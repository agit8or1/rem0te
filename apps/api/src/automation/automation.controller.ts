import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Actor } from '../common/decorators/actor.decorator';
import { RateLimit } from '../common/throttling';
import type { ActorContext } from '../rbac/access-control.service';
import { StepUpService } from '../auth/step-up.service';
import { assertFresh } from '../security-controls/review';
import { AutomationService } from './automation.service';

/**
 * Automation schedules (0.58). Proposing, reading, pausing, resuming and
 * revoking. There is no approve route: a schedule is approved on the
 * approval signer's own origin, with passkeys, and every run it signs there.
 * Creating, resuming and revoking need a fresh sign-in (catalog key
 * automation.policy); pausing never does, because it only narrows.
 */
@Controller()
@UseGuards(JwtAuthGuard)
export class AutomationController {
  constructor(private readonly svc: AutomationService, private readonly stepUp: StepUpService) {}

  private freshMethod(req: Request): string | null {
    const u = req.user as { sub?: string; iat?: number } | undefined;
    return u?.sub ? this.stepUp.read(req, u.sub, u.iat)?.method ?? null : null;
  }

  /** Schedules (create, resume, revoke): catalog key automation.policy (confirm-catalog.ts). */
  private fresh(req: Request) {
    assertFresh(this.freshMethod(req), { action: 'automation.policy' });
  }

  @Get('automation/schedules')
  async list(@Actor() actor: ActorContext, @Query('businessId') businessId?: string) {
    return { success: true, data: { readiness: await this.svc.readiness(), schedules: await this.svc.list(actor, businessId) } };
  }

  @Post('automation/schedules')
  @RateLimit(10)
  async create(@Actor() actor: ActorContext, @Body() body: unknown, @Req() req: Request) {
    this.fresh(req);
    return { success: true, data: await this.svc.create(actor, body, this.freshMethod(req)) };
  }

  /** A schedule's description and next runs, by the signer's own functions. Pure: reads and writes nothing. */
  @Post('automation/schedules/preview')
  @HttpCode(HttpStatus.OK)
  @RateLimit(60)
  preview(@Body() body: unknown) {
    return { success: true, data: this.svc.preview(body) };
  }

  @Get('automation/schedules/:id')
  async detail(@Actor() actor: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.svc.detail(actor, id) };
  }

  @Post('automation/schedules/:id/pause')
  @HttpCode(HttpStatus.OK)
  async pause(@Actor() actor: ActorContext, @Param('id') id: string, @Body() body: unknown) {
    return { success: true, data: await this.svc.pause(actor, id, body) };
  }

  @Post('automation/schedules/:id/resume')
  @HttpCode(HttpStatus.OK)
  async resume(@Actor() actor: ActorContext, @Param('id') id: string, @Req() req: Request) {
    this.fresh(req);
    return { success: true, data: await this.svc.resume(actor, id) };
  }

  @Post('automation/schedules/:id/revoke')
  @HttpCode(HttpStatus.OK)
  async revoke(@Actor() actor: ActorContext, @Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    this.fresh(req);
    return { success: true, data: await this.svc.revoke(actor, id, body) };
  }
}
