import { Injectable, NotFoundException, ForbiddenException, BadRequestException, ConflictException } from '@nestjs/common';
import { SessionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';
import { CreateSessionDto, CompleteSessionDto, SessionEventDto } from './dto/create-session.dto';
import { SessionEventsService } from './session-events.service';
import { STATUS_LABEL, TERMINAL, type SessionStatusValue } from './session-state';

/** Event names: plain identifiers, so they render inertly in the timeline. */
const EVENT_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

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
    private readonly events: SessionEventsService,
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

    // Owners and admins may reach any computer in scope; technicians their
    // assignment's; everyone else needs an active grant or COMPANY_WIDE.
    {
      const authorized = await this.acl.canReachEndpoint(actor, endpoint);
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

  /**
   * The technician closes a session out. Their notes, disposition and any
   * manually entered work time are kept on the row; the measured connection
   * duration is NOT computed from this — a technician's click is a report,
   * not a measurement (see session-state.ts).
   */
  async complete(actor: ActorContext, id: string, dto: CompleteSessionDto) {
    const session = await this.loadForMutation(actor, id);
    if (TERMINAL.includes(session.status as SessionStatusValue)) {
      throw new ConflictException(`Session is already ${STATUS_LABEL[session.status as SessionStatusValue].toLowerCase()}`);
    }
    // The transition first, refusing rather than recording if it no longer
    // applies (a racing close won): then nothing at all is written, notes
    // included.
    const r = await this.events.record(id, { type: 'technician_completed', source: 'technician', receivedAt: new Date() }, {
      actorId: actor.userId, dedupeKey: 'technician:completed', requireApplied: true,
    });
    if (!r.applied) throw new ConflictException('Session was closed by another request');
    await this.prisma.supportSession.update({
      where: { id },
      data: {
        notes: dto.notes ?? undefined,
        disposition: dto.disposition ?? undefined,
        ...(dto.manualWorkMinutes !== undefined ? { manualWorkMinutes: dto.manualWorkMinutes } : {}),
      },
    });
    await this.audit.log({
      tenantId: session.tenantId, customerId: session.customerId ?? undefined,
      actorId: actor.userId, actorIp: actor.ip,
      action: 'SESSION_COMPLETED', resource: 'support_session', resourceId: id,
      meta: { disposition: dto.disposition, manualWorkMinutes: dto.manualWorkMinutes ?? null, applied: r.applied },
    });
    return this.prisma.supportSession.findUnique({ where: { id } });
  }

  async cancel(actor: ActorContext, id: string) {
    const session = await this.loadForMutation(actor, id);
    if (TERMINAL.includes(session.status as SessionStatusValue)) {
      throw new ConflictException(`Session is already ${STATUS_LABEL[session.status as SessionStatusValue].toLowerCase()}`);
    }
    const r = await this.events.record(id, { type: 'technician_canceled', source: 'technician', receivedAt: new Date() }, {
      actorId: actor.userId, dedupeKey: 'technician:canceled', requireApplied: true,
    });
    if (!r.applied) throw new ConflictException('Session was closed by another request');
    await this.audit.log({
      tenantId: session.tenantId, customerId: session.customerId ?? undefined,
      actorId: actor.userId, actorIp: actor.ip,
      action: 'SESSION_CANCELED', resource: 'support_session', resourceId: id,
    });
    return this.prisma.supportSession.findUnique({ where: { id } });
  }

  /**
   * Events a signed-in technician may report from the browser.
   *
   * Only what a person can actually know: that they are connected (their
   * word, recorded as source "technician"), or that it failed. The old
   * `client_opened` / `client_closed` events are refused — a browser cannot
   * observe either, and `client_closed` used to complete a session with a
   * duration measured from the credential release.
   *
   * Authorization is the write check (`loadForMutation`), never the read
   * scope, and a report that does not apply to the session's current state
   * is a 409 that writes nothing (see 0.19.12).
   */
  async addEvent(actor: ActorContext, sessionId: string, dto: SessionEventDto) {
    if (typeof dto.event !== 'string' || !EVENT_NAME_RE.test(dto.event)) {
      throw new BadRequestException('event must be a lower-case identifier');
    }
    const map: Record<string, 'connection_confirmed' | 'technician_failed'> = {
      connected: 'connection_confirmed',
      failed: 'technician_failed',
    };
    const session = await this.loadForMutation(actor, sessionId);
    if (TERMINAL.includes(session.status as SessionStatusValue)) {
      throw new ConflictException(`Session is already ${STATUS_LABEL[session.status as SessionStatusValue].toLowerCase()}`);
    }
    const type = map[dto.event];
    if (!type) {
      throw new BadRequestException('Unsupported event. A technician can report "connected" or "failed".');
    }
    const r = await this.events.record(sessionId, { type, source: 'technician', receivedAt: new Date() }, {
      actorId: actor.userId, dedupeKey: `technician:${type}`, requireApplied: true,
      metadata: dto.metadata ? { note: String((dto.metadata as { note?: unknown }).note ?? '').slice(0, 200) } : undefined,
    });
    if (!r.applied) {
      throw new ConflictException(`"${dto.event}" does not apply to this session in its current state`);
    }
    return r;
  }

  async getStats(actor: ActorContext, days = 30, businessId?: string) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const scope = this.sessionScope(actor, businessId);

    const [total, completed, confirmedActive, launchedUnconfirmed, canceled, unknown, failed, measured] = await Promise.all([
      this.prisma.supportSession.count({ where: { ...scope, createdAt: { gte: since } } }),
      this.prisma.supportSession.count({ where: { ...scope, status: SessionStatus.SESSION_COMPLETED, createdAt: { gte: since } } }),
      this.prisma.supportSession.count({ where: { ...scope, status: SessionStatus.SESSION_STARTED } }),
      this.prisma.supportSession.count({
        where: { ...scope, status: { in: [SessionStatus.LAUNCH_REQUESTED, SessionStatus.LAUNCHER_ACKNOWLEDGED, SessionStatus.CLIENT_OPENED] } },
      }),
      this.prisma.supportSession.count({ where: { ...scope, status: SessionStatus.CANCELED, createdAt: { gte: since } } }),
      this.prisma.supportSession.count({ where: { ...scope, status: SessionStatus.STATUS_UNKNOWN, createdAt: { gte: since } } }),
      this.prisma.supportSession.count({ where: { ...scope, status: SessionStatus.FAILED, createdAt: { gte: since } } }),
      // Only MEASURED rows: confirmed start and observed end, both from the
      // endpoint. Legacy, reported and inferred timings never enter an average.
      this.prisma.supportSession.aggregate({
        where: { ...scope, timingQuality: 'MEASURED', duration: { not: null }, createdAt: { gte: since } },
        _avg: { duration: true },
        _count: { duration: true },
      }),
    ]);

    return {
      total,
      completed,
      // "active" used to be every row not completed/failed/canceled, which
      // counted every unconfirmed launch as a live session.
      active: confirmedActive,
      confirmedActive,
      launchedUnconfirmed,
      canceled,
      unknown,
      failed,
      avgDurationSeconds: measured._count.duration > 0 ? Math.round(measured._avg?.duration ?? 0) : null,
      measuredSessions: measured._count.duration,
      periodDays: days,
    };
  }

  /**
   * Close out launches that never produced a confirming or failing signal.
   *
   * This used to mark them FAILED. That was a guess dressed as a verdict: a
   * launch from a technician whose computer simply does not report back (an
   * older Connect script, a launcher that only acknowledges) may well have
   * connected. They are STATUS_UNKNOWN now, flagged as an inferred closure,
   * with no end time and no duration.
   *
   *   launched / acknowledged, nothing for 30 minutes   → unknown
   *   client opened, never confirmed, for 12 hours      → unknown
   */
  async expireStaleSessions(thresholdMinutes = 30) {
    const now = Date.now();
    const early = await this.prisma.supportSession.findMany({
      where: {
        isAdHoc: false,
        status: { in: [SessionStatus.PENDING, SessionStatus.LAUNCH_REQUESTED, SessionStatus.LAUNCHER_ACKNOWLEDGED] },
        createdAt: { lt: new Date(now - thresholdMinutes * 60_000) },
      },
      select: { id: true },
      take: 500,
    });
    const opened = await this.prisma.supportSession.findMany({
      where: {
        status: SessionStatus.CLIENT_OPENED,
        createdAt: { lt: new Date(now - 12 * 3600_000) },
      },
      select: { id: true },
      take: 500,
    });
    let n = 0;
    for (const s of [...early, ...opened]) {
      const r = await this.events.record(s.id, { type: 'timeout_unknown', source: 'timeout', receivedAt: new Date() }, { dedupeKey: 'timeout:unknown' });
      if (r.applied) n++;
    }
    return n;
  }

  /**
   * Close confirmed sessions nothing has reported on for a long time.
   *
   * A session confirmed by the endpoint agent is re-confirmed on every
   * heartbeat while it lasts, so one silent for an hour has an endpoint that
   * stopped reporting; one confirmed by the technician has no such signal and
   * gets 12 hours. Either way the end is INFERRED: endedAt is the last time
   * anything reported it alive, and no duration is recorded.
   */
  async closeAbandonedSessions(thresholdHours = 12) {
    const now = Date.now();
    const rows = await this.prisma.supportSession.findMany({
      where: {
        status: SessionStatus.SESSION_STARTED,
        OR: [
          { statusSource: 'endpoint_agent', lastSignalAt: { lt: new Date(now - 60 * 60_000) } },
          { NOT: { statusSource: 'endpoint_agent' }, lastSignalAt: { lt: new Date(now - thresholdHours * 3600_000) } },
          { lastSignalAt: null, connectionConfirmedAt: { lt: new Date(now - thresholdHours * 3600_000) } },
        ],
      },
      select: { id: true },
      take: 500,
    });
    let n = 0;
    for (const s of rows) {
      const r = await this.events.record(s.id, { type: 'timeout_ended', source: 'timeout', receivedAt: new Date() }, { dedupeKey: 'timeout:ended' });
      if (r.applied) n++;
    }
    return n;
  }
}
