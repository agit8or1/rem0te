import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, type MonitorAlert, type MonitorRule } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { validatePeerUrl } from '../integration/peers';
import {
  agentMonitorConfig, dedupKeyOf, type Destination, isEmailDestination, dueLevels, effectiveRules, EMPTY_STATE, evaluateEvents, evaluateLive, evaluateService, evaluateWarranty,
  NotifyLevel, OUTAGE, outageDecision, outageKeyOf, sanitizeReport, scopesFor, SEVERITY_RANK, suppressionFor,
  drivePrefixOf, evaluateDrives, evaluateFailedUpdates, evaluateMissingUpdates, evaluateUptime, type SeenUpdates,
  ASSET_ID, assetKeyOf, BACKUP_KINDS, evaluateBackup,
  type Live, type MonitorStateLike, type RuleLike, type Severity, type Verdict,
} from './engine';
import { AlertTicketsService } from './alert-tickets.service';
import { AlertEventsService } from './alert-events.service';
import { EmailService } from '../email/email.service';
import { alertMail } from '../email/mail-content';
import { PublicUrlService } from '../platform/public-url.service';
import { GroupMembershipService } from '../group-policy/membership.service';
import { classifyEvents, classifyThreshold, worse, type Classification } from './classify';
import { QualityEngineService } from './quality-engine.service';

/**
 * Monitoring (v0.29): the evaluator, the sweep and the notifier.
 *
 *   heartbeat      → onLiveSample: disk, processor and memory monitors
 *   monitor-report → ingestReport: service and event monitors
 *   sweep (60 s)   → offline, agent-silent and restart-pending monitors, event-alert
 *                    clearing, orphan clean-up, site outage correlation,
 *                    then notification and escalation
 *
 * Monitoring is read-side. It changes nothing on a computer, it keeps running
 * during a containment pause (that is when you most want it), and a
 * maintenance window — MonitorSuppression — only silences who is TOLD: the
 * alert is still raised and shown. Neither a window nor anything else here
 * touches ContainmentPause or SecurityAlert.
 *
 * Two sweepers (two API instances) are safe: alert creation loses on the
 * partial unique index, and every notification is claimed with a
 * compare-and-set on `escalationLevel` before it is sent. MONITOR_SWEEP=off
 * turns the sweep off in a process anyway.
 */

type Ep = { id: string; tenantId: string | null; customerId: string | null; siteId: string | null; name: string; platform?: string | null; osVersion?: string | null };
type Policy = { scopeKey: string; levels: NotifyLevel[]; ticketing: { enabled: boolean; minSeverity: Severity } };

const LIVE_KINDS = new Set(['DISK_FREE', 'CPU_HIGH', 'MEMORY_HIGH']);
/** 0.36: AGENT_SILENT — reachable through RustDesk, agent not checking in (opt-in). */
const SWEEP_KINDS = new Set(['OFFLINE', 'REBOOT_PENDING', 'AGENT_SILENT']);
/** What the agent is asked about and reports on: the heartbeat's monitor block and the monitor report. */
const AGENT_KINDS: ReadonlySet<string> = new Set(['SERVICE_STOPPED', 'EVENT_MATCH']);
/**
 * 0.55: read from what the server already stores — the inventory pass's
 * drives, the live sample's boot time, the patch scan and update-install
 * results — by the sweep, at most every MONITOR_INVENTORY_SECONDS (default
 * five minutes: the evidence moves on a six-hourly or daily cadence).
 */
const INVENTORY_KINDS: ReadonlySet<string> = new Set(['DRIVE_FREE', 'UPTIME_LONG', 'UPDATES_MISSING', 'UPDATE_FAILED']);
const inventoryEveryMs = () => { const s = Number(process.env.MONITOR_INVENTORY_SECONDS); return Number.isFinite(s) && s >= 1 ? s * 1000 : 5 * 60_000; };
/** How far back update-install results are read for UPDATE_FAILED (its longest window). */
const DEPLOYMENT_LOOKBACK_MS = 90 * 86_400_000;
const RECHECK_MS = 60 * 60_000;
/** The offline correlation hold. MONITOR_OFFLINE_HOLD_SECONDS overrides it, for tests. */
const offlineHoldMs = () => { const s = Number(process.env.MONITOR_OFFLINE_HOLD_SECONDS); return Number.isFinite(s) && s >= 1 ? s * 1000 : OUTAGE.holdMs; };

