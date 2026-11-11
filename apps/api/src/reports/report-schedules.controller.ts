import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Actor } from '../common/decorators/actor.decorator';
import { RateLimit } from '../common/throttling';
import type { ActorContext } from '../rbac/access-control.service';
import { StepUpService } from '../auth/step-up.service';
import { assertFresh } from '../security-controls/review';
import { ReportSchedulesService } from './report-schedules.service';

/**
 * Scheduled reports (0.34). Who may set one up is decided in the service: a
 * Business Owner of the business, or a Platform Admin, holding the report's
 * own capability (computers:view or monitoring:alerts). Creating or changing
 * one decides where a business's data is mailed, so both need fresh
 * authentication; deleting one only stops mail and does not.
 */
@Controller('reports/schedules')
export class ReportSchedulesController {
  constructor(private readonly svc: ReportSchedulesService, private readonly stepUp: StepUpService) {}

  private fresh(req: Request) {
    const u = req.user as { sub?: string; iat?: number } | undefined;
    assertFresh(u?.sub ? this.stepUp.read(req, u.sub, u.iat)?.method ?? null : null);
  }

  @Get()
  async list(@Actor() a: ActorContext, @Query() q: Record<string, unknown>) {
    return { success: true, data: await this.svc.list(a, typeof q.businessId === 'string' && q.businessId ? q.businessId : null) };
  }

  @Post()
  @RateLimit(20)
  async create(@Actor() a: ActorContext, @Body() body: unknown, @Req() req: Request) {
    this.fresh(req);
    return { success: true, data: await this.svc.create(a, body) };
  }

  @Patch(':id')
  @RateLimit(30)
  async update(@Actor() a: ActorContext, @Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    this.fresh(req);
    return { success: true, data: await this.svc.update(a, id, body) };
  }

  @Delete(':id')
  async remove(@Actor() a: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.svc.remove(a, id) };
  }
}
