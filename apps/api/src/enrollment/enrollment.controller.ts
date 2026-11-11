import {
  Controller, Get, Post, Delete, Param, Body, Query, Req,
  UseGuards, HttpCode, HttpStatus, OnModuleInit, OnModuleDestroy, Logger,
} from '@nestjs/common';
import { Request } from 'express';
import { EnrollmentService } from './enrollment.service';
import { CreateClaimTokenDto, ClaimEndpointDto, HeartbeatDto, CommandResultDto, MonitorReportDto, ConfirmRotationDto } from './dto/enrollment.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CapabilitiesGuard } from '../common/guards/capabilities.guard';
import { RequireCapability } from '../common/decorators/require-capability.decorator';
import { Public } from '../common/decorators/public.decorator';
import { Actor } from '../common/decorators/actor.decorator';
import type { ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';
import { RateLimit } from '../common/throttling';
import { DiagnosticResultDto } from '../diagnostics-catalog/diagnostic-result.dto';

@Controller('enrollment')
export class EnrollmentController implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EnrollmentController.name);
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly enrollment: EnrollmentService) {}

  onModuleInit() {
    // Every minute: hbbs presence is near real-time (30 s registration
    // window), and the heartbeat-staleness half is cheap.
    this.cleanupInterval = setInterval(() => {
      // Threshold is generous (30 min) because:
      //   * older installers that pre-date the Rem0teHeartbeat task ping
      //     only once at install time; we don't want to mark them offline
      //     just because they haven't been re-installed yet
      //   * new installers heartbeat every 3 min so a real 30-min silence
      //     is either a genuinely-offline machine or a broken heartbeat
      //     task worth investigating
      this.enrollment.markStaleEndpointsOffline(30).catch((e) =>
        this.logger.error('Stale endpoint cleanup failed', e),
      );
    }, 60 * 1000);
  }

  onModuleDestroy() {
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
  }

  @Get('tokens')
  @UseGuards(JwtAuthGuard, CapabilitiesGuard)
  @RequireCapability(CAP.COMPUTERS_VIEW)
  async listTokens(@Actor() actor: ActorContext, @Query('businessId') businessId?: string) {
    const tokens = await this.enrollment.listClaimTokens(actor, businessId);
    return { success: true, data: tokens };
  }

  @Post('tokens')
  @UseGuards(JwtAuthGuard, CapabilitiesGuard)
  @RequireCapability(CAP.COMPUTERS_ADD)
  async createToken(@Actor() actor: ActorContext, @Body() dto: CreateClaimTokenDto) {
    const token = await this.enrollment.createClaimToken(actor, dto);
    return { success: true, data: token };
  }

  // Add device, steps 4–5: has the device this token was made for enrolled,
  // and what has it reported so far? Polled by the page. Scoped by business
  // (token) and by endpoint visibility (device); see the service.
  @Get('tokens/:id/status')
  @UseGuards(JwtAuthGuard, CapabilitiesGuard)
  @RequireCapability(CAP.COMPUTERS_VIEW)
  async tokenStatus(@Actor() actor: ActorContext, @Param('id') id: string) {
    const data = await this.enrollment.claimTokenStatus(actor, id);
    return { success: true, data };
  }

  @Delete('tokens/:id')
  @UseGuards(JwtAuthGuard, CapabilitiesGuard)
  @RequireCapability(CAP.COMPUTERS_REMOVE)
  @HttpCode(HttpStatus.OK)
  async revokeToken(@Actor() actor: ActorContext, @Param('id') id: string) {
    const result = await this.enrollment.revokeClaimToken(actor, id);
    return { success: true, data: result };
  }

  // Public endpoint — called by the agent installer on the managed device
  @Post('claim')
  @Public()
  @RateLimit(10)
  @HttpCode(HttpStatus.OK)
  async claimEndpoint(@Body() dto: ClaimEndpointDto, @Req() req: Request) {
    const ip = req.ip ?? req.socket?.remoteAddress;
    const result = await this.enrollment.claimEndpoint(dto, ip);
    return { success: true, data: result };
  }

  // Public endpoint — called periodically by the agent to indicate online status
  @Post('heartbeat')
  @Public()
  @RateLimit(60)
  @HttpCode(HttpStatus.OK)
  async heartbeat(@Body() dto: HeartbeatDto, @Req() req: Request) {
    const ip = req.ip ?? req.socket?.remoteAddress;
    const result = await this.enrollment.heartbeat({ ...dto, ipAddress: dto.ipAddress ?? ip }, ip);
    return { success: true, data: result };
  }

  // Public endpoint — an endpoint reporting the result of a command it was
  // handed on a previous heartbeat. Rate limit is generous because two
  // commands may be collected per beat and each reports separately.
  @Post('command-result')
  @Public()
  @RateLimit(60)
  @HttpCode(HttpStatus.OK)
  async commandResult(@Body() dto: CommandResultDto) {
    const result = await this.enrollment.commandResult(dto);
    return { success: true, data: result };
  }

  // Public endpoint — the agent's monitor report (v0.29), sent after a
  // heartbeat whose response carried a `monitor` block. Device secret
  // required, like command-result.
  @Post('monitor-report')
  @Public()
  @RateLimit(30)
  @HttpCode(HttpStatus.OK)
  async monitorReport(@Body() dto: MonitorReportDto) {
    const result = await this.enrollment.monitorReport(dto);
    return { success: true, data: result };
  }

  // Public endpoint — the agent reporting on a diagnostic run (v0.31): once
  // when it starts, once with the result. Device secret required.
  @Post('diagnostic-result')
  @Public()
  @RateLimit(60)
  @HttpCode(HttpStatus.OK)
  async diagnosticResult(@Body() dto: DiagnosticResultDto) {
    const result = await this.enrollment.diagnosticResult(dto);
    return { success: true, data: result };
  }

  // Endpoint confirms it applied a rotation. Payload = { rustdeskId, sha256 }
  // where sha256 is SHA-256 of the plaintext the endpoint received back from
  // /heartbeat and applied via rustdesk.exe --password.
  @Post('confirm-rotation')
  @Public()
  @RateLimit(30)
  @HttpCode(HttpStatus.OK)
  async confirmRotation(@Body() body: ConfirmRotationDto) {
    const result = await this.enrollment.confirmRotation(body.rustdeskId, body.sha256, body.agentSecret);
    return { success: true, data: result };
  }
}
