import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ActivityAction } from '@prisma/client';
import { AuditService } from './audit.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/strategies/jwt.strategy';

@Controller('audit')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @RequirePermissions('audit:read')
  async getLogs(
    @CurrentUser() user: JwtPayload,
    @Query('action') action?: string,
    @Query('actorId') actorId?: string,
    @Query('resource') resource?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    if (!user.tenantId) {
      return { success: false, message: 'No tenant context' };
    }

    const result = await this.audit.query({
      tenantId: user.tenantId,
      action: action as ActivityAction | undefined,
      actorId,
      resource,
      fromDate: from ? new Date(from) : undefined,
      toDate: to ? new Date(to) : undefined,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 50,
    });

    return { success: true, data: result };
  }
}
