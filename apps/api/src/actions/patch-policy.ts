import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '../integration/crypto';
import { APPROVALS_REQUIRED, MAX_RING_TARGETS, MAX_UPDATES_PER_PLAN, MAX_WINDOW_HOURS, UPDATE_ID_RE, UPDATE_INSTALL, type Plan } from './catalog';
import { CLASSIFICATIONS, idKey, updateState, type PostureLike, type TargetView, type UpdateState } from '../patching/posture';

/**
 * Patch policies (v0.32): automatic patching that people approve once.
 *
 * Shared, as code, by the portal and the approval signer, like catalog.ts.
 * Pure: no clock but the one passed in, no I/O, no Nest, no Prisma.
 *
 * Two people on the approval roster approve a *policy document*: one
 * business, the exact computers of each ring (bound to their enrolled
 * identity, not a hostname), the update classifications and severities it
 * may install, KBs it never installs, the soak time and failure threshold,
 * a weekly maintenance window in a named timezone, the reboot rule, and an
 * expiry at most 90 days out. After that the approval signer — not the portal
 * — signs each ring plan, but only if `evaluatePolicyPlan` finds it inside
 * that document. The portal proposes; the signer decides from the policy it
 * holds, its own ledger of what it already signed, and its own clock.
 *
 * What the signer can check itself, and so what a compromised portal cannot
 * widen: the computers (identity-bound subset of the ring), the update
 * filter (carried into the plan's params, which the agent applies to Windows
 * Update's own answer), the window, the expiry, revocation, ring order (from
 * its own ledger: ring N only after it signed ring N-1 of the same
 * deployment), the updates (each ring a subset of the ring before it), and
 * the retry limit.
 *
 * What it cannot authenticate: the previous ring's results. Agents do not sign
 * their results, so the canary's evidence reaches the signer through the
 * portal. The signer re-runs the gate (`evaluateRingGate`, the same function
 * the portal uses) over that evidence and refuses unless it says passed —
 * including the canary being *effective* — but a portal that fabricates a
 * whole canary result can get ring 1 signed early. It still cannot add a
 * computer, an update, a class or an hour to it.
 */

/** Installable classification ids and their names, re-exported for the signer's pages. */
export { CLASSIFICATIONS };

export const POLICY_SCHEMA = 'rem0te-patch-policy/1';
/** Domain separation for a policy's digest and for the signer's signature over an approved policy. */
export const POLICY_DIGEST_PREFIX = 'rem0te-patch-policy-v1\n';
export const POLICY_SIGNING_PREFIX = 'rem0te-patch-policy-approved-v1\n';
export const MAX_POLICY_DAYS = 90;
export const MAX_POLICY_RINGS = 5;
/** How long a proposed policy waits for its approvals before it lapses. */
export const POLICY_PROPOSAL_DAYS = 7;
/** Times one ring of one deployment may be signed under a policy (the first and two retries). */
export const MAX_RING_ATTEMPTS = 3;
/** The signer accepts evidence and plans this many minutes behind its clock. */
const CLOCK_SKEW_MS = 5 * 60_000;

export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export const SEVERITIES = ['Critical', 'Important', 'Moderate', 'Low', 'Unrated'] as const;

const Id = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
const Hex32 = z.string().regex(/^[a-f0-9]{32}$/);
const Hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const Iso = z.string().datetime();
const Hhmm = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/);
const Kb = z.string().regex(/^KB[0-9]{4,10}$/);

/** One computer, as enrolled: the identity the agent checks, so a renamed or re-enrolled computer is a different one. */
export const PolicyComputer = z.object({
  endpointId: Id,
  hostname: z.string().max(64),
  rustdeskId: z.string().regex(/^[0-9]{6,15}$/),
  deviceSecretSha256: Hex64,
}).strict();

