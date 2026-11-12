import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { Actor } from '../common/decorators/actor.decorator';
import { Public } from '../common/decorators/public.decorator';
import { PlatformAdminGuard } from '../common/guards/platform-admin.guard';
import { RateLimit } from '../common/throttling';
import type { ActorContext } from '../rbac/access-control.service';
import { StepUpService } from '../auth/step-up.service';
import { assertFresh } from '../security-controls/review';
import { EmailService } from './email.service';

function fresh(stepUp: StepUpService, req: Request) {
  const u = req.user as { sub?: string; iat?: number } | undefined;
  assertFresh(u?.sub ? stepUp.read(req, u.sub, u.iat)?.method ?? null : null);
}

/**
 * Settings → Email (0.34): the SMTP relay. Platform Admin only (the guard,
 * before anything is read). Saving needs fresh authentication — it decides
 * where every alert email and report goes through, and holds a password.
 */
@Controller('email/settings')
@UseGuards(PlatformAdminGuard)
export class SmtpSettingsController {
  constructor(private readonly email: EmailService, private readonly stepUp: StepUpService) {}

  @Get()
  async get() { return { success: true, data: await this.email.getSettings() }; }

  @Put()
  @RateLimit(20)
  async put(@Actor() a: ActorContext, @Body() body: unknown, @Req() req: Request) {
    fresh(this.stepUp, req);
    return { success: true, data: await this.email.putSettings(a, body) };
  }

  /** To your own account address, or a confirmed global recipient — never a typed one. */
  @Post('test')
  @HttpCode(HttpStatus.OK)
  @RateLimit(10)
  async test(@Actor() a: ActorContext, @Body() body: unknown) { return { success: true, data: await this.email.sendTest(a, body) }; }
}

/**
 * Confirmed email recipients (0.34), per business or global. Managed by
 * whoever decides who is notified (a Business Owner of the business, or the
 * MSP — checked in the service); every change needs fresh authentication.
 */
@Controller('email')
export class EmailRecipientsController {
  constructor(private readonly email: EmailService, private readonly stepUp: StepUpService) {}

  /** Whether outbound email is on. Says nothing about the relay. */
  @Get('status')
  async status() { return { success: true, data: await this.email.status() }; }

  @Get('recipients')
  async list(@Actor() a: ActorContext, @Query() q: Record<string, unknown>) {
    const scope = q.scope === 'global' ? 'global' : 'business';
    return { success: true, data: await this.email.listRecipients(a, scope, typeof q.businessId === 'string' && q.businessId ? q.businessId : null) };
  }

  @Post('recipients')
  @RateLimit(10)
  async add(@Actor() a: ActorContext, @Body() body: unknown, @Req() req: Request) {
    fresh(this.stepUp, req);
    return { success: true, data: await this.email.addRecipient(a, body) };
  }

  @Post('recipients/:id/resend')
  @HttpCode(HttpStatus.OK)
  @RateLimit(10)
  async resend(@Actor() a: ActorContext, @Param('id') id: string, @Req() req: Request) {
    fresh(this.stepUp, req);
    return { success: true, data: await this.email.resendVerification(a, id) };
  }

  @Delete('recipients/:id')
  async remove(@Actor() a: ActorContext, @Param('id') id: string, @Req() req: Request) {
    fresh(this.stepUp, req);
    return { success: true, data: await this.email.removeRecipient(a, id) };
  }

  /** The confirmation link's page posts here. No session: the single-use token is the proof. */
  @Post('verify')
  @Public()
  @HttpCode(HttpStatus.OK)
  @RateLimit(10)
  async verify(@Body() body: unknown) { return { success: true, data: await this.email.verify(body) }; }
}
