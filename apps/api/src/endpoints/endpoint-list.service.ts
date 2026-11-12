import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { connectivityOf, heartbeatCutoff, HEARTBEAT_STALE_MS, type Connectivity } from '../common/connectivity';
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

import { versionParts, type ListFilters, type ListQuery, type SortKey } from './list-query';
import { likeEscape } from '../common/like';
import { groupsCell } from '../device-views/rules';
import { ruleFilters, ruleNeedsAlerts } from '../device-views/group-rule';
export { SORT_KEYS, LIST_FILTER_KEYS, parseListQuery } from './list-query';
export type { SortKey, ListQuery } from './list-query';

const ALERT_SORTS: SortKey[] = ['alerts', 'health'];
/** Largest export served. Beyond it the caller is asked to narrow the view, never given a silently truncated file. */
export const EXPORT_MAX_ROWS = 10_000;
/** The heartbeat samples CPU/RAM/disk every three minutes; five missed samples is stale. */
export const LIVE_STALE_MS = 15 * 60_000;
export { PATCH_STALE_AFTER_MS };

/** Which computers' alerts this caller may see. Mirrors MonitoringAdminService.alertWhere. */
type AlertAccess = { visible: false } | { visible: true; endpointIds: string[] | null };

interface SqlRow {
  id: string; name: string; hostname: string | null; platform: string | null; osVersion: string | null;
  status: string; isOnline: boolean; lastSeenAt: Date | null; accessMode: string; deviceClass: string;
  agentVersion: string | null; updateChannel: string | null;
  customerId: string | null; customerName: string | null; siteId: string | null; siteName: string | null;
  groups: { id: string; name: string; kind?: 'static' | 'rule' }[] | null;
  osCaption: string | null; loggedOnUser: string | null; liveSampledAt: Date | null;
  cpuLoadPercent: number | null; memoryTotalMb: number | null; memoryFreeMb: number | null;
  systemDiskTotalMb: number | null; systemDiskFreeMb: number | null;
  patchSource: 'signed_agent_scan' | 'standard_agent_scan' | null; patchAt: Date | null;
  patchPending: number | null; rebootPending: boolean | null;
  alertCount: number; alertWorst: number | null;
  total: bigint | number;
}

const SEVERITY = [null, 'INFO', 'WARNING', 'CRITICAL'] as const;
/** 2 checking in, 1 reachable with the agent silent, 0 offline — connectivityOf in SQL, for the Online sort. */
const CONNECTIVITY_RANK = `(CASE WHEN NOT e."isOnline" THEN 0 WHEN e."lastSeenAt" >= now() - interval '${HEARTBEAT_STALE_MS / 1000} seconds' THEN 2 ELSE 1 END)`;
/** The CSV's Connectivity column: "Online" (yes) is reachable; this says whether the agent is reporting. */
const CONNECTIVITY_CSV: Record<Connectivity, string> = { online: 'agent checking in', agent_silent: 'reachable (RustDesk), agent silent', offline: 'offline' };