export const PolicyWindow = z.object({
  days: z.array(z.enum(WEEKDAYS)).min(1).max(7).refine((d) => new Set(d).size === d.length, 'a day is listed twice'),
  /** Local wall-clock time in `timezone`. An end at or before the start ends on the next day. */
  start: Hhmm,
  end: Hhmm,
  timezone: z.string().min(1).max(64).refine(validTimezone, 'not a timezone this runtime knows (IANA name, e.g. America/Chicago)'),
}).strict().refine((w) => w.start !== w.end, 'the window must not be empty');
export type PolicyWindow = z.infer<typeof PolicyWindow>;

export const PolicyAllow = z.object({
  /** Windows Update classification ids; a subset of what any plan may install. */
  classifications: z.array(z.string().refine((c) => !!CLASSIFICATIONS[c], 'not an installable classification')).min(1).max(4)
    .refine((c) => new Set(c).size === c.length, 'a classification is listed twice'),
  severities: z.array(z.enum(SEVERITIES)).min(1).max(5).refine((s) => new Set(s).size === s.length, 'a severity is listed twice').optional(),
  excludeKbs: z.array(Kb).min(1).max(50).refine((s) => new Set(s).size === s.length, 'a KB is listed twice').optional(),
}).strict();
export type PolicyAllow = z.infer<typeof PolicyAllow>;

/** The document two approvers sign. Every field binds the signer. */
export const PolicyDoc = z.object({
  schema: z.literal(POLICY_SCHEMA),
  policyId: Hex32,
  name: z.string().min(3).max(120),
  businessId: Id,
  businessName: z.string().max(120),
  /** Ring 0 is the canary: exactly one computer. Later rings up to MAX_RING_TARGETS each. */
  rings: z.array(z.array(PolicyComputer).min(1).max(MAX_RING_TARGETS)).min(1).max(MAX_POLICY_RINGS),
  allow: PolicyAllow,
  soakHours: z.number().int().min(0).max(168),
  failureThreshold: z.number().int().min(0).max(MAX_RING_TARGETS),
  window: PolicyWindow,
  /** 0.32 never restarts a computer. A later reboot rule is a §15 change to the agent's closed params. */
  reboot: z.literal('never'),
  createdAt: Iso,
  expiresAt: Iso,
  createdBy: z.object({ userId: Id, name: z.string().max(120) }).strict(),
  reason: z.string().min(3).max(500),
}).strict();
export type PolicyDoc = z.infer<typeof PolicyDoc>;

export function policyDigest(doc: PolicyDoc): string {
  return createHash('sha256').update(POLICY_DIGEST_PREFIX).update(canonicalJson(doc)).digest('hex');
}

/** The bytes the signer signs when a policy reaches its quorum: the document and who approved it. */
export function policySigningBytes(doc: PolicyDoc, approvals: PolicyApproval[]): Buffer {
  return Buffer.from(POLICY_SIGNING_PREFIX + canonicalJson({ digest: policyDigest(doc), approvals }), 'utf8');
}

export interface PolicyApproval { userId: string; name: string; role: 'approver' | 'customer'; credentialSha256: string; at: string }

/** Rules a schema cannot say. Checked by the portal before it proposes, and by the signer before it accepts. */
export function validatePolicyDoc(doc: PolicyDoc, now: Date): { ok: true } | { ok: false; reason: string; message: string } {
  if (doc.rings[0].length !== 1) return { ok: false, reason: 'bad_rings', message: 'Ring 0 is the canary: exactly one computer.' };
  const all = doc.rings.flat();
  if (new Set(all.map((c) => c.endpointId)).size !== all.length || new Set(all.map((c) => c.rustdeskId)).size !== all.length) {
    return { ok: false, reason: 'bad_rings', message: 'A computer can be in one ring only.' };
  }
  const exp = Date.parse(doc.expiresAt), created = Date.parse(doc.createdAt);
  if (!(exp > now.getTime())) return { ok: false, reason: 'policy_expired', message: 'The expiry is in the past.' };
  const most = MAX_POLICY_DAYS * 86_400_000 + CLOCK_SKEW_MS;
  if (exp - now.getTime() > most || exp - created > most) {
    return { ok: false, reason: 'expiry_too_far', message: `A policy expires at most ${MAX_POLICY_DAYS} days after it is proposed; then it is approved again.` };
  }
  if (created > now.getTime() + CLOCK_SKEW_MS) return { ok: false, reason: 'bad_created', message: 'The policy is dated in the future.' };
  if (!nextOccurrence(now, doc.window, new Date(exp))) return { ok: false, reason: 'window_never_opens', message: 'The maintenance window never opens before the policy expires.' };
  return { ok: true };
}

