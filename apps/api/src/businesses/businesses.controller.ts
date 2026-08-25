import {
  Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards,
} from '@nestjs/common';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsEmail, IsIn, IsOptional, IsString, Length,
} from 'class-validator';
import { BusinessesService } from './businesses.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { CapabilitiesGuard } from '../common/guards/capabilities.guard';
import { RequireCapability } from '../common/decorators/require-capability.decorator';
import { Actor } from '../common/decorators/actor.decorator';
import type { ActorContext } from '../rbac/access-control.service';
import { CAP, CAPABILITY_GROUPS } from '../rbac/capabilities';

// class-validator decorators are REQUIRED — the global ValidationPipe runs with
// { whitelist: true, forbidNonWhitelisted: true }, so an undecorated property
// is stripped before the service ever sees it.
class CreateBusinessDto {
  @IsString() @Length(1, 128)                name!: string;
  @IsOptional() @IsString() @Length(0, 64)   code?: string;
  @IsOptional() @IsEmail()                   email?: string;
  @IsOptional() @IsString() @Length(0, 32)   phone?: string;
  @IsOptional() @IsString() @Length(0, 256)  address?: string;
  @IsOptional() @IsString() @Length(0, 96)   city?: string;
  @IsOptional() @IsString() @Length(0, 96)   state?: string;
  @IsOptional() @IsString() @Length(0, 96)   country?: string;
  @IsOptional() @IsString() @Length(0, 32)   postalCode?: string;
  @IsOptional() @IsString() @Length(0, 2048) notes?: string;
}

class UpdateBusinessDto {
  @IsOptional() @IsString() @Length(1, 128)  name?: string;
  @IsOptional() @IsString() @Length(0, 64)   code?: string;
  @IsOptional() @IsEmail()                   email?: string;
  @IsOptional() @IsString() @Length(0, 32)   phone?: string;
  @IsOptional() @IsString() @Length(0, 256)  address?: string;
  @IsOptional() @IsString() @Length(0, 96)   city?: string;
  @IsOptional() @IsString() @Length(0, 96)   state?: string;
  @IsOptional() @IsString() @Length(0, 96)   country?: string;
  @IsOptional() @IsString() @Length(0, 32)   postalCode?: string;
  @IsOptional() @IsString() @Length(0, 2048) notes?: string;
  @IsOptional() @IsBoolean()                 isActive?: boolean;
  @IsOptional() @IsBoolean()                 quickConnectEnabled?: boolean;
}

class AddBusinessUserDto {
  @IsEmail()                                  email!: string;
  @IsOptional() @IsString() @Length(0, 96)    firstName?: string;
  @IsOptional() @IsString() @Length(0, 96)    lastName?: string;
  @IsIn(['BUSINESS_OWNER', 'BUSINESS_USER'])  level!: 'BUSINESS_OWNER' | 'BUSINESS_USER';
  @IsOptional() @IsArray() @ArrayMaxSize(32) @IsString({ each: true }) capabilities?: string[];
}

class SetCapabilitiesDto {
  @IsArray() @ArrayMaxSize(32) @IsString({ each: true }) capabilities!: string[];
}

class SetActiveDto {
  @IsBoolean() active!: boolean;
}

/**
 * Businesses — the customer organisations the platform operator manages.
 *
 * `customers` is kept as a route alias so already-deployed launchers and API
 * consumers keep working through the rename; both paths hit the same
 * business-scoped handlers.
 */
@Controller(['businesses', 'customers'])
@UseGuards(JwtAuthGuard, PermissionsGuard, CapabilitiesGuard)
export class BusinessesController {
  constructor(private readonly businesses: BusinessesService) {}

  /** The capability vocabulary, so the UI never hard-codes it. */
  @Get('capability-catalog')
  capabilityCatalog() {
    return { success: true, data: CAPABILITY_GROUPS };
  }

  // No capability gate: the scope filter already limits a business member to
  // their own business, and knowing your own business exists is not a
  // privilege worth withholding.
  @Get()
  async list(@Actor() actor: ActorContext, @Query('search') search?: string) {
    const data = await this.businesses.findAll(actor, search);
    return { success: true, data };
  }

  @Get(':id')
  async get(@Actor() actor: ActorContext, @Param('id') id: string) {
    const data = await this.businesses.findOne(actor, id);
    return { success: true, data };
  }

  @Post()
  async create(@Actor() actor: ActorContext, @Body() dto: CreateBusinessDto) {
    const data = await this.businesses.create(actor, dto);
    return { success: true, data };
  }

  @Patch(':id')
  async update(@Actor() actor: ActorContext, @Param('id') id: string, @Body() dto: UpdateBusinessDto) {
    const data = await this.businesses.update(actor, id, dto);
    return { success: true, data };
  }

  @Patch(':id/archive')
  async archive(@Actor() actor: ActorContext, @Param('id') id: string) {
    const data = await this.businesses.archive(actor, id);
    return { success: true, data };
  }

  @Delete(':id')
  async remove(@Actor() actor: ActorContext, @Param('id') id: string) {
    const data = await this.businesses.remove(actor, id);
    return { success: true, data };
  }

  // ── People ────────────────────────────────────────────────────────────────

  @Get(':id/users')
  @RequireCapability(CAP.USERS_VIEW)
  async listUsers(@Actor() actor: ActorContext, @Param('id') id: string) {
    const data = await this.businesses.listUsers(actor, id);
    return { success: true, data };
  }

  @Post(':id/users')
  @RequireCapability(CAP.USERS_MANAGE)
  async addUser(@Actor() actor: ActorContext, @Param('id') id: string, @Body() dto: AddBusinessUserDto) {
    const data = await this.businesses.addUser(actor, id, dto);
    return { success: true, data };
  }

  @Patch(':id/users/:userId/capabilities')
  @RequireCapability(CAP.USERS_MANAGE)
  async setCapabilities(
    @Actor() actor: ActorContext,
    @Param('id') id: string,
    @Param('userId') userId: string,
    @Body() dto: SetCapabilitiesDto,
  ) {
    const data = await this.businesses.setUserCapabilities(actor, id, userId, dto.capabilities);
    return { success: true, data };
  }

  @Patch(':id/users/:userId/active')
  @RequireCapability(CAP.USERS_MANAGE)
  async setActive(
    @Actor() actor: ActorContext,
    @Param('id') id: string,
    @Param('userId') userId: string,
    @Body() dto: SetActiveDto,
  ) {
    const data = await this.businesses.setUserActive(actor, id, userId, dto.active);
    return { success: true, data };
  }

  @Post(':id/users/:userId/reset-access')
  @RequireCapability(CAP.USERS_MANAGE)
  async resetAccess(
    @Actor() actor: ActorContext,
    @Param('id') id: string,
    @Param('userId') userId: string,
  ) {
    const data = await this.businesses.resetUserAccess(actor, id, userId);
    return { success: true, data };
  }

  @Delete(':id/users/:userId')
  @RequireCapability(CAP.USERS_MANAGE)
  async removeUser(
    @Actor() actor: ActorContext,
    @Param('id') id: string,
    @Param('userId') userId: string,
  ) {
    const data = await this.businesses.removeUser(actor, id, userId);
    return { success: true, data };
  }
}
