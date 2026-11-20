import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Res, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CapabilitiesGuard } from '../common/guards/capabilities.guard';
import { RequireCapability } from '../common/decorators/require-capability.decorator';
import { Actor } from '../common/decorators/actor.decorator';
import { RateLimit } from '../common/throttling';
import type { ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';
import { RustdeskService } from '../common/rustdesk.service';
import { PublicUrlService } from '../platform/public-url.service';
import { MsaSessionService } from './msa-sessions.service';

/**
 * Managed Secure Access sessions (0.73, build step 5), console side. Behind
 * MSA_GRANTS (MsaGrantsGate runs before anything else). View computers to
 * reach any route; the service decides the rest:
 *
 *   - Connect is the ordinary launch decision (authorizeConnect, managed),
 *     counted against the fleet limits, and needs no fresh confirmation of
 *     its own: the one-time password it leads to is not the computer's
 *     permanent password, works for one session the agent enforces, and is
 *     changed by the agent when the session ends;
 *   - the Connect script hands that password over once, to the grant's own
 *     technician;
 *   - revoking never asks: it only reduces.
 */
@Controller('msa/sessions')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class MsaSessionsController {
  constructor(private readonly sessions: MsaSessionService, private readonly rustdesk: RustdeskService, private readonly urls: PublicUrlService) {}

  /** Connect to a verified managed computer through a session grant. */
  @Post('connect/:endpointId')
  @RequireCapability(CAP.COMPUTERS_VIEW)
  @RateLimit(30)
  @HttpCode(HttpStatus.OK)
  async connect(@Actor() a: ActorContext, @Param('endpointId') endpointId: string, @Body() body: { mode?: unknown } | undefined) {
    return { success: true, data: await this.sessions.connect(a, endpointId, body?.mode) };
  }

  /** One session's progress and timeline. */
  @Get('grants/:grantId')
  @RequireCapability(CAP.COMPUTERS_VIEW)
  @RateLimit(240)
  async grant(@Actor() a: ActorContext, @Param('grantId') grantId: string) {
    return { success: true, data: await this.sessions.grant(a, grantId) };
  }

  /** The Connect script, carrying the session's one-time password. Once, to the grant's technician. */
  @Get('grants/:grantId/connect.cmd')
  @RequireCapability(CAP.COMPUTERS_VIEW)
  @RateLimit(30)
  async connectScript(@Actor() a: ActorContext, @Param('grantId') grantId: string, @Res() res: Response) {
    const config = await this.rustdesk.serverConfig();
    if (!config) throw new ServiceUnavailableException('No RustDesk relay host is configured. A Platform Admin must set it under Settings.');
    const info = await this.sessions.connectScript(a, grantId);
    const name = String(info.endpointName);
    const script = this.rustdesk.buildConnectCmd({
      config,
      peerId: info.rustdeskId,
      password: info.password,
      // eslint-disable-next-line no-control-regex -- control chars are exactly what this strips
      endpointName: name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').slice(0, 60),
      clientDownloadUrl: `${this.urls.apiConfigured() ?? ''}/api/v1/public/quick-connect/download/windows`,
      clientVersion: await this.rustdesk.pinnedOrLatestVersion(),
      telemetry: null,
    });
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="Connect to ${name.replace(/[^A-Za-z0-9._ -]/g, '')}.cmd"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(script);
  }

  /** A computer's managed sessions. */
  @Get('endpoint/:endpointId')
  @RequireCapability(CAP.COMPUTERS_VIEW)
  async forEndpoint(@Actor() a: ActorContext, @Param('endpointId') endpointId: string) {
    return { success: true, data: await this.sessions.forEndpoint(a, endpointId) };
  }

  /** Live managed sessions on every computer this person can see. */
  @Get('active')
  @RequireCapability(CAP.COMPUTERS_VIEW)
  async active(@Actor() a: ActorContext, @Query('businessId') businessId?: string) {
    return { success: true, data: await this.sessions.active(a, businessId ?? null) };
  }

  /** Disconnect one session. */
  @Post('grants/:grantId/revoke')
  @RequireCapability(CAP.COMPUTERS_VIEW)
  @RateLimit(60)
  @HttpCode(HttpStatus.OK)
  async revokeOne(@Actor() a: ActorContext, @Param('grantId') grantId: string) {
    return { success: true, data: await this.sessions.revokeOne(a, grantId) };
  }

  /** Disconnect by scope: sessions, a computer, a technician, a business. */
  @Post('revoke')
  @RequireCapability(CAP.COMPUTERS_VIEW)
  @RateLimit(20)
  @HttpCode(HttpStatus.OK)
  async revoke(@Actor() a: ActorContext, @Body() body: unknown) {
    return { success: true, data: await this.sessions.revokeScope(a, body) };
  }
}
