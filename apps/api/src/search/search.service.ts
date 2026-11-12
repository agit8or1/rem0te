import { ForbiddenException, Injectable } from '@nestjs/common';
import { connectivityOf } from '../common/connectivity';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { accessLevelLabel } from '../rbac/capabilities';
import { EndpointListService } from '../endpoints/endpoint-list.service';
import { BusinessesService } from '../businesses/businesses.service';
import { SitesService } from '../sites/sites.service';
import { UsersService } from '../users/users.service';
import { MonitoringAdminService } from '../monitoring/monitoring-admin.service';
import { GROUP_CAP, GROUP_CAPABILITY, likeEscape, likePatterns, looksLikeAddress, nameWords, rankOf, type ComputerField } from './query';

/**
 * Global search (0.33): one query, grouped results, each group capped.
 *
 * Nothing here decides who may see what. Every group starts from the where
 * builder its own list route uses, and is gated by that route's capability:
 *
 *   computers   EndpointListService.scopedWhere   (asserts computers:view; endpointVisibilityWhere AND-ed)
 *   businesses  BusinessesService.listWhere       (no capability, like GET /businesses)
 *   sites       SitesService.listWhere            (computers:view, like GET /sites)
 *   users       UsersService.memberWhere          (users:view, like GET /users)
 *   alerts      MonitoringAdminService.alertWhere (monitoring:alerts, like GET /monitoring/alerts)
 *
 * The search condition is always AND-ed onto that fragment, never merged into
 * it, so no query text can add a row the list would not show. A group the
 * caller may not use is `null` in the response — not an empty list, which
 * would read as "nothing matched".
 *
 * Computers run in two phases, as the device list does: phase one is Prisma,
 * the scoped ids; phase two is one SQL statement over exactly those ids that
 * matches, picks the field that matched, ranks and caps. Phase two's only
 * source of rows is the id array, so it cannot widen phase one.
 *
 * Results carry names and the one field that matched — never a secret, a
 * token, a hash, a password or a credential flag. Searches are not audited
 * (a keystroke is not an event) and the query text is never logged.
 */

export type GroupResult<T> = { items: T[]; more: boolean } | null;

interface ComputerRow {
  id: string; name: string; hostname: string | null; isOnline: boolean; lastSeenAt: Date | null;
  platform: string | null; status: string;
  customerId: string | null; customerName: string | null; siteId: string | null; siteName: string | null;
  field: ComputerField | null; value: string | null; rank: number | null;
}

/**
 * A group whose list route would refuse this caller (a ForbiddenException from
 * the shared where builder or capability check) is absent, never an error for
 * the whole search and never an empty list.
 */
async function gated<T>(run: () => Promise<GroupResult<T>>): Promise<GroupResult<T>> {
  try { return await run(); } catch (e) { if (e instanceof ForbiddenException) return null; throw e; }
}

/** Enough rows to rank before capping, for the groups ranked in JavaScript. */
const RANK_WINDOW = 50;

