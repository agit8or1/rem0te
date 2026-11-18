import { ForbiddenException } from '@nestjs/common';
import type { ActorContext } from '../rbac/access-control.service';
import { ALWAYS_ASK_KEYS, CONFIRM_CATALOG, CONFIRM_KEYS, type ConfirmKey, type ConfirmValue, type StepUpKey } from './confirm-catalog';

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
 * the key is configurable, the policy has been read, and the key is `off`:
 * its row says exactly `off`, or (0.64) it has no row and its catalog default
 * is `off`. An unknown key, an always-ask key or an unread policy asks. A
 * phishing-resistant check (a protected-device exception) always asks,
 * whatever the policy says.
 *
 * 0.59: a phishing-resistant check accepts a Rem0te passkey, or `sso-passkey`
 * — which the SSO step-up issues only from a provider with `trustIdpPasskey`
 * whose acr and amr both say passkey (sso/identity-policy.ts stepUpMethod).
 * `sso-mfa` is an ordinary step-up, like a TOTP code.
 */
export const PHISHING_RESISTANT_METHODS: ReadonlySet<string> = new Set(['passkey', 'sso-passkey']);
export function assertFresh(method: string | null, opts: { action: StepUpKey; phishingResistant?: boolean; message?: string }) {
  if (!opts.phishingResistant && !confirmRequired(opts.action)) return;
  if (!method) {
    throw new ForbiddenException({
      code: 'STEP_UP_REQUIRED', action: opts.action,
      message: opts.message ?? 'Confirm it is you to continue: re-enter your password, an authenticator code, or use a passkey.',
    });
  }
  if (opts.phishingResistant && !PHISHING_RESISTANT_METHODS.has(method)) {
    throw new ForbiddenException({ code: 'STEP_UP_REQUIRED', action: 'fresh.auth.passkey', message: 'This action needs a fresh passkey confirmation (password and authenticator codes are not accepted).' });
  }
}

// ── The confirm policy (0.49) ──────────────────────────────────────────────
// Fails closed: until ConfirmPolicyService has read the rows, everything asks.
// A configurable catalog key skips when its row says exactly 'off'; a row
// saying anything else asks. 0.64: a key with no row takes its catalog
// default, which is 'off' for every key (the owner's "just on login").
const CONFIGURABLE: ReadonlySet<string> = new Set<string>(CONFIRM_KEYS);
const ALWAYS: ReadonlySet<string> = new Set<string>(ALWAYS_ASK_KEYS);
const DEFAULTS: ReadonlyMap<string, ConfirmValue> = new Map<string, ConfirmValue>(CONFIRM_CATALOG.map((f) => [f.key, f.default]));
let confirmPolicy: ReadonlyMap<string, ConfirmValue> = new Map();
let confirmLoaded = false;

/**
 * Set by ConfirmPolicyService when it reads or changes the policy. Takes the
 * rows as read; a row that is not a configurable key is dropped, and a
 * configurable key's row is 'off' only when its value is exactly 'off' —
 * any other value asks.
 */
export function setConfirmPolicy(rows: ReadonlyArray<{ key: unknown; value: unknown }>): void {
  const m = new Map<string, ConfirmValue>();
  for (const r of rows) {
    if (typeof r.key === 'string' && CONFIGURABLE.has(r.key) && !ALWAYS.has(r.key)) m.set(r.key, r.value === 'off' ? 'off' : 'ask');
  }
  confirmPolicy = m;
  confirmLoaded = true;
}

/**
 * Whether a function must ask "confirm it is you": true until the policy is
 * read, and for any key that is not configurable; otherwise its row, or with
 * no row its catalog default (0.64: off).
 */
export function confirmRequired(key: string): boolean {
  if (!confirmLoaded) return true;
  if (ALWAYS.has(key) || !CONFIGURABLE.has(key)) return true;
  return (confirmPolicy.get(key) ?? DEFAULTS.get(key) ?? 'ask') !== 'off';
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
