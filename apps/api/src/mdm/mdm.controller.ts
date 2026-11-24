import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { StepUpService } from '../auth/step-up.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CapabilitiesGuard } from '../common/guards/capabilities.guard';
import { RequireCapability } from '../common/decorators/require-capability.decorator';
import { Actor } from '../common/decorators/actor.decorator';
import { RateLimit } from '../common/throttling';
import type { ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';
import { MdmActionService } from './mdm-action.service';
import { MdmService } from './mdm.service';

/**
 * Mobile devices (0.80 Tablet). Four GETs, each needing `mobile:view`; the
 * service then pins the caller to their own business (§90).
 *
 * 0.86 Lighthouse (§95): one POST, sending a lost-device command (lock,
 * start or stop lost mode) to one device. It needs `mobile:act` here, and
 * the service checks mobile:view and mobile:act in scope again, the fresh
 * confirmation (mdm.act), the device's refusals and the `actions` pause
 * before anything is sent. No erase, wipe or retire route exists (M5).
 */
@Controller('mobile-devices')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class MdmController {
  constructor(private readonly mdm: MdmService, private readonly actions: MdmActionService, private readonly stepUp: StepUpService) {}

  /** Whether a provider is connected for this scope ("requires setup" until one is), and what one needs. */
  @Get('setup')
  @RequireCapability(CAP.MOBILE_VIEW)
  async setup(@Actor() a: ActorContext, @Query() q: Record<string, unknown>) {
    return { success: true, data: await this.mdm.setup(a, q) };
  }

  @Get()
  @RequireCapability(CAP.MOBILE_VIEW)
  async list(@Actor() a: ActorContext, @Query() q: Record<string, unknown>) {
    return { success: true, data: await this.mdm.list(a, q) };
  }

  @Get(':id')
  @RequireCapability(CAP.MOBILE_VIEW)
  async get(@Actor() a: ActorContext, @Param('id') id: string, @Query() q: Record<string, unknown>) {
    return { success: true, data: await this.mdm.get(a, id, q) };
  }

  /** Command history: provider acceptance and device completion as separate facts. */
  @Get(':id/commands')
  @RequireCapability(CAP.MOBILE_VIEW)
  async commands(@Actor() a: ActorContext, @Param('id') id: string, @Query() q: Record<string, unknown>) {
    return { success: true, data: await this.mdm.commands(a, id, q) };
  }

  /** Send one lost-device command (0.86): `{ kind, message?, phoneNumber? }`. */
  @Post(':id/commands')
  @RequireCapability(CAP.MOBILE_ACT)
  @RateLimit(10)
  @HttpCode(200)
  async send(@Actor() a: ActorContext, @Param('id') id: string, @Body() body: unknown, @Query() q: Record<string, unknown>, @Req() req: Request) {
    const u = req.user as { sub?: string; iat?: number } | undefined;
    const fresh = u?.sub ? this.stepUp.read(req, u.sub, u.iat)?.method ?? null : null;
    return { success: true, data: await this.actions.send(a, id, body, q, fresh) };
  }
}
