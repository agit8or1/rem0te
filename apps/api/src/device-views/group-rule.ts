import { BadRequestException } from '@nestjs/common';
import { parseListFilters, storedForm, type ListFilterKey, type ListFilters } from '../endpoints/list-query';

/**
 * Rule-based device groups (0.34): what a rule may say, decided without a
 * database so it is unit-tested (scripts/unit-dynamic-groups.mjs) and shared
 * by the groups service and the device list.
 *
 * A rule is a closed set of the device list's OWN filter parameters,
 * validated by the list's own parser (parseListFilters) — the same JSON shape
 * a saved view stores. It is never SQL and never free text: each value is an
 * enum member, an id, a bounded number of days, a dotted version or a
 * charset-checked term, and the device list turns each one into a Prisma
 * filter or a parameterised SQL fragment it already uses for that filter.
 *
 * Membership is the rule AND-ed with the group's business AND-ed with the
 * reader's own visibility (EndpointListService.scopedWhere), computed on
 * every read. Nothing is stored, so nothing goes stale.
 */

/** What a rule may filter on. */
export const RULE_KEYS = [
  'siteId', 'online', 'alerts', 'restartPending', 'agent',
  'platform', 'os', 'tag', 'patches', 'rustdeskMin', 'rustdeskMax', 'notSeenDays', 'seenWithinDays',
] as const satisfies readonly ListFilterKey[];
export type RuleKey = (typeof RULE_KEYS)[number];

/**
 * List filters a rule may NOT carry, and why — refused by name, never
 * dropped (a rule that silently lost a condition would match more than its
 * author meant).
 */
export const RULE_REFUSED: Partial<Record<ListFilterKey, string>> = {
  search: 'search is free text over names, users and addresses; a rule uses closed filters only',
  businessId: 'a rule group belongs to one business already',
  groupId: 'a rule cannot refer to another group',
  status: 'archived computers are governed by the list’s own Archived filter, not by the rule',
};

/** Rule groups per business. Each one is evaluated on every list read that shows groups, so the count is bounded. */
export const MAX_RULE_GROUPS_PER_BUSINESS = 50;

export type StoredRule = Partial<Record<RuleKey, string | boolean>>;

const bad = (message: string) => new BadRequestException({ code: 'INVALID_RULE', message });
const ID = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * A rule as submitted, validated and reduced to its stored form. Refuses:
 * anything that is not a plain object; unknown keys; the RULE_REFUSED keys;
 * any value that is not a string or boolean; any value the device list
 * itself refuses; a non-id siteId; and an empty rule (it would be "every
 * computer of the business", which is the business filter, not a group).
 */
export function parseRule(raw: unknown): StoredRule {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('rule must be an object of device-list filters');
  const obj = raw as Record<string, unknown>;
  const keys = Object.keys(obj);
  const refused = keys.filter((k) => k in RULE_REFUSED);
  if (refused.length) throw bad(`A rule cannot use ${refused.map((k) => `${k} (${RULE_REFUSED[k as ListFilterKey]})`).join('; ')}`);
  const unknown = keys.filter((k) => !(RULE_KEYS as readonly string[]).includes(k));
  if (unknown.length) throw bad(`A rule stores only device-list filters; not: ${unknown.join(', ')}`);
  const asQuery: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined || v === '' || v === false) continue;
    if (typeof v === 'boolean') asQuery[k] = String(v);
    else if (typeof v === 'string') asQuery[k] = v;
    else if (typeof v === 'number' && (k === 'notSeenDays' || k === 'seenWithinDays') && Number.isInteger(v)) asQuery[k] = String(v);
    else throw bad(`${k} must be a string`);
  }
  let f: ListFilters;
  try {
    f = parseListFilters(asQuery);
  } catch (e) {
    const m = (e as { message?: string }).message ?? 'invalid value';
    throw bad(m);
  }
  if (f.siteId !== undefined && !ID.test(f.siteId)) throw bad('siteId is not an id');
  const out = storedForm(f, RULE_KEYS) as StoredRule;
  if (!Object.keys(out).length) throw bad('A rule needs at least one condition.');
  return out;
}

/**
 * A rule read back from the database, as list filters — or null when it no
 * longer parses (a value an older or newer build wrote, a hand edit). A null
 * rule matches nothing: a group whose rule cannot be read must never fall
 * back to "the whole business".
 */
export function ruleFilters(stored: unknown): ListFilters | null {
  try {
    const r = parseRule(stored);
    // Stored values are strings or `true`; the list parser reads query strings.
    const f = parseListFilters(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, String(v)])));
    // parseListFilters fills status = 'current'; a rule never constrains status.
    delete f.status;
    return f;
  } catch {
    return null;
  }
}

/** Does evaluating this rule read alert state (and so need monitoring:alerts)? */
export function ruleNeedsAlerts(rule: ListFilters | null): boolean {
  return !!rule?.alerts;
}
