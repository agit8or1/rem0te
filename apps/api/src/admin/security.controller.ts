import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { IsBoolean, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { SecurityService } from './security.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Actor } from '../common/decorators/actor.decorator';
import { RateLimit } from '../common/throttling';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { StepUpService } from '../auth/step-up.service';
import { assertFresh } from '../security-controls/review';

class LockoutDto {
  // 0 turns the lockout off (auth.service.ts recordLoginFailure).
  @IsOptional() @IsInt() @Min(0) @Max(100) maxLoginAttempts?: number;
  @IsOptional() @IsInt() @Min(1) @Max(1440) lockoutMinutes?: number;
  // Clears the stored GeoIP / IP rules that nothing ever enforced.
  @IsOptional() @IsBoolean() clearUnenforced?: boolean;
}
class AcceptFindingDto {
  // Checked again (trimmed, no control characters) by acceptance.ts cleanReason; 0093 CHECKs 3–300.
  @IsString() @MinLength(3) @MaxLength(300) reason!: string;
  // None by default; at most a year (0093 CHECK).
  @IsOptional() @IsInt() @Min(1) @Max(365) expiresInDays?: number;
  // The fingerprint the page read: a moved one is 409 EVIDENCE_CHANGED.
  @IsOptional() @IsString() @Matches(/^[0-9a-f]{64}$/) fingerprint?: string;
}
class AddressDto { @IsString() @MaxLength(64) ip!: string }
class JailAddressDto { @IsString() @MaxLength(64) jail!: string; @IsString() @MaxLength(64) ip!: string }
class JailConfigDto {
  // fail2ban's own units: seconds, and a count. The wrapper accepts 0–999999999.
  @IsOptional() @IsInt() @Min(60) @Max(31_536_000) bantime?: number;
  @IsOptional() @IsInt() @Min(60) @Max(604_800) findtime?: number;
  @IsOptional() @IsInt() @Min(1) @Max(100) maxretry?: number;
}

/**
 * Admin → Security (0.74). Platform Admin only, checked first on every
 * route. Reads never change the host. Every route that changes the host or
 * the lockout policy names its step-up key (§62: `server.security`,
 * `login.lockout`) and is audited in SecurityService. §84 holds this list.
 *
 * Removed in 0.74: `POST audit/fix` (`npm audit fix` in the deployed API's
 * node_modules, bypassing the generated manifest) and `POST tls/renew`
 * (re-posting Caddy's own config to its admin API, which Caddy ignores when
 * nothing changed, so the button never renewed anything).
 */
@Controller('admin/security')
@UseGuards(JwtAuthGuard)
export class SecurityController {
  constructor(
    private readonly security: SecurityService,
    private readonly acl: AccessControlService,
    private readonly stepUp: StepUpService,
  ) {}

  private fresh(req: Request): string | null {
    const u = req.user as { sub?: string; iat?: number } | undefined;
    return u?.sub ? this.stepUp.read(req, u.sub, u.iat)?.method ?? null : null;
  }

  private ok<T>(data: T) { return { success: true, data }; }

  // ── Overview ──────────────────────────────────────────────────────────────

  @Get('posture')
  @RateLimit(20)
  async posture(@Actor() a: ActorContext, @Query('refresh') refresh?: string) {
    this.acl.assertPlatformAdmin(a);
    return this.ok(await this.security.getPosture(refresh === '1'));
  }

  // ── Accepted risks (0.75.1) ───────────────────────────────────────────────
  // Accepting hides a warning, so it names server.security (§62) and is
  // recorded with logOrFail. Re-opening only shows a warning again and never
  // asks. The finding id is checked against acceptance.ts's closed list.

  @Get('findings/acceptances')
  async acceptances(@Actor() a: ActorContext) {
    this.acl.assertPlatformAdmin(a);
    return this.ok(await this.security.acceptanceHistory());
  }

  @Post('findings/:id/accept')
  @HttpCode(HttpStatus.OK)
  @RateLimit(20)
  async acceptFinding(@Actor() a: ActorContext, @Param('id') id: string, @Body() dto: AcceptFindingDto, @Req() req: Request) {
    this.acl.assertPlatformAdmin(a);
    assertFresh(this.fresh(req), { action: 'server.security' });
    return this.ok(await this.security.acceptFinding(a, id, dto));
  }

  @Delete('findings/:id/accept')
  @RateLimit(20)
  async unacceptFinding(@Actor() a: ActorContext, @Param('id') id: string) {
    this.acl.assertPlatformAdmin(a);
    return this.ok(await this.security.unacceptFinding(a, id));
  }

  // ── Access rules (the lockout policy) ─────────────────────────────────────

  @Get('config')
  async getConfig(@Actor() a: ActorContext) {
    this.acl.assertPlatformAdmin(a);
    return this.ok(await this.security.getConfig());
  }

  @Patch('config')
  async updateConfig(@Actor() a: ActorContext, @Body() dto: LockoutDto, @Req() req: Request) {
    this.acl.assertPlatformAdmin(a);
    return this.ok(await this.security.updateConfig(a, dto, (weakens) => {
      if (weakens) assertFresh(this.fresh(req), { action: 'login.lockout' });
    }));
  }

  // ── fail2ban ──────────────────────────────────────────────────────────────

  @Get('fail2ban')
  async getFail2ban(@Actor() a: ActorContext, @Query('refresh') refresh?: string) {
    this.acl.assertPlatformAdmin(a);
    return this.ok(await this.security.getFail2ban(refresh === '1'));
  }

  @Post('fail2ban/ban')
  @HttpCode(HttpStatus.OK)
  @RateLimit(30)
  async banIp(@Actor() a: ActorContext, @Body() dto: JailAddressDto, @Req() req: Request) {
    this.acl.assertPlatformAdmin(a);
    assertFresh(this.fresh(req), { action: 'server.security' });
    return this.ok(await this.security.banIp(a, dto.jail, dto.ip));
  }

  @Post('fail2ban/unban')
  @HttpCode(HttpStatus.OK)
  @RateLimit(30)
  async unbanIp(@Actor() a: ActorContext, @Body() dto: JailAddressDto, @Req() req: Request) {
    this.acl.assertPlatformAdmin(a);
    assertFresh(this.fresh(req), { action: 'server.security' });
    return this.ok(await this.security.unbanIp(a, dto.jail, dto.ip));
  }

  @Get('fail2ban/ignore')
  async getIgnoreList(@Actor() a: ActorContext) {
    this.acl.assertPlatformAdmin(a);
    return this.ok(await this.security.getIgnoreList());
  }

  @Post('fail2ban/ignore')
  @HttpCode(HttpStatus.OK)
  @RateLimit(30)
  async addIgnoreIp(@Actor() a: ActorContext, @Body() dto: AddressDto, @Req() req: Request) {
    this.acl.assertPlatformAdmin(a);
    assertFresh(this.fresh(req), { action: 'server.security' });
    return this.ok(await this.security.addIgnoreIp(a, dto.ip));
  }

  @Delete('fail2ban/ignore/:ip')
  @RateLimit(30)
  async removeIgnoreIp(@Actor() a: ActorContext, @Param('ip') ip: string, @Req() req: Request) {
    this.acl.assertPlatformAdmin(a);
    assertFresh(this.fresh(req), { action: 'server.security' });
    return this.ok(await this.security.removeIgnoreIp(a, ip));
  }

  @Get('fail2ban/jail/:jail/config')
  async getJailConfig(@Actor() a: ActorContext, @Param('jail') jail: string) {
    this.acl.assertPlatformAdmin(a);
    return this.ok(await this.security.getJailConfig(jail));
  }

  @Patch('fail2ban/jail/:jail/config')
  @RateLimit(20)
  async updateJailConfig(@Actor() a: ActorContext, @Param('jail') jail: string, @Body() dto: JailConfigDto, @Req() req: Request) {
    this.acl.assertPlatformAdmin(a);
    assertFresh(this.fresh(req), { action: 'server.security' });
    return this.ok(await this.security.updateJailConfig(a, jail, dto));
  }

  @Post('fail2ban/install')
  @HttpCode(HttpStatus.OK)
  @RateLimit(3)
  async installFail2ban(@Actor() a: ActorContext, @Req() req: Request) {
    this.acl.assertPlatformAdmin(a);
    assertFresh(this.fresh(req), { action: 'server.security' });
    return this.ok(await this.security.installFail2ban(a));
  }

  // ── OS updates ────────────────────────────────────────────────────────────

  @Get('os-updates')
  async getOsUpdates(@Actor() a: ActorContext, @Query('refresh') refresh?: string) {
    this.acl.assertPlatformAdmin(a);
    return this.ok(await this.security.getOsUpdates(refresh === '1'));
  }

  @Post('os-updates/run')
  @HttpCode(HttpStatus.OK)
  @RateLimit(3)
  async runOsUpdate(@Actor() a: ActorContext, @Req() req: Request) {
    this.acl.assertPlatformAdmin(a);
    assertFresh(this.fresh(req), { action: 'server.security' });
    return this.ok(await this.security.runOsUpdate(a));
  }

  @Get('os-updates/status')
  getOsUpdateStatus(@Actor() a: ActorContext) {
    this.acl.assertPlatformAdmin(a);
    return this.ok(this.security.getOsUpdateStatus());
  }

  // ── Dependencies and TLS (read only) ──────────────────────────────────────

  @Get('audit')
  @RateLimit(10)
  async dependencyAudit(@Actor() a: ActorContext, @Query('refresh') refresh?: string) {
    this.acl.assertPlatformAdmin(a);
    return this.ok(await this.security.getDependencyAudit(refresh === '1'));
  }

  @Get('tls')
  async getTls(@Actor() a: ActorContext, @Query('refresh') refresh?: string) {
    this.acl.assertPlatformAdmin(a);
    return this.ok(await this.security.getTls(refresh === '1'));
  }
}
