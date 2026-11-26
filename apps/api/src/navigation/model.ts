import { z } from 'zod';

/**
 * Navigation preferences, favourites and recent items (0.87): the closed
 * lists and the parsing. Pure (zod only), so unit-navigation.mjs tests it
 * from dist and §96 compares its lists with migration 0104's CHECKs and the
 * web's nav model, word for word.
 *
 * Nothing here is a permission. A preference changes what the console draws;
 * every page and every API route still checks who may see and do what. A
 * favourite or a recent item stores only a kind and a reference (a record id
 * or a page path) — never a name, which is resolved on every read through the
 * same visibility rule as the record's own page, so losing access to a
 * computer removes it from the list without anyone touching the list.
 */

/** Standard (the default) only regroups: both modes reach the same pages. */
export const MODES = ['standard', 'advanced'] as const;
export const DENSITIES = ['comfortable', 'compact'] as const;
/**
 * Technician workspaces (0.90, UX P1-4, directive §11): which pages the
 * sidebar puts in front. `all` is every page the menu offers (the default);
 * `l1`, `l2` and `l3` narrow the sidebar to a role's everyday pages. A
 * presentation preference only: it grants nothing, hides nothing from
 * search, tabs or a typed URL, and every page and route still checks for
 * itself. The pages each one names are the web's (lib/workspace-modes.ts).
 */
export const WORKSPACES = ['all', 'l1', 'l2', 'l3'] as const;
/** The sidebar's groups (apps/web/components/layout/nav-model.ts NAV ids, in order). */
export const GROUP_IDS = ['dashboard', 'devices', 'remote', 'monitoring', 'patching', 'automation', 'reports', 'security', 'admin'] as const;
export const LISTS = ['favorite', 'recent'] as const;
export const KINDS = ['device', 'business', 'site', 'script', 'page'] as const;
export type NavKind = (typeof KINDS)[number];
export type NavList = (typeof LISTS)[number];

/** Bounds. A favourite beyond the cap is refused; recent items roll over. */
export const FAVORITE_CAP = 50;
export const RECENT_CAP = 15;
export const PINNED_CAP = GROUP_IDS.length;

/** A record id (cuid, or a seed's readable id). */
export const RECORD_REF = /^[A-Za-z0-9_-]{8,64}$/;
/**
 * A console page: an absolute path of lower-case segments, no query, no
 * fragment, no `..`, no `//`, at most 120 characters. Never an external URL,
 * so a favourite can only ever open a page of this console.
 */
// eslint-disable-next-line security/detect-unsafe-regex -- anchored, bounded repetitions, each group starts with a literal slash the segment class excludes; refOk checks the length first
export const PAGE_REF = /^\/(?:[a-z0-9][a-z0-9-]{0,40}(?:\/[a-z0-9][a-z0-9-]{0,40}){0,5})?$/;

export function refOk(kind: NavKind, ref: string): boolean {
  return kind === 'page' ? ref.length <= 120 && PAGE_REF.test(ref) : RECORD_REF.test(ref);
}

export const PrefsDto = z.object({
  mode: z.enum(MODES).optional(),
  sidebarCollapsed: z.boolean().optional(),
  pinnedGroups: z.array(z.enum(GROUP_IDS)).max(PINNED_CAP).optional(),
  density: z.enum(DENSITIES).optional(),
  workspace: z.enum(WORKSPACES).optional(),
  /** The customer the header context selector names; a hint, never a scope (null clears it). */
  contextBusinessId: z.string().regex(RECORD_REF).nullable().optional(),
}).strict();
export type PrefsInput = z.infer<typeof PrefsDto>;

export const ItemDto = z.object({
  kind: z.enum(KINDS),
  ref: z.string().min(1).max(120),
}).strict().refine((v) => refOk(v.kind, v.ref), { message: 'ref is not a record id or a console page path', path: ['ref'] });
export type ItemInput = z.infer<typeof ItemDto>;

export const DEFAULT_PREFS = { mode: 'standard', sidebarCollapsed: false, pinnedGroups: [] as string[], density: 'comfortable', workspace: 'all', contextBusinessId: null as string | null };

/** Distinct, in GROUP_IDS order, so a stored list is canonical. */
export function canonicalGroups(ids: readonly string[]): string[] {
  const set = new Set(ids);
  return GROUP_IDS.filter((g) => set.has(g));
}
