import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ActivityAction, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

interface LogParams {
  action: ActivityAction;
  actorId?: string;
  tenantId?: string;
  /** Business scope. Set it on anything a Business Owner should be able to see. */
  customerId?: string;
  actorIp?: string;
  actorAgent?: string;
  resource?: string;
  resourceId?: string;
  // Accept either `meta` (used by services) or `metadata`
  meta?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

interface QueryParams {
  tenantId?: string;
  /**
   * Business scope. `undefined` means platform-wide and is only ever passed
   * by a Platform Admin — AuditController resolves it through
   * AccessControlService before it gets here.
   */
  customerId?: string;
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
    try {
      await this.write(params);
    } catch (err) {
      // Audit failures must never crash the primary request path — except
      // where the record IS the control: see logOrFail.
      this.logger.error('Failed to write audit log', err);
    }
  }

  /**
   * Write the entry or refuse the request. For releasing a credential (a
   * password reveal, a connect that hands one over): a reveal nobody can see
   * afterwards is the one outcome worse than a refused reveal, so callers
   * write this BEFORE the secret leaves and let a failure abort the request.
   */
  async logOrFail(params: LogParams): Promise<void> {
    try {
      await this.write(params);
    } catch (err) {
      this.logger.error(`Audit write failed; refusing ${params.action}`, err);
      throw new ServiceUnavailableException({ code: 'AUDIT_UNAVAILABLE', message: 'This was not done: the audit log could not be written. Try again shortly.' });
    }
  }

  private async write(params: LogParams): Promise<void> {
    const metadata = params.metadata ?? params.meta ?? undefined;
    await this.prisma.activityLog.create({
      data: {
        action: params.action,
        actorId: params.actorId ?? null,
        tenantId: params.tenantId ?? null,
        customerId: params.customerId ?? null,
        actorIp: params.actorIp ?? null,
        actorAgent: params.actorAgent ?? null,
        resource: params.resource ?? null,
        resourceId: params.resourceId ?? null,
        metadata: metadata ? (metadata as Prisma.InputJsonValue) : undefined,
      },
    });
  }

  async query(params: QueryParams) {
    const page = params.page ?? 1;
    const limit = Math.min(params.limit ?? 50, 200);
    const skip = (page - 1) * limit;

    const where = {
      ...(params.tenantId ? { tenantId: params.tenantId } : {}),
      ...(params.customerId ? { customerId: params.customerId } : {}),
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
