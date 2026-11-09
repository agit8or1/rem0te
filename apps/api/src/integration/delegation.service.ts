import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ActorResolverService } from '../rbac/actor-resolver.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { CAP, effectiveCapabilities } from '../rbac/capabilities';
import { DelegationClaims, MAX_DELEGATION_TTL_S } from './contract';
import { parseJws, verifyEd25519 } from './crypto';
import { E } from './errors';
import type { Peer } from './peers';
import { ReplayGuardService } from './replay-guard.service';
import { MAX_CLOCK_SKEW_S } from './integration-auth.guard';

export interface DelegatedActor {
  claims: DelegationClaims;
  customerId: string;
  tenantId: string;
  actor: ActorContext;
}

export type ActorCheck =
  | { ok: true; customerId: string; tenantId: string; actor: ActorContext }
  | { ok: false; code: 'ORG_NOT_MAPPED' | 'TECHNICIAN_NOT_MAPPED' | 'BUSINESS_DISABLED' | 'NO_ACCESS' | 'MISSING_CAPABILITY'; message: string };

/**
 * Delegated technician identity.
 *
 * ClientSt0r mints a short-lived JWS (EdDSA, ≤ 5 min, single-use `jti`,
 * audience-bound to THIS rem0te) saying "technician T of organization O is
 * doing this". rem0te then:
 *
 *   1. verifies it with a delegation key from the peers FILE (not the
 *      request-signing key — a stolen service credential alone cannot mint a
 *      technician);
 *   2. maps O → business and (O, T) → user through explicit mapping rows —
 *      nothing is matched by name, email or hostname;
 *   3. rebuilds that user's access from the database NOW, with the same
 *      ActorResolverService the web app uses, and requires the business to be
 *      the user's own or a currently-assigned one and the
 *      `integration:ticket_analysis` capability to be held there.
 *
 * Step 3 is repeated by the worker before it does anything, so a role
 * revoked mid-job stops the job.
 */
