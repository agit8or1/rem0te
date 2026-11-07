import {
  Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, Req, UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { IsBoolean, IsInt, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { SupportRequestsService } from './support-requests.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CapabilitiesGuard } from '../common/guards/capabilities.guard';
import { RequireCapability } from '../common/decorators/require-capability.decorator';
import { Actor } from '../common/decorators/actor.decorator';
import { Public } from '../common/decorators/public.decorator';
import { RateLimit } from '../common/throttling';
import type { ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';

export class IntakeDto {
  @IsBoolean() enabled!: boolean;
  @IsOptional() @IsBoolean() regenerate?: boolean;
}
export class VersionDto {
  @IsInt() @Min(0) version!: number;
}
export class HandoffDto extends VersionDto {
  @IsString() toUserId!: string;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}
export class CloseDto extends VersionDto {
  @IsOptional() @IsString() @MaxLength(300) outcome?: string;
}
export class PortalRequestDto {
  @IsString() @MaxLength(2000) description!: string;
  @IsOptional() @IsString() endpointId?: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
}
export class PublicRequestDto {
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MaxLength(254) email?: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsString() @MaxLength(20) rustdeskId?: string;
  @IsOptional() @IsString() @MaxLength(200) website?: string;
  @IsOptional() @IsNumber() elapsedMs?: number;
}

@Controller('support-requests')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class SupportRequestsController {
  constructor(private readonly svc: SupportRequestsService) {}

  @Get('intake')
  async getIntake(@Actor() actor: ActorContext, @Query('businessId') businessId?: string) {
    return { success: true, data: await this.svc.getIntake(actor, businessId) };
  }

  @Patch('intake')
  async setIntake(@Actor() actor: ActorContext, @Body() dto: IntakeDto, @Query('businessId') businessId?: string) {
    return { success: true, data: await this.svc.setIntake(actor, businessId, dto.enabled, dto.regenerate === true) };
  }

  /** A signed-in business user asking for help (no capability needed). */
  @Post()
  @RateLimit(10)
  async submit(@Actor() actor: ActorContext, @Body() dto: PortalRequestDto) {
    return { success: true, data: await this.svc.portalSubmit(actor, dto) };
  }

  @Get()
  @RequireCapability(CAP.SUPPORT_REQUESTS)
  async list(
    @Actor() actor: ActorContext,
    @Query('businessId') businessId?: string, @Query('status') status?: string, @Query('mine') mine?: string,
  ) {
    return { success: true, data: await this.svc.list(actor, { businessId, status, mine: mine === '1' || mine === 'true' }) };
  }

  @Get(':id')
  @RequireCapability(CAP.SUPPORT_REQUESTS)
  async detail(@Actor() actor: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.svc.detail(actor, id) };
  }

  @Get(':id/handoff-candidates')
  @RequireCapability(CAP.SUPPORT_REQUESTS)
  async candidates(@Actor() actor: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.svc.handoffCandidates(actor, id) };
  }

  @Post(':id/claim')
  @RequireCapability(CAP.SUPPORT_REQUESTS)
  @HttpCode(HttpStatus.OK)
  async claim(@Actor() actor: ActorContext, @Param('id') id: string, @Body() dto: VersionDto) {
    return { success: true, data: await this.svc.claim(actor, id, dto.version) };
  }

  @Post(':id/handoff')
  @RequireCapability(CAP.SUPPORT_REQUESTS)
  @HttpCode(HttpStatus.OK)
  async handoff(@Actor() actor: ActorContext, @Param('id') id: string, @Body() dto: HandoffDto) {
    return { success: true, data: await this.svc.handoff(actor, id, dto.toUserId, dto.version, dto.note) };
  }

  @Post(':id/release')
  @RequireCapability(CAP.SUPPORT_REQUESTS)
  @HttpCode(HttpStatus.OK)
  async release(@Actor() actor: ActorContext, @Param('id') id: string, @Body() dto: VersionDto) {
    return { success: true, data: await this.svc.release(actor, id, dto.version) };
  }

  @Post(':id/complete')
  @RequireCapability(CAP.SUPPORT_REQUESTS)
  @HttpCode(HttpStatus.OK)
  async complete(@Actor() actor: ActorContext, @Param('id') id: string, @Body() dto: CloseDto) {
    return { success: true, data: await this.svc.close(actor, id, 'COMPLETED', dto.version, dto.outcome) };
  }

  @Post(':id/cancel')
  @RequireCapability(CAP.SUPPORT_REQUESTS)
  @HttpCode(HttpStatus.OK)
  async cancel(@Actor() actor: ActorContext, @Param('id') id: string, @Body() dto: CloseDto) {
    return { success: true, data: await this.svc.close(actor, id, 'CANCELED', dto.version, dto.outcome) };
  }
}

/**
 * The customer side. Unauthenticated, so: the business comes from the slug
 * alone, every route is rate-limited, and nothing returned names a computer,
 * an email address or another request.
 */
@Controller('public/support')
export class PublicSupportController {
  constructor(private readonly svc: SupportRequestsService) {}

  @Get('intake/:slug')
  @Public()
  @RateLimit(30)
  async intake(@Param('slug') slug: string) {
    return { success: true, data: await this.svc.publicIntake(slug) };
  }

  @Post('intake/:slug')
  @Public()
  @RateLimit(5)
  async submit(@Param('slug') slug: string, @Body() dto: PublicRequestDto, @Req() req: Request) {
    return { success: true, data: await this.svc.publicSubmit(slug, dto, req.ip) };
  }

  @Get('status/:token')
  @Public()
  @RateLimit(30)
  async status(@Param('token') token: string) {
    return { success: true, data: await this.svc.publicStatus(token) };
  }

  @Post('status/:token/cancel')
  @Public()
  @RateLimit(5)
  @HttpCode(HttpStatus.OK)
  async cancel(@Param('token') token: string, @Req() req: Request) {
    return { success: true, data: await this.svc.publicCancel(token, req.ip) };
  }
}
