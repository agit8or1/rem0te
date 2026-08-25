import {
  Controller, Get, Post, Patch, Param, Body, Query,
  UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import { SessionStatus } from '@prisma/client';
import { SessionsService } from './sessions.service';
import { CreateSessionDto, CompleteSessionDto, SessionEventDto } from './dto/create-session.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CapabilitiesGuard } from '../common/guards/capabilities.guard';
import { RequireCapability } from '../common/decorators/require-capability.decorator';
import { Actor } from '../common/decorators/actor.decorator';
import type { ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';

@Controller('sessions')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Get()
  @RequireCapability(CAP.SESSIONS_VIEW)
  async findAll(
    @Actor() actor: ActorContext,
    @Query('status') status?: string,
    @Query('technicianId') technicianId?: string,
    @Query('endpointId') endpointId?: string,
    @Query('businessId') businessId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const result = await this.sessions.findAll(actor, {
      status: status as SessionStatus | undefined,
      technicianId,
      endpointId,
      businessId,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 50,
    });
    return { success: true, data: result };
  }

  @Get('stats')
  @RequireCapability(CAP.SESSIONS_VIEW)
  async getStats(
    @Actor() actor: ActorContext,
    @Query('days') days?: string,
    @Query('businessId') businessId?: string,
  ) {
    const result = await this.sessions.getStats(actor, days ? parseInt(days, 10) : 30, businessId);
    return { success: true, data: result };
  }

  @Get(':id')
  @RequireCapability(CAP.SESSIONS_VIEW)
  async findOne(@Actor() actor: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.sessions.findOne(actor, id) };
  }

  @Post()
  @RequireCapability(CAP.COMPUTERS_CONNECT)
  async create(@Actor() actor: ActorContext, @Body() dto: CreateSessionDto) {
    return { success: true, data: await this.sessions.create(actor, dto) };
  }

  @Patch(':id/complete')
  @RequireCapability(CAP.COMPUTERS_CONNECT)
  async complete(
    @Actor() actor: ActorContext,
    @Param('id') id: string,
    @Body() dto: CompleteSessionDto,
  ) {
    return { success: true, data: await this.sessions.complete(actor, id, dto) };
  }

  @Patch(':id/cancel')
  @RequireCapability(CAP.COMPUTERS_CONNECT)
  @HttpCode(HttpStatus.OK)
  async cancel(@Actor() actor: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.sessions.cancel(actor, id) };
  }

  @Post(':id/events')
  @RequireCapability(CAP.COMPUTERS_CONNECT)
  @HttpCode(HttpStatus.OK)
  async addEvent(
    @Actor() actor: ActorContext,
    @Param('id') id: string,
    @Body() dto: SessionEventDto,
  ) {
    return { success: true, data: await this.sessions.addEvent(actor, id, dto) };
  }
}
