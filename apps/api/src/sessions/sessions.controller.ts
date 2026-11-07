import {
  Controller, Get, Post, Patch, Param, Body, Query,
  UseGuards, HttpCode, HttpStatus, OnModuleInit, OnModuleDestroy, Logger,
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
import { Public } from '../common/decorators/public.decorator';
import { RateLimit } from '../common/throttling';
import { SessionEventsService } from './session-events.service';
import { IsIn, IsOptional, IsString, Length } from 'class-validator';

class SessionTelemetryDto {
  @IsString() @Length(48, 48) token!: string;
  @IsIn(['launcher_acknowledged', 'client_opened', 'client_launch_failed'])
  event!: 'launcher_acknowledged' | 'client_opened' | 'client_launch_failed';
  @IsOptional() @IsString() @Length(0, 200) detail?: string;
}

@Controller('sessions')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class SessionsController implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SessionsController.name);
  private expiryInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly sessions: SessionsService,
    private readonly events: SessionEventsService,
  ) {}

  onModuleInit() {
    // Sweep every 5 minutes. 30 min is generous: a technician who clicks
    // Connect and is still fighting with the client half an hour later has
    // bigger problems than a mislabelled session row, and nothing that has
    // actually opened a client is touched (see expireStaleSessions).
    this.expiryInterval = setInterval(() => {
      this.sessions
        .expireStaleSessions(30)
        .then((n) => {
          if (n > 0) this.logger.log(`Expired ${n} session(s) that never opened a client`);
        })
        .catch((e) => this.logger.error('Stale session cleanup failed', e));

      // And the other half: sessions that DID open a client. Nothing tells us
      // when a RustDesk session ends, so without this they stay live forever
      // and every Connect ever clicked is counted as an active session.
      this.sessions
        .closeAbandonedSessions(12)
        .then((n) => {
          if (n > 0) this.logger.log(`Closed ${n} session(s) with no end signal`);
        })
        .catch((e) => this.logger.error('Abandoned session cleanup failed', e));
    }, 5 * 60 * 1000);
  }

  onModuleDestroy() {
    if (this.expiryInterval) clearInterval(this.expiryInterval);
  }

  /**
   * Telemetry from a Connect script on the technician's computer.
   *
   * Public, because the script has no session cookie; authenticated by the
   * per-session token embedded in that script, which names exactly one
   * session. Reports only what that script can see: it started, and whether
   * RustDesk started. It cannot report a connection — see session-state.ts.
   */
  @Post('telemetry')
  @Public()
  @HttpCode(HttpStatus.OK)
  @RateLimit(30)
  async telemetry(@Body() dto: SessionTelemetryDto) {
    return { success: true, data: await this.events.recordScriptTelemetry(dto.token, dto.event, dto.detail) };
  }

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
