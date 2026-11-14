import { ForbiddenException } from '@nestjs/common';
import type { ActorContext } from '../rbac/access-control.service';
import { ALWAYS_ASK_KEYS, CONFIRM_KEYS, type ConfirmKey, type ConfirmValue, type StepUpKey } from './confirm-catalog';

/**
 * Independent review: the decider is someone other than the requester, and
 * is either a Platform Admin or a designated independent reviewer
 * (`approvals:review`). Holding a technician tier is never enough.
 *
 * A deployment with a single Platform Admin and no reviewer cannot approve a
 * widening at all. That is the point: the request stays pending and visible
 * until a second person exists.
 */
export function assertIndependentReviewer(actor: ActorContext, requesterId: string, what: string) {
  if (actor.technician) throw new ForbiddenException('Switch back to your own account context to review requests');
  if (actor.userId === requesterId) {
    throw new ForbiddenException({ code: 'NOT_INDEPENDENT', message: `You cannot approve your own ${what}. Another reviewer must decide it.` });
  }
  const reviewer = actor.isPlatformAdmin || (actor.platformPermissions ?? []).includes('approvals:review');
  if (!reviewer) throw new ForbiddenException({ code: 'NOT_A_REVIEWER', message: `Approving a ${what} needs a Platform Admin or a designated independent reviewer.` });
}

/**
 * Fresh authentication: a recent step-up (password, authenticator code or
 * passkey) on top of the signed-in session.
 *
 * `action` is the function's key in the confirm catalog (confirm-catalog.ts),
 * required at every site; the console's dialog words its prompt from it.
 * 0.49: the check is skipped only when `confirmRequired(action)` is false —
 * the key is configurable, the policy has been read, and a Platform Admin set
 * it to `off`. An unknown key, an always-ask key or an unread policy asks. A
 * phishing-resistant check (a protected-device exception) always asks,
 * whatever the policy says.
 */
export function assertFresh(method: string | null, opts: { action: StepUpKey; phishingResistant?: boolean; message?: string }) {
  if (!opts.phishingResistant && !confirmRequired(opts.action)) return;
  if (!method) {
    throw new ForbiddenException({
      code: 'STEP_UP_REQUIRED', action: opts.action,
      message: opts.message ?? 'Confirm it is you to continue: re-enter your password, an authenticator code, or use a passkey.',
    });
  }
  if (opts.phishingResistant && method !== 'passkey') {
    throw new ForbiddenException({ code: 'STEP_UP_REQUIRED', action: 'fresh.auth.passkey', message: 'This action needs a fresh passkey confirmation (password and authenticator codes are not accepted).' });
  }
}

// ── The confirm policy (0.49) ──────────────────────────────────────────────
// Fails closed: until ConfirmPolicyService has read the rows, everything asks.
// Only a configurable catalog key whose value is exactly 'off' skips.
const CONFIGURABLE: ReadonlySet<string> = new Set<string>(CONFIRM_KEYS);
const ALWAYS: ReadonlySet<string> = new Set<string>(ALWAYS_ASK_KEYS);
let confirmPolicy: ReadonlyMap<string, ConfirmValue> = new Map();
let confirmLoaded = false;

/**
 * Set by ConfirmPolicyService when it reads or changes the policy. Takes the
 * rows as read; anything that is not a configurable key with the value 'off'
 * is dropped, so it asks.
 */
export function setConfirmPolicy(rows: ReadonlyArray<{ key: unknown; value: unknown }>): void {
  const m = new Map<string, ConfirmValue>();
  for (const r of rows) {
    if (typeof r.key === 'string' && CONFIGURABLE.has(r.key) && !ALWAYS.has(r.key) && r.value === 'off') m.set(r.key, 'off');
  }
  confirmPolicy = m;
  confirmLoaded = true;
}

/** Whether a function must ask "confirm it is you": true until the policy is read, and for any key that is not configurable. */
export function confirmRequired(key: string): boolean {
  if (!confirmLoaded) return true;
  if (ALWAYS.has(key) || !CONFIGURABLE.has(key)) return true;
  return confirmPolicy.get(key) !== 'off';
}

/** The effective value of every configurable key, for the view. */
export function confirmValues(): Record<ConfirmKey, ConfirmValue> {
  const out = {} as Record<ConfirmKey, ConfirmValue>;
  for (const k of CONFIRM_KEYS) out[k] = confirmRequired(k) ? 'ask' : 'off';
  return out;
}

/** For tests: forget what was read, so everything asks again. */
export function resetConfirmPolicy(): void {
  confirmPolicy = new Map();
  confirmLoaded = false;
}
