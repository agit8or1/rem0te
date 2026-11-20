/**
 * Managed Secure Access, build step 4 (0.72): the closed vocabulary the
 * portal and the signed agent share for cutover, enforcement, the managed
 * test session and rollback (docs/managed-secure-access.md §3.3, §3.7,
 * §3.11). Pure: zod and two pure sibling modules only.
 *
 * The agent's side is tools/windows-installer/internal/msa/enforce: the same
 * key list (msa/preflight.ts PREFLIGHT_KEYS, Go msa.Keys), the same ceiling,
 * the same report events and outcome codes. check-security-invariants §82
 * compares them.
 */
import { z } from 'zod';
import { GRANT_ID_RE, type GrantMode, type GrantPermissions } from './grant';
import { PREFLIGHT_KEYS } from './preflight';

/** A managed computer's state. No row is Legacy. */
export const MANAGED_STATES = ['pending', 'verified', 'enforcement_failure', 'rollback_pending'] as const;
export type ManagedState = (typeof MANAGED_STATES)[number];

/**
 * The ceiling every managed computer has (0.73; 0.72's was view-only):
 * interactive control with clipboard, file transfer and audio — never a TCP
 * tunnel and never a remote restart. COMPILED INTO THE SIGNED AGENT
 * (enforce.Ceiling), so widening it takes a signed agent release, which the
 * portal cannot make: a portal-supplied or portal-signed ceiling would be the
 * portal asking itself. The portal refuses a grant above it first
 * (MSA_ABOVE_CEILING) and the agent refuses one anyway (mode_not_allowed /
 * permission_not_allowed).
 *
 *   - tunnel: RustDesk's TCP tunnel reaches the customer's network beyond the
 *     desktop — not desktop support, and invisible to the person watching;
 *   - restart: a remote restart drops RustDesk and the session with it, and
 *     the agent's own bookkeeping is what ends a grant.
 *
 * Within it, each grant's mode and permissions come from the launch policy
 * (msa/connect-terms.ts), never from what a technician sends.
 */
export const MANAGED_CEILING: { mode: GrantMode; permissions: GrantPermissions } = {
  mode: 'control',
  permissions: { clipboard: true, files: true, audio: true, tunnel: false, restart: false },
};

/** The keys the agent sets (and saves first, and restores on rollback): exactly the preflight's eleven. */
export const MANAGED_KEYS = PREFLIGHT_KEYS;
/** A failed readback may also name the password (it cannot be read back; RustDesk did not say Done). */
export const REPORT_KEYS = [...PREFLIGHT_KEYS, 'password'] as const;

/** What the agent reports, on POST /msa/agent/report with its device secret. */
export const REPORT_EVENTS = [
  'received', // 0.73: the grant verified on the computer, before anything was applied
  'applied', // every setting read back, then the one-time password set
  'failed', // the grant was refused, or applying it failed (outcome says why)
  'connected', // a RustDesk connection manager (`rustdesk.exe --cm`) appeared while applied
  'ended', // the session ended: a password nobody is told, stop-service Y then N
  'drift', // a managed setting changed while no session was open
  'checked', // between sessions: every managed setting still reads back as last applied
  'secured', // after verification: the legacy permanent password replaced by one nobody is told
  'restored', // rollback: every saved setting put back and read back
  'restore_failed', // rollback: a saved setting did not read back
] as const;
export type ReportEvent = (typeof REPORT_EVENTS)[number];

/**
 * Closed outcome codes. A refusal by the verifier is its reason code
 * (grant.ts REASONS); the rest are the agent's.
 */
export const AGENT_OUTCOMES = [
  'readback_mismatch', 'password_not_applied', 'save_failed', 'rustdesk_not_ready', 'no_keys',
  'max_minutes', 'no_connection', 'disconnected', 'rollback', 'superseded', 'not_enabled', 'stop_failed', 'revoked', 'paused',
] as const;

const EVENT_NEEDS_GRANT: ReadonlySet<ReportEvent> = new Set(['received', 'applied', 'failed', 'connected', 'ended']);

