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
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { MfaService } from '../mfa/mfa.service';
import type { JwtPayload } from './strategies/jwt.strategy';
import type { LoginDto, RegisterDto } from './dto/login.dto';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

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

    if (!user.passwordHash) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const valid = await argon2.verify(user.passwordHash, dto.password);
    if (!valid) {
      await this.audit.log({ action: 'LOGIN_FAILURE', actorId: user.id, actorIp: ip, meta: { reason: 'invalid_password' } });
      throw new UnauthorizedException('Invalid credentials');
    }

    let tenantId: string | null = null;
    let roleType = null;
    let customerId: string | null = null;

    if (dto.tenantSlug) {
      const membership = user.memberships.find((m) => m.tenant.slug === dto.tenantSlug);
      if (!membership) throw new UnauthorizedException('No access to that tenant');
      tenantId = membership.tenantId;
      roleType = membership.role.type;
      customerId = membership.customerId ?? null;
    } else if (user.memberships.length === 1) {
      tenantId = user.memberships[0].tenantId;
      roleType = user.memberships[0].role.type;
      customerId = user.memberships[0].customerId ?? null;
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
        { sub: user.id, email: user.email, tenantId, roleType, isPlatformAdmin: user.isPlatformAdmin, mfaVerified: false, partial: true },
        { expiresIn: '10m' },
      );
      return { requiresMfa: true, mfaEnrolled: hasTotpMethod, partialToken };
    }

    const token = this.issueFullToken(user, tenantId, roleType, customerId);
    await this.audit.log({ action: 'LOGIN_SUCCESS', actorId: user.id, tenantId: tenantId ?? undefined, actorIp: ip, actorAgent: userAgent });

    return {
      requiresMfa: false,
      accessToken: token,
      user: { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName },
      tenants: user.memberships.map((m) => ({ id: m.tenantId, name: m.tenant.name, slug: m.tenant.slug, role: m.role.type })),
    };
  }

  async verifyMfaAndLogin(partialToken: string, code: string, ip: string) {
    let payload: JwtPayload & { partial?: boolean };
    try {
      payload = this.jwtService.verify(partialToken);
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

    // Resolve customerId from matching membership (partial token may not carry it)
    const matchingMembership = payload.tenantId
      ? user.memberships.find((m) => m.tenantId === payload.tenantId)
      : user.memberships[0];
    const mfaCustomerId = matchingMembership?.customerId ?? null;

    const token = this.issueFullToken(user, payload.tenantId, payload.roleType, mfaCustomerId);
    return {
      accessToken: token,
      user: { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName },
      tenants: user.memberships.map((m) => ({ id: m.tenantId, name: m.tenant.name, slug: m.tenant.slug, role: m.role.type })),
    };
  }

  async switchTenant(userId: string, tenantSlug: string): Promise<string> {
    const membership = await this.prisma.membership.findFirst({
      where: { userId, isActive: true, tenant: { slug: tenantSlug, isActive: true } },
      include: { tenant: true, role: true, user: true },
    });
    if (!membership) throw new UnauthorizedException('No access to that tenant');
    return this.issueFullToken(membership.user, membership.tenantId, membership.role.type, membership.customerId ?? null);
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
    customerId?: string | null,
  ): string {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      tenantId,
      roleType: roleType as JwtPayload['roleType'],
      isPlatformAdmin: user.isPlatformAdmin,
      mfaVerified: true,
      customerId: customerId ?? null,
    };
    return this.jwtService.sign(payload);
  }

  async getProfile(userId: string) {
    return this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, firstName: true, lastName: true, status: true, createdAt: true },
    });
  }

  async updateProfile(userId: string, data: { firstName?: string; lastName?: string; email?: string }) {
    if (data.email) {
      const clash = await this.prisma.user.findFirst({
        where: { email: data.email.toLowerCase(), NOT: { id: userId } },
      });
      if (clash) throw new BadRequestException('Email already in use');
    }
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(data.firstName !== undefined && { firstName: data.firstName }),
        ...(data.lastName  !== undefined && { lastName:  data.lastName  }),
        ...(data.email     !== undefined && { email:     data.email.toLowerCase() }),
      },
      select: { id: true, email: true, firstName: true, lastName: true },
    });
    await this.audit.log({ actorId: userId, action: 'USER_UPDATED', resource: 'user', resourceId: userId, meta: { self: true } });
    return updated;
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    if (!newPassword || newPassword.length < 8) throw new BadRequestException('Password must be at least 8 characters');
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
