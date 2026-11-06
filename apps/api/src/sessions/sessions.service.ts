import { Injectable, NotFoundException, ForbiddenException, BadRequestException, ConflictException } from '@nestjs/common';
import { SessionStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';
import { CreateSessionDto, CompleteSessionDto, SessionEventDto } from './dto/create-session.dto';
import {
  CLOSE_FROM, EVENT_NAME_RE, EVENT_TRANSITIONS, OPEN_STATUSES, isTerminal,
} from './session-transitions';

/** Thrown inside a transaction to roll it back when a conditional write matched nothing. */
class TransitionRefused extends Error {}

/**
 * Support sessions.
 *
 * Sessions carry their own `customerId` so a Quick Connect session — which
 * has no endpoint to inherit a business from — is still confined to the
 * business that started it.
 */
@Injectable()
export class SessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly acl: AccessControlService,
  ) {}

  /**
   * READ scope for session queries.
   *
   * A Business User who cannot view history only ever sees sessions they ran
   * themselves — the business filter alone would show them their colleagues'.
   *
   * This is visibility only. `support:history_view` lets someone read their
   * colleagues' sessions; it never lets them change one. Every mutation goes
   * through `loadForMutation`, which applies this scope and then a separate
   * write check. Until 0.19.12 complete/cancel/addEvent reused this filter as
   * their authorization, so `computers:connect` + `support:history_view` was
   * enough to close or inject events into another technician's session.
   */
  private sessionScope(actor: ActorContext, businessId?: string) {
    const scope = this.acl.resolveScope(actor, businessId);
    const canSeeOthers = this.acl.isBusinessOwner(actor) || this.acl.can(actor, CAP.HISTORY_VIEW);
    return {
      ...(scope ? { customerId: scope } : {}),
      ...(canSeeOthers ? {} : { technicianId: actor.userId }),
    };
  }

  /**
   * WRITE authorization: the technician who owns the session, or a
   * supervisor — a Business Owner of the session's business, or a Platform
   * Admin. The business boundary is the read scope's (`resolveScope`), so a
   * Business Owner is never a supervisor of another business's sessions.
   *
   * A session the caller cannot see is 404, exactly as before; one they can
   * see but not change is 403. Nothing is written for either.
   */
  private async loadForMutation(actor: ActorContext, id: string) {
    const session = await this.prisma.supportSession.findFirst({
      where: { id, ...this.sessionScope(actor) },
      select: { id: true, tenantId: true, customerId: true, technicianId: true, status: true, startedAt: true },
    });
    if (!session) throw new NotFoundException('Session not found');
    if (session.technicianId !== actor.userId && !this.acl.isBusinessOwner(actor)) {
      throw new ForbiddenException('Only the technician who ran this session, or a Business Owner, can change it');
    }
    return session;
  }

  async findAll(
    actor: ActorContext,
    opts: {
      status?: SessionStatus;
      technicianId?: string;
      endpointId?: string;
      businessId?: string;
      page?: number;
      limit?: number;
    } = {},
  ) {
    const page = opts.page ?? 1;
    const limit = Math.min(opts.limit ?? 50, 200);
    const skip = (page - 1) * limit;

    const where = {
      ...this.sessionScope(actor, opts.businessId),
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.technicianId ? { technicianId: opts.technicianId } : {}),
      ...(opts.endpointId ? { endpointId: opts.endpointId } : {}),
    };

    const [sessions, total] = await Promise.all([
      this.prisma.supportSession.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          technician: { select: { id: true, email: true, firstName: true, lastName: true } },
          customer: { select: { id: true, name: true } },
          endpoint: { select: { id: true, name: true, hostname: true, rustdeskNode: { select: { rustdeskId: true } } } },
        },
      }),
      this.prisma.supportSession.count({ where }),
    ]);

    return { sessions, total, page, limit, pages: Math.ceil(total / limit) };
  }

  async findOne(actor: ActorContext, id: string) {
    const session = await this.prisma.supportSession.findFirst({
      where: { id, ...this.sessionScope(actor) },
      include: {
        technician: { select: { id: true, email: true, firstName: true, lastName: true } },
        customer: { select: { id: true, name: true } },
        endpoint: {
          select: {
            id: true, name: true, hostname: true,
            rustdeskNode: { select: { rustdeskId: true } },
            customer: { select: { id: true, name: true } },
            site: { select: { id: true, name: true } },
          },
        },
        events: { orderBy: { timestamp: 'asc' } },
        noteRels: {
          include: { author: { select: { id: true, email: true, firstName: true, lastName: true } } },
          orderBy: [{ isPinned: 'desc' }, { createdAt: 'desc' }],
        },
        launcherToken: { select: { id: true, expiresAt: true, usedAt: true, revokedAt: true } },
      },
    });
    if (!session) throw new NotFoundException('Session not found');
    return session;
  }

  /**
   * Open a session.
   *
   * Ad-hoc sessions go through Quick Connect, which has its own gate; this
   * path is for sessions against an enrolled computer, and the caller must be
   * authorised for that specific computer.
   */
  async create(actor: ActorContext, dto: CreateSessionDto) {
    if (!dto.endpointId && !dto.adHocRustdeskId) {
      throw new BadRequestException('Either endpointId or adHocRustdeskId is required');
    }
    if (dto.adHocRustdeskId) {
      throw new BadRequestException('Use Quick Connect for ad-hoc support sessions');
    }

    this.acl.assertCapability(actor, CAP.COMPUTERS_CONNECT);

    const endpoint = await this.acl.assertEndpointInScope(actor, dto.endpointId!);

    // Owners and admins may reach any computer in scope; everyone else needs
    // a standing grant or a COMPANY_WIDE computer in their own business.
    if (!this.acl.isBusinessOwner(actor)) {
      const access = await this.prisma.computerAccess.findFirst({
        where: { endpointId: endpoint.id, userId: actor.userId },
        select: { id: true },
      });
      const authorized = !!access
        || (endpoint.accessMode === 'COMPANY_WIDE' && endpoint.customerId === actor.businessId);

      if (!authorized) {
        await this.audit.log({
          tenantId: endpoint.tenantId ?? undefined, customerId: endpoint.customerId ?? undefined,
          actorId: actor.userId, actorIp: actor.ip,
          action: 'SESSION_LAUNCHED', resource: 'support_session',
          meta: { endpointId: endpoint.id, denied: 'no_access' },
        });
        throw new ForbiddenException('You do not have access to this computer');
      }
    }

    const session = await this.prisma.supportSession.create({
      data: {
        tenantId: endpoint.tenantId!,
        customerId: endpoint.customerId,
        technicianId: actor.userId,
        endpointId: endpoint.id,
        isAdHoc: false,
        contactName: dto.contactName ?? null,
        contactEmail: dto.contactEmail ?? null,
        issueDescription: dto.issueDescription ?? null,
        status: SessionStatus.PENDING,
      },
      include: {
        technician: { select: { id: true, email: true, firstName: true, lastName: true } },
        endpoint: { select: { id: true, name: true, hostname: true, rustdeskNode: { select: { rustdeskId: true } } } },
      },
    });

    await this.audit.log({
      tenantId: endpoint.tenantId ?? undefined, customerId: endpoint.customerId ?? undefined,
      actorId: actor.userId, actorIp: actor.ip,
      action: 'SESSION_LAUNCHED', resource: 'support_session', resourceId: session.id,
      meta: { endpointId: endpoint.id },
    });

    return session;
  }

  async complete(actor: ActorContext, id: string, dto: CompleteSessionDto) {
    const session = await this.loadForMutation(actor, id);
    if (isTerminal(session.status)) {
      throw new ConflictException(`Session is already ${session.status.toLowerCase()}`);
    }

    const now = new Date();
    const duration = session.startedAt
      ? Math.round((now.getTime() - session.startedAt.getTime()) / 1000)
      : null;

    // Conditional on still being open: a concurrent close (or the sweeper)
    // that got there first wins, and this one changes nothing.
    const u = await this.prisma.supportSession.updateMany({
      where: { id, status: { in: [...CLOSE_FROM] } },
      data: {
        status: SessionStatus.SESSION_COMPLETED,
        completedAt: now,
        duration: duration ?? undefined,
        notes: dto.notes ?? undefined,
        disposition: dto.disposition ?? undefined,
      },
    });
    if (u.count === 0) throw new ConflictException('Session was closed by another request');

    await this.audit.log({
      tenantId: session.tenantId, customerId: session.customerId ?? undefined,
      actorId: actor.userId, actorIp: actor.ip,
      action: 'SESSION_COMPLETED', resource: 'support_session', resourceId: id,
      meta: { disposition: dto.disposition, duration },
    });

    return this.prisma.supportSession.findUnique({ where: { id } });
  }

  async cancel(actor: ActorContext, id: string) {
    const session = await this.loadForMutation(actor, id);
    if (isTerminal(session.status)) {
      throw new ConflictException(`Session is already ${session.status.toLowerCase()}`);
    }

    const u = await this.prisma.supportSession.updateMany({
      where: { id, status: { in: [...CLOSE_FROM] } },
      data: { status: SessionStatus.CANCELED, completedAt: new Date() },
    });
    if (u.count === 0) throw new ConflictException('Session was closed by another request');

    await this.audit.log({
      tenantId: session.tenantId, customerId: session.customerId ?? undefined,
      actorId: actor.userId, actorIp: actor.ip,
      action: 'SESSION_CANCELED', resource: 'support_session', resourceId: id,
    });

    return this.prisma.supportSession.findUnique({ where: { id } });
  }

  /**
   * Record a technician event.
   *
   * State events (see EVENT_TRANSITIONS) move the session only forward and
   * only from the states listed for them; anything else is refused with 409
   * and writes nothing. Other event names are timeline annotations and are
   * accepted only while the session is open. A closed session takes no new
   * events of any kind.
   *
   * The status write and the event row are one transaction, and the write is
   * conditional on the from-state, so a racing close cannot slip between the
   * check and the write, and a refused transition leaves no orphan event row.
   */
  async addEvent(actor: ActorContext, sessionId: string, dto: SessionEventDto) {
    if (typeof dto.event !== 'string' || !EVENT_NAME_RE.test(dto.event)) {
      throw new BadRequestException('event must be a lower-case identifier');
    }
    const session = await this.loadForMutation(actor, sessionId);
    if (isTerminal(session.status)) {
      throw new ConflictException(`Session is already ${session.status.toLowerCase()}`);
    }

    const transition = EVENT_TRANSITIONS[dto.event];
    const now = new Date();
    try {
      return await this.prisma.$transaction(async (tx) => {
        let u;
        if (!transition) {
          // Annotation: changes no status, but takes the row lock so it
          // cannot land after a concurrent close commits.
          u = await tx.supportSession.updateMany({
            where: { id: sessionId, status: { in: [...OPEN_STATUSES] } },
            data: { updatedAt: now },
          });
        } else if (transition.to === SessionStatus.CLIENT_OPENED) {
          u = await tx.supportSession.updateMany({
            where: { id: sessionId, status: { in: [...transition.from] } },
            data: { status: SessionStatus.CLIENT_OPENED, startedAt: now },
          });
        } else {
          // client_closed. startedAt is re-read under the lock the update
          // takes, so the duration matches the start that was recorded.
          const cur = await tx.supportSession.findUnique({ where: { id: sessionId }, select: { startedAt: true } });
          const duration = cur?.startedAt ? Math.round((now.getTime() - cur.startedAt.getTime()) / 1000) : null;
          u = await tx.supportSession.updateMany({
            where: { id: sessionId, status: { in: [...transition.from] } },
            data: { status: transition.to, completedAt: now, duration: duration ?? undefined },
          });
        }
        if (u.count === 0) throw new TransitionRefused();
        return tx.supportSessionEvent.create({
          data: {
            supportSessionId: sessionId,
            event: dto.event,
            metadata: dto.metadata ? (dto.metadata as Prisma.InputJsonValue) : undefined,
          },
        });
      });
    } catch (e) {
      if (e instanceof TransitionRefused) {
        throw new ConflictException(`Event ${dto.event} does not apply to this session in its current state`);
      }
      throw e;
    }
  }

  async getStats(actor: ActorContext, days = 30, businessId?: string) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const scope = this.sessionScope(actor, businessId);

    const [total, completed, active, canceled, avgDuration] = await Promise.all([
      this.prisma.supportSession.count({ where: { ...scope, createdAt: { gte: since } } }),
      this.prisma.supportSession.count({ where: { ...scope, status: SessionStatus.SESSION_COMPLETED, createdAt: { gte: since } } }),
      this.prisma.supportSession.count({ where: { ...scope, status: { notIn: [SessionStatus.SESSION_COMPLETED, SessionStatus.FAILED, SessionStatus.CANCELED] } } }),
      this.prisma.supportSession.count({ where: { ...scope, status: SessionStatus.CANCELED, createdAt: { gte: since } } }),
      this.prisma.supportSession.aggregate({
        where: { ...scope, status: SessionStatus.SESSION_COMPLETED, duration: { not: null }, createdAt: { gte: since } },
        _avg: { duration: true },
      }),
    ]);

    return {
      total,
      completed,
      active,
      canceled,
      avgDurationSeconds: Math.round(avgDuration._avg?.duration ?? 0),
      periodDays: days,
    };
  }

  /**
   * Fail sessions that were launched but whose client never opened.
   *
   * `create` writes a session as PENDING and only `addEvent` moves it to
   * CLIENT_OPENED, so every Connect click that does not end in a working
   * RustDesk connection leaves a row behind. getStats counts "active" as
   * anything not in (SESSION_COMPLETED, FAILED, CANCELED), so those rows are
   * reported as live sessions forever — ten failed clicks read as ten active
   * sessions against a single endpoint.
   *
   * Only sessions that never opened a client are expired: startedAt is still
   * null, which rules out a genuinely long-running session a technician is
   * still sitting in. CLIENT_OPENED and later are left alone deliberately —
   * a real session has no upper bound we can guess at safely.
   */
  async expireStaleSessions(thresholdMinutes = 30) {
    const cutoff = new Date(Date.now() - thresholdMinutes * 60 * 1000);
    const result = await this.prisma.supportSession.updateMany({
      where: {
        startedAt: null,
        createdAt: { lt: cutoff },
        // Ad-hoc rows are typed in by a person to record work against a machine
        // that is not enrolled; nothing ever "opens a client" for them, so
        // failing them just relabels every manual record as a failure. They are
        // completed or cancelled by hand.
        isAdHoc: false,
        status: {
          in: [
            SessionStatus.PENDING,
            SessionStatus.LAUNCH_REQUESTED,
            SessionStatus.LAUNCHER_ACKNOWLEDGED,
          ],
        },
      },
      data: { status: SessionStatus.FAILED, completedAt: new Date() },
    });
    return result.count;
  }

  /**
   * Close out sessions that opened a client and were never heard from again.
   *
   * There is no signal that a RustDesk session ended. Rem0te hands out a
   * credential and RustDesk carries the session; hbbs logs nothing for a
   * connect, let alone a disconnect. So a row promoted to CLIENT_OPENED has
   * nothing that will ever move it on, and `getStats` counts "active" as
   * anything not in (SESSION_COMPLETED, FAILED, CANCELED) — which made every
   * Connect click in the platform's history a permanently live session.
   * Clicking Connect four times in one minute read as four ongoing sessions,
   * and yesterday's read as ongoing too.
   *
   * `expireStaleSessions` deliberately does not touch these, and should not:
   * those are clicks that never reached a client at all, and failing them is
   * the right verdict. This one is the opposite case — a session that did
   * start, and whose end we can only infer from time passing. It is recorded
   * as completed rather than failed for that reason, and the threshold is
   * generous on purpose: the cost of closing one early is a technician's
   * genuinely-long session being marked done underneath them, which is worse
   * than a stale row.
   *
   * `duration` is left null. We know when it started and we are guessing when
   * it stopped, so writing a number here would put a fabricated figure into
   * the average session length on the stats page.
   */
  async closeAbandonedSessions(thresholdHours = 12) {
    const cutoff = new Date(Date.now() - thresholdHours * 60 * 60 * 1000);
    const result = await this.prisma.supportSession.updateMany({
      where: {
        // Keyed on when the session actually started, not when the row was
        // created: those differ by the whole handshake on the launcher path.
        startedAt: { lt: cutoff, not: null },
        completedAt: null,
        isAdHoc: false,
        status: { in: [SessionStatus.CLIENT_OPENED, SessionStatus.SESSION_STARTED] },
      },
      data: { status: SessionStatus.SESSION_COMPLETED, completedAt: new Date() },
    });
    return result.count;
  }
}
