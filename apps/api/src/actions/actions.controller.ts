import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Actor } from '../common/decorators/actor.decorator';
import { RateLimit } from '../common/throttling';
import type { ActorContext } from '../rbac/access-control.service';
import { StepUpService } from '../auth/step-up.service';
import { ActionsService } from './actions.service';

/**
 * Approved actions (v0.26). Requesting, reading, canceling and reconciling an
 * uncertain outcome — there is
 * deliberately no approve route here. Approval happens on the approval
 * signer's own origin, with a passkey on its roster.
 */
@Controller()
@UseGuards(JwtAuthGuard)
export class ActionsController {
  constructor(private readonly actions: ActionsService, private readonly stepUp: StepUpService) {}

  /** 0.39: direct mode needs a fresh sign-in for a request (ActionsService.createPlan). */
  private freshMethod(req: Request): string | null {
    const u = req.user as { sub?: string; iat?: number } | undefined;
    return u?.sub ? this.stepUp.read(req, u.sub, u.iat)?.method ?? null : null;
  }

  @Get('actions/catalog')
  async catalog(@Actor() actor: ActorContext, @Query('endpointId') endpointId?: string) {
    // 0.39: with endpointId, also the approval mode its business is in on the signer (read only).
    return { success: true, data: { ...this.actions.catalog(), approval: endpointId ? await this.actions.approvalModeFor(actor, endpointId) : null } };
  }

  @Get('endpoints/:id/actions')
  async list(@Actor() actor: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.actions.list(actor, id) };
  }

  @Post('endpoints/:id/actions')
  @RateLimit(10)
  async request(@Actor() actor: ActorContext, @Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    return { success: true, data: await this.actions.request(actor, id, body, undefined, undefined, this.freshMethod(req)) };
  }

  @Get('actions/:id')
  async get(@Actor() actor: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.actions.get(actor, id) };
  }

  @Post('actions/:id/cancel')
  @HttpCode(HttpStatus.OK)
  async cancel(@Actor() actor: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.actions.cancel(actor, id) };
  }

  @Post('actions/:id/reconcile')
  @HttpCode(HttpStatus.OK)
  @RateLimit(10)
  async reconcile(@Actor() actor: ActorContext, @Param('id') id: string, @Body() body: unknown) {
    return { success: true, data: await this.actions.reconcile(actor, id, body) };
  }
}
