import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { ArrayMaxSize, IsArray, IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { OffboardingService } from './offboarding.service';
import { AccessReviewService } from './access-review.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CapabilitiesGuard } from '../common/guards/capabilities.guard';
import { RequireCapability } from '../common/decorators/require-capability.decorator';
import { Actor } from '../common/decorators/actor.decorator';
import { StepUpService } from '../auth/step-up.service';
import type { ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';

export class OffboardDto {
  @IsString() @MaxLength(64) userId!: string;
  @IsOptional() @IsString() @MaxLength(64) businessId?: string;
  @IsOptional() @IsBoolean() suspendAccount?: boolean;
  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsString({ each: true }) rotateEndpointIds?: string[];
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

@Controller()
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class OffboardingController {
  constructor(
    private readonly svc: OffboardingService,
    private readonly review: AccessReviewService,
    private readonly stepUp: StepUpService,
  ) {}

  /** Who can reach this computer, and why. */
  @Get('endpoints/:id/access-review')
  @RequireCapability(CAP.COMPUTERS_VIEW)
  async accessReview(@Actor() actor: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.review.review(actor, id) };
  }

  @Get('offboarding/preview')
  async preview(@Actor() actor: ActorContext, @Query('userId') userId: string, @Query('businessId') businessId?: string) {
    return { success: true, data: await this.svc.preview(actor, userId, businessId || undefined) };
  }

  @Get('offboarding/pending-rotations')
  @RequireCapability(CAP.COMPUTERS_VIEW)
  async pendingRotations(@Actor() actor: ActorContext, @Query('businessId') businessId?: string) {
    return { success: true, data: await this.svc.unresolvedRotations(actor, businessId) };
  }

  @Get('offboarding')
  async list(@Actor() actor: ActorContext, @Query('businessId') businessId?: string) {
    return { success: true, data: await this.svc.list(actor, businessId) };
  }

  @Get('offboarding/:id')
  async get(@Actor() actor: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.svc.get(actor, id) };
  }

  @Post('offboarding')
  @HttpCode(HttpStatus.OK)
  async execute(@Actor() actor: ActorContext, @Body() dto: OffboardDto, @Req() req: Request) {
    // Authorization first (403/404), then a fresh re-authentication.
    await this.svc.authorize(actor, dto.userId, dto.businessId);
    await this.stepUp.assert(req, 'permissions.change');
    return { success: true, data: await this.svc.execute(actor, dto) };
  }
}
