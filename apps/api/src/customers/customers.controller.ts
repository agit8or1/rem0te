import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CustomersService } from './customers.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/strategies/jwt.strategy';

class CreateCustomerDto {
  name!: string;
  code?: string;
  email?: string;
  phone?: string;
  address?: string;
  city?: string;
  state?: string;
  country?: string;
  postalCode?: string;
  notes?: string;
}

class UpdateCustomerDto {
  name?: string;
  code?: string;
  email?: string;
  phone?: string;
  address?: string;
  city?: string;
  state?: string;
  country?: string;
  postalCode?: string;
  notes?: string;
  isActive?: boolean;
}

@Controller('customers')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class CustomersController {
  constructor(private readonly customersService: CustomersService) {}

  @Get()
  @RequirePermissions('customers:read')
  async list(@CurrentUser() user: JwtPayload, @Query('search') search?: string) {
    if (!user.tenantId) return { success: false, data: [] };
    const data = await this.customersService.findAll(user.tenantId, search);
    return { success: true, data };
  }

  @Get(':id')
  @RequirePermissions('customers:read')
  async get(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    if (!user.tenantId) return { success: false, message: 'No tenant context' };
    const data = await this.customersService.findOne(user.tenantId, id);
    return { success: true, data };
  }

  @Post()
  @RequirePermissions('customers:write')
  async create(@CurrentUser() user: JwtPayload, @Body() dto: CreateCustomerDto) {
    if (!user.tenantId) return { success: false, message: 'No tenant context' };
    const data = await this.customersService.create(user.tenantId, user.sub, dto);
    return { success: true, data };
  }

  @Patch(':id')
  @RequirePermissions('customers:write')
  async update(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateCustomerDto,
  ) {
    if (!user.tenantId) return { success: false, message: 'No tenant context' };
    const data = await this.customersService.update(user.tenantId, id, user.sub, dto);
    return { success: true, data };
  }

  @Patch(':id/archive')
  @RequirePermissions('customers:write')
  async archive(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    if (!user.tenantId) return { success: false, message: 'No tenant context' };
    const data = await this.customersService.archive(user.tenantId, id, user.sub);
    return { success: true, data };
  }

  @Post(':id/portal/invite')
  @RequirePermissions('users:write')
  async invitePortalUser(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: { email: string; firstName: string; lastName: string },
  ) {
    if (!user.tenantId) return { success: false };
    const data = await this.customersService.invitePortalUser(user.tenantId, id, user.sub, dto.email, dto.firstName, dto.lastName);
    return { success: true, data };
  }

  @Patch(':id/portal')
  @RequirePermissions('customers:write')
  async togglePortal(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body('enabled') enabled: boolean,
  ) {
    if (!user.tenantId) return { success: false };
    const data = await this.customersService.enablePortal(user.tenantId, id, user.sub, enabled);
    return { success: true, data };
  }

  @Get(':id/portal/users')
  @RequirePermissions('users:read')
  async listPortalUsers(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    if (!user.tenantId) return { success: false };
    const data = await this.customersService.listPortalUsers(user.tenantId, id);
    return { success: true, data };
  }
}
