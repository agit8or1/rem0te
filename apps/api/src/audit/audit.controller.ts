import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ActivityAction } from '@prisma/client';
import { AuditService } from './audit.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequireCapability } from '../common/decorators/require-capability.decorator';
import { Actor } from '../common/decorators/actor.decorator';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';

@Controller('audit')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AuditController {
  constructor(
    private readonly audit: AuditService,
    private readonly acl: AccessControlService,
  ) {}

  /**
   * Business audit log. A Platform Admin sees every event (and may narrow to
   * one business with `?businessId=`); everyone else sees only their own
   * business, regardless of what they ask for.
   */
  @Get()
  @RequireCapability(CAP.AUDIT_VIEW)
  async getLogs(
    @Actor() actor: ActorContext,
    @Query('businessId') businessId?: string,
    @Query('action') action?: string,
    @Query('actorId') actorId?: string,
    @Query('resource') resource?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const scope = this.acl.resolveScope(actor, businessId);

    const result = await this.audit.query({
      customerId: scope ?? undefined,
      action: action as ActivityAction | undefined,
      actorId,
      resource,
      fromDate: from ? new Date(from) : undefined,
      toDate: to ? new Date(to) : undefined,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 50,
    });

    return { success: true, data: { ...result, scope: scope ? 'business' : 'platform' } };
  }
}
