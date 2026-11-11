import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';
import { STALE_AFTER_MS as PATCH_STALE_AFTER_MS } from '../patching/summary';

/**
 * The device list (/endpoints, 0.31): search, filters, sort, pagination and
 * a CSV export of the same view.
 *
 * Scoping is decided in exactly one place, `scopedWhere()`, from the same
 * AccessControlService helpers every other endpoint list uses:
 *
 *   - `endpointVisibilityWhere()` — business scope plus, for a Business User,
 *     only assigned / COMPANY_WIDE computers, and for a technician only the
 *     computers their computers:view grants name. A `businessId` naming a
 *     business the caller cannot address is a 403 (resolveScope), not an
 *     empty page.
 *   - every filter is AND-ed onto that fragment, never OR-ed, so no
 *     parameter can add a row the fragment excludes.
 *
 * The query runs in two phases. Phase one is Prisma: the scoped, simply
 * filtered set of ids. Phase two is one SQL statement over exactly those ids
 * (`e.id = ANY($ids)`) that derives what Prisma cannot order by — open alert
 * count and worst severity, pending updates, restart pending, memory and disk
 * percentages — applies the filters on those, sorts, and pages. Phase two
 * never widens phase one: its only source of rows is the id array.
 *
 * Alerts are their own permission (monitoring:alerts). A caller without it
 * gets `alerts: null` on every row, and filtering or sorting by alerts or
 * health is refused rather than answered — an ordering is a disclosure.
 */

export const SORT_KEYS = [
  'online', 'name', 'business', 'site', 'os', 'lastSeen', 'agent', 'user',
  'cpu', 'memory', 'disk', 'patches', 'alerts', 'health',
] as const;
export type SortKey = (typeof SORT_KEYS)[number];
const ALERT_SORTS: SortKey[] = ['alerts', 'health'];

const PAGE_SIZES = [25, 50, 100, 200];
/** Largest export served. Beyond it the caller is asked to narrow the view, never given a silently truncated file. */
export const EXPORT_MAX_ROWS = 10_000;
/** The heartbeat samples CPU/RAM/disk every three minutes; five missed samples is stale. */
export const LIVE_STALE_MS = 15 * 60_000;
export { PATCH_STALE_AFTER_MS };

export interface ListQuery {
  search?: string;
  businessId?: string;
  siteId?: string;
  online?: 'online' | 'offline';
  alerts?: 'any' | 'critical';
  restartPending?: boolean;
  agent?: 'signed' | 'standard' | 'none';
  status?: 'current' | 'archived' | 'all';
  sort: SortKey;
  dir: 'asc' | 'desc';
  page: number;
  pageSize: number;
}

const str = (v: unknown, max = 200): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
};
function oneOf<T extends string>(v: unknown, allowed: readonly T[], name: string): T | undefined {
  const s = str(v, 40);
  if (s === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(s)) throw new BadRequestException(`${name} must be one of: ${allowed.join(', ')}`);
  return s as T;
}

/** Parse and bound the query string. Unknown values are a 400, never ignored into a wider view. */
export function parseListQuery(q: Record<string, unknown>): ListQuery {
  const page = Math.max(1, Math.min(100_000, parseInt(String(q.page ?? '1'), 10) || 1));
  const rawSize = parseInt(String(q.pageSize ?? '50'), 10) || 50;
  const pageSize = PAGE_SIZES.includes(rawSize) ? rawSize : 50;
  const rp = str(q.restartPending, 5);
  if (rp !== undefined && rp !== 'true' && rp !== 'false') throw new BadRequestException('restartPending must be true or false');
  const sort = oneOf(q.sort, SORT_KEYS, 'sort') ?? 'online';
  return {
    search: str(q.search, 100),
    businessId: str(q.businessId, 64),
    siteId: str(q.siteId, 64),
    online: oneOf(q.online, ['online', 'offline'] as const, 'online'),
    alerts: oneOf(q.alerts, ['any', 'critical'] as const, 'alerts'),
    restartPending: rp === 'true' ? true : undefined,
    agent: oneOf(q.agent, ['signed', 'standard', 'none'] as const, 'agent'),
    status: oneOf(q.status, ['current', 'archived', 'all'] as const, 'status') ?? 'current',
    sort,
    // Online-first and name ascending read naturally; every other column
    // starts with the "worst / most / newest" end first.
    dir: oneOf(q.dir, ['asc', 'desc'] as const, 'dir') ?? (sort === 'name' || sort === 'business' || sort === 'site' || sort === 'os' || sort === 'user' || sort === 'online' ? 'asc' : 'desc'),
    page, pageSize,
  };
}

