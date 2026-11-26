import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { z } from 'zod';
import { connectivityOf } from '../common/connectivity';
import { PrismaService } from '../prisma/prisma.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';
import { EndpointListService } from '../endpoints/endpoint-list.service';
import { BusinessesService } from '../businesses/businesses.service';
import { SitesService } from '../sites/sites.service';
import { anyRight, libraryWhere, listScope, viewOf } from '../script-library/access';
import {
  DEFAULT_PREFS, FAVORITE_CAP, ItemDto, PrefsDto, RECENT_CAP, canonicalGroups,
  type ItemInput, type NavKind, type NavList,
} from './model';

/**
 * The signed-in person's own navigation state (0.87): Standard/Advanced
 * mode, the sidebar's collapsed state and pinned groups, density, the
 * customer named in the header, favourites and recent items.
 *
 * Every row is the caller's own (`userId: actor.userId` on every read and
 * write; there is no route that names another person). Nothing stored is a
 * name or a URL: a favourite is a kind and a record id or a console path.
 * On every read each record is resolved through the visibility rule its own
 * page uses — the device list's scopedWhere (endpointVisibilityWhere AND-ed),
 * GET /businesses' and GET /sites' listWhere, the script library's
 * libraryWhere and viewOf — and a record the caller can no longer see is
 * left out of the answer (the row is kept: access may come back). Saving a
 * favourite or a visit checks the same rule first, so a record that cannot
 * be opened cannot be stored either.
 *
 * Not audited: a preference or a bookmark is not a security event, and the
 * records it points to are only ever shown as their own pages would show them.
 */

type Resolved = {
  id: string; list: NavList; kind: NavKind; ref: string; usedAt: Date;
  title: string | null; detail: string | null; href: string;
  connectivity?: string;
};

