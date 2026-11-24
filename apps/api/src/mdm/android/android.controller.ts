import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { StepUpService } from '../../auth/step-up.service';
import { Actor } from '../../common/decorators/actor.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { PlatformAdminGuard } from '../../common/guards/platform-admin.guard';
import { RateLimit } from '../../common/throttling';
import type { ActorContext } from '../../rbac/access-control.service';
import { assertFresh } from '../../security-controls/review';
import { AndroidEmmService } from './android-emm.service';

/**
 * Google's redirect at the end of an enterprise sign-up (0.85 Mooring, §94).
 * Public: the admin's session cookie is SameSite=Strict, so the browser does
 * not send it on a cross-site redirect from Google. What authenticates the
 * request is the one-time `state` (only its SHA-256 is stored), claimed by
 * one conditional update. The answer is always a 303 to the settings page.
 *
 *   GET /mdm/android/signup/callback?state=…&enterpriseToken=…
 */
@Controller('mdm/android/signup')
export class AndroidSignupCallbackController {
  constructor(private readonly svc: AndroidEmmService) {}

  @Public()
  @Get('callback')
  @RateLimit(10)
  async callback(@Query('state') state: unknown, @Query('enterpriseToken') token: unknown, @Req() req: Request, @Res() res: Response) {
    const to = await this.svc.callback(state, token, req.ip);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.redirect(303, to);
  }
}

/**
 * Settings → Mobile devices, Android steps 3, 5 and 6 (0.85 Mooring, §94).
 * Platform Admin only (the class guard). Every write asks for fresh
 * authentication: the connection test, a sign-up and the policy name
 * `mdm.setup`; an enrollment token names `mdm.enroll` (§62, both default off).
 */
@Controller('mdm/android')
@UseGuards(PlatformAdminGuard)
export class AndroidAdminController {
  constructor(private readonly svc: AndroidEmmService, private readonly stepUp: StepUpService) {}

  private method(req: Request) {
    const u = req.user as { sub?: string; iat?: number } | undefined;
    return u?.sub ? this.stepUp.read(req, u.sub, u.iat)?.method ?? null : null;
  }
  private freshSetup(req: Request, message: string) { assertFresh(this.method(req), { action: 'mdm.setup', message }); }
  private freshEnroll(req: Request, message: string) { assertFresh(this.method(req), { action: 'mdm.enroll', message }); }

  @Get()
  async view() { return { success: true, data: await this.svc.view() }; }

  @Post('test')
  @RateLimit(10)
  @HttpCode(HttpStatus.OK)
  async test(@Actor() a: ActorContext, @Req() req: Request) {
    this.freshSetup(req, 'Confirm it is you to test the connection to Google.');
    return { success: true, data: await this.svc.test(a) };
  }

  @Post('signup')
  @RateLimit(10)
  @HttpCode(HttpStatus.OK)
  async signup(@Actor() a: ActorContext, @Body() body: unknown, @Req() req: Request) {
    this.freshSetup(req, 'Confirm it is you to start an Android enterprise sign-up.');
    return { success: true, data: await this.svc.startSignup(a, body) };
  }

  @Post('enterprises/:businessId/policy')
  @RateLimit(10)
  @HttpCode(HttpStatus.OK)
  async policy(@Actor() a: ActorContext, @Param('businessId') businessId: string, @Req() req: Request) {
    this.freshSetup(req, 'Confirm it is you to apply the default Android policy.');
    return { success: true, data: await this.svc.applyPolicy(a, businessId) };
  }

  @Post('enrollment-tokens')
  @RateLimit(20)
  @HttpCode(HttpStatus.OK)
  async token(@Actor() a: ActorContext, @Body() body: unknown, @Req() req: Request) {
    this.freshEnroll(req, 'Confirm it is you to create an Android enrollment token.');
    return { success: true, data: await this.svc.createToken(a, body) };
  }
}
