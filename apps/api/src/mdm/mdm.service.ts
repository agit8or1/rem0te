import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { MdmCommand, MdmConnector, MobileDevice, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';
import { commandProgress, type CommandFacts } from './command-state';
import { DRIVERS } from './drivers';
import {
  COMMAND_KIND_LABEL, COMMAND_STATE_LABEL, COMPLIANCE_LABEL, COMPLIANCE_STATES, DESTRUCTIVE_KINDS, ENROLLMENT_LABEL, ENROLLMENT_STATES,
  OWNERSHIP_LABEL, OWNERSHIPS, PLATFORM_LABEL, PLATFORMS, PROVIDER_LABEL, SCOPE_LABEL, isOneOf,
  type CommandKind, type CommandState, type ComplianceState, type EnrollmentState, type ManagementScope, type Ownership, type Platform, type Provider,
} from './model';

/**
 * Mobile devices, read-only (0.80 Tablet). Every read goes through scope():
 *
 *   - `mobile:view` is required. A Business Owner holds it (every business
 *     capability); a Business User only if their owner grants it; a
 *     technician only on an assignment covering the WHOLE business, because
 *     a mobile device is not one of the computers a grant can name. No
 *     preset produces it (presets.ts), so a technician starts without it.
 *   - The business is the caller's own (resolveScope: naming another is a
 *     403, as everywhere). A Platform Admin may name one, or none.
 *   - A device or its commands outside that scope is a 404, never a 403, so
 *     an id from another tenant tells the caller nothing.
 *
 * This service writes nothing (§90: only MdmSyncService writes the MDM
 * tables).
 */
export const LIST_MAX_PAGE_SIZE = 100;
export const COMMANDS_MAX = 100;

type Query = Record<string, unknown>;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SEARCH_RE = /^[\p{L}\p{N} ._'()-]{1,60}$/u;

@Injectable()
export class MdmService {
  constructor(private readonly prisma: PrismaService, private readonly acl: AccessControlService) {}

  // ── Who may read ──────────────────────────────────────────────────────────

  /** The business filter for this caller, or a 403. `{}` only for a Platform Admin naming no business. */
  scope(actor: ActorContext, requestedBusinessId?: unknown): { customerId?: string } {
    const requested = typeof requestedBusinessId === 'string' && requestedBusinessId ? requestedBusinessId : null;
    if (requested !== null && !ID_RE.test(requested)) throw new ForbiddenException({ code: 'INVALID_BUSINESS', message: 'That is not a business id.' });
    if (actor.isPlatformAdmin) return requested ? { customerId: requested } : {};
    if (actor.technician) {
      const whole = actor.technician.businessId === actor.businessId
        && actor.technician.sources.some((s) => s.endpointIds === null && (s.capabilities as string[]).includes(CAP.MOBILE_VIEW));
      if (!whole) throw new ForbiddenException({ code: 'MOBILE_VIEW_REQUIRED', message: 'Viewing mobile devices needs the View mobile devices permission on an assignment covering the whole business.' });
      if (requested && requested !== actor.technician.businessId) throw new ForbiddenException('You do not have access to that business');
      return { customerId: actor.technician.businessId };
    }
    const business = this.acl.requireScope(actor, requested);
    if (!this.acl.can(actor, CAP.MOBILE_VIEW)) throw new ForbiddenException({ code: 'MOBILE_VIEW_REQUIRED', message: 'Viewing mobile devices needs the View mobile devices permission.' });
    return { customerId: business };
  }

  // ── Setup state ───────────────────────────────────────────────────────────

  /**
   * "Requires setup" until a provider is connected and readable for this
   * scope. In 0.80 no real provider exists, so outside the test suites the
   * answer is always requires_setup.
   */
  async setup(actor: ActorContext, q: Query) {
    const where = this.scope(actor, q.businessId);
    const rows = await this.prisma.mdmConnector.findMany({ where, orderBy: { createdAt: 'asc' }, take: 50, include: { customer: { select: { id: true, name: true } } } });
    const counts = new Map((await this.prisma.mobileDevice.groupBy({ by: ['connectorId'], where: { connectorId: { in: rows.map((r) => r.id) } }, _count: { _all: true } }))
      .map((g) => [g.connectorId, g._count._all]));
    const connectors = rows.map((r) => this.connectorView(r, counts.get(r.id) ?? 0));
    const available = connectors.some((c) => c.enabled && c.ready);
    return {
      state: available ? 'available' as const : 'requires_setup' as const,
      connectors,
      sweep: { enabled: process.env.MDM_SWEEP !== 'off' },
      readOnly: true,
      prerequisites: PREREQUISITES,
    };
  }

  private connectorView(r: MdmConnector & { customer?: { id: string; name: string } }, devices: number) {
    const drv = isOneOf(Object.keys(DRIVERS) as Provider[], r.provider) ? DRIVERS[r.provider as Provider] : null;
    const ready = drv ? drv.ready(r) : { ok: false as const, reason: 'Unknown provider.' };
    return {
      id: r.id,
      business: r.customer ? { id: r.customer.id, name: r.customer.name } : null,
      provider: r.provider,
      providerLabel: PROVIDER_LABEL[r.provider as Provider] ?? r.provider,
      enabled: r.enabled,
      ready: ready.ok,
      reason: ready.ok ? null : ready.reason,
      lastSyncAt: r.lastSyncAt,
      lastSyncResult: r.lastSyncResult,
      lastSyncDevices: r.lastSyncDevices,
      devices,
    };
  }

  // ── The list ──────────────────────────────────────────────────────────────

  async list(actor: ActorContext, q: Query) {
    const scope = this.scope(actor, q.businessId);
    const and: Prisma.MobileDeviceWhereInput[] = [scope];
    if (isOneOf(PLATFORMS, q.platform)) and.push({ platform: q.platform });
    if (isOneOf(OWNERSHIPS, q.ownership)) and.push({ ownership: q.ownership });
    if (isOneOf(COMPLIANCE_STATES, q.compliance)) and.push({ complianceState: q.compliance });
    if (isOneOf(ENROLLMENT_STATES, q.enrollment)) and.push({ enrollmentState: q.enrollment });
    else and.push({ enrollmentState: { not: 'not_reported' } }); // gone from the provider: only when asked for
    const search = typeof q.search === 'string' ? q.search.trim() : '';
    if (search && SEARCH_RE.test(search)) and.push({ OR: [{ name: { contains: search, mode: 'insensitive' } }, { model: { contains: search, mode: 'insensitive' } }] });
    const where: Prisma.MobileDeviceWhereInput = { AND: and };
    const pageSize = Math.min(LIST_MAX_PAGE_SIZE, Math.max(1, Number(q.pageSize) || 50));
    const page = Math.min(10_000, Math.max(1, Number(q.page) || 1));
    const [total, rows, byCompliance] = await Promise.all([
      this.prisma.mobileDevice.count({ where }),
      this.prisma.mobileDevice.findMany({
        where, orderBy: [{ name: 'asc' }, { id: 'asc' }], skip: (page - 1) * pageSize, take: pageSize,
        include: { connector: { select: { customer: { select: { id: true, name: true } } } } },
      }),
      this.prisma.mobileDevice.groupBy({ by: ['complianceState'], where: { AND: [scope, { enrollmentState: { not: 'not_reported' } }] }, _count: { _all: true } }),
    ]);
    const counts = Object.fromEntries(COMPLIANCE_STATES.map((s) => [s, byCompliance.find((g) => g.complianceState === s)?._count._all ?? 0])) as Record<ComplianceState, number>;
    return { total, page, pageSize, counts, devices: rows.map((r) => this.deviceView(r, r.connector.customer)) };
  }

  private deviceView(d: MobileDevice, business: { id: string; name: string } | null) {
    return {
      id: d.id,
      name: d.name,
      business,
      provider: d.provider,
      providerLabel: PROVIDER_LABEL[d.provider as Provider] ?? d.provider,
      providerDeviceId: d.providerDeviceId,
      platform: d.platform, platformLabel: PLATFORM_LABEL[d.platform as Platform] ?? d.platform,
      ownership: d.ownership, ownershipLabel: OWNERSHIP_LABEL[d.ownership as Ownership] ?? d.ownership,
      managementScope: d.managementScope, managementScopeLabel: SCOPE_LABEL[d.managementScope as ManagementScope] ?? d.managementScope,
      enrollmentState: d.enrollmentState, enrollmentLabel: ENROLLMENT_LABEL[d.enrollmentState as EnrollmentState] ?? d.enrollmentState,
      enrolledAt: d.enrolledAt,
      complianceState: d.complianceState, complianceLabel: COMPLIANCE_LABEL[d.complianceState as ComplianceState] ?? d.complianceState,
      complianceReason: d.complianceReason,
      model: d.model, manufacturer: d.manufacturer, osVersion: d.osVersion,
      serialNumber: d.serialNumber,
      storage: d.storageTotalBytes === null ? null : {
        totalBytes: Number(d.storageTotalBytes), freeBytes: d.storageFreeBytes === null ? null : Number(d.storageFreeBytes),
      },
      lastCheckInAt: d.lastCheckInAt,
      lastSyncedAt: d.lastSyncedAt,
      notReportedSince: d.notReportedSince,
    };
  }

  // ── One device and its commands ───────────────────────────────────────────

  private async visible(actor: ActorContext, id: string, q: Query) {
    const scope = this.scope(actor, q.businessId);
    if (!ID_RE.test(id)) throw new NotFoundException({ code: 'MOBILE_DEVICE_NOT_FOUND', message: 'No such mobile device.' });
    const d = await this.prisma.mobileDevice.findFirst({ where: { AND: [{ id }, scope] }, include: { connector: { select: { customer: { select: { id: true, name: true } } } } } });
    if (!d) throw new NotFoundException({ code: 'MOBILE_DEVICE_NOT_FOUND', message: 'No such mobile device.' });
    return d;
  }

  async get(actor: ActorContext, id: string, q: Query) {
    const d = await this.visible(actor, id, q);
    return { device: this.deviceView(d, d.connector.customer), readOnly: true };
  }

  async commands(actor: ActorContext, id: string, q: Query) {
    const d = await this.visible(actor, id, q);
    const rows = await this.prisma.mdmCommand.findMany({
      where: { mobileDeviceId: d.id, customerId: d.customerId }, orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }], take: COMMANDS_MAX,
    });
    return { deviceId: d.id, commands: rows.map(commandView), max: COMMANDS_MAX, canSend: false };
  }
}

