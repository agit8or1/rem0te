import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { SessionStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CreateSessionDto, CompleteSessionDto, SessionEventDto } from './dto/create-session.dto';

@Injectable()
export class SessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async findAll(
    tenantId: string,
    opts: {
      status?: SessionStatus;
      technicianId?: string;
      endpointId?: string;
      page?: number;
      limit?: number;
    } = {},
  ) {
    const page = opts.page ?? 1;
    const limit = Math.min(opts.limit ?? 50, 200);
    const skip = (page - 1) * limit;

    const where = {
      tenantId,
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
          endpoint: { select: { id: true, name: true, hostname: true, rustdeskNode: { select: { rustdeskId: true } } } },
        },
      }),
      this.prisma.supportSession.count({ where }),
    ]);

    return { sessions, total, page, limit, pages: Math.ceil(total / limit) };
  }

  async findOne(tenantId: string, id: string) {
    const session = await this.prisma.supportSession.findFirst({
      where: { id, tenantId },
      include: {
        technician: { select: { id: true, email: true, firstName: true, lastName: true } },
        endpoint: {
          select: {
            id: true, name: true, hostname: true, rustdeskNode: { select: { rustdeskId: true } },
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
    if (!session) throw new NotFoundException(`Session ${id} not found`);
    return session;
  }

  async create(
    tenantId: string,
    technicianId: string,
    dto: CreateSessionDto,
    actor?: { isPlatformAdmin?: boolean; roleType?: string | null },
  ) {
    if (!dto.endpointId && !dto.adHocRustdeskId) {
      throw new BadRequestException('Either endpointId or adHocRustdeskId is required');
    }

    if (dto.endpointId) {
      const endpoint = await this.prisma.endpoint.findFirst({
        where: { id: dto.endpointId, tenantId },
        select: { id: true, accessMode: true, customerId: true },
      });
      if (!endpoint) throw new NotFoundException(`Endpoint ${dto.endpointId} not found`);

      // Authorization: the caller must actually be allowed to connect to this
      // computer. Platform admins and tenant owner/admin bypass this check
      // (they can manage everything); everyone else must have a
      // ComputerAccess row OR the computer must be COMPANY_WIDE and the
      // caller must be a member of the same customer.
      const isMgmt =
        actor?.isPlatformAdmin === true ||
        actor?.roleType === 'TENANT_OWNER' ||
        actor?.roleType === 'TENANT_ADMIN';
      if (!isMgmt) {
        const access = await this.prisma.computerAccess.findFirst({
          where: { endpointId: dto.endpointId, userId: technicianId },
          select: { id: true },
        });
        let authorized = !!access;
        if (!authorized && endpoint.accessMode === 'COMPANY_WIDE' && endpoint.customerId) {
          const membership = await this.prisma.membership.findFirst({
            where: {
              tenantId,
              userId: technicianId,
              isActive: true,
              customerId: endpoint.customerId,
            },
            select: { id: true },
          });
          authorized = !!membership;
        }
        if (!authorized) {
          await this.audit.log({
            tenantId,
            actorId: technicianId,
            action: 'SESSION_LAUNCHED',
            resource: 'support_session',
            meta: { endpointId: dto.endpointId, denied: 'no_access' },
          });
          throw new ForbiddenException('You do not have access to this computer');
        }
      }
    }

    const session = await this.prisma.supportSession.create({
      data: {
        tenantId,
        technicianId,
        endpointId: dto.endpointId ?? null,
        adHocRustdeskId: dto.adHocRustdeskId ?? null,
        isAdHoc: dto.isAdHoc ?? !!dto.adHocRustdeskId,
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
      tenantId,
      actorId: technicianId,
      action: 'SESSION_LAUNCHED',
      resource: 'support_session',
      resourceId: session.id,
      meta: {
        endpointId: dto.endpointId,
        adHocRustdeskId: dto.adHocRustdeskId,
        isAdHoc: session.isAdHoc,
      },
    });

    return session;
  }

  async complete(tenantId: string, id: string, actorId: string, dto: CompleteSessionDto) {
    const session = await this.findOne(tenantId, id);

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
      tenantId,
      actorId,
      action: 'SESSION_COMPLETED',
      resource: 'support_session',
      resourceId: id,
      meta: { disposition: dto.disposition, duration },
    });

    return updated;
  }

  async cancel(tenantId: string, id: string, actorId: string) {
    const session = await this.findOne(tenantId, id);

    if (session.status === SessionStatus.SESSION_COMPLETED || session.status === SessionStatus.CANCELED) {
      throw new BadRequestException(`Session is already ${session.status.toLowerCase()}`);
    }

    const updated = await this.prisma.supportSession.update({
      where: { id },
      data: { status: SessionStatus.CANCELED, completedAt: new Date() },
    });

    await this.audit.log({
      tenantId,
      actorId,
      action: 'SESSION_CANCELED',
      resource: 'support_session',
      resourceId: id,
    });

    return updated;
  }

  async addEvent(tenantId: string, sessionId: string, dto: SessionEventDto) {
    // Verify session belongs to tenant
    const session = await this.prisma.supportSession.findFirst({ where: { id: sessionId, tenantId } });
    if (!session) throw new NotFoundException(`Session ${sessionId} not found`);

    const event = await this.prisma.supportSessionEvent.create({
      data: {
        supportSessionId: sessionId,
        event: dto.event,
        metadata: dto.metadata ? (dto.metadata as Prisma.InputJsonValue) : undefined,
      },
    });

    // Update session status based on event type
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

  async getStats(tenantId: string, days = 30) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [total, completed, active, canceled, avgDuration] = await Promise.all([
      this.prisma.supportSession.count({ where: { tenantId, createdAt: { gte: since } } }),
      this.prisma.supportSession.count({ where: { tenantId, status: SessionStatus.SESSION_COMPLETED, createdAt: { gte: since } } }),
      this.prisma.supportSession.count({ where: { tenantId, status: { notIn: [SessionStatus.SESSION_COMPLETED, SessionStatus.FAILED, SessionStatus.CANCELED] } } }),
      this.prisma.supportSession.count({ where: { tenantId, status: SessionStatus.CANCELED, createdAt: { gte: since } } }),
      this.prisma.supportSession.aggregate({
        where: { tenantId, status: SessionStatus.SESSION_COMPLETED, duration: { not: null }, createdAt: { gte: since } },
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
