import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
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
import { assertFresh } from '../security-controls/review';
import { WarrantyService } from './warranty.service';

/**
 * Settings → Warranty (0.56). Platform Admin only (the class guard, before
 * anything is read). Saving needs fresh authentication unless a Platform
 * Admin turned its catalog key (warranty.settings) off: it holds a vendor
 * credential and decides that serial numbers are sent to that vendor.
 */
@Controller('warranty/settings')
@UseGuards(PlatformAdminGuard)
export class WarrantySettingsController {
  constructor(private readonly warranty: WarrantyService, private readonly stepUp: StepUpService) {}

  @Get()
  async get() { return { success: true, data: await this.warranty.settings() }; }

  @Put(':vendor')
  @RateLimit(20)
  async put(@Actor() a: ActorContext, @Param('vendor') vendor: string, @Body() body: unknown, @Req() req: Request) {
    const u = req.user as { sub?: string; iat?: number } | undefined;
    assertFresh(u?.sub ? this.stepUp.read(req, u.sub, u.iat)?.method ?? null : null, { action: 'warranty.settings', message: 'Confirm it is you to change a warranty lookup or its credential.' });
    return { success: true, data: await this.warranty.putVendor(a, vendor, body) };
  }
}

/** A computer's warranty and hardware support links (0.56). */
@Controller('endpoints/:id/warranty')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class WarrantyController {
  constructor(private readonly warranty: WarrantyService) {}

  @Get()
  @RequireCapability(CAP.COMPUTERS_VIEW)
  async get(@Actor() a: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.warranty.get(a, id) };
  }

  /** Set or clear the dates by hand. computers:edit on this computer; audited with before and after. */
  @Put()
  @RequireCapability(CAP.COMPUTERS_EDIT)
  @RateLimit(30)
  async put(@Actor() a: ActorContext, @Param('id') id: string, @Body() body: unknown) {
    return { success: true, data: await this.warranty.setManual(a, id, body) };
  }

  /** Ask the vendor now (only for a vendor a Platform Admin switched on). */
  @Post('lookup')
  @HttpCode(HttpStatus.OK)
  @RequireCapability(CAP.COMPUTERS_EDIT)
  @RateLimit(10)
  async lookup(@Actor() a: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.warranty.checkNow(a, id) };
  }
}