/** A rule group as the list evaluates it: its business and its parsed rule (null = unreadable, matches nothing). */
export type RuleGroup = { id: string; name: string; customerId: string; rule: ListFilters | null };
/** Rule groups evaluated at once; each is one or two queries. */
const RULE_EVAL_CONCURRENCY = 6;
/** Version strings padded to four parts, so 1.4 and 1.4.0 compare equal. */
const pad4 = (p: number[]) => [...p, 0, 0, 0, 0].slice(0, 4);
const OTHER_PLATFORM: Prisma.EndpointWhereInput[] = [
  { platform: { startsWith: 'win', mode: 'insensitive' } },
  { platform: { startsWith: 'linux', mode: 'insensitive' } },
  { platform: { startsWith: 'mac', mode: 'insensitive' } },
  { platform: { startsWith: 'darwin', mode: 'insensitive' } },
  { platform: { startsWith: 'osx', mode: 'insensitive' } },
  { platform: { startsWith: 'os x', mode: 'insensitive' } },
];

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

  /**
   * The Prisma half of a filter set: everything Prisma can express. Used for
   * the request's own filters and, identically, for a rule group's rule — so
   * a rule matches exactly what the list shows with the same filters set.
   * Every value is a Prisma parameter; nothing is spliced into SQL.
   */
  private filterConds(f: ListFilters): Prisma.EndpointWhereInput[] {
    const and: Prisma.EndpointWhereInput[] = [];
    if (f.siteId) and.push({ siteId: f.siteId });
    // Connectivity (0.35), the three states of common/connectivity.ts: isOnline
    // alone is "reachable" (hbbs keeps it true for a silent agent), so
    // "online" also needs a heartbeat inside the sweep's window.
    if (f.online === 'online') and.push({ isOnline: true, lastSeenAt: { gte: heartbeatCutoff() } });
    if (f.online === 'silent') and.push({ isOnline: true, OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: heartbeatCutoff() } }] });
    if (f.online === 'offline') and.push({ isOnline: false });
    if (f.agent === 'signed') and.push({ updateChannel: 'signed' });
    if (f.agent === 'standard') and.push({ OR: [{ updateChannel: null }, { updateChannel: { not: 'signed' } }], agentVersion: { not: null } });
    if (f.agent === 'none') and.push({ OR: [{ updateChannel: null }, { updateChannel: { not: 'signed' } }], agentVersion: null });
    // OS family, by the same prefixes common/platform.ts recognises.
    if (f.platform === 'windows') and.push(OTHER_PLATFORM[0]);
    if (f.platform === 'linux') and.push(OTHER_PLATFORM[1]);
    if (f.platform === 'macos') and.push({ OR: OTHER_PLATFORM.slice(2) });
    if (f.platform === 'other') and.push({ OR: [{ platform: null }, { NOT: { OR: OTHER_PLATFORM } }] });
    if (f.os) {
      const c = { contains: likeEscape(f.os), mode: 'insensitive' as const };
      and.push({ OR: [{ osVersion: c }, { inventory: { osCaption: c } }] });
    }
    if (f.tag) and.push({ tags: { some: { tag: f.tag } } });
    if (f.notSeenDays) and.push({ OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: new Date(Date.now() - f.notSeenDays * 86_400_000) } }] });
    if (f.seenWithinDays) and.push({ lastSeenAt: { gte: new Date(Date.now() - f.seenWithinDays * 86_400_000) } });
    if (f.search) {
      const c = { contains: likeEscape(f.search), mode: 'insensitive' as const };
      and.push({
        OR: [
          { name: c }, { hostname: c }, { ipAddress: c }, { osVersion: c },
          { aliases: { some: { alias: c } } }, { rustdeskNode: { rustdeskId: c } },
          { customer: { name: c } }, { site: { name: c } },
          { inventory: { loggedOnUser: c } },
        ],
      });
    }
    return and;
  }

  /**
   * The SQL half: conditions on what phase two derives. Each fragment is a
   * Prisma.sql template with the value as a bound parameter ($n) — a rule's
   * values never become SQL text (security invariants §35).
   */
  private derivedConds(f: ListFilters): Prisma.Sql[] {
    const out: Prisma.Sql[] = [];
    if (f.restartPending) out.push(Prisma.sql`d.reboot_pending IS TRUE`);
    if (f.alerts === 'any') out.push(Prisma.sql`al.alert_count > 0`);
    if (f.alerts === 'critical') out.push(Prisma.sql`al.alert_worst = 3`);
    if (f.patches === 'pending') out.push(Prisma.sql`d.patch_pending > 0`);
    if (f.patches === 'current') out.push(Prisma.sql`d.patch_pending = 0`);
    if (f.patches === 'unknown') out.push(Prisma.sql`d.patch_source IS NULL`);
    if (f.patches === 'stale') out.push(Prisma.sql`d.patch_at < ${new Date(Date.now() - PATCH_STALE_AFTER_MS)}`);
    const min = versionParts(f.rustdeskMin), max = versionParts(f.rustdeskMax);
    if (min) out.push(Prisma.sql`rv.parts >= ${pad4(min)}::int[]`);
    if (max) out.push(Prisma.sql`rv.parts <= ${pad4(max)}::int[]`);
    return out;
  }

  /** The request's filters plus, for a rule group, its rule AND its business; or a static group's membership. */
  private filteredWhere(actor: ActorContext, q: ListQuery): Prisma.EndpointWhereInput {
    const and: Prisma.EndpointWhereInput[] = [this.scopedWhere(actor, q), ...this.filterConds(q)];
    if (q.groupRule) {
      and.push({ customerId: q.groupRule.customerId });
      // An unreadable rule matches nothing, never the whole business.
      and.push(...(q.groupRule.rule ? this.filterConds(q.groupRule.rule) : [{ id: { in: [] } }]));
    } else if (q.groupId) {
      and.push({ groupMemberships: { some: { endpointGroupId: q.groupId } } });
    }
    if (q.ids) and.push({ id: { in: q.ids } });
    return { AND: and };
  }

  private orderSql(sort: SortKey, dir: 'asc' | 'desc'): Prisma.Sql {
    const d = dir === 'asc' ? 'ASC' : 'DESC';
    // Whitelisted fragments only: `sort` is validated against SORT_KEYS, and
    // nothing from the request is ever spliced into this string.
    const expr: Record<SortKey, string> = {
      // Checking in, then reachable with the agent silent, then offline (0.35). The window is a constant, not request input.
      online: `${CONNECTIVITY_RANK} ${dir === 'asc' ? 'DESC' : 'ASC'}`,
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

  /**
   * What phase two derives, as joins on `e`: inventory `i`, patch and
   * resource posture `d`, the caller's visible open alerts `al`, and the
   * RustDesk version as a four-part integer array `rv` (null when the
   * reported version is not a dotted number, so it never matches a range).
   */
  private derivedJoins(alerts: AlertAccess): Prisma.Sql {
    const alertAll = alerts.visible && alerts.endpointIds === null;
    const alertIds = alerts.visible && alerts.endpointIds ? alerts.endpointIds : [];
    return Prisma.sql`
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
        LEFT JOIN "RustdeskNode" rn ON rn."endpointId" = e.id
        LEFT JOIN LATERAL (
          SELECT CASE WHEN rn.version ~ '^[0-9]{1,6}([.][0-9]{1,6}){0,3}$'
                      THEN (string_to_array(rn.version || repeat('.0', 3 - (length(rn.version) - length(replace(rn.version, '.', '')))), '.'))::int[]
                 END AS parts
        ) rv ON TRUE`;
  }

  /** Phase two: derive, filter on what was derived, order and page — over the given ids only. */
  private async derive(ids: string[], q: ListQuery, alerts: AlertAccess, limit: number, offset: number): Promise<SqlRow[]> {
    if (ids.length === 0) return [];
    const conds: Prisma.Sql[] = [Prisma.sql`e.id = ANY(${ids}::text[])`, ...this.derivedConds(q)];
    if (q.groupRule?.rule) conds.push(...this.derivedConds(q.groupRule.rule));
    return this.prisma.$queryRaw<SqlRow[]>`
      SELECT e.id, e.name, e.hostname, e.platform, e."osVersion", e.status::text AS status, e."isOnline", e."lastSeenAt",
             e."accessMode"::text AS "accessMode", e."deviceClass"::text AS "deviceClass", e."agentVersion", e."updateChannel",
             e."customerId", c.name AS "customerName", e."siteId", s.name AS "siteName",
             gm.groups,
             i."osCaption", i."loggedOnUser", i."liveSampledAt", i."cpuLoadPercent", i."memoryTotalMb", i."memoryFreeMb",
             i."systemDiskTotalMb", i."systemDiskFreeMb",
             d.patch_source AS "patchSource", d.patch_at AS "patchAt", d.patch_pending AS "patchPending", d.reboot_pending AS "rebootPending",
             al.alert_count AS "alertCount", al.alert_worst AS "alertWorst",
             COUNT(*) OVER () AS total
        FROM "Endpoint" e
        LEFT JOIN "Customer" c ON c.id = e."customerId"
        LEFT JOIN "Site" s ON s.id = e."siteId"
        LEFT JOIN LATERAL (
          -- Every group the computer is in (0.34: any number, all of its own business).
          SELECT json_agg(json_build_object('id', g.id, 'name', g.name) ORDER BY lower(g.name), g.id) AS groups
            FROM "EndpointGroupMember" m JOIN "EndpointGroup" g ON g.id = m."endpointGroupId"
           WHERE m."endpointId" = e.id
        ) gm ON TRUE
        ${this.derivedJoins(alerts)}
       WHERE ${Prisma.join(conds, ' AND ')}
       ORDER BY ${this.orderSql(q.sort, q.dir)}
       LIMIT ${limit} OFFSET ${offset}`;
  }

  private assertAlertUse(q: ListQuery, alerts: AlertAccess) {
    if (alerts.visible) return;
    if (q.alerts || ALERT_SORTS.includes(q.sort)) {
      throw new ForbiddenException({ code: 'NOT_ALLOWED', message: 'Filtering or sorting by alerts or health needs the monitoring:alerts permission.' });
    }
    // Membership of a rule on alert state would answer the same question.
    if (q.groupRule && ruleNeedsAlerts(q.groupRule.rule)) {
      throw new ForbiddenException({ code: 'NOT_ALLOWED', message: 'This rule group selects computers by their alerts, which needs the monitoring:alerts permission.' });
    }
  }

  // ── Rule groups (0.34) ────────────────────────────────────────────────────

  /**
   * If `q.groupId` names a RULE group this caller may address — the same
   * test as DeviceGroupsService.findVisible: a Platform Admin, or the group's
   * business is the caller's active one — attach its rule. Otherwise leave
   * groupId as a static-membership filter: a rule group of another business
   * has no members, so it lists nothing, exactly as a made-up id does.
   */
  private async withGroupRule(actor: ActorContext, q: ListQuery): Promise<ListQuery> {
    if (!q.groupId || q.groupRule) return q;
    const g = await this.prisma.endpointGroup.findFirst({
      where: { id: q.groupId, kind: 'RULE', customerId: actor.isPlatformAdmin ? { not: null } : (actor.businessId ?? '__none__') },
      select: { customerId: true, rule: true },
    });
    if (!g?.customerId) return q;
    return { ...q, groupRule: { customerId: g.customerId, rule: ruleFilters(g.rule) } };
  }

  /** A business's rule groups, as the list evaluates them. */
  async ruleGroupsOf(customerIds: string[]): Promise<RuleGroup[]> {
    if (!customerIds.length) return [];
    const rows = await this.prisma.endpointGroup.findMany({
      where: { kind: 'RULE', customerId: { in: customerIds } },
      select: { id: true, name: true, customerId: true, rule: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return rows.map((g) => ({ id: g.id, name: g.name, customerId: g.customerId!, rule: ruleFilters(g.rule) }));
  }

  /**
   * The computers in each rule group, as THIS caller sees them: scopedWhere
   * (their visibility, `status`), AND the group's business, AND its rule —
   * through filterConds/derivedConds, the list's own filters. `within`
   * narrows to given ids (a page, an export, a bulk selection).
   *
   * A group whose rule reads alerts is `null` (not evaluated) for a caller
   * without monitoring:alerts; for a technician whose alerts grant names some
   * computers, alert counts are over those only, as on the list.
   */
  async evaluateRuleGroups(
    actor: ActorContext, groups: RuleGroup[], opts: { status: ListQuery['status']; within?: string[] },
  ): Promise<Map<string, string[] | null>> {
    const alerts = this.alertAccess(actor);
    const out = new Map<string, string[] | null>();
    const scoped = this.scopedWhere(actor, { status: opts.status });
    const one = async (g: RuleGroup): Promise<string[] | null> => {
      if (!g.rule) return [];
      if (ruleNeedsAlerts(g.rule) && !alerts.visible) return null;
      if (opts.within && !opts.within.length) return [];
      const where: Prisma.EndpointWhereInput = {
        AND: [scoped, { customerId: g.customerId }, ...this.filterConds(g.rule), ...(opts.within ? [{ id: { in: opts.within } }] : [])],
      };
      const ids = (await this.prisma.endpoint.findMany({ where, select: { id: true } })).map((r) => r.id);
      const conds = this.derivedConds(g.rule);
      if (!conds.length || !ids.length) return ids;
      const rows = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT e.id FROM "Endpoint" e
        ${this.derivedJoins(alerts)}
        WHERE e.id = ANY(${ids}::text[]) AND ${Prisma.join(conds, ' AND ')}`;
      return rows.map((r) => r.id);
    };
    for (let i = 0; i < groups.length; i += RULE_EVAL_CONCURRENCY) {
      const chunk = groups.slice(i, i + RULE_EVAL_CONCURRENCY);
      const res = await Promise.all(chunk.map(one));
      chunk.forEach((g, k) => out.set(g.id, res[k]));
    }
    return out;
  }

  /** Rule-group membership for given rows, merged into each row's groups (static and rule, by name). */
  private async withRuleGroups(actor: ActorContext, rows: SqlRow[], status: ListQuery['status'], known?: { groups: RuleGroup[]; members: Map<string, string[] | null> }) {
    if (!rows.length) return rows;
    let groups: RuleGroup[], members: Map<string, string[] | null>;
    if (known) ({ groups, members } = known);
    else {
      groups = await this.ruleGroupsOf([...new Set(rows.map((r) => r.customerId).filter((x): x is string => !!x))]);
      members = await this.evaluateRuleGroups(actor, groups, { status, within: rows.map((r) => r.id) });
    }
    const byRow = new Map<string, { id: string; name: string; kind: 'rule' }[]>();
    for (const g of groups) {
      for (const id of members.get(g.id) ?? []) byRow.set(id, [...(byRow.get(id) ?? []), { id: g.id, name: g.name, kind: 'rule' }]);
    }
    return rows.map((r) => {
      const extra = byRow.get(r.id);
      const stat = (r.groups ?? []).map((g) => ({ ...g, kind: 'static' as const }));
      if (!extra) return { ...r, groups: stat };
      const all = [...stat, ...extra].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id));
      return { ...r, groups: all };
    });
  }

  /**
   * Every group ONE computer is in, as this caller sees it (0.35, the device
   * page): its static memberships, plus each rule group of its business whose
   * rule it matches — evaluateRuleGroups over just this computer, with the
   * caller's own visibility and alert access, so the device page and the
   * device list's Groups column cannot disagree. A rule group the caller may
   * not evaluate (its rule reads alerts and they may not see alerts) is left
   * out, as the list's facet leaves it out. The caller must already have
   * been shown the computer (assertEndpointInScope). `status: 'all'`, so an
   * archived computer still shows the rule groups it matches, as the list
   * does with Archived chosen.
   */
  async groupsOfComputer(
    actor: ActorContext, e: { id: string; customerId: string | null }, statics: { id: string; name: string }[],
  ): Promise<{ id: string; name: string; kind: 'static' | 'rule' }[]> {
    const groups = e.customerId ? await this.ruleGroupsOf([e.customerId]) : [];
    const members = groups.length ? await this.evaluateRuleGroups(actor, groups, { status: 'all', within: [e.id] }) : new Map<string, string[] | null>();
    const rule = groups.filter((g) => members.get(g.id)?.includes(e.id)).map((g) => ({ id: g.id, name: g.name, kind: 'rule' as const }));
    return [...statics.map((g) => ({ id: g.id, name: g.name, kind: 'static' as const })), ...rule]
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id));
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
      connectivity: connectivityOf(r.isOnline, r.lastSeenAt, now),
      deviceClass: r.deviceClass, accessMode: r.accessMode,
      business: r.customerId ? { id: r.customerId, name: r.customerName } : null,
      site: r.siteId ? { id: r.siteId, name: r.siteName } : null,
      groups: r.groups ?? [],
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

  async list(actor: ActorContext, query: ListQuery) {
    const alerts = this.alertAccess(actor);
    const q = await this.withGroupRule(actor, query);
    this.assertAlertUse(q, alerts);
    const [ids, facetsAndRules] = await Promise.all([this.ids(actor, q), this.facets(actor, q)]);
    const { rules, ...facets } = facetsAndRules;
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
    // The facet already evaluated every rule group over the caller's visible
    // set with this status, which contains every row of this page.
    rows = await this.withRuleGroups(actor, rows, q.status, rules);
    const now = Date.now();
    return {
      rows: rows.map((r) => this.rowView(r, alerts, now)),
      total, page, pageSize: q.pageSize, pages: Math.max(1, Math.ceil(total / q.pageSize)),
      sort: q.sort, dir: q.dir,
      alertsVisible: alerts.visible,
      facets,
      generatedAt: new Date(now),
      thresholds: { liveStaleMs: LIVE_STALE_MS, patchStaleMs: PATCH_STALE_AFTER_MS, heartbeatStaleMs: HEARTBEAT_STALE_MS },
    };
  }

  /** Businesses and sites among the caller's visible computers — what the filter menus offer. */
  private async facets(actor: ActorContext, q: ListQuery) {
    // Without the caller's own businessId filter, so the menu still lists the
    // others they may pick; still the caller's visibility, still 403 for a
    // foreign business via scopedWhere in the main query.
    const scoped = this.scopedWhere(actor, { status: q.status });
    const [groups, members] = await Promise.all([
      this.prisma.endpoint.groupBy({ by: ['customerId', 'siteId'], where: scoped, _count: { _all: true } }),
      // A computer in several groups counts once in each.
      this.prisma.endpointGroupMember.groupBy({ by: ['endpointGroupId'], where: { endpoint: scoped }, _count: { _all: true } }),
    ]);
    const bIds = [...new Set(groups.map((g) => g.customerId).filter((x): x is string => !!x))];
    const sIds = [...new Set(groups.map((g) => g.siteId).filter((x): x is string => !!x))];
    const gIds = members.map((m) => m.endpointGroupId);
    const inGroup = new Map(members.map((m) => [m.endpointGroupId, m._count._all]));
    const [bs, ss, gs] = await Promise.all([
      bIds.length ? this.prisma.customer.findMany({ where: { id: { in: bIds } }, select: { id: true, name: true } }) : [],
      sIds.length ? this.prisma.site.findMany({ where: { id: { in: sIds } }, select: { id: true, name: true, customerId: true } }) : [],
      gIds.length ? this.prisma.endpointGroup.findMany({ where: { id: { in: gIds } }, select: { id: true, name: true, customerId: true } }) : [],
    ]);
    const count = (pred: (g: (typeof groups)[number]) => boolean) => groups.filter(pred).reduce((n, g) => n + g._count._all, 0);
    // Rule groups of the businesses among the caller's visible computers,
    // each counted over what the caller can see (0.34). A group whose rule
    // reads alerts is left out for a caller who may not see alerts.
    const ruleGroups = await this.ruleGroupsOf(bIds);
    const ruleMembers = await this.evaluateRuleGroups(actor, ruleGroups, { status: q.status });
    const ruleFacets = ruleGroups.filter((g) => ruleMembers.get(g.id) !== null)
      .map((g) => ({ id: g.id, name: g.name, businessId: g.customerId, count: ruleMembers.get(g.id)!.length, kind: 'rule' as const }));
    return {
      rules: { groups: ruleGroups, members: ruleMembers },
      businesses: bs.map((b) => ({ id: b.id, name: b.name, count: count((g) => g.customerId === b.id) })).sort((a, b) => a.name.localeCompare(b.name)),
      sites: ss.map((s) => ({ id: s.id, name: s.name, businessId: s.customerId, count: count((g) => g.siteId === s.id) })).sort((a, b) => a.name.localeCompare(b.name)),
      // Groups among the caller's visible computers, counted over what they can see.
      groups: [
        ...gs.map((x) => ({ id: x.id, name: x.name, businessId: x.customerId, count: inGroup.get(x.id) ?? 0, kind: 'static' as const })),
        ...ruleFacets,
      ].sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  /**
   * The current filtered view as CSV. Same scoping and filters as the list,
   * every page at once, capped at EXPORT_MAX_ROWS. Audited before the file
   * leaves, with logOrFail: an export nobody can see afterwards is refused.
   */
  async exportCsv(actor: ActorContext, query: ListQuery): Promise<{ filename: string; csv: string; rows: number }> {
    const alerts = this.alertAccess(actor);
    const q = await this.withGroupRule(actor, query);
    this.assertAlertUse(q, alerts);
    const ids = await this.ids(actor, q);
    let rows = await this.derive(ids, q, alerts, EXPORT_MAX_ROWS + 1, 0);
    if (rows.length > EXPORT_MAX_ROWS) {
      throw new BadRequestException({ code: 'EXPORT_TOO_LARGE', message: `This view has more than ${EXPORT_MAX_ROWS} devices. Narrow it with a filter and export again.` });
    }
    rows = await this.withRuleGroups(actor, rows, q.status);
    const now = Date.now();
    const views = rows.map((r) => this.rowView(r, alerts, now));
    const header = [
      'Name', 'Hostname', 'Business', 'Site', 'Groups', 'OS', 'Status', 'Online', 'Connectivity', 'Last seen (UTC)',
      'Agent', 'Agent version', 'Logged-in user',
      'CPU %', 'Memory used %', 'Disk used %', 'Resources sampled (UTC)', 'Resources stale',
      'Pending updates', 'Restart pending', 'Update scan source', 'Update scan (UTC)', 'Update scan stale',
      ...(alerts.visible ? ['Open alerts', 'Worst alert'] : []),
    ];
    const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : '');
    const yn = (b: boolean | null | undefined) => (b === null || b === undefined ? '' : b ? 'yes' : 'no');
    const lines = [header, ...views.map((v) => [
      v.name, v.hostname ?? '', v.business?.name ?? '', v.site?.name ?? '', groupsCell(v.groups), v.os ?? v.platform ?? '', v.status, yn(v.isOnline), CONNECTIVITY_CSV[v.connectivity], iso(v.lastSeenAt),
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
          groupId: q.groupId ?? null,
          ...(q.groupRule ? { groupRule: q.groupRule.rule ?? 'unreadable' } : {}),
          platform: q.platform ?? null, os: q.os ?? null, tag: q.tag ?? null, patches: q.patches ?? null,
          rustdeskMin: q.rustdeskMin ?? null, rustdeskMax: q.rustdeskMax ?? null,
          notSeenDays: q.notSeenDays ?? null, seenWithinDays: q.seenWithinDays ?? null,
        },
        ...(q.ids ? { selection: { requested: q.ids.length, ids: q.ids } } : {}),
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
