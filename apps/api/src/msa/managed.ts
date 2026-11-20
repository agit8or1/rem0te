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
 * The ceiling every managed computer has in 0.72: view-only, nothing beyond.
 * The agent compiles in the same constant (enforce.Ceiling) and refuses a
 * grant above it (mode_not_allowed / permission_not_allowed); the portal
 * refuses to issue one to a managed computer first (MSA_ABOVE_CEILING).
 * It is not configurable: a portal-supplied ceiling would be a portal
 * asking itself for permission. A signed, per-computer ceiling is step 5.
 */
export const MANAGED_CEILING: { mode: GrantMode; permissions: GrantPermissions } = {
  mode: 'view',
  permissions: { clipboard: false, files: false, audio: false, tunnel: false, restart: false },
};

/** The keys the agent sets (and saves first, and restores on rollback): exactly the preflight's eleven. */
export const MANAGED_KEYS = PREFLIGHT_KEYS;
/** A failed readback may also name the password (it cannot be read back; RustDesk did not say Done). */
export const REPORT_KEYS = [...PREFLIGHT_KEYS, 'password'] as const;

/** What the agent reports, on POST /msa/agent/report with its device secret. */
export const REPORT_EVENTS = [
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
  'max_minutes', 'no_connection', 'disconnected', 'rollback', 'superseded', 'not_enabled', 'stop_failed',
] as const;

const EVENT_NEEDS_GRANT: ReadonlySet<ReportEvent> = new Set(['applied', 'failed', 'connected', 'ended']);

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
  'This computer is in Managed Secure Access: its RustDesk password is one nobody is told. Connecting to a managed computer is the next build step; until then roll it back to Legacy to connect.';
