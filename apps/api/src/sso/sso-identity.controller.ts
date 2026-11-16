import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Actor } from '../common/decorators/actor.decorator';
import { RateLimit } from '../common/throttling';
import { StepUpService } from '../auth/step-up.service';
import { assertFresh } from '../security-controls/review';
import type { ActorContext } from '../rbac/access-control.service';
import { SsoIdentityService } from './sso-identity.service';

/**
 * 0.59, Platform Admin only: link suggestions, sign-in enforcement and
 * break-glass accounts. Every check of who and what runs before the fresh
 * authentication; the write after it.
 */
@Controller('sso')
export class SsoIdentityController {
  constructor(private readonly svc: SsoIdentityService, private readonly stepUp: StepUpService) {}

  private method(req: Request): string | null {
    const u = req.user as { sub?: string; iat?: number } | undefined;
    return u?.sub ? this.stepUp.read(req, u.sub, u.iat)?.method ?? null : null;
  }

  @Get('link-suggestions')
  async suggestions(@Actor() actor: ActorContext) {
    return { success: true, data: await this.svc.suggestions(actor) };
  }

  /** One link, confirmed by a Platform Admin. Never automatic, never in bulk. */
  @Post('link-suggestions/:id/confirm')
  @HttpCode(HttpStatus.OK)
  @RateLimit(20)
  async confirm(@Actor() actor: ActorContext, @Param('id') id: string, @Req() req: Request) {
    await this.svc.suggestions(actor); // admin check before the step-up
    assertFresh(this.method(req), { action: 'sso.configure' });
    return { success: true, data: await this.svc.confirmSuggestion(actor, id) };
  }

  @Post('link-suggestions/:id/dismiss')
  @HttpCode(HttpStatus.OK)
  async dismiss(@Actor() actor: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.svc.dismissSuggestion(actor, id) };
  }

  @Get('enforcement')
  async enforcement(@Actor() actor: ActorContext) {
    return { success: true, data: await this.svc.enforcement(actor) };
  }

  /** `scope` is `staff` or a business id. Moving to required confirms first; lowering never asks. */
  @Put('enforcement/:scope')
  async setMode(@Actor() actor: ActorContext, @Param('scope') scope: string, @Body() body: { mode?: unknown }, @Req() req: Request) {
    const plan = await this.svc.setMode(actor, scope, body?.mode);
    if (plan.tightens) assertFresh(this.method(req), { action: 'sso.enforce' });
    return { success: true, data: await this.svc.applyMode(actor, scope, plan) };
  }

  @Put('break-glass/:userId')
  async breakGlass(@Actor() actor: ActorContext, @Param('userId') userId: string, @Body() body: { breakGlass?: unknown }, @Req() req: Request) {
    const plan = await this.svc.planBreakGlass(actor, userId, body?.breakGlass);
    assertFresh(this.method(req), { action: 'breakglass.manage' });
    return { success: true, data: await this.svc.applyBreakGlass(actor, userId, plan) };
  }
}
