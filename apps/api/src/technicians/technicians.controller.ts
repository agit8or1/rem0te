import {
  Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, Req, UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, Length,
} from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Actor } from '../common/decorators/actor.decorator';
import type { ActorContext } from '../rbac/access-control.service';
import { StepUpService } from '../auth/step-up.service';
import { TechniciansService } from './technicians.service';
import { CAPABILITY_GROUPS, TECHNICIAN_ASSIGNABLE_CAPABILITIES } from '../rbac/capabilities';
import { PLATFORM_PERMISSION_LABELS } from '../rbac/platform-permissions';

class AssignmentDto {
  @IsOptional() @IsString() @Length(1, 64) userId?: string;
  @IsOptional() @IsString() @Length(1, 64) groupId?: string;
  @IsString() @Length(1, 64) businessId!: string;
  @IsOptional() @IsArray() @ArrayMaxSize(32) @IsString({ each: true }) capabilities?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsString({ each: true }) endpointIds?: string[];
  @IsOptional() @IsString() startsAt?: string | null;
  @IsOptional() @IsString() expiresAt?: string | null;
  // Validated structurally by parseSchedule().
  @IsOptional() schedule?: unknown;
  @IsOptional() @IsString() @Length(0, 500) reason?: string;
  @IsOptional() @IsString() @Length(1, 64) presetId?: string;
}

class AccessRequestDto {
  @IsString() @Length(1, 64) businessId!: string;
  @IsOptional() @IsArray() @ArrayMaxSize(32) @IsString({ each: true }) capabilities?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsString({ each: true }) endpointIds?: string[];
  @IsOptional() @IsString() startsAt?: string | null;
  @IsString() expiresAt!: string;
  @IsOptional() schedule?: unknown;
  @IsString() @Length(3, 500) reason!: string;
}

class DecisionDto {
  @IsIn(['APPROVE', 'DENY']) decision!: 'APPROVE' | 'DENY';
  @IsOptional() @IsString() @Length(0, 500) note?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(32) @IsString({ each: true }) capabilities?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsString({ each: true }) endpointIds?: string[];
  @IsOptional() @IsString() expiresAt?: string | null;
}

class RevokeDto {
  @IsOptional() @IsString() @Length(0, 500) reason?: string;
}

class GroupDto {
  @IsString() @Length(1, 100) name!: string;
  @IsOptional() @IsString() @Length(0, 500) description?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(32) @IsString({ each: true }) capabilities?: string[];
}

class GroupUpdateDto {
  @IsOptional() @IsString() @Length(1, 100) name?: string;
  @IsOptional() @IsString() @Length(0, 500) description?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(32) @IsString({ each: true }) capabilities?: string[];
}

class MemberDto {
  @IsString() @Length(1, 64) userId!: string;
}

class PlatformPermsDto {
  @IsArray() @ArrayMaxSize(8) @IsString({ each: true }) permissions!: string[];
}

class ApprovalRequiredDto {
  @IsBoolean() required!: boolean;
}

@Controller('technicians')
@UseGuards(JwtAuthGuard)
export class TechniciansController {
  constructor(
    private readonly svc: TechniciansService,
    private readonly stepUp: StepUpService,
  ) {}

