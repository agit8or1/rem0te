import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { StepUpService } from '../../auth/step-up.service';
import { Actor } from '../../common/decorators/actor.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { PlatformAdminGuard } from '../../common/guards/platform-admin.guard';
import { RateLimit } from '../../common/throttling';
import type { ActorContext } from '../../rbac/access-control.service';
import { assertFresh } from '../../security-controls/review';
import { AppleEnrollmentService } from './apple-enrollment.service';
import { AppleMdmService, type DeviceAnswer } from './apple-mdm.service';
import type { AppleRawRequest } from './apple-raw-body.middleware';
import { PROFILE_CONTENT_TYPE } from './profile';

function send(res: Response, a: DeviceAnswer) {
  res.setHeader('Cache-Control', 'no-store');
  if (!a.body) { res.status(a.status).end(); return; }
  res.status(a.status).setHeader('Content-Type', 'application/xml; charset=UTF-8');
  res.end(a.body);
}

/**
 * The device side of Rem0te's own Apple MDM server (0.84 Harbor, §93).
 * Public: a device has no session. What authenticates it is the message's
 * Mdm-Signature, checked by AppleMdmService against the device CA before
 * the body is parsed; every refusal is a status with no body. The raw bytes
 * come from AppleRawBodyMiddleware (MdmModule.configure), bounded.
 *
 *   PUT /mdm/apple/checkin?enroll=<link>   Authenticate, TokenUpdate, CheckOut
 *   PUT /mdm/apple/server                  results, and the next command
 *   GET /mdm/apple/enroll/<token>          the one-time signed profile
 */
@Controller('mdm/apple')
export class AppleDeviceController {
  constructor(private readonly mdm: AppleMdmService, private readonly enrollment: AppleEnrollmentService) {}

  @Public()
  @Put('checkin')
  @RateLimit(120)
  async checkin(@Req() req: AppleRawRequest, @Res() res: Response, @Query('enroll') enroll: unknown) {
    send(res, await this.mdm.checkin(req.appleRaw, req.headers['mdm-signature'], enroll, req.ip));
  }

  @Public()
  @Put('server')
  @RateLimit(300)
  async server(@Req() req: AppleRawRequest, @Res() res: Response) {
    send(res, await this.mdm.server(req.appleRaw, req.headers['mdm-signature']));
  }

  /** Any link that cannot be claimed (unknown, used, expired, revoked) is the same 404. */
  @Public()
  @Get('enroll/:token')
  @RateLimit(10)
  async enroll(@Param('token') token: string, @Req() req: Request, @Res() res: Response) {
    const p = await this.enrollment.claim(token, req.ip);
    res.setHeader('Cache-Control', 'no-store');
    if (!p) { res.status(404).end(); return; }
    res.status(200).setHeader('Content-Type', PROFILE_CONTENT_TYPE);
    res.setHeader('Content-Disposition', `attachment; filename="${p.filename}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(p.body);
  }
}

/**
 * Enrollment links and the enrolled-device list (Settings → Mobile devices,
 * step 6). Platform Admin only (the class guard). Creating a link asks for
 * fresh authentication naming `mdm.enroll` (§62, default off); revoking
 * never asks.
 */
@Controller('mdm/apple')
@UseGuards(PlatformAdminGuard)
export class AppleAdminController {
  constructor(private readonly mdm: AppleMdmService, private readonly enrollment: AppleEnrollmentService, private readonly stepUp: StepUpService) {}

  @Get('links')
  async links(@Query('businessId') businessId?: string) { return { success: true, data: await this.enrollment.list({ businessId: typeof businessId === 'string' ? businessId : undefined }) }; }

  @Post('links')
  @RateLimit(20)
  @HttpCode(HttpStatus.OK)
  async create(@Actor() a: ActorContext, @Body() body: unknown, @Req() req: Request) {
    const u = req.user as { sub?: string; iat?: number } | undefined;
    assertFresh(u?.sub ? this.stepUp.read(req, u.sub, u.iat)?.method ?? null : null, { action: 'mdm.enroll', message: 'Confirm it is you to create an Apple enrollment link.' });
    return { success: true, data: await this.enrollment.create(a, body) };
  }

  @Delete('links/:id')
  @HttpCode(HttpStatus.OK)
  async revoke(@Actor() a: ActorContext, @Param('id') id: string) { return { success: true, data: await this.enrollment.revoke(a, id) }; }

  @Get('devices')
  async devices(@Query('businessId') businessId?: string) { return { success: true, data: await this.mdm.adminList({ businessId: typeof businessId === 'string' ? businessId : undefined }) }; }
}
