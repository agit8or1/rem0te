import {
  Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Put, Query, Req, UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { DeviceClass } from '@prisma/client';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Actor } from '../common/decorators/actor.decorator';
import type { ActorContext } from '../rbac/access-control.service';
import { AccessControlService } from '../rbac/access-control.service';
import { StepUpService } from '../auth/step-up.service';
import { AccessPolicyService } from './access-policy.service';
import { PolicyAdminService } from './policy-admin.service';
import { TemporaryAccessService } from './temporary-access.service';
import { TrustChangeService } from './trust-change.service';
import { assertFresh } from './review';
import { SECURITY_FEATURES } from './security-features';

class CloneDto { @IsString() @Length(1, 100) name!: string }
class PresetDto {
  @IsOptional() @IsString() @Length(1, 100) name?: string;
  @IsOptional() @IsString() @Length(0, 500) description?: string;
  // Structure validated by the PresetPolicy schema in PolicyAdminService.
  @IsObject() policy!: Record<string, unknown>;
}
class PreviewDto { @IsObject() policy!: Record<string, unknown> }
class DecisionDto { @IsIn(['APPROVE', 'DENY']) decision!: 'APPROVE' | 'DENY'; @IsOptional() @IsString() @Length(0, 500) note?: string }
class TemporaryDto {
  @IsString() @Length(1, 64) endpointId!: string;
  @IsIn(['CONTROL', 'ELEVATION', 'PROTECTED_EXCEPTION']) mode!: 'CONTROL' | 'ELEVATION' | 'PROTECTED_EXCEPTION';
  @IsString() @Length(3, 500) reason!: string;
  @IsInt() @Min(5) @Max(480) durationMinutes!: number;
}
class ExceptionDto {
  @IsString() @Length(3, 80) identity!: string;
  @IsArray() @ArrayMaxSize(200) @IsString({ each: true }) endpointIds!: string[];
  @IsArray() @ArrayMaxSize(3) @IsString({ each: true }) kinds!: string[];
  @IsString() @Length(3, 500) reason!: string;
  @IsString() expiresAt!: string;
}
class SuppressDto {
  @IsOptional() @IsString() @Length(3, 80) identity?: string;
  @IsString() @Length(1, 64) kind!: string;
  @IsString() @Length(3, 500) reason!: string;
  @IsString() until!: string;
}
class DeviceClassDto { @IsIn(Object.values(DeviceClass)) deviceClass!: DeviceClass }
class ManagedDto { @IsBoolean() managed!: boolean }

/**
 * Settings → Security → Technician Access, the Security Features catalog,
 * and the technician's own temporary-access requests.
 *
 * Every mutation needs fresh authentication (step-up), whatever step-up
 * actions the platform has enabled — these are the controls a stolen session
 * would go for first. Revoking, clearing a request and tightening are the
 * exceptions only where noted.
 */
@Controller('security-controls')
@UseGuards(JwtAuthGuard)
export class SecurityControlsController {
  constructor(
    private readonly policy: AccessPolicyService,
    private readonly admin: PolicyAdminService,
    private readonly temporary: TemporaryAccessService,
    private readonly trust: TrustChangeService,
    private readonly stepUp: StepUpService,
    private readonly acl: AccessControlService,
  ) {}

  private fresh(req: Request): string | null {
    const u = req.user as { sub?: string; iat?: number } | undefined;
    return u?.sub ? this.stepUp.read(req, u.sub, u.iat)?.method ?? null : null;
  }
  private requireFresh(req: Request) { assertFresh(this.fresh(req)); }

  @Get('catalog')
  catalog(@Actor() actor: ActorContext) {
    this.acl.assertPlatformAdmin(actor);
    return { success: true, data: SECURITY_FEATURES };
  }

  // ── Presets ───────────────────────────────────────────────────────────────

  @Get('presets')
  async presets(@Actor() actor: ActorContext) { return { success: true, data: await this.admin.listPresets(actor) }; }

