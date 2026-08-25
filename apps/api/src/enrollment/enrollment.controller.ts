import {
  Controller, Get, Post, Delete, Param, Body, Query, Req,
  UseGuards, HttpCode, HttpStatus, OnModuleInit, OnModuleDestroy, Logger,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { EnrollmentService } from './enrollment.service';
import { CreateClaimTokenDto, ClaimEndpointDto, HeartbeatDto } from './dto/enrollment.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CapabilitiesGuard } from '../common/guards/capabilities.guard';
import { RequireCapability } from '../common/decorators/require-capability.decorator';
import { Public } from '../common/decorators/public.decorator';
import { Actor } from '../common/decorators/actor.decorator';
import type { ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';

@Controller('enrollment')
export class EnrollmentController implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EnrollmentController.name);
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly enrollment: EnrollmentService) {}

  onModuleInit() {
    // Run every 5 minutes
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
    }, 5 * 60 * 1000);
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
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  async claimEndpoint(@Body() dto: ClaimEndpointDto, @Req() req: Request) {
    const ip = req.ip ?? req.socket?.remoteAddress;
    const result = await this.enrollment.claimEndpoint(dto, ip);
    return { success: true, data: result };
  }

  // Public endpoint — called periodically by the agent to indicate online status
  @Post('heartbeat')
  @Public()
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  async heartbeat(@Body() dto: HeartbeatDto, @Req() req: Request) {
    const ip = req.ip ?? req.socket?.remoteAddress;
    const result = await this.enrollment.heartbeat({ ...dto, ipAddress: dto.ipAddress ?? ip });
    return { success: true, data: result };
  }

  // Endpoint confirms it applied a rotation. Payload = { rustdeskId, sha256 }
  // where sha256 is SHA-256 of the plaintext the endpoint received back from
  // /heartbeat and applied via rustdesk.exe --password.
  @Post('confirm-rotation')
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  async confirmRotation(@Body() body: { rustdeskId: string; sha256: string }) {
    const result = await this.enrollment.confirmRotation(body.rustdeskId, body.sha256);
    return { success: true, data: result };
  }
}