@Injectable()
export class SearchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly acl: AccessControlService,
    private readonly devices: EndpointListService,
    private readonly businesses: BusinessesService,
    private readonly sites: SitesService,
    private readonly users: UsersService,
    private readonly monitoring: MonitoringAdminService,
  ) {}

  async search(actor: ActorContext, q: string) {
    const [computers, businesses, sites, users, alerts] = await Promise.all([
      gated(() => this.computers(actor, q)),
      gated(() => this.businessGroup(actor, q)),
      gated(() => this.siteGroup(actor, q)),
      gated(() => this.userGroup(actor, q)),
      gated(() => this.alertGroup(actor, q)),
    ]);
    return { query: q, cap: GROUP_CAP, groups: { computers, businesses, sites, users, alerts } };
  }

  /** The group's list-page capability (GROUP_CAPABILITY). Alerts are decided by alertWhere itself. */
  private allowed(actor: ActorContext, group: 'computers' | 'sites' | 'users'): boolean {
    return this.acl.can(actor, GROUP_CAPABILITY[group]);
  }

  /** Rank exact, then prefix, then anywhere; stable, so the database's order breaks ties. */
  private capRanked<T>(rows: T[], keys: (r: T) => (string | null | undefined)[], q: string): { items: T[]; more: boolean } {
    const best = (r: T) => Math.min(...keys(r).map((k) => rankOf(k, q) ?? 3));
    const ranked = rows.map((r, i) => ({ r, i, b: best(r) })).sort((a, b) => a.b - b.b || a.i - b.i).map((x) => x.r);
    return { items: ranked.slice(0, GROUP_CAP), more: rows.length > GROUP_CAP };
  }

  // ── Computers ─────────────────────────────────────────────────────────────

  private async computers(actor: ActorContext, q: string): Promise<GroupResult<ReturnType<SearchService['computerView']>>> {
    if (!this.allowed(actor, 'computers')) return null;
    const p = likePatterns(q);
    // Prisma's `contains` is ILIKE '%…%' with the value spliced in as is, so
    // the value is escaped first: '%', '_' and a DOMAIN\\user backslash are literal.
    const c = { contains: likeEscape(q), mode: 'insensitive' as const };
    // Adapter addresses live in a JSON array Prisma cannot search, so the
    // computers with a matching IPv4 are found first, platform-wide. That list
    // is only ever a filter input: it sits inside the match condition, which
    // is AND-ed onto the scope below, so it can narrow and never widen.
    // (looksLikeAddress admits no quote or backslash, which JSON text would
    // escape, so the ::text shortcut cannot miss a value the exact test finds.)
    const nicIds = looksLikeAddress(q)
      ? (await this.prisma.$queryRaw<{ id: string }[]>`
          SELECT i."endpointId" AS id FROM "EndpointInventory" i
           WHERE jsonb_typeof(i.networks) = 'array' AND i.networks::text ILIKE ${p.contains}
             AND EXISTS (SELECT 1 FROM jsonb_array_elements(i.networks) n WHERE n->>'ipv4' ILIKE ${p.contains})`).map((r) => r.id)
      : [];
    // Phase one: the device list's own scope (visibility — business, Business
    // User grants, technician computers — AND not archived; it asserts
    // computers:view itself), AND the match. One Prisma query.
    const match: Prisma.EndpointWhereInput = {
      OR: [
        { name: c }, { hostname: c }, { serialNumber: c }, { ipAddress: c },
        { rustdeskNode: { rustdeskId: c } },
        { inventory: { OR: [{ serialNumber: c }, { loggedOnUser: c }] } },
        { aliases: { some: { alias: c } } },
        ...(nicIds.length ? [{ id: { in: nicIds } }] : []),
      ],
    };
    const found = await this.prisma.endpoint.findMany({
      where: { AND: [this.devices.scopedWhere(actor, { status: 'current' }), match] },
      select: { id: true },
    });
    const ids = found.map((r) => r.id);
    if (!ids.length) return { items: [], more: false };
    // Phase two, over exactly those ids (its only source of rows): rank each
    // by its best field — 0 exact, 1 prefix, 2 anywhere — order and cap; then,
    // for the few rows kept, say which field matched.
    //
    // Every value below is shown on the device page to whoever can open it,
    // which every caller reaching this row can: the RustDesk ID (System card),
    // serial (Hardware), signed-in user and IP address (Session) and each
    // adapter's IPv4 (Network). Only the one that matched is returned.
    const rk = (col: string) => Prisma.sql`CASE WHEN lower(${Prisma.raw(col)}) = ${p.exact} THEN 0 WHEN lower(${Prisma.raw(col)}) LIKE ${p.prefix} THEN 1 WHEN lower(${Prisma.raw(col)}) LIKE ${p.contains} THEN 2 END`;
    const nics = Prisma.sql`jsonb_array_elements(CASE WHEN jsonb_typeof(i.networks) = 'array' THEN i.networks ELSE '[]'::jsonb END) n`;
    const rows = await this.prisma.$queryRaw<ComputerRow[]>`
      WITH ranked AS (
        SELECT e.id, e."isOnline", lower(e.name) AS lname,
               LEAST(${rk('e.name')}, ${rk('e.hostname')}, ${rk('r."rustdeskId"')}, ${rk('i."serialNumber"')}, ${rk('e."serialNumber"')},
                     ${rk('i."loggedOnUser"')}, ${rk('e."ipAddress"')},
                     CASE WHEN ${nicIds.length > 0}::boolean THEN (SELECT min(${rk("n->>'ipv4'")}) FROM ${nics}) END,
                     (SELECT min(${rk('a.alias')}) FROM "EndpointAlias" a WHERE a."endpointId" = e.id)) AS rank
          FROM unnest(${ids}::text[]) AS u(id)
          JOIN "Endpoint" e ON e.id = u.id
          LEFT JOIN "EndpointInventory" i ON i."endpointId" = e.id
          LEFT JOIN "RustdeskNode" r ON r."endpointId" = e.id
      ), kept AS (
        SELECT * FROM ranked ORDER BY rank, "isOnline" DESC, lname, id LIMIT ${GROUP_CAP + 1}
      )
      SELECT e.id, e.name, e.hostname, e."isOnline", e."lastSeenAt", e.platform, e.status::text AS status,
             e."customerId", c.name AS "customerName", e."siteId", s.name AS "siteName",
             m.field, m.value, k.rank
        FROM kept k
        JOIN "Endpoint" e ON e.id = k.id
        LEFT JOIN "Customer" c ON c.id = e."customerId"
        LEFT JOIN "Site" s ON s.id = e."siteId"
        LEFT JOIN "EndpointInventory" i ON i."endpointId" = e.id
        LEFT JOIN "RustdeskNode" r ON r."endpointId" = e.id
        LEFT JOIN LATERAL (
          SELECT v.field, v.value
            FROM (
              SELECT 1 AS ord, 'name' AS field, e.name AS value
              UNION ALL SELECT 2, 'hostname', e.hostname
              UNION ALL SELECT 3, 'rustdeskId', r."rustdeskId"
              UNION ALL SELECT 4, 'serialNumber', i."serialNumber"
              UNION ALL SELECT 4, 'serialNumber', e."serialNumber"
              UNION ALL SELECT 5, 'loggedOnUser', i."loggedOnUser"
              UNION ALL SELECT 6, 'ipAddress', e."ipAddress"
              UNION ALL SELECT 7, 'privateIp', n->>'ipv4' FROM ${nics}
              UNION ALL SELECT 8, 'alias', a.alias FROM "EndpointAlias" a WHERE a."endpointId" = e.id
            ) v
           WHERE ${rk('v.value')} = k.rank
           ORDER BY v.ord
           LIMIT 1
        ) m ON TRUE
       ORDER BY k.rank, k."isOnline" DESC, k.lname, k.id`;
    return { items: rows.slice(0, GROUP_CAP).map((r) => this.computerView(r)), more: rows.length > GROUP_CAP };
  }

  private computerView(r: ComputerRow) {
    return {
      id: r.id, name: r.name, hostname: r.hostname, isOnline: r.isOnline, connectivity: connectivityOf(r.isOnline, r.lastSeenAt), lastSeenAt: r.lastSeenAt, platform: r.platform,
      business: r.customerId ? { id: r.customerId, name: r.customerName } : null,
      site: r.siteId ? { id: r.siteId, name: r.siteName } : null,
      // The name is already on the row; any other field says what matched.
      // (null too in the rare case Postgres' ILIKE and lower() disagree about
      // a character's case, and no field can be named.)
      match: r.field === 'name' || r.field === null ? null : { field: r.field, value: r.value },
    };
  }

  // ── Businesses and sites ──────────────────────────────────────────────────

  private async businessGroup(actor: ActorContext, q: string) {
    const rows = await this.prisma.customer.findMany({
      where: this.businesses.listWhere(actor, likeEscape(q)), select: { id: true, name: true, code: true, city: true, isActive: true }, orderBy: { name: 'asc' }, take: RANK_WINDOW,
    });
    return this.capRanked(rows, (b) => [b.name, b.code, b.city], q);
  }

  private async siteGroup(actor: ActorContext, q: string) {
    if (!this.allowed(actor, 'sites')) return null;
    const c = { contains: likeEscape(q), mode: 'insensitive' as const };
    const rows = await this.prisma.site.findMany({
      where: { AND: [this.sites.listWhere(actor), { OR: [{ name: c }, { city: c }, { address: c }] }] },
      select: { id: true, name: true, city: true, customer: { select: { id: true, name: true } } },
      orderBy: { name: 'asc' }, take: RANK_WINDOW,
    });
    const r = this.capRanked(rows, (s) => [s.name, s.city], q);
    return { more: r.more, items: r.items.map((s) => ({ id: s.id, name: s.name, city: s.city, business: s.customer })) };
  }

  // ── People ────────────────────────────────────────────────────────────────

  private async userGroup(actor: ActorContext, q: string) {
    if (!this.allowed(actor, 'users')) return null;
    const words = nameWords(q);
    const rows = await this.prisma.membership.findMany({
      where: {
        AND: [
          this.users.memberWhere(actor),
          ...words.map((t) => ({ user: { OR: [
            { email: { contains: likeEscape(t), mode: 'insensitive' as const } },
            { firstName: { contains: likeEscape(t), mode: 'insensitive' as const } },
            { lastName: { contains: likeEscape(t), mode: 'insensitive' as const } },
          ] } })),
        ],
      },
      // Named fields only: never the password hash, MFA secrets or tokens.
      select: {
        id: true,
        user: { select: { id: true, email: true, firstName: true, lastName: true, status: true, isPlatformAdmin: true } },
        role: { select: { type: true } },
        customer: { select: { id: true, name: true } },
      },
      orderBy: [{ user: { email: 'asc' } }], take: RANK_WINDOW,
    });
    const full = (m: (typeof rows)[number]) => [m.user.firstName, m.user.lastName].filter(Boolean).join(' ');
    const r = this.capRanked(rows, (m) => [m.user.email, full(m), m.user.firstName, m.user.lastName], q);
    return {
      more: r.more,
      items: r.items.map((m) => ({
        id: m.user.id, membershipId: m.id, name: full(m) || null, email: m.user.email, status: m.user.status,
        accessLevel: accessLevelLabel({ isPlatformAdmin: m.user.isPlatformAdmin, roleType: m.role.type }),
        business: m.customer,
      })),
    };
  }

  // ── Alerts ────────────────────────────────────────────────────────────────

  private async alertGroup(actor: ActorContext, q: string) {
    // alertWhere throws for a caller without monitoring:alerts — the alerts
    // list's own refusal — and gated() turns that into "no group".
    const rows = await this.prisma.monitorAlert.findMany({
      where: { AND: [this.monitoring.alertWhere(actor), { state: { in: ['OPEN', 'ACKNOWLEDGED'] } }, { title: { contains: likeEscape(q), mode: 'insensitive' } }] },
      select: {
        id: true, title: true, severity: true, state: true, kind: true, lastSeenAt: true,
        customer: { select: { id: true, name: true } },
        endpoint: { select: { id: true, name: true } },
        site: { select: { id: true, name: true } },
      },
      orderBy: [{ lastSeenAt: 'desc' }, { id: 'asc' }], take: GROUP_CAP + 1,
    });
    return {
      more: rows.length > GROUP_CAP,
      items: rows.slice(0, GROUP_CAP).map((a) => ({
        id: a.id, title: a.title, severity: a.severity, state: a.state, kind: a.kind, lastSeenAt: a.lastSeenAt,
        business: a.customer, computer: a.endpoint, site: a.site,
      })),
    };
  }
}
