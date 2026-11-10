import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Actor } from '../common/decorators/actor.decorator';
import type { ActorContext } from '../rbac/access-control.service';
import { StepUpService } from '../auth/step-up.service';
import { assertFresh } from '../security-controls/review';
import { ContainmentService } from './containment.service';

/**
 * Containment (v0.28). Setting a pause needs no fresh authentication —
 * stopping must be quick. Lifting one does. There is no route that lifts the
 * approval signer's copy or an agent-side signed pause: those belong to
 * their own operators.
 */
@Controller('containment')
@UseGuards(JwtAuthGuard)
export class ContainmentController {
  constructor(private readonly svc: ContainmentService, private readonly stepUp: StepUpService) {}

  @Get()
  async state(@Actor() actor: ActorContext) { return { success: true, data: await this.svc.state(actor) }; }

  @Get('banner')
  async banner(@Actor() actor: ActorContext) { return { success: true, data: await this.svc.banner(actor) }; }

  @Post('pauses')
  async set(@Actor() actor: ActorContext, @Body() body: unknown) { return { success: true, data: await this.svc.set(actor, body) }; }

  @Post('pauses/:id/clear')
  @HttpCode(HttpStatus.OK)
  async clear(@Actor() actor: ActorContext, @Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    const u = req.user as { sub?: string; iat?: number } | undefined;
    assertFresh(u?.sub ? this.stepUp.read(req, u.sub, u.iat)?.method ?? null : null);
    return { success: true, data: await this.svc.clear(actor, id, body) };
  }
}
