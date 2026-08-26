import {
  Body, Controller, Get, Param, Post, Query, Req, UseGuards,
  HttpCode, HttpStatus, UnauthorizedException,
} from '@nestjs/common';
import { IsArray, IsEmail, IsIn, IsInt, IsOptional, IsString, Length, Min, Max } from 'class-validator';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';

import { ApiKeyAuthGuard } from '../apikeys/apikey-auth.guard';
import { RequireScopes } from '../apikeys/require-scopes.decorator';
import { Public } from '../common/decorators/public.decorator';
import { BusinessesService } from '../businesses/businesses.service';
import { EndpointsService } from '../endpoints/endpoints.service';
import { EnrollmentService } from '../enrollment/enrollment.service';
import { buildActorContext, type ActorContext } from '../rbac/access-control.service';
import type { JwtPayload } from '../auth/strategies/jwt.strategy';

// ── DTOs ─────────────────────────────────────────────────────────────────────

class ApiCreateCompanyDto {
  @IsString() @Length(1, 128) name!: string;
  @IsOptional() @IsString() @Length(0, 64)  code?: string;
  @IsOptional() @IsEmail()                   email?: string;
  @IsOptional() @IsString() @Length(0, 32)  phone?: string;
  @IsOptional() @IsString() @Length(0, 256) address?: string;
  @IsOptional() @IsString() @Length(0, 96)  city?: string;
  @IsOptional() @IsString() @Length(0, 96)  state?: string;
  @IsOptional() @IsString() @Length(0, 96)  country?: string;
  @IsOptional() @IsString() @Length(0, 32)  postalCode?: string;
  @IsOptional() @IsString() @Length(0, 2048) notes?: string;
}

class ApiInviteUserDto {
  @IsEmail() email!: string;
  /** Only the two business levels are assignable. */
  @IsIn(['BUSINESS_OWNER', 'BUSINESS_USER']) level!: 'BUSINESS_OWNER' | 'BUSINESS_USER';
  @IsOptional() @IsString() firstName?: string;
  @IsOptional() @IsString() lastName?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) capabilities?: string[];
}

class ApiMintEnrollmentDto {
  @IsOptional() @IsString() businessId?: string;
  @IsOptional() @IsIn(['ASSIGNED_USERS', 'COMPANY_WIDE']) accessMode?: 'ASSIGNED_USERS' | 'COMPANY_WIDE';
  @IsOptional() @IsArray() @IsString({ each: true }) assignedUserIds?: string[];
  @IsOptional() @IsIn(['windows', 'linux', 'macos']) platform?: 'windows' | 'linux' | 'macos';
  @IsOptional() @IsInt() @Min(1) @Max(30) expiresInDays?: number;
  @IsOptional() @IsString() @Length(0, 256) description?: string;
}

// ── Public API v1 ────────────────────────────────────────────────────────────

// @Public() bypasses the global JwtAuthGuard so the controller-level
// ApiKeyAuthGuard is the only auth gate. The class-level PermissionsGuard
// (also global) sees no @RequirePermissions() decorator and permits.
@Controller('pub/v1')
@Public()
@UseGuards(ApiKeyAuthGuard)
@Throttle({ default: { limit: 300, ttl: 60_000 } })
export class PublicApiController {
  constructor(
    private readonly businesses: BusinessesService,
    private readonly endpoints: EndpointsService,
    private readonly enrollment: EnrollmentService,
    // No direct Prisma access on purpose — every read and write goes through
    // the same services the web app uses, so the same business-isolation and
    // audit behaviour applies to API-key callers.
  ) {}

  /**
   * Build the same ActorContext an interactive request would produce. The
   * ApiKeyAuthGuard already pinned `businessId` to the key's business, so
   * every scope check downstream confines the key to it.
   */
  private actor(req: Request): ActorContext {
    const user = (req as unknown as { user?: JwtPayload }).user;
    if (!user?.businessId) {
      throw new UnauthorizedException('This API key is not bound to a business. Re-issue it.');
    }
    return buildActorContext(user, req.ip, req.headers['user-agent']);
  }

  private apiKeyMeta(req: Request) {
    const u = (req as unknown as { user?: { apiKeyId?: string; apiScopes?: string[] } }).user;
    return { apiKeyId: u?.apiKeyId, scopes: u?.apiScopes };
  }

  // ── System ────────────────────────────────────────────────────────────────
  @Get('whoami')
  async whoami(@Req() req: Request) {
    const actor = this.actor(req);
    return {
      success: true,
      businessId: actor.businessId,
      ...this.apiKeyMeta(req),
      timestamp: new Date().toISOString(),
    };
  }