/** One command as the console shows it: provider acceptance and device completion side by side, never merged. */
export function commandView(c: MdmCommand) {
  const facts: CommandFacts = {
    state: c.state as CommandState, sentAt: c.sentAt, providerAcceptedAt: c.providerAcceptedAt, deviceCompletedAt: c.deviceCompletedAt,
    failedAt: c.failedAt, failureCode: c.failureCode, expiresAt: c.expiresAt, expiredAt: c.expiredAt,
  };
  const p = commandProgress(facts);
  return {
    id: c.id,
    kind: c.kind, kindLabel: COMMAND_KIND_LABEL[c.kind as CommandKind] ?? c.kind,
    destructive: DESTRUCTIVE_KINDS.includes(c.kind as CommandKind),
    origin: c.origin,
    state: c.state, stateLabel: COMMAND_STATE_LABEL[c.state as CommandState] ?? c.state,
    requestedAt: c.requestedAt,
    sentAt: c.sentAt,
    providerAccepted: p.providerAccepted,
    deviceCompleted: p.deviceCompleted,
    waitingFor: p.waitingFor,
    failedAt: c.failedAt, failureCode: c.failureCode,
    expiresAt: c.expiresAt, expiredAt: c.expiredAt,
  };
}

/** What has to exist before a real provider can be connected (docs/mobile-devices.md). Plain data for the setup panel. */
export const PREREQUISITES = [
  {
    key: 'third_party', title: 'An existing MDM (for example Microsoft Intune)',
    needs: 'The provider tenant, an app registration or API account with read-only scopes, and a provider licence per device.',
    plannedIn: '3.2: the first read-only connector',
  },
  {
    key: 'android', title: 'Android Management API',
    needs: 'A Google Cloud project with the API on, a service account, Pub/Sub, an enterprise per customer, and device quota: a new project starts with none, and up to 500 devices needs a business justification that takes weeks.',
    plannedIn: 'After 3.2; ask Google for quota early',
  },
  {
    key: 'apple', title: 'Native Apple MDM',
    needs: 'An MDM Vendor CSR Signing Certificate from Apple, an APNs MDM push certificate per customer renewed every year with the same Apple Account, and Apple Business Manager for automated enrollment.',
    plannedIn: 'Last, if ever',
  },
] as const;
