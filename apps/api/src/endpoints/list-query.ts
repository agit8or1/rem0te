import { BadRequestException } from '@nestjs/common';

/**
 * The device list's query parameters (0.31), on their own so a saved view
 * (0.33) is validated by exactly the same rules as the list it opens, and so
 * the rules can be unit-tested without a database. Re-exported by
 * endpoint-list.service.
 */

export const SORT_KEYS = [
  'online', 'name', 'business', 'site', 'os', 'lastSeen', 'agent', 'user',
  'cpu', 'memory', 'disk', 'patches', 'alerts', 'health',
] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export const PAGE_SIZES = [25, 50, 100, 200];
export const PLATFORMS = ['windows', 'linux', 'macos', 'other'] as const;
export const PATCH_STATES = ['pending', 'current', 'unknown', 'stale'] as const;
/** Dotted numeric versions only (1.4.2, at most four parts of up to six digits): compared as integer arrays, never as text. */
export function isVersion(v: string): boolean {
  const parts = v.split('.');
  return parts.length >= 1 && parts.length <= 4 && parts.every((p) => /^\d{1,6}$/.test(p));
}
/** An OS search term: letters, digits, space and . _ ( ) + - only. */
export const OS_TERM = /^[\p{L}\p{N} ._()+-]{1,60}$/u;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
export const MAX_DAYS = 3650;

/** A version string as the integer array SQL compares, or null when it is not a dotted number. */
export function versionParts(v: string | null | undefined): number[] | null {
  if (typeof v !== 'string' || !isVersion(v)) return null;
  return v.split('.').map((x) => parseInt(x, 10));
}

