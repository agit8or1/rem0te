import { Body, Controller, Delete, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { IsArray, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { ApiKeysService } from './apikeys.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { Actor } from '../common/decorators/actor.decorator';
import type { ActorContext } from '../rbac/access-control.service';
import { StepUpService } from '../auth/step-up.service';

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
  constructor(private readonly svc: ApiKeysService, private readonly stepUp: StepUpService) {}

  @Get()
  @RequirePermissions('api_keys:read')
  async list(@Actor() actor: ActorContext, @Query('businessId') businessId?: string) {
    return { success: true, data: await this.svc.list(actor, businessId) };
  }

  @Post()
  @RequirePermissions('api_keys:write')
  async create(@Actor() actor: ActorContext, @Body() dto: CreateApiKeyDto, @Req() req: Request) {
    // A key with enrollment:write needs a fresh re-authentication (0.33).
    const u = req.user as { sub?: string; iat?: number } | undefined;
    const freshMethod = u?.sub ? this.stepUp.read(req, u.sub, u.iat)?.method ?? null : null;
    return { success: true, data: await this.svc.create(actor, dto, freshMethod) };
  }

  @Delete(':id')
  @RequirePermissions('api_keys:write')
  async revoke(@Actor() actor: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.svc.revoke(actor, id) };
  }
}