  // ── Businesses ────────────────────────────────────────────────────────────
  // `companies` remains the public path for compatibility with integrations
  // built against v0.6; `businesses` is the current name for the same thing.

  @Get(['businesses', 'companies'])
  @RequireScopes('companies:read')
  async listBusinesses(@Req() req: Request, @Query('search') search?: string) {
    return { success: true, data: await this.businesses.findAll(this.actor(req), search) };
  }

  @Get(['businesses/:id', 'companies/:id'])
  @RequireScopes('companies:read')
  async getBusiness(@Req() req: Request, @Param('id') id: string) {
    return { success: true, data: await this.businesses.findOne(this.actor(req), id) };
  }

  // Creating a business is a platform-operator action; BusinessesService
  // asserts Platform Admin, which an API key never is. Kept so the route
  // returns a clear 403 instead of a 404.
  @Post(['businesses', 'companies'])
  @RequireScopes('companies:write')
  @HttpCode(HttpStatus.CREATED)
  async createBusiness(@Req() req: Request, @Body() dto: ApiCreateCompanyDto) {
    return { success: true, data: await this.businesses.create(this.actor(req), dto) };
  }

  // ── Users ─────────────────────────────────────────────────────────────────
  @Get('users')
  @RequireScopes('users:read')
  async listUsers(@Req() req: Request) {
    const actor = this.actor(req);
    return { success: true, data: await this.businesses.listUsers(actor, actor.businessId!) };
  }

  @Post('users/invite')
  @RequireScopes('users:write')
  @HttpCode(HttpStatus.CREATED)
  async inviteUser(@Req() req: Request, @Body() dto: ApiInviteUserDto) {
    const actor = this.actor(req);
    const data = await this.businesses.addUser(actor, actor.businessId!, dto);
    return { success: true, data };
  }

  // ── Computers ────────────────────────────────────────────────────────────
  @Get('computers')
  @RequireScopes('computers:read')
  async listComputers(@Req() req: Request, @Query() q: Record<string, string>) {
    return {
      success: true,
      data: await this.endpoints.findAll(this.actor(req), {
        search: q.search, status: q.status, platform: q.platform,
        page: q.page ? parseInt(q.page, 10) : 1,
        limit: q.limit ? Math.min(parseInt(q.limit, 10) || 50, 200) : 50,
      }),
    };
  }

  @Get('computers/:id')
  @RequireScopes('computers:read')
  async getComputer(@Req() req: Request, @Param('id') id: string) {
    return { success: true, data: await this.endpoints.findOne(this.actor(req), id) };
  }

  // ── Managed enrollment ───────────────────────────────────────────────────
  @Post('enrollment/tokens')
  @RequireScopes('enrollment:write')
  @HttpCode(HttpStatus.CREATED)
  async mintEnrollment(@Req() req: Request, @Body() dto: ApiMintEnrollmentDto) {
    const actor = this.actor(req);
    const record = await this.enrollment.createClaimToken(
      actor,
      {
        businessId: dto.businessId,
        accessMode: (dto.accessMode ?? 'ASSIGNED_USERS') as never,
        assignedUserIds: dto.assignedUserIds ?? [],
        description: dto.description,
      },
    );
    const platform = dto.platform ?? 'windows';
    const base = (process.env.PUBLIC_API_URL ?? '').replace(/\/+$/, '') || `${req.protocol}://${req.get('host')}`;
    const paths: Record<string, { path: string; cmd: string }> = {
      windows: { path: `/api/v1/public/install/win/${record.token}`, cmd: `irm ${base}/api/v1/public/install/win/${record.token} | iex` },
      linux:   { path: `/api/v1/public/install/linux/${record.token}`, cmd: `curl -fsSL ${base}/api/v1/public/install/linux/${record.token} | sudo bash` },
      macos:   { path: `/api/v1/public/install/mac/${record.token}`,   cmd: `curl -fsSL ${base}/api/v1/public/install/mac/${record.token} | sudo bash` },
    };
    const p = paths[platform];
    return {
      success: true,
      data: {
        id: record.id,
        token: record.token,   // raw — one-time
        expiresAt: record.expiresAt,
        install: { platform, url: `${base}${p.path}`, command: p.cmd },
      },
    };
  }

  @Get('enrollment/tokens')
  @RequireScopes('enrollment:write')
  async listEnrollment(@Req() req: Request) {
    return { success: true, data: await this.enrollment.listClaimTokens(this.actor(req)) };
  }
}
