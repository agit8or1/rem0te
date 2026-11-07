import { Body, ConflictException, Controller, Get, HttpCode, HttpStatus, Param, Post, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { IsBoolean, IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';
import { PublicUrlService } from './public-url.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { StepUpService } from '../auth/step-up.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { Actor } from '../common/decorators/actor.decorator';
import { Public } from '../common/decorators/public.decorator';
import { RateLimit } from '../common/throttling';

class SetAddressDto {
  // null clears the setting and falls back to FRONTEND_URL / PUBLIC_API_URL.
  @ValidateIf((_o, v) => v !== null) @IsString() @MaxLength(200) url!: string | null;
  // Save even though the check could not prove the address reaches this server
  // (DNS not switched yet, no hairpin NAT on the server's own network…).
  @IsOptional() @IsBoolean() saveUnverified?: boolean;
}
class CheckAddressDto {
  @IsString() @MaxLength(200) url!: string;
}

/** Settings → General → Public address. Platform Admin only. */
@Controller('admin/public-address')
export class PublicAddressController {
  constructor(
    private readonly urls: PublicUrlService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly stepUp: StepUpService,
    private readonly acl: AccessControlService,
  ) {}

  private async passkeyCount() {
    return this.prisma.userMfaMethod.count({ where: { type: 'WEBAUTHN', isActive: true } });
  }

  @Get()
  async get(@Actor() actor: ActorContext) {
    this.acl.assertPlatformAdmin(actor);
    return { success: true, data: { ...this.urls.describe(), passkeys: await this.passkeyCount() } };
  }

  @Post('check')
  @HttpCode(HttpStatus.OK)
  @RateLimit(10)
  async check(@Actor() actor: ActorContext, @Body() dto: CheckAddressDto) {
    this.acl.assertPlatformAdmin(actor);
    return { success: true, data: await this.urls.check(dto.url) };
  }

  @Put()
  @RateLimit(30)
  async set(@Actor() actor: ActorContext, @Body() dto: SetAddressDto, @Req() req: Request) {
    this.acl.assertPlatformAdmin(actor); // access first, then step-up
    const next = dto.url === null ? null : PublicUrlService.normalize(dto.url);
    await this.stepUp.assert(req, 'platform.configure');

    let check: Awaited<ReturnType<PublicUrlService['check']>> | null = null;
    if (next) {
      check = await this.urls.check(next);
      if (!check.sameServer && !dto.saveUnverified) {
        // 409 so the client can offer "save anyway" rather than a dead end.
        throw new ConflictException({ code: 'ADDRESS_UNVERIFIED', message: check.detail });
      }
    }

    const before = this.urls.settingValue();
    await this.prisma.platformSettings.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton', publicUrl: next },
      update: { publicUrl: next },
    });
    this.urls.applySaved(next);

    if (before !== next) {
      await this.audit.log({
        actorId: actor.userId, actorIp: actor.ip,
        action: 'PLATFORM_SETTINGS_UPDATED',
        resource: 'platform_settings', resourceId: 'singleton',
        meta: { field: 'publicUrl', from: before, to: next, verified: check?.sameServer ?? null },
      });
    }
    return { success: true, data: { ...this.urls.describe(), passkeys: await this.passkeyCount(), check } };
  }
}

/** The far end of the reachability check. Reveals nothing but whether a nonce was ours. */
@Controller('public/address-probe')
export class AddressProbeController {
  constructor(private readonly urls: PublicUrlService) {}

  @Public()
  @Get(':nonce')
  @RateLimit(30)
  probe(@Param('nonce') nonce: string) {
    const ok = /^[A-Za-z0-9_-]{24}$/.test(nonce) && this.urls.answerProbe(nonce);
    return { success: true, data: { ok } };
  }
}
