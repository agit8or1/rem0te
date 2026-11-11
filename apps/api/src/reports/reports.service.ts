import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';
import { MonitoringAdminService } from '../monitoring/monitoring-admin.service';
import { effectiveRules, scopesFor, type RuleLike } from '../monitoring/engine';
import { STALE_AFTER_MS } from '../patching/summary';
import { deviceCompliance, tally, PATCH_COMPLIANCE_DEFINITION, PATCH_INVENTORY_SELECT, type DeviceCompliance } from '../patching/compliance';
import { csvCell, EXPORT_MAX_ROWS } from '../endpoints/endpoint-list.service';

/**
 * Reports (0.32): patch compliance, agent coverage, alert frequency and
 * offline time — each computed only from what the database really stores.
 *
 * Scoping is the dashboard's and the device list's, called rather than
 * copied:
 *   devices  `acl.endpointVisibilityWhere` AND-ed with the filters (never
 *            spread beside another OR — that is how 0.31's first fix leaked),
 *            ACTIVE computers only, as the dashboard counts them;
 *   alerts   `MonitoringAdminService.alertWhere` (the alerts list's own rule,
 *            which throws without monitoring:alerts) AND-ed with the same
 *            endpoint visibility, so a technician's report never names a
 *            computer their computers:view grants do not.
 * A business the caller cannot address is a 403 (resolveScope), not an empty
 * report. Each report needs the capability of the data it summarises:
 * computers:view for patch compliance and agent coverage, monitoring:alerts
 * for alert frequency and offline time.
 *
 * Offline time is derived from OFFLINE monitor alerts: `Endpoint.isOnline` is
 * a flag the staleness sweep overwrites and keeps no history, so it cannot be
 * a time series. An OFFLINE alert records the last heartbeat before the
 * silence (`detail.lastSeenAt`), when the monitor noticed, and when it cleared
 * because the computer reconnected. That is a recorded episode, and only
 * computers with an enabled OFFLINE monitor have them. No availability
 * percentage is given: which computers were monitored, and when, is not
 * recorded (MonitorRule keeps no history), so the denominator is unknown.
 *
 * Exports are the device list's: the same row cap (refused, never truncated),
 * the same formula-cell neutralisation, and an audit row (REPORT_EXPORTED)
 * written with logOrFail before the file leaves.
 */

export const REPORT_KEYS = ['patch-compliance', 'agent-coverage', 'alert-frequency', 'offline-time'] as const;
export type ReportKey = (typeof REPORT_KEYS)[number];

export const PERIOD_DAYS = [1, 7, 30, 90, 365] as const;
export const SILENT_DAYS = [1, 3, 7, 14, 30, 90] as const;
/** Rows a page shows in any one list; the export carries all of them. */
export const PAGE_LIST_MAX = 200;
/** Alerts read for one report. Beyond it the caller is asked for a shorter period, never given a partial count. */
export const ALERT_ROWS_MAX = 50_000;

export interface ReportQuery {
  businessId?: string;
  siteId?: string;
  days: number;
  silentDays: number;
}

const str = (v: unknown, max = 64): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
};
function intOf(v: unknown, allowed: readonly number[], fallback: number, name: string): number {
  const s = str(v, 6);
  if (s === undefined) return fallback;
  const n = Number(s);
  if (!allowed.includes(n)) throw new BadRequestException(`${name} must be one of: ${allowed.join(', ')}`);
  return n;
}

/** Parse and bound the query string. Unknown values are a 400, never widened into a default. */
export function parseReportQuery(q: Record<string, unknown>): ReportQuery {
  const siteId = str(q.siteId);
  if (siteId !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(siteId)) throw new BadRequestException('siteId is not an id');
  return {
    businessId: str(q.businessId),
    siteId,
    days: intOf(q.days, PERIOD_DAYS, 30, 'days'),
    silentDays: intOf(q.silentDays, SILENT_DAYS, 7, 'silentDays'),
  };
}

type Ref = { id: string; name: string };
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const label = (e: { name: string; hostname: string | null }) => e.hostname || e.name;
const minutes = (ms: number) => Math.round(ms / 6_000) / 10;
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const byName = <T extends { name: string }>(a: T | null, b: T | null) => (a?.name ?? '\uffff').localeCompare(b?.name ?? '\uffff');
const agentType = (e: { updateChannel: string | null; agentVersion: string | null }) =>
  e.updateChannel === 'signed' ? 'signed' : e.agentVersion ? 'standard' : 'none';
