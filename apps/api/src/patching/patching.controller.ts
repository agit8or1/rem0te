import { BadRequestException, Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Actor } from '../common/decorators/actor.decorator';
import { RateLimit } from '../common/throttling';
import type { ActorContext } from '../rbac/access-control.service';
import { StepUpService } from '../auth/step-up.service';
import { assertFresh } from '../security-controls/review';
import { PatchingService } from './patching.service';
import { PatchPolicyService } from './policies.service';

/**
 * Staged Windows patching (v0.27). Reading posture, building deployments and
 * requesting rings. Like approved actions, there is no approve route: each
 * ring is approved on the approval signer's own origin.
 *
 * 0.32 adds installing from one computer's Patches tab (a one-computer
 * deployment that still needs two approvals) and patch policies. A policy
 * is approved on the signer too; creating or revoking one here needs a fresh
 * sign-in, and nothing here can approve one or sign under one.
 */
@Controller()
@UseGuards(JwtAuthGuard)
export class PatchingController {
  constructor(private readonly patching: PatchingService, private readonly policies: PatchPolicyService, private readonly stepUp: StepUpService) {}

  private fresh(req: Request) {
    const u = req.user as { sub?: string; iat?: number } | undefined;
    assertFresh(u?.sub ? this.stepUp.read(req, u.sub, u.iat)?.method ?? null : null);
  }

  @Get('endpoints/:id/patches')
  async endpoint(@Actor() actor: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.patching.endpointPatches(actor, id) };
  }

  /** Two approvals, like any ring: this only builds the one-computer deployment and requests its canary. */
  @Post('endpoints/:id/patches/install')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(10)
  async install(@Actor() actor: ActorContext, @Param('id') id: string, @Body() body: unknown) {
    return { success: true, data: await this.patching.installOnEndpoint(actor, id, body) };
  }

  @Get('patching/preflight')
  async preflight(@Actor() actor: ActorContext) {
    return { success: true, data: await this.policies.preflight(actor) };
  }

  @Get('patching/policies')
  async listPolicies(@Actor() actor: ActorContext, @Query('businessId') businessId: string) {
    return { success: true, data: await this.policies.list(actor, businessId) };
  }

  @Post('patching/policies')
  @RateLimit(10)
  async createPolicy(@Actor() actor: ActorContext, @Body() body: unknown, @Req() req: Request) {
    this.fresh(req);
    return { success: true, data: await this.policies.create(actor, body) };
  }

  @Get('patching/policies/:id')
  async getPolicy(@Actor() actor: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.policies.detail(actor, id) };
  }

  @Post('patching/policies/:id/revoke')
  @HttpCode(HttpStatus.OK)
  async revokePolicy(@Actor() actor: ActorContext, @Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    this.fresh(req);
    return { success: true, data: await this.policies.revoke(actor, id, body) };
  }

  @Get('patching/candidates')
  async candidates(@Actor() actor: ActorContext, @Query('businessId') businessId: string) {
    return { success: true, data: await this.patching.candidates(actor, businessId) };
  }

  @Get('patching/deployments')
  async list(@Actor() actor: ActorContext, @Query('businessId') businessId: string) {
    return { success: true, data: await this.patching.list(actor, businessId) };
  }

  @Post('patching/deployments')
  @RateLimit(10)
  async create(@Actor() actor: ActorContext, @Body() body: unknown) {
    return { success: true, data: await this.patching.create(actor, body) };
  }

  @Get('patching/deployments/:id')
  async get(@Actor() actor: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.patching.detail(actor, id) };
  }

  @Post('patching/deployments/:id/rings/:ring/request')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(10)
  async requestRing(@Actor() actor: ActorContext, @Param('id') id: string, @Param('ring') ring: string, @Body() body: unknown) {
    if (!/^[0-9]$/.test(ring)) throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'ring is 0 to 9' });
    return { success: true, data: await this.patching.requestRing(actor, id, Number(ring), body) };
  }

  @Post('patching/deployments/:id/pause')
  @HttpCode(HttpStatus.OK)
  async pause(@Actor() actor: ActorContext, @Param('id') id: string, @Body() body: unknown) {
    return { success: true, data: await this.patching.setStatus(actor, id, 'pause', body) };
  }

  @Post('patching/deployments/:id/resume')
  @HttpCode(HttpStatus.OK)
  async resume(@Actor() actor: ActorContext, @Param('id') id: string, @Body() body: unknown) {
    return { success: true, data: await this.patching.setStatus(actor, id, 'resume', body) };
  }

  @Post('patching/deployments/:id/cancel')
  @HttpCode(HttpStatus.OK)
  async cancel(@Actor() actor: ActorContext, @Param('id') id: string, @Body() body: unknown) {
    return { success: true, data: await this.patching.setStatus(actor, id, 'cancel', body) };
  }
}
