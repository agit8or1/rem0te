import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, type MonitorAlert, type MonitorRule } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { validatePeerUrl } from '../integration/peers';
import {
  agentMonitorConfig, dedupKeyOf, dueLevels, effectiveRules, EMPTY_STATE, evaluateEvents, evaluateLive, evaluateService,
  NotifyLevel, OUTAGE, outageDecision, outageKeyOf, sanitizeReport, scopesFor, SEVERITY_RANK, suppressionFor,
  type Live, type MonitorStateLike, type RuleLike, type Severity, type Verdict,
} from './engine';
import { AlertEventsService } from './alert-events.service';

/**
 * Monitoring (v0.29): the evaluator, the sweep and the notifier.
 *
 *   heartbeat      → onLiveSample: disk, processor and memory monitors
 *   monitor-report → ingestReport: service and event monitors
 *   sweep (60 s)   → offline and restart-pending monitors, event-alert
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

type Ep = { id: string; tenantId: string | null; customerId: string | null; siteId: string | null; name: string };
type Policy = { levels: NotifyLevel[]; ticketing: { enabled: boolean; minSeverity: Severity } };

const LIVE_KINDS = new Set(['DISK_FREE', 'CPU_HIGH', 'MEMORY_HIGH']);
const SWEEP_KINDS = new Set(['OFFLINE', 'REBOOT_PENDING']);
const RECHECK_MS = 60 * 60_000;
/** The offline correlation hold. MONITOR_OFFLINE_HOLD_SECONDS overrides it, for tests. */
const offlineHoldMs = () => { const s = Number(process.env.MONITOR_OFFLINE_HOLD_SECONDS); return Number.isFinite(s) && s >= 1 ? s * 1000 : OUTAGE.holdMs; };

