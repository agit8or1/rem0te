import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { IsArray, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { ApiKeysService } from './apikeys.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/strategies/jwt.strategy';

class CreateApiKeyDto {
  @IsString() @Length(1, 128) name!: string;
  @IsArray() @IsString({ each: true }) scopes!: string[];
  @IsOptional() @IsInt() @Min(1) @Max(3650) expiresInDays?: number;
}

@Controller('apikeys')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ApiKeysController {
  constructor(private readonly svc: ApiKeysService) {}

  @Get()
  @RequirePermissions('api_keys:read')
  async list(@CurrentUser() u: JwtPayload) {
    if (!u.tenantId) return { success: false, data: [] };
    return { success: true, data: await this.svc.list(u.tenantId) };
  }

  @Post()
  @RequirePermissions('api_keys:write')
  async create(@CurrentUser() u: JwtPayload, @Body() dto: CreateApiKeyDto) {
    if (!u.tenantId) return { success: false, message: 'No tenant context' };
    return { success: true, data: await this.svc.create(u.tenantId, u.sub, dto) };
  }

  @Delete(':id')
  @RequirePermissions('api_keys:write')
  async revoke(@CurrentUser() u: JwtPayload, @Param('id') id: string) {
    if (!u.tenantId) return { success: false, message: 'No tenant context' };
    return { success: true, data: await this.svc.revoke(u.tenantId, id, u.sub) };
  }
}