@Injectable()
export class DelegationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly actors: ActorResolverService,
    private readonly acl: AccessControlService,
    private readonly replay: ReplayGuardService,
  ) {}

  verifyToken(peer: Peer, token: string | undefined, scope: string, reqSha256?: string): DelegationClaims {
    if (!token) throw E.delegation('Delegation token required');
    let parsed;
    try { parsed = parseJws(token); } catch { throw E.delegation('Malformed delegation token'); }
    if (parsed.header.alg !== 'EdDSA' || parsed.header.typ !== 'rem0te-delegation+jwt') throw E.delegation('Unsupported token type');
    const key = peer.delegationKeys.find((k) => k.kid === parsed.header.kid);
    if (!key || !verifyEd25519(key.key, parsed.signingInput, parsed.signature)) throw E.delegation('Delegation signature invalid');

    const c = DelegationClaims.safeParse(parsed.payload);
    if (!c.success) throw E.delegation('Delegation claims invalid');
    const claims = c.data;
    const now = Math.floor(Date.now() / 1000);
    if (claims.iss !== peer.id) throw E.delegation('Wrong issuer');
    if (claims.aud !== peer.audience) throw E.delegation('Wrong audience');
    if (claims.exp - claims.iat > MAX_DELEGATION_TTL_S) throw E.delegation('Token lifetime too long');
    if (claims.iat > now + MAX_CLOCK_SKEW_S) throw E.delegation('Token issued in the future');
    if ((claims.nbf ?? claims.iat) > now + MAX_CLOCK_SKEW_S) throw E.delegation('Token not yet valid');
    if (claims.exp < now - MAX_CLOCK_SKEW_S) throw E.delegation('Token expired');
    if (!claims.scope.split(' ').includes(scope)) throw E.delegation(`Token lacks scope ${scope}`);
    if (reqSha256 !== undefined && claims.req_sha256 !== reqSha256) throw E.delegation('Token is not bound to this request body');
    return claims;
  }

  jtiKey(peer: Peer, claims: DelegationClaims) { return `${peer.id}:jti:${claims.jti}`; }
  jtiExpiry(claims: DelegationClaims) { return new Date((claims.exp + MAX_CLOCK_SKEW_S + 60) * 1000); }

  /** Consume a read token's jti. Submit tokens are consumed by the job service, inside its idempotency logic. */
  async consumeReadToken(peer: Peer, claims: DelegationClaims) {
    if (!(await this.replay.consume(this.jtiKey(peer, claims), this.jtiExpiry(claims)))) throw E.replay('Delegation token already used');
  }

  /** The live access check. Shared by intake, polling and the worker. */
  async checkActor(peerId: string, externalOrgId: string, externalTechnicianId: string): Promise<ActorCheck> {
    const org = await this.prisma.integrationOrgMapping.findUnique({
      where: { peerId_externalOrgId: { peerId, externalOrgId } },
    });
    if (!org || org.revokedAt) return { ok: false, code: 'ORG_NOT_MAPPED', message: 'Organization is not mapped to a business' };
    const tech = await this.prisma.integrationTechnicianMapping.findUnique({
      where: { peerId_externalOrgId_externalTechnicianId: { peerId, externalOrgId, externalTechnicianId } },
    });
    if (!tech || tech.revokedAt) return { ok: false, code: 'TECHNICIAN_NOT_MAPPED', message: 'Technician is not mapped' };

    const business = await this.prisma.customer.findUnique({ where: { id: org.customerId }, select: { isActive: true, isArchived: true, tenantId: true } });
    if (!business || !business.isActive || business.isArchived) return { ok: false, code: 'BUSINESS_DISABLED', message: 'Business is disabled' };

    const live = await this.actors.actorForBusiness(tech.userId, business.tenantId, org.customerId);
    // The user must reach THIS business — their own, or a current technician
    // assignment. actorForBusiness falls back to the user's own business when
    // the requested one is not reachable, so the comparison is what matters.
    if (!live || live.businessId !== org.customerId) return { ok: false, code: 'NO_ACCESS', message: 'Technician has no current access to this business' };

    const capabilities = live.technician
      ? live.capabilities
      : effectiveCapabilities({ isPlatformAdmin: false, roleType: live.roleType, capabilities: live.capabilities });
    const actor: ActorContext = {
      userId: live.user.id, email: live.user.email, tenantId: business.tenantId,
      businessId: org.customerId,
      // Never Platform Admin through the integration: the admin bypass in
      // AccessControlService would otherwise lift every per-computer limit.
      isPlatformAdmin: false,
      roleType: live.roleType,
      capabilities: capabilities as ActorContext['capabilities'],
      ownBusinessId: live.ownBusinessId,
      technician: live.technician,
      assignedBusinessIds: live.assignedBusinessIds,
      platformPermissions: [],
    };
    if (!this.acl.can(actor, CAP.TICKET_ANALYSIS)) return { ok: false, code: 'MISSING_CAPABILITY', message: 'Technician lacks integration:ticket_analysis' };
    return { ok: true, customerId: org.customerId, tenantId: business.tenantId, actor };
  }

  async requireActor(peerId: string, claims: DelegationClaims): Promise<DelegatedActor> {
    const r = await this.checkActor(peerId, claims.org, claims.sub);
    if (!r.ok) throw E.forbidden(r.message);
    return { claims, customerId: r.customerId, tenantId: r.tenantId, actor: r.actor };
  }

  /** The endpoint must be in the business and visible to this technician. Same NotFound for both. */
  async assertEndpoint(actor: ActorContext, endpointId: string) {
    const ep = await this.prisma.endpoint.findUnique({
      where: { id: endpointId }, select: { id: true, customerId: true, accessMode: true, status: true },
    });
    if (!ep || ep.customerId !== actor.businessId || ep.status === 'ARCHIVED') throw E.invalid('Endpoint not found');
    if (actor.technician?.endpointIds && !actor.technician.endpointIds.includes(ep.id)) throw E.invalid('Endpoint not found');
    if (!(await this.acl.canReachEndpoint(actor, ep))) throw E.invalid('Endpoint not found');
    return ep;
  }
}
