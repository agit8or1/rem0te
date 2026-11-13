import { BadRequestException, ConflictException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { ContainmentService } from '../containment/containment.service';
import { pauseMessage } from '../containment/pause';
import { UpdateTrustService } from '../update-trust/update-trust.service';
import { AgentMigrationService } from '../update-trust/agent-migration.service';
import {
  FULL_AGENT, HOLD_TEXT, isWindows, migrationBlock, migrationState, PUBLISH_COMMAND, SETUP_COMMAND, STATUS_COMMAND, TIMESTAMP_TIMER,
  type MigrationFacts,
} from '../update-trust/agent-migration';
import { AgentAutoUpdateService } from '../agent-auto-update/agent-auto-update.service';
import { ROLLOUT_OPEN } from '../client-updates/policy';
import { assertFresh } from '../security-controls/review';
import { readOnlyAgentOs } from '../common/platform';
import { heartbeatCutoff, HEARTBEAT_STALE_MS } from '../common/connectivity';
import { servedAgentVersion } from '../common/served-version';
import {
  budget, canaryOrder, gate, GATE_TEXT, HOLD_LABEL, holdOf, isWidening, nextStep, onBuild, parseSettingsUpdate, reporting, settingsFrom,
  STATE_TEXT, type AutoMigrationSettings, type CanaryFacts, type HoldCode, type RolloutState, type Step,
} from './rollout';

const SWEEP_SECONDS_DEFAULT = 60;
const SETTINGS_SELECT = { agentAutoMigrationMode: true, agentAutoMigrationSoakMinutes: true } as const;
const OPEN = { completedAt: null, cancelledAt: null } as const;
const AGENT_TARGET = 'windows/rem0te-agent.exe';
const TRAY_TARGET = 'windows/rem0te-tray.exe';
/** 2–4 dot-separated numeric parts of at most six digits (no regex: the linter refuses nested quantifiers). */
const dotted = (v: string) => { const p = v.split('.'); return p.length >= 2 && p.length <= 4 && p.every((x) => /^[0-9]{1,6}$/.test(x)); };
const COMMIT_RE = /^[0-9a-f]{40}$/;

type Rollout = Prisma.AgentAutoMigrationGetPayload<object>;

/**
 * Automatic migration to the signed agent (0.37). The rules are in
 * rollout.ts; this is where they meet the database.
 *
 *   - The sweep (every AUTO_MIGRATION_SWEEP_SECONDS, default 60;
 *     AUTO_MIGRATION_SWEEP=off stops it) runs one rollout per published
 *     signed agent build, canary first. Its only effect on a computer is an
 *     AgentMigration row made through AgentMigrationService.requestAutomatic,
 *     which re-checks the 0.34 preconditions (migrationBlock: Signed only,
 *     an updates pause, a staged rollout, no device secret…) at the moment
 *     of writing; the heartbeat then hands it out exactly as it hands out a
 *     person's request, and re-applies the same holds.
 *   - The rollout's steps are audited as the system (no actor): canary
 *     chosen, confirmed, rolling, halted. The per-computer requests are not
 *     — they are history rows (AgentMigration.automatic), like 0.36's
 *     AgentAutoUpdateAttempt.
 *   - Settings, resume and restart are Platform Admin. Turning it on,
 *     shortening the soak, resuming and restarting need fresh
 *     authentication; turning it off never does.
 *   - overview(): the Full agent page. Its counts come only from computers
 *     the person can see (acl.endpointVisibilityWhere); the repository, the
 *     mode and the rollout's state are platform facts, and the canary is
 *     named only to someone who can see it.
 *
 * This never writes the platform's update-trust mode
 * (check-security-invariants §57).
 */
@Injectable()
export class AgentAutoMigrationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('AgentAutoMigration');
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly acl: AccessControlService,
    private readonly containment: ContainmentService,
    private readonly updateTrust: UpdateTrustService,
    private readonly migration: AgentMigrationService,
    private readonly auto: AgentAutoUpdateService,
  ) {}

  onModuleInit() {
    if (process.env.AUTO_MIGRATION_SWEEP === 'off') return;
    const s = Number(process.env.AUTO_MIGRATION_SWEEP_SECONDS ?? SWEEP_SECONDS_DEFAULT);
    const ms = Number.isFinite(s) && s >= 1 && s <= 3600 ? s * 1000 : SWEEP_SECONDS_DEFAULT * 1000;
    this.timer = setInterval(() => { void this.tick(); }, ms);
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  // ── Facts ─────────────────────────────────────────────────────────────────

  async settings(): Promise<AutoMigrationSettings> {
    const row = await this.prisma.platformSettings.findUnique({ where: { id: 'singleton' }, select: SETTINGS_SELECT });
    return settingsFrom(row);
  }

  /** The published signed agent (and tray): digest from the served file, version and commit from the signed target's custom. */
  published() {
    const agent = this.updateTrust.agentTarget();
    if (!agent) return { agent: null, tray: null };
    const st = this.updateTrust.status();
    const custom = (name: string) => {
      const c = st.targets?.find((t) => t.name === name)?.custom ?? {};
      return {
        version: typeof c.version === 'string' && dotted(c.version) ? c.version : null,
        commit: typeof c.commit === 'string' && COMMIT_RE.test(c.commit) ? c.commit : null,
      };
    };
    const tray = this.updateTrust.trayTarget();
    return {
      agent: { sha256: agent.sha256, ...custom(AGENT_TARGET) },
      tray: tray ? { sha256: tray.sha256, ...custom(TRAY_TARGET) } : null,
    };
  }

  private async gateNow() {
    const [settings, trust] = await Promise.all([this.settings(), this.updateTrust.mode()]);
    const { agent } = this.published();
    const g = gate({ settings, repoConfigured: this.updateTrust.isConfigured(), publishedSha256: agent?.sha256 ?? null, trustMode: trust.mode });
    return { settings, trust, agent, gate: g };
  }

  // ── The sweep ─────────────────────────────────────────────────────────────

  /**
   * One pass. Only one API process acts at a time (a transaction-scoped
   * advisory lock, tried, never waited for). Best-effort: a failure is
   * logged and the next tick tries again.
   */
  async tick(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const g = await this.gateNow();
      if (g.gate || !g.agent) return;
      await this.prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRawUnsafe<{ ok: boolean }[]>(`SELECT pg_try_advisory_xact_lock(hashtext('rem0te.agent-auto-migration')) AS ok`);
        if (!rows[0]?.ok) return;
        const rollout = await this.rolloutFor(g.agent!);
        await this.advance(rollout, g.settings, now);
      }, { timeout: 120_000, maxWait: 5_000 });
    } catch (e) {
      this.logger.warn(`automatic migration sweep: ${String(e)}`);
    } finally {
      this.running = false;
    }
  }

  private async rolloutFor(agent: { sha256: string; version: string | null; commit: string | null }): Promise<Rollout> {
    return this.prisma.agentAutoMigration.upsert({
      where: { targetSha256: agent.sha256 },
      update: {},
      create: { targetSha256: agent.sha256, targetVersion: agent.version, targetCommit: agent.commit },
    });
  }

  private async canaryFacts(r: Rollout): Promise<CanaryFacts | null> {
    if (!r.canaryEndpointId) return null;
    const [ep, mig] = await Promise.all([
      this.prisma.endpoint.findUnique({
        where: { id: r.canaryEndpointId },
        select: { status: true, updateChannel: true, agentSha256: true, lastSeenAt: true, agentUpdateCheckedAt: true, agentUpdateResult: true },
      }),
      r.canaryMigrationId ? this.prisma.agentMigration.findUnique({ where: { id: r.canaryMigrationId }, select: { cancelledAt: true, cancelledById: true } }) : null,
    ]);
    if (!ep) return { exists: false, updateChannel: null, agentSha256: null, lastSeenAt: null, agentUpdateCheckedAt: null, agentUpdateResult: null, requestCancelledByPerson: false };
    return {
      exists: ep.status !== 'ARCHIVED', updateChannel: ep.updateChannel, agentSha256: ep.agentSha256, lastSeenAt: ep.lastSeenAt,
      agentUpdateCheckedAt: ep.agentUpdateCheckedAt, agentUpdateResult: ep.agentUpdateResult,
      requestCancelledByPerson: !!mig?.cancelledAt && !!mig.cancelledById,
    };
  }

  /** Apply one step. Every write is conditional on the state this pass read. */
  private async advance(r: Rollout, settings: AutoMigrationSettings, now: Date): Promise<Step> {
    const canary = await this.canaryFacts(r);
    const step = nextStep({ ...r, state: r.state as RolloutState }, canary, now, settings.soakMinutes);
    const sys = (action: Parameters<AuditService['log']>[0]['action'], meta: Record<string, unknown>, ep?: { tenantId: string | null; customerId: string | null } | null) =>
      this.audit.log({
        tenantId: ep?.tenantId ?? undefined, customerId: ep?.customerId ?? undefined,
        action, resource: 'agent_auto_migration', resourceId: r.id,
        meta: { targetSha256: r.targetSha256, targetVersion: r.targetVersion, ...meta },
      });
    const canaryEp = r.canaryEndpointId ? await this.prisma.endpoint.findUnique({ where: { id: r.canaryEndpointId }, select: { tenantId: true, customerId: true } }) : null;
    switch (step.do) {
      case 'choose_canary': {
        const picked = await this.chooseCanary(r, now);
        if (picked) {
          await sys('AGENT_AUTO_MIGRATION_CANARY_CHOSEN', { endpointId: picked.endpointId, migrationId: picked.migrationId }, picked.ep);
        }
        break;
      }
      case 'confirm': {
        const w = await this.prisma.agentAutoMigration.updateMany({ where: { id: r.id, state: 'canary' }, data: { state: 'soaking', canaryConfirmedAt: now } });
        if (w.count === 1) await sys('AGENT_AUTO_MIGRATION_CANARY_CONFIRMED', { endpointId: r.canaryEndpointId, soakMinutes: settings.soakMinutes }, canaryEp);
        break;
      }
      case 'start_rolling': {
        const w = await this.prisma.agentAutoMigration.updateMany({ where: { id: r.id, state: 'soaking' }, data: { state: 'rolling', rollingAt: now } });
        if (w.count === 1) await sys('AGENT_AUTO_MIGRATION_ROLLING', { endpointId: r.canaryEndpointId, soakMinutes: settings.soakMinutes });
        break;
      }
      case 'halt': {
        let reason = step.reason;
        if (step.code === 'canary_not_confirmed' && r.canaryMigrationId) {
          const m = await this.prisma.agentMigration.findUnique({ where: { id: r.canaryMigrationId }, select: { holdReason: true } });
          if (m?.holdReason) reason += ` Its request was ${HOLD_TEXT[m.holdReason] ?? m.holdReason}.`;
        }
        const w = await this.prisma.agentAutoMigration.updateMany({
          where: { id: r.id, state: r.state }, data: { state: 'halted', haltedAt: now, haltCode: step.code, haltReason: reason.slice(0, 500) },
        });
        if (w.count === 1) {
          // A halted rollout stops its own canary request, so a failing
          // migration is not re-run every 30 minutes. A person's request is
          // never touched (cancelAutomatic matches automatic rows only).
          if (r.canaryMigrationId) await this.migration.cancelAutomatic(r.canaryMigrationId);
          await sys('AGENT_AUTO_MIGRATION_HALTED', { endpointId: r.canaryEndpointId, code: step.code, reason }, canaryEp);
        }
        break;
      }
      case 'migrate_rest':
        await this.migrateRest(r, now);
        break;
      default:
        break;
    }
    return step;
  }

  /**
   * Standard Windows computers the automatic migration could ask, in the
   * order it would: reporting, with a device secret, not archived, no open
   * request, never cancelled by a person, not already asked by this rollout.
   * The precondition function decides the rest, per computer, at write time.
   */
  private candidates(r: Rollout, now: Date, exclude: string[], take: number) {
    return this.prisma.endpoint.findMany({
      where: {
        platform: { startsWith: 'windows', mode: 'insensitive' },
        OR: [{ updateChannel: null }, { updateChannel: { not: 'signed' } }],
        status: { not: 'ARCHIVED' },
        isOnline: true,
        lastSeenAt: { gte: heartbeatCutoff(now.getTime()) },
        rustdeskNode: { agentSecretHash: { not: null } },
        agentMigrations: { none: { OR: [{ ...OPEN }, { cancelledById: { not: null } }, { rolloutId: r.id }] } },
        ...(exclude.length ? { id: { notIn: exclude } } : {}),
      },
      select: { id: true, tenantId: true, customerId: true, siteId: true, platform: true, isOnline: true, lastSeenAt: true },
      orderBy: [{ lastSeenAt: 'desc' }, { id: 'asc' }],
      take,
    });
  }

  /** The update policy opts this computer out, or its window is shut: not now. */
  private async policyAllows(ep: { id: string; customerId: string | null; siteId: string | null }, now: Date): Promise<boolean> {
    const m = await this.auto.modeFor(ep, now);
    return m.mode !== 'OFF' && !(m.mode === 'WINDOW' && !m.windowOpen);
  }

  private async chooseCanary(r: Rollout, now: Date) {
    const cands = canaryOrder((await this.candidates(r, now, r.rejectedCanaryIds, 50)).filter((c) => isWindows(c.platform)), r.rejectedCanaryIds, now, HEARTBEAT_STALE_MS);
    for (const c of cands) {
      if (!(await this.policyAllows(c, now))) continue;
      const res = await this.migration.requestAutomatic(c.id, r.id, 'canary');
      if ('refused' in res) continue;
      const w = await this.prisma.agentAutoMigration.updateMany({
        where: { id: r.id, state: 'choosing_canary' },
        data: { state: 'canary', canaryEndpointId: c.id, canaryMigrationId: res.id, canaryRequestedAt: now, canaryConfirmedAt: null },
      });
      if (w.count !== 1) { await this.migration.cancelAutomatic(res.id); return null; }
      return { endpointId: c.id, migrationId: res.id, ep: { tenantId: c.tenantId, customerId: c.customerId } };
    }
    return null;
  }

  /** The automatic requests made in the last hour, against the 0.36 pace (agentAutoUpdatePerHour). */
  private usedLastHour(now: Date) {
    return this.prisma.agentMigration.count({ where: { automatic: true, requestedAt: { gt: new Date(now.getTime() - 3600_000) } } });
  }

  private async migrateRest(r: Rollout, now: Date) {
    const pace = await this.auto.settings(true);
    let left = budget(pace.perHour, await this.usedLastHour(now));
    if (left <= 0) return 0;
    const cands = (await this.candidates(r, now, [], left * 4)).filter((c) => isWindows(c.platform) && reporting(c, now, HEARTBEAT_STALE_MS));
    let made = 0;
    for (const c of cands) {
      if (left <= 0) break;
      if (!(await this.policyAllows(c, now))) continue;
      const res = await this.migration.requestAutomatic(c.id, r.id, 'rollout');
      if ('refused' in res) continue;
      made++; left--;
    }
    return made;
  }

  // ── Settings, resume, restart (Platform Admin) ────────────────────────────

  async getSettings(actor: ActorContext) {
    this.acl.assertPlatformAdmin(actor);
    return this.settings();
  }

  async putSettings(actor: ActorContext, body: unknown, freshMethod: string | null) {
    this.acl.assertPlatformAdmin(actor);
    let data;
    try { data = parseSettingsUpdate(body); } catch (e) {
      throw new BadRequestException({ code: 'INVALID_AUTO_MIGRATION', message: (e as Error).message });
    }
    const before = await this.settings();
    const next = { mode: data.mode ?? before.mode, soakMinutes: data.soakMinutes ?? before.soakMinutes };
    if (isWidening(before, next)) {
      assertFresh(freshMethod, { action: 'agent.automigrate', message: 'Turning on automatic migration, or shortening its soak, decides when the portal moves computers to the signed agent by itself: confirm it is you.' });
    }
    const update = { agentAutoMigrationMode: next.mode, agentAutoMigrationSoakMinutes: next.soakMinutes };
    await this.prisma.platformSettings.upsert({ where: { id: 'singleton' }, create: { id: 'singleton', ...update }, update });
    const after = await this.settings();
    const shape = (x: AutoMigrationSettings) => ({ mode: x.mode, soakMinutes: x.soakMinutes });
    if (JSON.stringify(shape(before)) !== JSON.stringify(shape(after))) {
      await this.audit.log({
        actorId: actor.userId, actorIp: actor.ip,
        action: 'AGENT_AUTO_MIGRATION_SETTINGS_CHANGED', resource: 'platform_settings', resourceId: 'singleton',
        meta: { before: shape(before), after: shape(after) },
      });
    }
    return after;
  }

  private async current(): Promise<Rollout | null> {
    const { agent } = this.published();
    return agent ? this.prisma.agentAutoMigration.findUnique({ where: { targetSha256: agent.sha256 } }) : null;
  }

  /**
   * Resume a halted rollout with the SAME canary, its clocks from now: if it
   * reports the published build, it soaks again; otherwise it is asked again
   * (a new request, re-checked like any other). Never skips the canary.
   */
  async resume(actor: ActorContext, freshMethod: string | null) {
    this.acl.assertPlatformAdmin(actor);
    assertFresh(freshMethod, { action: 'agent.automigrate', message: 'Resuming the automatic migration moves computers to the signed agent: confirm it is you.' });
    const r = await this.current();
    if (!r || r.state !== 'halted') throw new ConflictException({ code: 'NOT_HALTED', message: 'There is no halted automatic migration for the published signed agent.' });
    if (!r.canaryEndpointId) throw new ConflictException({ code: 'NO_CANARY', message: 'This rollout has no canary to resume with; restart it with another canary.' });
    const now = new Date();
    const facts = await this.canaryFacts(r);
    let data: Prisma.AgentAutoMigrationUpdateManyMutationInput;
    let migrationId: string | null = r.canaryMigrationId;
    if (facts?.exists && onBuild(facts, r.targetSha256)) {
      data = { state: 'soaking', canaryConfirmedAt: now, haltedAt: null, haltCode: null, haltReason: null };
    } else {
      const res = await this.migration.requestAutomatic(r.canaryEndpointId, r.id, 'canary');
      if ('refused' in res) {
        throw new ConflictException({ code: 'CANARY_NOT_ELIGIBLE', message: `The canary cannot be asked again (${res.refused}). Restart with another canary.` });
      }
      migrationId = res.id;
      data = { state: 'canary', canaryMigrationId: res.id, canaryRequestedAt: now, canaryConfirmedAt: null, haltedAt: null, haltCode: null, haltReason: null };
    }
    const w = await this.prisma.agentAutoMigration.updateMany({ where: { id: r.id, state: 'halted' }, data });
    if (w.count !== 1) {
      if (migrationId && migrationId !== r.canaryMigrationId) await this.migration.cancelAutomatic(migrationId);
      throw new ConflictException({ code: 'NOT_HALTED', message: 'The rollout changed meanwhile; reload.' });
    }
    await this.audit.log({
      actorId: actor.userId, actorIp: actor.ip, action: 'AGENT_AUTO_MIGRATION_RESUMED', resource: 'agent_auto_migration', resourceId: r.id,
      meta: { targetSha256: r.targetSha256, endpointId: r.canaryEndpointId, wasHalted: { code: r.haltCode, reason: r.haltReason }, now: data.state },
    });
    return { state: data.state as RolloutState };
  }

  /** Restart a halted rollout with another canary; the old one is never picked again for this build. */
  async restart(actor: ActorContext, freshMethod: string | null) {
    this.acl.assertPlatformAdmin(actor);
    assertFresh(freshMethod, { action: 'agent.automigrate', message: 'Restarting the automatic migration picks another computer to move to the signed agent: confirm it is you.' });
    const r = await this.current();
    if (!r || r.state !== 'halted') throw new ConflictException({ code: 'NOT_HALTED', message: 'There is no halted automatic migration for the published signed agent.' });
    const rejected = r.canaryEndpointId && !r.rejectedCanaryIds.includes(r.canaryEndpointId) ? [...r.rejectedCanaryIds, r.canaryEndpointId] : r.rejectedCanaryIds;
    const w = await this.prisma.agentAutoMigration.updateMany({
      where: { id: r.id, state: 'halted' },
      data: {
        state: 'choosing_canary', rejectedCanaryIds: rejected, canaryEndpointId: null, canaryMigrationId: null, canaryRequestedAt: null,
        canaryConfirmedAt: null, haltedAt: null, haltCode: null, haltReason: null,
      },
    });
    if (w.count !== 1) throw new ConflictException({ code: 'NOT_HALTED', message: 'The rollout changed meanwhile; reload.' });
    if (r.canaryMigrationId) await this.migration.cancelAutomatic(r.canaryMigrationId);
    await this.audit.log({
      actorId: actor.userId, actorIp: actor.ip, action: 'AGENT_AUTO_MIGRATION_RESTARTED', resource: 'agent_auto_migration', resourceId: r.id,
      meta: { targetSha256: r.targetSha256, previousCanary: r.canaryEndpointId, wasHalted: { code: r.haltCode, reason: r.haltReason } },
    });
    return { state: 'choosing_canary' as RolloutState };
  }

  // ── The Full agent page ───────────────────────────────────────────────────

  /**
   * GET /agent-signing/overview. The caller holds computers:view (route).
   * Counts and the list come only from computers this person can see; the
   * repository, the mode and the rollout's state are platform facts.
   */
  async overview(actor: ActorContext, businessId: string | null, now = new Date()) {
    const status = this.updateTrust.status(now);
    const pub = this.published();
    const portalVersion = servedAgentVersion();
    const g = await this.gateNow();
    const ts = status.roles?.timestamp ?? null;
    const tsLeftH = ts ? (new Date(ts.expires).getTime() - now.getTime()) / 3600_000 : null;

    // ── Step 4: the computers this person can see ──
    const vis = this.acl.endpointVisibilityWhere(actor, businessId);
    const eps = await this.prisma.endpoint.findMany({
      where: { AND: [vis] },
      select: {
        id: true, name: true, hostname: true, platform: true, updateChannel: true, agentSha256: true, agentVersion: true, status: true,
        isOnline: true, lastSeenAt: true, customerId: true, siteId: true, customer: { select: { id: true, name: true } },
        rustdeskNode: { select: { agentSecretHash: true } },
      },
      orderBy: { lastSeenAt: 'desc' },
      take: 5000,
    });
    const ids = eps.map((e) => e.id);
    const [migs, rollouts, portalHost] = await Promise.all([
      ids.length ? this.prisma.agentMigration.findMany({
        where: { endpointId: { in: ids } }, orderBy: { requestedAt: 'desc' },
        select: { id: true, endpointId: true, automatic: true, requestedAt: true, dispatchedAt: true, lastDispatchedAt: true, fetchedAt: true, holdReason: true, holdAt: true, completedAt: true, cancelledAt: true, cancelledById: true },
      }) : [],
      ids.length ? this.prisma.updateJob.findMany({ where: { endpointId: { in: ids }, status: { in: [...ROLLOUT_OPEN] } }, select: { endpointId: true } }) : [],
      this.migration.portalHost(),
    ]);
    const latest = new Map<string, (typeof migs)[number]>();
    const cancelledByPerson = new Set<string>();
    for (const m of migs) {
      if (!latest.has(m.endpointId)) latest.set(m.endpointId, m);
      if (m.cancelledAt && m.cancelledById) cancelledByPerson.add(m.endpointId);
    }
    const inRollout = new Set(rollouts.map((x) => x.endpointId));
    const pauseByBiz = new Map<string, string | null>();
    const pauseFor = async (customerId: string | null) => {
      const k = customerId ?? '';
      if (!pauseByBiz.has(k)) {
        const p = await this.containment.blocking('updates', customerId);
        pauseByBiz.set(k, p ? pauseMessage(p, 'updates') : null);
      }
      return pauseByBiz.get(k)!;
    };
    const standardEps = eps.filter((e) => !readOnlyAgentOs(e.platform) && isWindows(e.platform) && e.updateChannel !== 'signed');
    const modes = await this.auto.modesFor(standardEps, now);

    type Kind = 'standard' | 'migrating' | 'signed' | 'held' | 'not_eligible';
    const counts: Record<Kind, number> = { standard: 0, migrating: 0, signed: 0, held: 0, not_eligible: 0 };
    const holds: Partial<Record<HoldCode, number>> = {};
    const notEligible = { linux: 0, macos: 0, other: 0 };
    let signedOnBuild = 0;
    const rows: {
      id: string; name: string; business: { id: string; name: string } | null; kind: Kind; text: string; hold: HoldCode | null;
      online: boolean; lastSeenAt: Date | null; agentVersion: string | null; onPublishedBuild: boolean | null; automatic: boolean | null;
    }[] = [];
    for (const e of eps) {
      const os = readOnlyAgentOs(e.platform);
      const base = { id: e.id, name: e.hostname ?? e.name, business: e.customer, online: e.isOnline, lastSeenAt: e.lastSeenAt, agentVersion: e.agentVersion };
      const m = latest.get(e.id) ?? null;
      let kind: Kind; let text: string; let hold: HoldCode | null = null; let onPub: boolean | null = null;
      if (os || !isWindows(e.platform)) {
        kind = 'not_eligible';
        if (os === 'Linux') notEligible.linux++; else if (os === 'macOS') notEligible.macos++; else notEligible.other++;
        text = os ? `There is no signed agent for ${os}; the ${os} agent only reports.` : 'Has not reported Windows.';
      } else if (e.updateChannel === 'signed') {
        kind = 'signed';
        onPub = pub.agent ? e.agentSha256 === pub.agent.sha256 : null;
        if (onPub) signedOnBuild++;
        text = onPub ? 'Signed agent, on the published build.' : pub.agent ? 'Signed agent, on another build; it updates itself.' : 'Signed agent.';
      } else if (m && !m.completedAt && !m.cancelledAt) {
        kind = 'migrating';
        text = `${m.automatic ? 'Automatic' : 'Requested'}: ${migrationState(m, now.getTime()).text}`;
      } else {
        const facts: MigrationFacts = {
          platform: e.platform, updateChannel: e.updateChannel, status: e.status, hasSecret: !!e.rustdeskNode?.agentSecretHash,
          repoConfigured: this.updateTrust.isConfigured(), signedAgentPublished: !!pub.agent, portalHost,
          mode: g.trust.mode, legacyPortalMigration: g.trust.legacyPortalMigration,
          updatesPause: await pauseFor(e.customerId), inRollout: inRollout.has(e.id),
        };
        const b = migrationBlock(facts);
        hold = holdOf(b?.code ?? null);
        const mode = modes.get(e.id);
        if (!hold && cancelledByPerson.has(e.id)) hold = 'cancelled_by_person';
        if (!hold && mode?.mode === 'OFF') hold = 'opted_out';
        if (!hold && mode?.mode === 'WINDOW' && !mode.windowOpen) hold = 'outside_window';
        if (!hold && !reporting(e, now, HEARTBEAT_STALE_MS)) hold = 'offline';
        if (hold) {
          kind = 'held';
          holds[hold] = (holds[hold] ?? 0) + 1;
          text = hold === 'other' && b ? b.reason : HOLD_LABEL[hold];
        } else {
          kind = 'standard';
          text = b ? b.reason : 'Standard agent; waiting its turn.';
        }
      }
      counts[kind]++;
      rows.push({ ...base, kind, text, hold, onPublishedBuild: onPub, automatic: m ? m.automatic : null });
    }
    const order: Kind[] = ['migrating', 'held', 'standard', 'signed', 'not_eligible'];
    rows.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));

    // ── The automatic migration: platform facts ──
    const r = await this.current();
    let rollout: null | Record<string, unknown> = null;
    if (r) {
      const canaryVisible = r.canaryEndpointId
        ? await this.prisma.endpoint.findFirst({ where: { AND: [{ id: r.canaryEndpointId }, vis] }, select: { id: true, name: true, hostname: true } })
        : null;
      const facts = await this.canaryFacts(r);
      const step = g.gate ? null : nextStep({ ...r, state: r.state as RolloutState }, facts, now, g.settings.soakMinutes);
      const progress = actor.isPlatformAdmin ? await this.progress(r.id) : null;
      rollout = {
        id: r.id, state: r.state, text: r.state === 'halted' ? `Halted: ${r.haltReason}` : STATE_TEXT[r.state as RolloutState],
        targetSha256: r.targetSha256, targetVersion: r.targetVersion,
        canary: r.canaryEndpointId ? (canaryVisible ? { id: canaryVisible.id, name: canaryVisible.hostname ?? canaryVisible.name } : { id: null, name: 'a computer in another business' }) : null,
        canaryRequestedAt: r.canaryRequestedAt, canaryConfirmedAt: r.canaryConfirmedAt,
        soakEndsAt: r.state === 'soaking' && r.canaryConfirmedAt ? new Date(r.canaryConfirmedAt.getTime() + g.settings.soakMinutes * 60_000) : null,
        waitUntil: step?.do === 'wait' ? step.until : null, waitText: step?.do === 'wait' ? step.text : null,
        halted: r.state === 'halted' ? { at: r.haltedAt, code: r.haltCode, reason: r.haltReason } : null,
        rollingAt: r.rollingAt, triedCanaries: r.rejectedCanaryIds.length,
        progress,
      };
    }
    const pace = await this.auto.settings();

    return {
      platformAdmin: actor.isPlatformAdmin,
      steps: {
        signing: {
          done: status.configured,
          reason: status.configured ? null : status.reason ?? null,
          command: SETUP_COMMAND,
          docs: '/docs/update-signing#the-easy-way',
        },
        published: {
          done: !!pub.agent,
          agent: pub.agent, tray: pub.tray,
          portalVersion,
          behind: pub.agent?.version && dotted(portalVersion) ? pub.agent.version !== portalVersion : null,
          command: PUBLISH_COMMAND,
        },
        timestamp: {
          done: tsLeftH !== null && tsLeftH > 48,
          expires: ts?.expires ?? null,
          hoursLeft: tsLeftH === null ? null : Math.floor(tsLeftH),
          state: tsLeftH === null ? 'unknown' : tsLeftH <= 0 ? 'expired' : tsLeftH < 48 ? 'expiring' : 'fresh',
          command: STATUS_COMMAND,
          timer: TIMESTAMP_TIMER,
        },
        computers: {
          done: counts.standard + counts.migrating + counts.held === 0 && counts.signed > 0,
          counts, holds, notEligible, signedOnBuild,
          holdLabels: HOLD_LABEL,
          auto: {
            mode: g.settings.mode, soakMinutes: g.settings.soakMinutes, processOn: g.settings.processOn,
            gate: g.gate, gateText: g.gate ? GATE_TEXT[g.gate] : null,
            perHour: pace.perHour,
            trustMode: g.trust.mode, legacyPortalMigration: g.trust.legacyPortalMigration,
            rollout,
          },
          rows: rows.slice(0, 500), total: rows.length,
        },
      },
      links: { fullAgent: FULL_AGENT.href, migrations: '/endpoints/agent-migrations', updateSigning: '/settings/security/update-signing' },
    };
  }

  /** Platform Admin only: this rollout's automatic requests, fleet-wide. */
  private async progress(rolloutId: string) {
    const rows = await this.prisma.agentMigration.findMany({ where: { rolloutId }, select: { completedAt: true, cancelledAt: true } });
    return {
      requested: rows.length,
      completed: rows.filter((x) => x.completedAt).length,
      open: rows.filter((x) => !x.completedAt && !x.cancelledAt).length,
      stopped: rows.filter((x) => x.cancelledAt).length,
    };
  }
}
