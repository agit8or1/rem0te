import {
  Controller, Get, Post, Delete, Param, Body, Req,
  UseGuards, HttpCode, HttpStatus, OnModuleInit, OnModuleDestroy, Logger,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { EnrollmentService } from './enrollment.service';
import { CreateClaimTokenDto, ClaimEndpointDto, HeartbeatDto } from './dto/enrollment.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/strategies/jwt.strategy';

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
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions('endpoints:read')
  async listTokens(@CurrentUser() user: JwtPayload) {
    if (!user.tenantId) return { success: false, message: 'No tenant context' };
    const tokens = await this.enrollment.listClaimTokens(user.tenantId);
    return { success: true, data: tokens };
  }

  @Post('tokens')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions('endpoints:create')
  async createToken(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateClaimTokenDto,
    @Req() req: Request,
  ) {
    if (!user.tenantId) return { success: false, message: 'No tenant context' };
    const ip = req.ip ?? req.socket?.remoteAddress;
    const token = await this.enrollment.createClaimToken(user.tenantId, user.sub, dto, ip);
    return { success: true, data: token };
  }

  @Delete('tokens/:id')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions('endpoints:delete')
  @HttpCode(HttpStatus.OK)
  async revokeToken(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    if (!user.tenantId) return { success: false, message: 'No tenant context' };
    const result = await this.enrollment.revokeClaimToken(user.tenantId, id);
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
