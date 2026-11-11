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

export interface ListQuery {
  search?: string;
  businessId?: string;
  siteId?: string;
  online?: 'online' | 'offline';
  alerts?: 'any' | 'critical';
  restartPending?: boolean;
  agent?: 'signed' | 'standard' | 'none';
  status?: 'current' | 'archived' | 'all';
  /** A device group (0.33). Like siteId, it narrows the caller's visible set and never widens it. */
  groupId?: string;
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
export const LIST_FILTER_KEYS = ['search', 'businessId', 'siteId', 'online', 'alerts', 'restartPending', 'agent', 'status', 'groupId'] as const;

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
    groupId: str(q.groupId, 64),
    sort,
    // Online-first and name ascending read naturally; every other column
    // starts with the "worst / most / newest" end first.
    dir: oneOf(q.dir, ['asc', 'desc'] as const, 'dir') ?? (sort === 'name' || sort === 'business' || sort === 'site' || sort === 'os' || sort === 'user' || sort === 'online' ? 'asc' : 'desc'),
    page, pageSize,
  };
}
