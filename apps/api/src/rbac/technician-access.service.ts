import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { type Capability, sanitizeTechnicianCapabilities } from './capabilities';
import { PresetPolicy, presetCapabilities } from '../security-controls/presets';
import { describeSchedule, isWithinDates, parseSchedule, storedScheduleAllows } from './schedule';

/**
 * Why a technician can reach a business, one row per assignment that counts.
 */
export interface TechnicianGrantSource {
  assignmentId: string;
  /** DIRECT = assigned to the user; GROUP = through a technician group. */
  via: 'DIRECT' | 'GROUP';
  /** Has an end time — a contractor / time-boxed assignment. */
  temporary: boolean;
  groupId: string | null;
  groupName: string | null;
  capabilities: Capability[];
  /** null = every computer in the business. */
  endpointIds: string[] | null;
  startsAt: Date | null;
  expiresAt: Date | null;
  schedule: string | null;
  approval: string;
  /** v0.23: the preset behind this grant, or null for a custom assignment. */
  presetId: string | null;
  presetTier: string | null;
  presetPolicy: PresetPolicy | null;
}

export interface InactiveGrant extends TechnicianGrantSource {
  businessId: string;
  businessName: string;
  inactiveReason: 'not_started' | 'expired' | 'outside_schedule' | 'pending_approval' | 'denied' | 'business_disabled';
}

/** Effective access to one business — the union of every active grant for it. */
export interface TechnicianBusinessScope {
  businessId: string;
  businessName: string;
  capabilities: Capability[];
  /** null = every computer in the business (at least one whole-business grant). */
  endpointIds: string[] | null;
  sources: TechnicianGrantSource[];
}

/**
 * Technician access: MSP staff working across selected customer businesses.
 *
 * Effective access is recomputed from the database on every request (the JWT
 * strategy calls `resolve`), on every launcher-token and connection-grant
 * redemption, and on every credential release. A token never carries it. So:
 *
 *   • Revoking, expiring or narrowing an assignment takes effect on the very
 *     next request, without waiting for a session token to expire.
 *   • Assignment to business A says nothing about business B — scopes are
 *     keyed by business id and never merged across businesses.
 *
 * Overlap rules, for several active grants to the SAME business:
 *   capabilities  union of every active grant's capabilities
 *   computers     whole business if ANY active grant is whole-business,
 *                 otherwise the union of the listed computers
 * A grant counts only while all of these hold:
 *   not revoked; approval NOT_REQUIRED or APPROVED; startsAt <= now < expiresAt
 *   (either bound optional); inside its weekly schedule if it has one; the
 *   business is active and not archived; for a GROUP grant, the user is a
 *   member of the group now.
 * When one grant lapses the others keep working — nothing is "inherited" from
 * a grant that is no longer active.
 */