/** What a plan's params carry so the agent applies the policy's filter itself. Canonical: same document, same object. */
export function allowParams(a: PolicyAllow): Record<string, string[]> {
  return {
    classifications: [...a.classifications].sort(),
    ...(a.severities ? { severities: [...a.severities].sort() } : {}),
    ...(a.excludeKbs ? { excludeKbs: [...a.excludeKbs].sort() } : {}),
  };
}

/** Would this policy install this update, judged from what is known about it? (The agent re-decides from Windows Update.) */
export function policyAllowsUpdate(a: PolicyAllow, u: { classification?: string | null; className?: string | null; severity?: string | null; kb?: string | null }): { ok: true } | { ok: false; reason: 'class_not_allowed' | 'severity_not_allowed' | 'kb_excluded' } {
  const names = a.classifications.map((c) => CLASSIFICATIONS[c]);
  const classOk = u.classification ? a.classifications.includes(u.classification) : !!u.className && names.includes(u.className);
  if (!classOk) return { ok: false, reason: 'class_not_allowed' };
  if (a.severities && !a.severities.includes((u.severity || 'Unrated') as (typeof SEVERITIES)[number])) return { ok: false, reason: 'severity_not_allowed' };
  if (a.excludeKbs && u.kb && a.excludeKbs.includes(u.kb)) return { ok: false, reason: 'kb_excluded' };
  return { ok: true };
}

// ── Time ────────────────────────────────────────────────────────────────────
// A window is wall-clock time in a named zone, so "Saturday 22:00–04:00
// America/Chicago" means that in July and in January. The arithmetic goes
// through the runtime's own zone data (ICU), never a fixed offset.

export function validTimezone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return /^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(tz); } catch { return false; }
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    fmtCache.set(tz, f);
  }
  return f;
}

export interface LocalTime { y: number; m: number; d: number; hh: number; mm: number; weekday: Weekday }

/** The wall-clock time in `tz` at instant `t`. */
export function localTime(t: Date, tz: string): LocalTime {
  const p = Object.fromEntries(fmt(tz).formatToParts(t).filter((x) => x.type !== 'literal').map((x) => [x.type, Number(x.value)]));
  const y = p.year, m = p.month, d = p.day;
  return { y, m, d, hh: p.hour, mm: p.minute, weekday: WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] };
}

/** The zone's offset from UTC at instant t, in ms (local − UTC), to the minute. */
function offsetAt(t: number, tz: string): number {
  const tm = Math.floor(t / 60_000) * 60_000;
  const l = localTime(new Date(tm), tz);
  return Date.UTC(l.y, l.m - 1, l.d, l.hh, l.mm) - tm;
}

/**
 * The instant at which `tz` shows this wall-clock time. In the hour a DST
 * change repeats, the earlier of the two instants. In the hour it skips, the
 * time does not exist; the instant is where that time would have fallen on
 * the old offset, which the new clock reads as an hour later (02:30 on a
 * spring-forward night is 03:30).
 */
export function zonedToUtc(y: number, m: number, d: number, hh: number, mm: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  // A day either side brackets any transition; the offsets in force then,
  // and at the guess itself, are every offset this wall time could carry.
  const before = offsetAt(guess - 86_400_000, tz), after = offsetAt(guess + 86_400_000, tz);
  const offsets = [...new Set([before, after, offsetAt(guess, tz), offsetAt(guess - before, tz), offsetAt(guess - after, tz)])];
  const want = (t: number) => { const l = localTime(new Date(t), tz); return l.y === y && l.m === m && l.d === d && l.hh === hh && l.mm === mm; };
  const hits = offsets.map((o) => guess - o).filter(want).sort((a, b) => a - b);
  return new Date(hits.length ? hits[0] : guess - before);
}

