/**
 * The MDM command state machine (0.80 Tablet). Pure: it imports only ./model.
 *
 *   queued ──send──▶ sent ──provider accepts──▶ acknowledged ──device reports done──▶ completed
 *      │               │                              │
 *      └───────────────┴── rejected / failed / expired ┴──▶ failed | expired
 *
 * Provider acceptance is NOT device completion. A provider accepting a lock
 * means it queued the command for the device (Apple: an APNs push that may
 * never arrive; Android Management API: a long-running Operation; Intune: an
 * action result of "pending"). The device has done it only when the device
 * itself reports so, which may be hours later or never. So:
 *
 *   - `providerAcceptedAt` is stamped only by `provider_accepted`, and only
 *     from `sent`;
 *   - `deviceCompletedAt` is stamped only by `device_completed`, and only from
 *     `acknowledged`: a completion the provider never accepted is refused
 *     (`not_accepted`), never back-filled;
 *   - completed, failed and expired are final: nothing moves a command out of
 *     them (`terminal`);
 *   - an event that only restates what is recorded (the next sync reporting
 *     the same acceptance) changes nothing and is not an error.
 *
 * 0096's CHECKs hold the same shape in SQL (a completed row has both
 * timestamps, an acknowledged one only the first, a failed one a code…), so
 * a writer that skipped this module would still be refused.
 *
 * Nothing in 0.80 creates a `queued` command: no device action can be
 * requested. The sync records commands a provider reports (origin
 * `provider`) by `observe()`; 3.3 and 3.4 will queue from the portal and use
 * the same transitions.
 */
import { CommandState, FAILURE_CODE_RE } from './model';

export const TERMINAL_STATES: readonly CommandState[] = ['completed', 'failed', 'expired'];

/** Every legal move. Anything not listed is refused. */
export const TRANSITIONS: Readonly<Record<CommandState, readonly CommandState[]>> = {
  queued: ['sent', 'failed', 'expired'],
  sent: ['acknowledged', 'failed', 'expired'],
  acknowledged: ['completed', 'failed', 'expired'],
  completed: [],
  failed: [],
  expired: [],
};

export interface CommandFacts {
  state: CommandState;
  sentAt: Date | null;
  providerAcceptedAt: Date | null;
  deviceCompletedAt: Date | null;
  failedAt: Date | null;
  failureCode: string | null;
  expiresAt: Date | null;
  expiredAt: Date | null;
}

export type CommandEvent =
  | { type: 'sent'; at: Date }
  | { type: 'provider_accepted'; at: Date }
  | { type: 'provider_rejected'; at: Date; code: string }
  | { type: 'device_completed'; at: Date }
  | { type: 'device_failed'; at: Date; code: string }
  | { type: 'expired'; at: Date };

export type Refusal = 'terminal' | 'not_sent' | 'not_accepted' | 'already_accepted' | 'not_due' | 'bad_code' | 'bad_time';
export type Step = { ok: true; next: CommandFacts; changed: boolean } | { ok: false; reason: Refusal };

export const isTerminal = (s: CommandState) => TERMINAL_STATES.includes(s);
export const canMove = (from: CommandState, to: CommandState) => TRANSITIONS[from].includes(to);

/** A brand-new command Rem0te is about to send (3.3+). */
export function queuedCommand(expiresAt: Date | null): CommandFacts {
  return { state: 'queued', sentAt: null, providerAcceptedAt: null, deviceCompletedAt: null, failedAt: null, failureCode: null, expiresAt, expiredAt: null };
}

/** A command first seen in a provider's report: it was sent (by the provider's console) at `sentAt`. */
export function observedCommand(sentAt: Date, expiresAt: Date | null): CommandFacts {
  return { ...queuedCommand(expiresAt), state: 'sent', sentAt };
}

const okDate = (d: Date) => d instanceof Date && !Number.isNaN(d.getTime());
const move = (f: CommandFacts, to: CommandState, patch: Partial<CommandFacts>): Step => {
  if (!canMove(f.state, to)) return { ok: false, reason: isTerminal(f.state) ? 'terminal' : f.state === 'queued' ? 'not_sent' : 'not_accepted' };
  return { ok: true, changed: true, next: { ...f, ...patch, state: to } };
};
const same = (f: CommandFacts): Step => ({ ok: true, changed: false, next: f });

