import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { RoleType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export interface JwtPayload {
  sub: string;
  email: string;
  tenantId: string | null;
  roleType: RoleType | null;
  isPlatformAdmin: boolean;
  mfaVerified: boolean;
  customerId?: string | null;
  partial?: boolean;
  iat?: number;
  exp?: number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        (req) => (req?.cookies as Record<string, string> | undefined)?.['access_token'] ?? null,
      ]),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_SECRET')!,
    });
  }

  async validate(payload: JwtPayload): Promise<JwtPayload> {
    // Partial tokens (pre-MFA) only carry a user identity; do not re-check membership.
    if (payload.partial) {
      const user = await this.prisma.user.findUnique({
        where: { id: payload.sub },
        select: { id: true, status: true },
      });
      if (!user || user.status !== 'ACTIVE') {
        throw new UnauthorizedException('Account not available');
      }
      return payload;
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, status: true, isPlatformAdmin: true },
    });

    if (!user || user.status === 'DELETED') {
      throw new UnauthorizedException('Account not found');
    }
    if (user.status === 'SUSPENDED') {
      throw new UnauthorizedException('Account suspended');
    }

    // Re-check platform-admin flag against DB — never trust the JWT claim by itself.
    // If admin rights were revoked after the token was issued, honor the revocation.
    const isPlatformAdmin = user.isPlatformAdmin === true;

    let roleType = payload.roleType;
    let customerId = payload.customerId ?? null;

    if (payload.tenantId) {
      const tenant = await this.prisma.tenant.findUnique({
        where: { id: payload.tenantId },
        select: { id: true, isActive: true },
      });
      if (!tenant) throw new UnauthorizedException('Tenant no longer exists');
      if (!tenant.isActive) throw new UnauthorizedException('Tenant is disabled');

      // Platform admins may operate against any tenant without a membership row —
      // regular users must have an active membership in the tenant claimed by the JWT.
      const membership = await this.prisma.membership.findUnique({
        where: { userId_tenantId: { userId: payload.sub, tenantId: payload.tenantId } },
        select: {
          isActive: true,
          customerId: true,
          role: { select: { type: true } },
        },
      });

      if (!membership || !membership.isActive) {
        if (!isPlatformAdmin) {
          throw new UnauthorizedException('Membership no longer active for this tenant');
        }
      } else {
        // Honor current role / customerId from the database rather than the frozen JWT claim.
        roleType = membership.role.type;
        customerId = membership.customerId ?? null;
      }
    }

    return { ...payload, isPlatformAdmin, roleType, customerId };
  }
}