export const ReportBody = z.strictObject({
  rustdeskId: z.string().regex(/^[0-9]{6,15}$/),
  agentSecret: z.string().min(16).max(128),
  event: z.enum(REPORT_EVENTS),
  grantId: z.string().regex(GRANT_ID_RE).optional(),
  outcome: z.string().regex(/^[a-z_]{1,40}$/).optional(),
  keys: z.array(z.enum(REPORT_KEYS)).max(REPORT_KEYS.length).optional(),
}).superRefine((b, ctx) => {
  if (EVENT_NEEDS_GRANT.has(b.event) !== (b.grantId !== undefined)) ctx.addIssue({ code: 'custom', message: 'grantId' });
});
export type Report = z.infer<typeof ReportBody>;

/** A grant to a managed computer may never exceed MANAGED_CEILING. */
export function withinCeiling(mode: GrantMode, permissions: GrantPermissions): boolean {
  if (mode === 'control' && MANAGED_CEILING.mode !== 'control') return false;
  return (Object.keys(permissions) as (keyof GrantPermissions)[]).every((k) => !permissions[k] || MANAGED_CEILING.permissions[k]);
}

/**
 * Whether the portal may hand this computer a staged legacy password
 * rotation now. A managed computer's RustDesk password is the agent's: a
 * rotation would put a password the portal knows back on it. Held while any
 * managed row exists, except Managed (pending) with no grant in flight,
 * where Legacy still works and the rotation re-establishes it after a test
 * session ended with a password nobody is told.
 */
export function rotationHeld(row: { state: ManagedState } | null, grantInFlight: boolean): boolean {
  if (!row) return false;
  return row.state !== 'pending' || grantInFlight;
}

/** Legacy Connect and password reveal are refused once a computer was verified (its password is one nobody is told). */
export function legacyRefused(row: { verifiedAt: Date | null } | null): boolean {
  return !!row?.verifiedAt;
}

export const LEGACY_REFUSED_MESSAGE =
  'This computer is in Managed Secure Access: its RustDesk password is one nobody is told, so there is no password to launch with. Press Connect on the computer\'s own page, which connects through a session grant while the server has Managed Secure Access on — or roll it back to Legacy to connect the ordinary way.';

// ── 0.73 (build step 5): sessions, revocation, cutover runs ─────────────────

/** Where a grant came from: a Platform Admin's test grant, a person's Connect, or a cutover run's verification. */
export const GRANT_SOURCES = ['test', 'connect', 'verify'] as const;
export type GrantSource = (typeof GRANT_SOURCES)[number];

/** Why grants were revoked (0090 CHECK). */
export const REVOKE_REASONS = ['session', 'technician', 'business', 'computer', 'pause', 'timeout'] as const;
export type RevokeReason = (typeof REVOKE_REASONS)[number];

/** A grant that is, or can still become, an open session. */
export const LIVE_GRANT_STATES = ['issued', 'delivered', 'applied'] as const;

/** How long Connect waits for the agent's `applied` before it gives up and revokes the grant. */
export const CONNECT_APPLY_TIMEOUT_MS = 60_000;
/** An agent counts as polling when it held or made a poll this recently. */
export const POLLING_FRESH_MS = 90_000;
/** The verification grant a cutover run sends each computer it moves: view-only, consent required, five minutes. */
export const VERIFY_GRANT_MINUTES = 5;

/** Cutover run states and scopes (0090 CHECKs). */
export const RUN_STATES = ['canary', 'rolling', 'complete', 'halted', 'rolled_back'] as const;
export type RunState = (typeof RUN_STATES)[number];
export const RUN_SCOPES = ['group', 'business'] as const;
export type RunScope = (typeof RUN_SCOPES)[number];
/** One advance moves at most this many computers. */
export const RUN_BATCH_MAX = 25;
export const RUN_BATCH_DEFAULT = 5;
/** A run covers at most this many computers. */
export const RUN_MEMBERS_MAX = 500;
/** An advance waits while a computer of the previous batch has had no readback, for up to this long. */
export const RUN_BATCH_SETTLE_MS = 60 * 60_000;

/**
 * Connect through a grant needs an agent that verifies revocations and
 * enforces the 0.73 ceiling: an 0.72 agent would refuse a control grant
 * (mode_not_allowed) and could not be told to end a session early.
 */
export const MIN_SESSION_AGENT = '0.73.0';
