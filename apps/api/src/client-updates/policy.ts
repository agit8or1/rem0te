import { z } from 'zod';
import { compareVersions } from '../common/agent-contract';
import { isWindowOpen, storedWindow, type UpdateWindow } from './update-window';
import { applies, explain, PRIORITY_MAX, PRIORITY_MIN, resolve, type PolicyScope, type Resolution } from '../group-policy/precedence';

/**
 * Client-update policy (0.32): the pure decisions, kept here so they are
 * unit-tested without a database and the sweep, the heartbeat and the page
 * cannot each grow their own idea of them.
 */

const ID = /^[A-Za-z0-9_-]{8,64}$/;

export const PolicyInput = z.object({
  businessId: z.string().regex(ID),
  /** Omitted or null: the business policy. Set: that site's override. */
  siteId: z.string().regex(ID).nullable().optional(),
  /** 0.35: set — that device group's policy (never with siteId), with a priority (1 first). */
  groupId: z.string().regex(ID).nullable().optional(),
  priority: z.number().int().min(PRIORITY_MIN).max(PRIORITY_MAX).nullable().optional(),
  enabled: z.boolean(),
  timeZone: z.string().min(1).max(64),
  windows: z.array(z.object({
    days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    start: z.string().max(5),
    end: z.string().max(5),
  }).strict()).min(1).max(7),
  skipActiveSession: z.boolean().default(true),
  skipLoggedOnUser: z.boolean().default(false),
  /**
   * 0.36: automatic agent updates for the computers this policy governs —
   * ANY_TIME (paced), WINDOW (only inside this policy's window) or OFF; null
   * inherits. Omitted: left as it is (agent-auto-update/schedule.ts).
   */
  agentMode: z.enum(['ANY_TIME', 'WINDOW', 'OFF']).nullable().optional(),
}).strict();
export type PolicyInput = z.infer<typeof PolicyInput>;

export interface PolicyLike {
  id: string;
  customerId: string;
  siteId: string | null;
  /** 0.35 */
  groupId?: string | null;
  priority?: number | null;
  enabled: boolean;
  timeZone: string;
  windows: unknown;
  skipActiveSession: boolean;
  skipLoggedOnUser: boolean;
}

export const policyScope = (p: Pick<PolicyLike, 'siteId' | 'groupId'>): PolicyScope => (p.groupId ? 'group' : p.siteId ? 'site' : 'business');

/**
 * Every policy that could govern one computer, ranked (group-policy/
 * precedence.ts): a device-group policy for a group it is in — between two,
 * the lower priority — then its site's override, then its business's. There
 * is no per-computer client-update policy: the one-off is the Update button.
 * The winner replaces the others entirely, including being off when a
 * broader one is on.
 */
export function resolvePolicy<P extends PolicyLike>(
  policies: P[], ep: { id: string; customerId: string | null; siteId: string | null; groupIds?: ReadonlySet<string> | readonly string[] },
): Resolution<P & { scope: PolicyScope }> {
  if (!ep.customerId) return { winner: null, ranked: [] };
  const groupIds = ep.groupIds ?? [];
  const cands = policies
    .map((p) => ({ ...p, scope: policyScope(p) }))
    .filter((p) => applies(p, { id: ep.id, customerId: ep.customerId, siteId: ep.siteId, groupIds }));
  return resolve(cands);
}

/** The policy that governs one computer, or null. */
export function effectivePolicy<P extends PolicyLike>(
  policies: P[], customerId: string | null, siteId: string | null, groupIds: ReadonlySet<string> | readonly string[] = [],
): P | null {
  const w = resolvePolicy(policies, { id: '', customerId, siteId, groupIds }).winner;
  if (!w) return null;
  return policies.find((p) => p.id === w.id) ?? null;
}

/** Why the winner governs this computer, in one sentence, naming groups and sites by `names`. */
export function explainPolicy<P extends PolicyLike>(r: Resolution<P & { scope: PolicyScope }>, names: { group: (id: string) => string; site: (id: string) => string }): string {
  return explain(r, (p) => (p.scope === 'group' ? `the policy of group ${names.group(p.groupId!)}` : p.scope === 'site' ? `the override for site ${names.site(p.siteId!)}` : 'the business policy'));
}

export function policyWindow(p: Pick<PolicyLike, 'timeZone' | 'windows'> | null): UpdateWindow | null {
  return p ? storedWindow(p.timeZone, p.windows) : null;
}

export type HoldReason = 'policy_off' | 'outside_window' | 'session_open' | 'user_logged_on' | 'user_unknown';

export const HOLD_TEXT: Record<HoldReason, string> = {
  policy_off: 'the update policy that queued it is now off',
  outside_window: 'waiting for the update window',
  session_open: 'a remote session is open on it',
  user_logged_on: 'someone is logged on',
  user_unknown: 'its agent does not report who is logged on, and the policy skips computers with a user',
};

/**
 * Should the heartbeat withhold a POLICY-queued update right now? Null means
 * hand it out. A MANUAL request never comes through here.
 *
 * `sessionOpen` is the caller's session evidence (reported by the endpoint, a
 * confirmed session, or an unconfirmed recent launch); `loggedOnUser` is what
 * this heartbeat reported. The standard agent sends '' for "nobody"; a value
 * that is absent altogether means the agent does not say, and when the policy
 * skips computers with a user that fails closed — an unknown is not "nobody".
 */
