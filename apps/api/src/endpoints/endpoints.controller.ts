import {
  Controller, Get, Post, Patch, Delete,
  Body, Param, Query, Req, UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { EndpointsService } from './endpoints.service';
import { CreateEndpointDto, UpdateEndpointDto, AddTagDto, AddAliasDto } from './dto/create-endpoint.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/strategies/jwt.strategy';

@Controller('endpoints')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class EndpointsController {
  constructor(private readonly svc: EndpointsService) {}

  @Get('connected')
  @RequirePermissions('endpoints:read')
  async connected(@CurrentUser() u: JwtPayload) {
    return { success: true, data: await this.svc.findConnected(u.tenantId!) };
  }

  // Employee-facing: "My Computers" — the list of computers this specific user
  // is authorized to connect to. Requires an authenticated user but no admin
  // permission, so ordinary employees always have access to their assigned PCs.
  @Get('mine')
  async mine(@CurrentUser() u: JwtPayload) {
    if (!u.tenantId) return { success: true, data: [] };
    return { success: true, data: await this.svc.myComputers(u.tenantId, u.sub) };
  }

  // Manage ComputerAccess rows for a specific endpoint (admin only).
  @Get(':id/access')
  @RequirePermissions('endpoints:write')
  async listAccess(@CurrentUser() u: JwtPayload, @Param('id') id: string) {
    return { success: true, data: await this.svc.listAccess(u.tenantId!, id) };
  }

  @Post(':id/access')
  @RequirePermissions('endpoints:write')
  @HttpCode(HttpStatus.OK)
  async grantAccess(
    @CurrentUser() u: JwtPayload,
    @Param('id') id: string,
    @Body() body: { userId: string },
  ) {
    return { success: true, data: await this.svc.grantAccess(u.tenantId!, id, body.userId, u.sub) };
  }

  @Delete(':id/access/:userId')
  @RequirePermissions('endpoints:write')
  @HttpCode(HttpStatus.OK)
  async revokeAccess(
    @CurrentUser() u: JwtPayload,
    @Param('id') id: string,
    @Param('userId') userId: string,
  ) {
    await this.svc.revokeAccess(u.tenantId!, id, userId, u.sub);
    return { success: true };
  }

  @Patch(':id/access-mode')
  @RequirePermissions('endpoints:write')
  @HttpCode(HttpStatus.OK)
  async setAccessMode(
    @CurrentUser() u: JwtPayload,
    @Param('id') id: string,
    @Body() body: { accessMode: 'ASSIGNED_USERS' | 'COMPANY_WIDE' },
  ) {
    return { success: true, data: await this.svc.setAccessMode(u.tenantId!, id, body.accessMode, u.sub) };
  }

  @Get()
  @RequirePermissions('endpoints:read')
  async list(@CurrentUser() u: JwtPayload, @Query() q: Record<string, string>) {
    return { success: true, data: await this.svc.findAll(u.tenantId!, {
      search: q.search, customerId: q.customerId, status: q.status,
      tag: q.tag, platform: q.platform,
      page: q.page ? parseInt(q.page) : 1,
      limit: q.limit ? parseInt(q.limit) : 50,
    }) };
  }

  @Get(':id')
  @RequirePermissions('endpoints:read')
  async get(@CurrentUser() u: JwtPayload, @Param('id') id: string) {
    return { success: true, data: await this.svc.findOne(u.tenantId!, id) };
  }

  @Post()
  @RequirePermissions('endpoints:write')
  async create(@CurrentUser() u: JwtPayload, @Body() dto: CreateEndpointDto) {
    return { success: true, data: await this.svc.create(u.tenantId!, u.sub, dto) };
  }

  @Patch(':id')
  @RequirePermissions('endpoints:write')
  async update(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body() dto: UpdateEndpointDto) {
    return { success: true, data: await this.svc.update(u.tenantId!, id, u.sub, dto) };
  }

  @Patch(':id/archive')
  @RequirePermissions('endpoints:write')
  @HttpCode(HttpStatus.OK)
  async archive(@CurrentUser() u: JwtPayload, @Param('id') id: string) {
    return { success: true, data: await this.svc.archive(u.tenantId!, id, u.sub) };
  }

  @Post(':id/tags')
  @RequirePermissions('endpoints:write')
  async addTag(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body() dto: AddTagDto) {
    await this.svc.addTag(u.tenantId!, id, dto.tag);
    return { success: true };
  }

  @Delete(':id/tags/:tag')
  @RequirePermissions('endpoints:write')
  @HttpCode(HttpStatus.OK)
  async removeTag(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Param('tag') tag: string) {
    await this.svc.removeTag(u.tenantId!, id, tag);
    return { success: true };
  }

  @Post(':id/aliases')
  @RequirePermissions('endpoints:write')
  async addAlias(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body() dto: AddAliasDto) {
    return { success: true, data: await this.svc.addAlias(u.tenantId!, id, dto.alias, dto.isPrimary) };
  }

  @Delete(':id/aliases/:aliasId')
  @RequirePermissions('endpoints:write')
  @HttpCode(HttpStatus.OK)
  async removeAlias(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Param('aliasId') aliasId: string) {
    await this.svc.removeAlias(u.tenantId!, id, aliasId);
    return { success: true };
  }

  @Post(':id/timeline/generate')
  @RequirePermissions('endpoints:write')
  @HttpCode(HttpStatus.OK)
  async generateTimeline(@CurrentUser() u: JwtPayload, @Param('id') id: string) {
    return { success: true, data: await this.svc.generateTimeline(u.tenantId!, id) };
  }

  @Get(':id/password')
  @RequirePermissions('endpoints:write')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async getPassword(
    @CurrentUser() u: JwtPayload,
    @Param('id') id: string,
    @Req() req: Request,
  ) {
    // MFA gate: revealing a persistent RustDesk credential requires the technician
    // to have satisfied MFA on this session (if they have MFA configured).
    if (u.mfaVerified === false) {
      return { success: false, message: 'MFA required to reveal endpoint password' };
    }
    const password = await this.svc.getPassword(u.tenantId!, id, u.sub, req.ip);
    return { success: true, data: { hasPassword: password !== null, password } };
  }

  @Patch(':id/password')
  @RequirePermissions('endpoints:write')
  @HttpCode(HttpStatus.OK)
  async setPassword(
    @CurrentUser() u: JwtPayload,
    @Param('id') id: string,
    @Body('password') password: string | null,
  ) {
    await this.svc.setPassword(u.tenantId!, id, password ?? null);
    return { success: true };
  }
}