const addDays = (y: number, m: number, d: number, n: number) => { const t = new Date(Date.UTC(y, m - 1, d + n)); return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }; };
const hm = (s: string) => s.split(':').map(Number) as [number, number];

/** The occurrence of the window that begins on this local date, if the date's weekday is one of its days. */
function occurrenceOn(date: { y: number; m: number; d: number }, w: PolicyWindow): { start: Date; end: Date } | null {
  const wd = WEEKDAYS[new Date(Date.UTC(date.y, date.m - 1, date.d)).getUTCDay()];
  if (!w.days.includes(wd)) return null;
  const [sh, sm] = hm(w.start), [eh, em] = hm(w.end);
  const start = zonedToUtc(date.y, date.m, date.d, sh, sm, w.timezone);
  const crosses = eh * 60 + em <= sh * 60 + sm;
  const ed = crosses ? addDays(date.y, date.m, date.d, 1) : date;
  const end = zonedToUtc(ed.y, ed.m, ed.d, eh, em, w.timezone);
  return end > start ? { start, end } : null;
}

/** The occurrence of the window that contains instant t, or null. */
export function occurrenceAt(t: Date, w: PolicyWindow): { start: Date; end: Date } | null {
  const l = localTime(t, w.timezone);
  for (const n of [-1, 0]) {
    const o = occurrenceOn(addDays(l.y, l.m, l.d, n), w);
    if (o && o.start <= t && t < o.end) return o;
  }
  return null;
}

/** The first occurrence that has not ended by `after` (it may already be open), before `until` if given. */
export function nextOccurrence(after: Date, w: PolicyWindow, until?: Date): { start: Date; end: Date } | null {
  const l = localTime(after, w.timezone);
  for (let n = -1; n <= 8; n++) {
    const o = occurrenceOn(addDays(l.y, l.m, l.d, n), w);
    if (!o || o.end <= after) continue;
    if (until && o.start >= until) return null;
    return o;
  }
  return null;
}

// ── The ring gate ───────────────────────────────────────────────────────────
// One rule, used by the portal to decide what it may request and by the
// signer to decide whether a policy plan for the next ring may be signed.

export const FAILED_STATES: UpdateState[] = ['failed', 'unknown', 'refused', 'not_executed'];
/** The canary's proof: each update took effect, or genuinely did not apply to it. */
export const CANARY_OK: UpdateState[] = ['effective', 'superseded', 'not_applicable', 'excluded'];

export interface Gate { ok: boolean; reason: string; detail: string; until?: string }
export interface GateTarget {
  endpointId: string;
  status: string; statusReason: string | null;
  reconciled: boolean; reconcileNote: string | null;
  resultAt: Date | null;
  result: TargetView['result'];
  scan: PostureLike | null;
}
export interface GateInput {
  ring: number;
  jobStatus: string | null;
  targets: GateTarget[];
  updates: { updateId: string; revision: number }[];
  failureThreshold: number;
  soakHours: number;
}

export function targetStates(updates: GateInput['updates'], t: GateTarget | null, jobStatus: string) {
  const tv: TargetView | null = t ? { status: t.status, statusReason: t.statusReason, jobStatus, result: t.result, resultAt: t.resultAt, reconciledNote: t.reconcileNote } : null;
  return updates.map((u) => ({ key: idKey(u), ...updateState(u, tv, t?.scan ?? null) }));
}

