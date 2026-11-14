import { Body, Controller, Get, Put, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { StepUpService } from '../auth/step-up.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Actor } from '../common/decorators/actor.decorator';
import { RateLimit } from '../common/throttling';
import type { ActorContext } from '../rbac/access-control.service';
import { RoutineConfirmService } from './routine-confirm';

/** 0.46.1 / 0.47: Settings → General → Confirm before everyday changes (routine-confirm.ts). */
@Controller('security/routine-confirm')
@UseGuards(JwtAuthGuard)
export class RoutineConfirmController {
  constructor(private readonly svc: RoutineConfirmService, private readonly stepUp: StepUpService) {}

  @Get()
  async get(@Actor() actor: ActorContext) {
    return { success: true, data: this.svc.view(await this.svc.load(), actor) };
  }

  @Put()
  @RateLimit(20)
  async put(@Actor() actor: ActorContext, @Body() body: { value?: unknown }, @Req() req: Request) {
    const u = req.user as { sub?: string; iat?: number } | undefined;
    const fresh = u?.sub ? this.stepUp.read(req, u.sub, u.iat)?.method ?? null : null;
    return { success: true, data: await this.svc.set(actor, body?.value, fresh) };
  }
}

