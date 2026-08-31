import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { createHmac } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { MfaService } from '../mfa/mfa.service';
import type { JwtPayload } from './strategies/jwt.strategy';
import type { LoginDto, RegisterDto } from './dto/login.dto';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  /**
   * The pre-MFA token is signed with a key derived from JWT_SECRET rather than
   * with JWT_SECRET itself.
   *
   * It used to be signed with the session key, and `JwtStrategy` accepted it,
   * so anyone holding a password could skip the second factor entirely: the
   * partial token is handed to the browser after the password check and worked
   * as a bearer credential on every route. The strategy now refuses tokens
   * carrying `partial`, and a separate key means the two can never be
   * interchangeable even if that check is ever lost again. Derived rather than
   * configured so an existing deployment needs no new environment variable.
   */
  /**
   * Failed password attempts per account, in process.
   *
   * `PlatformSecurityConfig.maxLoginAttempts` and `.lockoutMinutes` have been
   * configurable — and shown in the Security page — since before there was any
   * code that read them, so an operator could set a lockout policy that did
   * nothing at all. The per-IP throttle is the other half and lives on the
   * route; this half is per-account, so distributing an attack across addresses
   * does not buy the attacker anything.
   *
   * In process, like the recovery-code backoff in MfaService, because the API
   * runs as a single unit. Moving to Redis is the change to make if that stops
   * being true.
   */
  private readonly loginFailures = new Map<string, { count: number; lockedUntil: number }>();

  private async lockoutPolicy(): Promise<{ max: number; minutes: number }> {
    const cfg = await this.prisma.platformSecurityConfig.findFirst({
      select: { maxLoginAttempts: true, lockoutMinutes: true },
    });
    return {
      max: cfg?.maxLoginAttempts ?? 5,
      minutes: cfg?.lockoutMinutes ?? 15,
    };
  }

  /** Remaining lockout in seconds, or 0 when the account is not locked. */
  private lockedFor(userId: string): number {
    const state = this.loginFailures.get(userId);
    if (!state || state.lockedUntil <= Date.now()) return 0;
    return Math.ceil((state.lockedUntil - Date.now()) / 1000);
  }

  private async recordLoginFailure(userId: string, ip: string): Promise<void> {
    const { max, minutes } = await this.lockoutPolicy();
    if (max <= 0) return;                       // 0 disables the policy
    const state = this.loginFailures.get(userId);
    const count = (state && state.lockedUntil > Date.now() - minutes * 60_000 ? state.count : 0) + 1;
    const lockedUntil = count >= max ? Date.now() + minutes * 60_000 : Date.now();
    this.loginFailures.set(userId, { count, lockedUntil });
    if (count >= max) {
      await this.audit.log({
        action: 'LOGIN_FAILURE', actorId: userId, actorIp: ip,
        meta: { reason: 'account_locked', attempts: count, lockoutMinutes: minutes },
      });
    }
  }

  private clearLoginFailures(userId: string): void {
    this.loginFailures.delete(userId);
  }

  private partialSecret(): string {
    const base = this.config.get<string>('JWT_SECRET')!;
    return createHmac('sha256', base).update('rem0te:mfa-partial:v1').digest('hex');
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly mfaService: MfaService,
    private readonly audit: AuditService,
  ) {}

  async login(dto: LoginDto, ip: string, userAgent: string) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
      include: {
        memberships: {
          where: { isActive: true },
          include: { tenant: { select: { id: true, name: true, slug: true } }, role: true },
          // customerId is a scalar field on Membership, selected by default
        },
        mfaMethods: { where: { type: 'TOTP', isActive: true } },
      },
    });

    if (!user) {
      await this.audit.log({ action: 'LOGIN_FAILURE', actorIp: ip, meta: { email: dto.email, reason: 'user_not_found' } });
      throw new UnauthorizedException('Invalid credentials');
    }

    if (user.status === 'SUSPENDED') {
      throw new UnauthorizedException('Account is suspended');
    }
    if (user.status === 'INVITED') {
      throw new UnauthorizedException('Account setup not complete. Check your invitation email.');
    }
    // A deleted account is a deleted account. The strategy refuses its token on
    // the next request anyway, so letting the login itself succeed only ever
    // produced a confusing redirect loop.
    if (user.status === 'DELETED') {
      throw new UnauthorizedException('Invalid credentials');
    }

    const locked = this.lockedFor(user.id);
    if (locked > 0) {
      await this.audit.log({ action: 'LOGIN_FAILURE', actorId: user.id, actorIp: ip, meta: { reason: 'locked_out' } });
      throw new UnauthorizedException(
        `Too many failed sign-in attempts. Try again in ${Math.ceil(locked / 60)} minute(s).`,
      );
    }

    if (!user.passwordHash) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const valid = await argon2.verify(user.passwordHash, dto.password);
    if (!valid) {
      await this.audit.log({ action: 'LOGIN_FAILURE', actorId: user.id, actorIp: ip, meta: { reason: 'invalid_password' } });
      await this.recordLoginFailure(user.id, ip);
      throw new UnauthorizedException('Invalid credentials');
    }
    this.clearLoginFailures(user.id);

    let tenantId: string | null = null;
    let roleType = null;
    let businessId: string | null = null;
    let capabilities: string[] = [];

    // A person belongs to exactly one business, so there is nothing to pick.
    if (user.memberships.length === 1) {
      tenantId = user.memberships[0].tenantId;
      roleType = user.memberships[0].role.type;
      businessId = user.memberships[0].customerId ?? null;
      capabilities = user.memberships[0].capabilities ?? [];
    } else if (user.memberships.length === 0 && user.isPlatformAdmin) {
      // Platform admins don't need a membership. Rem0te has one platform
      // operator; the businesses it manages are Customer rows. Fall back to
      // the platform container so an admin can create and manage businesses
      // without a placeholder membership.
      const t = await this.prisma.tenant.findFirst({
        where: { isActive: true },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      });
      if (t) tenantId = t.id;
    }

    // A Business Owner / Business User with no business cannot do anything —
    // say so at login rather than handing out a token that 403s everywhere.
    if (!user.isPlatformAdmin && roleType && !businessId) {
      this.logger.warn(`User ${user.email} has a membership with no business assigned`);
    }

    const hasTotpMethod = user.mfaMethods.length > 0;

    let requireMfa = false;
    if (tenantId) {
      const settings = await this.prisma.tenantSettings.findUnique({
        where: { tenantId },
        select: { requireMfa: true },
      });
      requireMfa = settings?.requireMfa ?? false;
    }

    if (hasTotpMethod || requireMfa) {
      const partialToken = this.jwtService.sign(
        {
          sub: user.id, email: user.email, tenantId, roleType,
          isPlatformAdmin: user.isPlatformAdmin, mfaVerified: false, partial: true,
        },
        { expiresIn: '10m', secret: this.partialSecret() },
      );
      return { requiresMfa: true, mfaEnrolled: hasTotpMethod, partialToken };
    }

    const token = this.issueFullToken(user, tenantId, roleType, businessId, capabilities);
    await this.audit.log({
      action: 'LOGIN_SUCCESS', actorId: user.id,
      tenantId: tenantId ?? undefined, customerId: businessId ?? undefined,
      actorIp: ip, actorAgent: userAgent,
    });

    return {
      requiresMfa: false,
      accessToken: token,
      user: { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName },
    };
  }

  async verifyMfaAndLogin(partialToken: string, code: string, ip: string) {
    let payload: JwtPayload & { partial?: boolean };
    try {
      payload = this.jwtService.verify(partialToken, { secret: this.partialSecret() });
    } catch {
      throw new UnauthorizedException('Invalid or expired partial token');
    }

    if (!payload.partial) throw new BadRequestException('Token is not a partial token');

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      include: {
        memberships: {
          where: { isActive: true },
          include: { tenant: { select: { id: true, name: true, slug: true } }, role: true },
        },
      },
    });
    if (!user) throw new UnauthorizedException();

    const verified = await this.mfaService.verifyTotp(user.id, code);
    if (!verified) {
      await this.audit.log({ action: 'LOGIN_FAILURE', actorId: user.id, actorIp: ip, meta: { reason: 'invalid_totp' } });
      throw new UnauthorizedException('Invalid MFA code');
    }

    await this.audit.log({ action: 'MFA_VERIFIED', actorId: user.id, tenantId: payload.tenantId ?? undefined, actorIp: ip });
    await this.audit.log({ action: 'LOGIN_SUCCESS', actorId: user.id, tenantId: payload.tenantId ?? undefined, actorIp: ip });

    // Resolve business + capabilities from the matching membership — the
    // partial token deliberately does not carry them.
    const matchingMembership = payload.tenantId
      ? user.memberships.find((m) => m.tenantId === payload.tenantId)
      : user.memberships[0];

    const token = this.issueFullToken(
      user,
      payload.tenantId,
      matchingMembership?.role.type ?? payload.roleType,
      matchingMembership?.customerId ?? null,
      matchingMembership?.capabilities ?? [],
    );
    return {
      accessToken: token,
      user: { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName },
    };
  }

  async register(dto: RegisterDto): Promise<void> {
    const exists = await this.prisma.user.findUnique({ where: { email: dto.email.toLowerCase() } });
    if (exists) throw new ConflictException('Email already registered');

    const passwordHash = await argon2.hash(dto.password, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });

    await this.prisma.user.create({
      data: { email: dto.email.toLowerCase(), passwordHash, firstName: dto.firstName, lastName: dto.lastName },
    });
  }

  private issueFullToken(
    user: { id: string; email: string; isPlatformAdmin: boolean },
    tenantId: string | null,
    roleType: unknown,
    businessId?: string | null,
    capabilities?: string[] | null,
  ): string {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      tenantId,
      roleType: roleType as JwtPayload['roleType'],
      isPlatformAdmin: user.isPlatformAdmin,
      mfaVerified: true,
      businessId: businessId ?? null,
      // Legacy alias so a token minted here still resolves on older code paths.
      customerId: businessId ?? null,
      capabilities: capabilities ?? [],
    };
    return this.jwtService.sign(payload);
  }

  async getProfile(userId: string) {
    return this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true, email: true, firstName: true, lastName: true,
        status: true, createdAt: true, isPlatformAdmin: true,
        phone: true, jobTitle: true,
        address: true, city: true, state: true, country: true, postalCode: true,
        timeZone: true,
      },
    });
  }

  async updateProfile(
    userId: string,
    data: {
      firstName?: string; lastName?: string; email?: string;
      phone?: string; jobTitle?: string;
      address?: string; city?: string; state?: string; country?: string; postalCode?: string;
      timeZone?: string;
    },
  ) {
    if (data.email) {
      const clash = await this.prisma.user.findFirst({
        where: { email: data.email.toLowerCase(), NOT: { id: userId } },
      });
      if (clash) throw new BadRequestException('Email already in use');
    }
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(data.firstName  !== undefined && { firstName:  data.firstName }),
        ...(data.lastName   !== undefined && { lastName:   data.lastName  }),
        ...(data.email      !== undefined && { email:      data.email.toLowerCase() }),
        ...(data.phone      !== undefined && { phone:      data.phone || null }),
        ...(data.jobTitle   !== undefined && { jobTitle:   data.jobTitle || null }),
        ...(data.address    !== undefined && { address:    data.address || null }),
        ...(data.city       !== undefined && { city:       data.city || null }),
        ...(data.state      !== undefined && { state:      data.state || null }),
        ...(data.country    !== undefined && { country:    data.country || null }),
        ...(data.postalCode !== undefined && { postalCode: data.postalCode || null }),
        ...(data.timeZone   !== undefined && { timeZone:   data.timeZone || null }),
      },
      select: {
        id: true, email: true, firstName: true, lastName: true,
        phone: true, jobTitle: true,
        address: true, city: true, state: true, country: true, postalCode: true, timeZone: true,
      },
    });
    await this.audit.log({ actorId: userId, action: 'USER_UPDATED', resource: 'user', resourceId: userId, meta: { self: true, fields: Object.keys(data) } });
    return updated;
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    if (!newPassword || newPassword.length < 12) throw new BadRequestException('Password must be at least 12 characters');
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('User not found');
    if (!user.passwordHash) throw new BadRequestException('No password set on this account');
    const valid = await argon2.verify(user.passwordHash, currentPassword);
    if (!valid) throw new UnauthorizedException('Current password is incorrect');
    const passwordHash = await argon2.hash(newPassword);
    await this.prisma.user.update({ where: { id: userId }, data: { passwordHash } });
    await this.audit.log({ actorId: userId, action: 'PASSWORD_CHANGED', resource: 'user', resourceId: userId, meta: { self: true } });
    return { success: true };
  }
}
