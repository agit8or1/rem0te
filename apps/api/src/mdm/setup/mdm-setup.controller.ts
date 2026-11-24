import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Post, Put, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { PlatformAdminGuard } from '../../common/guards/platform-admin.guard';
import { Actor } from '../../common/decorators/actor.decorator';
import { RateLimit } from '../../common/throttling';
import type { ActorContext } from '../../rbac/access-control.service';
import { StepUpService } from '../../auth/step-up.service';
import { assertFresh } from '../../security-controls/review';
import { MdmSetupService } from './mdm-setup.service';

/**
 * Settings → Mobile devices (0.83 Beacon, docs/own-mdm.md M1, §92): the own
 * MDM's setup wizard. Platform Admin only (the class guard, before anything
 * is read). Every write but a delete asks for fresh authentication naming
 * mdm.setup (§62; default off, like the others), before the service is
 * called. Deleting a credential never asks, and is audited. Nothing here
 * calls Apple or Google.
 */
@Controller('mdm/setup')
@UseGuards(PlatformAdminGuard)
export class MdmSetupController {
  constructor(private readonly svc: MdmSetupService, private readonly stepUp: StepUpService) {}

  private fresh(req: Request, message: string) {
    const u = req.user as { sub?: string; iat?: number } | undefined;
    assertFresh(u?.sub ? this.stepUp.read(req, u.sub, u.iat)?.method ?? null : null, { action: 'mdm.setup', message });
  }

  @Get()
  async view() { return { success: true, data: await this.svc.view() }; }

  /** The push CSR (public). Never the key. */
  @Get('apple/push-csr')
  async csr() { return { success: true, data: await this.svc.pushCsr() }; }

  @Put('checklist')
  @RateLimit(30)
  async checklist(@Actor() a: ActorContext, @Body() body: unknown, @Req() req: Request) {
    this.fresh(req, 'Confirm it is you to change the mobile-device setup.');
    return { success: true, data: await this.svc.setChecklist(a, body) };
  }

  @Put('apple/signing-route')
  @RateLimit(30)
  async route(@Actor() a: ActorContext, @Body() body: unknown, @Req() req: Request) {
    this.fresh(req, 'Confirm it is you to change how the push request is signed.');
    return { success: true, data: await this.svc.setSigningRoute(a, body) };
  }

  @Post('apple/push-key')
  @RateLimit(10)
  @HttpCode(HttpStatus.OK)
  async pushKey(@Actor() a: ActorContext, @Body() body: unknown, @Req() req: Request) {
    this.fresh(req, 'Confirm it is you to generate the Apple push key.');
    return { success: true, data: await this.svc.generatePushKey(a, body) };
  }

  @Delete('apple/push-key')
  @HttpCode(HttpStatus.OK)
  async deletePushKey(@Actor() a: ActorContext) { return { success: true, data: await this.svc.deletePushKey(a) }; }

  @Put('apple/vendor')
  @RateLimit(10)
  async vendor(@Actor() a: ActorContext, @Body() body: unknown, @Req() req: Request) {
    this.fresh(req, 'Confirm it is you to upload the MDM vendor certificate.');
    return { success: true, data: await this.svc.setVendor(a, body) };
  }

  @Delete('apple/vendor')
  @HttpCode(HttpStatus.OK)
  async deleteVendor(@Actor() a: ActorContext) { return { success: true, data: await this.svc.deleteVendor(a) }; }

  @Post('apple/push-request')
  @RateLimit(10)
  @HttpCode(HttpStatus.OK)
  async pushRequest(@Actor() a: ActorContext, @Req() req: Request) {
    this.fresh(req, 'Confirm it is you to sign the push certificate request.');
    return { success: true, data: await this.svc.signPushRequest(a) };
  }

  @Put('apple/push-certificate')
  @RateLimit(10)
  async pushCert(@Actor() a: ActorContext, @Body() body: unknown, @Req() req: Request) {
    this.fresh(req, 'Confirm it is you to install the Apple push certificate.');
    return { success: true, data: await this.svc.installPushCert(a, body, false) };
  }

  /** A certificate with a different topic: its own action, naming the topic it replaces. */
  @Post('apple/push-certificate/replace')
  @RateLimit(5)
  @HttpCode(HttpStatus.OK)
  async replacePushCert(@Actor() a: ActorContext, @Body() body: unknown, @Req() req: Request) {
    this.fresh(req, 'Confirm it is you to replace the push certificate with a new topic.');
    return { success: true, data: await this.svc.installPushCert(a, body, true) };
  }

  @Delete('apple/push-certificate')
  @HttpCode(HttpStatus.OK)
  async deletePushCert(@Actor() a: ActorContext) { return { success: true, data: await this.svc.deletePushCert(a) }; }

  /** 0.84 (step 6): the device CA's public root and intermediates. Never its key. */
  @Put('apple/device-ca')
  @RateLimit(10)
  async deviceCa(@Actor() a: ActorContext, @Body() body: unknown, @Req() req: Request) {
    this.fresh(req, 'Confirm it is you to change the device CA that enrolled devices are checked against.');
    return { success: true, data: await this.svc.setDeviceCa(a, body) };
  }

  @Delete('apple/device-ca')
  @HttpCode(HttpStatus.OK)
  async deleteDeviceCa(@Actor() a: ActorContext) { return { success: true, data: await this.svc.deleteDeviceCa(a) }; }

  /** 0.84 (step 6): the enrollment profile's signing certificate and key (sealed). */
  @Put('apple/profile-signer')
  @RateLimit(10)
  async profileSigner(@Actor() a: ActorContext, @Body() body: unknown, @Req() req: Request) {
    this.fresh(req, 'Confirm it is you to upload the enrollment profile signing certificate.');
    return { success: true, data: await this.svc.setProfileSigner(a, body) };
  }

  @Delete('apple/profile-signer')
  @HttpCode(HttpStatus.OK)
  async deleteProfileSigner(@Actor() a: ActorContext) { return { success: true, data: await this.svc.deleteProfileSigner(a) }; }

  @Put('android/service-account')
  @RateLimit(10)
  async androidKey(@Actor() a: ActorContext, @Body() body: unknown, @Req() req: Request) {
    this.fresh(req, 'Confirm it is you to upload the Google service-account key.');
    return { success: true, data: await this.svc.setAndroidKey(a, body) };
  }

  @Delete('android/service-account')
  @HttpCode(HttpStatus.OK)
  async deleteAndroidKey(@Actor() a: ActorContext) { return { success: true, data: await this.svc.deleteAndroidKey(a) }; }
}