export interface ListQuery {
  search?: string;
  businessId?: string;
  siteId?: string;
  /** 0.35: online = agent checking in; silent = reachable through RustDesk, agent silent (common/connectivity.ts); offline = not reachable. */
  online?: 'online' | 'silent' | 'offline';
  alerts?: 'any' | 'critical';
  restartPending?: boolean;
  /** 0.36: outdated = a standard Windows agent reporting a version older than this server's, or a signed agent not on the published signed build. */
  agent?: 'signed' | 'standard' | 'none' | 'outdated';
  status?: 'current' | 'archived' | 'all';
  /** A device group (0.33). Like siteId, it narrows the caller's visible set and never widens it. */
  groupId?: string;
  // 0.34: the filters a rule group is made of (they are list filters first,
  // so a rule is exactly what the list would show with them set).
  /** OS family, from the self-reported platform (common/platform.ts). */
  platform?: (typeof PLATFORMS)[number];
  /** A substring of the OS caption or version, case-insensitive. Bounded charset. */
  os?: string;
  /** A tag the computer carries, exactly. */
  tag?: string;
  /** Update posture from the last scan: pending > 0, current = 0, unknown = no scan, stale = older than the stale limit. */
  patches?: (typeof PATCH_STATES)[number];
  /** RustDesk client version range, inclusive, dotted numbers only. A computer with no reported version never matches a range. */
  rustdeskMin?: string;
  rustdeskMax?: string;
  /** Last seen more than this many days ago (or never). */
  notSeenDays?: number;
  /** Last seen within this many days. */
  seenWithinDays?: number;
  /**
   * Set by EndpointListService only, never parsed from a request: the rule of
   * the RULE group named by groupId, AND-ed with that group's business.
   */
  groupRule?: { customerId: string; rule: ListFilters | null };
  /**
   * Bulk export only (0.33): the selected computers. Never parsed from a
   * query string or stored in a view — set by DeviceBulkService, AND-ed like
   * every other filter.
   */
  ids?: string[];
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

/**
 * The filter parameters the list accepts — what a saved view may store
 * (0.33). sort and dir are stored beside them; page and pageSize never are.
 */
export const LIST_FILTER_KEYS = [
  'search', 'businessId', 'siteId', 'online', 'alerts', 'restartPending', 'agent', 'status', 'groupId',
  'platform', 'os', 'tag', 'patches', 'rustdeskMin', 'rustdeskMax', 'notSeenDays', 'seenWithinDays',
] as const;
export type ListFilterKey = (typeof LIST_FILTER_KEYS)[number];
/** The filter half of a ListQuery (no sort, page or internal fields). */
export type ListFilters = Pick<ListQuery, Exclude<ListFilterKey, never>>;

function days(v: unknown, name: string): number | undefined {
  const s = str(v, 6);
  if (s === undefined) return undefined;
  if (!/^\d{1,4}$/.test(s)) throw new BadRequestException(`${name} must be a whole number of days`);
  const n = parseInt(s, 10);
  if (n < 1 || n > MAX_DAYS) throw new BadRequestException(`${name} must be between 1 and ${MAX_DAYS}`);
  return n;
}
function version(v: unknown, name: string): string | undefined {
  const s = str(v, 30);
  if (s === undefined) return undefined;
  if (!isVersion(s)) throw new BadRequestException(`${name} must be a dotted version number, e.g. 1.4.2`);
  return s;
}

/** The filter parameters alone, parsed and bounded like the list parses them. */
export function parseListFilters(q: Record<string, unknown>): ListFilters {
  const rp = str(q.restartPending, 5);
  if (rp !== undefined && rp !== 'true' && rp !== 'false') throw new BadRequestException('restartPending must be true or false');
  const os = str(q.os, 60);
  if (os !== undefined && !OS_TERM.test(os)) throw new BadRequestException('os may contain only letters, digits, spaces and . _ ( ) + -');
  const tag = str(q.tag, 64);
  if (tag !== undefined && CONTROL.test(tag)) throw new BadRequestException('tag contains a control character');
  const rustdeskMin = version(q.rustdeskMin, 'rustdeskMin');
  const rustdeskMax = version(q.rustdeskMax, 'rustdeskMax');
  if (rustdeskMin && rustdeskMax && compareVersions(rustdeskMin, rustdeskMax) > 0) throw new BadRequestException('rustdeskMin is above rustdeskMax');
  const notSeenDays = days(q.notSeenDays, 'notSeenDays');
  const seenWithinDays = days(q.seenWithinDays, 'seenWithinDays');
  return {
    search: str(q.search, 100),
    businessId: str(q.businessId, 64),
    siteId: str(q.siteId, 64),
    online: oneOf(q.online, ['online', 'silent', 'offline'] as const, 'online'),
    alerts: oneOf(q.alerts, ['any', 'critical'] as const, 'alerts'),
    restartPending: rp === 'true' ? true : undefined,
    agent: oneOf(q.agent, ['signed', 'standard', 'none', 'outdated'] as const, 'agent'),
    status: oneOf(q.status, ['current', 'archived', 'all'] as const, 'status') ?? 'current',
    groupId: str(q.groupId, 64),
    platform: oneOf(q.platform, PLATFORMS, 'platform'),
    os, tag,
    patches: oneOf(q.patches, PATCH_STATES, 'patches'),
    rustdeskMin, rustdeskMax, notSeenDays, seenWithinDays,
  };
}

/** Compare two isVersion() strings numerically, missing parts as 0. */
export function compareVersions(a: string, b: string): number {
  const x = versionParts(a) ?? [], y = versionParts(b) ?? [];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Parse and bound the query string. Unknown values are a 400, never ignored into a wider view. */
export function parseListQuery(q: Record<string, unknown>): ListQuery {
  const page = Math.max(1, Math.min(100_000, parseInt(String(q.page ?? '1'), 10) || 1));
  const rawSize = parseInt(String(q.pageSize ?? '50'), 10) || 50;
  const pageSize = PAGE_SIZES.includes(rawSize) ? rawSize : 50;
  const sort = oneOf(q.sort, SORT_KEYS, 'sort') ?? 'online';
  return {
    ...parseListFilters(q),
    sort,
    // Online-first and name ascending read naturally; every other column
    // starts with the "worst / most / newest" end first.
    dir: oneOf(q.dir, ['asc', 'desc'] as const, 'dir') ?? (sort === 'name' || sort === 'business' || sort === 'site' || sort === 'os' || sort === 'user' || sort === 'online' ? 'asc' : 'desc'),
    page, pageSize,
  };
}

/**
 * Parsed filters back in their stored form (a saved view's `filters`, a rule
 * group's `rule`): set values only, in LIST_FILTER_KEYS order, every value a
 * string or `true`. parseListFilters(storedForm(f)) gives f again.
 */
export function storedForm(f: ListFilters, keys: readonly ListFilterKey[] = LIST_FILTER_KEYS): Partial<Record<ListFilterKey, string | boolean>> {
  const out: Partial<Record<ListFilterKey, string | boolean>> = {};
  for (const k of keys) {
    const v = f[k];
    if (v === undefined || v === null || v === '' || v === false) continue;
    if (k === 'status' && v === 'current') continue;
    out[k] = typeof v === 'boolean' ? v : String(v);
  }
  return out;
}