@Injectable()
export class MonitoringService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Monitoring');
  private timer: ReturnType<typeof setInterval> | null = null;
  private first: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  private inventoryAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: AlertEventsService,
    private readonly email: EmailService,
    private readonly urls: PublicUrlService,
    private readonly groups: GroupMembershipService,
    private readonly tickets: AlertTicketsService,
    private readonly quality: QualityEngineService,
  ) {}

  onModuleInit() {
    if (process.env.MONITOR_SWEEP === 'off') return;
    const every = Math.max(2, Number(process.env.MONITOR_SWEEP_SECONDS) || 60) * 1000;
    this.first = setTimeout(() => { void this.sweep(); }, Math.min(30_000, every));
    this.timer = setInterval(() => { void this.sweep(); }, every);
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); if (this.first) clearTimeout(this.first); }

  // ── Rules ─────────────────────────────────────────────────────────────────

  private asRule(r: MonitorRule): RuleLike & MonitorRule { return r as unknown as RuleLike & MonitorRule; }

  /**
   * The effective monitors for one computer — optionally only those of
   * `kinds`, which is what each heartbeat-time caller needs.
   *
   * 0.35: device-group monitors apply by the groups the computer is in NOW
   * (group-policy/membership.service.ts), and membership is evaluated only
   * for groups that can change the answer: those carrying a monitor whose
   * key has a monitor of a wanted kind at some scope. That is exact, not a
   * shortcut — a key with no monitor of a wanted kind anywhere cannot yield
   * one, whichever scope wins it — and it keeps the heartbeat from
   * evaluating fifty rule groups to find that it has no service monitors.
   */
  async rulesFor(ep: { id: string; customerId: string | null; siteId: string | null }, kinds?: ReadonlySet<string>) {
    return (await this.resolveFor(ep, kinds)).rules;
  }

  /** rulesFor, plus the scope keys that applied (the device page lists them). */
  async resolveFor(ep: { id: string; customerId: string | null; siteId: string | null }, kinds?: ReadonlySet<string>) {
    const fixed = scopesFor(ep);
    const rows = (await this.prisma.monitorRule.findMany({
      where: { OR: [{ scopeKey: { in: fixed } }, ...(ep.customerId ? [{ customerId: ep.customerId, groupId: { not: null } }] : [])] },
    })).map((r) => this.asRule(r));
    const wantedKeys = kinds ? new Set(rows.filter((r) => kinds.has(r.kind)).map((r) => r.key)) : null;
    const groupIds = [...new Set(rows.filter((r) => r.groupId && (!wantedKeys || wantedKeys.has(r.key))).map((r) => r.groupId!))];
    const membership = groupIds.length ? await this.groups.snapshot(groupIds, [ep.id]) : null;
    const scopes = scopesFor(ep, membership?.groupsOf(ep.id) ?? []);
    const eff = effectiveRules(rows, scopes);
    return { rules: kinds ? eff.filter((r) => kinds.has(r.kind)) : eff, scopes };
  }

  private async endpoint(endpointId: string): Promise<Ep | null> {
    return this.prisma.endpoint.findFirst({ where: { id: endpointId, status: 'ACTIVE' }, select: { id: true, tenantId: true, customerId: true, siteId: true, name: true, platform: true, osVersion: true } });
  }

  /** The `monitor` block of an authenticated heartbeat response, or null when nothing is asked. */
  async heartbeatConfig(endpointId: string) {
    const ep = await this.endpoint(endpointId);
    if (!ep) return null;
    const rules = await this.rulesFor(ep, AGENT_KINDS);
    const evKeys = rules.filter((r) => r.kind === 'EVENT_MATCH').map((r) => r.key);
    const states = evKeys.length ? await this.prisma.endpointMonitorState.findMany({ where: { endpointId, ruleKey: { in: evKeys } }, select: { ruleKey: true, checkedAt: true } }) : [];
    return agentMonitorConfig(rules, Object.fromEntries(states.map((s) => [s.ruleKey, s.checkedAt])));
  }

  // ── Evidence in ───────────────────────────────────────────────────────────

  /** A monitor report from an authenticated agent: service states and event-rule counts. */
  async ingestReport(endpointId: string, raw: unknown, now = new Date()) {
    const ep = await this.endpoint(endpointId);
    if (!ep) return { accepted: false, reason: 'unknown_endpoint' };
    const rules = await this.rulesFor(ep, AGENT_KINDS);
    const cfg = agentMonitorConfig(rules, {});
    const report = sanitizeReport(raw, { services: cfg?.services ?? [], eventKeys: (cfg?.events ?? []).map((e) => e.key) });
    await this.prisma.endpointInventory.upsert({
      where: { endpointId },
      create: { endpointId, monitorReport: report as unknown as Prisma.InputJsonValue, monitorReportedAt: now },
      update: { monitorReport: report as unknown as Prisma.InputJsonValue, monitorReportedAt: now },
    });
    const states = await this.states(endpointId, rules.map((r) => r.key));
    for (const r of rules) {
      if (r.kind === 'SERVICE_STOPPED') {
        const name = String((r.params as { service?: string }).service ?? '');
        const svc = report.services.find((s) => s.name.toLowerCase() === name.toLowerCase());
        await this.apply(ep, r, evaluateService(r, svc, ep.name, states.get(r.key) ?? EMPTY_STATE, now), now, { repeat: true });
      } else if (r.kind === 'EVENT_MATCH') {
        const ev = report.events.find((e) => e.key === r.key);
        if (!ev) continue;
        // 0.66: classify before anything is raised (classify.ts). Events that
        // match a known-harmless pattern are taken out of the count the
        // threshold sees, and recorded, never dropped.
        const view = { severity: r.severity, params: r.params as Record<string, unknown> };
        const first = ev.count > 0 ? classifyEvents(view, { count: ev.count, samples: ev.samples }) : null;
        if (first) await this.recordFingerprints(ep, r.key, String((r.params as { log?: unknown }).log ?? ''), ev.samples, first, now);
        // 0.67: approved alert quality rules, before the threshold and before
        // anything is raised, notified or ticketed. The classifier makes the
        // one decision again with each rule's verdict; pending rules are only
        // counted (quality-engine.service.ts).
        const q = first ? await this.quality.forEvents(ep, { key: r.key, id: r.id }, first, now) : null;
        const cls = first && q ? classifyEvents(view, { count: ev.count, samples: ev.samples }, q.adjust) : first;
        const v = evaluateEvents(r, ev, ep.name, states.get(r.key) ?? EMPTY_STATE, now, cls ? cls.effectiveCount : 0);
        const alertId = await this.apply(ep, r, v, now, { repeat: true, checkedAt: ev.checkedAt, cls });
        if (alertId && cls) {
          const fps = cls.samples.filter((d) => d.class !== 'BENIGN').map((d) => d.fingerprint);
          if (fps.length) await this.prisma.monitorEventFingerprint.updateMany({ where: { endpointId: ep.id, ruleKey: r.key, fingerprint: { in: fps } }, data: { lastAlertId: alertId } });
        }
      }
    }
    return { accepted: true, services: report.services.length, events: report.events.length };
  }

  /** After a heartbeat wrote a live sample: the resource monitors. */
  async onLiveSample(endpointId: string, now = new Date()) {
    const ep = await this.endpoint(endpointId);
    if (!ep) return;
    const rules = await this.rulesFor(ep, LIVE_KINDS);
    if (!rules.length) return;
    const live = await this.live(endpointId, ep.name);
    if (!live) return;
    const states = await this.states(endpointId, rules.map((r) => r.key));
    for (const r of rules) await this.apply(ep, r, evaluateLive(r, live, states.get(r.key) ?? EMPTY_STATE, now, true), now, { repeat: true });
  }

  private async live(endpointId: string, name: string): Promise<Live | null> {
    const e = await this.prisma.endpoint.findUnique({
      where: { id: endpointId },
      select: { isOnline: true, lastSeenAt: true, inventory: { select: { cpuLoadPercent: true, memoryTotalMb: true, memoryFreeMb: true, systemDiskTotalMb: true, systemDiskFreeMb: true, liveSampledAt: true, rebootRequired: true, updatesCheckedAt: true } } },
    });
    if (!e) return null;
    const i = e.inventory;
    return {
      name, isOnline: e.isOnline, lastSeenAt: e.lastSeenAt,
      cpuLoadPercent: i?.cpuLoadPercent ?? null, memoryTotalMb: i?.memoryTotalMb ?? null, memoryFreeMb: i?.memoryFreeMb ?? null,
      systemDiskTotalMb: i?.systemDiskTotalMb ?? null, systemDiskFreeMb: i?.systemDiskFreeMb ?? null, liveSampledAt: i?.liveSampledAt ?? null,
      rebootRequired: i?.rebootRequired ?? null, updatesCheckedAt: i?.updatesCheckedAt ?? null,
    };
  }

  private async states(endpointId: string, keys: string[]) {
    const rows = keys.length ? await this.prisma.endpointMonitorState.findMany({ where: { endpointId, ruleKey: { in: keys } } }) : [];
    return new Map(rows.map((r) => [r.ruleKey, r as MonitorStateLike & { checkedAt: string | null }]));
  }

  private async saveState(endpointId: string, ruleKey: string, s: MonitorStateLike, checkedAt?: string) {
    const data = { breachCount: s.breachCount, okCount: s.okCount, breachSince: s.breachSince, lastMatchAt: s.lastMatchAt, ...(checkedAt ? { checkedAt } : {}) };
    await this.prisma.endpointMonitorState.upsert({ where: { endpointId_ruleKey: { endpointId, ruleKey } }, create: { endpointId, ruleKey, ...data }, update: data });
  }

  private async apply(ep: Ep, rule: RuleLike & { id: string }, v: Verdict, now: Date, o: { repeat: boolean; checkedAt?: string; saveState?: boolean; cls?: Classification | null }): Promise<string | null> {
    if (v.verdict === 'skip') return null;
    if (o.saveState !== false) await this.saveState(ep.id, rule.key, v.state, o.checkedAt);
    if (v.verdict === 'breach') return this.raise(ep, rule, v.title, v.detail, now, o.repeat, undefined, o.cls ?? null);
    else if (v.verdict === 'ok' && v.clear) await this.resolveOpen(dedupKeyOf(rule.key, ep.id), null, 'Cleared: the monitor reads normal again.', now);
    return null;
  }

  /**
   * 0.66: every event the agent sent, one row per computer, monitor and
   * fingerprint — harmless ones included — with the newest raw event. At most
   * SAMPLES_MAX upserts per report with matches; nothing when there were none.
   */
  private async recordFingerprints(ep: Ep, ruleKey: string, log: string, samples: { eventId: number | null; level: number | null; provider: string | null; message: string | null; at?: string | null }[], cls: Classification, now: Date) {
    const done = new Set<string>();
    for (let i = 0; i < cls.samples.length; i++) {
      const d = cls.samples[i];
      if (done.has(d.fingerprint)) continue;
      done.add(d.fingerprint);
      const raw = samples[i] ?? {};
      const small = (n: number | null) => (typeof n === 'number' && n >= 0 && n <= 2_147_483_647 ? n : null);
      const data = {
        class: d.class, basis: d.basis, matched: d.matched, classifierVersion: cls.v, sample: raw as Prisma.InputJsonValue, lastSeenAt: now,
        customerId: ep.customerId, tenantId: ep.tenantId,
      };
      try {
        await this.prisma.monitorEventFingerprint.upsert({
          where: { endpointId_ruleKey_fingerprint: { endpointId: ep.id, ruleKey, fingerprint: d.fingerprint } },
          create: { endpointId: ep.id, ruleKey, fingerprint: d.fingerprint, log, provider: d.provider?.slice(0, 128) ?? null, eventId: small(d.eventId), level: small(d.level), statusCode: d.statusCode, component: d.component, firstSeenAt: now, ...data },
          update: { ...data, seen: { increment: 1 } },
        });
      } catch (e) {
        // Two reports at once can both try the create; the second is a repeat.
        if ((e as { code?: string }).code !== 'P2002') throw e;
      }
    }
  }

  // ── Alert lifecycle ───────────────────────────────────────────────────────

  /** `dedupKey` is the rule and computer, or (0.55, DRIVE_FREE) the rule, computer and drive. */
  async raise(ep: Ep, rule: RuleLike & { id: string }, title: string, detail: Record<string, unknown>, now: Date, repeat: boolean, dedupKey = dedupKeyOf(rule.key, ep.id), cls: Classification | null = null) {
    // 0.66: an event monitor's severity is the classifier's (never above the
    // monitor's); a threshold monitor's is the monitor's own.
    let decided = cls ?? classifyThreshold(rule.severity);
    // 0.67: a threshold monitor's alert under an approved alert quality rule:
    // suppressed (nothing raised, notified or ticketed) or capped. (A site
    // outage is not raised here, and no rule names one.)
    if (!cls) {
      const t = await this.quality.forThreshold(ep, { key: rule.key, id: rule.id }, rule.severity as Severity, now);
      if (t.severity === null) return null;
      if (t.ruleId && t.severity !== rule.severity) decided = { ...classifyThreshold(t.severity), basis: 'quality_rule', ruleSeverity: rule.severity as Severity, qualityRules: [t.ruleId], reasons: [`rule_capped:${t.ruleId}`] };
    }
    const severity = (decided.severity ?? rule.severity) as Severity;
    const bump = async (a: MonitorAlert) => {
      // An open event alert keeps the worst it has seen, and the decision
      // that made it so; a threshold alert follows its monitor.
      const keep = cls && SEVERITY_RANK[a.severity as Severity] > SEVERITY_RANK[severity];
      await this.prisma.monitorAlert.update({
        where: { id: a.id },
        data: {
          lastSeenAt: now, title: title.slice(0, 300), detail: detail as Prisma.InputJsonValue, ruleId: rule.id, ...(repeat ? { occurrences: { increment: 1 } } : {}),
          ...(keep ? {} : { severity: cls ? worse(a.severity as Severity, severity) : severity, classification: decided as unknown as Prisma.InputJsonValue, classifierVersion: decided.v, fingerprint: decided.fingerprint }),
        },
      });
    };
    const open = await this.prisma.monitorAlert.findFirst({ where: { dedupKey, state: { not: 'RESOLVED' } } });
    if (open) { await bump(open); return open.id; }
    const notifyFrom = rule.kind === 'OFFLINE' ? new Date(now.getTime() + offlineHoldMs()) : now;
    try {
      const a = await this.prisma.monitorAlert.create({
        data: {
          tenantId: ep.tenantId, customerId: ep.customerId, siteId: ep.siteId, endpointId: ep.id, ruleId: rule.id, ruleKey: rule.key, kind: rule.kind,
          dedupKey, severity, title: title.slice(0, 300), detail: detail as Prisma.InputJsonValue,
          classification: decided as unknown as Prisma.InputJsonValue, classifierVersion: decided.v, fingerprint: decided.fingerprint,
          firstSeenAt: now, lastSeenAt: now, notifyFrom, nextCheckAt: notifyFrom,
          events: { create: { type: 'raised', detail: { rule: rule.key, inheritedFrom: (rule as { inheritedFrom?: string }).inheritedFrom ?? null, class: decided.class, basis: decided.basis, ...(decided.matched ? { matched: decided.matched } : {}) } } },
        },
      });
      return a.id;
    } catch (e) {
      if ((e as { code?: string }).code !== 'P2002') throw e;
      const again = await this.prisma.monitorAlert.findFirst({ where: { dedupKey, state: { not: 'RESOLVED' } } });
      if (again) await bump(again);
      return again?.id ?? null;
    }
  }

  /** Resolve the open alert with this key, if any. `actorId` null = the monitor itself. */
  async resolveOpen(dedupKey: string, actorId: string | null, note: string, now = new Date()) {
    const a = await this.prisma.monitorAlert.findFirst({ where: { dedupKey, state: { not: 'RESOLVED' } } });
    if (!a) return null;
    return this.resolve(a, actorId, note, now);
  }

  async resolve(a: MonitorAlert, actorId: string | null, note: string, now = new Date()) {
    const r = await this.prisma.monitorAlert.updateMany({ where: { id: a.id, state: { not: 'RESOLVED' } }, data: { state: 'RESOLVED', resolvedAt: now, resolvedById: actorId, resolveNote: note.slice(0, 300) } });
    if (!r.count) return null;
    await this.prisma.monitorAlertEvent.create({ data: { alertId: a.id, type: 'resolved', actorId, detail: { note: note.slice(0, 300) } } });
    if (a.kind === 'SITE_OUTAGE') {
      // Its computers are no longer grouped: any still offline are told about on their own from now.
      await this.prisma.monitorAlert.updateMany({ where: { parentId: a.id, state: 'OPEN' }, data: { notifyFrom: now, nextCheckAt: now } });
    }
    if (a.lastNotifiedAt) {
      const policy = await this.policyFor(a.customerId);
      const reached = (policy?.levels ?? []).slice(0, a.escalationLevel);
      const fresh = await this.prisma.monitorAlert.findUnique({ where: { id: a.id }, include: VIEW_INCLUDE });
      if (fresh) {
        const results = await this.deliverAll(reached.flatMap((l) => l.destinations), 'alert.resolved', fresh, null, policy!.scopeKey);
        await this.prisma.monitorAlertEvent.create({ data: { alertId: a.id, type: 'notified', detail: { level: null, kind: 'resolved', results } as Prisma.InputJsonValue } });
      }
    }
    await this.events.emit(a.id, 'alert.resolved');
    return a.id;
  }

  // ── The sweep ─────────────────────────────────────────────────────────────

  /**
   * 0.67: extra steps run first in every sweep (alert quality rules' expiry
   * and review reminders). Registered by their own service, so the sweep stays
   * the one timer: MONITOR_SWEEP=off stops them with it.
   */
  private readonly steps: { name: string; run: (now: Date) => Promise<unknown> }[] = [];
  addSweepStep(name: string, run: (now: Date) => Promise<unknown>) { this.steps.push({ name, run }); }

  async sweep(now = new Date()) {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const s of this.steps) {
        try { await s.run(now); } catch (e) { this.logger.error(`monitoring sweep step ${s.name}: ${(e as Error).message}`); }
      }
      await this.evaluateSweepRules(now);
      await this.correlateOutages(now);
      await this.notifyPass(now);
      // 0.55: automatic PSA tickets, after notification so an alert's hold
      // and maintenance window have been looked at this tick. Only here:
      // MONITOR_SWEEP=off stops it with the rest of the sweep.
      await this.tickets.pass(now);
    } catch (e) {
      this.logger.error(`monitoring sweep: ${(e as Error).stack ?? e}`);
    } finally { this.busy = false; }
  }

  private async evaluateSweepRules(now: Date) {
    const rules = (await this.prisma.monitorRule.findMany()).map((r) => this.asRule(r));
    const eps = await this.prisma.endpoint.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, tenantId: true, customerId: true, siteId: true, name: true, isOnline: true, lastSeenAt: true, warrantyEndsAt: true, inventory: { select: { rebootRequired: true, updatesCheckedAt: true } } },
    });
    const valid = new Set<string>();
    const openRows = await this.prisma.monitorAlert.findMany({ where: { state: { not: 'RESOLVED' }, kind: { not: 'SITE_OUTAGE' } }, select: { id: true, dedupKey: true, kind: true, endpointId: true, title: true, detail: true } });
    const open = new Map(openRows.map((a) => [a.dedupKey, a]));
    const sweepKeys = [...new Set(rules.filter((r) => SWEEP_KINDS.has(r.kind) || r.kind === 'EVENT_MATCH').map((r) => r.key))];
    const stateRows = sweepKeys.length ? await this.prisma.endpointMonitorState.findMany({ where: { ruleKey: { in: sweepKeys } } }) : [];
    const states = new Map(stateRows.map((s) => [`${s.endpointId}|${s.ruleKey}`, s as MonitorStateLike]));
    // 0.55: a drive monitor's alerts are one per drive; while the rule applies, any of them is valid.
    const validPrefixes = new Set<string>();
    const inventoryWork: { ep: Ep; rules: (RuleLike & MonitorRule)[] }[] = [];
    // 0.81: the backup kinds, per computer, over the backup assets linked to it.
    const backupWork: { ep: Ep; rules: (RuleLike & MonitorRule)[] }[] = [];
    // Group membership, once for this tick and never kept past it: the
    // groups that carry a monitor, each evaluated over its whole business.
    const membership = await this.groups.snapshot(rules.filter((r) => r.groupId).map((r) => r.groupId!));
    for (const ep of eps) {
      const eff = effectiveRules(rules, scopesFor(ep, membership.groupsOf(ep.id)));
      const inv = eff.filter((r) => INVENTORY_KINDS.has(r.kind));
      if (inv.length) inventoryWork.push({ ep, rules: inv });
      const bk = eff.filter((r) => BACKUP_KINDS.has(r.kind));
      if (bk.length) backupWork.push({ ep, rules: bk });
      for (const r of eff) {
        const dk = dedupKeyOf(r.key, ep.id);
        valid.add(dk);
        // 0.81: likewise a backup monitor's alerts, one per asset.
        if (r.kind === 'DRIVE_FREE' || BACKUP_KINDS.has(r.kind)) validPrefixes.add(drivePrefixOf(r.key, ep.id));
        const st = states.get(`${ep.id}|${r.key}`) ?? EMPTY_STATE;
        if (SWEEP_KINDS.has(r.kind)) {
          const live: Live = {
            name: ep.name, isOnline: ep.isOnline, lastSeenAt: ep.lastSeenAt, cpuLoadPercent: null, memoryTotalMb: null, memoryFreeMb: null,
            systemDiskTotalMb: null, systemDiskFreeMb: null, liveSampledAt: null,
            rebootRequired: ep.inventory?.rebootRequired ?? null, updatesCheckedAt: ep.inventory?.updatesCheckedAt ?? null,
          };
          const v = evaluateLive(r, live, st, now, false);
          if (v.verdict === 'skip') continue;
          // Write state only when it moved, or a fleet costs a write per computer per minute.
          const moved = (v.state.breachSince?.getTime() ?? null) !== (st.breachSince?.getTime() ?? null);
          const isOpen = open.has(dk);
          // An open agent-silent alert's title says how long ("silent for 3 d");
          // it is rewritten when that coarse figure changes, not every tick.
          const stale = v.verdict === 'breach' && r.kind === 'AGENT_SILENT' && open.get(dk)?.title !== v.title.slice(0, 300);
          if (v.verdict === 'breach' && isOpen && !moved && !stale) continue;
          if (v.verdict !== 'breach' && !isOpen && !moved) continue;
          await this.apply(ep, r, v, now, { repeat: false, saveState: moved || v.verdict === 'breach' });
        } else if (r.kind === 'WARRANTY_EXPIRING') {
          // 0.56: stateless, from the stored end date. A date that moved
          // closes the open alert and raises one naming the new date.
          const v = evaluateWarranty(r, ep.warrantyEndsAt, ep.name, st, now);
          const was = open.get(dk);
          if (v.verdict === 'breach') {
            const wasEnds = (was?.detail as { endsAt?: unknown } | null)?.endsAt;
            if (was && wasEnds !== v.detail.endsAt) await this.resolveOpen(dk, null, 'Cleared: the warranty end date changed.', now);
            else if (was && was.title === v.title.slice(0, 300)) continue;
            await this.apply(ep, r, v, now, { repeat: false, saveState: false });
          } else if (v.verdict === 'ok' && was) {
            await this.resolveOpen(dk, null, 'Cleared: the warranty end date is no longer within the warning period.', now);
          }
        } else if (r.kind === 'EVENT_MATCH' && open.has(dk)) {
          const v = evaluateEvents(r, undefined, ep.name, st, now);
          if (v.verdict === 'ok' && v.clear) await this.resolveOpen(dk, null, 'Cleared: no matching events for the quiet period.', now);
        }
      }
    }
    if ((inventoryWork.length || backupWork.length) && now.getTime() - this.inventoryAt >= inventoryEveryMs()) {
      this.inventoryAt = now.getTime();
      if (inventoryWork.length) await this.evaluateInventoryRules(inventoryWork, open, now);
      if (backupWork.length) await this.evaluateBackupRules(backupWork, open, now);
    }
    // An open alert whose monitor no longer applies (removed, disabled, moved scope) or whose computer was retired.
    for (const [dk, a] of open) {
      if (!valid.has(dk) && !validPrefixes.has(dk.slice(0, dk.lastIndexOf(':') + 1))) await this.resolveOpen(dk, null, 'Closed: the monitor no longer applies to this computer, or the computer was retired.', now);
      void a;
    }
  }

  /**
   * 0.81: BACKUP_STALE, BACKUP_FAILED, DRILL_FAILED and RPO_EXCEEDED, from the
   * backup rows a provider reported (backups/) — stored data only, read here
   * and written nowhere. One alert per asset linked to the computer
   * (assetKeyOf); an asset no longer linked (or gone) closes its alert. A
   * verdict raises (or rewrites a changed title, without counting a repeat),
   * clears, or — skip, hold — leaves things as they are.
   */
  private async evaluateBackupRules(work: { ep: Ep; rules: (RuleLike & MonitorRule)[] }[], open: Map<string, { id: string; dedupKey: string; title: string }>, now: Date) {
    const ids = work.map((w) => w.ep.id);
    type Asset = Prisma.BackupProtectedAssetGetPayload<{ include: { objective: true; jobs: true; recoveryPoints: true; drills: true } }>;
    const byEp = new Map<string, Asset[]>();
    const bizIds = new Set<string>();
    for (let i = 0; i < ids.length; i += 200) {
      const rows = await this.prisma.backupProtectedAsset.findMany({
        where: { endpointId: { in: ids.slice(i, i + 200) } },
        include: {
          objective: true,
          jobs: { orderBy: [{ startedAt: 'desc' }, { id: 'asc' }], take: 20 },
          recoveryPoints: { orderBy: [{ pointAt: 'desc' }, { id: 'asc' }], take: 1 },
          drills: { orderBy: [{ startedAt: 'desc' }, { id: 'asc' }], take: 20 },
        },
        orderBy: { id: 'asc' }, take: 5000,
      });
      for (const r of rows) {
        if (!r.endpointId || !ASSET_ID.test(r.id)) continue;
        const l = byEp.get(r.endpointId) ?? []; l.push(r); byEp.set(r.endpointId, l);
        bizIds.add(r.customerId);
      }
    }
    const bizObj = new Map((bizIds.size ? await this.prisma.backupObjective.findMany({ where: { customerId: { in: [...bizIds] }, assetId: null } }) : []).map((o) => [o.customerId, o]));
    for (const { ep, rules } of work) {
      // An asset of another business can never be linked here (0097's trigger); checked again anyway.
      const assets = (byEp.get(ep.id) ?? []).filter((x) => x.customerId === ep.customerId);
      for (const r of rules) {
        try {
          const prefix = drivePrefixOf(r.key, ep.id);
          const seen = new Set<string>();
          for (const x of assets) {
            const dk = assetKeyOf(r.key, ep.id, x.id);
            seen.add(dk);
            const v = evaluateBackup(r, `${ep.name} · ${x.name}`, {
              firstSeenAt: x.firstSeenAt, jobs: x.jobs, points: x.recoveryPoints, drills: x.drills,
              objective: x.objective ? { rpoMinutes: x.objective.rpoMinutes, rtoMinutes: x.objective.rtoMinutes } : null,
              businessObjective: bizObj.get(x.customerId) ?? null,
            }, now);
            const cur = open.get(dk);
            if (v.verdict === 'breach') {
              if (!cur || cur.title !== v.title.slice(0, 300)) await this.raise(ep, r, v.title, { ...v.detail, assetId: x.id, asset: x.name }, now, false, dk);
            } else if (v.verdict === 'ok' && cur) {
              await this.resolveOpen(dk, null, 'Cleared: the backup provider\'s latest report no longer shows the problem.', now);
            }
          }
          for (const dk of open.keys()) if (dk.startsWith(prefix) && !seen.has(dk)) await this.resolveOpen(dk, null, 'Closed: that backup asset is no longer linked to this computer.', now);
        } catch (e) {
          this.logger.warn(`backup monitor ${r.key} on ${ep.id}: ${(e as Error).message}`);
        }
      }
    }
  }

  /**
   * 0.55: drive space, uptime, outstanding and failed updates, from stored
   * evidence. Stateless but for UPDATES_MISSING's first-seen dates: a verdict
   * raises (or rewrites an open alert's title when it changed, without
   * counting a repeat — the same evidence is read again every pass), clears,
   * or — `skip`, `hold` — leaves things as they are.
   */
  private async evaluateInventoryRules(work: { ep: Ep; rules: (RuleLike & MonitorRule)[] }[], open: Map<string, { id: string; dedupKey: string; title: string }>, now: Date) {
    const ids = work.map((w) => w.ep.id);
    const needs = (k: string) => work.filter((w) => w.rules.some((r) => r.kind === k)).map((w) => w.ep.id);
    const patchIds = new Set([...needs('UPDATES_MISSING'), ...needs('UPDATE_FAILED')]);
    const inv = new Map<string, { disks: Prisma.JsonValue; collectedAt: Date | null; lastBootAt: Date | null; uptimeSeconds: number | null; liveSampledAt: Date | null; patchPosture?: Prisma.JsonValue }>();
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const rows = await this.prisma.endpointInventory.findMany({
        where: { endpointId: { in: chunk } },
        select: { endpointId: true, disks: true, collectedAt: true, lastBootAt: true, uptimeSeconds: true, liveSampledAt: true },
      });
      for (const r of rows) inv.set(r.endpointId, r);
      const withPatch = chunk.filter((id) => patchIds.has(id));
      if (withPatch.length) {
        for (const r of await this.prisma.endpointInventory.findMany({ where: { endpointId: { in: withPatch } }, select: { endpointId: true, patchPosture: true } })) {
          const cur = inv.get(r.endpointId);
          if (cur) cur.patchPosture = r.patchPosture;
        }
      }
    }
    const failIds = needs('UPDATE_FAILED');
    const deployments = new Map<string, { resultAt: Date | null; result: unknown }[]>();
    if (failIds.length) {
      const rows = await this.prisma.actionTarget.findMany({
        where: { endpointId: { in: failIds }, resultAt: { gte: new Date(now.getTime() - DEPLOYMENT_LOOKBACK_MS) }, job: { actionId: 'windows.update.install' } },
        select: { endpointId: true, resultAt: true, result: true }, orderBy: { resultAt: 'desc' }, take: 5000,
      });
      for (const r of rows) { const l = deployments.get(r.endpointId) ?? []; l.push(r); deployments.set(r.endpointId, l); }
    }
    const missKeys = [...new Set(work.flatMap((w) => w.rules.filter((r) => r.kind === 'UPDATES_MISSING').map((r) => r.key)))];
    const seenRows = missKeys.length ? await this.prisma.endpointMonitorState.findMany({ where: { endpointId: { in: needs('UPDATES_MISSING') }, ruleKey: { in: missKeys } }, select: { endpointId: true, ruleKey: true, lastValue: true } }) : [];
    const seen = new Map(seenRows.map((s) => [`${s.endpointId}|${s.ruleKey}`, s.lastValue]));

    const verdict = async (ep: Ep, r: RuleLike & MonitorRule, dk: string, v: { verdict: string; title?: string; detail?: Record<string, unknown> }, note: string) => {
      const cur = open.get(dk);
      if (v.verdict === 'breach') {
        // Raise, or rewrite a title that changed ("… 31 days"); the same reading again is not a repeat.
        if (!cur || cur.title !== v.title!.slice(0, 300)) await this.raise(ep, r, v.title!, v.detail ?? {}, now, false, dk);
      } else if (v.verdict === 'ok' && cur) {
        await this.resolveOpen(dk, null, note, now);
      }
    };
    for (const { ep, rules } of work) {
      const i = inv.get(ep.id) ?? null;
      for (const r of rules) {
        try {
          if (r.kind === 'DRIVE_FREE') {
            const v = evaluateDrives(r, ep, i ? { disks: i.disks, collectedAt: i.collectedAt } : null, now);
            if (v.verdict === 'skip') continue;
            const reported = new Set<string>();
            for (const d of v.drives) {
              reported.add(d.dedupKey);
              await verdict(ep, r, d.dedupKey, d, `Cleared: drive ${d.drive} has room again.`);
            }
            // A drive no longer reported (removed, or excluded since) closes its alert.
            const prefix = drivePrefixOf(r.key, ep.id);
            for (const dk of open.keys()) if (dk.startsWith(prefix) && !reported.has(dk)) await this.resolveOpen(dk, null, 'Closed: that drive is no longer reported, or the monitor no longer covers it.', now);
          } else if (r.kind === 'UPTIME_LONG') {
            if (!i) continue;
            await verdict(ep, r, dedupKeyOf(r.key, ep.id), evaluateUptime(r, { name: ep.name, lastBootAt: i.lastBootAt, uptimeSeconds: i.uptimeSeconds, liveSampledAt: i.liveSampledAt }, now), 'Cleared: the computer has restarted.');
          } else if (r.kind === 'UPDATES_MISSING') {
            if (!i) continue;
            const prev = seen.get(`${ep.id}|${r.key}`);
            const prevSeen = (prev && typeof prev === 'object' && !Array.isArray(prev) ? (prev as { seen?: SeenUpdates }).seen : undefined) ?? {};
            const v = evaluateMissingUpdates(r, ep.name, i.patchPosture ?? null, prevSeen, now);
            if (v.verdict === 'skip') continue;
            if (JSON.stringify(v.seen) !== JSON.stringify(prevSeen)) {
              const lastValue = { seen: v.seen } as Prisma.InputJsonValue;
              await this.prisma.endpointMonitorState.upsert({
                where: { endpointId_ruleKey: { endpointId: ep.id, ruleKey: r.key } },
                create: { endpointId: ep.id, ruleKey: r.key, lastValue }, update: { lastValue },
              });
            }
            await verdict(ep, r, dedupKeyOf(r.key, ep.id), v, 'Cleared: no security or critical update has been outstanding that long.');
          } else if (r.kind === 'UPDATE_FAILED') {
            if (!i && !deployments.has(ep.id)) continue;
            await verdict(ep, r, dedupKeyOf(r.key, ep.id), evaluateFailedUpdates(r, ep.name, i?.patchPosture ?? null, deployments.get(ep.id) ?? [], now), 'Cleared: no failed update install in the window, or it has since installed.');
          }
        } catch (e) {
          this.logger.warn(`inventory monitor ${r.key} on ${ep.id}: ${(e as Error).message}`);
        }
      }
    }
  }

  private async correlateOutages(now: Date) {
    const eps = await this.prisma.endpoint.findMany({ where: { status: 'ACTIVE', siteId: { not: null } }, select: { id: true, siteId: true, customerId: true, tenantId: true } });
    const bySite = new Map<string, { active: number; customerId: string | null; tenantId: string | null }>();
    for (const e of eps) {
      const s = bySite.get(e.siteId!) ?? { active: 0, customerId: e.customerId, tenantId: e.tenantId };
      s.active++; bySite.set(e.siteId!, s);
    }
    const offline = await this.prisma.monitorAlert.findMany({ where: { kind: 'OFFLINE', state: { not: 'RESOLVED' }, siteId: { not: null } }, select: { id: true, siteId: true, parentId: true } });
    const offBySite = new Map<string, typeof offline>();
    for (const a of offline) { const l = offBySite.get(a.siteId!) ?? []; l.push(a); offBySite.set(a.siteId!, l); }
    const outages = await this.prisma.monitorAlert.findMany({ where: { kind: 'SITE_OUTAGE', state: { not: 'RESOLVED' } } });
    const outBySite = new Map(outages.map((o) => [o.siteId ?? '', o]));
    const sites = new Set([...offBySite.keys(), ...outBySite.keys()].filter(Boolean));
    for (const siteId of sites) {
      const s = bySite.get(siteId);
      const kids = offBySite.get(siteId) ?? [];
      const cur = outBySite.get(siteId);
      const d = outageDecision({ active: s?.active ?? 0, offline: kids.length, open: !!cur });
      if (d === 'none') continue;
      if (d === 'clear') { if (cur) await this.resolve(cur, null, `Cleared: ${kids.length} of ${s?.active ?? 0} computers still offline.`, now); continue; }
      const site = await this.prisma.site.findUnique({ where: { id: siteId }, select: { name: true } });
      const title = `Site ${site?.name ?? siteId}: ${kids.length} of ${s!.active} computers offline`;
      const detail = { offline: kids.length, active: s!.active, share: Math.round((100 * kids.length) / s!.active) };
      let id = cur?.id;
      if (d === 'raise') {
        try {
          const a = await this.prisma.monitorAlert.create({
            data: {
              tenantId: s!.tenantId, customerId: s!.customerId, siteId, ruleKey: 'site-outage', kind: 'SITE_OUTAGE', dedupKey: outageKeyOf(siteId),
              severity: 'CRITICAL', title, detail, firstSeenAt: now, lastSeenAt: now, notifyFrom: now, nextCheckAt: now,
              events: { create: { type: 'raised', detail: { grouped: kids.length } } },
            },
          });
          id = a.id;
        } catch (e) { if ((e as { code?: string }).code !== 'P2002') throw e; continue; }
      } else if (cur && (cur.title !== title)) {
        await this.prisma.monitorAlert.update({ where: { id: cur.id }, data: { title, detail, lastSeenAt: now } });
      }
      const adopt = kids.filter((k) => k.parentId !== id).map((k) => k.id);
      if (id && adopt.length) {
        await this.prisma.monitorAlert.updateMany({ where: { id: { in: adopt } }, data: { parentId: id } });
        await this.prisma.monitorAlertEvent.createMany({ data: adopt.map((alertId) => ({ alertId, type: 'grouped', detail: { outageAlertId: id } })) });
      }
    }
  }

  // ── Notification and escalation ───────────────────────────────────────────

  private policyCache = new Map<string, { at: number; p: Policy | null }>();
  async policyFor(customerId: string | null): Promise<Policy | null> {
    const keys = [...(customerId ? [`b:${customerId}`] : []), 'global'];
    for (const k of keys) {
      const c = this.policyCache.get(k);
      let p: Policy | null;
      if (c && Date.now() - c.at < 10_000) p = c.p;
      else {
        const row = await this.prisma.monitorNotifyPolicy.findUnique({ where: { scopeKey: k } });
        p = row ? { scopeKey: row.scopeKey, levels: row.levels as unknown as NotifyLevel[], ticketing: row.ticketing as unknown as Policy['ticketing'] } : null;
        this.policyCache.set(k, { at: Date.now(), p });
      }
      if (p) return p;
    }
    return null;
  }
  forgetPolicies() { this.policyCache.clear(); }

  async notifyPass(now: Date) {
    const due = await this.prisma.monitorAlert.findMany({
      where: { state: 'OPEN', nextCheckAt: { lte: now } }, orderBy: { nextCheckAt: 'asc' }, take: 500, include: { ...VIEW_INCLUDE, parent: { select: { state: true } } },
    });
    if (!due.length) return;
    const sups = await this.prisma.monitorSuppression.findMany({ where: { revokedAt: null, endsAt: { gt: now }, startsAt: { lte: now } } });
    for (const a of due) {
      try { await this.notifyOne(a, sups, now); } catch (e) { this.logger.warn(`notify ${a.id}: ${(e as Error).message}`); }
    }
  }

  private async notifyOne(a: AlertView & { parent: { state: string } | null }, sups: Parameters<typeof suppressionFor>[1], now: Date) {
    if (a.notifyFrom > now) { await this.prisma.monitorAlert.update({ where: { id: a.id }, data: { nextCheckAt: a.notifyFrom } }); return; }
    // Grouped under an open site outage: the outage is the one notification.
    if (a.parentId && a.parent && a.parent.state !== 'RESOLVED') {
      await this.prisma.monitorAlert.update({ where: { id: a.id }, data: { nextCheckAt: new Date(now.getTime() + RECHECK_MS) } });
      return;
    }
    const sup = suppressionFor(a, sups, now);
    if (sup) {
      // Recorded and shown; nobody is told until the window ends, and the escalation clock starts then.
      await this.prisma.monitorAlert.update({ where: { id: a.id }, data: { suppressed: true, suppressionId: sup.id, notifyFrom: sup.endsAt, nextCheckAt: sup.endsAt } });
      if (!a.suppressed || a.suppressionId !== sup.id) await this.prisma.monitorAlertEvent.create({ data: { alertId: a.id, type: 'suppressed', detail: { suppressionId: sup.id, until: sup.endsAt.toISOString() } } });
      return;
    }
    if (a.suppressed) {
      await this.prisma.monitorAlert.update({ where: { id: a.id }, data: { suppressed: false, suppressionId: null } });
      await this.prisma.monitorAlertEvent.create({ data: { alertId: a.id, type: 'unsuppressed' } });
    }
    const policy = await this.policyFor(a.customerId);
    if (policy?.ticketing?.enabled && SEVERITY_RANK[a.severity as Severity] >= SEVERITY_RANK[policy.ticketing.minSeverity]) {
      await this.events.emit(a.id, 'alert.raised');
    }
    const levels = policy?.levels ?? [];
    for (const d of dueLevels(levels, { severity: a.severity as Severity, notifyFrom: a.notifyFrom, escalationLevel: a.escalationLevel }, now)) {
      // Claim first: whoever moves escalationLevel sends; a second sweeper does not.
      const claimed = await this.prisma.monitorAlert.updateMany({ where: { id: a.id, state: 'OPEN', escalationLevel: d.index }, data: { escalationLevel: d.index + 1, ...(d.skip ? {} : { lastNotifiedAt: now }) } });
      if (!claimed.count) return;
      if (d.skip) continue;
      const results = await this.deliverAll(d.level.destinations, 'alert.notify', a, d.index, policy!.scopeKey);
      await this.prisma.monitorAlertEvent.create({ data: { alertId: a.id, type: d.index === 0 ? 'notified' : 'escalated', detail: { level: d.index, results } as Prisma.InputJsonValue } });
      if (d.index > 0) await this.events.emit(a.id, 'alert.updated');
    }
    const fresh = await this.prisma.monitorAlert.findUnique({ where: { id: a.id }, select: { escalationLevel: true, notifyFrom: true } });
    const next = fresh && fresh.escalationLevel < levels.length ? new Date(fresh.notifyFrom.getTime() + levels[fresh.escalationLevel].afterMinutes * 60_000) : new Date(now.getTime() + RECHECK_MS);
    await this.prisma.monitorAlert.update({ where: { id: a.id }, data: { nextCheckAt: next > now ? next : new Date(now.getTime() + 60_000) } });
  }

  /**
   * POST the alert to each webhook, and mail it to each email recipient.
   * Never throws; returns one line per destination. An email goes only to a
   * recipient still confirmed in the policy's own scope (`scopeKey`), says
   * only what alertMail says, and is stopped by a `notifications` pause.
   */
  async deliverAll(dests: Destination[], type: 'alert.notify' | 'alert.resolved', a: AlertView, level: number | null, scopeKey: string) {
    const body = JSON.stringify({ source: 'rem0te', type, level, alert: webhookView(a) });
    const out: { label: string; ok: boolean; status: string }[] = [];
    for (const d of dests) {
      if (isEmailDestination(d)) {
        const mail = alertMail({
          id: a.id, title: a.title, severity: a.severity, kind: a.kind, state: a.state, firstSeenAt: a.firstSeenAt, resolvedAt: a.resolvedAt,
          computer: a.endpoint?.name ?? null, site: a.site?.name ?? null, business: a.customer?.name ?? null,
        }, type, `${this.urls.web()}/alerts?alert=${encodeURIComponent(a.id)}`);
        const [r] = await this.email.sendToRecipients([d.recipientId], scopeKey, mail, { customerId: a.customerId });
        out.push({ label: d.label, ok: r.ok, status: `email ${r.status}` });
        continue;
      }
      try {
        const url = validatePeerUrl(d.url, 'alert destination');
        const r = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000), headers: { 'content-type': 'application/json', 'user-agent': 'rem0te-monitoring/1' }, body });
        await r.body?.cancel().catch(() => undefined);
        out.push({ label: d.label, ok: r.ok, status: `HTTP ${r.status}` });
      } catch (e) {
        out.push({ label: d.label, ok: false, status: (e as Error).name || 'error' });
      }
    }
    return out;
  }
}

