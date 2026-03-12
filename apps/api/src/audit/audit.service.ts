import { Injectable, Logger } from '@nestjs/common';
import { ActivityAction, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

interface LogParams {
  action: ActivityAction;
  actorId?: string;
  tenantId?: string;
  actorIp?: string;
  actorAgent?: string;
  resource?: string;
  resourceId?: string;
  // Accept either `meta` (used by services) or `metadata`
  meta?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

interface QueryParams {
  tenantId: string;
  action?: ActivityAction;
  actorId?: string;
  resource?: string;
  fromDate?: Date;
  toDate?: Date;
  page?: number;
  limit?: number;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async log(params: LogParams): Promise<void> {
    const metadata = params.metadata ?? params.meta ?? undefined;
    try {
      await this.prisma.activityLog.create({
        data: {
          action: params.action,
          actorId: params.actorId ?? null,
          tenantId: params.tenantId ?? null,
          actorIp: params.actorIp ?? null,
          actorAgent: params.actorAgent ?? null,
          resource: params.resource ?? null,
          resourceId: params.resourceId ?? null,
          metadata: metadata ? (metadata as Prisma.InputJsonValue) : undefined,
        },
      });
    } catch (err) {
      // Audit failures must never crash the primary request path.
      this.logger.error('Failed to write audit log', err);
    }
  }

  async query(params: QueryParams) {
    const page = params.page ?? 1;
    const limit = Math.min(params.limit ?? 50, 200);
    const skip = (page - 1) * limit;

    const where = {
      tenantId: params.tenantId,
      ...(params.action ? { action: params.action } : {}),
      ...(params.actorId ? { actorId: params.actorId } : {}),
      ...(params.resource ? { resource: params.resource } : {}),
      ...(params.fromDate || params.toDate
        ? {
            createdAt: {
              ...(params.fromDate ? { gte: params.fromDate } : {}),
              ...(params.toDate ? { lte: params.toDate } : {}),
            },
          }
        : {}),
    };

    const [logs, total] = await Promise.all([
      this.prisma.activityLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          actor: {
            select: { id: true, email: true, firstName: true, lastName: true },
          },
        },
      }),
      this.prisma.activityLog.count({ where }),
    ]);

    return {
      logs,
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
    };
  }
}
