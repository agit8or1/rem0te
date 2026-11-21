/**
 * Accepted risks on Admin → Security (0.75.1). Pure: it imports only
 * node:crypto and posture's types.
 *
 * A Platform Admin may mark one finding Accepted, with a reason, so a
 * deliberate decision (SSH behind a hardware firewall, a single-disk host
 * with nowhere to export the audit log) stops reading as a warning. Three
 * rules keep that from becoming a way to hide problems:
 *
 *   1. Only a closed list of checks can be accepted (ACCEPTABLE_FINDINGS,
 *      the same list as migration 0093's CHECK). A few never can
 *      (NEVER_ACCEPTABLE): those must be fixed.
 *   2. An acceptance holds only while the evidence is what it was when it was
 *      accepted. Each finding carries a fingerprint of the facts it was
 *      decided on (its `basis`, never its wording or the time it was read);
 *      when the fingerprint moves (a new port, a different sshd value, a new
 *      vulnerable package) or the expiry passes, the acceptance lapses and
 *      the finding is a warning again.
 *   3. An accepted finding is never shown as passing. It keeps its status
 *      (fail or unknown), is listed under Accepted risks, is left out of the
 *      score's penalty and is counted as accepted.
 */
import { createHash } from 'node:crypto';
import type { Finding } from './posture';

/**
 * The checks a Platform Admin may accept, and nothing else (0093's CHECK
 * holds the same list; §84 compares them). Ids are fixed: a check whose id
 * carries a value (`web.tls.<domain>`, `process.switch.<name>`) is never here.
 */
export const ACCEPTABLE_FINDINGS = [
  'host.ssh.root_login', 'host.ssh.password_auth', 'host.ssh.x11',
  'host.firewall', 'network.listeners',
  'host.updates.security', 'host.updates.other', 'host.updates.lists', 'host.updates.unattended', 'host.reboot',
  'host.fail2ban', 'host.fail2ban.sshd_unit',
  'web.public_https', 'web.headers', 'web.http_redirect',
  'web.header.hsts', 'web.header.csp', 'web.header.framing', 'web.header.nosniff', 'web.header.referrer', 'web.header.permissions',
  'portal.mfa.users', 'portal.apikeys', 'portal.audit_export', 'portal.lockout', 'portal.unenforced_rules',
  'portal.signed_releases', 'portal.release_root_keys', 'portal.approval_signer',
  'deps.npm',
] as const;
export type AcceptableFinding = (typeof ACCEPTABLE_FINDINGS)[number];

/**
 * Findings that must be fixed, never accepted, and why. `prefix` matches a
 * family of ids. None of these is in ACCEPTABLE_FINDINGS (§84, and the unit
 * suite, check the two lists are disjoint).
 */
export const NEVER_ACCEPTABLE: ReadonlyArray<{ id: string; prefix?: true; why: string }> = [
  { id: 'portal.mfa.admins', why: 'A Platform Admin without MFA can do everything Rem0te can with one stolen password. Set one up; there is no circumstance this is the right trade.' },
  { id: 'portal.admins', why: 'A break-glass account without both an authenticator and a passkey breaks the rule break-glass exists under (§72). Add the missing factor.' },
  { id: 'portal.audit_chain', why: 'An audit chain that does not verify means entries were changed or lost. That is an incident to investigate, not a risk to accept.' },
  { id: 'host.ssh.empty_passwords', why: 'SSH accepting empty passwords is never deliberate on a server.' },
  { id: 'process.node_env', why: 'NODE_ENV=test admits loopback test endpoints and a host fixture. Production must run in production mode.' },
  { id: 'process.switch.', prefix: true, why: 'These off switches exist for test stacks; in production each one silently stops a safety job. Remove it from api.env.' },
  { id: 'web.tls', prefix: true, why: 'A certificate that is expired, untrusted or failing to renew breaks every agent and browser. Fix the renewal.' },
];

export function neverAcceptable(id: string): string | null {
  for (const n of NEVER_ACCEPTABLE) if (n.prefix ? id === n.id || id.startsWith(n.id) : id === n.id) return n.why;
  return null;
}
export function isAcceptable(id: string): id is AcceptableFinding {
  return (ACCEPTABLE_FINDINGS as readonly string[]).includes(id) && neverAcceptable(id) === null;
}

export const REASON_MIN = 3;
export const REASON_MAX = 300;
export const MAX_EXPIRY_DAYS = 365;

/** A reason, trimmed, 3–300 characters with no control characters; or null. */
export function cleanReason(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  // eslint-disable-next-line no-control-regex -- refusing control characters is the point
  if (t.length < REASON_MIN || t.length > REASON_MAX || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(t)) return null;
  return t;
}

/** The expiry for `days` from `now`: null for none, undefined when `days` is not 1–365 whole days. */
export function expiryFor(days: unknown, now: Date): Date | null | undefined {
  if (days === undefined || days === null) return null;
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > MAX_EXPIRY_DAYS) return undefined;
  return new Date(now.getTime() + days * 86_400_000);
}

/** Stable JSON: object keys sorted, so the same facts always hash the same. */
function canonical(v: unknown): string {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
}

/**
 * The fingerprint of a finding's evidence: its id, its status and its basis
 * (the facts it was decided on), or its evidence text when it names no basis.
 * The time it was read and its severity are not part of it.
 */
export function fingerprintOf(f: Pick<Finding, 'id' | 'status' | 'evidence'> & { basis?: unknown }): string {
  return createHash('sha256').update(canonical([f.id, f.status, f.basis === undefined ? { evidence: f.evidence } : f.basis])).digest('hex');
}

export interface AcceptanceRow {
  id: string;
  findingId: string;
  status: string;
  fingerprint: string;
  reason: string;
  evidence: string;
  acceptedById: string | null;
  acceptedAt: Date;
  expiresAt: Date | null;
}

export type ReopenCause = 'evidence_changed' | 'expired' | 'resolved' | 'unaccepted';
export const REOPEN_CAUSES: readonly ReopenCause[] = ['evidence_changed', 'expired', 'resolved', 'unaccepted'];

/**
 * Whether an acceptance still holds against this reading of its finding, and
 * if not, why. `finding` is undefined when this reading produced no finding
 * with that id (the check no longer applies, which is `resolved`).
 */
export function acceptanceStanding(row: AcceptanceRow, finding: (Finding & { fingerprint: string }) | undefined, now: Date): 'holds' | Exclude<ReopenCause, 'unaccepted'> {
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) return 'expired';
  if (!finding || finding.status === 'pass' || finding.status === 'info') return 'resolved';
  if (finding.fingerprint !== row.fingerprint) return 'evidence_changed';
  return 'holds';
}