const isWindows = (p: string | null | undefined) => !!p && /windows/i.test(p);
const RANK: Record<DeviceCompliance['state'], number> = { needs_updates: 0, stale_scan: 1, no_scan: 2, up_to_date: 3 };

@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly acl: AccessControlService,
    private readonly audit: AuditService,
    private readonly monitoring: MonitoringAdminService,
  ) {}

  // ── Scope ─────────────────────────────────────────────────────────────────

  /** The caller's visible ACTIVE computers, narrowed by site. Every device report starts here. */
  private devicesWhere(actor: ActorContext, q: Pick<ReportQuery, 'businessId' | 'siteId'>): Prisma.EndpointWhereInput {
    this.acl.assertCapability(actor, CAP.COMPUTERS_VIEW);
    const and: Prisma.EndpointWhereInput[] = [this.acl.endpointVisibilityWhere(actor, q.businessId), { status: 'ACTIVE' }];
    if (q.siteId) and.push({ siteId: q.siteId });
    return { AND: and };
  }

  /** The caller's visible alerts, narrowed by site. Every alert report starts here. */
  private alertsWhere(actor: ActorContext, q: Pick<ReportQuery, 'businessId' | 'siteId'>): Prisma.MonitorAlertWhereInput {
    // alertWhere throws Forbidden without monitoring:alerts, and 403s a foreign business.
    const and: Prisma.MonitorAlertWhereInput[] = [
      this.monitoring.alertWhere(actor, q.businessId),
      // A site-wide alert (site outage) has no computer; every other one must be on a computer this caller can see.
      { OR: [{ endpointId: null }, { endpoint: this.acl.endpointVisibilityWhere(actor, q.businessId) }] },
    ];
    if (q.siteId) and.push({ siteId: q.siteId });
    return { AND: and };
  }

  /** Businesses and sites the filter menus offer — from the same scoped source as the report. */
  private async facets(actor: ActorContext, source: 'devices' | 'alerts') {
    const pairs: { customerId: string | null; siteId: string | null }[] = source === 'devices'
      ? await this.prisma.endpoint.groupBy({ by: ['customerId', 'siteId'] as const, where: this.devicesWhere(actor, {}), _count: { _all: true } }).then((g) => g.map(({ customerId, siteId }) => ({ customerId, siteId })))
      : await this.prisma.monitorAlert.groupBy({ by: ['customerId', 'siteId'] as const, where: this.alertsWhere(actor, {}), _count: { _all: true } }).then((g) => g.map(({ customerId, siteId }) => ({ customerId, siteId })));
    const bIds = [...new Set(pairs.map((g) => g.customerId).filter((x): x is string => !!x))];
    const sIds = [...new Set(pairs.map((g) => g.siteId).filter((x): x is string => !!x))];
    const [bs, ss] = await Promise.all([
      bIds.length ? this.prisma.customer.findMany({ where: { id: { in: bIds } }, select: { id: true, name: true } }) : [],
      sIds.length ? this.prisma.site.findMany({ where: { id: { in: sIds } }, select: { id: true, name: true, customerId: true } }) : [],
    ]);
    return {
      businesses: (bs as Ref[]).sort((a, b) => a.name.localeCompare(b.name)),
      sites: (ss as (Ref & { customerId: string })[]).map((s) => ({ id: s.id, name: s.name, businessId: s.customerId })).sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  private head(actor: ActorContext, q: ReportQuery, now: Date) {
    const scope = this.acl.resolveScope(actor, q.businessId);
    return { generatedAt: now.toISOString(), scope: scope ? 'business' : 'platform', businessId: scope, siteId: q.siteId ?? null };
  }

  // ── Patch compliance ──────────────────────────────────────────────────────

  private async patchRows(actor: ActorContext, q: ReportQuery, now: Date) {
    const eps = await this.prisma.endpoint.findMany({
      where: this.devicesWhere(actor, q),
      select: {
        id: true, name: true, hostname: true, platform: true, isOnline: true, lastSeenAt: true,
        customer: { select: { id: true, name: true } }, site: { select: { id: true, name: true } },
        inventory: { select: PATCH_INVENTORY_SELECT },
      },
    });
    return eps.map((e) => ({
      device: { id: e.id, name: label(e) }, business: e.customer as Ref | null, site: e.site as Ref | null,
      platform: e.platform, windows: isWindows(e.platform), isOnline: e.isOnline, lastSeenAt: e.lastSeenAt,
      c: deviceCompliance(e.inventory, e, now),
    }));
  }

  async patchCompliance(actor: ActorContext, q: ReportQuery) {
    const now = new Date();
    const head = this.head(actor, q, now);
    const [rows, facets] = await Promise.all([this.patchRows(actor, q, now), this.facets(actor, 'devices')]);
    type Row = (typeof rows)[number];
    const summarise = (list: Row[]) => {
      const fresh = list.filter((r) => r.c.freshness === 'fresh');
      return {
        ...tally(list.map((r) => r.c)),
        // Not Windows: there is no Windows Update scan to have. Still in noScan, as the dashboard counts it.
        noScanNotWindows: list.filter((r) => r.c.state === 'no_scan' && !r.windows).length,
        restartPending: fresh.filter((r) => r.c.rebootRequired === true).length,
        pendingUpdates: fresh.reduce((n, r) => n + r.c.pendingCount, 0),
      };
    };
    const group = <M extends object>(key: (r: Row) => string, make: (r: Row) => M) => {
      const m = new Map<string, Row[]>();
      for (const r of rows) { const k = key(r); const l = m.get(k) ?? []; l.push(r); m.set(k, l); }
      return [...m.values()].map((l) => ({ ...make(l[0]), ...summarise(l) }));
    };
    const byBusiness = group((r) => r.business?.id ?? '', (r) => ({ business: r.business }))
      .sort((a, b) => byName(a.business, b.business));
    const bySite = group((r) => `${r.business?.id ?? ''}|${r.site?.id ?? ''}`, (r) => ({ business: r.business, site: r.site }))
      .sort((a, b) => byName(a.business, b.business) || byName(a.site, b.site));
    const attention = rows.filter((r) => r.c.state !== 'up_to_date')
      .sort((a, b) => RANK[a.c.state] - RANK[b.c.state] || b.c.pendingCount - a.c.pendingCount || a.device.name.localeCompare(b.device.name));
    const scans = rows.map((r) => r.c.scanAt).filter((d): d is Date => !!d).sort((a, b) => a.getTime() - b.getTime());
    return {
      ...head,
      definition: PATCH_COMPLIANCE_DEFINITION,
      staleAfterHours: STALE_AFTER_MS / 3_600_000,
      totals: summarise(rows),
      oldestScanAt: iso(scans[0]), newestScanAt: iso(scans[scans.length - 1]),
      byBusiness, bySite,
      devices: attention.slice(0, PAGE_LIST_MAX).map((r) => this.patchView(r)),
      devicesTotal: attention.length,
      facets,
    };
  }

  private patchView(r: Awaited<ReturnType<ReportsService['patchRows']>>[number]) {
    return {
      device: r.device, business: r.business, site: r.site, platform: r.platform, windows: r.windows,
      state: r.c.state, source: r.c.source, scanAt: iso(r.c.scanAt), pendingCount: r.c.freshness === 'none' ? null : r.c.pendingCount,
      rebootRequired: r.c.rebootRequired, isOnline: r.isOnline, lastSeenAt: iso(r.lastSeenAt),
    };
  }

  // ── Agent coverage ────────────────────────────────────────────────────────

  private async agentRows(actor: ActorContext, q: ReportQuery) {
    const eps = await this.prisma.endpoint.findMany({
      where: this.devicesWhere(actor, q),
      select: {
        id: true, name: true, hostname: true, platform: true, isOnline: true, lastSeenAt: true, createdAt: true,
        agentVersion: true, updateChannel: true,
        customer: { select: { id: true, name: true } }, site: { select: { id: true, name: true } },
        // Whether a secret is bound — never the hash itself.
        rustdeskNode: { select: { agentSecretHash: true } },
        inventory: { select: { collectedAt: true } },
      },
    });
    return eps.map((e) => ({
      device: { id: e.id, name: label(e) }, business: e.customer as Ref | null, site: e.site as Ref | null,
      platform: e.platform, windows: isWindows(e.platform), isOnline: e.isOnline, lastSeenAt: e.lastSeenAt,
      agent: { type: agentType(e), version: e.agentVersion },
      secret: !e.rustdeskNode ? 'no_rustdesk_record' as const : e.rustdeskNode.agentSecretHash ? 'bound' as const : 'none' as const,
      inventoryAt: e.inventory?.collectedAt ?? null,
    }));
  }

  async agentCoverage(actor: ActorContext, q: ReportQuery) {
    const now = new Date();
    const head = this.head(actor, q, now);
    const [rows, facets] = await Promise.all([this.agentRows(actor, q), this.facets(actor, 'devices')]);
    const silentBefore = now.getTime() - q.silentDays * 86_400_000;
    type Row = (typeof rows)[number];
    const silent = (r: Row) => !r.lastSeenAt || r.lastSeenAt.getTime() < silentBefore;
    const noSecret = (r: Row) => r.secret !== 'bound';
    const nonWinNoInv = (r: Row) => !r.windows && !r.inventoryAt;
    const summarise = (l: Row[]) => ({
      total: l.length,
      signed: l.filter((r) => r.agent.type === 'signed').length,
      standard: l.filter((r) => r.agent.type === 'standard').length,
      none: l.filter((r) => r.agent.type === 'none').length,
      noDeviceSecret: l.filter(noSecret).length,
      silent: l.filter(silent).length,
      nonWindowsNoInventory: l.filter(nonWinNoInv).length,
    });
    const versions = new Map<string, { type: string; version: string | null; count: number }>();
    for (const r of rows) {
      const k = `${r.agent.type}|${r.agent.version ?? ''}`;
      const v = versions.get(k) ?? { type: r.agent.type, version: r.agent.version, count: 0 };
      v.count++; versions.set(k, v);
    }
    const TYPE_ORDER: Record<string, number> = { signed: 0, standard: 1, none: 2 };
    const sites = new Map<string, Row[]>();
    for (const r of rows) { const k = `${r.business?.id ?? ''}|${r.site?.id ?? ''}`; const l = sites.get(k) ?? []; l.push(r); sites.set(k, l); }
    const view = (r: Row) => ({
      device: r.device, business: r.business, site: r.site, platform: r.platform,
      agent: r.agent, secret: r.secret, lastSeenAt: iso(r.lastSeenAt), isOnline: r.isOnline, inventoryAt: iso(r.inventoryAt),
    });
    const list = (pred: (r: Row) => boolean, order: (a: Row, b: Row) => number) => {
      const l = rows.filter(pred).sort(order);
      return { total: l.length, rows: l.slice(0, PAGE_LIST_MAX).map(view) };
    };
    const byLastSeen = (a: Row, b: Row) => (a.lastSeenAt?.getTime() ?? 0) - (b.lastSeenAt?.getTime() ?? 0) || a.device.name.localeCompare(b.device.name);
    const byDevice = (a: Row, b: Row) => a.device.name.localeCompare(b.device.name);
    return {
      ...head,
      silentDays: q.silentDays,
      definitions: {
        agent: 'Signed: the agent reports the signed update channel. Standard: it reports an agent version on the standard channel. None: no agent has ever reported a version (RustDesk only, or never checked in).',
        deviceSecret: 'A device secret is bound when the agent\'s installer registered one and the server stored it. Without one, a heartbeat is accepted as "online" but nothing it reports is written.',
        silent: `Not heard from: no heartbeat in the last ${q.silentDays} day${q.silentDays === 1 ? '' : 's'}, or never.`,
        nonWindowsNoInventory: 'Not Windows (or no platform reported) and no inventory pass ever received. The read-only Linux (0.32) and macOS (0.33) agents send one; these are computers installed before their agent existed, or a Mac installed without sudo.',
      },
      totals: summarise(rows),
      versions: [...versions.values()].sort((a, b) => TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || (b.version ?? '').localeCompare(a.version ?? '', undefined, { numeric: true }) || b.count - a.count),
      bySite: [...sites.values()].map((l) => ({ business: l[0].business, site: l[0].site, ...summarise(l) }))
        .sort((a, b) => byName(a.business, b.business) || byName(a.site, b.site)),
      noDeviceSecret: list(noSecret, byDevice),
      silent: list(silent, byLastSeen),
      nonWindowsNoInventory: list(nonWinNoInv, byDevice),
      facets,
    };
  }

  // ── Alert frequency ───────────────────────────────────────────────────────

  private period(q: ReportQuery, now: Date) {
    return { from: new Date(now.getTime() - q.days * 86_400_000), to: now };
  }

  private async alertRows(actor: ActorContext, q: ReportQuery, now: Date) {
    const { from } = this.period(q, now);
    const rows = await this.prisma.monitorAlert.findMany({
      where: { AND: [this.alertsWhere(actor, q), { firstSeenAt: { gte: from, lte: now } }] },
      select: {
        id: true, kind: true, ruleKey: true, severity: true, state: true, title: true, suppressed: true, parentId: true,
        firstSeenAt: true, resolvedAt: true, resolvedById: true,
        customer: { select: { id: true, name: true } }, site: { select: { id: true, name: true } },
        endpoint: { select: { id: true, name: true, hostname: true } },
      },
      orderBy: [{ firstSeenAt: 'asc' }, { id: 'asc' }],
      take: ALERT_ROWS_MAX + 1,
    });
    if (rows.length > ALERT_ROWS_MAX) {
      throw new BadRequestException({ code: 'REPORT_TOO_LARGE', message: `More than ${ALERT_ROWS_MAX} alerts were raised in this period. Choose a shorter period or one business.` });
    }
    return rows;
  }

  async alertFrequency(actor: ActorContext, q: ReportQuery) {
    const now = new Date();
    const head = this.head(actor, q, now);
    const [rows, facets] = await Promise.all([this.alertRows(actor, q, now), this.facets(actor, 'alerts')]);
    type Row = (typeof rows)[number];
    const summarise = (l: Row[]) => {
      const done = l.filter((r) => r.state === 'RESOLVED' && r.resolvedAt);
      const ttr = done.map((r) => r.resolvedAt!.getTime() - r.firstSeenAt.getTime());
      return {
        raised: l.length,
        critical: l.filter((r) => r.severity === 'CRITICAL').length,
        warning: l.filter((r) => r.severity === 'WARNING').length,
        info: l.filter((r) => r.severity === 'INFO').length,
        inMaintenance: l.filter((r) => r.suppressed).length,
        open: l.filter((r) => r.state !== 'RESOLVED').length,
        resolved: done.length,
        resolvedByPerson: done.filter((r) => r.resolvedById).length,
        resolvedByMonitor: done.filter((r) => !r.resolvedById).length,
        medianResolveMinutes: ttr.length ? minutes(median(ttr)!) : null,
        meanResolveMinutes: ttr.length ? minutes(ttr.reduce((a, b) => a + b, 0) / ttr.length) : null,
        longestResolveMinutes: ttr.length ? minutes(Math.max(...ttr)) : null,
      };
    };
    // Most raised first; ties keep the order their first alert was raised in (rows are oldest first).
    const group = <G extends object>(key: (r: Row) => string, make: (r: Row) => G) => {
      const m = new Map<string, Row[]>();
      for (const r of rows) { const k = key(r); const l = m.get(k) ?? []; l.push(r); m.set(k, l); }
      return [...m.values()].map((l) => ({ ...make(l[0]), ...summarise(l) })).sort((a, b) => b.raised - a.raised);
    };
    const dev = (r: Row) => (r.endpoint ? { id: r.endpoint.id, name: label(r.endpoint) } : null);
    const byComputer = group((r) => r.endpoint?.id ?? `site:${r.site?.id ?? ''}`, (r) => ({ business: r.customer, site: r.site, device: dev(r) }));
    const { from, to } = this.period(q, now);
    return {
      ...head,
      days: q.days, from: from.toISOString(), to: to.toISOString(),
      definitions: {
        raised: 'An alert counts in the period it was first raised. A repeat of the same open problem is one alert (its occurrences are counted on the alert, not here). A site outage and each computer\'s offline alert grouped under it are each counted.',
        resolve: 'Time to resolve is from when the alert was first raised to when it was resolved — by the monitor reading normal again, or by a person. Alerts still open are not in it.',
      },
      totals: summarise(rows),
      byBusiness: group((r) => r.customer?.id ?? '', (r) => ({ business: r.customer })),
      bySite: group((r) => `${r.customer?.id ?? ''}|${r.site?.id ?? ''}`, (r) => ({ business: r.customer, site: r.site })),
      byComputer: byComputer.slice(0, PAGE_LIST_MAX),
      byComputerTotal: byComputer.length,
      byMonitor: group((r) => r.kind, (r) => ({ kind: r.kind })).sort((a, b) => b.raised - a.raised || a.kind.localeCompare(b.kind)),
      facets,
    };
  }

  // ── Offline time ──────────────────────────────────────────────────────────

  private async offlineEpisodes(actor: ActorContext, q: ReportQuery, now: Date) {
    const { from } = this.period(q, now);
    const base = this.alertsWhere(actor, q);
    const rows = await this.prisma.monitorAlert.findMany({
      where: {
        AND: [base, { kind: 'OFFLINE', endpointId: { not: null }, firstSeenAt: { lte: now } }, { OR: [{ resolvedAt: null }, { resolvedAt: { gte: from } }] }],
      },
      select: {
        id: true, state: true, firstSeenAt: true, resolvedAt: true, resolvedById: true, resolveNote: true, detail: true,
        customer: { select: { id: true, name: true } }, site: { select: { id: true, name: true } },
        endpoint: { select: { id: true, name: true, hostname: true } },
      },
      orderBy: [{ firstSeenAt: 'asc' }, { id: 'asc' }],
      take: ALERT_ROWS_MAX + 1,
    });
    if (rows.length > ALERT_ROWS_MAX) {
      throw new BadRequestException({ code: 'REPORT_TOO_LARGE', message: `More than ${ALERT_ROWS_MAX} offline alerts fall in this period. Choose a shorter period or one business.` });
    }
    const earliest = await this.prisma.monitorAlert.aggregate({ where: { AND: [base, { kind: 'OFFLINE' }] }, _min: { firstSeenAt: true } });

    type Comp = {
      device: Ref; business: Ref | null; site: Ref | null;
      spans: [number, number][]; alerts: number; stillOffline: boolean; endedByPerson: number; closedWithoutReconnect: number; lastOfflineAt: number;
    };
    const comps = new Map<string, Comp>();
    const lo = from.getTime(), hi = now.getTime();
    for (const r of rows) {
      const e = r.endpoint!;
      // The last heartbeat before the silence, as the monitor recorded it; else when it noticed.
      const seen = typeof (r.detail as { lastSeenAt?: unknown } | null)?.lastSeenAt === 'string' ? Date.parse((r.detail as { lastSeenAt: string }).lastSeenAt) : NaN;
      const start = Number.isFinite(seen) && seen <= r.firstSeenAt.getTime() ? seen : r.firstSeenAt.getTime();
      const end = r.state === 'RESOLVED' && r.resolvedAt ? r.resolvedAt.getTime() : hi;
      let c = comps.get(e.id);
      if (!c) { c = { device: { id: e.id, name: label(e) }, business: r.customer, site: r.site, spans: [], alerts: 0, stillOffline: false, endedByPerson: 0, closedWithoutReconnect: 0, lastOfflineAt: 0 }; comps.set(e.id, c); }
      c.alerts++;
      if (r.state !== 'RESOLVED') c.stillOffline = true;
      else if (r.resolvedById) c.endedByPerson++;
      else if (!/^Cleared/.test(r.resolveNote ?? '')) c.closedWithoutReconnect++;
      c.lastOfflineAt = Math.max(c.lastOfflineAt, start);
      const s = Math.max(start, lo), t = Math.min(end, hi);
      if (t > s) c.spans.push([s, t]);
    }
    const out = [...comps.values()].map((c) => {
      // A person resolving an alert while the computer is still silent makes
      // the monitor raise a new one: the two overlap, so spans are merged.
      const merged: [number, number][] = [];
      for (const [s, t] of c.spans.sort((a, b) => a[0] - b[0])) {
        const last = merged[merged.length - 1];
        if (last && s <= last[1]) last[1] = Math.max(last[1], t); else merged.push([s, t]);
      }
      const total = merged.reduce((n, [s, t]) => n + (t - s), 0);
      return {
        device: c.device, business: c.business, site: c.site,
        offlineMinutes: minutes(total), episodes: merged.length, alerts: c.alerts,
        longestMinutes: merged.length ? minutes(Math.max(...merged.map(([s, t]) => t - s))) : 0,
        stillOffline: c.stillOffline, endedByPerson: c.endedByPerson, closedWithoutReconnect: c.closedWithoutReconnect,
        lastOfflineAt: new Date(c.lastOfflineAt).toISOString(),
      };
    }).sort((a, b) => b.offlineMinutes - a.offlineMinutes || a.device.name.localeCompare(b.device.name));
    return { computers: out, recordsBeginAt: earliest._min.firstSeenAt };
  }

  async offlineTime(actor: ActorContext, q: ReportQuery) {
    const now = new Date();
    const head = this.head(actor, q, now);
    const [{ computers, recordsBeginAt }, facets] = await Promise.all([this.offlineEpisodes(actor, q, now), this.facets(actor, 'alerts')]);
    // Which visible computers have an enabled OFFLINE monitor right now. Only
    // "now": rules keep no history, so this is said as current coverage.
    let coverage: { computers: number; monitored: number; notMonitored: { total: number; rows: { device: Ref; business: Ref | null; site: Ref | null }[] } } | null = null;
    if (this.acl.can(actor, CAP.COMPUTERS_VIEW)) {
      const [eps, rules] = await Promise.all([
        this.prisma.endpoint.findMany({ where: this.devicesWhere(actor, q), select: { id: true, name: true, hostname: true, customerId: true, siteId: true, customer: { select: { id: true, name: true } }, site: { select: { id: true, name: true } } } }),
        this.prisma.monitorRule.findMany({ select: { id: true, scopeKey: true, key: true, kind: true, enabled: true, severity: true, params: true, name: true } }),
      ]);
      const rl = rules as unknown as RuleLike[];
      const not = eps.filter((e) => !effectiveRules(rl, scopesFor(e)).some((r) => r.kind === 'OFFLINE'))
        .map((e) => ({ device: { id: e.id, name: label(e) }, business: e.customer as Ref | null, site: e.site as Ref | null }))
        .sort((a, b) => a.device.name.localeCompare(b.device.name));
      coverage = { computers: eps.length, monitored: eps.length - not.length, notMonitored: { total: not.length, rows: not.slice(0, PAGE_LIST_MAX) } };
    }
    const sum = (l: typeof computers) => ({
      computers: l.length,
      offlineMinutes: Math.round(l.reduce((n, c) => n + c.offlineMinutes, 0) * 10) / 10,
      episodes: l.reduce((n, c) => n + c.episodes, 0),
      stillOffline: l.filter((c) => c.stillOffline).length,
    });
    const bySiteMap = new Map<string, typeof computers>();
    for (const c of computers) { const k = `${c.business?.id ?? ''}|${c.site?.id ?? ''}`; const l = bySiteMap.get(k) ?? []; l.push(c); bySiteMap.set(k, l); }
    const { from, to } = this.period(q, now);
    return {
      ...head,
      days: q.days, from: from.toISOString(), to: to.toISOString(),
      recordsBeginAt: iso(recordsBeginAt),
      definition: 'Offline time is measured from OFFLINE monitor alerts: from the last heartbeat before the silence to the moment the computer reconnected (or now, if it has not). Only computers with an enabled Offline monitor have records, and only silences longer than that monitor\'s threshold (15 minutes by default). There is no availability percentage: which computers were monitored, and when, is not recorded, so the time under monitoring is unknown.',
      totals: sum(computers),
      bySite: [...bySiteMap.values()].map((l) => ({ business: l[0].business, site: l[0].site, ...sum(l) })).sort((a, b) => b.offlineMinutes - a.offlineMinutes),
      computers: computers.slice(0, PAGE_LIST_MAX),
      computersTotal: computers.length,
      coverage,
      facets,
    };
  }

  // ── Export ────────────────────────────────────────────────────────────────

  /**
   * One report as CSV: every row, capped at EXPORT_MAX_ROWS (refused above
   * it), formula cells neutralised, audited with logOrFail before it leaves.
   */
  async exportCsv(actor: ActorContext, report: ReportKey, q: ReportQuery, via?: { scheduleId: string; recipients: number }): Promise<{ filename: string; csv: string; rows: number }> {
    const now = new Date();
    const yn = (b: boolean | null | undefined) => (b === null || b === undefined ? '' : b ? 'yes' : 'no');
    let header: string[];
    let lines: unknown[][];
    if (report === 'patch-compliance') {
      const rows = (await this.patchRows(actor, q, now))
        .sort((a, b) => byName(a.business, b.business) || byName(a.site, b.site) || a.device.name.localeCompare(b.device.name));
      header = ['Business', 'Site', 'Device', 'Platform', 'State', 'Scan source', 'Scan (UTC)', 'Pending updates', 'Restart pending', 'Online', 'Last seen (UTC)'];
      lines = rows.map((r) => this.patchView(r)).map((v) => [
        v.business?.name ?? '', v.site?.name ?? '', v.device.name, v.platform ?? '', v.state, v.source, v.scanAt ?? '', v.pendingCount ?? '', yn(v.rebootRequired), yn(v.isOnline), v.lastSeenAt ?? '',
      ]);
    } else if (report === 'agent-coverage') {
      const silentBefore = now.getTime() - q.silentDays * 86_400_000;
      const rows = (await this.agentRows(actor, q))
        .sort((a, b) => byName(a.business, b.business) || byName(a.site, b.site) || a.device.name.localeCompare(b.device.name));
      header = ['Business', 'Site', 'Device', 'Platform', 'Agent', 'Agent version', 'Device secret', `Not heard from in ${q.silentDays} days`, 'Last seen (UTC)', 'Inventory received (UTC)'];
      lines = rows.map((r) => [
        r.business?.name ?? '', r.site?.name ?? '', r.device.name, r.platform ?? '', r.agent.type, r.agent.version ?? '',
        r.secret === 'bound' ? 'bound' : r.secret === 'none' ? 'none' : 'no RustDesk record',
        yn(!r.lastSeenAt || r.lastSeenAt.getTime() < silentBefore), iso(r.lastSeenAt) ?? '', iso(r.inventoryAt) ?? '',
      ]);
    } else if (report === 'alert-frequency') {
      const rows = await this.alertRows(actor, q, now);
      header = ['Raised (UTC)', 'Business', 'Site', 'Computer', 'Monitor type', 'Monitor', 'Severity', 'Title', 'State', 'In maintenance', 'Resolved (UTC)', 'Resolved by', 'Minutes to resolve'];
      lines = rows.map((r) => [
        r.firstSeenAt.toISOString(), r.customer?.name ?? '', r.site?.name ?? '', r.endpoint ? label(r.endpoint) : '', r.kind, r.ruleKey, r.severity, r.title, r.state, yn(r.suppressed),
        r.state === 'RESOLVED' ? iso(r.resolvedAt) ?? '' : '', r.state === 'RESOLVED' ? (r.resolvedById ? 'person' : 'monitor') : '',
        r.state === 'RESOLVED' && r.resolvedAt ? minutes(r.resolvedAt.getTime() - r.firstSeenAt.getTime()) : '',
      ]);
    } else {
      const { computers } = await this.offlineEpisodes(actor, q, now);
      header = ['Business', 'Site', 'Computer', 'Offline minutes', 'Episodes', 'Longest episode (minutes)', 'Still offline', 'Ended by a person', 'Closed without reconnecting', 'Last went offline (UTC)'];
      lines = computers.map((c) => [
        c.business?.name ?? '', c.site?.name ?? '', c.device.name, c.offlineMinutes, c.episodes, c.longestMinutes, yn(c.stillOffline), c.endedByPerson, c.closedWithoutReconnect, c.lastOfflineAt,
      ]);
    }
    if (lines.length > EXPORT_MAX_ROWS) {
      throw new BadRequestException({ code: 'EXPORT_TOO_LARGE', message: `This report has more than ${EXPORT_MAX_ROWS} rows. Narrow it with a business, site or shorter period and export again.` });
    }
    const scope = actor.isPlatformAdmin ? (q.businessId ?? null) : actor.businessId;
    await this.audit.logOrFail({
      action: 'REPORT_EXPORTED', actorId: actor.userId, actorIp: actor.ip,
      tenantId: actor.tenantId ?? undefined, customerId: scope ?? undefined,
      resource: 'report', resourceId: report,
      meta: {
        report, rows: lines.length,
        filters: {
          businessId: q.businessId ?? null, siteId: q.siteId ?? null,
          ...(report === 'alert-frequency' || report === 'offline-time' ? { days: q.days } : {}),
          ...(report === 'agent-coverage' ? { silentDays: q.silentDays } : {}),
        },
        viaTechnicianAssignment: !!actor.technician,
        // 0.34: a scheduled report's CSV is this same export, evaluated as the schedule's owner.
        ...(via ? { via: 'schedule', scheduleId: via.scheduleId, recipients: via.recipients } : {}),
      },
    });
    const stamp = now.toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const body = [header, ...lines].map((cells) => cells.map(csvCell).join(','));
    return { filename: `${report}-${stamp}.csv`, csv: '\uFEFF' + body.join('\r\n') + '\r\n', rows: lines.length };
  }
}

