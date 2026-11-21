import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CapabilitiesGuard } from '../common/guards/capabilities.guard';
import { PlatformAdminGuard } from '../common/guards/platform-admin.guard';
import { RequireCapability } from '../common/decorators/require-capability.decorator';
import { Actor } from '../common/decorators/actor.decorator';
import { Public } from '../common/decorators/public.decorator';
import { RateLimit } from '../common/throttling';
import type { ActorContext } from '../rbac/access-control.service';
import { CAP, PLATFORM_CAP } from '../rbac/capabilities';
import { StepUpService } from '../auth/step-up.service';
import { TerminalService } from './terminal.service';
import { RemoteAgentService } from './remote-agent.service';
import { RemoteOpsSettingsService } from './remote-ops-settings.service';

/**
 * The background terminal, console side (0.77 Conduit). Opening, reading,
 * typing, keeping alive and the transcript need `computers:terminal` (a
 * Platform Admin only in this release, rbac/capabilities.ts PLATFORM_CAP);
 * listing and ending need `computers:view`, because the business's own
 * member with Edit computers may revoke a session they could not open. The
 * service checks scope and visibility for every route: another business's
 * computer is a 404.
 */
@Controller('endpoints/:id/terminal')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class TerminalController {
  constructor(private readonly terminals: TerminalService, private readonly stepUp: StepUpService) {}

  @Get()
  @RequireCapability(CAP.COMPUTERS_VIEW)
  async list(@Actor() a: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.terminals.list(a, id) };
  }

  /** Open one: shell and reason; a fresh confirmation (terminal.open, which defaults to ask). */
  @Post()
  @RequireCapability(PLATFORM_CAP.COMPUTERS_TERMINAL)
  @RateLimit(10)
  async open(@Actor() a: ActorContext, @Param('id') id: string, @Body() body: { shell?: unknown; reason?: unknown }, @Req() req: Request) {
    const u = req.user as { sub?: string; iat?: number } | undefined;
    const fresh = u?.sub ? this.stepUp.read(req, u.sub, u.iat)?.method ?? null : null;
    return { success: true, data: await this.terminals.open(a, id, body ?? {}, fresh) };
  }

  @Get('sessions/:sid')
  @RequireCapability(PLATFORM_CAP.COMPUTERS_TERMINAL)
  @RateLimit(240)
  async read(@Actor() a: ActorContext, @Param('id') id: string, @Param('sid') sid: string, @Query('after') after?: string) {
    return { success: true, data: await this.terminals.read(a, id, sid, after) };
  }

  @Post('sessions/:sid/input')
  @RequireCapability(PLATFORM_CAP.COMPUTERS_TERMINAL)
  @RateLimit(240)
  @HttpCode(HttpStatus.OK)
  async input(@Actor() a: ActorContext, @Param('id') id: string, @Param('sid') sid: string, @Body() body: { data?: unknown }) {
    return { success: true, data: await this.terminals.input(a, id, sid, body?.data) };
  }

  @Post('sessions/:sid/keepalive')
  @RequireCapability(PLATFORM_CAP.COMPUTERS_TERMINAL)
  @RateLimit(30)
  @HttpCode(HttpStatus.OK)
  async keepAlive(@Actor() a: ActorContext, @Param('id') id: string, @Param('sid') sid: string) {
    return { success: true, data: await this.terminals.keepAlive(a, id, sid) };
  }

  /** End: its technician closes it; a Platform Admin or the business's own member with Edit computers revokes it. Never asks. */
  @Post('sessions/:sid/end')
  @RequireCapability(CAP.COMPUTERS_VIEW)
  @RateLimit(30)
  @HttpCode(HttpStatus.OK)
  async end(@Actor() a: ActorContext, @Param('id') id: string, @Param('sid') sid: string) {
    return { success: true, data: await this.terminals.endBy(a, id, sid) };
  }

  @Get('sessions/:sid/transcript')
  @RequireCapability(PLATFORM_CAP.COMPUTERS_TERMINAL)
  @RateLimit(30)
  async transcript(@Actor() a: ActorContext, @Param('id') id: string, @Param('sid') sid: string) {
    return { success: true, data: await this.terminals.transcript(a, id, sid) };
  }
}

/** A business's terminal settings: Platform Admin, audited. */
@Controller('remote-ops/settings')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
export class RemoteOpsSettingsController {
  constructor(private readonly settings: RemoteOpsSettingsService) {}

  @Get(':businessId')
  async get(@Actor() a: ActorContext, @Param('businessId') businessId: string) {
    return { success: true, data: await this.settings.get(a, businessId) };
  }

  @Put(':businessId')
  @RateLimit(20)
  async put(@Actor() a: ActorContext, @Param('businessId') businessId: string, @Body() body: unknown) {
    return { success: true, data: await this.settings.put(a, businessId, body) };
  }
}

/**
 * The signed agent's remote worker (0.77). Public, but each call parses
 * strictly and checks the device secret before anything else is read.
 * Outbound from the computer only.
 */
@Controller('remote/agent')
export class RemoteAgentController {
  constructor(private readonly agent: RemoteAgentService) {}

  @Post('poll')
  @Public()
  @RateLimit(240)
  @HttpCode(HttpStatus.OK)
  async poll(@Body() body: unknown) {
    return { success: true, data: await this.agent.poll(body) };
  }

  @Post('terminal/output')
  @Public()
  @RateLimit(600)
  @HttpCode(HttpStatus.OK)
  async output(@Body() body: unknown) {
    return { success: true, data: await this.agent.terminalOutput(body) };
  }

  // File transfer (0.78): the same strict parse and device check first.
  @Post('files/pull')
  @Public()
  @RateLimit(1200)
  @HttpCode(HttpStatus.OK)
  async filePull(@Body() body: unknown) {
    return { success: true, data: await this.agent.filePull(body) };
  }

  @Post('files/begin')
  @Public()
  @RateLimit(60)
  @HttpCode(HttpStatus.OK)
  async fileBegin(@Body() body: unknown) {
    return { success: true, data: await this.agent.fileBegin(body) };
  }

  @Post('files/push')
  @Public()
  @RateLimit(1200)
  @HttpCode(HttpStatus.OK)
  async filePush(@Body() body: unknown) {
    return { success: true, data: await this.agent.filePush(body) };
  }

  @Post('files/finish')
  @Public()
  @RateLimit(60)
  @HttpCode(HttpStatus.OK)
  async fileFinish(@Body() body: unknown) {
    return { success: true, data: await this.agent.fileFinish(body) };
  }
}
