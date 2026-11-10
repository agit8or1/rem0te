import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Actor } from '../common/decorators/actor.decorator';
import type { ActorContext } from '../rbac/access-control.service';
import { StepUpService } from '../auth/step-up.service';
import { assertFresh } from '../security-controls/review';
import { MonitoringAdminService } from './monitoring-admin.service';

const biz = (q: Record<string, unknown>) => (typeof q.businessId === 'string' && q.businessId ? q.businessId : undefined);

/**
 * Monitoring (v0.29). Read-side throughout: nothing here reaches a computer.
 * Changing who is notified needs fresh authentication; setting monitors and
 * maintenance windows does not, but both are audited.
 */
@Controller('monitoring')
@UseGuards(JwtAuthGuard)
export class MonitoringController {
  constructor(private readonly svc: MonitoringAdminService, private readonly stepUp: StepUpService) {}

  private fresh(req: Request) {
    const u = req.user as { sub?: string; iat?: number } | undefined;
    assertFresh(u?.sub ? this.stepUp.read(req, u.sub, u.iat)?.method ?? null : null);
  }

  @Get('summary')
  async summary(@Actor() a: ActorContext, @Query() q: Record<string, unknown>) { return { success: true, data: await this.svc.summary(a, biz(q)) }; }

  @Get('alerts')
  async alerts(@Actor() a: ActorContext, @Query() q: Record<string, unknown>) { return { success: true, data: await this.svc.listAlerts(a, q, biz(q)) }; }

  @Get('alerts/:id')
  async alert(@Actor() a: ActorContext, @Param('id') id: string, @Query() q: Record<string, unknown>) { return { success: true, data: await this.svc.getAlert(a, id, biz(q)) }; }

  @Post('alerts/:id/acknowledge')
  @HttpCode(HttpStatus.OK)
  async ack(@Actor() a: ActorContext, @Param('id') id: string, @Body() body: unknown, @Query() q: Record<string, unknown>) { return { success: true, data: await this.svc.acknowledge(a, id, body, biz(q)) }; }

  @Post('alerts/:id/resolve')
  @HttpCode(HttpStatus.OK)
  async resolve(@Actor() a: ActorContext, @Param('id') id: string, @Body() body: unknown, @Query() q: Record<string, unknown>) { return { success: true, data: await this.svc.resolveAlert(a, id, body, biz(q)) }; }

  @Get('rules')
  async rules(@Actor() a: ActorContext, @Query() q: Record<string, unknown>) { return { success: true, data: await this.svc.listRules(a, biz(q)) }; }

  @Post('rules')
  async createRule(@Actor() a: ActorContext, @Body() body: unknown) { return { success: true, data: await this.svc.createRule(a, body) }; }

  @Post('rules/recommended')
  async recommended(@Actor() a: ActorContext, @Body() body: unknown) { return { success: true, data: await this.svc.addRecommended(a, body) }; }

  @Patch('rules/:id')
  async updateRule(@Actor() a: ActorContext, @Param('id') id: string, @Body() body: unknown) { return { success: true, data: await this.svc.updateRule(a, id, body) }; }

  @Delete('rules/:id')
  async deleteRule(@Actor() a: ActorContext, @Param('id') id: string) { return { success: true, data: await this.svc.deleteRule(a, id) }; }

  @Get('suppressions')
  async suppressions(@Actor() a: ActorContext, @Query() q: Record<string, unknown>) { return { success: true, data: await this.svc.listSuppressions(a, biz(q)) }; }

  @Post('suppressions')
  async suppress(@Actor() a: ActorContext, @Body() body: unknown) { return { success: true, data: await this.svc.createSuppression(a, body) }; }

  @Post('suppressions/:id/revoke')
  @HttpCode(HttpStatus.OK)
  async revoke(@Actor() a: ActorContext, @Param('id') id: string) { return { success: true, data: await this.svc.revokeSuppression(a, id) }; }

  @Get('notify-policy')
  async policy(@Actor() a: ActorContext, @Query() q: Record<string, unknown>) { return { success: true, data: await this.svc.getPolicy(a, biz(q)) }; }

  @Put('notify-policy')
  async putPolicy(@Actor() a: ActorContext, @Body() body: unknown, @Req() req: Request) {
    this.fresh(req);
    return { success: true, data: await this.svc.putPolicy(a, body) };
  }

  @Get('endpoints/:id')
  async endpoint(@Actor() a: ActorContext, @Param('id') id: string) { return { success: true, data: await this.svc.endpointView(a, id) }; }
}