  /** Capability vocabulary an assignment may use — drives the UI checkboxes. */
  @Get('vocabulary')
  vocabulary() {
    const allowed = new Set<string>(TECHNICIAN_ASSIGNABLE_CAPABILITIES);
    return {
      success: true,
      data: {
        capabilityGroups: CAPABILITY_GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => allowed.has(i.key)) }))
          .filter((g) => g.items.length > 0),
        platformPermissions: PLATFORM_PERMISSION_LABELS,
      },
    };
  }

  // ── Self ─────────────────────────────────────────────────────────────────

  @Get('me')
  async mine(@Actor() actor: ActorContext) {
    return { success: true, data: await this.svc.mine(actor) };
  }

  @Get('overview')
  async overview(@Actor() actor: ActorContext) {
    return { success: true, data: await this.svc.overview(actor) };
  }

  @Post('access-requests')
  async requestAccess(@Actor() actor: ActorContext, @Body() dto: AccessRequestDto) {
    return { success: true, data: await this.svc.requestAccess(actor, dto) };
  }

  // ── Approvals (Business Owner of the business, or Platform Admin) ─────────

  @Get('approvals')
  async approvals(@Actor() actor: ActorContext) {
    return { success: true, data: await this.svc.pendingApprovals(actor) };
  }

  @Post('approvals/:id')
  @HttpCode(HttpStatus.OK)
  async decide(@Actor() actor: ActorContext, @Param('id') id: string, @Body() dto: DecisionDto, @Req() req: Request) {
    await this.stepUp.assert(req, 'permissions.change');
    return { success: true, data: await this.svc.decide(actor, id, dto) };
  }

  @Patch('businesses/:businessId/approval-required')
  async setApprovalRequired(
    @Actor() actor: ActorContext, @Param('businessId') businessId: string, @Body() dto: ApprovalRequiredDto, @Req() req: Request,
  ) {
    await this.stepUp.assert(req, 'permissions.change');
    return { success: true, data: await this.svc.setApprovalRequired(actor, businessId, dto.required) };
  }

  // ── Management (technicians:manage) ───────────────────────────────────────

  @Get('people')
  async people(@Actor() actor: ActorContext) {
    return { success: true, data: await this.svc.listTechnicians(actor) };
  }

  @Get('people/:userId/effective')
  async effective(@Actor() actor: ActorContext, @Param('userId') userId: string) {
    return { success: true, data: await this.svc.effectiveFor(actor, userId) };
  }

  @Patch('people/:userId/platform-permissions')
  async setPlatformPermissions(
    @Actor() actor: ActorContext, @Param('userId') userId: string, @Body() dto: PlatformPermsDto, @Req() req: Request,
  ) {
    await this.stepUp.assert(req, 'technicians.manage');
    return { success: true, data: await this.svc.setPlatformPermissions(actor, userId, dto.permissions) };
  }

  @Get('assignments')
  async listAssignments(
    @Actor() actor: ActorContext,
    @Query('userId') userId?: string,
    @Query('groupId') groupId?: string,
    @Query('businessId') businessId?: string,
    @Query('includeRevoked') includeRevoked?: string,
  ) {
    return {
      success: true,
      data: await this.svc.listAssignments(actor, { userId, groupId, businessId, includeRevoked: includeRevoked === 'true' }),
    };
  }

  @Post('assignments')
  async createAssignment(@Actor() actor: ActorContext, @Body() dto: AssignmentDto, @Req() req: Request) {
    await this.stepUp.assert(req, 'technicians.manage');
    return { success: true, data: await this.svc.createAssignment(actor, dto) };
  }

  @Post('assignments/:id/revoke')
  @HttpCode(HttpStatus.OK)
  async revokeAssignment(@Actor() actor: ActorContext, @Param('id') id: string, @Body() dto: RevokeDto) {
    // Revocation never needs step-up: removing access must always be easy.
    return { success: true, data: await this.svc.revokeAssignment(actor, id, dto.reason) };
  }

  @Get('groups')
  async groups(@Actor() actor: ActorContext) {
    return { success: true, data: await this.svc.listGroups(actor) };
  }

  @Post('groups')
  async createGroup(@Actor() actor: ActorContext, @Body() dto: GroupDto, @Req() req: Request) {
    await this.stepUp.assert(req, 'technicians.manage');
    return { success: true, data: await this.svc.createGroup(actor, dto) };
  }

  @Patch('groups/:id')
  async updateGroup(@Actor() actor: ActorContext, @Param('id') id: string, @Body() dto: GroupUpdateDto, @Req() req: Request) {
    await this.stepUp.assert(req, 'technicians.manage');
    return { success: true, data: await this.svc.updateGroup(actor, id, dto) };
  }

  @Delete('groups/:id')
  async deleteGroup(@Actor() actor: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.svc.deleteGroup(actor, id) };
  }

  @Post('groups/:id/members')
  async addMember(@Actor() actor: ActorContext, @Param('id') id: string, @Body() dto: MemberDto, @Req() req: Request) {
    await this.stepUp.assert(req, 'technicians.manage');
    return { success: true, data: await this.svc.addMember(actor, id, dto.userId) };
  }

  @Delete('groups/:id/members/:userId')
  async removeMember(@Actor() actor: ActorContext, @Param('id') id: string, @Param('userId') userId: string) {
    return { success: true, data: await this.svc.removeMember(actor, id, userId) };
  }
}
