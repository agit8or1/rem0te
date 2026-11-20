import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';
import { EndpointsService } from '../endpoints/endpoints.service';
import { AccessPolicyService } from '../security-controls/access-policy.service';
import { ENTITY_ID_RE, GRANT_ID_RE } from './grant';
import { MsaService } from './msa.service';
import { MsaGrantService } from './msa-grant.service';
import { msaGrantsEnabled, MSA_NOT_ENABLED } from './msa-grants-flag';
import { CONNECT_APPLY_TIMEOUT_MS, LIVE_GRANT_STATES, MIN_SESSION_AGENT, POLLING_FRESH_MS } from './managed';
import { compareVersion } from './readiness';
import { MANAGED_LAUNCH_MODES, managedGrantTerms, type ManagedLaunchMode } from './connect-terms';
import { sessionTimeline } from './session-timeline';

/** At most this many grants in one bulk revoke, and this many computers in a scope revoke. */
export const BULK_REVOKE_MAX = 100;
export const SCOPE_REVOKE_COMPUTERS_MAX = 500;
const LIST_SESSIONS = 50;

const GRANT_SELECT = {
  id: true, endpointId: true, businessId: true, technicianId: true, source: true, launchMode: true, mode: true, permissions: true,
  consent: true, maxMinutes: true, idleMinutes: true, state: true, createdAt: true, notAfter: true, deliveredAt: true, receivedAt: true,
  appliedAt: true, launchedAt: true, revealedAt: true, connectedAt: true, endedAt: true, revokedAt: true, revokeReason: true, outcome: true,
} as const;
type GrantRow = {
  id: string; endpointId: string; businessId: string; technicianId: string; source: string; launchMode: string | null; mode: string;
  permissions: unknown; consent: string; maxMinutes: number; idleMinutes: number; state: string; createdAt: Date; notAfter: Date;
  deliveredAt: Date | null; receivedAt: Date | null; appliedAt: Date | null; launchedAt: Date | null; revealedAt: Date | null;
  connectedAt: Date | null; endedAt: Date | null; revokedAt: Date | null; revokeReason: string | null; outcome: string | null;
};

/**
 * Managed Secure Access sessions (0.73, build step 5), behind MSA_GRANTS.
 * Every public method asserts the switch first.
 *
 * Connect on a verified managed computer goes through here and only here:
 * the ordinary launch decision (EndpointsService.authorizeConnect with
 * `managed: true`) decides whether, and how; connect-terms.ts turns that
 * into the grant's mode, permissions, consent and limits; MsaGrantService
 * signs it. The one-time password goes to the technician's Connect script
 * once the agent reported the grant applied, once. Nothing the technician
 * sends but the launch mode reaches the grant, and that mode is what the
 * policy decided on.
 *
 * Who may revoke (end) a session:
 *   - the technician it was issued to, their own, while they can still see
 *     the computer;
 *   - a Platform Admin, any session on a computer they can see;
 *   - a business's own Owner or Admin with Edit computers, any session on
 *     that business's computers (never a technician's preset, whatever its
 *     capabilities).
 * Revoking never asks for a fresh confirmation: it only reduces.
 */