/** May the ring after `ring` be requested? */
export function evaluateRingGate(g: GateInput, now: Date): Gate {
  const ring = g.ring;
  if (!g.jobStatus) return { ok: false, reason: 'not_requested', detail: `Ring ${ring} has not been requested.` };
  if (['AWAITING_APPROVAL', 'APPROVED', 'DISPATCHED'].includes(g.jobStatus)) return { ok: false, reason: 'in_progress', detail: `Ring ${ring} is ${g.jobStatus.toLowerCase().replace(/_/g, ' ')}.` };
  if (['REJECTED', 'CANCELED', 'EXPIRED'].includes(g.jobStatus)) return { ok: false, reason: 'ring_not_run', detail: `Ring ${ring}'s plan was ${g.jobStatus.toLowerCase()}; request it again.` };
  if (g.targets.some((t) => t.status === 'UNKNOWN' && !t.reconciled)) return { ok: false, reason: 'unreconciled', detail: `A computer in ring ${ring} has an uncertain outcome. Reconcile it first.` };
  if (g.targets.some((t) => t.status === 'PENDING' || t.status === 'DISPATCHED')) return { ok: false, reason: 'in_progress', detail: `A computer in ring ${ring} has not answered yet.` };
  const computers = g.targets.filter((t) => t.status !== 'CANCELED');
  if (computers.length === 0) return { ok: false, reason: 'ring_not_run', detail: `No computer in ring ${ring} was reached.` };
  const failed = computers.filter((t) => t.status !== 'SUCCEEDED' || targetStates(g.updates, t, g.jobStatus!).some((s) => FAILED_STATES.includes(s.state)));
  if (failed.length > g.failureThreshold) return { ok: false, reason: 'too_many_failures', detail: `${failed.length} computer(s) in ring ${ring} failed; the threshold is ${g.failureThreshold}.` };
  if (ring === 0) {
    const states = targetStates(g.updates, computers[0], g.jobStatus);
    const pending = states.filter((s) => !CANARY_OK.includes(s.state));
    if (pending.length) return { ok: false, reason: 'canary_not_effective', detail: `The canary has not confirmed ${pending.length} update(s) took effect (${[...new Set(pending.map((s) => s.state.replace(/_/g, ' ')))].join(', ')}). Restart it if it needs one, and let it scan again.` };
    if (!states.some((s) => s.state === 'effective')) return { ok: false, reason: 'canary_proved_nothing', detail: 'None of these updates applied to the canary, so it proves nothing. Choose a canary that is offered them.' };
  }
  const last = computers.map((t) => t.resultAt?.getTime() ?? 0).reduce((a, b) => Math.max(a, b), 0);
  const until = last + g.soakHours * 3_600_000;
  if (now.getTime() < until) return { ok: false, reason: 'soaking', detail: `Soaking until ${new Date(until).toISOString()}.`, until: new Date(until).toISOString() };
  return { ok: true, reason: 'passed', detail: `Ring ${ring} passed.` };
}

// ── Evidence: what the portal relays about the previous ring ────────────────

const UpdKey = z.string().regex(/^[0-9a-f-]{36}@[0-9]{1,7}$/);
export const EvidenceTarget = z.object({
  endpointId: Id,
  status: z.enum(['PENDING', 'DISPATCHED', 'SUCCEEDED', 'FAILED', 'REFUSED_BY_ENDPOINT', 'NOT_EXECUTED', 'UNKNOWN', 'CANCELED']),
  statusReason: z.string().max(200).nullable(),
  reconciled: z.boolean(),
  resultAt: Iso.nullable(),
  result: z.object({
    outcome: z.string().max(40).optional(), reason: z.string().max(200).optional(),
    updates: z.array(z.object({ updateId: z.string().regex(UPDATE_ID_RE), revision: z.number().int(), state: z.string().max(40), reason: z.string().max(200).optional(), hresult: z.string().max(12).optional() }).strict()).max(MAX_UPDATES_PER_PLAN).optional(),
  }).strict().nullable(),
  /** The computer's latest scan, reduced to the plan's updates. */
  scan: z.object({
    scannedAt: Iso, error: z.boolean(), rebootPending: z.boolean(),
    offered: z.array(UpdKey).max(MAX_UPDATES_PER_PLAN), installed: z.array(UpdKey).max(MAX_UPDATES_PER_PLAN),
  }).strict().nullable(),
}).strict();
export const RingEvidence = z.object({
  previousJobId: Hex32,
  jobStatus: z.string().max(40),
  targets: z.array(EvidenceTarget).max(MAX_RING_TARGETS),
}).strict();
export type RingEvidence = z.infer<typeof RingEvidence>;

