import {
  Controller, Get, Post, Patch, Param, Body, Query,
  UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import { SessionStatus } from '@prisma/client';
import { SessionsService } from './sessions.service';
import { CreateSessionDto, CompleteSessionDto, SessionEventDto } from './dto/create-session.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/strategies/jwt.strategy';

@Controller('sessions')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Get()
  @RequirePermissions('sessions:read')
  async findAll(
    @CurrentUser() user: JwtPayload,
    @Query('status') status?: string,
    @Query('technicianId') technicianId?: string,
    @Query('endpointId') endpointId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    if (!user.tenantId) return { success: false, message: 'No tenant context' };

    const result = await this.sessions.findAll(user.tenantId, {
      status: status as SessionStatus | undefined,
      technicianId,
      endpointId,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 50,
    });
    return { success: true, data: result };
  }

  @Get('stats')
  @RequirePermissions('sessions:read')
  async getStats(
    @CurrentUser() user: JwtPayload,
    @Query('days') days?: string,
  ) {
    if (!user.tenantId) return { success: false, message: 'No tenant context' };
    const result = await this.sessions.getStats(user.tenantId, days ? parseInt(days, 10) : 30);
    return { success: true, data: result };
  }

  @Get(':id')
  @RequirePermissions('sessions:read')
  async findOne(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    if (!user.tenantId) return { success: false, message: 'No tenant context' };
    const session = await this.sessions.findOne(user.tenantId, id);
    return { success: true, data: session };
  }

  @Post()
  @RequirePermissions('sessions:create')
  async create(@CurrentUser() user: JwtPayload, @Body() dto: CreateSessionDto) {
    if (!user.tenantId) return { success: false, message: 'No tenant context' };
    const session = await this.sessions.create(user.tenantId, user.sub, dto);
    return { success: true, data: session };
  }

  @Patch(':id/complete')
  @RequirePermissions('sessions:update')
  async complete(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: CompleteSessionDto,
  ) {
    if (!user.tenantId) return { success: false, message: 'No tenant context' };
    const session = await this.sessions.complete(user.tenantId, id, user.sub, dto);
    return { success: true, data: session };
  }

  @Patch(':id/cancel')
  @RequirePermissions('sessions:update')
  @HttpCode(HttpStatus.OK)
  async cancel(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    if (!user.tenantId) return { success: false, message: 'No tenant context' };
    const session = await this.sessions.cancel(user.tenantId, id, user.sub);
    return { success: true, data: session };
  }

  @Post(':id/events')
  @RequirePermissions('sessions:update')
  @HttpCode(HttpStatus.OK)
  async addEvent(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: SessionEventDto,
  ) {
    if (!user.tenantId) return { success: false, message: 'No tenant context' };
    const event = await this.sessions.addEvent(user.tenantId, id, dto);
    return { success: true, data: event };
  }
}
