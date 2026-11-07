import {
  Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, UseGuards,
} from '@nestjs/common';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Length, Matches, Max, Min,
} from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PlatformAdminGuard } from '../common/guards/platform-admin.guard';
import { Actor } from '../common/decorators/actor.decorator';
import type { ActorContext } from '../rbac/access-control.service';
import { UpdateRolloutService } from './update-rollout.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { latestRustdeskVersion } from '../common/rustdesk-release';

class RolloutDto {
  @IsString() @Length(1, 120) name!: string;
  @IsIn(['RUSTDESK', 'AGENT']) component!: 'RUSTDESK' | 'AGENT';
  @IsString() @Matches(/^\d+\.\d+\.\d+$/) targetVersion!: string;
  @IsOptional() @IsArray() @ArrayMaxSize(5000) @IsString({ each: true }) endpointIds?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsString({ each: true }) businessIds?: string[];
  @IsOptional() @IsString() pilotGroupId?: string | null;
  @IsOptional() @IsInt() @Min(1) @Max(500) batchSize?: number;
  @IsOptional() @IsInt() @Min(0) @Max(1000) failureThreshold?: number;
  @IsOptional() @IsInt() @Min(1) @Max(10) maxAttempts?: number;
  @IsOptional() @IsInt() @Min(5) @Max(1440) backoffMinutes?: number;
  @IsOptional() @IsInt() @Min(15) @Max(1440) verifyTimeoutMinutes?: number;
  @IsOptional() maintenanceWindow?: unknown;
  @IsOptional() @IsBoolean() deferOnUnknownSession?: boolean;
  @IsOptional() @IsBoolean() allowSignatureOnly?: boolean;
}

class PilotGroupDto {
  @IsOptional() @IsString() id?: string;
  @IsString() @Length(1, 100) name!: string;
  @IsOptional() @IsString() @Length(0, 500) description?: string;
  @IsArray() @ArrayMaxSize(500) @IsString({ each: true }) endpointIds!: string[];
}

class PinDto {
  // null clears the pin (installers go back to the latest release).
  @IsOptional() @IsString() @Matches(/^\d+\.\d+\.\d+$/) version?: string | null;
}

/**
 * Staged endpoint updates. Platform Admin only, like every other endpoint
 * update control. Server components (hbbs/hbbr, Rem0te itself) are NOT
 * scheduled here — they have their own routes under admin/update and are
 * updated on the server, not by rolling out to endpoints.
 */
@Controller('admin/rollouts')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
export class RolloutsController {
  constructor(
    private readonly rollouts: UpdateRolloutService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async list() {
    return { success: true, data: await this.rollouts.list() };
  }

  @Post()
  async create(@Actor() actor: ActorContext, @Body() dto: RolloutDto) {
    return { success: true, data: await this.rollouts.create(actor, dto) };
  }

  @Get('pilot-groups')
  async pilotGroups() {
    return { success: true, data: await this.rollouts.listPilotGroups() };
  }

  @Post('pilot-groups')
  async savePilotGroup(@Body() dto: PilotGroupDto) {
    return { success: true, data: await this.rollouts.savePilotGroup(dto) };
  }

  /** Supported-version pin for every installer, Connect script and Quick Connect download. */
  @Get('pin')
  async pin() {
    const s = await this.prisma.platformSettings.findUnique({ where: { id: 'singleton' }, select: { rustdeskPinnedVersion: true } });
    return { success: true, data: { pinnedVersion: s?.rustdeskPinnedVersion ?? null, latestVersion: await latestRustdeskVersion() } };
  }

  @Patch('pin')
  async setPin(@Actor() actor: ActorContext, @Body() dto: PinDto) {
    const version = dto.version ?? null;
    await this.prisma.platformSettings.upsert({
      where: { id: 'singleton' },
      update: { rustdeskPinnedVersion: version },
      create: { id: 'singleton', rustdeskPinnedVersion: version },
    });
    await this.audit.log({
      actorId: actor.userId, actorIp: actor.ip,
      action: 'PLATFORM_SETTINGS_UPDATED', resource: 'platform_settings', resourceId: 'singleton',
      meta: { rustdeskPinnedVersion: version },
    });
    return { success: true, data: { pinnedVersion: version } };
  }

  @Get('endpoints/:endpointId/history')
  async history(@Param('endpointId') endpointId: string) {
    return { success: true, data: await this.rollouts.history(endpointId) };
  }

  @Post('jobs/:jobId/cancel')
  @HttpCode(HttpStatus.OK)
  async cancelJob(@Actor() actor: ActorContext, @Param('jobId') jobId: string) {
    return { success: true, data: await this.rollouts.cancelJob(actor, jobId) };
  }

  @Get(':id')
  async detail(@Param('id') id: string) {
    return { success: true, data: await this.rollouts.detail(id) };
  }

  @Post(':id/start')
  @HttpCode(HttpStatus.OK)
  async start(@Actor() actor: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.rollouts.start(actor, id) };
  }

  @Post(':id/pause')
  @HttpCode(HttpStatus.OK)
  async pause(@Actor() actor: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.rollouts.pause(actor, id, 'Paused by operator') };
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  async cancel(@Actor() actor: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.rollouts.cancel(actor, id) };
  }
}
