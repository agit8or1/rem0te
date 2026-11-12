import { Body, Controller, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { IsString, Length, Matches } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CapabilitiesGuard } from '../common/guards/capabilities.guard';
import { PlatformAdminGuard } from '../common/guards/platform-admin.guard';
import { RequireCapability } from '../common/decorators/require-capability.decorator';
import { Actor } from '../common/decorators/actor.decorator';
import { RateLimit } from '../common/throttling';
import type { ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';
import { DiagnosticsCatalogService } from './diagnostics-catalog.service';

/** A catalog key and nothing else. The service refuses keys not in the catalog. */
export class RequestDiagnosticDto {
  @IsString()
  @Length(1, 64)
  @Matches(/^[a-z][a-z0-9_]{0,63}$/, { message: 'key must be a catalog key' })
  key!: string;
}

/**
 * One-click read-only diagnostics (0.31). `computers:view` is the floor for
 * every route; each run additionally needs its catalog entry's capability
 * (recent_system_errors needs `computers:event_logs`), checked in the service.
 */
@Controller('endpoints/:id/diagnostics')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class DiagnosticsCatalogController {
  constructor(private readonly svc: DiagnosticsCatalogService) {}

  @Get('catalog')
  @RequireCapability(CAP.COMPUTERS_VIEW)
  async catalog(@Actor() actor: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.svc.catalogFor(actor, id) };
  }

  @Post('runs')
  @RequireCapability(CAP.COMPUTERS_VIEW)
  @RateLimit(30)
  async run(@Actor() actor: ActorContext, @Param('id') id: string, @Body() dto: RequestDiagnosticDto) {
    return { success: true, data: await this.svc.request(actor, id, dto.key) };
  }

  @Get('runs')
  @RequireCapability(CAP.COMPUTERS_VIEW)
  async history(@Actor() actor: ActorContext, @Param('id') id: string, @Query('limit') limit?: string) {
    return { success: true, data: await this.svc.history(actor, id, Number(limit) || 20) };
  }

  /** 0.33: the Processes, Services and Network tabs. Refresh is a POST to runs. */
  @Get('snapshots/:key')
  @RequireCapability(CAP.COMPUTERS_VIEW)
  async snapshot(@Actor() actor: ActorContext, @Param('id') id: string, @Param('key') key: string) {
    return { success: true, data: await this.svc.snapshot(actor, id, key) };
  }

  @Get('runs/:runId')
  @RequireCapability(CAP.COMPUTERS_VIEW)
  async one(@Actor() actor: ActorContext, @Param('id') id: string, @Param('runId') runId: string) {
    return { success: true, data: await this.svc.getRun(actor, id, runId) };
  }
}

/**
 * Settings → Monitoring & API → Automatic snapshots (0.35): how often the
 * server asks checking-in computers for their process list, service list and
 * network adapters. Platform Admin only — the guard before anything is read,
 * and the service checks again — because the schedule is platform-wide.
 * Every change is audited (SNAPSHOT_SCHEDULE_CHANGED, before and after).
 * There is no route that makes a computer collect now: that is Refresh, a
 * POST to /endpoints/:id/diagnostics/runs under the person's own access.
 */
@Controller('admin/snapshot-schedule')
@UseGuards(PlatformAdminGuard)
export class SnapshotScheduleController {
  constructor(private readonly svc: DiagnosticsCatalogService) {}

  @Get()
  async get(@Actor() actor: ActorContext) {
    return { success: true, data: await this.svc.getSchedule(actor) };
  }

  @Put()
  @RateLimit(20)
  async put(@Actor() actor: ActorContext, @Body() body: unknown) {
    return { success: true, data: await this.svc.updateSchedule(actor, body) };
  }
}
