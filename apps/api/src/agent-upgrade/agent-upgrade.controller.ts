import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CapabilitiesGuard } from '../common/guards/capabilities.guard';
import { RequireCapability } from '../common/decorators/require-capability.decorator';
import { Actor } from '../common/decorators/actor.decorator';
import { RateLimit } from '../common/throttling';
import type { ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';
import { StepUpService } from '../auth/step-up.service';
import { AgentUpgradeService } from './agent-upgrade.service';

/**
 * The Agent card (0.34): read it, update the agent the computer runs, and
 * move a standard Windows agent onto the signed agent. Same capability as
 * the existing reinstall (computers:edit) for every write; the migration also
 * needs a fresh sign-in and a reason (see update-trust/agent-migration.ts).
 */
@Controller('endpoints')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class AgentUpgradeController {
  constructor(private readonly svc: AgentUpgradeService, private readonly stepUp: StepUpService) {}

  private freshMethod(req: Request): string | null {
    const u = req.user as { sub?: string; iat?: number } | undefined;
    return u?.sub ? this.stepUp.read(req, u.sub, u.iat)?.method ?? null : null;
  }

  @Get(':id/agent')
  @RequireCapability(CAP.COMPUTERS_VIEW)
  async card(@Actor() actor: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.svc.card(actor, id) };
  }

  @Post(':id/agent/update')
  @RequireCapability(CAP.COMPUTERS_EDIT)
  @RateLimit(10)
  @HttpCode(HttpStatus.OK)
  async update(@Actor() actor: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.svc.updateAgent(actor, id) };
  }

  @Post(':id/agent/migrate')
  @RequireCapability(CAP.COMPUTERS_EDIT)
  @RateLimit(10)
  @HttpCode(HttpStatus.OK)
  async migrate(@Actor() actor: ActorContext, @Param('id') id: string, @Body() body: { reason?: unknown } | undefined, @Req() req: Request) {
    return { success: true, data: await this.svc.migrate(actor, id, body?.reason, this.freshMethod(req)) };
  }

  @Post(':id/agent/migrate/cancel')
  @RequireCapability(CAP.COMPUTERS_EDIT)
  @RateLimit(10)
  @HttpCode(HttpStatus.OK)
  async cancel(@Actor() actor: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.svc.cancelMigration(actor, id) };
  }
}

/** Migration status: the fleet view of per-computer moves to the signed agent, scoped like the device list. */
@Controller('agent-migrations')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class AgentMigrationsController {
  constructor(private readonly svc: AgentUpgradeService) {}

  @Get()
  @RequireCapability(CAP.COMPUTERS_VIEW)
  async list(@Actor() actor: ActorContext, @Query('state') state?: string, @Query('businessId') businessId?: string) {
    return { success: true, data: await this.svc.migrations(actor, { state, businessId }) };
  }
}
