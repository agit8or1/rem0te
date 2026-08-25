import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SessionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { PlatformSettingsService } from '../platform/platform-settings.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';

/**
 * RustDesk IDs are 9-ish digits, usually shown grouped as "123 456 789".
 * Accept any grouping the person reads out, normalise to digits.
 */
const RUSTDESK_ID_RE = /^[0-9]{6,16}$/;

export interface QuickConnectRequest {
  rustdeskId: string;
  password: string;
  contactName?: string;
  issueDescription?: string;
}

/**
 * Quick Connect — temporary support access to a machine that is NOT an
 * enrolled managed computer.
 *
 * The remote person runs the Quick Connect client, reads out the RustDesk ID
 * and password it displays, and an authorised Rem0te user types them in here.
 * That act of reading out the password IS the consent for the session.
 *
 * Three things must all be true before a connection is allowed:
 *
 *   1. the platform master switch is on
 *   2. Quick Connect is enabled for the caller's business
 *   3. the caller holds `support:quick_connect`
 *      (Business Owners hold it implicitly; Platform Admins always do)
 *
 * The password is never stored, never logged and never placed in a URL — it
 * is handed straight back to the caller's launcher and forgotten.
 */
@Injectable()
export class QuickConnectService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly acl: AccessControlService,
    private readonly platformSettings: PlatformSettingsService,
  ) {}

  // ── Availability ──────────────────────────────────────────────────────────

  /**
   * Why Quick Connect is or isn't available to this caller. The UI renders
   * the reason instead of an unexplained disabled button.
   */
  async status(actor: ActorContext) {
    const settings = await this.platformSettings.get();
    const platformEnabled = settings.quickConnectEnabled;

    let businessEnabled = true;
    let businessName: string | null = null;
    if (actor.businessId) {
      const business = await this.prisma.customer.findUnique({
        where: { id: actor.businessId },
        select: { name: true, quickConnectEnabled: true, isActive: true },
      });
      businessEnabled = !!business?.quickConnectEnabled && !!business?.isActive;
      businessName = business?.name ?? null;
    }

    const hasCapability = this.acl.can(actor, CAP.QUICK_CONNECT);
    const canUse = platformEnabled && businessEnabled && hasCapability;

    let reason: string | null = null;
    if (!platformEnabled) reason = 'Quick Connect is turned off for this Rem0te platform.';
    else if (!businessEnabled) reason = 'Quick Connect is turned off for your business.';
    else if (!hasCapability) reason = 'You do not have the Use Quick Connect permission.';

    return {
      platformEnabled,
      businessEnabled,
      hasCapability,
      canUse,
      reason,
      businessName,
      downloads: platformEnabled ? await this.platformSettings.availableClients() : [],
    };
  }

  /** Throws with the specific reason rather than a generic 403. */
  private async assertUsable(actor: ActorContext) {
    const status = await this.status(actor);
    if (!status.canUse) {
      await this.audit.log({
        tenantId: actor.tenantId ?? undefined,
        customerId: actor.businessId ?? undefined,
        actorId: actor.userId, actorIp: actor.ip,
        action: 'QUICK_CONNECT_DENIED',
        resource: 'quick_connect',
        meta: {
          platformEnabled: status.platformEnabled,
          businessEnabled: status.businessEnabled,
          hasCapability: status.hasCapability,
        },
      });
      throw new ForbiddenException(status.reason ?? 'Quick Connect is not available');
    }
    return status;
  }

  // ── Connect ───────────────────────────────────────────────────────────────

  /**
   * Start a Quick Connect session.
   *
   * No Endpoint row is created and nothing is enrolled — this is deliberately
   * a session record and nothing more, so a support call can never quietly
   * turn a stranger's machine into a permanently managed device.
   */
  async connect(actor: ActorContext, dto: QuickConnectRequest) {
    await this.assertUsable(actor);

    const rustdeskId = dto.rustdeskId.replace(/[\s-]/g, '');
    if (!RUSTDESK_ID_RE.test(rustdeskId)) {
      throw new BadRequestException('That does not look like a Remote ID. It should be the 9-digit number shown by the Quick Connect client.');
    }
    if (!dto.password || dto.password.length < 4 || dto.password.length > 128) {
      throw new BadRequestException('Enter the password shown by the Quick Connect client.');
    }

    if (!actor.tenantId) throw new BadRequestException('No platform context');

    const session = await this.prisma.supportSession.create({
      data: {
        tenantId: actor.tenantId,
        customerId: actor.businessId,
        technicianId: actor.userId,
        endpointId: null,
        isAdHoc: true,
        adHocRustdeskId: rustdeskId,
        contactName: dto.contactName ?? null,
        issueDescription: dto.issueDescription ?? null,
        status: SessionStatus.LAUNCH_REQUESTED,
        startedAt: new Date(),
      },
      select: { id: true, createdAt: true },
    });

    // The remote ID is recorded; the password never is.
    await this.audit.log({
      tenantId: actor.tenantId,
      customerId: actor.businessId ?? undefined,
      actorId: actor.userId,
      actorIp: actor.ip,
      action: 'QUICK_CONNECT_INITIATED',
      resource: 'support_session',
      resourceId: session.id,
      meta: { rustdeskId, result: 'connected' },
    });

    return {
      sessionId: session.id,
      rustdeskId,
      // Passed straight through to the caller's own launcher. Not persisted.
      password: dto.password,
      launchUri: `rustdesk://connection/new/${rustdeskId}`,
      startedAt: session.createdAt,
    };
  }

  /** Record that a Quick Connect session finished. */
  async end(actor: ActorContext, sessionId: string, result: 'completed' | 'failed' | 'cancelled' = 'completed') {
    const scope = this.acl.resolveScope(actor);

    const session = await this.prisma.supportSession.findFirst({
      where: {
        id: sessionId,
        isAdHoc: true,
        ...(scope ? { customerId: scope } : {}),
      },
      select: { id: true, tenantId: true, customerId: true, technicianId: true, startedAt: true, adHocRustdeskId: true, status: true },
    });
    if (!session) throw new NotFoundException('Session not found');

    // A Business User may only close their own session; owners and admins may
    // close any session in scope.
    if (!this.acl.isBusinessOwner(actor) && session.technicianId !== actor.userId) {
      throw new ForbiddenException('That is not your session');
    }

    const now = new Date();
    const duration = session.startedAt
      ? Math.round((now.getTime() - session.startedAt.getTime()) / 1000)
      : null;

    const updated = await this.prisma.supportSession.update({
      where: { id: sessionId },
      data: {
        status: result === 'completed' ? SessionStatus.SESSION_COMPLETED
          : result === 'failed' ? SessionStatus.FAILED
            : SessionStatus.CANCELED,
        completedAt: now,
        duration: duration ?? undefined,
      },
      select: { id: true, status: true, duration: true, completedAt: true },
    });

    await this.audit.log({
      tenantId: session.tenantId,
      customerId: session.customerId ?? undefined,
      actorId: actor.userId,
      actorIp: actor.ip,
      action: 'QUICK_CONNECT_ENDED',
      resource: 'support_session',
      resourceId: sessionId,
      meta: { rustdeskId: session.adHocRustdeskId, result, durationSeconds: duration },
    });

    return updated;
  }

  /** Quick Connect history, scoped to the caller's business. */
  async listSessions(actor: ActorContext, opts: { businessId?: string; page?: number; limit?: number } = {}) {
    const scope = this.acl.resolveScope(actor, opts.businessId);
    const page = opts.page ?? 1;
    const limit = Math.min(opts.limit ?? 25, 100);

    const where = {
      isAdHoc: true,
      ...(scope ? { customerId: scope } : {}),
      // A Business User without history rights sees only their own sessions.
      ...(this.acl.isBusinessOwner(actor) || this.acl.can(actor, CAP.HISTORY_VIEW)
        ? {}
        : { technicianId: actor.userId }),
    };

    const [sessions, total] = await Promise.all([
      this.prisma.supportSession.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true, adHocRustdeskId: true, status: true, contactName: true,
          issueDescription: true, startedAt: true, completedAt: true, duration: true,
          createdAt: true,
          technician: { select: { id: true, email: true, firstName: true, lastName: true } },
          customer: { select: { id: true, name: true } },
        },
      }),
      this.prisma.supportSession.count({ where }),
    ]);

    return { sessions, total, page, limit, pages: Math.ceil(total / limit) };
  }
}