export function policyHold(
  p: PolicyLike | null, now: Date, facts: { sessionOpen: boolean; loggedOnUser: string | null | undefined },
): HoldReason | null {
  if (!p || !p.enabled) return 'policy_off';
  if (!isWindowOpen(policyWindow(p), now)) return 'outside_window';
  if (p.skipActiveSession && facts.sessionOpen) return 'session_open';
  if (p.skipLoggedOnUser) {
    if (facts.loggedOnUser === undefined || facts.loggedOnUser === null) return 'user_unknown';
    if (facts.loggedOnUser.trim()) return 'user_logged_on';
  }
  return null;
}

/**
 * Why a computer will not be queued automatically, or null if it can be.
 * `permanent` ones will not change on their own (someone has to fix the
 * machine); the rest are states that pass.
 */
export type Blocker =
  | 'archived' | 'no_rustdesk' | 'not_windows' | 'no_device_secret' | 'version_unknown'
  | 'offline' | 'up_to_date' | 'rollout' | 'queued';

export const BLOCKER: Record<Blocker, { permanent: boolean; text: string }> = {
  archived: { permanent: true, text: 'Archived — nothing is sent to an archived computer.' },
  no_rustdesk: { permanent: true, text: 'No RustDesk client is linked to this computer.' },
  not_windows: { permanent: true, text: 'Not Windows — automatic client updates re-run the Windows installer.' },
  no_device_secret: { permanent: true, text: 'Never authenticated with a device secret, so the server cannot ask it to do anything. Re-run the installer on the machine once.' },
  version_unknown: { permanent: true, text: 'Has never reported a RustDesk version (agent older than 0.8.2), so it would not understand the instruction. Reinstall the agent.' },
  offline: { permanent: false, text: 'Offline — it is queued only while online.' },
  up_to_date: { permanent: false, text: 'Already on the target version.' },
  rollout: { permanent: false, text: 'A staged rollout owns this computer’s updates.' },
  queued: { permanent: false, text: 'Already queued.' },
};

/** UpdateJob states in which a staged rollout owns a computer's updates. */
export const ROLLOUT_OPEN = ['REQUESTED', 'DISPATCHED', 'INSTALLING', 'AWAITING_VERIFICATION'] as const;

export interface EligibilityFacts {
  status: string;
  isOnline: boolean;
  platform: string | null;
  node: { agentSecretHash: string | null; version: string | null; updateRequestedAt: Date | null } | null;
  inRollout: boolean;
}

/** The first reason this computer cannot be auto-queued for `target`, or null. Ordered: permanent reasons first. */
export function blocker(e: EligibilityFacts, target: string | null): Blocker | null {
  if (e.status === 'ARCHIVED') return 'archived';
  if (!e.node) return 'no_rustdesk';
  if (!/windows/i.test(e.platform ?? '')) return 'not_windows';
  if (!e.node.agentSecretHash) return 'no_device_secret';
  if (!e.node.version) return 'version_unknown';
  if (target && compareVersions(e.node.version, target) >= 0) return 'up_to_date';
  if (e.node.updateRequestedAt) return 'queued';
  if (e.inRollout) return 'rollout';
  if (!e.isOnline) return 'offline';
  return null;
}

/**
 * What to do with an automatic (POLICY) request already queued, now (0.36).
 *
 * The request was queued under one policy; the computer may since have left
 * the device group that policy belongs to, moved site, or had the policy
 * removed or switched off. Before 0.36 only saving a policy re-checked
 * queued requests, so a computer that left a group kept its request queued —
 * and the heartbeat held it as `policy_off` — until someone next saved the
 * business's policy. The sweep now asks this every tick:
 *
 *   keep      the policy that queued it still governs the computer, enabled
 *   adopt     queued before 0.36 (no policy recorded) and an enabled policy
 *             governs it: record that policy, nothing else changes
 *   replan    a different enabled policy governs it now: the request stays,
 *             under that policy's window and conditions
 *   withdraw  no enabled policy governs it: the request is removed
 *
 * `reason` says why the queuing policy no longer counts:
 *   policy_removed     it was deleted
 *   policy_off         it was switched off
 *   no_longer_applies  it is still there and on, but no longer governs this
 *                      computer (it left the group or site, or a policy
 *                      that outranks it now applies)
 *   no_policy_recorded queued before 0.36
 */
export type QueuedAction = 'keep' | 'adopt' | 'replan' | 'withdraw';
export type QueuedReason = 'policy_removed' | 'policy_off' | 'no_longer_applies' | 'no_policy_recorded';
export interface QueuedDecision { action: QueuedAction; reason: QueuedReason | null; from: string | null; to: string | null }

export const QUEUED_REASON_TEXT: Record<QueuedReason, string> = {
  policy_removed: 'the update policy that queued it was removed',
  policy_off: 'the update policy that queued it was switched off',
  no_longer_applies: 'the update policy that queued it no longer applies to this computer (it left that device group or site, or another policy now outranks it)',
  no_policy_recorded: 'it was queued before 0.36, which did not record the policy',
};

export function reconcileQueued<P extends Pick<PolicyLike, 'id' | 'enabled'>>(queuedPolicyId: string | null, effective: P | null, policies: P[]): QueuedDecision {
  const to = effective && effective.enabled ? effective.id : null;
  if (to && queuedPolicyId === to) return { action: 'keep', reason: null, from: queuedPolicyId, to };
  let reason: QueuedReason;
  if (!queuedPolicyId) reason = 'no_policy_recorded';
  else {
    const was = policies.find((p) => p.id === queuedPolicyId);
    reason = !was ? 'policy_removed' : !was.enabled ? 'policy_off' : 'no_longer_applies';
  }
  if (!to) return { action: 'withdraw', reason, from: queuedPolicyId, to: null };
  return { action: queuedPolicyId ? 'replan' : 'adopt', reason, from: queuedPolicyId, to };
}