/** Reduce a gate target to what the signer needs about these updates. */
export function toEvidenceTarget(t: GateTarget, updates: { updateId: string; revision: number }[]): z.infer<typeof EvidenceTarget> {
  const keys = new Set(updates.map(idKey));
  const s = t.scan;
  return {
    endpointId: t.endpointId, status: t.status as z.infer<typeof EvidenceTarget>['status'], statusReason: t.statusReason?.slice(0, 200) ?? null,
    reconciled: t.reconciled, resultAt: t.resultAt ? t.resultAt.toISOString() : null,
    result: t.result ? {
      ...(t.result.outcome ? { outcome: t.result.outcome } : {}), ...(t.result.reason ? { reason: t.result.reason.slice(0, 200) } : {}),
      ...(t.result.updates ? { updates: t.result.updates.filter((u) => keys.has(idKey(u))).map((u) => ({ updateId: u.updateId, revision: u.revision, state: u.state, ...(u.reason ? { reason: u.reason.slice(0, 200) } : {}), ...(u.hresult ? { hresult: u.hresult } : {}) })) } : {}),
    } : null,
    scan: s ? {
      scannedAt: new Date(s.scannedAt).toISOString(), error: !!s.error, rebootPending: s.reboot.pending,
      offered: s.updates.map(idKey).filter((k) => keys.has(k)),
      installed: [...new Set(s.history.filter((h) => h.operation === 'install' && h.result === 'succeeded').map(idKey).filter((k) => keys.has(k)))],
    } : null,
  };
}

/** Rebuild a gate target from relayed evidence (the signer's side). */
export function fromEvidenceTarget(e: z.infer<typeof EvidenceTarget>): GateTarget {
  const split = (k: string) => { const [updateId, rev] = k.split('@'); return { updateId, revision: Number(rev) }; };
  return {
    endpointId: e.endpointId, status: e.status, statusReason: e.statusReason, reconciled: e.reconciled, reconcileNote: null,
    resultAt: e.resultAt ? new Date(e.resultAt) : null, result: e.result,
    scan: e.scan ? {
      scannedAt: e.scan.scannedAt, error: e.scan.error ? 'reported' : undefined, reboot: { pending: e.scan.rebootPending },
      updates: e.scan.offered.map(split),
      history: e.scan.installed.map((k) => ({ ...split(k), operation: 'install', result: 'succeeded' })),
    } : null,
  };
}

// ── The signer's decision ───────────────────────────────────────────────────

export type PolicyStatus = 'AWAITING_APPROVAL' | 'ACTIVE' | 'REJECTED' | 'REVOKED' | 'EXPIRED';
/** One plan the signer signed under a policy: its ledger, kept on the signer's own disk. */
export interface LedgerEntry { jobId: string; deploymentId: string; ring: number; signedAt: string; notBefore: string; notAfter: string; endpointIds: string[]; updates: string[] }
export interface PolicyState {
  doc: PolicyDoc;
  digest: string;
  status: PolicyStatus;
  approvals: PolicyApproval[];
  /** Did this signer's signature over (doc, approvals) verify? Computed by the signer with its own key. */
  signatureValid: boolean;
  revokedAt: string | null;
  ledger: LedgerEntry[];
}
export interface PolicyPlanRequest { plan: Plan; policyDigest: string; evidence: RingEvidence | null }
export type PolicyDecision = { ok: true } | { ok: false; code: string; message: string };

const no = (code: string, message: string): PolicyDecision => ({ ok: false, code, message });

