import {
  Controller, Get, Post, Patch, Delete,
  Body, Param, Query, Req, UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { EndpointsService } from './endpoints.service';
import { CreateEndpointDto, UpdateEndpointDto, AddTagDto, AddAliasDto } from './dto/create-endpoint.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CapabilitiesGuard } from '../common/guards/capabilities.guard';
import { RequireCapability } from '../common/decorators/require-capability.decorator';
import { Actor } from '../common/decorators/actor.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import type { ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';
import type { JwtPayload } from '../auth/strategies/jwt.strategy';

/**
 * Computers.
 *
 * The capability decorators here gate the verb. The business the verb lands
 * on is resolved inside EndpointsService for every single route — a path
 * parameter naming another business's computer produces a 404, not a leak.
 */
@Controller('endpoints')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class EndpointsController {
  constructor(private readonly svc: EndpointsService) {}

  @Get('connected')
  @RequireCapability(CAP.COMPUTERS_VIEW)
  async connected(@Actor() actor: ActorContext) {
    return { success: true, data: await this.svc.findConnected(actor) };
  }

  /**
   * "My Computers" — what this specific person may connect to. No admin
   * capability required beyond `computers:view`, so an ordinary Business User
   * always reaches their own assigned machines.
   */
  @Get('mine')
  async mine(@Actor() actor: ActorContext) {
    return { success: true, data: await this.svc.myComputers(actor) };
  }

  /**
   * One-click Connect. Mints a short-lived single-use grant for the launcher
   * and also returns the credentials for the current browser flow. Both paths
   * run the same authorization check and both are audited.
   */
  @Post(':id/connect')
  @HttpCode(HttpStatus.OK)
  @RequireCapability(CAP.COMPUTERS_CONNECT)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async connect(@Actor() actor: ActorContext, @Param('id') id: string) {
    const grant = await this.svc.createConnectionGrant(actor, id);
    const info = await this.svc.connectInfo(actor, id);
    return {
      success: true,
      data: {
        ...info,
        grantToken: grant.token,
        grantExpiresAt: grant.expiresAt,
        launchUri: `rem0te://connect/${grant.token}`,
      },
    };
  }

  /**
   * Redeem a ConnectionGrant. Public because the launcher has no session —
   * the single-use token is itself the proof, and the service re-runs the
   * full authorization check before handing anything back.
   */
  @Post('grants/redeem')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async redeemGrant(@Body() body: { token: string }, @Req() req: Request) {
    const data = await this.svc.redeemConnectionGrant(body.token, req.ip);
    return { success: true, data };
  }

  // ── Per-computer access ───────────────────────────────────────────────────

  @Get(':id/access')
  @RequireCapability(CAP.USERS_VIEW)
  async listAccess(@Actor() actor: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.svc.listAccess(actor, id) };
  }

  @Post(':id/access')
  @RequireCapability(CAP.USERS_MANAGE)
  @HttpCode(HttpStatus.OK)
  async grantAccess(@Actor() actor: ActorContext, @Param('id') id: string, @Body() body: { userId: string }) {
    return { success: true, data: await this.svc.grantAccess(actor, id, body.userId) };
  }

  @Delete(':id/access/:userId')
  @RequireCapability(CAP.USERS_MANAGE)
  @HttpCode(HttpStatus.OK)
  async revokeAccess(@Actor() actor: ActorContext, @Param('id') id: string, @Param('userId') userId: string) {
    await this.svc.revokeAccess(actor, id, userId);
    return { success: true };
  }

  @Patch(':id/access-mode')
  @RequireCapability(CAP.COMPUTERS_EDIT)
  @HttpCode(HttpStatus.OK)
  async setAccessMode(
    @Actor() actor: ActorContext,
    @Param('id') id: string,
    @Body() body: { accessMode: 'ASSIGNED_USERS' | 'COMPANY_WIDE' },
  ) {
    return { success: true, data: await this.svc.setAccessMode(actor, id, body.accessMode) };
  }

  // ── Credentials ───────────────────────────────────────────────────────────

  @Post(':id/rotate-credential')
  @RequireCapability(CAP.COMPUTERS_EDIT)
  @HttpCode(HttpStatus.OK)
  async rotateCredential(@Actor() actor: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.svc.rotateCredential(actor, id) };
  }

  @Get(':id/password')
  @RequireCapability(CAP.COMPUTERS_EDIT)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async getPassword(
    @Actor() actor: ActorContext,
    @CurrentUser() u: JwtPayload,
    @Param('id') id: string,
  ) {
    // Revealing a persistent credential requires MFA to have been satisfied
    // on this session, for anyone who has MFA configured.
    if (u.mfaVerified === false) {
      return { success: false, message: 'MFA required to reveal a computer password' };
    }
    const password = await this.svc.getPassword(actor, id);
    return { success: true, data: { hasPassword: password !== null, password } };
  }

  @Patch(':id/password')
  @RequireCapability(CAP.COMPUTERS_EDIT)
  @HttpCode(HttpStatus.OK)
  async setPassword(
    @Actor() actor: ActorContext,
    @Param('id') id: string,
    @Body('password') password: string | null,
  ) {
    await this.svc.setPassword(actor, id, password ?? null);
    return { success: true };
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  @Get()
  @RequireCapability(CAP.COMPUTERS_VIEW)
  async list(@Actor() actor: ActorContext, @Query() q: Record<string, string>) {
    return { success: true, data: await this.svc.findAll(actor, {
      search: q.search,
      // `businessId` is the current name; `customerId` still accepted so an
      // in-flight client does not break mid-upgrade.
      businessId: q.businessId ?? q.customerId,
      status: q.status,
      tag: q.tag, platform: q.platform,
      page: q.page ? parseInt(q.page) : 1,
      limit: q.limit ? parseInt(q.limit) : 50,
    }) };
  }

  @Get(':id')
  @RequireCapability(CAP.COMPUTERS_VIEW)
  async get(@Actor() actor: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.svc.findOne(actor, id) };
  }

  @Post()
  @RequireCapability(CAP.COMPUTERS_ADD)
  async create(@Actor() actor: ActorContext, @Body() dto: CreateEndpointDto) {
    return { success: true, data: await this.svc.create(actor, dto) };
  }

  @Patch(':id')
  @RequireCapability(CAP.COMPUTERS_EDIT)
  async update(@Actor() actor: ActorContext, @Param('id') id: string, @Body() dto: UpdateEndpointDto) {
    return { success: true, data: await this.svc.update(actor, id, dto) };
  }

  @Patch(':id/archive')
  @RequireCapability(CAP.COMPUTERS_REMOVE)
  @HttpCode(HttpStatus.OK)
  async archive(@Actor() actor: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.svc.archive(actor, id) };
  }

  @Post(':id/tags')
  @RequireCapability(CAP.COMPUTERS_EDIT)
  async addTag(@Actor() actor: ActorContext, @Param('id') id: string, @Body() dto: AddTagDto) {
    await this.svc.addTag(actor, id, dto.tag);
    return { success: true };
  }

  @Delete(':id/tags/:tag')
  @RequireCapability(CAP.COMPUTERS_EDIT)
  @HttpCode(HttpStatus.OK)
  async removeTag(@Actor() actor: ActorContext, @Param('id') id: string, @Param('tag') tag: string) {
    await this.svc.removeTag(actor, id, tag);
    return { success: true };
  }

  @Post(':id/aliases')
  @RequireCapability(CAP.COMPUTERS_EDIT)
  async addAlias(@Actor() actor: ActorContext, @Param('id') id: string, @Body() dto: AddAliasDto) {
    return { success: true, data: await this.svc.addAlias(actor, id, dto.alias, dto.isPrimary) };
  }

  @Delete(':id/aliases/:aliasId')
  @RequireCapability(CAP.COMPUTERS_EDIT)
  @HttpCode(HttpStatus.OK)
  async removeAlias(@Actor() actor: ActorContext, @Param('id') id: string, @Param('aliasId') aliasId: string) {
    await this.svc.removeAlias(actor, id, aliasId);
    return { success: true };
  }

  @Post(':id/timeline/generate')
  @RequireCapability(CAP.COMPUTERS_EDIT)
  @HttpCode(HttpStatus.OK)
  async generateTimeline(@Actor() actor: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.svc.generateTimeline(actor, id) };
  }
}
