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
import { IsBoolean, IsEmail, IsOptional, IsString, Length } from 'class-validator';
import { SitesService } from './sites.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CapabilitiesGuard } from '../common/guards/capabilities.guard';
import { RequireCapability } from '../common/decorators/require-capability.decorator';
import { Actor } from '../common/decorators/actor.decorator';
import type { ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';

// class-validator decorators are REQUIRED — see businesses.controller.ts.
class CreateSiteDto {
  @IsString() @Length(1, 128)                name!: string;
  @IsOptional() @IsString() @Length(0, 256)  address?: string;
  @IsOptional() @IsString() @Length(0, 96)   city?: string;
  @IsOptional() @IsString() @Length(0, 96)   state?: string;
  @IsOptional() @IsString() @Length(0, 96)   country?: string;
  @IsOptional() @IsString() @Length(0, 32)   postalCode?: string;
  @IsOptional() @IsString() @Length(0, 128)  contactName?: string;
  @IsOptional() @IsEmail()                    contactEmail?: string;
  @IsOptional() @IsString() @Length(0, 32)   contactPhone?: string;
  @IsOptional() @IsString() @Length(0, 2048) notes?: string;
}

class UpdateSiteDto {
  @IsOptional() @IsString() @Length(1, 128)  name?: string;
  @IsOptional() @IsString() @Length(0, 256)  address?: string;
  @IsOptional() @IsString() @Length(0, 96)   city?: string;
  @IsOptional() @IsString() @Length(0, 96)   state?: string;
  @IsOptional() @IsString() @Length(0, 96)   country?: string;
  @IsOptional() @IsString() @Length(0, 32)   postalCode?: string;
  @IsOptional() @IsString() @Length(0, 128)  contactName?: string;
  @IsOptional() @IsEmail()                    contactEmail?: string;
  @IsOptional() @IsString() @Length(0, 32)   contactPhone?: string;
  @IsOptional() @IsString() @Length(0, 2048) notes?: string;
  @IsOptional() @IsBoolean()                  isActive?: boolean;
}

// Sites nested under a business. `customers/...` is kept as an alias so
// existing links keep resolving through the rename.
@Controller(['businesses/:businessId/sites', 'customers/:businessId/sites'])
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class BusinessSitesController {
  constructor(private readonly sites: SitesService) {}

  @Get()
  @RequireCapability(CAP.COMPUTERS_VIEW)
  async list(@Actor() actor: ActorContext, @Param('businessId') businessId: string) {
    return { success: true, data: await this.sites.findAll(actor, businessId) };
  }

  @Get(':id')
  @RequireCapability(CAP.COMPUTERS_VIEW)
  async get(@Actor() actor: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.sites.findOne(actor, id) };
  }

  @Post()
  @RequireCapability(CAP.COMPUTERS_EDIT)
  async create(
    @Actor() actor: ActorContext,
    @Param('businessId') businessId: string,
    @Body() dto: CreateSiteDto,
  ) {
    return { success: true, data: await this.sites.create(actor, { ...dto, businessId }) };
  }

  @Patch(':id')
  @RequireCapability(CAP.COMPUTERS_EDIT)
  async update(@Actor() actor: ActorContext, @Param('id') id: string, @Body() dto: UpdateSiteDto) {
    return { success: true, data: await this.sites.update(actor, id, dto) };
  }

  @Delete(':id')
  @RequireCapability(CAP.COMPUTERS_REMOVE)
  async remove(@Actor() actor: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.sites.delete(actor, id) };
  }
}

// Flat route for cross-business listing (Platform Admin) and direct lookups.
@Controller('sites')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class SitesController {
  constructor(private readonly sites: SitesService) {}

  @Get()
  @RequireCapability(CAP.COMPUTERS_VIEW)
  async list(@Actor() actor: ActorContext, @Query('businessId') businessId?: string) {
    return { success: true, data: await this.sites.findAll(actor, businessId) };
  }

  @Get(':id')
  @RequireCapability(CAP.COMPUTERS_VIEW)
  async get(@Actor() actor: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.sites.findOne(actor, id) };
  }

  @Patch(':id')
  @RequireCapability(CAP.COMPUTERS_EDIT)
  async update(@Actor() actor: ActorContext, @Param('id') id: string, @Body() dto: UpdateSiteDto) {
    return { success: true, data: await this.sites.update(actor, id, dto) };
  }

  @Delete(':id')
  @RequireCapability(CAP.COMPUTERS_REMOVE)
  async remove(@Actor() actor: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.sites.delete(actor, id) };
  }
}
