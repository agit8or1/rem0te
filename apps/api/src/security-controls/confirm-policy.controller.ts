import { Body, Controller, Get, Put, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { StepUpService } from '../auth/step-up.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Actor } from '../common/decorators/actor.decorator';
import { RateLimit } from '../common/throttling';
import type { ActorContext } from '../rbac/access-control.service';
import { ConfirmPolicyService } from './confirm-policy.service';

/**
 * 0.49: Settings → Confirm it is you (confirm-policy.service.ts). Replaces
 * 0.47's everyday-changes route, which is gone.
 */
@Controller('security/confirm-policy')
@UseGuards(JwtAuthGuard)
export class ConfirmPolicyController {
  constructor(private readonly svc: ConfirmPolicyService, private readonly stepUp: StepUpService) {}

  @Get()
  async get(@Actor() actor: ActorContext) {
    return { success: true, data: this.svc.view(await this.svc.load(), actor) };
  }

  @Put()
  @RateLimit(20)
  async put(@Actor() actor: ActorContext, @Body() body: unknown, @Req() req: Request) {
    const u = req.user as { sub?: string; iat?: number } | undefined;
    const fresh = u?.sub ? this.stepUp.read(req, u.sub, u.iat)?.method ?? null : null;
    return { success: true, data: await this.svc.set(actor, body, fresh) };
  }
}
