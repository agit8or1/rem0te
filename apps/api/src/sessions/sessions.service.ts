import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { SessionStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';
import { CreateSessionDto, CompleteSessionDto, SessionEventDto } from './dto/create-session.dto';

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
   * Scope filter for every session query.
   *
   * A Business User who cannot view history only ever sees sessions they ran
   * themselves — the business filter alone would show them their colleagues'.
   */
  private sessionScope(actor: ActorContext, businessId?: string) {
    const scope = this.acl.resolveScope(actor, businessId);
    const canSeeOthers = this.acl.isBusinessOwner(actor) || this.acl.can(actor, CAP.HISTORY_VIEW);
    return {
      ...(scope ? { customerId: scope } : {}),
      ...(canSeeOthers ? {} : { technicianId: actor.userId }),
    };
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
    const session = await this.findOne(actor, id);

    if (session.status === SessionStatus.SESSION_COMPLETED || session.status === SessionStatus.CANCELED) {
      throw new BadRequestException(`Session is already ${session.status.toLowerCase()}`);
    }

    const now = new Date();
    const duration = session.startedAt
      ? Math.round((now.getTime() - session.startedAt.getTime()) / 1000)
      : null;

    const updated = await this.prisma.supportSession.update({
      where: { id },
      data: {
        status: SessionStatus.SESSION_COMPLETED,
        completedAt: now,
        duration: duration ?? undefined,
        notes: dto.notes ?? undefined,
        disposition: dto.disposition ?? undefined,
      },
    });

    await this.audit.log({
      tenantId: session.tenantId, customerId: session.customerId ?? undefined,
      actorId: actor.userId, actorIp: actor.ip,
      action: 'SESSION_COMPLETED', resource: 'support_session', resourceId: id,
      meta: { disposition: dto.disposition, duration },
    });

    return updated;
  }

  async cancel(actor: ActorContext, id: string) {
    const session = await this.findOne(actor, id);

    if (session.status === SessionStatus.SESSION_COMPLETED || session.status === SessionStatus.CANCELED) {
      throw new BadRequestException(`Session is already ${session.status.toLowerCase()}`);
    }

    const updated = await this.prisma.supportSession.update({
      where: { id },
      data: { status: SessionStatus.CANCELED, completedAt: new Date() },
    });

    await this.audit.log({
      tenantId: session.tenantId, customerId: session.customerId ?? undefined,
      actorId: actor.userId, actorIp: actor.ip,
      action: 'SESSION_CANCELED', resource: 'support_session', resourceId: id,
    });

    return updated;
  }

  async addEvent(actor: ActorContext, sessionId: string, dto: SessionEventDto) {
    const session = await this.prisma.supportSession.findFirst({
      where: { id: sessionId, ...this.sessionScope(actor) },
      select: { id: true, startedAt: true },
    });
    if (!session) throw new NotFoundException('Session not found');

    const event = await this.prisma.supportSessionEvent.create({
      data: {
        supportSessionId: sessionId,
        event: dto.event,
        metadata: dto.metadata ? (dto.metadata as Prisma.InputJsonValue) : undefined,
      },
    });

    if (dto.event === 'client_opened') {
      await this.prisma.supportSession.update({
        where: { id: sessionId },
        data: { status: SessionStatus.CLIENT_OPENED, startedAt: new Date() },
      });
    } else if (dto.event === 'client_closed') {
      const now = new Date();
      const duration = session.startedAt
        ? Math.round((now.getTime() - session.startedAt.getTime()) / 1000)
        : null;
      await this.prisma.supportSession.update({
        where: { id: sessionId },
        data: { status: SessionStatus.SESSION_COMPLETED, completedAt: now, duration: duration ?? undefined },
      });
    }

    return event;
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
}
