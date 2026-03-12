import {
  Controller, Get, Post, Patch, Delete,
  Body, Param, Query, UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
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

  @Get(':id/password')
  @RequirePermissions('endpoints:read')
  async getPassword(@CurrentUser() u: JwtPayload, @Param('id') id: string) {
    const password = await this.svc.getPassword(u.tenantId!, id);
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
