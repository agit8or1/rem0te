import { BadRequestException, Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Actor } from '../common/decorators/actor.decorator';
import { RateLimit } from '../common/throttling';
import type { ActorContext } from '../rbac/access-control.service';
import { PatchingService } from './patching.service';

/**
 * Staged Windows patching (v0.27). Reading posture, building deployments and
 * requesting rings. Like approved actions, there is no approve route: each
 * ring is approved on the approval signer's own origin.
 */
@Controller()
@UseGuards(JwtAuthGuard)
export class PatchingController {
  constructor(private readonly patching: PatchingService) {}

  @Get('endpoints/:id/patches')
  async endpoint(@Actor() actor: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.patching.endpointPatches(actor, id) };
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
