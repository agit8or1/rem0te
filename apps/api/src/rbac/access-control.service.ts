import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, RoleType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  Capability,
  effectiveCapabilities,
  isOwnerRole,
} from './capabilities';
import type { JwtPayload } from '../auth/strategies/jwt.strategy';
import type { TechnicianContext } from './actor-resolver.service';
import { computerAccessActive } from './technician-access.service';
import { PLATFORM_PERM, type PlatformPermission } from './platform-permissions';

/**
 * The resolved identity of whoever is making the request, plus the business
 * they are allowed to touch. Built once per request by the `@Actor()`
 * decorator and threaded through the services.
 */
export interface ActorContext {
  userId: string;
  email: string;
  tenantId: string | null;
  /**
   * The business (Customer id) this actor belongs to.
   * `null` for a Platform Admin who has not narrowed to a specific business.
   */
  businessId: string | null;
  isPlatformAdmin: boolean;
  roleType: RoleType | null;
  capabilities: Capability[];
  ip?: string;
  userAgent?: string;
  /** The business on the user's own membership (businessId is the ACTIVE one). */
  ownBusinessId?: string | null;
  /**
   * Set when this request acts in `businessId` through a technician
   * assignment. `endpointIds` null = every computer in that business.
   */
  technician?: TechnicianContext | null;
  /** Every business this user can currently reach as a technician. */
  assignedBusinessIds?: string[];
  platformPermissions?: PlatformPermission[];
}

export function buildActorContext(user: JwtPayload, ip?: string, userAgent?: string): ActorContext {
  const isPlatformAdmin = user.isPlatformAdmin === true;
  return {
    userId: user.sub,
    email: user.email,
    tenantId: user.tenantId ?? null,
    businessId: user.businessId ?? user.customerId ?? null,
    isPlatformAdmin,
    roleType: user.roleType ?? null,
    capabilities: effectiveCapabilities({
      isPlatformAdmin,
      roleType: user.roleType ?? null,
      capabilities: user.capabilities ?? null,
    }),
    ip,
    userAgent,
    ownBusinessId: user.ownBusinessId ?? null,
    technician: user.technician ?? null,
    assignedBusinessIds: user.assignedBusinessIds ?? [],
    platformPermissions: (user.platformPermissions ?? []) as PlatformPermission[],
  };
}

/**
 * Business isolation, enforced server side.
 *
 * Every business-scoped read and write goes through `resolveScope()` or
 * `businessWhere()`. The rule is deliberately boring:
 *
 *   • Platform Admin may address any business, or none (= platform-wide view).
 *   • Everyone else is pinned to the business on their membership. A request
 *     that names a different business is a 403, not a filtered-empty 200 —
 *     silently returning nothing hides probing from the audit trail.
 *   • A non-admin with no business on their membership can reach nothing.
 *     Fail closed.
 *
 * Nothing here trusts a request body, a path parameter, or the frontend.
 */
@Injectable()
export class AccessControlService {
  constructor(private readonly prisma: PrismaService) {}

  // ── Scope resolution ──────────────────────────────────────────────────────

  /**
   * Decide which business this request operates on.
   *
   * Returns `null` only for a Platform Admin who did not name one, meaning
   * "all businesses". Throws for any attempt to reach across the boundary.
   */
  resolveScope(actor: ActorContext, requestedBusinessId?: string | null): string | null {
    const requested = requestedBusinessId?.trim() || null;

    if (actor.isPlatformAdmin) {
      // Platform Admin bypasses business restrictions, explicitly and audibly.
      return requested;
    }

    if (!actor.businessId) {
      throw new ForbiddenException(
        'Your account is not linked to a business. Ask your Rem0te administrator to assign one.',
      );
    }

    if (requested && requested !== actor.businessId) {
      throw new ForbiddenException('You do not have access to that business');
    }

    return actor.businessId;
  }

  /**
   * Same rule as `resolveScope`, but always yields a concrete business id.
   * Use for writes that must land inside one business.
   */
  requireScope(actor: ActorContext, requestedBusinessId?: string | null): string {
    const scope = this.resolveScope(actor, requestedBusinessId);
    if (!scope) {
      throw new ForbiddenException('A business must be selected for this action');
    }
    return scope;
  }