export const VIEW_INCLUDE = {
  // 0.92: lastSeenAt is the agent's last report, for the alert's freshness (alert-questions.ts).
  endpoint: { select: { id: true, name: true, hostname: true, lastSeenAt: true } },
  site: { select: { id: true, name: true } },
  customer: { select: { id: true, name: true } },
  // 0.55: the automatic PSA ticket, if one was made or tried.
  autoTicket: { select: { status: true, attempts: true, lastStatus: true, connectorKind: true, ref: true, url: true, lastAttemptAt: true, nextAttemptAt: true } },
} as const;
export type AlertView = Prisma.MonitorAlertGetPayload<{ include: typeof VIEW_INCLUDE }>;

/** What a webhook receives. Names are device-reported text. */
export function webhookView(a: AlertView) {
  return {
    id: a.id, title: a.title, severity: a.severity.toLowerCase(), state: a.state.toLowerCase(), monitor: a.ruleKey, kind: a.kind,
    business: a.customer?.name ?? null, site: a.site?.name ?? null, computer: a.endpoint?.name ?? null, computerId: a.endpointId,
    firstSeenAt: a.firstSeenAt, lastSeenAt: a.lastSeenAt, occurrences: a.occurrences, resolvedAt: a.resolvedAt,
    detail: a.detail, ticket: a.ticketId ? { id: a.ticketId, url: a.ticketUrl } : null,
  };
}
