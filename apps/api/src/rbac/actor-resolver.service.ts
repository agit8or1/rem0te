import { Injectable } from '@nestjs/common';
import { RoleType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TechnicianAccessService, type TechnicianBusinessScope } from './technician-access.service';
import { sanitizePlatformPermissions } from './platform-permissions';

/** Header (or cookie) naming the business a multi-business user is working in. */
export const ACTIVE_BUSINESS_HEADER = 'x-rem0te-business';
export const ACTIVE_BUSINESS_COOKIE = 'rem0te_business';

export interface TechnicianContext {
  businessId: string;
  businessName: string;
  capabilities: string[];
  endpointIds: string[] | null;
  sources: TechnicianBusinessScope['sources'];
}

/**
 * The live, database-derived parts of an identity: own membership, technician
 * scopes, platform permissions and which business this request acts in.
 *
 * One implementation, used by the JWT strategy on every request AND by the
 * redemption paths (connection grants, launcher tokens) that rebuild an actor
 * with no request context. Two copies of "who is this and what may they
 * reach" is how a revocation ends up honoured on one path and not the other.
 */
@Injectable()
export class ActorResolverService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly technicianAccess: TechnicianAccessService,
  ) {}

  /**
   * @param ownBusinessId  the business on the user's own membership, if any
   * @param requested      the business the client asked to act in (header or
   *                       cookie). Untrusted: honoured only if it is the own
   *                       business or a currently-assigned one.
   */
  async resolveExtras(userId: string, ownBusinessId: string | null, requested: string | null | undefined) {
    const [{ scopes }, user] = await Promise.all([
      this.technicianAccess.resolve(userId),
      this.prisma.user.findUnique({ where: { id: userId }, select: { platformPermissions: true } }),
    ]);
    const platformPermissions = sanitizePlatformPermissions(user?.platformPermissions ?? []);
    const assignedBusinessIds = [...scopes.keys()];

    const want = typeof requested === 'string' ? requested.trim() : '';
    let technician: TechnicianContext | null = null;

    const pick = (id: string) => {
      const s = scopes.get(id)!;
      technician = {
        businessId: s.businessId, businessName: s.businessName,
        capabilities: s.capabilities, endpointIds: s.endpointIds, sources: s.sources,
      };
    };

    if (want && want !== ownBusinessId && scopes.has(want)) {
      pick(want);
    } else if (!want && !ownBusinessId && scopes.size === 1) {
      // Exactly one assignment and no business of their own: nothing to choose.
      pick(assignedBusinessIds[0]);
    }
    // Anything else — the own business, an unassigned id, a stale cookie for a
    // revoked assignment — acts as the user's own membership (or as no
    // business at all). A requested id is never trusted beyond this check.

    return { technician: technician as TechnicianContext | null, assignedBusinessIds, platformPermissions };
  }

  /**
   * Rebuild a full actor for a user with no request (grant / launcher-token
   * redemption), acting in `businessId`. Returns null when the user is not
   * active or has no live path into that business.
   */
  async actorForBusiness(userId: string, tenantId: string, businessId: string | null, ip?: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, status: true, isPlatformAdmin: true },
    });
    if (!user || user.status !== 'ACTIVE') return null;

    const membership = await this.prisma.membership.findFirst({
      where: { userId, isActive: true },
      select: {
        customerId: true, capabilities: true, role: { select: { type: true } },
        customer: { select: { isActive: true, isArchived: true } },
      },
    });
    const ownDisabled = !!membership?.customer && (!membership.customer.isActive || membership.customer.isArchived);
    const ownBusinessId = ownDisabled ? null : (membership?.customerId ?? null);
    const extras = await this.resolveExtras(userId, ownBusinessId, businessId);

    return {
      user,
      ownBusinessId,
      roleType: (extras.technician ? null : (ownDisabled ? null : membership?.role.type ?? null)) as RoleType | null,
      capabilities: extras.technician ? extras.technician.capabilities : (ownDisabled ? [] : membership?.capabilities ?? []),
      businessId: extras.technician ? extras.technician.businessId : ownBusinessId,
      tenantId,
      ip,
      ...extras,
    };
  }
}