  @Post('presets/:id/clone')
  async clone(@Actor() a: ActorContext, @Param('id') id: string, @Body() dto: CloneDto, @Req() req: Request) {
    this.requireFresh(req);
    return { success: true, data: await this.admin.clonePreset(a, id, dto.name) };
  }

  @Post('presets/:id/preview')
  @HttpCode(HttpStatus.OK)
  async preview(@Actor() a: ActorContext, @Param('id') id: string, @Body() dto: PreviewDto) {
    return { success: true, data: await this.admin.previewPreset(a, id, dto.policy) };
  }

  @Put('presets/:id')
  async updatePreset(@Actor() a: ActorContext, @Param('id') id: string, @Body() dto: PresetDto, @Req() req: Request) {
    this.requireFresh(req);
    return { success: true, data: await this.admin.updatePreset(a, id, dto) };
  }

  @Post('presets/:id/reset')
  @HttpCode(HttpStatus.OK)
  async reset(@Actor() a: ActorContext, @Param('id') id: string, @Req() req: Request) {
    this.requireFresh(req);
    return { success: true, data: await this.admin.resetPreset(a, id) };
  }

  @Delete('presets/:id')
  async deletePreset(@Actor() a: ActorContext, @Param('id') id: string, @Req() req: Request) {
    this.requireFresh(req);
    return { success: true, data: await this.admin.deletePreset(a, id) };
  }

  // ── Policy ────────────────────────────────────────────────────────────────

  @Get('policy')
  async getPolicy(@Actor() a: ActorContext, @Query('businessId') businessId?: string) {
    return { success: true, data: await this.admin.getPolicy(a, businessId) };
  }

  @Put('policy')
  async setPolicy(@Actor() a: ActorContext, @Body() body: unknown, @Req() req: Request) {
    this.requireFresh(req);
    return { success: true, data: await this.admin.setPlatformPolicy(a, body) };
  }

  /** Tighten-only by construction; still needs fresh auth. */
  @Put('policy/business/:businessId')
  async setBusinessPolicy(@Actor() a: ActorContext, @Param('businessId') id: string, @Body() body: unknown, @Req() req: Request) {
    this.requireFresh(req);
    return { success: true, data: await this.admin.setBusinessPolicy(a, id, body) };
  }

  @Get('inspect')
  async inspect(
    @Actor() a: ActorContext,
    @Query('userId') userId: string, @Query('businessId') businessId: string,
    @Query('action') action: string, @Query('endpointId') endpointId?: string,
  ) {
    this.acl.assertPlatformPermission(a, 'technicians:manage');
    if (!(AccessPolicyService.ACTIONS as readonly string[]).includes(action)) {
      return { success: false, error: `action must be one of ${AccessPolicyService.ACTIONS.join(', ')}` };
    }
    return { success: true, data: await this.policy.inspect(userId, businessId, endpointId || null, action as (typeof AccessPolicyService.ACTIONS)[number]) };
  }

  @Get('upgrade-preview')
  async upgradePreview(@Actor() a: ActorContext) {
    this.acl.assertPlatformPermission(a, 'technicians:manage');
    return { success: true, data: await this.policy.upgradePreview() };
  }

  // ── Trust changes ─────────────────────────────────────────────────────────

  @Get('trust-changes')
  async trustChanges(@Actor() a: ActorContext, @Query('status') status?: string) {
    this.acl.assertPlatformPermission(a, 'technicians:manage');
    return { success: true, data: await this.trust.list(status) };
  }

  @Post('trust-changes/:id/decision')
  @HttpCode(HttpStatus.OK)
  async decideTrust(@Actor() a: ActorContext, @Param('id') id: string, @Body() dto: DecisionDto, @Req() req: Request) {
    this.requireFresh(req);
    return { success: true, data: await this.trust.decide(a, id, dto.decision) };
  }

  // ── Temporary access ──────────────────────────────────────────────────────

  @Post('temporary-access')
  async requestTemporary(@Actor() a: ActorContext, @Body() dto: TemporaryDto) {
    return { success: true, data: await this.temporary.request(a, dto) };
  }

