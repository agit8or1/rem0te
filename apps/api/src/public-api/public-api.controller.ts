import {
  Body, Controller, Delete, Get, Param, Post, Query, Req, UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import { IsArray, IsEmail, IsIn, IsInt, IsOptional, IsString, Length, Min, Max, Matches } from 'class-validator';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';

import { ApiKeyAuthGuard } from '../apikeys/apikey-auth.guard';
import { RequireScopes } from '../apikeys/require-scopes.decorator';
import { Public } from '../common/decorators/public.decorator';
import { CustomersService } from '../customers/customers.service';
import { UsersService } from '../users/users.service';
import { EndpointsService } from '../endpoints/endpoints.service';
import { EnrollmentService } from '../enrollment/enrollment.service';

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
  @IsString() roleType!: string; // e.g. TECHNICIAN, TENANT_ADMIN
  @IsOptional() @IsString() customerId?: string;
}

class ApiMintEnrollmentDto {
  @IsString() customerId!: string;
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
    private readonly customers: CustomersService,
    private readonly users: UsersService,
    private readonly endpoints: EndpointsService,
    private readonly enrollment: EnrollmentService,
    // Prisma isn't needed directly here — all data access goes through the
    // existing services so the same tenant-isolation / audit trails run.
  ) {}

  private tenantId(req: Request): string {
    const u = (req as unknown as { user?: { tenantId?: string } }).user;
    if (!u?.tenantId) throw new Error('API key not tenant-bound');
    return u.tenantId;
  }
  private actorId(req: Request): string {
    return (req as unknown as { user?: { sub?: string } }).user?.sub ?? 'api-key';
  }
  private apiKeyMeta(req: Request) {
    const u = (req as unknown as { user?: { apiKeyId?: string; apiScopes?: string[] } }).user;
    return { apiKeyId: u?.apiKeyId, scopes: u?.apiScopes };
  }

  // ── System ────────────────────────────────────────────────────────────────
  @Get('whoami')
  async whoami(@Req() req: Request) {
    return {
      success: true,
      tenantId: this.tenantId(req),
      ...this.apiKeyMeta(req),
      timestamp: new Date().toISOString(),
    };
  }

  // ── Companies ─────────────────────────────────────────────────────────────
  @Get('companies')
  @RequireScopes('companies:read')
  async listCompanies(@Req() req: Request, @Query('search') search?: string) {
    return { success: true, data: await this.customers.findAll(this.tenantId(req), search) };
  }

  @Get('companies/:id')
  @RequireScopes('companies:read')
  async getCompany(@Req() req: Request, @Param('id') id: string) {
    return { success: true, data: await this.customers.findOne(this.tenantId(req), id) };
  }

  @Post('companies')
  @RequireScopes('companies:write')
  @HttpCode(HttpStatus.CREATED)
  async createCompany(@Req() req: Request, @Body() dto: ApiCreateCompanyDto) {
    return { success: true, data: await this.customers.create(this.tenantId(req), this.actorId(req), dto) };
  }

  // ── Users ─────────────────────────────────────────────────────────────────
  @Get('users')
  @RequireScopes('users:read')
  async listUsers(@Req() req: Request) {
    return { success: true, data: await this.users.listMembers(this.tenantId(req)) };
  }

  @Post('users/invite')
  @RequireScopes('users:write')
  @HttpCode(HttpStatus.CREATED)
  async inviteUser(@Req() req: Request, @Body() dto: ApiInviteUserDto) {
    // Resolve the role by RoleType within this tenant so callers can just
    // send "TECHNICIAN" instead of an internal roleId.
    const roleType = dto.roleType.toUpperCase();
    const role = await this.enrollment['prisma'].role.findFirst({
      where: { tenantId: this.tenantId(req), type: roleType as never },
      select: { id: true },
    });
    if (!role) throw new Error(`Unknown roleType: ${roleType}`);
    const invited = await this.users.invite(this.tenantId(req), this.actorId(req), dto.email, role.id);
    if (dto.customerId) {
      await this.users.setCustomer(this.tenantId(req), invited.membership.userId, dto.customerId, this.actorId(req));
    }
    return { success: true, data: invited };
  }

  // ── Computers ────────────────────────────────────────────────────────────
  @Get('computers')
  @RequireScopes('computers:read')
  async listComputers(@Req() req: Request, @Query() q: Record<string, string>) {
    return {
      success: true,
      data: await this.endpoints.findAll(this.tenantId(req), {
        search: q.search, customerId: q.customerId, status: q.status,
        platform: q.platform,
        page: q.page ? parseInt(q.page, 10) : 1,
        limit: q.limit ? Math.min(parseInt(q.limit, 10) || 50, 200) : 50,
      }),
    };
  }

  @Get('computers/:id')
  @RequireScopes('computers:read')
  async getComputer(@Req() req: Request, @Param('id') id: string) {
    return { success: true, data: await this.endpoints.findOne(this.tenantId(req), id) };
  }

  // ── Managed enrollment ───────────────────────────────────────────────────
  @Post('enrollment/tokens')
  @RequireScopes('enrollment:write')
  @HttpCode(HttpStatus.CREATED)
  async mintEnrollment(@Req() req: Request, @Body() dto: ApiMintEnrollmentDto) {
    const record = await this.enrollment.createClaimToken(
      this.tenantId(req),
      this.actorId(req),
      {
        customerId: dto.customerId,
        accessMode: (dto.accessMode ?? 'ASSIGNED_USERS') as never,
        assignedUserIds: dto.assignedUserIds ?? [],
        description: dto.description,
      },
      req.ip,
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
    return { success: true, data: await this.enrollment.listClaimTokens(this.tenantId(req)) };
  }
}