/** Apply one event. Never throws; a refusal leaves the facts as they were. */
export function apply(f: CommandFacts, e: CommandEvent): Step {
  if (!okDate(e.at)) return { ok: false, reason: 'bad_time' };
  switch (e.type) {
    case 'sent':
      if (f.state !== 'queued') return f.sentAt && !isTerminal(f.state) ? same(f) : { ok: false, reason: isTerminal(f.state) ? 'terminal' : 'not_sent' };
      return move(f, 'sent', { sentAt: e.at });
    case 'provider_accepted':
      if (f.state === 'acknowledged' || (f.state === 'completed' && f.providerAcceptedAt)) return same(f);
      if (f.state === 'queued') return { ok: false, reason: 'not_sent' };
      return move(f, 'acknowledged', { providerAcceptedAt: e.at });
    case 'provider_rejected':
      if (!FAILURE_CODE_RE.test(e.code)) return { ok: false, reason: 'bad_code' };
      if (f.state === 'failed' && f.failureCode === `provider_rejected:${e.code}`) return same(f);
      // Once accepted, the provider can no longer reject it: only the device can fail it.
      if (f.state === 'acknowledged') return { ok: false, reason: 'already_accepted' };
      return move(f, 'failed', { failedAt: e.at, failureCode: `provider_rejected:${e.code}` });
    case 'device_completed':
      if (f.state === 'completed') return same(f);
      // Completion without acceptance is refused, never back-filled.
      if (f.state === 'queued' || f.state === 'sent') return { ok: false, reason: 'not_accepted' };
      return move(f, 'completed', { deviceCompletedAt: e.at });
    case 'device_failed':
      if (!FAILURE_CODE_RE.test(e.code)) return { ok: false, reason: 'bad_code' };
      if (f.state === 'failed' && f.failureCode === `device:${e.code}`) return same(f);
      if (f.state === 'queued' || f.state === 'sent') return { ok: false, reason: 'not_accepted' };
      return move(f, 'failed', { failedAt: e.at, failureCode: `device:${e.code}` });
    case 'expired':
      if (f.state === 'expired') return same(f);
      if (!f.expiresAt || e.at.getTime() < f.expiresAt.getTime()) return isTerminal(f.state) ? { ok: false, reason: 'terminal' } : { ok: false, reason: 'not_due' };
      return move(f, 'expired', { expiredAt: e.at });
  }
}

/** What a provider reports about one command, already parsed (schemas.ts). */
export interface ProviderCommandReport {
  acceptedAt: Date | null;
  rejected: { at: Date; code: string } | null;
  completedAt: Date | null;
  failed: { at: Date; code: string } | null;
}

/** The report as events, in the only order they can happen. */
export function eventsFromReport(r: ProviderCommandReport): CommandEvent[] {
  const ev: CommandEvent[] = [];
  if (r.rejected) ev.push({ type: 'provider_rejected', at: r.rejected.at, code: r.rejected.code });
  if (r.acceptedAt) ev.push({ type: 'provider_accepted', at: r.acceptedAt });
  if (r.completedAt) ev.push({ type: 'device_completed', at: r.completedAt });
  if (r.failed) ev.push({ type: 'device_failed', at: r.failed.at, code: r.failed.code });
  return ev;
}

/**
 * Bring recorded facts up to a provider's latest report. A terminal command
 * is left as it is. The first refused event stops the walk: what was applied
 * before it stands, and the refusal is returned so the sync can count it.
 */
export function reconcile(f: CommandFacts, r: ProviderCommandReport): { next: CommandFacts; changed: boolean; refused: Refusal | null } {
  if (isTerminal(f.state)) return { next: f, changed: false, refused: null };
  let cur = f, changed = false;
  for (const e of eventsFromReport(r)) {
    const s = apply(cur, e);
    if (!s.ok) return { next: cur, changed, refused: s.reason };
    cur = s.next; changed = changed || s.changed;
  }
  return { next: cur, changed, refused: null };
}

/** Expire a command whose deadline passed, if it is not final yet. */
export function expireIfDue(f: CommandFacts, now: Date): { next: CommandFacts; changed: boolean } {
  if (isTerminal(f.state) || !f.expiresAt || now.getTime() < f.expiresAt.getTime()) return { next: f, changed: false };
  const s = apply(f, { type: 'expired', at: now });
  return s.ok ? { next: s.next, changed: s.changed } : { next: f, changed: false };
}

/**
 * The two facts the console shows side by side. "Accepted by the provider"
 * and "Completed on the device" are never merged into one "done".
 */
export function commandProgress(f: CommandFacts): {
  providerAccepted: { done: boolean; at: Date | null };
  deviceCompleted: { done: boolean; at: Date | null };
  waitingFor: 'send' | 'provider' | 'device' | null;
} {
  return {
    providerAccepted: { done: !!f.providerAcceptedAt, at: f.providerAcceptedAt },
    deviceCompleted: { done: !!f.deviceCompletedAt, at: f.deviceCompletedAt },
    waitingFor: f.state === 'queued' ? 'send' : f.state === 'sent' ? 'provider' : f.state === 'acknowledged' ? 'device' : null,
  };
}
