import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { ArrayMaxSize, IsArray, IsBoolean, IsOptional, IsString, Length, Matches } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CapabilitiesGuard } from '../common/guards/capabilities.guard';
import { PlatformAdminGuard } from '../common/guards/platform-admin.guard';
import { RequireCapability } from '../common/decorators/require-capability.decorator';
import { Actor } from '../common/decorators/actor.decorator';
import { Public } from '../common/decorators/public.decorator';
import { RateLimit } from '../common/throttling';
import type { ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';
import { StepUpService } from '../auth/step-up.service';
import { assertFresh } from '../security-controls/review';
import { MsaGrantService } from './msa-grant.service';

/**
 * Managed Secure Access grants (0.71, build step 3), console side. Every
 * route is behind MSA_GRANTS (MsaGrantsGate, before anything else runs).
 * Issuing is the Platform Admin test route only; Connect does not issue a
 * grant until step 4.
 */
@Controller('msa/grants')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class MsaGrantsController {
  constructor(private readonly grants: MsaGrantService, private readonly stepUp: StepUpService) {}

  /** Issue a test grant to one computer. Platform Admin, a fresh confirmation (msa.grant). */
  @Post('test/:endpointId')
  @UseGuards(PlatformAdminGuard)
  @RateLimit(20)
  async test(@Actor() a: ActorContext, @Param('endpointId') endpointId: string, @Body() body: unknown, @Req() req: Request) {
    const u = req.user as { sub?: string; iat?: number } | undefined;
    assertFresh(u?.sub ? this.stepUp.read(req, u.sub, u.iat)?.method ?? null : null, { action: 'msa.grant', message: 'Confirm it is you to issue a session grant.' });
    return { success: true, data: await this.grants.issueTest(a, endpointId, body) };
  }

  /** The grant public keys (what step 4 publishes in the signed release metadata). Platform Admin. */
  @Get('keys')
  @UseGuards(PlatformAdminGuard)
  async keys() {
    return { success: true, data: await this.grants.publicKeys() };
  }

  /** A computer's recent grants: no envelope, no password. View computers, in scope. */
  @Get('endpoint/:endpointId')
  @RequireCapability(CAP.COMPUTERS_VIEW)
  async list(@Actor() a: ActorContext, @Param('endpointId') endpointId: string) {
    return { success: true, data: await this.grants.listForEndpoint(a, endpointId) };
  }
}

export class MsaPollDto {
  @IsString() @Matches(/^[0-9]{6,15}$/, { message: 'rustdeskId must be numeric' }) rustdeskId!: string;
  @IsString() @Length(16, 128) agentSecret!: string;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @Length(32, 32, { each: true }) ack?: string[];
  /** false: answer at once rather than holding the poll (an ack on its own). */
  @IsOptional() @IsBoolean() wait?: boolean;
}

/**
 * The signed agent's long-poll for grants (0.71). Public, but the device
 * secret is checked before anything else is read, and only a Windows
 * computer running the signed agent may poll. Held for at most 25 s; one
 * held poll per computer. No agent in 0.71 calls it.
 */
@Controller('msa/agent')
export class MsaAgentController {
  constructor(private readonly grants: MsaGrantService) {}

  @Post('poll')
  @Public()
  @RateLimit(120)
  @HttpCode(HttpStatus.OK)
  async poll(@Body() dto: MsaPollDto) {
    return { success: true, data: await this.grants.poll(dto) };
  }
}
