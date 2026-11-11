import { BadRequestException } from '@nestjs/common';
import { likeEscape } from '../common/like';

/**
 * Global search (0.33): parsing and the pure parts of matching. No database,
 * no Nest beyond the exception, so scripts/unit-search.mjs can test it from
 * dist.
 */

export const MIN_QUERY = 2;
export const MAX_QUERY = 100;
/** Results per group. One more is fetched to say "more" without counting. */
export const GROUP_CAP = 8;

export const GROUPS = ['computers', 'businesses', 'sites', 'users', 'alerts'] as const;
export type SearchGroup = (typeof GROUPS)[number];

/**
 * The capability each group's own list page needs — the same one, never a
 * weaker one. `null` = the list route has no capability gate (GET /businesses:
 * a member may always see their own business); its scope rule still applies.
 *
 *   computers   GET /endpoints/list           computers:view
 *   sites       GET /sites                    computers:view
 *   users       GET /users                    users:view
 *   alerts      GET /monitoring/alerts        monitoring:alerts (inside alertWhere)
 *   businesses  GET /businesses               none
 */
export const GROUP_CAPABILITY = {
  computers: 'computers:view',
  businesses: null,
  sites: 'computers:view',
  users: 'users:view',
  alerts: 'monitoring:alerts',
} as const satisfies Record<SearchGroup, string | null>;

/** Which computer field matched, in the order a tie is reported. */
export const COMPUTER_FIELDS = ['name', 'hostname', 'rustdeskId', 'serialNumber', 'loggedOnUser', 'ipAddress', 'privateIp', 'alias'] as const;
export type ComputerField = (typeof COMPUTER_FIELDS)[number];

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\ufeff]/g;

/**
 * Validate `q`. Control and invisible formatting characters are removed and
 * runs of whitespace collapsed before the length is checked, so a query of
 * two zero-width spaces is "too short", not a search for nothing.
 */
export function parseSearchQuery(raw: unknown): string {
  if (Array.isArray(raw)) throw new BadRequestException({ code: 'INVALID_QUERY', message: 'Give q once.' });
  if (typeof raw !== 'string') throw new BadRequestException({ code: 'INVALID_QUERY', message: `q is required (${MIN_QUERY}–${MAX_QUERY} characters).` });
  // Whitespace controls (tab, newline) separate words; the rest are dropped.
  const q = raw.replace(/[\t\n\v\f\r]/g, ' ').replace(CONTROL, '').replace(/\s+/g, ' ').trim();
  if (q.length < MIN_QUERY) throw new BadRequestException({ code: 'QUERY_TOO_SHORT', message: `Type at least ${MIN_QUERY} characters.` });
  if (q.length > MAX_QUERY) throw new BadRequestException({ code: 'QUERY_TOO_LONG', message: `A search is at most ${MAX_QUERY} characters.` });
  return q;
}

// Shared with the list routes' searches (GET /businesses, GET /endpoints, the
// device list), so a wildcard means the same thing everywhere.
export { likeEscape };

/** The three patterns the computer query ranks by: exact, prefix, anywhere. */
export function likePatterns(q: string) {
  const e = likeEscape(q.toLowerCase());
  return { exact: q.toLowerCase(), prefix: `${e}%`, contains: `%${e}%` };
}

/**
 * Words of a person's search: "jane doe" finds Jane Doe. Each word must match
 * the first name, last name or email. At most five words, so a long query
 * cannot become a large OR.
 */
export function nameWords(q: string): string[] {
  return [...new Set(q.split(' ').filter(Boolean))].slice(0, 5);
}

/** Rank one value against the query, as the SQL does: 0 exact, 1 prefix, 2 contains, null no match. */
export function rankOf(value: string | null | undefined, q: string): 0 | 1 | 2 | null {
  if (!value) return null;
  const v = value.toLowerCase(), l = q.toLowerCase();
  if (v === l) return 0;
  if (v.startsWith(l)) return 1;
  return v.includes(l) ? 2 : null;
}

/**
 * Could this be part of an adapter address? Only then are the inventory's
 * adapter lists searched, which keeps a name search from unpacking JSON.
 * Hex digits, dots, colons, a slash and a zone index cover IPv4, IPv6 and CIDR.
 */
export function looksLikeAddress(q: string): boolean {
  return /^[0-9a-f.:/%]+$/i.test(q) && /[0-9]/.test(q) && /[.:]/.test(q);
}