/** Which computers' alerts this caller may see. Mirrors MonitoringAdminService.alertWhere. */
type AlertAccess = { visible: false } | { visible: true; endpointIds: string[] | null };

interface SqlRow {
  id: string; name: string; hostname: string | null; platform: string | null; osVersion: string | null;
  status: string; isOnline: boolean; lastSeenAt: Date | null; accessMode: string; deviceClass: string;
  agentVersion: string | null; updateChannel: string | null;
  customerId: string | null; customerName: string | null; siteId: string | null; siteName: string | null;
  osCaption: string | null; loggedOnUser: string | null; liveSampledAt: Date | null;
  cpuLoadPercent: number | null; memoryTotalMb: number | null; memoryFreeMb: number | null;
  systemDiskTotalMb: number | null; systemDiskFreeMb: number | null;
  patchSource: 'signed_agent_scan' | 'standard_agent_scan' | null; patchAt: Date | null;
  patchPending: number | null; rebootPending: boolean | null;
  alertCount: number; alertWorst: number | null;
  total: bigint | number;
}

const SEVERITY = [null, 'INFO', 'WARNING', 'CRITICAL'] as const;

@Injectable()
export class EndpointListService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly acl: AccessControlService,
    private readonly audit: AuditService,
  ) {}

  private alertAccess(actor: ActorContext): AlertAccess {
    if (this.acl.isBusinessOwner(actor)) return { visible: true, endpointIds: null };
    if (actor.technician) {
      const g = actor.technician.sources.filter((s) => (s.capabilities as string[]).includes(CAP.ALERTS_VIEW));
      if (!g.length) return { visible: false };
      if (g.some((s) => s.endpointIds === null)) return { visible: true, endpointIds: null };
      return { visible: true, endpointIds: [...new Set(g.flatMap((s) => s.endpointIds ?? []))] };
    }
    return actor.capabilities.includes(CAP.ALERTS_VIEW) ? { visible: true, endpointIds: null } : { visible: false };
  }

  /**
   * The caller's visible computers. Every list, facet and export starts here,
   * and so does global search (SearchService), so a search can never find a
   * computer the device list would not show.
   */
  scopedWhere(actor: ActorContext, q: Pick<ListQuery, 'businessId' | 'status'>): Prisma.EndpointWhereInput {
    this.acl.assertCapability(actor, CAP.COMPUTERS_VIEW);
    const visibility = this.acl.endpointVisibilityWhere(actor, q.businessId);
    const status: Prisma.EndpointWhereInput =
      q.status === 'archived' ? { status: 'ARCHIVED' } : q.status === 'all' ? {} : { status: { not: 'ARCHIVED' } };
    return { AND: [visibility, status] };
  }

  private filteredWhere(actor: ActorContext, q: ListQuery): Prisma.EndpointWhereInput {
    const and: Prisma.EndpointWhereInput[] = [this.scopedWhere(actor, q)];
    if (q.siteId) and.push({ siteId: q.siteId });
    if (q.online) and.push({ isOnline: q.online === 'online' });
    if (q.agent === 'signed') and.push({ updateChannel: 'signed' });
    if (q.agent === 'standard') and.push({ OR: [{ updateChannel: null }, { updateChannel: { not: 'signed' } }], agentVersion: { not: null } });
    if (q.agent === 'none') and.push({ OR: [{ updateChannel: null }, { updateChannel: { not: 'signed' } }], agentVersion: null });
    if (q.search) {
      const c = { contains: q.search, mode: 'insensitive' as const };
      and.push({
        OR: [
          { name: c }, { hostname: c }, { ipAddress: c }, { osVersion: c },
          { aliases: { some: { alias: c } } }, { rustdeskNode: { rustdeskId: c } },
          { customer: { name: c } }, { site: { name: c } },
          { inventory: { loggedOnUser: c } },
        ],
      });
    }
    return { AND: and };
  }

  private orderSql(sort: SortKey, dir: 'asc' | 'desc'): Prisma.Sql {
    const d = dir === 'asc' ? 'ASC' : 'DESC';
    // Whitelisted fragments only: `sort` is validated against SORT_KEYS, and
    // nothing from the request is ever spliced into this string.
    const expr: Record<SortKey, string> = {
      online: `e."isOnline" ${dir === 'asc' ? 'DESC' : 'ASC'}`,
      name: `lower(e.name) ${d}`,
      business: `lower(c.name) ${d} NULLS LAST`,
      site: `lower(s.name) ${d} NULLS LAST`,
      os: `lower(coalesce(i."osCaption", e."osVersion", e.platform)) ${d} NULLS LAST`,
      lastSeen: `e."lastSeenAt" ${d} NULLS LAST`,
      agent: `(CASE WHEN e."updateChannel" = 'signed' THEN 2 WHEN e."agentVersion" IS NOT NULL THEN 1 ELSE 0 END) ${d}, e."lastSeenAt" DESC NULLS LAST`,
      user: `lower(i."loggedOnUser") ${d} NULLS LAST`,
      cpu: `i."cpuLoadPercent" ${d} NULLS LAST`,
      memory: `mem_used ${d} NULLS LAST`,
      disk: `disk_used ${d} NULLS LAST`,
      patches: `patch_pending ${d} NULLS LAST`,
      alerts: `alert_count ${d}, alert_worst ${d} NULLS LAST`,
      health: `alert_worst ${d} NULLS LAST, alert_count ${d}`,
    };
    return Prisma.raw(`${expr[sort]}, e."isOnline" DESC, lower(e.name) ASC, e.id ASC`);
  }

  /** Phase two: derive, filter on what was derived, order and page — over the given ids only. */
  private async derive(ids: string[], q: ListQuery, alerts: AlertAccess, limit: number, offset: number): Promise<SqlRow[]> {
    if (ids.length === 0) return [];
    const alertAll = alerts.visible && alerts.endpointIds === null;
    const alertIds = alerts.visible && alerts.endpointIds ? alerts.endpointIds : [];
    const conds: Prisma.Sql[] = [Prisma.sql`e.id = ANY(${ids}::text[])`];
    if (q.restartPending) conds.push(Prisma.sql`d.reboot_pending IS TRUE`);
    if (q.alerts === 'any') conds.push(Prisma.sql`al.alert_count > 0`);
    if (q.alerts === 'critical') conds.push(Prisma.sql`al.alert_worst = 3`);
    return this.prisma.$queryRaw<SqlRow[]>`
      SELECT e.id, e.name, e.hostname, e.platform, e."osVersion", e.status::text AS status, e."isOnline", e."lastSeenAt",
             e."accessMode"::text AS "accessMode", e."deviceClass"::text AS "deviceClass", e."agentVersion", e."updateChannel",
             e."customerId", c.name AS "customerName", e."siteId", s.name AS "siteName",
             i."osCaption", i."loggedOnUser", i."liveSampledAt", i."cpuLoadPercent", i."memoryTotalMb", i."memoryFreeMb",
             i."systemDiskTotalMb", i."systemDiskFreeMb",
             d.patch_source AS "patchSource", d.patch_at AS "patchAt", d.patch_pending AS "patchPending", d.reboot_pending AS "rebootPending",
             al.alert_count AS "alertCount", al.alert_worst AS "alertWorst",
             COUNT(*) OVER () AS total
        FROM "Endpoint" e
        LEFT JOIN "Customer" c ON c.id = e."customerId"
        LEFT JOIN "Site" s ON s.id = e."siteId"
        LEFT JOIN "EndpointInventory" i ON i."endpointId" = e.id
        LEFT JOIN LATERAL (
          SELECT
            CASE WHEN jsonb_typeof(i."patchPosture") = 'object' THEN 'signed_agent_scan'
                 WHEN i."updatesCheckedAt" IS NOT NULL THEN 'standard_agent_scan' END AS patch_source,
            CASE WHEN jsonb_typeof(i."patchPosture") = 'object' THEN coalesce(i."patchScannedAt", i."updatesCheckedAt")
                 ELSE i."updatesCheckedAt" END AS patch_at,
            CASE WHEN jsonb_typeof(i."patchPosture"->'updates') = 'array' THEN jsonb_array_length(i."patchPosture"->'updates')
                 WHEN jsonb_typeof(i."patchPosture") = 'object' THEN NULL
                 WHEN i."updatesCheckedAt" IS NULL THEN NULL
                 WHEN jsonb_typeof(i."pendingUpdates") = 'array' THEN jsonb_array_length(i."pendingUpdates")
                 ELSE i."pendingUpdateCount" END AS patch_pending,
            CASE WHEN jsonb_typeof(i."patchPosture") = 'object'
                   THEN CASE WHEN jsonb_typeof(i."patchPosture"->'reboot'->'pending') = 'boolean'
                             THEN (i."patchPosture"->'reboot'->'pending') = 'true'::jsonb END
                 ELSE i."rebootRequired" END AS reboot_pending,
            CASE WHEN i."memoryTotalMb" > 0 AND i."memoryFreeMb" IS NOT NULL
                 THEN 100.0 * (i."memoryTotalMb" - i."memoryFreeMb") / i."memoryTotalMb" END AS mem_used,
            CASE WHEN i."systemDiskTotalMb" > 0 AND i."systemDiskFreeMb" IS NOT NULL
                 THEN 100.0 * (i."systemDiskTotalMb" - i."systemDiskFreeMb") / i."systemDiskTotalMb" END AS disk_used
        ) d ON TRUE
        LEFT JOIN LATERAL (
          SELECT count(*)::int AS alert_count,
                 max(CASE a.severity WHEN 'CRITICAL' THEN 3 WHEN 'WARNING' THEN 2 ELSE 1 END)::int AS alert_worst
            FROM "MonitorAlert" a
           WHERE a."endpointId" = e.id AND a.state IN ('OPEN', 'ACKNOWLEDGED')
             AND (${alertAll}::boolean OR a."endpointId" = ANY(${alertIds}::text[]))
        ) al ON TRUE
       WHERE ${Prisma.join(conds, ' AND ')}
       ORDER BY ${this.orderSql(q.sort, q.dir)}
       LIMIT ${limit} OFFSET ${offset}`;
  }

  private assertAlertUse(q: ListQuery, alerts: AlertAccess) {
    if (alerts.visible) return;
    if (q.alerts || ALERT_SORTS.includes(q.sort)) {
      throw new ForbiddenException({ code: 'NOT_ALLOWED', message: 'Filtering or sorting by alerts or health needs the monitoring:alerts permission.' });
    }
  }

  private rowView(r: SqlRow, alerts: AlertAccess, now: number) {
    const seesAlerts = alerts.visible && (alerts.endpointIds === null || alerts.endpointIds.includes(r.id));
    const sampled = r.liveSampledAt ? new Date(r.liveSampledAt) : null;
    const patchAt = r.patchAt ? new Date(r.patchAt) : null;
    const pct = (used: number | null, total: number | null) =>
      used === null || total === null || total <= 0 ? null : Math.round((100 * used) / total);
    const hasLive = sampled && (r.cpuLoadPercent !== null || r.memoryTotalMb !== null || r.systemDiskTotalMb !== null);
    return {
      id: r.id, name: r.name, hostname: r.hostname,
      platform: r.platform, os: r.osCaption ?? r.osVersion ?? null,
      status: r.status, isOnline: r.isOnline, lastSeenAt: r.lastSeenAt,
      deviceClass: r.deviceClass, accessMode: r.accessMode,
      business: r.customerId ? { id: r.customerId, name: r.customerName } : null,
      site: r.siteId ? { id: r.siteId, name: r.siteName } : null,
      agent: {
        type: r.updateChannel === 'signed' ? 'signed' : r.agentVersion ? 'standard' : 'none',
        version: r.agentVersion,
        lastHeartbeatAt: r.lastSeenAt,
      },
      // Exposed to exactly the callers who could already read it on the
      // device page's inventory (computers:view on this computer).
      loggedOnUser: r.loggedOnUser,
      resources: hasLive ? {
        sampledAt: sampled,
        stale: now - sampled!.getTime() > LIVE_STALE_MS,
        cpuPercent: r.cpuLoadPercent,
        memoryUsedPercent: pct(r.memoryTotalMb !== null && r.memoryFreeMb !== null ? r.memoryTotalMb - r.memoryFreeMb : null, r.memoryTotalMb),
        memoryTotalMb: r.memoryTotalMb,
        diskUsedPercent: pct(r.systemDiskTotalMb !== null && r.systemDiskFreeMb !== null ? r.systemDiskTotalMb - r.systemDiskFreeMb : null, r.systemDiskTotalMb),
        diskFreeMb: r.systemDiskFreeMb,
        diskTotalMb: r.systemDiskTotalMb,
      } : null,
      patches: {
        source: r.patchSource ?? 'none',
        checkedAt: patchAt,
        stale: patchAt ? now - patchAt.getTime() > PATCH_STALE_AFTER_MS : null,
        pendingCount: r.patchPending,
        rebootPending: r.rebootPending,
      },
      // null = this caller may not see alerts for this computer.
      alerts: seesAlerts ? { open: r.alertCount ?? 0, worst: SEVERITY[r.alertWorst ?? 0] } : null,
    };
  }

  private async ids(actor: ActorContext, q: ListQuery): Promise<string[]> {
    const rows = await this.prisma.endpoint.findMany({ where: this.filteredWhere(actor, q), select: { id: true } });
    return rows.map((r) => r.id);
  }

  async list(actor: ActorContext, q: ListQuery) {
    const alerts = this.alertAccess(actor);
    this.assertAlertUse(q, alerts);
    const [ids, facets] = await Promise.all([this.ids(actor, q), this.facets(actor, q)]);
    let page = q.page;
    let rows = await this.derive(ids, q, alerts, q.pageSize, (page - 1) * q.pageSize);
    let total = rows.length ? Number(rows[0].total) : 0;
    if (!rows.length && page > 1) {
      // Past the end (rows went away since the last page was fetched): the last real page.
      const probe = await this.derive(ids, q, alerts, 1, 0);
      total = probe.length ? Number(probe[0].total) : 0;
      page = Math.max(1, Math.ceil(total / q.pageSize));
      rows = total ? await this.derive(ids, q, alerts, q.pageSize, (page - 1) * q.pageSize) : [];
    }
    const now = Date.now();
    return {
      rows: rows.map((r) => this.rowView(r, alerts, now)),
      total, page, pageSize: q.pageSize, pages: Math.max(1, Math.ceil(total / q.pageSize)),
      sort: q.sort, dir: q.dir,
      alertsVisible: alerts.visible,
      facets,
      generatedAt: new Date(now),
      thresholds: { liveStaleMs: LIVE_STALE_MS, patchStaleMs: PATCH_STALE_AFTER_MS },
    };
  }

  /** Businesses and sites among the caller's visible computers — what the filter menus offer. */
  private async facets(actor: ActorContext, q: ListQuery) {
    // Without the caller's own businessId filter, so the menu still lists the
    // others they may pick; still the caller's visibility, still 403 for a
    // foreign business via scopedWhere in the main query.
    const groups = await this.prisma.endpoint.groupBy({
      by: ['customerId', 'siteId'],
      where: this.scopedWhere(actor, { status: q.status }),
      _count: { _all: true },
    });
    const bIds = [...new Set(groups.map((g) => g.customerId).filter((x): x is string => !!x))];
    const sIds = [...new Set(groups.map((g) => g.siteId).filter((x): x is string => !!x))];
    const [bs, ss] = await Promise.all([
      bIds.length ? this.prisma.customer.findMany({ where: { id: { in: bIds } }, select: { id: true, name: true } }) : [],
      sIds.length ? this.prisma.site.findMany({ where: { id: { in: sIds } }, select: { id: true, name: true, customerId: true } }) : [],
    ]);
    const count = (pred: (g: (typeof groups)[number]) => boolean) => groups.filter(pred).reduce((n, g) => n + g._count._all, 0);
    return {
      businesses: bs.map((b) => ({ id: b.id, name: b.name, count: count((g) => g.customerId === b.id) })).sort((a, b) => a.name.localeCompare(b.name)),
      sites: ss.map((s) => ({ id: s.id, name: s.name, businessId: s.customerId, count: count((g) => g.siteId === s.id) })).sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  /**
   * The current filtered view as CSV. Same scoping and filters as the list,
   * every page at once, capped at EXPORT_MAX_ROWS. Audited before the file
   * leaves, with logOrFail: an export nobody can see afterwards is refused.
   */
  async exportCsv(actor: ActorContext, q: ListQuery): Promise<{ filename: string; csv: string; rows: number }> {
    const alerts = this.alertAccess(actor);
    this.assertAlertUse(q, alerts);
    const ids = await this.ids(actor, q);
    const rows = await this.derive(ids, q, alerts, EXPORT_MAX_ROWS + 1, 0);
    if (rows.length > EXPORT_MAX_ROWS) {
      throw new BadRequestException({ code: 'EXPORT_TOO_LARGE', message: `This view has more than ${EXPORT_MAX_ROWS} devices. Narrow it with a filter and export again.` });
    }
    const now = Date.now();
    const views = rows.map((r) => this.rowView(r, alerts, now));
    const header = [
      'Name', 'Hostname', 'Business', 'Site', 'OS', 'Status', 'Online', 'Last seen (UTC)',
      'Agent', 'Agent version', 'Logged-in user',
      'CPU %', 'Memory used %', 'Disk used %', 'Resources sampled (UTC)', 'Resources stale',
      'Pending updates', 'Restart pending', 'Update scan source', 'Update scan (UTC)', 'Update scan stale',
      ...(alerts.visible ? ['Open alerts', 'Worst alert'] : []),
    ];
    const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : '');
    const yn = (b: boolean | null | undefined) => (b === null || b === undefined ? '' : b ? 'yes' : 'no');
    const lines = [header, ...views.map((v) => [
      v.name, v.hostname ?? '', v.business?.name ?? '', v.site?.name ?? '', v.os ?? v.platform ?? '', v.status, yn(v.isOnline), iso(v.lastSeenAt),
      v.agent.type, v.agent.version ?? '', v.loggedOnUser ?? '',
      v.resources?.cpuPercent ?? '', v.resources?.memoryUsedPercent ?? '', v.resources?.diskUsedPercent ?? '', iso(v.resources?.sampledAt), yn(v.resources?.stale),
      v.patches.pendingCount ?? '', yn(v.patches.rebootPending), v.patches.source, iso(v.patches.checkedAt), yn(v.patches.stale),
      ...(alerts.visible ? [v.alerts ? v.alerts.open : '', v.alerts?.worst ?? ''] : []),
    ])].map((cells) => cells.map(csvCell).join(','));

    const scope = actor.isPlatformAdmin ? (q.businessId ?? null) : actor.businessId;
    await this.audit.logOrFail({
      action: 'ENDPOINT_LIST_EXPORTED', actorId: actor.userId, actorIp: actor.ip,
      tenantId: actor.tenantId ?? undefined, customerId: scope ?? undefined,
      resource: 'endpoint', meta: {
        rows: views.length,
        filters: {
          search: q.search ?? null, businessId: q.businessId ?? null, siteId: q.siteId ?? null, online: q.online ?? null,
          alerts: q.alerts ?? null, restartPending: q.restartPending ?? null, agent: q.agent ?? null, status: q.status,
        },
        sort: q.sort, dir: q.dir, viaTechnicianAssignment: !!actor.technician,
      },
    });
    const stamp = new Date(now).toISOString().slice(0, 16).replace(/[:T]/g, '-');
    // \r\n and a BOM so a spreadsheet opens it as UTF-8 with the rows split.
    return { filename: `devices-${stamp}.csv`, csv: '\uFEFF' + lines.join('\r\n') + '\r\n', rows: views.length };
  }
}

/**
 * One CSV cell. Device names, hostnames and logged-on users are reported by
 * the device, so a cell that a spreadsheet would read as a formula (= + - @,
 * tab, CR) is prefixed with an apostrophe — CSV injection — and every cell
 * is quoted.
 */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}
