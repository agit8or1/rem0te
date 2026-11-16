import { applies, resolve, type PolicyScope } from '../group-policy/precedence';

/**
 * Which restart window governs a computer (0.60). Pure: no database, no
 * clock, no Nest. The sweep, the computer page, the business page and
 * scripts/unit-restart-window-settings.mjs all decide through it.
 *
 * Precedence is the 0.35 rule (group-policy/precedence.ts), most specific
 * first: the computer's own setting, then its device groups' (priority, 1
 * first), then the business's. A computer's own "no automatic restarts"
 * (or a group's) wins like any other setting.
 *
 * Only a setting IN FORCE competes: `off` always is; a `window` is in force
 * while the policy it stands on is ACTIVE and not paused. A window still
 * waiting for its first approval, rejected, expired or revoked does not
 * govern anything, and the next setting down does — the page says so,
 * naming the setting that is not in force and why.
 *
 * A patch policy's own restart window (0.54) is more specific still: a
 * computer live in an ACTIVE patch policy that has a restart window is
 * restarted by that policy, never by a simple restart window as well.
 */

export type RestartScope = 'business' | 'group' | 'computer';
export const RESTART_SCOPES: readonly RestartScope[] = ['business', 'group', 'computer'];
export const RESTART_MODES = ['window', 'off'] as const;
export type RestartMode = (typeof RESTART_MODES)[number];

export interface SettingLike {
  id: string;
  scope: RestartScope;
  customerId: string;
  groupId: string | null;
  endpointId: string | null;
  priority: number | null;
  mode: RestartMode;
  /** For a window: is the policy it stands on ACTIVE and not paused? Ignored for off. */
  policyLive: boolean;
}

export interface ComputerLike { id: string; customerId: string | null; groupIds: ReadonlySet<string> }

const toPolicyScope = (s: RestartScope): PolicyScope => (s === 'computer' ? 'endpoint' : s);

export function inForce(s: Pick<SettingLike, 'mode' | 'policyLive'>): boolean {
  return s.mode === 'off' || (s.mode === 'window' && s.policyLive);
}

export interface Effective<S extends SettingLike> {
  /** The setting that governs this computer, or null: nothing restarts it automatically. */
  winner: S | null;
  /** Settings that apply to it but are not in force (a window waiting for approval, expired…), most specific first. */
  notInForce: S[];
}

/** The setting that governs one computer, from every setting of its business. */
export function effectiveSetting<S extends SettingLike>(ep: ComputerLike, settings: readonly S[]): Effective<S> {
  if (!ep.customerId) return { winner: null, notInForce: [] };
  const applying = settings.filter((s) => applies(
    { scope: toPolicyScope(s.scope), customerId: s.customerId, groupId: s.groupId, endpointId: s.endpointId },
    { id: ep.id, customerId: ep.customerId, siteId: null, groupIds: ep.groupIds },
  ));
  const view = (s: S) => ({ ...s, id: s.id, scope: toPolicyScope(s.scope), priority: s.priority, groupId: s.groupId });
  const live = applying.filter(inForce);
  const won = resolve(live.map(view)).winner;
  const winner = won ? live.find((s) => s.id === won.id) ?? null : null;
  const notInForce = resolve(applying.filter((s) => !inForce(s)).map(view)).ranked
    .map((r) => applying.find((s) => s.id === r.id)!)
    // Only what would have governed: settings more specific than the winner.
    .filter((s) => !winner || rank(s.scope) > rank(winner.scope) || (s.scope === 'group' && winner.scope === 'group' && (s.priority ?? 999) < (winner.priority ?? 999)));
  return { winner, notInForce };
}

const rank = (s: RestartScope) => (s === 'computer' ? 3 : s === 'group' ? 2 : 1);

/** Where a setting comes from, in words: "set on this computer", "from group Tills", "from business Acme". */
export function sourceInWords(s: Pick<SettingLike, 'scope'>, names: { group?: string | null; business?: string | null }): string {
  if (s.scope === 'computer') return 'set on this computer';
  if (s.scope === 'group') return `from device group ${names.group ?? '(unnamed)'}`;
  return `from business ${names.business ?? '(unnamed)'}`;
}

/** A restart attempt is tried again only after these outcomes (0.54's rule): a RustDesk session, or "cannot tell". */
export const RESTART_RETRY_REASONS: readonly string[] = ['remote_session_open', 'session_state_unknown'];
/** A plan that never reached the computer is tried again too. */
export const RESTART_RETRY_JOB_STATES: readonly string[] = ['REJECTED', 'CANCELED', 'EXPIRED'];

/**
 * May the sweep ask again for this computer in this occurrence, after its
 * last attempt? Only when that attempt asked nothing (refused before the
 * signer signed), or its plan never reached the computer, or the computer
 * deferred it for a RustDesk session or could not tell. A restart that ran,
 * or a computer that said no restart was required, is not asked again.
 */
export function mayRetry(last: { jobId: string | null; jobStatus?: string | null; targetStatus?: string | null; reason?: string | null }): boolean {
  if (!last.jobId) return true;
  if (!last.jobStatus) return true;
  if (RESTART_RETRY_JOB_STATES.includes(last.jobStatus) || last.targetStatus === 'CANCELED') return true;
  return last.targetStatus === 'NOT_EXECUTED' && RESTART_RETRY_REASONS.includes(last.reason ?? '');
}