@Injectable()
export class TechnicianAccessService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TechnicianAccessService.name);
  private sweep: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit() {
    // Expiry is enforced at request time; this only writes the audit entry
    // ("assignment expired at …") so the trail shows it without anyone having
    // to look. Once a minute is plenty for a log line.
    this.sweep = setInterval(() => {
      this.auditExpiries().catch((e) => this.logger.warn(`Expiry audit sweep failed: ${e}`));
    }, 60_000);
  }

  onModuleDestroy() {
    if (this.sweep) clearInterval(this.sweep);
  }

  private async loadGrants(userId: string) {
    return this.prisma.technicianAssignment.findMany({
      where: {
        revokedAt: null,
        OR: [{ userId }, { group: { members: { some: { userId } } } }],
      },
      include: {
        customer: { select: { id: true, name: true, isActive: true, isArchived: true } },
        group: { select: { id: true, name: true, capabilities: true } },
        preset: { select: { id: true, tier: true, policy: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  private toSource(a: Awaited<ReturnType<TechnicianAccessService['loadGrants']>>[number]): TechnicianGrantSource {
    // A preset-backed grant takes its capabilities from the preset's policy,
    // live — never from the copy stored on the assignment — so tightening a
    // preset tightens every grant made from it. A preset whose stored policy
    // no longer validates grants nothing (fail closed).
    let presetPolicy: PresetPolicy | null = null;
    if (a.preset) {
      const parsed = PresetPolicy.safeParse(a.preset.policy);
      presetPolicy = parsed.success ? parsed.data : null;
    }
    const caps = a.preset
      ? (presetPolicy ? sanitizeTechnicianCapabilities(presetCapabilities(presetPolicy)) : [])
      : sanitizeTechnicianCapabilities(a.capabilities.length > 0 ? a.capabilities : (a.group?.capabilities ?? []));
    let schedule: string | null;
    try { schedule = describeSchedule(parseSchedule(a.schedule)); } catch { schedule = 'invalid schedule (denies access)'; }
    return {
      assignmentId: a.id,
      via: a.userId ? 'DIRECT' : 'GROUP',
      temporary: !!a.expiresAt,
      groupId: a.groupId,
      groupName: a.group?.name ?? null,
      capabilities: caps,
      endpointIds: a.endpointIds.length > 0 ? [...a.endpointIds] : null,
      startsAt: a.startsAt,
      expiresAt: a.expiresAt,
      schedule,
      approval: a.approvalStatus,
      presetId: a.preset?.id ?? null,
      presetTier: a.preset?.tier ?? null,
      presetPolicy,
    };
  }

  /**
   * Every business this user can currently reach as a technician, keyed by
   * business id, plus the grants that exist but do not count right now (so
   * the UI can say why).
   */
  async resolve(userId: string, at: Date = new Date()): Promise<{
    scopes: Map<string, TechnicianBusinessScope>;
    inactive: InactiveGrant[];
  }> {
    const grants = await this.loadGrants(userId);
    const scopes = new Map<string, TechnicianBusinessScope>();
    const inactive: InactiveGrant[] = [];

    for (const a of grants) {
      const src = this.toSource(a);
      const reason: InactiveGrant['inactiveReason'] | null =
        a.approvalStatus === 'PENDING' ? 'pending_approval'
          : a.approvalStatus === 'DENIED' ? 'denied'
            : !a.customer.isActive || a.customer.isArchived ? 'business_disabled'
              : a.startsAt && at < a.startsAt ? 'not_started'
                : a.expiresAt && at >= a.expiresAt ? 'expired'
                  : !storedScheduleAllows(a.schedule, at) ? 'outside_schedule'
                    : null;
      if (reason) {
        inactive.push({ ...src, businessId: a.customerId, businessName: a.customer.name, inactiveReason: reason });
        continue;
      }
      if (!isWithinDates(a.startsAt, a.expiresAt, at)) continue; // belt and braces

      const existing = scopes.get(a.customerId);
      if (!existing) {
        scopes.set(a.customerId, {
          businessId: a.customerId,
          businessName: a.customer.name,
          capabilities: [...src.capabilities],
          endpointIds: src.endpointIds ? [...src.endpointIds] : null,
          sources: [src],
        });
      } else {
        existing.capabilities = [...new Set([...existing.capabilities, ...src.capabilities])];
        existing.endpointIds =
          existing.endpointIds === null || src.endpointIds === null
            ? null
            : [...new Set([...existing.endpointIds, ...src.endpointIds])];
        existing.sources.push(src);
      }
    }
    return { scopes, inactive };
  }

  /** The effective scope for one business, or null. */
  async scopeFor(userId: string, businessId: string, at: Date = new Date()): Promise<TechnicianBusinessScope | null> {
    const { scopes } = await this.resolve(userId, at);
    return scopes.get(businessId) ?? null;
  }

  /** Write the audit entry for assignments and computer grants that have lapsed. */
  async auditExpiries(at: Date = new Date()) {
    const lapsed = await this.prisma.technicianAssignment.findMany({
      where: { expiresAt: { lte: at }, expiryAuditedAt: null, revokedAt: null },
      select: { id: true, tenantId: true, customerId: true, userId: true, groupId: true, expiresAt: true },
      take: 200,
    });
    for (const a of lapsed) {
      const claimed = await this.prisma.technicianAssignment.updateMany({
        where: { id: a.id, expiryAuditedAt: null },
        data: { expiryAuditedAt: at },
      });
      if (claimed.count === 0) continue;
      await this.audit.log({
        tenantId: a.tenantId, customerId: a.customerId,
        action: 'TECHNICIAN_ASSIGNMENT_EXPIRED', resource: 'technician_assignment', resourceId: a.id,
        meta: { userId: a.userId, groupId: a.groupId, expiresAt: a.expiresAt },
      });
    }

    const lapsedAccess = await this.prisma.computerAccess.findMany({
      where: { expiresAt: { lte: at }, expiryAuditedAt: null },
      select: { id: true, tenantId: true, endpointId: true, userId: true, expiresAt: true, endpoint: { select: { customerId: true } } },
      take: 200,
    });
    for (const c of lapsedAccess) {
      const claimed = await this.prisma.computerAccess.updateMany({
        where: { id: c.id, expiryAuditedAt: null },
        data: { expiryAuditedAt: at },
      });
      if (claimed.count === 0) continue;
      await this.audit.log({
        tenantId: c.tenantId, customerId: c.endpoint.customerId ?? undefined,
        action: 'COMPUTER_ACCESS_EXPIRED', resource: 'endpoint', resourceId: c.endpointId,
        meta: { userId: c.userId, expiresAt: c.expiresAt },
      });
    }
    return { assignments: lapsed.length, computerAccess: lapsedAccess.length };
  }
}

/**
 * Is a ComputerAccess row usable right now? Same window and schedule rules as
 * a technician assignment; a malformed stored schedule fails closed.
 */
export function computerAccessActive(
  row: { startsAt?: Date | null; expiresAt?: Date | null; schedule?: unknown } | null | undefined,
  at: Date = new Date(),
): boolean {
  if (!row) return false;
  return isWithinDates(row.startsAt ?? null, row.expiresAt ?? null, at) && storedScheduleAllows(row.schedule, at);
}
