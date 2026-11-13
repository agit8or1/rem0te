import { Body, Controller, Get, HttpCode, HttpStatus, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CapabilitiesGuard } from '../common/guards/capabilities.guard';
import { PlatformAdminGuard } from '../common/guards/platform-admin.guard';
import { RequireCapability } from '../common/decorators/require-capability.decorator';
import { Actor } from '../common/decorators/actor.decorator';
import { RateLimit } from '../common/throttling';
import type { ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';
import { StepUpService } from '../auth/step-up.service';
import { AgentAutoMigrationService } from './agent-auto-migration.service';

const ID = /^[a-z0-9]{20,40}$/;

/**
 * Devices → Full agent (0.37): the whole move to the signed agent on one
 * page, read live. computers:view; the counts are only of computers this
 * person can see (acl.endpointVisibilityWhere), the rest is platform facts.
 */
@Controller('agent-signing')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class AgentSigningController {
  constructor(private readonly svc: AgentAutoMigrationService) {}

  @Get('overview')
  @RequireCapability(CAP.COMPUTERS_VIEW)
  async overview(@Actor() actor: ActorContext, @Query('businessId') businessId?: string) {
    return { success: true, data: await this.svc.overview(actor, businessId && ID.test(businessId) ? businessId : null) };
  }
}

/**
 * The automatic migration's settings, resume and restart (0.37). Platform-wide,
 * so Platform Admin only — the guard before anything is read, and the service
 * checks again. Turning it on, shortening the soak, resuming and restarting
 * need fresh authentication; turning it off does not. All audited. There is
 * no route that migrates a computer: that stays Upgrade to full agent,
 * POST /endpoints/:id/agent/migrate, under the person's own access.
 */
@Controller('admin/agent-auto-migration')
@UseGuards(PlatformAdminGuard)
export class AgentAutoMigrationController {
  constructor(private readonly svc: AgentAutoMigrationService, private readonly stepUp: StepUpService) {}

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

  @Post('resume')
  @RateLimit(10)
  @HttpCode(HttpStatus.OK)
  async resume(@Actor() actor: ActorContext, @Req() req: Request) {
    return { success: true, data: await this.svc.resume(actor, this.freshMethod(req)) };
  }

  @Post('restart')
  @RateLimit(10)
  @HttpCode(HttpStatus.OK)
  async restart(@Actor() actor: ActorContext, @Req() req: Request) {
    return { success: true, data: await this.svc.restart(actor, this.freshMethod(req)) };
  }
}
