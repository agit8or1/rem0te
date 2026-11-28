import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ActivityAction } from '@prisma/client';
import { AuditService } from './audit.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequireCapability } from '../common/decorators/require-capability.decorator';
import { Actor } from '../common/decorators/actor.decorator';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';

/** 0.93: a record id from a background tool's audit link (cuid, uuid or similar). */
const RESOURCE_ID = /^[A-Za-z0-9_-]{1,64}$/;

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
    @Query('resourceId') resourceId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const scope = this.acl.resolveScope(actor, businessId);
    // 0.93 (UX P1-7): the background tools link here by record. The filters
    // only narrow the caller's scope above; malformed ones are refused rather
    // than passed to the database (an unknown action used to be a 500).
    if (resourceId !== undefined && !RESOURCE_ID.test(resourceId)) throw new BadRequestException({ code: 'BAD_RESOURCE_ID', message: 'resourceId must be 1–64 letters, digits, _ or -.' });
    if (action !== undefined && !(Object.values(ActivityAction) as string[]).includes(action)) throw new BadRequestException({ code: 'BAD_ACTION', message: 'Unknown audit action.' });

    const result = await this.audit.query({
      customerId: scope ?? undefined,
      action: action as ActivityAction | undefined,
      actorId,
      resource,
      resourceId,
      fromDate: from ? new Date(from) : undefined,
      toDate: to ? new Date(to) : undefined,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 50,
    });

    return { success: true, data: { ...result, scope: scope ? 'business' : 'platform' } };
  }
}
