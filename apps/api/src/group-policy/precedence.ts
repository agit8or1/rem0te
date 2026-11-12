/**
 * Policy precedence (0.35): which of several policies that could govern one
 * computer actually does, and why. Pure — no database, no clock — so the
 * same decision is made by the monitor sweep, the client-update sweep, the
 * heartbeat and every page that says "effective policy", and
 * scripts/unit-group-policy.mjs tests it on its own.
 *
 * The rule, most specific first:
 *
 *   computer  >  device group  >  site  >  business  >  global
 *
 * A computer may be in any number of its business's groups (static or
 * rule-based). Between two GROUP policies the lower `priority` wins (1 is
 * first). Priorities are unique per business among group policies (for
 * monitors: per business and key), enforced by a partial unique index, so
 * two group policies never tie when they are evaluated. Should one ever
 * reach here (a row written around the index), the policy id breaks the tie
 * — a fixed, visible order, never the order the database returned rows in.
 *
 * Why a priority rather than refusing overlapping group policies: whether two
 * groups overlap is not a property of the policies. A rule group's members
 * change by themselves (a computer goes offline, reports a new version, is
 * not seen for a week), and a static group's change by bulk actions that
 * never look at policies. A save-time overlap check would be true when it ran
 * and false an hour later, with nothing to say so. A priority is decided once,
 * by the person who sets the policy, and holds whatever the membership does.
 */

export type PolicyScope = 'global' | 'business' | 'site' | 'group' | 'endpoint';

/** Higher is more specific. */
export const SCOPE_RANK: Record<PolicyScope, number> = { global: 0, business: 1, site: 2, group: 3, endpoint: 4 };

export const PRIORITY_MIN = 1;
export const PRIORITY_MAX = 999;

export interface Scoped {
  id: string;
  scope: PolicyScope;
  /** Group policies only: 1 first. */
  priority?: number | null;
  groupId?: string | null;
}

/**
 * Order two candidates that both apply: negative when `a` takes precedence.
 * Total and deterministic — it never returns 0 for two different ids.
 */
export function comparePrecedence(a: Scoped, b: Scoped): number {
  const r = SCOPE_RANK[b.scope] - SCOPE_RANK[a.scope];
  if (r) return r;
  if (a.scope === 'group') {
    const pa = a.priority ?? Number.MAX_SAFE_INTEGER, pb = b.priority ?? Number.MAX_SAFE_INTEGER;
    if (pa !== pb) return pa - pb;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export type Outcome = { reason: 'won' } | { reason: 'more_specific'; by: string } | { reason: 'priority'; by: string } | { reason: 'tie_id'; by: string };

export interface Resolution<P extends Scoped> {
  winner: P | null;
  /** Every candidate that applied, in precedence order, with what beat it. */
  ranked: (P & { outcome: Outcome })[];
}

/** The winner among candidates that all apply to this computer. */
export function resolve<P extends Scoped>(applicable: P[]): Resolution<P> {
  const ranked = [...applicable].sort(comparePrecedence);
  const winner = ranked[0] ?? null;
  return {
    winner,
    ranked: ranked.map((p, i) => {
      if (i === 0) return { ...p, outcome: { reason: 'won' } as Outcome };
      const w = winner!;
      const outcome: Outcome = SCOPE_RANK[w.scope] !== SCOPE_RANK[p.scope] ? { reason: 'more_specific', by: w.id }
        : w.scope === 'group' && (w.priority ?? null) !== (p.priority ?? null) ? { reason: 'priority', by: w.id }
          : { reason: 'tie_id', by: w.id };
      return { ...p, outcome };
    }),
  };
}

/** Does a policy at this scope apply to this computer? */
export function applies(
  p: { scope: PolicyScope; customerId?: string | null; siteId?: string | null; groupId?: string | null; endpointId?: string | null },
  ep: { id: string; customerId: string | null; siteId: string | null; groupIds: ReadonlySet<string> | readonly string[] },
): boolean {
  const inGroup = (g: string) => (ep.groupIds instanceof Set ? ep.groupIds.has(g) : (ep.groupIds as readonly string[]).includes(g));
  switch (p.scope) {
    case 'global': return true;
    case 'business': return !!ep.customerId && p.customerId === ep.customerId;
    case 'site': return !!ep.siteId && p.siteId === ep.siteId && (!p.customerId || p.customerId === ep.customerId);
    case 'group': return !!p.groupId && !!ep.customerId && p.customerId === ep.customerId && inGroup(p.groupId);
    case 'endpoint': return p.endpointId === ep.id;
  }
}

/** One sentence, for a page: why this policy governs the computer. */
export function explain<P extends Scoped>(r: Resolution<P>, name: (p: P) => string): string {
  if (!r.winner) return 'No policy applies to this computer.';
  const w = r.ranked[0];
  const others = r.ranked.slice(1);
  const lead = w.scope === 'group'
    ? `${name(w)} applies because the computer is in that group, at priority ${w.priority ?? '—'}`
    : `${name(w)} applies`;
  if (!others.length) return `${lead}; nothing else applies here.`;
  const byPriority = others.filter((o) => o.outcome.reason === 'priority' || o.outcome.reason === 'tie_id');
  const bySpec = others.filter((o) => o.outcome.reason === 'more_specific');
  const parts: string[] = [];
  if (byPriority.length) parts.push(`it is ahead of ${byPriority.map((o) => `${name(o)} (priority ${o.priority ?? '—'})`).join(', ')} on priority, 1 first`);
  if (bySpec.length) parts.push(`it is more specific than ${bySpec.map(name).join(', ')}`);
  return `${lead}; ${parts.join('; and ')}.`;
}
