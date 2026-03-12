import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import { TenantsService } from './tenants.service';
import {
  CreateTenantDto,
  UpdateBrandingDto,
  UpdateSettingsDto,
  UpdateTenantDto,
} from './dto/create-tenant.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/strategies/jwt.strategy';

@Controller('tenants')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class TenantsController {
  constructor(private readonly tenantsService: TenantsService) {}

  @Get()
  @RequirePermissions('platform:admin')
  async findAll() {
    const data = await this.tenantsService.findAll();
    return { success: true, data };
  }

  @Get(':id')
  @RequirePermissions('tenant:read')
  async findOne(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    if (!user.isPlatformAdmin && user.tenantId !== id) {
      throw new ForbiddenException('Access denied');
    }
    const data = await this.tenantsService.findOne(id);
    return { success: true, data };
  }

  @Post()
  @RequirePermissions('platform:admin')
  async create(@CurrentUser() user: JwtPayload, @Body() dto: CreateTenantDto) {
    const data = await this.tenantsService.create(user.sub, dto);
    return { success: true, data };
  }

  @Patch(':id')
  @RequirePermissions('tenant:write')
  async update(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateTenantDto,
  ) {
    const data = await this.tenantsService.update(id, user.sub, dto);
    return { success: true, data };
  }

  @Patch(':id/branding')
  @RequirePermissions('branding:write')
  async updateBranding(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateBrandingDto,
  ) {
    const data = await this.tenantsService.updateBranding(id, user.sub, dto);
    return { success: true, data };
  }

  @Patch(':id/settings')
  @RequirePermissions('settings:write')
  async updateSettings(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateSettingsDto,
  ) {
    const data = await this.tenantsService.updateSettings(id, user.sub, dto);
    return { success: true, data };
  }

  @Get(':id/members')
  @RequirePermissions('users:read')
  async getMembers(@Param('id') id: string) {
    const data = await this.tenantsService.getMembers(id);
    return { success: true, data };
  }

  @Patch(':id/members/:userId/role')
  @RequirePermissions('roles:write')
  async assignRole(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @CurrentUser() user: JwtPayload,
    @Body('roleId') roleId: string,
  ) {
    const data = await this.tenantsService.assignRole(id, userId, roleId, user.sub);
    return { success: true, data };
  }

  @Get(':id/roles')
  @RequirePermissions('users:read')
  async listRoles(@Param('id') id: string) {
    const data = await this.tenantsService.listRoles(id);
    return { success: true, data };
  }

  @Post(':id/invite')
  @RequirePermissions('users:write')
  async inviteMember(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body('email') email: string,
    @Body('roleId') roleId: string,
  ) {
    const data = await this.tenantsService.inviteMember(id, user.sub, email, roleId);
    return { success: true, data };
  }
}
