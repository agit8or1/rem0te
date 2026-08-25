import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { IsBoolean, IsOptional } from 'class-validator';
import { AdminService } from './admin.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Actor } from '../common/decorators/actor.decorator';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { PlatformSettingsService } from '../platform/platform-settings.service';

class PlatformSettingsDto {
  @IsOptional() @IsBoolean() quickConnectEnabled?: boolean;
  @IsOptional() @IsBoolean() quickConnectWindows?: boolean;
  @IsOptional() @IsBoolean() quickConnectMacos?: boolean;
  @IsOptional() @IsBoolean() quickConnectLinux?: boolean;
}

/**
 * Platform-operator surface. Every route here asserts Platform Admin
 * explicitly — none of it is business-scoped, so there is no scope to fall
 * back on if the check were forgotten.
 */
@Controller('admin')
@UseGuards(JwtAuthGuard)
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly acl: AccessControlService,
    private readonly platformSettings: PlatformSettingsService,
  ) {}

  @Get('status')
  async getStatus(@Actor() actor: ActorContext) {
    this.acl.assertPlatformAdmin(actor);
    return { success: true, data: await this.adminService.getStatus(actor) };
  }

  // ── Platform settings ─────────────────────────────────────────────────────

  @Get('platform-settings')
  async getPlatformSettings(@Actor() actor: ActorContext) {
    this.acl.assertPlatformAdmin(actor);
    return { success: true, data: await this.platformSettings.get() };
  }

  @Patch('platform-settings')
  async updatePlatformSettings(@Actor() actor: ActorContext, @Body() dto: PlatformSettingsDto) {
    this.acl.assertPlatformAdmin(actor);
    return { success: true, data: await this.platformSettings.update(actor, dto) };
  }

  // ── Unassigned devices ────────────────────────────────────────────────────

  @Get('unassigned-devices')
  async listUnassigned(@Actor() actor: ActorContext) {
    this.acl.assertPlatformAdmin(actor);
    return { success: true, data: await this.adminService.getUnassignedDevices() };
  }

  /** Move an unassigned device into a business. */
  @Post('unassigned-devices/:id/assign')
  @HttpCode(HttpStatus.OK)
  async assignDevice(
    @Actor() actor: ActorContext,
    @Param('id') id: string,
    @Body('businessId') businessId: string,
  ) {
    this.acl.assertPlatformAdmin(actor);
    return { success: true, data: await this.adminService.assignDevice(actor, id, businessId) };
  }

  // ── Global search ─────────────────────────────────────────────────────────

  /**
   * Cross-cutting search. A Platform Admin searches everything; anyone else
   * gets results confined to their own business by the same scope rule as
   * every other read.
   */
  @Get('search')
  async search(@Actor() actor: ActorContext, @Query('q') q?: string) {
    return { success: true, data: await this.adminService.search(actor, q ?? '') };
  }
}