  /**
   * Prisma `where` fragment constraining a query to the caller's business.
   * `{}` for a platform-wide Platform Admin query.
   */
  businessWhere(actor: ActorContext, requestedBusinessId?: string | null): { customerId?: string } {
    const scope = this.resolveScope(actor, requestedBusinessId);
    return scope ? { customerId: scope } : {};
  }

  /**
   * Prisma `where` fragment for the computers this actor may actually see.
   *
   * Business scope alone is NOT enough. A Business User sees only the
   * computers explicitly granted to them plus any marked COMPANY_WIDE within
   * their own business, so filtering on `customerId` would expose every
   * ASSIGNED_USERS machine in that business to someone with no access to it.
   * Owners and Platform Admins are unrestricted within their scope.
   *
   * Anything that lists, counts, maps, or otherwise derives facts about
   * endpoints must use this rather than `businessWhere` — a map pin is as much
   * a disclosure as a row in a table.
   */
  endpointVisibilityWhere(
    actor: ActorContext,
    requestedBusinessId?: string | null,
  ): Prisma.EndpointWhereInput {
    const scope = this.resolveScope(actor, requestedBusinessId);
    if (this.isBusinessOwner(actor)) {
      return scope ? { customerId: scope } : {};
    }
    if (actor.technician) {
      return { customerId: actor.technician.businessId, ...this.endpointRestrictionWhere(actor) };
    }
    const now = new Date();
    return {
      ...(scope ? { customerId: scope } : {}),
      OR: [
        {
          computerAccess: {
            some: {
              userId: actor.userId,
              // Date bounds are checked here; a weekly schedule cannot be
              // expressed in SQL and is enforced by canReachEndpoint instead —
              // seeing a computer outside its hours is not connecting to it.
              AND: [
                { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
                { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
              ],
            },
          },
        },
        ...(actor.businessId
          ? [{ accessMode: 'COMPANY_WIDE' as const, customerId: actor.businessId }]
          : []),
      ],
    };
  }

  /**
   * Extra `where` for any endpoint query: a technician whose assignment names
   * specific computers sees only those. `{}` for everyone else (their own
   * rules — business scope, grants — still apply on top).
   */
  endpointRestrictionWhere(actor: ActorContext): Prisma.EndpointWhereInput {
    if (actor.technician?.endpointIds) return { id: { in: actor.technician.endpointIds } };
    return {};
  }

  /**
   * The per-computer half of every connect / credential decision.
   *
   * One implementation for: Business Owners and Platform Admins (anything in
   * scope), technicians (their assignment's computers), and Business Users
   * (an ACTIVE ComputerAccess grant — inside its dates and schedule — or a
   * COMPANY_WIDE computer in their own business). Callers must already have
   * confirmed business scope.
   */
  async canReachEndpoint(
    actor: ActorContext,
    endpoint: { id: string; customerId: string | null; accessMode: string },
    at: Date = new Date(),
  ): Promise<boolean> {
    if (this.isBusinessOwner(actor)) return true;
    if (actor.technician) {
      if (endpoint.customerId !== actor.technician.businessId) return false;
      return actor.technician.endpointIds === null || actor.technician.endpointIds.includes(endpoint.id);
    }
    if (endpoint.accessMode === 'COMPANY_WIDE' && endpoint.customerId === actor.businessId) return true;
    const access = await this.prisma.computerAccess.findFirst({
      where: { endpointId: endpoint.id, userId: actor.userId },
      select: { startsAt: true, expiresAt: true, schedule: true },
    });
    return computerAccessActive(access, at);
  }

  // ── Platform permissions ──────────────────────────────────────────────────

  hasPlatformPermission(actor: ActorContext, perm: PlatformPermission): boolean {
    return actor.isPlatformAdmin || (actor.platformPermissions ?? []).includes(perm);
  }

  assertPlatformPermission(actor: ActorContext, perm: PlatformPermission): void {
    if (!this.hasPlatformPermission(actor, perm)) {
      throw new ForbiddenException(
        perm === PLATFORM_PERM.TECHNICIANS_MANAGE
          ? 'Managing technician access needs the "Manage technician access" platform permission'
          : 'Platform permission required',
      );
    }
  }

  // ── Capabilities ──────────────────────────────────────────────────────────

  can(actor: ActorContext, capability: Capability): boolean {
    if (actor.isPlatformAdmin) return true;
    return actor.capabilities.includes(capability);
  }

  assertCapability(actor: ActorContext, ...capabilities: Capability[]): void {
    if (actor.isPlatformAdmin) return;
    const missing = capabilities.filter((c) => !actor.capabilities.includes(c));
    if (missing.length > 0) {
      throw new ForbiddenException(`You do not have permission to do that (${missing.join(', ')})`);
    }
  }

  isBusinessOwner(actor: ActorContext): boolean {
    return actor.isPlatformAdmin || isOwnerRole(actor.roleType);
  }

  assertBusinessOwner(actor: ActorContext): void {
    if (!this.isBusinessOwner(actor)) {
      throw new ForbiddenException('Business Owner access required');
    }
  }

  assertPlatformAdmin(actor: ActorContext): void {
    if (!actor.isPlatformAdmin) {
      throw new ForbiddenException('Platform Admin access required');
    }
  }

  // ── Object-level checks ───────────────────────────────────────────────────

  /**
   * Confirm a computer is inside the caller's business before anything is
   * read from or written to it.
   *
   * Deliberately raises NotFound rather than Forbidden: a caller poking at
   * another business's ids learns nothing about whether they exist.
   */
  async assertEndpointInScope(actor: ActorContext, endpointId: string) {
    const endpoint = await this.prisma.endpoint.findUnique({
      where: { id: endpointId },
      select: { id: true, customerId: true, tenantId: true, status: true, accessMode: true, name: true },
    });
    if (!endpoint) throw new NotFoundException('Computer not found');

    if (!actor.isPlatformAdmin) {
      if (!actor.businessId || endpoint.customerId !== actor.businessId) {
        throw new NotFoundException('Computer not found');
      }
      // A technician assigned to named computers cannot address any other,
      // even inside the same business — same NotFound as a foreign id.
      if (actor.technician?.endpointIds && !actor.technician.endpointIds.includes(endpoint.id)) {
        throw new NotFoundException('Computer not found');
      }
    }
    return endpoint;
  }

  /** Confirm a business exists and the caller may address it. */
  async assertBusinessInScope(actor: ActorContext, businessId: string) {
    const scope = this.resolveScope(actor, businessId);
    const business = await this.prisma.customer.findFirst({
      where: { id: businessId, ...(scope ? { id: scope } : {}) },
      select: { id: true, name: true, tenantId: true, isActive: true, isArchived: true, quickConnectEnabled: true },
    });
    if (!business) throw new NotFoundException('Business not found');
    return business;
  }

  /**
   * Confirm a user is a member of the caller's business before the caller may
   * act on them. Platform Admins may act on anyone.
   */
  async assertUserInScope(actor: ActorContext, targetUserId: string) {
    const membership = await this.prisma.membership.findFirst({
      where: {
        userId: targetUserId,
        ...(actor.isPlatformAdmin ? {} : { customerId: actor.businessId ?? '__none__' }),
      },
      include: {
        user: { select: { id: true, email: true, firstName: true, lastName: true, status: true, isPlatformAdmin: true } },
        role: { select: { id: true, name: true, type: true } },
      },
    });
    if (!membership) throw new NotFoundException('User not found in this business');
    return membership;
  }

  /**
   * A Business Owner must never be able to act on a Platform Admin, and no
   * one may escalate someone (including themselves) to a level at or above
   * their own.
   */
  assertMayManage(actor: ActorContext, target: { roleType: RoleType | null; isPlatformAdmin: boolean; userId: string }): void {
    if (actor.isPlatformAdmin) return;

    if (target.isPlatformAdmin) {
      throw new ForbiddenException('Only a Platform Admin can manage a Platform Admin');
    }
    if (!this.isBusinessOwner(actor)) {
      throw new ForbiddenException('Business Owner access required');
    }
    if (isOwnerRole(target.roleType) && target.userId !== actor.userId) {
      throw new ForbiddenException('A Business Owner cannot manage another Business Owner');
    }
  }
}
