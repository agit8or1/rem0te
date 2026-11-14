import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CapabilitiesGuard } from '../common/guards/capabilities.guard';
import { RequireCapability } from '../common/decorators/require-capability.decorator';
import { Actor } from '../common/decorators/actor.decorator';
import { RateLimit } from '../common/throttling';
import type { ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';
import { StepUpService } from '../auth/step-up.service';
import { DeviceControlService } from './device-control.service';

/**
 * Service control and End process (0.45). Every route needs computers:view;
 * a request is then decided per computer by AccessPolicyService.evaluateAction
 * (high risk: actions:request, or a technician preset allowing higher-risk
 * fixes), as the software routes are. There is no approve or sign route, and
 * no route that changes anything about a service but its state or startup
 * type.
 */
@Controller()
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class DeviceControlController {
  constructor(private readonly svc: DeviceControlService, private readonly stepUp: StepUpService) {}

  /** Direct mode (0.40) needs a fresh sign-in; ActionsService.createPlan checks it. */
  private fresh(req: Request): string | null {
    const u = req.user as { sub?: string; iat?: number } | undefined;
    return u?.sub ? this.stepUp.read(req, u.sub, u.iat)?.method ?? null : null;
  }

  @Get('endpoints/:id/device-control')
  @RequireCapability(CAP.COMPUTERS_VIEW)
  async overview(@Actor() actor: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.svc.overview(actor, id) };
  }

  /** windows.service.control@1: start, stop, restart, or the startup type — of a service in the latest service list. */
  @Post('endpoints/:id/services/control')
  @HttpCode(HttpStatus.CREATED)
  @RequireCapability(CAP.COMPUTERS_VIEW)
  @RateLimit(10)
  async controlService(@Actor() actor: ActorContext, @Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    return { success: true, data: await this.svc.controlService(actor, id, body, this.fresh(req)) };
  }

  /** windows.process.stop@1: end a process in the latest process list (its id, name and start time). */
  @Post('endpoints/:id/processes/stop')
  @HttpCode(HttpStatus.CREATED)
  @RequireCapability(CAP.COMPUTERS_VIEW)
  @RateLimit(10)
  async stopProcess(@Actor() actor: ActorContext, @Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    return { success: true, data: await this.svc.stopProcess(actor, id, body, this.fresh(req)) };
  }
}
