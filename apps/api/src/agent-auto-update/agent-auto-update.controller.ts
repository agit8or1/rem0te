import { Body, Controller, Get, Put, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { PlatformAdminGuard } from '../common/guards/platform-admin.guard';
import { Actor } from '../common/decorators/actor.decorator';
import { RateLimit } from '../common/throttling';
import type { ActorContext } from '../rbac/access-control.service';
import { StepUpService } from '../auth/step-up.service';
import { AgentAutoUpdateService } from './agent-auto-update.service';

/**
 * Settings → Client updates → Keep agents up to date automatically (0.36).
 * Platform-wide, so Platform Admin only — the guard before anything is read,
 * and the service checks again. A change needs fresh authentication and is
 * audited (AGENT_AUTO_UPDATE_SETTINGS_CHANGED, before and after). A
 * business, site or device group opts out through its client-update policy
 * (PUT /client-updates/policy, agentMode), under that route's rules.
 * There is no route that makes a computer update now: that is Update agent,
 * POST /endpoints/:id/agent/update, under the person's own access.
 */
@Controller('admin/agent-auto-update')
@UseGuards(PlatformAdminGuard)
export class AgentAutoUpdateController {
  constructor(private readonly svc: AgentAutoUpdateService, private readonly stepUp: StepUpService) {}

  private freshMethod(req: Request): string | null {
    const u = req.user as { sub?: string; iat?: number } | undefined;
    return u?.sub ? this.stepUp.read(req, u.sub, u.iat)?.method ?? null : null;
  }

  @Get()
  async get(@Actor() actor: ActorContext) {
    return { success: true, data: await this.svc.getSettings(actor) };
  }

  @Put()
  @RateLimit(20)
  async put(@Actor() actor: ActorContext, @Body() body: unknown, @Req() req: Request) {
    return { success: true, data: await this.svc.putSettings(actor, body, this.freshMethod(req)) };
  }
}