/** The quorum a policy needs: two distinct approvers who are not its author, and a customer sign-off when the business requires one. */
export function policyQuorum(doc: PolicyDoc, approvals: PolicyApproval[], customerSignoff: boolean): boolean {
  const approvers = new Set(approvals.filter((a) => a.role === 'approver' && a.userId !== doc.createdBy.userId).map((a) => a.userId));
  if (approvers.size < APPROVALS_REQUIRED.high) return false;
  if (customerSignoff && !approvals.some((a) => a.role === 'customer' && a.userId !== doc.createdBy.userId && !approvers.has(a.userId))) return false;
  return true;
}

/**
 * Is this plan inside the policy? Every refusal is a distinct code, because
 * each is a different thing a compromised portal might try.
 */
export function evaluatePolicyPlan(s: PolicyState, r: PolicyPlanRequest, opts: { now: Date; customerSignoff: boolean }): PolicyDecision {
  const { doc } = s, p = r.plan, now = opts.now;
  // The policy itself.
  if (s.revokedAt || s.status === 'REVOKED') return no('policy_revoked', 'This policy was revoked; nothing more is signed under it.');
  if (!s.signatureValid) return no('policy_signature_invalid', 'The stored policy does not verify against this signer\'s key.');
  if (policyDigest(doc) !== s.digest || r.policyDigest !== s.digest) return no('policy_digest_mismatch', 'The policy digest does not match the approved policy.');
  // Expiry is checked before status: an expired policy's status is EXPIRED, and the code should say why.
  if (now.getTime() >= Date.parse(doc.expiresAt)) return no('policy_expired', 'This policy has expired. Approve a new one.');
  if (s.status !== 'ACTIVE') return no('policy_not_active', `This policy is ${s.status.toLowerCase().replace(/_/g, ' ')}.`);
  if (!policyQuorum(doc, s.approvals, false)) return no('policy_not_approved', 'This policy does not carry two approvals from people other than its author.');
  if (!policyQuorum(doc, s.approvals, opts.customerSignoff)) return no('policy_mismatch', 'This business now requires customer sign-off, which this policy was not approved with. Approve a new policy.');
  if (Date.parse(p.window.notAfter) > Date.parse(doc.expiresAt)) return no('policy_expired', 'The plan would run past the policy\'s expiry.');

  // The action and what it installs.
  if (p.action.id !== UPDATE_INSTALL.id || p.action.version !== UPDATE_INSTALL.version) return no('action_not_in_policy', 'A patch policy signs Windows update installs only.');
  const params = p.params as { updates?: { updateId: string; revision: number }[]; reboot?: unknown; allow?: unknown };
  if (params.reboot !== doc.reboot) return no('reboot_not_allowed', 'The plan\'s reboot rule is not the policy\'s.');
  if (canonicalJson(params.allow ?? null) !== canonicalJson(allowParams(doc.allow))) return no('filter_mismatch', 'The plan must carry exactly the policy\'s update filter, so each computer applies it.');
  const updates = params.updates ?? [];
  const shown = p.display?.updates ?? [];
  if (shown.length !== updates.length || !updates.every((u) => shown.some((x) => idKey(x) === idKey(u)))) return no('bad_display', 'Every update in the plan must be shown, once.');
  for (const u of shown) {
    const a = policyAllowsUpdate(doc.allow, u);
    if (!a.ok) return no(a.reason, `${u.kb ?? u.title}: ${a.reason === 'class_not_allowed' ? `${u.className ?? 'unclassified'} is not a class this policy installs` : a.reason === 'severity_not_allowed' ? `severity ${u.severity || 'Unrated'} is not one this policy installs` : 'this KB is excluded by the policy'}.`);
  }
  if (p.display?.policy?.id !== doc.policyId || p.display.policy.digest !== s.digest) return no('bad_display', 'The plan must name this policy.');

  // Who and when.
  if (p.requestedBy.userId !== doc.createdBy.userId) return no('requester_mismatch', 'A policy plan is requested on behalf of the policy\'s author.');
  const nb = new Date(p.window.notBefore), na = new Date(p.window.notAfter);
  const occ = occurrenceAt(nb, doc.window);
  if (!occ || na > occ.end) return no('outside_window', `The plan must run inside the policy's maintenance window (${doc.window.days.join(', ')} ${doc.window.start}–${doc.window.end} ${doc.window.timezone}).`);
  if (nb.getTime() < now.getTime() - CLOCK_SKEW_MS) return no('outside_window', 'The plan starts in the past.');
  if (na.getTime() - nb.getTime() > MAX_WINDOW_HOURS * 3_600_000) return no('outside_window', 'A plan runs for at most 24 hours.');

  // Which ring, and which computers.
  const dep = p.display?.deployment;
  if (!dep || dep.rings !== doc.rings.length || dep.ring < 0 || dep.ring >= doc.rings.length) return no('ring_out_of_order', 'The plan names a ring this policy does not have.');
  const ring = dep.ring;
  const allowed = new Map(doc.rings[ring].map((c) => [c.endpointId, c]));
  for (const t of p.targets) {
    const c = allowed.get(t.endpointId);
    if (!c || t.businessId !== doc.businessId || t.rustdeskId !== c.rustdeskId || t.deviceSecretSha256 !== c.deviceSecretSha256) {
      return no('computer_not_in_policy', `${t.hostname} is not in ring ${ring} of this policy, or is not the computer that was approved (its enrolled identity differs).`);
    }
  }
  if (ring === 0 && p.targets.length !== 1) return no('computer_not_in_policy', 'Ring 0 is the canary alone.');

  // Ring order, from this signer's own ledger.
  const mine = s.ledger.filter((e) => e.deploymentId === dep.id);
  if (mine.some((e) => e.ring > ring)) return no('ring_out_of_order', `A later ring of this deployment is already signed; ring ${ring} is not signed again.`);
  const same = mine.filter((e) => e.ring === ring);
  if (same.some((e) => Date.parse(e.notAfter) > now.getTime())) return no('ring_already_signed', `Ring ${ring} of this deployment is already signed and its window is still open.`);
  if (same.length >= MAX_RING_ATTEMPTS) return no('ring_retry_limit', `Ring ${ring} has been signed ${same.length} times under this policy. Retry it as an ordinary deployment, with approvals.`);
  const keys = updates.map(idKey);
  if (ring === 0) {
    if (r.evidence) return no('bad_evidence', 'The canary needs no evidence.');
    return { ok: true };
  }
  const prev = mine.filter((e) => e.ring === ring - 1).sort((a, b) => a.signedAt.localeCompare(b.signedAt)).pop();
  if (!prev) return no('ring_out_of_order', `Ring ${ring} needs ring ${ring - 1} of the same deployment signed first. The canary cannot be skipped.`);
  if (!keys.every((k) => prev.updates.includes(k))) return no('updates_not_proven', `Every update in ring ${ring} must have been in ring ${ring - 1}.`);
  if (!r.evidence || r.evidence.previousJobId !== prev.jobId) return no('evidence_mismatch', `The evidence must be ring ${ring - 1}'s plan as this signer signed it.`);
  const named = new Set(r.evidence.targets.map((t) => t.endpointId));
  if (named.size !== r.evidence.targets.length || named.size !== prev.endpointIds.length || !prev.endpointIds.every((e) => named.has(e))) {
    return no('evidence_mismatch', `The evidence must cover every computer in ring ${ring - 1}, and only those.`);
  }
  const gate = evaluateRingGate({
    ring: ring - 1, jobStatus: r.evidence.jobStatus, targets: r.evidence.targets.map(fromEvidenceTarget),
    updates: prev.updates.map((k) => { const [updateId, rev] = k.split('@'); return { updateId, revision: Number(rev) }; }),
    failureThreshold: doc.failureThreshold, soakHours: doc.soakHours,
  }, new Date(Math.max(now.getTime(), nb.getTime())));
  if (!gate.ok) return no(gate.reason === 'canary_not_effective' || gate.reason === 'canary_proved_nothing' ? gate.reason : 'gate_not_passed', gate.detail);
  if (nb.getTime() < Date.parse(prev.signedAt)) return no('ring_out_of_order', 'A ring cannot start before the ring before it was signed.');
  return { ok: true };
}