function bad(e: z.ZodError) {
  return new BadRequestException({ code: 'INVALID_REQUEST', message: e.issues.slice(0, 4).map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
}

/** A builder that refuses this caller (no capability) means "none of these", not an error. */
async function orNone<T>(run: () => Promise<T[]>): Promise<T[]> {
  try { return await run(); } catch (e) { if (e instanceof ForbiddenException) return []; throw e; }
}

@Injectable()
export class NavigationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly acl: AccessControlService,
    private readonly devices: EndpointListService,
    private readonly businesses: BusinessesService,
    private readonly sites: SitesService,
  ) {}

  // ── Reading ────────────────────────────────────────────────────────────────

  async view(actor: ActorContext) {
    const [row, items] = await Promise.all([
      this.prisma.userNavPreference.findUnique({ where: { userId: actor.userId } }),
      this.prisma.userNavItem.findMany({ where: { userId: actor.userId }, orderBy: [{ usedAt: 'desc' }, { id: 'asc' }], take: FAVORITE_CAP + RECENT_CAP }),
    ]);
    const resolved = await this.resolve(actor, items);
    let context: { id: string; name: string } | null = null;
    if (row?.contextBusinessId) {
      const b = await this.prisma.customer.findFirst({ where: { AND: [this.businesses.listWhere(actor), { id: row.contextBusinessId }] }, select: { id: true, name: true } });
      context = b ?? null;
    }
    return {
      preferences: {
        mode: row?.mode ?? DEFAULT_PREFS.mode,
        sidebarCollapsed: row?.sidebarCollapsed ?? DEFAULT_PREFS.sidebarCollapsed,
        pinnedGroups: row?.pinnedGroups ?? DEFAULT_PREFS.pinnedGroups,
        density: row?.density ?? DEFAULT_PREFS.density,
        workspace: row?.workspace ?? DEFAULT_PREFS.workspace,
        contextBusiness: context,
      },
      favorites: resolved.filter((r) => r.list === 'favorite'),
      recent: resolved.filter((r) => r.list === 'recent').slice(0, RECENT_CAP),
      caps: { favorites: FAVORITE_CAP, recent: RECENT_CAP },
    };
  }

  /**
   * Names for the rows the caller may still open, each through its own
   * page's rule, in the order given. Pages are returned as paths; the web
   * names them from its own menu and drops one it does not know.
   */
  private async resolve(actor: ActorContext, rows: { id: string; list: string; kind: string; ref: string; usedAt: Date }[]): Promise<Resolved[]> {
    const ids = (k: NavKind) => [...new Set(rows.filter((r) => r.kind === k).map((r) => r.ref))];
    const [devs, bizs, sites, scripts] = await Promise.all([
      this.visibleDevices(actor, ids('device')),
      this.visibleBusinesses(actor, ids('business')),
      this.visibleSites(actor, ids('site')),
      this.visibleScripts(actor, ids('script')),
    ]);
    const out: Resolved[] = [];
    for (const r of rows) {
      const base = { id: r.id, list: r.list as NavList, kind: r.kind as NavKind, ref: r.ref, usedAt: r.usedAt };
      if (r.kind === 'page') { out.push({ ...base, title: null, detail: null, href: r.ref }); continue; }
      const hit = r.kind === 'device' ? devs.get(r.ref) : r.kind === 'business' ? bizs.get(r.ref) : r.kind === 'site' ? sites.get(r.ref) : scripts.get(r.ref);
      if (hit) out.push({ ...base, ...hit });
    }
    return out;
  }

  private async visibleDevices(actor: ActorContext, ids: string[]) {
    const m = new Map<string, Omit<Resolved, 'id' | 'list' | 'kind' | 'ref' | 'usedAt'>>();
    if (!ids.length) return m;
    const rows = await orNone(() => this.prisma.endpoint.findMany({
      where: { AND: [this.devices.scopedWhere(actor, { status: 'current' }), { id: { in: ids } }] },
      select: { id: true, name: true, isOnline: true, lastSeenAt: true, customer: { select: { name: true } } },
    }));
    for (const e of rows) m.set(e.id, { title: e.name, detail: e.customer?.name ?? null, href: `/endpoints/${e.id}`, connectivity: connectivityOf(e.isOnline, e.lastSeenAt) });
    return m;
  }

  private async visibleBusinesses(actor: ActorContext, ids: string[]) {
    const m = new Map<string, Omit<Resolved, 'id' | 'list' | 'kind' | 'ref' | 'usedAt'>>();
    if (!ids.length) return m;
    const rows = await this.prisma.customer.findMany({ where: { AND: [this.businesses.listWhere(actor), { id: { in: ids } }] }, select: { id: true, name: true, city: true } });
    for (const b of rows) m.set(b.id, { title: b.name, detail: b.city ?? null, href: `/businesses/${b.id}` });
    return m;
  }

  private async visibleSites(actor: ActorContext, ids: string[]) {
    const m = new Map<string, Omit<Resolved, 'id' | 'list' | 'kind' | 'ref' | 'usedAt'>>();
    // GET /sites needs computers:view, as search's sites group does.
    if (!ids.length || !this.acl.can(actor, CAP.COMPUTERS_VIEW)) return m;
    const rows = await this.prisma.site.findMany({
      where: { AND: [this.sites.listWhere(actor), { id: { in: ids } }] },
      select: { id: true, name: true, customer: { select: { id: true, name: true } } },
    });
    for (const s of rows) m.set(s.id, { title: s.name, detail: s.customer.name, href: `/endpoints?businessId=${encodeURIComponent(s.customer.id)}&siteId=${encodeURIComponent(s.id)}` });
    return m;
  }

  private async visibleScripts(actor: ActorContext, ids: string[]) {
    const m = new Map<string, Omit<Resolved, 'id' | 'list' | 'kind' | 'ref' | 'usedAt'>>();
    if (!ids.length || !anyRight(actor)) return m;
    const rows = await this.prisma.script.findMany({
      where: { AND: [libraryWhere(actor, listScope(actor)), { id: { in: ids } }] },
      select: { id: true, name: true, scope: true, customerId: true, customer: { select: { name: true } }, versions: { where: { status: 'APPROVED' }, select: { id: true }, take: 1 } },
    });
    for (const s of rows) {
      const view = viewOf(actor, s);
      // As the library's own detail read: a global script with nothing approved is not there for a business.
      if (!view || (view === 'approved_only' && !s.versions.length)) continue;
      m.set(s.id, { title: s.name, detail: s.scope === 'GLOBAL' ? 'Global script' : s.customer?.name ?? null, href: `/automation/scripts/${s.id}` });
    }
    return m;
  }

  /** Whether the caller may open this record now (the same rule as the read). */
  private async visible(actor: ActorContext, item: ItemInput): Promise<boolean> {
    switch (item.kind) {
      case 'page': return true;
      case 'device': return (await this.visibleDevices(actor, [item.ref])).has(item.ref);
      case 'business': return (await this.visibleBusinesses(actor, [item.ref])).has(item.ref);
      case 'site': return (await this.visibleSites(actor, [item.ref])).has(item.ref);
      case 'script': return (await this.visibleScripts(actor, [item.ref])).has(item.ref);
    }
  }

  // ── Writing (always the caller's own rows) ─────────────────────────────────

  async setPreferences(actor: ActorContext, body: unknown) {
    const p = PrefsDto.safeParse(body);
    if (!p.success) throw bad(p.error);
    const d = p.data;
    if (d.contextBusinessId) {
      const ok = await this.prisma.customer.count({ where: { AND: [this.businesses.listWhere(actor), { id: d.contextBusinessId }] } });
      if (!ok) throw new NotFoundException('Business not found');
    }
    const data = {
      ...(d.mode !== undefined ? { mode: d.mode } : {}),
      ...(d.sidebarCollapsed !== undefined ? { sidebarCollapsed: d.sidebarCollapsed } : {}),
      ...(d.pinnedGroups !== undefined ? { pinnedGroups: canonicalGroups(d.pinnedGroups) } : {}),
      ...(d.density !== undefined ? { density: d.density } : {}),
      ...(d.workspace !== undefined ? { workspace: d.workspace } : {}),
      ...(d.contextBusinessId !== undefined ? { contextBusinessId: d.contextBusinessId } : {}),
    };
    await this.prisma.userNavPreference.upsert({ where: { userId: actor.userId }, create: { userId: actor.userId, ...data }, update: data });
    return this.view(actor);
  }

  async addFavorite(actor: ActorContext, body: unknown) {
    const p = ItemDto.safeParse(body);
    if (!p.success) throw bad(p.error);
    // Another business's computer and a missing one look the same, as on its page.
    if (!(await this.visible(actor, p.data))) throw new NotFoundException('Not found');
    await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, actor);
      const existing = await tx.userNavItem.findUnique({ where: { userId_list_kind_ref: { userId: actor.userId, list: 'favorite', kind: p.data.kind, ref: p.data.ref } } });
      if (existing) return;
      const n = await tx.userNavItem.count({ where: { userId: actor.userId, list: 'favorite' } });
      if (n >= FAVORITE_CAP) throw new ConflictException({ code: 'FAVORITES_FULL', message: `At most ${FAVORITE_CAP} favourites. Remove one first.` });
      await tx.userNavItem.create({ data: { userId: actor.userId, list: 'favorite', kind: p.data.kind, ref: p.data.ref } });
    });
    return this.view(actor);
  }

  async removeFavorite(actor: ActorContext, id: string) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) throw new NotFoundException('Not found');
    // Conditional on the owner: another person's row is never matched.
    await this.prisma.userNavItem.deleteMany({ where: { id, userId: actor.userId, list: 'favorite' } });
    return this.view(actor);
  }

  /**
   * One person's navigation writes, one at a time. Two tabs recording visits at
   * once deadlocked on each other's trim (a 500 in the browser suite), two
   * upserts of the same item raced to insert, and two favourites added at once
   * could both pass the count. A transaction-scoped advisory lock on the
   * person's id serialises them and is released at commit.
   */
  private async lock(tx: Prisma.TransactionClient, actor: ActorContext) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'rem0te.nav:' + actor.userId}, 0))`;
  }

  /** A page or record opened: kept as the newest recent item, at most RECENT_CAP of them. */
  async recordVisit(actor: ActorContext, body: unknown) {
    const p = ItemDto.safeParse(body);
    if (!p.success) throw bad(p.error);
    if (!(await this.visible(actor, p.data))) throw new NotFoundException('Not found');
    const key = { userId: actor.userId, list: 'recent', kind: p.data.kind, ref: p.data.ref };
    await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, actor);
      await tx.userNavItem.upsert({ where: { userId_list_kind_ref: key }, create: key, update: { usedAt: new Date() } });
      const over = await tx.userNavItem.findMany({ where: { userId: actor.userId, list: 'recent' }, orderBy: [{ usedAt: 'desc' }, { id: 'asc' }], skip: RECENT_CAP, select: { id: true } });
      if (over.length) await tx.userNavItem.deleteMany({ where: { userId: actor.userId, list: 'recent', id: { in: over.map((o) => o.id) } } });
    });
    return { recorded: true };
  }
}
