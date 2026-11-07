import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { RoleType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { isRevoked } from '../session-revocation';
import {
  ACTIVE_BUSINESS_COOKIE, ACTIVE_BUSINESS_HEADER, ActorResolverService, type TechnicianContext,
} from '../../rbac/actor-resolver.service';
import type { Request } from 'express';

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

  // ── Resolved per request, never minted into a token ──────────────────────
  /** The business on the user's own membership (as opposed to the active one). */
  ownBusinessId?: string | null;
  /** Set when this request acts in a business through a technician assignment. */
  technician?: TechnicianContext | null;
  /** Every business this user can currently reach as a technician. */
  assignedBusinessIds?: string[];
  platformPermissions?: string[];
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly actors: ActorResolverService,
  ) {
    super({
      passReqToCallback: true,
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        (req) => (req?.cookies as Record<string, string> | undefined)?.['access_token'] ?? null,
      ]),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_SECRET')!,
    });
  }

  async validate(req: Request, payload: JwtPayload): Promise<JwtPayload> {
    // Never trust per-request fields that arrived inside a token.
    delete payload.technician;
    delete payload.assignedBusinessIds;
    delete payload.platformPermissions;
    delete payload.ownBusinessId;

    // A pre-MFA token is not a session. It used to be accepted here, which made
    // the second factor optional: the token is handed out once the password
    // checks out, and both permission guards short-circuit on the
    // platform-admin and owner claims it carries. Only /auth/mfa/verify may
    // consume one, and it verifies it against its own key.
    if (payload.partial) {
      throw new UnauthorizedException('Multi-factor authentication is not complete');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, status: true, isPlatformAdmin: true, sessionsValidAfter: true },
    });

    if (!user || user.status === 'DELETED') {
      throw new UnauthorizedException('Account not found');
    }
    // Revoked by sign-out, a password change or an MFA change. See
    // session-revocation.ts for why this is not a plain timestamp comparison.
    if (isRevoked(payload.iat, user.sessionsValidAfter)) {
      throw new UnauthorizedException('This session has ended. Sign in again.');
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
    let noMembership = false;

    // A token with no tenant used to keep whatever role, business and
    // capabilities it was minted with, forever — the one path where a claim was
    // taken on trust. Resolve it from the database like every other.
    if (!payload.tenantId) {
      const membership = await this.prisma.membership.findFirst({
        where: { userId: payload.sub, isActive: true },
        select: {
          customerId: true,
          capabilities: true,
          role: { select: { type: true } },
          customer: { select: { isActive: true, isArchived: true } },
        },
      });
      if (membership) {
        roleType = membership.role.type;
        businessId = membership.customerId ?? null;
        capabilities = membership.capabilities ?? [];
        if (!isPlatformAdmin && membership.customer &&
            (!membership.customer.isActive || membership.customer.isArchived)) {
          throw new UnauthorizedException('This business is disabled');
        }
      } else if (!isPlatformAdmin) {
        roleType = null;
        businessId = null;
        capabilities = [];
      }
    }

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
        // A technician may have no membership at all — their access is the
        // assignments resolved below. Anyone else without one is out.
        roleType = null;
        businessId = null;
        capabilities = [];
        noMembership = true;
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

    // Which business does this request act in? A multi-business user names
    // one with the X-Rem0te-Business header (or the rem0te_business cookie the
    // web app sets). It is honoured only for their own business or one they
    // are currently assigned to as a technician — recomputed here, now.
    const headerVal = req.headers?.[ACTIVE_BUSINESS_HEADER];
    const requested = (Array.isArray(headerVal) ? headerVal[0] : headerVal)
      ?? (req.cookies as Record<string, string> | undefined)?.[ACTIVE_BUSINESS_COOKIE]
      ?? null;
    const ownBusinessId = businessId;
    const extras = await this.actors.resolveExtras(payload.sub, ownBusinessId, requested);

    if (noMembership && !isPlatformAdmin && extras.assignedBusinessIds.length === 0 &&
        extras.platformPermissions.length === 0) {
      throw new UnauthorizedException('Your access to this business is no longer active');
    }

    if (extras.technician) {
      // Acting through an assignment: the business, capabilities and computer
      // restriction are the assignment's, and nothing of the user's own role
      // carries over — a Business Owner of their own MSP business is NOT an
      // owner of a customer they are assigned to.
      roleType = null;
      businessId = extras.technician.businessId;
      capabilities = extras.technician.capabilities;
    }

    return {
      ...payload,
      isPlatformAdmin,
      roleType,
      businessId,
      customerId: businessId,
      capabilities,
      ownBusinessId,
      technician: extras.technician,
      assignedBusinessIds: extras.assignedBusinessIds,
      platformPermissions: extras.platformPermissions,
    };
  }
}
