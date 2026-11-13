import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { ClientUpdatePolicy, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { ContainmentService } from '../containment/containment.service';
import { UpdateTrustService } from '../update-trust/update-trust.service';
import { ClientUpdatesService } from '../client-updates/client-updates.service';
import { policyScope, policyWindow, resolvePolicy, ROLLOUT_OPEN } from '../client-updates/policy';
import { describeWindow, isWindowOpen, windowState } from '../client-updates/update-window';
import { openSessionReason } from '../admin/session-evidence';
import { assertFresh } from '../security-controls/review';
import { servedAgentVersion } from '../common/served-version';
import {
  agentChannel, ATTEMPT_WINDOW_MS, attemptsFor, decide, flagFor, isBehind, parseSettingsUpdate, REASON_TEXT, resolveMode,
  selfCheckAllowed, settingsFrom, targetFor, VERIFY_GRACE_MS,
  type AgentAutoSettings, type AgentChannel, type AgentMode, type Decision, type Served,
} from './schedule';

const SETTINGS_CACHE_MS = 30_000;
/** After the pace says no, this process does not count again for this long. */
const PACE_RECHECK_MS = 60_000;
/** A session count the endpoint reported longer ago than this is not evidence about now. */
const SESSION_COUNT_FRESH_MS = 10 * 60_000;
const LIVE_SAMPLE_FRESH_MS = 15 * 60_000;
const SETTINGS_SELECT = { agentAutoUpdateEnabled: true, agentAutoUpdatePerHour: true, agentAutoUpdateMaxAttempts: true } as const;

type NodeState = {
  id: string; endpointId: string; agentSecretHash: string | null;
  agentAutoTarget: string | null; agentAutoAttempts: number; agentAutoLastAt: Date | null;
};

/**
 * Automatic agent self-update (0.36). The decisions are in schedule.ts; this
 * is where they meet the database.
 *
 *   - forHeartbeat: called by an AUTHENTICATED heartbeat only, after every
 *     other update step (RustDesk staging, Reinstall, rollouts, the legacy
 *     gate, migration) has had its say. It never overrides one: it only adds
 *     a flag when nothing else is going out, and the heartbeat's own
 *     containment check runs after it. For an up-to-date agent with no
 *     attempt on record it touches the database not at all (the node is the
 *     one the heartbeat already loaded).
 *   - Each attempt is an AgentAutoUpdateAttempt row — the system-initiated
 *     update history, with no requester — and is never an audit entry: one
 *     per computer per release would bury the log. The settings and the
 *     per-business opt-outs that cause them are audited when they change.
 *   - card: what the Agent card says, from the same decide().
 *   - getSettings / putSettings: Settings → Client updates, Platform Admin,
 *     fresh authentication to change, audited before and after.
 */
@Injectable()
export class AgentAutoUpdateService {
  private readonly logger = new Logger('AgentAutoUpdate');
  private settingsCache: { at: number; value: AgentAutoSettings } | null = null;
  private paceFullUntil = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly acl: AccessControlService,
    private readonly containment: ContainmentService,
    private readonly updateTrust: UpdateTrustService,
    private readonly clientUpdates: ClientUpdatesService,
  ) {}

  // ── What the server serves ────────────────────────────────────────────────

  /** What a fresh installer reports (common/served-version.ts, the heartbeat's own lookup). */
  servedVersion(): string { return servedAgentVersion(); }

  served(): Served {
    return { version: this.servedVersion(), signedSha256: this.updateTrust.agentTarget()?.sha256 ?? null };
  }

  async settings(fresh = false): Promise<AgentAutoSettings> {
    if (!fresh && this.settingsCache && Date.now() - this.settingsCache.at < SETTINGS_CACHE_MS) return this.settingsCache.value;
    const row = await this.prisma.platformSettings.findUnique({ where: { id: 'singleton' }, select: SETTINGS_SELECT });
    const value = settingsFrom(row);
    this.settingsCache = { at: Date.now(), value };
    return value;
  }

  // ── Which policy governs ──────────────────────────────────────────────────

  /**
   * The agent mode for one computer: its client-update policies ranked by
   * group-policy/precedence.ts (group > site > business), the first that
   * sets one deciding. Membership is computed now and never kept.
   */
  async modeFor(ep: { id: string; customerId: string | null; siteId: string | null }, now: Date) {
    return (await this.modesFor([ep], now)).get(ep.id)!;
  }

  /**
   * modeFor for many computers at once (0.37: the Full agent page's counts
   * and the automatic migration's opt-out). One policy read and one
   * membership snapshot per business; the same ranking for each computer.
   */
  async modesFor(eps: { id: string; customerId: string | null; siteId: string | null }[], now: Date) {
    const out = new Map<string, {
      mode: AgentMode; policy: (ClientUpdatePolicy & { scope: 'business' | 'site' | 'group' }) | null; groupName?: string | null; windowOpen: boolean; skipLoggedOnUser: boolean;
    }>();
    const byBiz = new Map<string, typeof eps>();
    for (const ep of eps) {
      if (!ep.customerId) { out.set(ep.id, { mode: 'ANY_TIME', policy: null, windowOpen: true, skipLoggedOnUser: false }); continue; }
      const list = byBiz.get(ep.customerId) ?? [];
      list.push(ep); byBiz.set(ep.customerId, list);
    }
    for (const [customerId, list] of byBiz) {
      const policies = await this.prisma.clientUpdatePolicy.findMany({ where: { customerId } });
      const m = await this.clientUpdates.membershipFor(policies, list.map((e) => e.id));
      for (const ep of list) {
        const res = resolvePolicy(policies, { id: ep.id, customerId: ep.customerId, siteId: ep.siteId, groupIds: m.groupsOf(ep.id) });
        const ranked = res.ranked.map((p) => ({ ...p, scope: policyScope(p) as 'business' | 'site' | 'group', agentMode: (p.agentMode ?? null) as AgentMode | null }));
        const { mode, policy } = resolveMode(ranked);
        const groupName = policy?.groupId ? m.groups.get(policy.groupId)?.name ?? null : null;
        out.set(ep.id, {
          mode, policy: policy as (ClientUpdatePolicy & { scope: 'business' | 'site' | 'group' }) | null, groupName,
          // A WINDOW policy with a malformed window is closed (fails closed), like the RustDesk sweep.
          windowOpen: mode === 'WINDOW' ? isWindowOpen(policyWindow(policy), now) : true,
          skipLoggedOnUser: mode === 'WINDOW' ? !!policy?.skipLoggedOnUser : false,
        });
      }
    }
    return out;
  }

  private async rolloutOwns(endpointId: string) {
    return !!(await this.prisma.updateJob.findFirst({ where: { endpointId, status: { in: [...ROLLOUT_OPEN] } }, select: { id: true } }));
  }

  // ── Heartbeat ─────────────────────────────────────────────────────────────

  /**
   * One authenticated heartbeat. Returns the flag to add (only when the
   * caller has none going out) and whether a signed agent may run its own
   * periodic update check. Best-effort: the caller catches.
   */
  async forHeartbeat(c: {
    node: NodeState & { updateRequestedAt: Date | null; reinstallRequestedAt: Date | null; rdSessionsActive: number | null; rdSessionsObservedAt: Date | null };
    dto: { agentVersion?: string; updateChannel?: string; agentSha256?: string; platform?: string; rustdeskSessions?: number; loggedOnUser?: string };
    updatesHeld: boolean; rolloutManaged: boolean; flagGoingOut: boolean; now?: Date;
  }): Promise<{ flag: 'reinstallAgent' | 'updateRustdesk' | null; selfCheck: boolean }> {
    const now = c.now ?? new Date();
    const facts = {
      platform: c.dto.platform ?? null,
      updateChannel: c.dto.updateChannel === 'signed' ? 'signed' : 'legacy',
      agentVersion: c.dto.agentVersion ?? null,
      agentSha256: c.dto.updateChannel === 'signed' ? c.dto.agentSha256 ?? null : null,
      hasSecret: !!c.node.agentSecretHash,
    };
    const ch = agentChannel(facts);
    if (!('channel' in ch)) return { flag: null, selfCheck: false };
    const channel = ch.channel;
    const served = this.served();
    const target = targetFor(channel, served);
    const behind = isBehind(channel, facts, target);

    if (behind === false) {
      // Reached it: close what is on record, once.
      if (c.node.agentAutoTarget) await this.complete(c.node, now);
      return { flag: null, selfCheck: channel === 'signed' ? await this.selfCheck(c, now) : false };
    }
    if (behind === null) return { flag: null, selfCheck: channel === 'signed' ? await this.selfCheck(c, now) : false };

    const settings = await this.settings();
    if (!settings.enabled || !settings.processOn) return { flag: null, selfCheck: false };
    const st = attemptsFor(c.node, target);
    // Cheap exits before any query: exhausted, or spaced out and not due.
    const last = st.lastAt?.getTime() ?? null;
    const inAttempt = last !== null && now.getTime() - last < ATTEMPT_WINDOW_MS;
    if (!inAttempt && st.attempts >= settings.maxAttempts) return { flag: null, selfCheck: false };
    if (!inAttempt && last !== null && now.getTime() < last + ATTEMPT_WINDOW_MS + VERIFY_GRACE_MS) return { flag: null, selfCheck: false };

    const ep = await this.prisma.endpoint.findUnique({ where: { id: c.node.endpointId }, select: { id: true, status: true, customerId: true, siteId: true } });
    if (!ep) return { flag: null, selfCheck: false };
    const gov = await this.modeFor(ep, now);
    const reported = c.dto.rustdeskSessions;
    const d = decide({
      now, settings, archived: ep.status === 'ARCHIVED', facts, served,
      gate: await this.updateTrust.gateForHeartbeat(channel === 'signed' ? 'signed' : 'legacy'),
      mode: gov.mode, windowOpen: gov.windowOpen, skipLoggedOnUser: gov.skipLoggedOnUser,
      paused: c.updatesHeld, rollout: c.rolloutManaged || await this.rolloutOwns(ep.id),
      pendingRequest: c.flagGoingOut || !!c.node.updateRequestedAt || !!c.node.reinstallRequestedAt,
      sessionOpen: !!(await openSessionReason(this.prisma, ep.id, reported, now, true)),
      loggedOnUser: c.dto.loggedOnUser,
      attempts: st.attempts, lastAt: st.lastAt,
    });
    const selfCheck = channel === 'signed' && selfCheckAllowed({ settings, mode: gov.mode, windowOpen: gov.windowOpen, paused: c.updatesHeld, rollout: c.rolloutManaged, sessionOpen: false });
    if (d.dispatch === 'resend') return { flag: flagFor(channel), selfCheck };
    if (d.dispatch !== 'new') return { flag: null, selfCheck };
    if (Date.now() < this.paceFullUntil) return { flag: null, selfCheck };
    const started = await this.startAttempt(c.node, ep, channel, target!, st.attempts, facts, settings, now);
    return { flag: started ? flagFor(channel) : null, selfCheck };
  }

  /** A signed agent's own periodic check: same opt-outs and holds, no version comparison. */
  private async selfCheck(c: { node: NodeState; updatesHeld: boolean; rolloutManaged: boolean; dto: { rustdeskSessions?: number } }, now: Date): Promise<boolean> {
    const settings = await this.settings();
    if (!settings.enabled || !settings.processOn || c.updatesHeld || c.rolloutManaged) return false;
    if ((c.dto.rustdeskSessions ?? 0) > 0) return false;
    const ep = await this.prisma.endpoint.findUnique({ where: { id: c.node.endpointId }, select: { id: true, customerId: true, siteId: true, status: true } });
    if (!ep || ep.status === 'ARCHIVED') return false;
    const gov = await this.modeFor(ep, now);
    return selfCheckAllowed({ settings, mode: gov.mode, windowOpen: gov.windowOpen, paused: false, rollout: false, sessionOpen: false });
  }

  /**
   * Start one attempt, if the global pace allows: under an advisory lock (so
   * two API processes cannot both take the last slot), count the attempts
   * started in the last hour, then move the node on conditionally on what
   * this heartbeat read (so two concurrent heartbeats of one computer start
   * one attempt), and write the history row.
   */
  private async startAttempt(
    node: NodeState, ep: { id: string; customerId: string | null }, channel: AgentChannel, target: string, attemptsMade: number,
    facts: { agentVersion: string | null; agentSha256: string | null }, settings: AgentAutoSettings, now: Date,
  ): Promise<boolean> {
    const r = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext('rem0te.agent-auto-update.pace'))`);
      const used = await tx.agentAutoUpdateAttempt.count({ where: { dispatchedAt: { gt: new Date(now.getTime() - 3600_000) } } });
      if (used >= settings.perHour) return 'pacing' as const;
      const moved = await tx.rustdeskNode.updateMany({
        where: { id: node.id, agentAutoTarget: node.agentAutoTarget, agentAutoAttempts: node.agentAutoAttempts, agentAutoLastAt: node.agentAutoLastAt },
        data: { agentAutoTarget: target, agentAutoAttempts: attemptsMade + 1, agentAutoLastAt: now },
      });
      if (moved.count !== 1) return 'raced' as const;
      await tx.agentAutoUpdateAttempt.updateMany({ where: { endpointId: ep.id, outcome: null }, data: { outcome: 'superseded', resolvedAt: now } });
      const tenantId = (await tx.endpoint.findUnique({ where: { id: ep.id }, select: { tenantId: true } }))?.tenantId ?? null;
      await tx.agentAutoUpdateAttempt.create({
        data: {
          endpointId: ep.id, tenantId, customerId: ep.customerId, channel,
          fromVersion: channel === 'signed' ? facts.agentSha256 : facts.agentVersion,
          targetVersion: target, attempt: attemptsMade + 1, dispatchedAt: now,
        },
      });
      return 'started' as const;
    });
    if (r === 'pacing') this.paceFullUntil = Date.now() + PACE_RECHECK_MS;
    return r === 'started';
  }

  private async complete(node: NodeState, now: Date) {
    await this.prisma.rustdeskNode.updateMany({
      where: { id: node.id, agentAutoTarget: node.agentAutoTarget },
      data: { agentAutoTarget: null, agentAutoAttempts: 0, agentAutoLastAt: null },
    });
    await this.prisma.agentAutoUpdateAttempt.updateMany({ where: { endpointId: node.endpointId, outcome: null }, data: { outcome: 'updated', resolvedAt: now } });
  }

  /** Someone clicked Update agent: automatic attempts at the current target start again from zero afterwards. */
  async resetFor(endpointId: string) {
    await this.prisma.rustdeskNode.updateMany({ where: { endpointId }, data: { agentAutoAttempts: 0, agentAutoLastAt: null } });
  }

  // ── The Agent card ────────────────────────────────────────────────────────

  /**
   * The card's "Automatic updates" block. The caller has already checked
   * the person may see this computer (assertEndpointInScope).
   */
  async card(endpointId: string, manualCommand: string | null, now = new Date()) {
    const ep = await this.prisma.endpoint.findUnique({
      where: { id: endpointId },
      select: {
        id: true, status: true, customerId: true, siteId: true, platform: true, agentVersion: true, updateChannel: true, agentSha256: true, lastSeenAt: true,
        site: { select: { id: true, name: true } },
        inventory: { select: { loggedOnUser: true, liveSampledAt: true } },
        rustdeskNode: {
          select: {
            id: true, endpointId: true, agentSecretHash: true, agentAutoTarget: true, agentAutoAttempts: true, agentAutoLastAt: true,
            updateRequestedAt: true, reinstallRequestedAt: true, rdSessionsActive: true, rdSessionsObservedAt: true,
          },
        },
      },
    });
    if (!ep) return null;
    const n = ep.rustdeskNode;
    const settings = await this.settings(true);
    const served = this.served();
    const facts = { platform: ep.platform, updateChannel: ep.updateChannel, agentVersion: ep.agentVersion, agentSha256: ep.updateChannel === 'signed' ? ep.agentSha256 : null, hasSecret: !!n?.agentSecretHash };
    const ch = agentChannel(facts);
    const channel = 'channel' in ch ? ch.channel : null;
    const gov = await this.modeFor(ep, now);
    const pause = await this.containment.blocking('updates', ep.customerId);
    const reported = n?.rdSessionsObservedAt && now.getTime() - n.rdSessionsObservedAt.getTime() < SESSION_COUNT_FRESH_MS ? n.rdSessionsActive : null;
    const migrationOpen = !!(await this.prisma.agentMigration.findFirst({ where: { endpointId, completedAt: null, cancelledAt: null }, select: { id: true } }));
    const liveFresh = !!ep.inventory?.liveSampledAt && now.getTime() - ep.inventory.liveSampledAt.getTime() < LIVE_SAMPLE_FRESH_MS;
    const target = channel ? targetFor(channel, served) : null;
    const st = n ? attemptsFor(n, target) : { attempts: 0, lastAt: null };
    const d: Decision = decide({
      now, settings, archived: ep.status === 'ARCHIVED', facts, served,
      gate: channel ? await this.updateTrust.gateForHeartbeat(channel === 'signed' ? 'signed' : 'legacy') : 'pass',
      mode: gov.mode, windowOpen: gov.windowOpen, skipLoggedOnUser: gov.skipLoggedOnUser,
      paused: !!pause, rollout: await this.rolloutOwns(endpointId),
      pendingRequest: !!n?.updateRequestedAt || !!n?.reinstallRequestedAt || migrationOpen,
      sessionOpen: !!(await openSessionReason(this.prisma, endpointId, reported, now, true)),
      loggedOnUser: liveFresh ? ep.inventory!.loggedOnUser ?? '' : undefined,
      attempts: st.attempts, lastAt: st.lastAt,
    });
    // The pace is the one hold decide() cannot see.
    let reason = d.reason;
    if (d.dispatch === 'new' && (await this.paceUsed(now)) >= settings.perHour) reason = 'pacing';
    const w = gov.mode === 'WINDOW' && gov.policy ? windowState(policyWindow(gov.policy), now) : null;
    const history = await this.prisma.agentAutoUpdateAttempt.findMany({
      where: { endpointId }, orderBy: { dispatchedAt: 'desc' }, take: 10,
      select: { id: true, channel: true, fromVersion: true, targetVersion: true, attempt: true, dispatchedAt: true, outcome: true, resolvedAt: true },
    });
    const silent = !ep.lastSeenAt || now.getTime() - ep.lastSeenAt.getTime() > 10 * 60_000;
    return {
      state: d.state,
      reason,
      text: REASON_TEXT[reason],
      channel,
      target: d.target,
      mode: gov.mode,
      policy: gov.policy ? {
        id: gov.policy.id, scope: gov.policy.scope,
        name: gov.policy.scope === 'group' ? `group ${gov.groupName ?? gov.policy.groupId}` : gov.policy.scope === 'site' ? `site ${ep.site?.name ?? gov.policy.siteId}` : 'business policy',
        window: gov.mode === 'WINDOW' ? describeWindow(policyWindow(gov.policy)) : null,
      } : null,
      window: w ? { open: w.open, opensAt: w.opensAt, closesAt: w.closesAt } : null,
      attempts: { made: st.attempts, max: settings.maxAttempts, lastAt: st.lastAt },
      nextAt: d.nextAt,
      // Only for a computer that is waiting on the agent itself to check in.
      waitingForCheckIn: silent && (d.state === 'queued' || d.state === 'updating'),
      manual: d.state === 'manual' ? { command: manualCommand } : null,
      history: history.map((h) => ({ ...h, automatic: true })),
    };
  }

  private paceUsed(now: Date) {
    return this.prisma.agentAutoUpdateAttempt.count({ where: { dispatchedAt: { gt: new Date(now.getTime() - 3600_000) } } });
  }

  // ── Settings (Platform Admin) ─────────────────────────────────────────────

  async getSettings(actor: ActorContext) {
    this.acl.assertPlatformAdmin(actor);
    const now = new Date();
    const s = await this.settings(true);
    const served = this.served();
    const failingWhere: Prisma.RustdeskNodeWhereInput = {
      agentAutoAttempts: { gte: s.maxAttempts }, agentAutoLastAt: { lt: new Date(now.getTime() - ATTEMPT_WINDOW_MS - VERIFY_GRACE_MS) },
      agentAutoTarget: { in: [served.version, ...(served.signedSha256 ? [served.signedSha256] : [])] },
    };
    const [usedHour, day, failing, failingRows] = await Promise.all([
      this.paceUsed(now),
      this.prisma.agentAutoUpdateAttempt.groupBy({ by: ['outcome'], where: { dispatchedAt: { gt: new Date(now.getTime() - 86_400_000) } }, _count: { _all: true } }),
      this.prisma.rustdeskNode.count({ where: failingWhere }),
      this.prisma.rustdeskNode.findMany({
        where: failingWhere, take: 100, orderBy: { agentAutoLastAt: 'desc' },
        select: { agentAutoAttempts: true, agentAutoLastAt: true, endpoint: { select: { id: true, name: true, agentVersion: true, customer: { select: { id: true, name: true } } } } },
      }),
    ]);
    const count = (o: string | null) => day.find((x) => x.outcome === o)?._count._all ?? 0;
    return {
      ...s,
      served: { version: served.version, signedSha256: served.signedSha256 },
      pace: { usedLastHour: usedHour, perHour: s.perHour },
      lastDay: { started: day.reduce((a, x) => a + x._count._all, 0), updated: count('updated'), open: count(null), superseded: count('superseded') },
      failing: {
        count: failing,
        computers: failingRows.map((r) => ({ id: r.endpoint.id, name: r.endpoint.name, business: r.endpoint.customer, agentVersion: r.endpoint.agentVersion, attempts: r.agentAutoAttempts, lastAt: r.agentAutoLastAt })),
      },
    };
  }

  async putSettings(actor: ActorContext, body: unknown, freshMethod: string | null) {
    this.acl.assertPlatformAdmin(actor);
    let data;
    try { data = parseSettingsUpdate(body); } catch (e) {
      throw new BadRequestException({ code: 'INVALID_AGENT_AUTO_UPDATE', message: (e as Error).message });
    }
    assertFresh(freshMethod, { action: 'agent.autoupdate', message: 'Changing automatic agent updates decides when the server re-runs the installer across the whole fleet: confirm it is you.' });
    const before = await this.settings(true);
    const update = {
      ...(data.enabled !== undefined ? { agentAutoUpdateEnabled: data.enabled } : {}),
      ...(data.perHour !== undefined ? { agentAutoUpdatePerHour: data.perHour } : {}),
      ...(data.maxAttempts !== undefined ? { agentAutoUpdateMaxAttempts: data.maxAttempts } : {}),
    };
    await this.prisma.platformSettings.upsert({ where: { id: 'singleton' }, create: { id: 'singleton', ...update }, update });
    this.settingsCache = null;
    // A new pace is counted afresh in this process, not after the recheck delay.
    this.paceFullUntil = 0;
    const after = await this.settings(true);
    const shape = (x: AgentAutoSettings) => ({ enabled: x.enabled, perHour: x.perHour, maxAttempts: x.maxAttempts });
    if (JSON.stringify(shape(before)) !== JSON.stringify(shape(after))) {
      await this.audit.log({
        actorId: actor.userId, actorIp: actor.ip,
        action: 'AGENT_AUTO_UPDATE_SETTINGS_CHANGED', resource: 'platform_settings', resourceId: 'singleton',
        meta: { before: shape(before), after: shape(after) },
      });
    }
    return after;
  }
}
