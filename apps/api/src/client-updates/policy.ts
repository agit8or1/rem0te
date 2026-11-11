import { z } from 'zod';
import { compareVersions } from '../common/agent-contract';
import { isWindowOpen, storedWindow, type UpdateWindow } from './update-window';

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
  enabled: z.boolean(),
  timeZone: z.string().min(1).max(64),
  windows: z.array(z.object({
    days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    start: z.string().max(5),
    end: z.string().max(5),
  }).strict()).min(1).max(7),
  skipActiveSession: z.boolean().default(true),
  skipLoggedOnUser: z.boolean().default(false),
}).strict();
export type PolicyInput = z.infer<typeof PolicyInput>;

export interface PolicyLike {
  id: string;
  customerId: string;
  siteId: string | null;
  enabled: boolean;
  timeZone: string;
  windows: unknown;
  skipActiveSession: boolean;
  skipLoggedOnUser: boolean;
}

/**
 * The policy that governs one computer: its site's override when there is one,
 * otherwise its business's. An override replaces the business policy for that
 * site entirely — including being off when the business is on.
 */
export function effectivePolicy<P extends PolicyLike>(
  policies: P[], customerId: string | null, siteId: string | null,
): P | null {
  if (!customerId) return null;
  const mine = policies.filter((p) => p.customerId === customerId);
  return (siteId ? mine.find((p) => p.siteId === siteId) : undefined) ?? mine.find((p) => p.siteId === null) ?? null;
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