@Injectable()
export class MonitoringService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Monitoring');
  private timer: ReturnType<typeof setInterval> | null = null;
  private first: ReturnType<typeof setTimeout> | null = null;
  private busy = false;

  constructor(private readonly prisma: PrismaService, private readonly events: AlertEventsService) {}

  onModuleInit() {
    if (process.env.MONITOR_SWEEP === 'off') return;
    const every = Math.max(2, Number(process.env.MONITOR_SWEEP_SECONDS) || 60) * 1000;
    this.first = setTimeout(() => { void this.sweep(); }, Math.min(30_000, every));
    this.timer = setInterval(() => { void this.sweep(); }, every);
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); if (this.first) clearTimeout(this.first); }

  // ── Rules ─────────────────────────────────────────────────────────────────

  private asRule(r: MonitorRule): RuleLike & MonitorRule { return r as unknown as RuleLike & MonitorRule; }

  async rulesFor(ep: { id: string; customerId: string | null; siteId: string | null }) {
    const scopes = scopesFor(ep);
    const rows = await this.prisma.monitorRule.findMany({ where: { scopeKey: { in: scopes } } });
    return effectiveRules(rows.map((r) => this.asRule(r)), scopes);
  }

  private async endpoint(endpointId: string): Promise<Ep | null> {
    return this.prisma.endpoint.findFirst({ where: { id: endpointId, status: 'ACTIVE' }, select: { id: true, tenantId: true, customerId: true, siteId: true, name: true } });
  }

  /** The `monitor` block of an authenticated heartbeat response, or null when nothing is asked. */
  async heartbeatConfig(endpointId: string) {
    const ep = await this.endpoint(endpointId);
    if (!ep) return null;
    const rules = await this.rulesFor(ep);
    const evKeys = rules.filter((r) => r.kind === 'EVENT_MATCH').map((r) => r.key);
    const states = evKeys.length ? await this.prisma.endpointMonitorState.findMany({ where: { endpointId, ruleKey: { in: evKeys } }, select: { ruleKey: true, checkedAt: true } }) : [];
    return agentMonitorConfig(rules, Object.fromEntries(states.map((s) => [s.ruleKey, s.checkedAt])));
  }

  // ── Evidence in ───────────────────────────────────────────────────────────

  /** A monitor report from an authenticated agent: service states and event-rule counts. */
  async ingestReport(endpointId: string, raw: unknown, now = new Date()) {
    const ep = await this.endpoint(endpointId);
    if (!ep) return { accepted: false, reason: 'unknown_endpoint' };
    const rules = await this.rulesFor(ep);
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
        const v = evaluateEvents(r, ev, ep.name, states.get(r.key) ?? EMPTY_STATE, now);
        await this.apply(ep, r, v, now, { repeat: true, checkedAt: ev.checkedAt });
      }
    }
    return { accepted: true, services: report.services.length, events: report.events.length };
  }

  /** After a heartbeat wrote a live sample: the resource monitors. */
  async onLiveSample(endpointId: string, now = new Date()) {
    const ep = await this.endpoint(endpointId);
    if (!ep) return;
    const rules = (await this.rulesFor(ep)).filter((r) => LIVE_KINDS.has(r.kind));
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

  private async apply(ep: Ep, rule: RuleLike & { id: string }, v: Verdict, now: Date, o: { repeat: boolean; checkedAt?: string; saveState?: boolean }) {
    if (v.verdict === 'skip') return;
    if (o.saveState !== false) await this.saveState(ep.id, rule.key, v.state, o.checkedAt);
    if (v.verdict === 'breach') await this.raise(ep, rule, v.title, v.detail, now, o.repeat);
    else if (v.verdict === 'ok' && v.clear) await this.resolveOpen(dedupKeyOf(rule.key, ep.id), null, 'Cleared: the monitor reads normal again.', now);
  }

  // ── Alert lifecycle ───────────────────────────────────────────────────────

  async raise(ep: Ep, rule: RuleLike & { id: string }, title: string, detail: Record<string, unknown>, now: Date, repeat: boolean) {
    const dedupKey = dedupKeyOf(rule.key, ep.id);
    const bump = async (a: MonitorAlert) => {
      await this.prisma.monitorAlert.update({
        where: { id: a.id },
        data: { lastSeenAt: now, title: title.slice(0, 300), detail: detail as Prisma.InputJsonValue, severity: rule.severity, ruleId: rule.id, ...(repeat ? { occurrences: { increment: 1 } } : {}) },
      });
    };
    const open = await this.prisma.monitorAlert.findFirst({ where: { dedupKey, state: { not: 'RESOLVED' } } });
    if (open) { await bump(open); return open.id; }
    const notifyFrom = rule.kind === 'OFFLINE' ? new Date(now.getTime() + offlineHoldMs()) : now;
    try {
      const a = await this.prisma.monitorAlert.create({
        data: {
          tenantId: ep.tenantId, customerId: ep.customerId, siteId: ep.siteId, endpointId: ep.id, ruleId: rule.id, ruleKey: rule.key, kind: rule.kind,
          dedupKey, severity: rule.severity, title: title.slice(0, 300), detail: detail as Prisma.InputJsonValue,
          firstSeenAt: now, lastSeenAt: now, notifyFrom, nextCheckAt: notifyFrom,
          events: { create: { type: 'raised', detail: { rule: rule.key, inheritedFrom: (rule as { inheritedFrom?: string }).inheritedFrom ?? null } } },
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
        const results = await this.deliverAll(reached.flatMap((l) => l.destinations), 'alert.resolved', fresh, null);
        await this.prisma.monitorAlertEvent.create({ data: { alertId: a.id, type: 'notified', detail: { level: null, kind: 'resolved', results } as Prisma.InputJsonValue } });
      }
    }
    await this.events.emit(a.id, 'alert.resolved');
    return a.id;
  }

  // ── The sweep ─────────────────────────────────────────────────────────────

  async sweep(now = new Date()) {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.evaluateSweepRules(now);
      await this.correlateOutages(now);
      await this.notifyPass(now);
    } catch (e) {
      this.logger.error(`monitoring sweep: ${(e as Error).stack ?? e}`);
    } finally { this.busy = false; }
  }

  private async evaluateSweepRules(now: Date) {
    const rules = (await this.prisma.monitorRule.findMany()).map((r) => this.asRule(r));
    const eps = await this.prisma.endpoint.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, tenantId: true, customerId: true, siteId: true, name: true, isOnline: true, lastSeenAt: true, inventory: { select: { rebootRequired: true, updatesCheckedAt: true } } },
    });
    const valid = new Set<string>();
    const openRows = await this.prisma.monitorAlert.findMany({ where: { state: { not: 'RESOLVED' }, kind: { not: 'SITE_OUTAGE' } }, select: { id: true, dedupKey: true, kind: true, endpointId: true } });
    const open = new Map(openRows.map((a) => [a.dedupKey, a]));
    const sweepKeys = [...new Set(rules.filter((r) => SWEEP_KINDS.has(r.kind) || r.kind === 'EVENT_MATCH').map((r) => r.key))];
    const stateRows = sweepKeys.length ? await this.prisma.endpointMonitorState.findMany({ where: { ruleKey: { in: sweepKeys } } }) : [];
    const states = new Map(stateRows.map((s) => [`${s.endpointId}|${s.ruleKey}`, s as MonitorStateLike]));
    for (const ep of eps) {
      const eff = effectiveRules(rules, scopesFor(ep));
      for (const r of eff) {
        const dk = dedupKeyOf(r.key, ep.id);
        valid.add(dk);
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
          if (v.verdict === 'breach' && isOpen && !moved) continue;
          if (v.verdict !== 'breach' && !isOpen && !moved) continue;
          await this.apply(ep, r, v, now, { repeat: false, saveState: moved || v.verdict === 'breach' });
        } else if (r.kind === 'EVENT_MATCH' && open.has(dk)) {
          const v = evaluateEvents(r, undefined, ep.name, st, now);
          if (v.verdict === 'ok' && v.clear) await this.resolveOpen(dk, null, 'Cleared: no matching events for the quiet period.', now);
        }
      }
    }
    // An open alert whose monitor no longer applies (removed, disabled, moved scope) or whose computer was retired.
    for (const [dk, a] of open) {
      if (!valid.has(dk)) await this.resolveOpen(dk, null, 'Closed: the monitor no longer applies to this computer, or the computer was retired.', now);
      void a;
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
        p = row ? { levels: row.levels as unknown as NotifyLevel[], ticketing: row.ticketing as unknown as Policy['ticketing'] } : null;
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
      const results = await this.deliverAll(d.level.destinations, 'alert.notify', a, d.index);
      await this.prisma.monitorAlertEvent.create({ data: { alertId: a.id, type: d.index === 0 ? 'notified' : 'escalated', detail: { level: d.index, results } as Prisma.InputJsonValue } });
      if (d.index > 0) await this.events.emit(a.id, 'alert.updated');
    }
    const fresh = await this.prisma.monitorAlert.findUnique({ where: { id: a.id }, select: { escalationLevel: true, notifyFrom: true } });
    const next = fresh && fresh.escalationLevel < levels.length ? new Date(fresh.notifyFrom.getTime() + levels[fresh.escalationLevel].afterMinutes * 60_000) : new Date(now.getTime() + RECHECK_MS);
    await this.prisma.monitorAlert.update({ where: { id: a.id }, data: { nextCheckAt: next > now ? next : new Date(now.getTime() + 60_000) } });
  }

  /** POST the alert to each destination. Never throws; returns one line per destination. */
  async deliverAll(dests: { label: string; url: string }[], type: 'alert.notify' | 'alert.resolved', a: AlertView, level: number | null) {
    const body = JSON.stringify({ source: 'rem0te', type, level, alert: webhookView(a) });
    const out: { label: string; ok: boolean; status: string }[] = [];
    for (const d of dests) {
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
  endpoint: { select: { id: true, name: true, hostname: true } },
  site: { select: { id: true, name: true } },
  customer: { select: { id: true, name: true } },
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
