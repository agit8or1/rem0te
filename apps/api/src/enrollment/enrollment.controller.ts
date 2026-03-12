import {
  Controller, Get, Post, Delete, Param, Body, Req,
  UseGuards, HttpCode, HttpStatus, OnModuleInit, OnModuleDestroy, Logger,
} from '@nestjs/common';
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
      this.enrollment.markStaleEndpointsOffline(10).catch((e) =>
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
  @HttpCode(HttpStatus.OK)
  async claimEndpoint(@Body() dto: ClaimEndpointDto, @Req() req: Request) {
    const ip = req.ip ?? req.socket?.remoteAddress;
    const result = await this.enrollment.claimEndpoint(dto, ip);
    return { success: true, data: result };
  }

  // Public endpoint — called periodically by the agent to indicate online status
  @Post('heartbeat')
  @Public()
  @HttpCode(HttpStatus.OK)
  async heartbeat(@Body() dto: HeartbeatDto, @Req() req: Request) {
    const ip = req.ip ?? req.socket?.remoteAddress;
    const result = await this.enrollment.heartbeat({ ...dto, ipAddress: dto.ipAddress ?? ip });
    return { success: true, data: result };
  }

}
