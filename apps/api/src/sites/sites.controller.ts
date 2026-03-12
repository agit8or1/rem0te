import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { SitesService } from './sites.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/strategies/jwt.strategy';

class CreateSiteDto {
  name!: string;
  address?: string;
  city?: string;
  state?: string;
  country?: string;
  postalCode?: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  notes?: string;
}

class UpdateSiteDto {
  name?: string;
  address?: string;
  city?: string;
  state?: string;
  country?: string;
  postalCode?: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  notes?: string;
  isActive?: boolean;
}

// Nested route: /customers/:customerId/sites
@Controller('customers/:customerId/sites')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class SitesByCustomerController {
  constructor(private readonly sitesService: SitesService) {}

  @Get()
  @RequirePermissions('customers:read')
  async list(@Param('customerId') customerId: string, @CurrentUser() user: JwtPayload) {
    if (!user.tenantId) return { success: false, data: [] };
    const data = await this.sitesService.findAll(user.tenantId, customerId);
    return { success: true, data };
  }

  @Get(':id')
  @RequirePermissions('customers:read')
  async get(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    if (!user.tenantId) return { success: false, message: 'No tenant context' };
    const data = await this.sitesService.findOne(user.tenantId, id);
    return { success: true, data };
  }

  @Post()
  @RequirePermissions('customers:write')
  async create(
    @Param('customerId') customerId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateSiteDto,
  ) {
    if (!user.tenantId) return { success: false, message: 'No tenant context' };
    const data = await this.sitesService.create(user.tenantId, user.sub, { ...dto, customerId });
    return { success: true, data };
  }

  @Patch(':id')
  @RequirePermissions('customers:write')
  async update(@Param('id') id: string, @CurrentUser() user: JwtPayload, @Body() dto: UpdateSiteDto) {
    if (!user.tenantId) return { success: false, message: 'No tenant context' };
    const data = await this.sitesService.update(user.tenantId, id, user.sub, dto);
    return { success: true, data };
  }

  @Delete(':id')
  @RequirePermissions('customers:write')
  async delete(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    if (!user.tenantId) return { success: false, message: 'No tenant context' };
    await this.sitesService.delete(user.tenantId, id, user.sub);
    return { success: true };
  }
}

// Flat route: /sites
@Controller('sites')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class SitesController {
  constructor(private readonly sitesService: SitesService) {}

  @Get()
  @RequirePermissions('customers:read')
  async list(@CurrentUser() user: JwtPayload, @Query('customerId') customerId?: string) {
    if (!user.tenantId) return { success: false, data: [] };
    const data = await this.sitesService.findAll(user.tenantId, customerId);
    return { success: true, data };
  }

  @Get(':id')
  @RequirePermissions('customers:read')
  async get(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    if (!user.tenantId) return { success: false, message: 'No tenant context' };
    const data = await this.sitesService.findOne(user.tenantId, id);
    return { success: true, data };
  }

  @Patch(':id')
  @RequirePermissions('customers:write')
  async update(@Param('id') id: string, @CurrentUser() user: JwtPayload, @Body() dto: UpdateSiteDto) {
    if (!user.tenantId) return { success: false, message: 'No tenant context' };
    const data = await this.sitesService.update(user.tenantId, id, user.sub, dto);
    return { success: true, data };
  }

  @Delete(':id')
  @RequirePermissions('customers:write')
  async delete(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    if (!user.tenantId) return { success: false, message: 'No tenant context' };
    await this.sitesService.delete(user.tenantId, id, user.sub);
    return { success: true };
  }
}
