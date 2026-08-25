import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IsArray, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { ApiKeysService } from './apikeys.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { Actor } from '../common/decorators/actor.decorator';
import type { ActorContext } from '../rbac/access-control.service';

class CreateApiKeyDto {
  @IsString() @Length(1, 128) name!: string;
  @IsArray() @IsString({ each: true }) scopes!: string[];
  @IsOptional() @IsInt() @Min(1) @Max(3650) expiresInDays?: number;
  /** Platform Admin only — everyone else's key lands in their own business. */
  @IsOptional() @IsString() businessId?: string;
}

@Controller('apikeys')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ApiKeysController {
  constructor(private readonly svc: ApiKeysService) {}

  @Get()
  @RequirePermissions('api_keys:read')
  async list(@Actor() actor: ActorContext, @Query('businessId') businessId?: string) {
    return { success: true, data: await this.svc.list(actor, businessId) };
  }

  @Post()
  @RequirePermissions('api_keys:write')
  async create(@Actor() actor: ActorContext, @Body() dto: CreateApiKeyDto) {
    return { success: true, data: await this.svc.create(actor, dto) };
  }

  @Delete(':id')
  @RequirePermissions('api_keys:write')
  async revoke(@Actor() actor: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.svc.revoke(actor, id) };
  }
}
