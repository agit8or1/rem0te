import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { RoleType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export interface JwtPayload {
  sub: string;
  email: string;
  /** Internal platform container. Not a security boundary — `businessId` is. */
  tenantId: string | null;
  /**
   * The business this user belongs to (Customer id). Null for a Platform
   * Admin, who is not confined to one.
   */
  businessId?: string | null;
  roleType: RoleType | null;
  isPlatformAdmin: boolean;
  mfaVerified: boolean;
  /** Granted business capabilities. Meaningful for BUSINESS_USER only. */
  capabilities?: string[] | null;
  /** @deprecated legacy alias of `businessId`, kept so old tokens still resolve. */
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
    let businessId = payload.businessId ?? payload.customerId ?? null;
    let capabilities = payload.capabilities ?? null;

    if (payload.tenantId) {
      const tenant = await this.prisma.tenant.findUnique({
        where: { id: payload.tenantId },
        select: { id: true, isActive: true },
      });
      if (!tenant) throw new UnauthorizedException('Platform container no longer exists');
      if (!tenant.isActive) throw new UnauthorizedException('Account is disabled');

      // Platform admins may operate without a membership row — everyone else
      // must have an active membership matching the token.
      const membership = await this.prisma.membership.findUnique({
        where: { userId_tenantId: { userId: payload.sub, tenantId: payload.tenantId } },
        select: {
          isActive: true,
          customerId: true,
          capabilities: true,
          role: { select: { type: true } },
          customer: { select: { id: true, isActive: true, isArchived: true } },
        },
      });

      if (!membership || !membership.isActive) {
        if (!isPlatformAdmin) {
          throw new UnauthorizedException('Your access to this business is no longer active');
        }
      } else {
        // Role, business and capabilities always come from the database, not
        // from the frozen token — so revoking a capability or moving a user
        // between businesses takes effect on the very next request rather
        // than whenever their token happens to expire.
        roleType = membership.role.type;
        businessId = membership.customerId ?? null;
        capabilities = membership.capabilities ?? [];

        // A disabled or archived business locks out its own users immediately.
        if (!isPlatformAdmin && membership.customer) {
          if (!membership.customer.isActive || membership.customer.isArchived) {
            throw new UnauthorizedException('This business is disabled');
          }
        }
      }
    }

    return {
      ...payload,
      isPlatformAdmin,
      roleType,
      businessId,
      customerId: businessId,
      capabilities,
    };
  }
}
