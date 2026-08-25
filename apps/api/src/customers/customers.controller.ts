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
import { IsBoolean, IsEmail, IsOptional, IsString, Length } from 'class-validator';
import { CustomersService } from './customers.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/strategies/jwt.strategy';

// class-validator decorators are REQUIRED — the global ValidationPipe runs
// with { whitelist: true, forbidNonWhitelisted: true }, which strips any body
// property that has no rule. Without these decorators the request body arrives
// at the service as `{}` and Prisma throws.
class CreateCustomerDto {
  @IsString() @Length(1, 128)                   name!: string;
  @IsOptional() @IsString() @Length(0, 64)      code?: string;
  @IsOptional() @IsEmail()                       email?: string;
  @IsOptional() @IsString() @Length(0, 32)      phone?: string;
  @IsOptional() @IsString() @Length(0, 256)     address?: string;
  @IsOptional() @IsString() @Length(0, 96)      city?: string;
  @IsOptional() @IsString() @Length(0, 96)      state?: string;
  @IsOptional() @IsString() @Length(0, 96)      country?: string;
  @IsOptional() @IsString() @Length(0, 32)      postalCode?: string;
  @IsOptional() @IsString() @Length(0, 2048)    notes?: string;
}

class UpdateCustomerDto {
  @IsOptional() @IsString() @Length(1, 128)     name?: string;
  @IsOptional() @IsString() @Length(0, 64)      code?: string;
  @IsOptional() @IsEmail()                       email?: string;
  @IsOptional() @IsString() @Length(0, 32)      phone?: string;
  @IsOptional() @IsString() @Length(0, 256)     address?: string;
  @IsOptional() @IsString() @Length(0, 96)      city?: string;
  @IsOptional() @IsString() @Length(0, 96)      state?: string;
  @IsOptional() @IsString() @Length(0, 96)      country?: string;
  @IsOptional() @IsString() @Length(0, 32)      postalCode?: string;
  @IsOptional() @IsString() @Length(0, 2048)    notes?: string;
  @IsOptional() @IsBoolean()                     isActive?: boolean;
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