@Injectable()
export class MsaSessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly acl: AccessControlService,
    private readonly endpoints: EndpointsService,
    private readonly policy: AccessPolicyService,
    private readonly msa: MsaService,
    private readonly grants: MsaGrantService,
  ) {}

  private assertEnabled() {
    if (!msaGrantsEnabled()) throw new NotFoundException({ code: MSA_NOT_ENABLED, message: 'Managed Secure Access grants are not enabled on this server.' });
  }

  /** A business's Owner/Admin with Edit computers on its own computer, or a Platform Admin. */
  private mayRevokeAny(actor: ActorContext, businessId: string | null): boolean {
    if (actor.isPlatformAdmin) return true;
    return !actor.technician && !!businessId && actor.businessId === businessId && this.acl.can(actor, CAP.COMPUTERS_EDIT);
  }

  private mayRevoke(actor: ActorContext, g: { technicianId: string; businessId: string }): boolean {
    return g.technicianId === actor.userId || this.mayRevokeAny(actor, g.businessId);
  }

  private async visible(actor: ActorContext, endpointId: string) {
    if (!ENTITY_ID_RE.test(endpointId)) throw new NotFoundException('Computer not found');
    await this.acl.assertEndpointInScope(actor, endpointId, 'computers:view');
    const ep = await this.prisma.endpoint.findFirst({
      where: { AND: [{ id: endpointId }, this.acl.endpointVisibilityWhere(actor)] },
      select: { id: true, tenantId: true, customerId: true, name: true, hostname: true, customer: { select: { name: true } } },
    });
    if (!ep) throw new NotFoundException('Computer not found');
    return ep;
  }

  private refusedOf(g: GrantRow) {
    if (g.state === 'revoked' && g.revokeReason === 'timeout') {
      return { code: 'MSA_APPLY_TIMEOUT', message: `The computer's agent did not apply the session within ${CONNECT_APPLY_TIMEOUT_MS / 1000} seconds, so it was revoked. Nothing was handed over. Check that the computer is online and try again.` };
    }
    if (g.state === 'failed') return { code: 'MSA_GRANT_FAILED', message: `The computer's agent could not enforce the session (${g.outcome ?? 'failed'}); nothing weaker was substituted and nothing was handed over.` };
    if (g.state === 'expired') return { code: 'MSA_GRANT_EXPIRED', message: 'The computer\'s agent did not collect the session within its five-minute start window.' };
    if (g.state === 'cancelled') return { code: 'MSA_GRANT_CANCELLED', message: 'The session was replaced or the computer started rolling back before it was delivered.' };
    return undefined;
  }

  private async shape(actor: ActorContext, rows: GrantRow[], now: number) {
    const techIds = [...new Set(rows.map((r) => r.technicianId))];
    const users = techIds.length
      ? await this.prisma.user.findMany({ where: { id: { in: techIds } }, select: { id: true, email: true, firstName: true, lastName: true } })
      : [];
    const byId = new Map(users.map((u) => [u.id, { id: u.id, email: u.email, name: `${u.firstName} ${u.lastName}`.trim() }]));
    return rows.map((g) => {
      const timeline = sessionTimeline({ ...g }, now);
      const mine = g.technicianId === actor.userId;
      const refused = this.refusedOf(g);
      return {
        grantId: g.id, endpointId: g.endpointId, technicianId: g.technicianId, technician: byId.get(g.technicianId) ?? null,
        source: g.source, launchMode: g.launchMode, mode: g.mode, permissions: g.permissions, consent: g.consent,
        maxMinutes: g.maxMinutes, idleMinutes: g.idleMinutes, state: g.state, createdAt: g.createdAt,
        mine, ready: mine && g.source === 'connect' && g.state === 'applied' && !g.revealedAt && timeline.live,
        canRevoke: timeline.live && (LIVE_GRANT_STATES as readonly string[]).includes(g.state) && this.mayRevoke(actor, g),
        timeline, ...(refused ? { refused } : {}),
      };
    });
  }

  // ── Connect ───────────────────────────────────────────────────────────────

  /**
   * Connect to a verified managed computer through a grant. Refused, with a
   * reason, when the computer is not verified managed, its agent is too old
   * or not polling, another person has a session open on it, or the launch
   * policy says no. Never falls back to a Legacy password: there is none.
   */
  async connect(actor: ActorContext, endpointId: string, rawMode: unknown, now = Date.now()) {
    this.assertEnabled();
    const mode = (rawMode === undefined || rawMode === null || rawMode === '' ? 'control' : rawMode) as ManagedLaunchMode;
    if (!MANAGED_LAUNCH_MODES.includes(mode)) throw new BadRequestException({ code: 'MSA_MODE_INVALID', message: 'mode must be view_only, control or unattended.' });
    const ep = await this.visible(actor, endpointId);
    const row = await this.prisma.msaManagedComputer.findUnique({ where: { endpointId: ep.id }, select: { state: true, lastPollAt: true } });
    if (!row) throw new ConflictException({ code: 'MSA_NOT_MANAGED', message: 'This computer is in Legacy mode: use the ordinary Connect.' });
    if (row.state === 'rollback_pending') throw new ConflictException({ code: 'MSA_ROLLBACK_PENDING', message: 'This computer is rolling back to Legacy. Connect again once it has.' });
    if (row.state === 'enforcement_failure') throw new ConflictException({ code: 'MSA_ENFORCEMENT_FAILURE', message: 'The computer\'s agent could not enforce Managed Secure Access. A Platform Admin must send a test grant that reads back, or roll it back to Legacy.' });
    if (row.state !== 'verified') throw new ConflictException({ code: 'MSA_NOT_VERIFIED', message: 'This computer is Managed (pending): until a Platform Admin confirms it, use the ordinary Connect.' });
    const pr = await this.msa.preflightReadiness(ep.id, now);
    const v = compareVersion(pr?.agentVersion ?? null, MIN_SESSION_AGENT);
    if (v === null || v < 0) throw new ConflictException({ code: 'MSA_AGENT_TOO_OLD', message: `Connecting through a session grant needs the signed agent ${MIN_SESSION_AGENT} or later on the computer.` });
    const polling = this.grants.isHeld(ep.id) || (!!row.lastPollAt && now - row.lastPollAt.getTime() <= POLLING_FRESH_MS);
    if (!polling) throw new ConflictException({ code: 'MSA_AGENT_NOT_POLLING', message: 'The computer\'s agent is not collecting session grants right now (offline, or its poller is not running). Nothing was issued.' });

    // One person at a time: another technician's live session refuses; my
    // own earlier one is ended (revoked) by this new one.
    const live = await this.prisma.msaGrant.findMany({
      where: { endpointId: ep.id, state: { in: [...LIVE_GRANT_STATES] }, notAfter: { gte: new Date(now - 9 * 3_600_000) } },
      select: { ...GRANT_SELECT },
    });
    const stillLive = (await this.shape(actor, live, now)).filter((s) => s.timeline.live);
    const others = stillLive.filter((s) => !s.mine);
    if (others.length) throw new ConflictException({ code: 'MSA_SESSION_ACTIVE', message: `${others[0].technician?.name ?? 'Someone'} has a managed session open on this computer. It must end (or be disconnected) first.` });

    const authz = await this.endpoints.canConnect(actor, ep.id, { mode, admit: 'ui', stage: 'connect', managed: true });
    if (!authz.ok) {
      if (authz.message) throw new ForbiddenException({ code: authz.reason.toUpperCase(), status: authz.status, message: authz.message });
      throw new NotFoundException('Computer not found');
    }
    const facts = await this.policy.managedTermsFacts(actor, ep);
    const path = authz.path as 'member' | 'legacy_assignment' | 'preset';
    const terms = managedGrantTerms({ mode, path, maxSessionMinutes: authz.maxSessionMinutes, ...facts });
    const mineLive = stillLive.filter((s) => s.mine).map((s) => s.grantId);
    if (mineLive.length) await this.grants.revoke(actor, ep.id, { grantIds: mineLive, reason: 'session' }, now);
    await this.audit.logOrFail({
      action: 'MSA_SESSION_REQUESTED', actorId: actor.userId, actorIp: actor.ip, tenantId: ep.tenantId ?? undefined, customerId: ep.customerId ?? undefined,
      resource: 'endpoint', resourceId: ep.id, meta: { endpointId: ep.id, mode, path, grantMode: terms.mode, consent: terms.consent, maxMinutes: terms.maxMinutes },
    });
    const g = await this.grants.issueForConnect(actor, ep.id, mode, terms, now);
    const session = await this.grant(actor, g.grantId, now);
    return {
      grantId: g.grantId, endpointId: ep.id, mode: g.mode, permissions: g.permissions, consent: g.consent, maxMinutes: g.maxMinutes,
      idleMinutes: g.idleMinutes, applyTimeoutMs: CONNECT_APPLY_TIMEOUT_MS, session,
    };
  }

  /**
   * One session's progress and timeline: the grant's technician, or anyone
   * who can see the computer. Reading a Connect grant past its apply window
   * revokes it (reason timeout) first, so a stuck Connect fails closed.
   */
  async grant(actor: ActorContext, grantId: string, now = Date.now()) {
    this.assertEnabled();
    if (!GRANT_ID_RE.test(grantId)) throw new NotFoundException('Session not found');
    const head = await this.prisma.msaGrant.findUnique({ where: { id: grantId }, select: { endpointId: true } });
    if (!head) throw new NotFoundException('Session not found');
    await this.visible(actor, head.endpointId).catch(() => { throw new NotFoundException('Session not found'); });
    await this.grants.checkTimeout(head.endpointId, now);
    const g = await this.prisma.msaGrant.findUnique({ where: { id: grantId }, select: { ...GRANT_SELECT } });
    return (await this.shape(actor, [g!], now))[0];
  }

  /**
   * The Connect script for a Connect grant: the grant's technician only, the
   * launch re-authorized now (a revoked assignment or a pause since Connect
   * stops it), then MsaGrantService.release hands over the one-time
   * password once.
   */
  async connectScript(actor: ActorContext, grantId: string) {
    this.assertEnabled();
    if (!GRANT_ID_RE.test(grantId)) throw new NotFoundException('Session not found');
    const g = await this.prisma.msaGrant.findUnique({ where: { id: grantId }, select: { endpointId: true, technicianId: true, source: true, launchMode: true } });
    if (!g || g.source !== 'connect' || g.technicianId !== actor.userId || !g.launchMode) throw new NotFoundException('Session not found');
    const ep = await this.visible(actor, g.endpointId);
    const authz = await this.endpoints.canConnect(actor, ep.id, { mode: g.launchMode as ManagedLaunchMode, stage: 'connect', managed: true });
    if (!authz.ok) {
      await this.grants.revoke(actor, ep.id, { grantIds: [grantId], reason: 'session' });
      if (authz.message) throw new ForbiddenException({ code: authz.reason.toUpperCase(), status: authz.status, message: authz.message });
      throw new NotFoundException('Session not found');
    }
    const rel = await this.grants.release(actor, grantId);
    return { ...rel, endpointName: ep.hostname ?? ep.name ?? rel.rustdeskId };
  }

  // ── Reading ───────────────────────────────────────────────────────────────

  /** A computer's sessions, newest first (View computers, in scope). */
  async forEndpoint(actor: ActorContext, endpointId: string, now = Date.now()) {
    this.assertEnabled();
    const ep = await this.visible(actor, endpointId);
    await this.grants.checkTimeout(ep.id, now);
    const rows = await this.prisma.msaGrant.findMany({
      where: { endpointId: ep.id }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: LIST_SESSIONS, select: { ...GRANT_SELECT },
    });
    return { sessions: await this.shape(actor, rows, now), canRevokeAny: this.mayRevokeAny(actor, ep.customerId) };
  }

  /** Live sessions on every computer this person can see (optionally one business): Devices → Managed sessions. */
  async active(actor: ActorContext, businessId: string | null, now = Date.now()) {
    this.assertEnabled();
    const vis = this.acl.endpointVisibilityWhere(actor, businessId && ENTITY_ID_RE.test(businessId) ? businessId : null);
    const rows = await this.prisma.msaGrant.findMany({
      where: { state: { in: [...LIVE_GRANT_STATES] }, createdAt: { gte: new Date(now - 9 * 3_600_000) }, endpoint: vis },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: 200,
      select: { ...GRANT_SELECT, endpoint: { select: { id: true, name: true, hostname: true, customerId: true, customer: { select: { name: true } } } } },
    });
    const shaped = await this.shape(actor, rows, now);
    const sessions = shaped.map((s, i) => {
      const e = rows[i].endpoint;
      return { ...s, endpoint: { id: e.id, name: e.name, hostname: e.hostname, businessId: e.customerId, businessName: e.customer?.name ?? null } };
    }).filter((s) => s.timeline.live);
    return { sessions, canRevokeAny: actor.isPlatformAdmin || (!actor.technician && this.acl.can(actor, CAP.COMPUTERS_EDIT)) };
  }

  // ── Revocation ────────────────────────────────────────────────────────────

  /** End one session. Its technician, or someone who may end any session on that computer. */
  async revokeOne(actor: ActorContext, grantId: string) {
    this.assertEnabled();
    if (!GRANT_ID_RE.test(grantId)) throw new NotFoundException('Session not found');
    const g = await this.prisma.msaGrant.findUnique({ where: { id: grantId }, select: { id: true, endpointId: true, technicianId: true, businessId: true } });
    if (!g) throw new NotFoundException('Session not found');
    await this.visible(actor, g.endpointId).catch(() => { throw new NotFoundException('Session not found'); });
    if (!this.mayRevoke(actor, g)) throw new ForbiddenException({ code: 'MSA_REVOKE_NOT_ALLOWED', message: 'Only the technician whose session it is, the business\'s Owner or Admin, or a Platform Admin can disconnect it.' });
    const r = await this.grants.revoke(actor, g.endpointId, { grantIds: [g.id], reason: 'session' });
    return { revoked: r.revoked };
  }

  /**
   * End sessions by scope: a list of sessions, every session on a computer,
   * a technician's sessions (in one business, or every visible business for
   * a Platform Admin), or every session in a business. Each computer gets its
   * own signed revocation.
   */
  async revokeScope(actor: ActorContext, raw: unknown) {
    this.assertEnabled();
    const b = (raw ?? {}) as Record<string, unknown>;
    const scope = b.scope;
    const id = (k: string) => (typeof b[k] === 'string' && ENTITY_ID_RE.test(b[k] as string) ? (b[k] as string) : null);
    if (scope === 'sessions') {
      const ids = Array.isArray(b.grantIds) ? [...new Set(b.grantIds.filter((x): x is string => typeof x === 'string' && GRANT_ID_RE.test(x)))] : [];
      if (!ids.length || ids.length > BULK_REVOKE_MAX) throw new BadRequestException({ code: 'MSA_REVOKE_INVALID', message: `Name between 1 and ${BULK_REVOKE_MAX} sessions.` });
      const rows = await this.prisma.msaGrant.findMany({
        where: { id: { in: ids }, state: { in: [...LIVE_GRANT_STATES] }, endpoint: this.acl.endpointVisibilityWhere(actor) },
        select: { id: true, endpointId: true, technicianId: true, businessId: true },
      });
      const allowed = rows.filter((g) => this.mayRevoke(actor, g));
      const byEp = new Map<string, string[]>();
      for (const g of allowed) byEp.set(g.endpointId, [...(byEp.get(g.endpointId) ?? []), g.id]);
      let revoked = 0;
      for (const [ep, gids] of byEp) revoked += (await this.grants.revoke(actor, ep, { grantIds: gids, reason: 'session' })).revoked;
      return { revoked, computers: byEp.size, refused: rows.length - allowed.length };
    }
    if (scope === 'computer') {
      const endpointId = id('endpointId');
      if (!endpointId) throw new BadRequestException({ code: 'MSA_REVOKE_INVALID', message: 'Name the computer.' });
      const ep = await this.visible(actor, endpointId);
      if (!this.mayRevokeAny(actor, ep.customerId)) throw new ForbiddenException({ code: 'MSA_REVOKE_NOT_ALLOWED', message: 'Disconnecting every session on a computer is for the business\'s Owner or Admin, or a Platform Admin.' });
      const r = await this.grants.revoke(actor, ep.id, { all: true, reason: 'computer' });
      return { revoked: r.revoked, computers: r.revoked ? 1 : 0 };
    }
    if (scope === 'technician' || scope === 'business') {
      const businessId = id('businessId');
      const technicianId = scope === 'technician' ? id('technicianId') : null;
      if (scope === 'technician' && !technicianId) throw new BadRequestException({ code: 'MSA_REVOKE_INVALID', message: 'Name the technician.' });
      if (scope === 'business' && !businessId) throw new BadRequestException({ code: 'MSA_REVOKE_INVALID', message: 'Name the business.' });
      if (!actor.isPlatformAdmin) {
        const own = businessId ?? actor.businessId;
        if (!own || !this.mayRevokeAny(actor, own)) throw new ForbiddenException({ code: 'MSA_REVOKE_NOT_ALLOWED', message: 'Disconnecting a technician\'s or a business\'s sessions is for that business\'s Owner or Admin, or a Platform Admin.' });
      }
      const scopeBusiness = actor.isPlatformAdmin ? businessId : (businessId ?? actor.businessId);
      const rows = await this.prisma.msaGrant.findMany({
        where: {
          state: { in: [...LIVE_GRANT_STATES] }, ...(technicianId ? { technicianId } : {}), ...(scopeBusiness ? { businessId: scopeBusiness } : {}),
          endpoint: this.acl.endpointVisibilityWhere(actor, scopeBusiness),
        },
        distinct: ['endpointId'], select: { endpointId: true }, take: SCOPE_REVOKE_COMPUTERS_MAX,
      });
      let revoked = 0, computers = 0;
      for (const r of rows) {
        const n = (await this.grants.revoke(actor, r.endpointId, { ...(technicianId ? { technicianId } : { all: true }), reason: scope })).revoked;
        revoked += n;
        if (n) computers++;
      }
      return { revoked, computers };
    }
    throw new BadRequestException({ code: 'MSA_REVOKE_INVALID', message: 'scope must be sessions, computer, technician or business.' });
  }
}