  @Get('temporary-access')
  async listTemporary(@Actor() a: ActorContext, @Query('status') status?: string, @Query('mine') mine?: string) {
    const reviewer = a.isPlatformAdmin || (a.platformPermissions ?? []).includes('approvals:review');
    return { success: true, data: await this.temporary.list({ status, userId: reviewer && mine !== 'true' ? undefined : a.userId }) };
  }

  @Post('temporary-access/:id/decision')
  @HttpCode(HttpStatus.OK)
  async decideTemporary(@Actor() a: ActorContext, @Param('id') id: string, @Body() dto: DecisionDto, @Req() req: Request) {
    this.requireFresh(req);
    return { success: true, data: await this.temporary.decide(a, id, dto.decision, dto.note) };
  }

  @Post('temporary-access/:id/activate')
  @HttpCode(HttpStatus.OK)
  async activate(@Actor() a: ActorContext, @Param('id') id: string, @Req() req: Request) {
    return { success: true, data: await this.temporary.activate(a, id, this.fresh(req)) };
  }

  /** Ending access never needs step-up. */
  @Post('temporary-access/:id/revoke')
  @HttpCode(HttpStatus.OK)
  async revokeTemporary(@Actor() a: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.temporary.revoke(a, id) };
  }

  // ── Device class, managed workstations ────────────────────────────────────

  @Patch('endpoints/:id/device-class')
  async deviceClass(@Actor() a: ActorContext, @Param('id') id: string, @Body() dto: DeviceClassDto, @Req() req: Request) {
    this.requireFresh(req);
    return { success: true, data: await this.admin.setDeviceClass(a, id, dto.deviceClass) };
  }

  @Patch('technician-devices/:id/managed')
  async managed(@Actor() a: ActorContext, @Param('id') id: string, @Body() dto: ManagedDto, @Req() req: Request) {
    this.requireFresh(req);
    return { success: true, data: await this.admin.setManagedWorkstation(a, id, dto.managed) };
  }

  // ── Pauses, maintenance exceptions, alerts ────────────────────────────────

  @Get('pauses')
  async pauses(@Actor() a: ActorContext) { return { success: true, data: await this.admin.pauses(a) }; }

  @Post('pauses/:id/clear')
  @HttpCode(HttpStatus.OK)
  async clearPause(@Actor() a: ActorContext, @Param('id') id: string, @Req() req: Request) {
    this.requireFresh(req);
    return { success: true, data: await this.admin.clearPause(a, id) };
  }

  @Get('maintenance-exceptions')
  async exceptions(@Actor() a: ActorContext) { return { success: true, data: await this.admin.exceptions(a) }; }

  @Post('maintenance-exceptions')
  async requestException(@Actor() a: ActorContext, @Body() dto: ExceptionDto, @Req() req: Request) {
    this.requireFresh(req);
    return { success: true, data: await this.admin.requestException(a, dto) };
  }

  @Post('maintenance-exceptions/:id/decision')
  @HttpCode(HttpStatus.OK)
  async decideException(@Actor() a: ActorContext, @Param('id') id: string, @Body() dto: DecisionDto, @Req() req: Request) {
    this.requireFresh(req);
    return { success: true, data: await this.admin.decideException(a, id, dto.decision) };
  }

  @Post('maintenance-exceptions/:id/revoke')
  @HttpCode(HttpStatus.OK)
  async revokeException(@Actor() a: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.admin.revokeException(a, id) };
  }

  @Get('alerts')
  async alerts(@Actor() a: ActorContext) { return { success: true, data: await this.admin.alerts(a) }; }

  @Post('alert-suppressions')
  async suppress(@Actor() a: ActorContext, @Body() dto: SuppressDto, @Req() req: Request) {
    this.requireFresh(req);
    return { success: true, data: await this.admin.suppress(a, dto) };
  }

  @Post('alert-suppressions/:id/revoke')
  @HttpCode(HttpStatus.OK)
  async unsuppress(@Actor() a: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.admin.unsuppress(a, id) };
  }
}
