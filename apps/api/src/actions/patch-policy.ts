import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '../integration/crypto';
import { APPROVALS_REQUIRED, MAX_RING_TARGETS, MAX_UPDATES_PER_PLAN, MAX_WINDOW_HOURS, REBOOT_SCHEDULE, UPDATE_ID_RE, UPDATE_INSTALL, UPDATE_RESTART_WARNING_MINUTES, UpdateReboot, rebootWithin, type Plan } from './catalog';
import { CLASSIFICATIONS, idKey, updateState, type PostureLike, type TargetView, type UpdateState } from '../patching/posture';
import { RESULT_STATUS, ResultKey, openDeviceStatement } from './device-result';

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
 * a weekly or (0.53) monthly maintenance window in a named timezone, and the
 * reboot rule. Until 0.63 every document also carried an expiry at most 90
 * days out; from 0.63 (the owner's request, "Policies shouldnt expire") a
 * document may instead carry a signed `expiry: "never"` and stands until it
 * is revoked (see `expiryMsOf`). After that the approval signer — not the portal
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
 * The previous ring's results (v0.34) are signed by the computers that
 * produced them, with a key each one generated itself and two approvers bound
 * to it in this document (`resultKey`). The portal relays those signatures
 * unmodified; `verifiedGateTargets` checks each one — this computer's key,
 * this plan, this computer's identity, a time inside the plan's run — and
 * the gate (`evaluateRingGate`, the same function the portal uses) is run
 * over the signed facts alone, never over the portal's copy of them. So a
 * portal that fabricates a canary success no longer gets ring 1 signed: it
 * would need the canary's key, which never leaves the canary.
 *
 * Before 0.34 it could; see docs/staged-patching.md "Signed results" for the
 * trust-on-first-use window that remains (who vouches for the key the first
 * time a policy names a computer).
 */

/** Installable classification ids and their names, re-exported for the signer's pages. */
export { CLASSIFICATIONS };

export const POLICY_SCHEMA = 'rem0te-patch-policy/1';
/** Domain separation for a policy's digest and for the signer's signature over an approved policy. */
export const POLICY_DIGEST_PREFIX = 'rem0te-patch-policy-v1\n';
export const POLICY_SIGNING_PREFIX = 'rem0te-patch-policy-approved-v1\n';
/** The furthest a document that carries an expiry may set it (0.32). A document with `expiry: "never"` (0.63) has none. */
export const MAX_POLICY_DAYS = 90;
/**
 * 0.63, at the owner's request ("Policies shouldnt expire"): the one value of
 * a document's signed `expiry` field. A document carries exactly one of
 * `expiresAt` (every document before 0.63, and one made through the API with
 * an expiry) or `expiry: "never"`, which stands until the policy is revoked,
 * paused or replaced. Anything else — neither, both, another value — is
 * refused at admission and treated as already expired by every decision.
 */
export const EXPIRY_NEVER = 'never' as const;
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
  /**
   * v0.34: the public key this computer signs its results with, as its signed
   * scans reported it. Approving the policy is what makes the signer trust it
   * (and pin it to this identity). Absent in 0.32/0.33 policies, and for an
   * agent older than 0.34 — whose results then can never open a later ring.
   */
  resultKey: ResultKey.optional(),
}).strict();
export type PolicyComputer = z.infer<typeof PolicyComputer>;

const Timezone = z.string().min(1).max(64).refine(validTimezone, 'not a timezone this runtime knows (IANA name, e.g. America/Chicago)');
const notEmpty = (w: { start: string; end: string }) => w.start !== w.end;

/**
 * A weekly window (0.32): the days of the week it opens on. Its shape is
 * unchanged since 0.32 and carries no `kind`, so a weekly policy document's
 * canonical bytes, digest and signature are exactly what they always were.
 */
export const WeeklyWindow = z.object({
  days: z.array(z.enum(WEEKDAYS)).min(1).max(7).refine((d) => new Set(d).size === d.length, 'a day is listed twice'),
  /** Local wall-clock time in `timezone`. An end at or before the start ends on the next day. */
  start: Hhmm,
  end: Hhmm,
  timezone: Timezone,
}).strict().refine(notEmpty, 'the window must not be empty');
export type WeeklyWindow = z.infer<typeof WeeklyWindow>;

/** 0.53: which week of the month a monthly window's weekday falls in. */
export const MONTH_WEEKS = ['first', 'second', 'third', 'fourth', 'last'] as const;
export type MonthWeek = (typeof MONTH_WEEKS)[number];
/** 0.53: the most a monthly weekday window may be moved on (Patch Tuesday + 14 days). */
export const MAX_MONTHLY_OFFSET_DAYS = 14;
/** 0.53: a day-of-month window names 1 to 28, so it opens in every month, February included. */
export const MAX_MONTH_DAY = 28;

/**
 * A monthly window on the nth (or last) weekday of each month, moved on by
 * `offsetDays` (0.53): "second Tuesday + 2 days" is the Thursday after Patch
 * Tuesday. The offset may carry it into the next month; that occurrence still
 * belongs to the month whose weekday it was counted from.
 */
export const MonthlyWeekdayWindow = z.object({
  kind: z.literal('monthly'),
  week: z.enum(MONTH_WEEKS),
  weekday: z.enum(WEEKDAYS),
  offsetDays: z.number().int().min(0).max(MAX_MONTHLY_OFFSET_DAYS),
  start: Hhmm,
  end: Hhmm,
  timezone: Timezone,
}).strict().refine(notEmpty, 'the window must not be empty');
export type MonthlyWeekdayWindow = z.infer<typeof MonthlyWeekdayWindow>;

/** A monthly window on one day of each month, 1 to 28 (0.53). There is no "29th" that skips February. */
export const MonthlyDayWindow = z.object({
  kind: z.literal('monthly'),
  day: z.number().int().min(1).max(MAX_MONTH_DAY),
  start: Hhmm,
  end: Hhmm,
  timezone: Timezone,
}).strict().refine(notEmpty, 'the window must not be empty');
export type MonthlyDayWindow = z.infer<typeof MonthlyDayWindow>;
export type MonthlyWindow = MonthlyWeekdayWindow | MonthlyDayWindow;

/**
 * The maintenance window: a closed union of exactly three strict shapes.
 * Anything else — another `kind`, a weekly window with a `kind`, a monthly
 * one with `days`, a day and a weekday together — matches none of them and
 * is refused, by the portal before it proposes and by the signer before it
 * admits. The occurrence functions below fail closed on an unknown shape too.
 */
export const PolicyWindow = z.union([WeeklyWindow, MonthlyWeekdayWindow, MonthlyDayWindow]);
export type PolicyWindow = z.infer<typeof PolicyWindow>;

/**
 * 0.54: a policy's restart rule, with its own restart window (the same three
 * window shapes and the same occurrence functions as the install window).
 * Absent in every document made before 0.54, whose bytes and digest are
 * therefore unchanged. Two rules, and nothing else:
 *
 *   if_required  after an install leaves a computer "restart required", the
 *                portal proposes a windows.reboot.schedule plan for it in
 *                the next restart window, carrying onlyIfRequired: the agent
 *                restarts only if Windows still says a restart is required.
 *   always       a maintenance restart: every computer in the policy, once
 *                per restart window, whether or not one is required.
 *
 * The signer signs such a plan only inside this window, only for a computer
 * the policy names, with the fixed warning, and at most MAX_RESTART_ATTEMPTS
 * times per computer per occurrence (restart_already_signed / _retry_limit).
 */
export const RESTART_RULES = ['if_required', 'always'] as const;
export type RestartRule = (typeof RESTART_RULES)[number];
export const PolicyRestart = z.object({
  rule: z.enum(RESTART_RULES),
  window: PolicyWindow,
}).strict();
export type PolicyRestart = z.infer<typeof PolicyRestart>;
/** The warning before a policy's restart: the update restart's fixed warning. The signer accepts no other delay. */
export const POLICY_RESTART_DELAY_MINUTES = UPDATE_RESTART_WARNING_MINUTES;
/** Restart plans one computer may have signed in one occurrence of a restart window (the first and two retries). */
export const MAX_RESTART_ATTEMPTS = 3;
/** The longest window a restart plan is signed for; windows.reboot.schedule's own maxWindowHours. */
export const MAX_RESTART_PLAN_HOURS = 2;

/** The restart rule of a document, or null — fail closed on anything but the two named rules. */
export function restartRuleOf(doc: { restart?: unknown }): RestartRule | null {
  const r = doc.restart as { rule?: unknown } | undefined;
  if (!r || typeof r !== 'object') return null;
  return (RESTART_RULES as readonly unknown[]).includes(r.rule) ? r.rule as RestartRule : null;
}

/**
 * 0.62, at the owner's request: how a policy's rings relate to each other.
 * Signed with the rest of the document, and read only through `stagingOf`.
 *
 *   canary  ring 0 is one computer, and each later ring is signed only after
 *           the ring before it is confirmed by the computers' own signed
 *           results (the gate). What every document before 0.62 means: a
 *           document without the field is a canary document.
 *   none    "all at once": every ring is signed on its own, inside the
 *           window, with no canary, no evidence, no order and no soak. Rings
 *           exist only because a plan names at most MAX_RING_TARGETS
 *           computers; none of them waits for another.
 *
 * Anything else is refused at admission (the schema and `staging_unknown`)
 * and again when a plan is decided, so an unknown value is never read as
 * either.
 */
export const STAGINGS = ['none', 'canary'] as const;
export type Staging = (typeof STAGINGS)[number];

/** The staging a document asks for, or null for a value this version does not know (fail closed). Absent is canary. */
export function stagingOf(doc: { staging?: unknown }): Staging | null {
  if (!('staging' in doc) || doc.staging === undefined) return 'canary';
  return (STAGINGS as readonly unknown[]).includes(doc.staging) ? doc.staging as Staging : null;
}

export const PolicyAllow = z.object({
  /** Windows Update classification ids; a subset of what any plan may install. */
  classifications: z.array(z.string().refine((c) => !!CLASSIFICATIONS[c], 'not an installable classification')).min(1).max(6)
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
  /**
   * Under canary staging, ring 0 is the canary: exactly one computer. Every
   * other ring (and, under staging none, every ring) holds up to
   * MAX_RING_TARGETS computers.
   */
  rings: z.array(z.array(PolicyComputer).min(1).max(MAX_RING_TARGETS)).min(1).max(MAX_POLICY_RINGS),
  /** 0.62: 'none' (all at once) or 'canary'. Absent in every document before 0.62, which therefore mean canary and keep their bytes. */
  staging: z.enum(STAGINGS).optional(),
  allow: PolicyAllow,
  soakHours: z.number().int().min(0).max(168),
  failureThreshold: z.number().int().min(0).max(MAX_RING_TARGETS),
  window: PolicyWindow,
  /**
   * The most a plan under this policy may ask (0.34): never, or a restart if
   * required inside the window. Signed with the rest, so the signer refuses
   * a plan asking for more (reboot_not_allowed).
   */
  reboot: UpdateReboot,
  /** 0.54: a separate restart window and rule. Absent before 0.54 (and when not chosen), so older documents keep their digest. */
  restart: PolicyRestart.optional(),
  /**
   * 0.54, the owner's exception to the RustDesk-session rule: this policy's
   * restarts (in the install window and in the restart window) go ahead even
   * while a technician is connected through RustDesk. Present only when true.
   * The signer refuses a plan carrying ignoreRemoteSession under a policy
   * without it (override_not_allowed).
   */
  ignoreRemoteSession: z.literal(true).optional(),
  createdAt: Iso,
  /** When the policy stops. Present in every document before 0.63, which keep their bytes, digest and expiry. Absent exactly when `expiry` is "never". */
  expiresAt: Iso.optional(),
  /** 0.63: "never" — the policy stands until revoked. Present only without expiresAt (`expiryMsOf`); signed, so a portal that adds or drops it breaks the digest. */
  expiry: z.literal(EXPIRY_NEVER).optional(),
  createdBy: z.object({ userId: Id, name: z.string().max(120) }).strict(),
  reason: z.string().min(3).max(500),
}).strict();
export type PolicyDoc = z.infer<typeof PolicyDoc>;

/** The two fields that say how long a document stands (patch and automation documents alike). */
export type ExpiryFields = { expiresAt?: unknown; expiry?: unknown };
const present = (o: object, k: string) => k in o && (o as Record<string, unknown>)[k] !== undefined;

/**
 * 0.63: when a document stops, in ms since the epoch — Infinity for a signed
 * `expiry: "never"` — or null for a document that says neither, both, or
 * something this version does not know. Null is fail closed: every caller
 * treats it as already expired, never as "never".
 */
export function expiryMsOf(doc: ExpiryFields): number | null {
  const never = present(doc, 'expiry'), at = present(doc, 'expiresAt');
  if (never) return doc.expiry === EXPIRY_NEVER && !at ? Infinity : null;
  if (!at || typeof doc.expiresAt !== 'string') return null;
  const t = Date.parse(doc.expiresAt);
  return Number.isFinite(t) ? t : null;
}

/** The `until` the occurrence functions take: none for "never", the expiry otherwise, and the epoch (nothing opens) for an invalid document. */
export function expiryUntil(doc: ExpiryFields): Date | undefined {
  const ms = expiryMsOf(doc);
  return ms === Infinity ? undefined : new Date(ms ?? 0);
}

/**
 * 0.63: the expiry rules a schema cannot say, shared by both documents'
 * validators (portal before it proposes, signer before it admits). A "never"
 * document has no expiry to check; one with an expiry keeps 0.32's rules.
 */
export function expiryProblem(doc: ExpiryFields & { createdAt: string }, now: Date, maxDays: number, noun: string): { reason: string; message: string } | null {
  const never = present(doc, 'expiry'), at = present(doc, 'expiresAt');
  if (never && doc.expiry !== EXPIRY_NEVER) return { reason: 'expiry_unknown', message: `The ${noun}'s expiry is not one this version knows (only "never").` };
  if (never && at) return { reason: 'expiry_conflict', message: `The ${noun} carries both an expiry date and "never".` };
  if (never) return null;
  if (!at) return { reason: 'expiry_missing', message: `The ${noun} says neither when it expires nor that it never does.` };
  const exp = expiryMsOf(doc), created = Date.parse(doc.createdAt);
  if (exp === null) return { reason: 'expiry_unknown', message: `The ${noun}'s expiry is not a date.` };
  if (!(exp > now.getTime())) return { reason: 'policy_expired', message: 'The expiry is in the past.' };
  const most = maxDays * 86_400_000 + CLOCK_SKEW_MS;
  if (exp - now.getTime() > most || exp - created > most) return { reason: 'expiry_too_far', message: `A ${noun} that expires does so at most ${maxDays} days after it is proposed. Leave the expiry out and it never expires.` };
  return null;
}

/** 0.63: the expiry in words, for the pages: "never (until revoked)" or the date. */
export function expiryInWords(doc: ExpiryFields): string {
  const ms = expiryMsOf(doc);
  return ms === Infinity ? 'never (until revoked)' : ms === null ? 'unreadable (treated as expired)' : new Date(ms).toISOString();
}

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
  const staging = stagingOf(doc);
  if (!staging) return { ok: false, reason: 'staging_unknown', message: 'The staging is not one this version knows (none or canary).' };
  if (staging === 'canary' && doc.rings[0].length !== 1) return { ok: false, reason: 'bad_rings', message: 'Ring 0 is the canary: exactly one computer.' };
  const all = doc.rings.flat();
  if (new Set(all.map((c) => c.endpointId)).size !== all.length || new Set(all.map((c) => c.rustdeskId)).size !== all.length) {
    return { ok: false, reason: 'bad_rings', message: 'A computer can be in one ring only.' };
  }
  // 0.63: an expiry date (0.32's rules), or a signed "never"; anything else is refused.
  const ex = expiryProblem(doc, now, MAX_POLICY_DAYS, 'policy');
  if (ex) return { ok: false, ...ex };
  const until = expiryUntil(doc), created = Date.parse(doc.createdAt);
  if (created > now.getTime() + CLOCK_SKEW_MS) return { ok: false, reason: 'bad_created', message: 'The policy is dated in the future.' };
  if (!nextOccurrence(now, doc.window, until)) return { ok: false, reason: 'window_never_opens', message: 'The maintenance window never opens before the policy expires.' };
  // 0.54: a restart window must open before expiry too, and the RustDesk-session exception needs a restart to apply to.
  if (doc.restart !== undefined && !restartRuleOf(doc)) return { ok: false, reason: 'restart_rule_unknown', message: 'The restart rule is not one this version knows.' };
  if (doc.restart && !nextOccurrence(now, doc.restart.window, until)) return { ok: false, reason: 'restart_window_never_opens', message: 'The restart window never opens before the policy expires.' };
  if (doc.ignoreRemoteSession && doc.reboot !== 'if_required_in_window' && !doc.restart) return { ok: false, reason: 'override_without_restart', message: 'The RustDesk-session exception applies to a restart, and this policy never restarts.' };
  // v0.34, fail closed: a computer whose results open the next ring must be
  // able to sign them. Only the last ring's results gate nothing — and, under
  // staging none (0.62), no ring's results open anything.
  const unsigned = staging === 'none' ? [] : doc.rings.slice(0, -1).flat().filter((c) => !c.resultKey);
  if (unsigned.length) {
    return { ok: false, reason: 'result_key_missing', message: `${unsigned.map((c) => c.hostname).slice(0, 3).join(', ')}${unsigned.length > 3 ? ` and ${unsigned.length - 3} more` : ''}: no result-signing key. Its results would open the next ring, and an agent older than 0.34 cannot sign them. Update its agent and let it scan, or put it in the last ring.` };
  }
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

type LocalDate = { y: number; m: number; d: number };
const weekdayOf = (date: LocalDate): Weekday => WEEKDAYS[new Date(Date.UTC(date.y, date.m - 1, date.d)).getUTCDay()];
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const intIn = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

/**
 * 0.53: which kind of window this is — or null for a shape that is neither,
 * which every function here treats as a window that never opens (fail
 * closed: an unknown kind is never read as weekly or as monthly).
 */
export function windowKind(w: unknown): 'weekly' | 'monthly' | null {
  if (!w || typeof w !== 'object') return null;
  const o = w as Record<string, unknown>;
  if (!('kind' in o)) return Array.isArray(o.days) ? 'weekly' : null;
  if (o.kind !== 'monthly' || 'days' in o) return null;
  return ('day' in o) !== ('week' in o) ? 'monthly' : null;
}

/**
 * 0.53: the local date a monthly window opens in month (y, m), counted from
 * that month (the offset may carry it into the next one). Null for a shape
 * that is not a monthly window.
 */
export function monthlyDate(y: number, m: number, w: MonthlyWindow): LocalDate | null {
  if ('day' in w) return intIn(w.day, 1, MAX_MONTH_DAY) ? { y, m, d: w.day } : null;
  const wd = WEEKDAYS.indexOf(w.weekday), wk = MONTH_WEEKS.indexOf(w.week);
  if (wd < 0 || wk < 0 || !intIn(w.offsetDays, 0, MAX_MONTHLY_OFFSET_DAYS)) return null;
  let d: number;
  if (w.week === 'last') {
    const last = daysInMonth(y, m);
    d = last - ((new Date(Date.UTC(y, m - 1, last)).getUTCDay() - wd + 7) % 7);
  } else {
    d = 1 + ((wd - new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 7) % 7) + 7 * wk;
  }
  return addDays(y, m, d, w.offsetDays);
}

/** Does the window open (start) on this local date? Weekly: one of its days. Monthly: its date this month, or last month's carried over by the offset. */
function opensOn(date: LocalDate, w: PolicyWindow): boolean {
  const kind = windowKind(w);
  if (kind === 'weekly') return (w as WeeklyWindow).days.includes(weekdayOf(date));
  if (kind !== 'monthly') return false;
  // The offset is at most 14 days, so a date's occurrence was counted from its own month or the one before.
  const prev = date.m === 1 ? { y: date.y - 1, m: 12 } : { y: date.y, m: date.m - 1 };
  for (const mo of [{ y: date.y, m: date.m }, prev]) {
    const t = monthlyDate(mo.y, mo.m, w as MonthlyWindow);
    if (t && t.y === date.y && t.m === date.m && t.d === date.d) return true;
  }
  return false;
}

/** How many local days ahead `nextOccurrence` looks: a week and a day for weekly, two months and more for monthly. */
const lookahead = (w: PolicyWindow) => (windowKind(w) === 'monthly' ? 70 : 8);

/** The occurrence of the window that begins on this local date, if it opens on that date. */
function occurrenceOn(date: LocalDate, w: PolicyWindow): { start: Date; end: Date } | null {
  if (!opensOn(date, w)) return null;
  const [sh, sm] = hm(w.start), [eh, em] = hm(w.end);
  const start = zonedToUtc(date.y, date.m, date.d, sh, sm, w.timezone);
  const crosses = eh * 60 + em <= sh * 60 + sm;
  const ed = crosses ? addDays(date.y, date.m, date.d, 1) : date;
  const end = zonedToUtc(ed.y, ed.m, ed.d, eh, em, w.timezone);
  return end > start ? { start, end } : null;
}

/** The occurrence of the window that contains instant t, or null. */
export function occurrenceAt(t: Date, w: PolicyWindow): { start: Date; end: Date } | null {
  if (!windowKind(w)) return null;
  const l = localTime(t, w.timezone);
  for (const n of [-1, 0]) {
    const o = occurrenceOn(addDays(l.y, l.m, l.d, n), w);
    if (o && o.start <= t && t < o.end) return o;
  }
  return null;
}

/** The first occurrence that has not ended by `after` (it may already be open), before `until` if given. */
export function nextOccurrence(after: Date, w: PolicyWindow, until?: Date): { start: Date; end: Date } | null {
  if (!windowKind(w)) return null;
  const l = localTime(after, w.timezone);
  for (let n = -1, most = lookahead(w); n <= most; n++) {
    const o = occurrenceOn(addDays(l.y, l.m, l.d, n), w);
    if (!o || o.end <= after) continue;
    if (until && o.start >= until) return null;
    return o;
  }
  return null;
}

/** 0.53: the next `count` occurrences (at most 12) from `after`, before `until` if given. What the editor previews and the signer's page shows. */
export function nextOccurrences(after: Date, w: PolicyWindow, count: number, until?: Date): { start: Date; end: Date }[] {
  const out: { start: Date; end: Date }[] = [];
  let t = after;
  for (let i = 0; i < Math.min(Math.max(count, 0), 12); i++) {
    const o = nextOccurrence(t, w, until);
    if (!o) break;
    out.push(o);
    t = o.end;
  }
  return out;
}

const WEEKDAY_NAME: Record<Weekday, string> = { sun: 'Sunday', mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday' };
const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;

/**
 * The window in words, as the signer's refusal and its approval page say it.
 * A weekly window reads exactly as it did before 0.53 ("sat, sun 22:00–04:00
 * America/Chicago").
 */
export function describePolicyWindow(w: PolicyWindow): string {
  const kind = windowKind(w);
  const times = `${w.start}–${w.end} ${w.timezone}`;
  if (kind === 'weekly') return `${(w as WeeklyWindow).days.join(', ')} ${times}`;
  if (kind !== 'monthly') return `an unrecognised window ${times}`;
  const m = w as MonthlyWindow;
  if ('day' in m) return `the ${ordinal(m.day)} of each month ${times}`;
  const base = `the ${m.week} ${WEEKDAY_NAME[m.weekday]} of each month`;
  return `${m.offsetDays ? `${m.offsetDays} day${m.offsetDays === 1 ? '' : 's'} after ${base}` : base} ${times}`;
}

const SHORT_DAY: Record<Weekday, string> = { sun: 'Sun', mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat' };
const WEEK_WORD: Record<MonthWeek, string> = { first: '1st', second: '2nd', third: '3rd', fourth: '4th', last: 'Last' };

/**
 * 0.54: a window in plain words for the policy list — "Sundays 02:00–04:00
 * America/New_York", "2nd Tuesday +2, 22:00–04:00 America/New_York". Words
 * only: the occurrences themselves come from the functions above.
 */
export function windowInWords(w: PolicyWindow): string {
  const kind = windowKind(w);
  const times = `${w.start}–${w.end} ${w.timezone}`;
  if (kind === 'weekly') {
    const days = WEEKDAYS.filter((d) => (w as WeeklyWindow).days.includes(d));
    const which = days.length === 7 ? 'Every day' : days.length === 1 ? `${WEEKDAY_NAME[days[0]]}s` : days.map((d) => SHORT_DAY[d]).join(', ');
    return `${which} ${times}`;
  }
  if (kind !== 'monthly') return `an unrecognised window ${times}`;
  const m = w as MonthlyWindow;
  if ('day' in m) return `the ${ordinal(m.day)} of each month, ${times}`;
  return `${WEEK_WORD[m.week]} ${WEEKDAY_NAME[m.weekday]}${m.offsetDays ? ` +${m.offsetDays}` : ''}, ${times}`;
}

/** 0.54: what a policy does about restarts, in words. */
export function restartInWords(doc: Pick<PolicyDoc, 'reboot' | 'restart' | 'ignoreRemoteSession'>): string {
  const rule = restartRuleOf(doc);
  const inWindow = doc.reboot === 'if_required_in_window';
  let s: string;
  if (doc.restart && rule === 'always') s = `every restart window (maintenance restart), ${windowInWords(doc.restart.window)}${inWindow ? '; also if required in the install window' : ''}`;
  else if (doc.restart && rule === 'if_required') s = `${inWindow ? 'if required, in the install window or else ' : 'if required, '}${windowInWords(doc.restart.window)}`;
  else if (doc.restart) s = 'an unrecognised restart rule (nothing is restarted)';
  else s = inWindow ? 'if required, in the install window' : 'never (someone restarts it by hand)';
  return doc.ignoreRemoteSession ? `${s} — even with a technician connected through RustDesk` : s;
}

/** 0.54: the whole schedule in one line: "Installs: … · Restarts: …". */
export function scheduleInWords(doc: Pick<PolicyDoc, 'window' | 'reboot' | 'restart' | 'ignoreRemoteSession'>): string {
  return `Installs: ${windowInWords(doc.window)} · Restarts: ${restartInWords(doc)}`;
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
  /** 0.62: false under staging none, where ring 0 is not a canary and proves nothing for another ring. Absent means canary. */
  canary?: boolean;
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
  if (ring === 0 && g.canary !== false) {
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
/**
 * The portal's copy of a target (status, result, scan) is kept for the
 * operator's record, but from 0.34 the signer's gate reads only what the
 * computer signed: `signedResult` and `signedScan`, relayed as received.
 */
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
  /** v0.34: the computer's own signature over its result and its latest scan, exactly as it sent them. Checked by `openDeviceStatement`. */
  signedResult: z.unknown().optional(),
  signedScan: z.unknown().optional(),
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
  // Passed through as the computer sent them: the portal neither builds nor
  // edits a device signature, and could not make one verify if it did.
  const signedResult = (t.result as { signed?: unknown } | null)?.signed ?? null;
  const signedScan = (s as { signed?: unknown } | null)?.signed ?? null;
  return {
    signedResult, signedScan,
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
export interface LedgerEntry {
  jobId: string; deploymentId: string; ring: number; signedAt: string; notBefore: string; notAfter: string; endpointIds: string[]; updates: string[];
  /** 0.54: a restart plan (windows.reboot.schedule), and the occurrence of the restart window (its UTC start) it was signed for. Never a ring. */
  kind?: 'restart';
  restartWindow?: string;
  /** v0.34: sha256 of the signed plan bytes, which each computer's signed result must name. */
  planSha256?: string;
}
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

/**
 * The quorum a policy needs: two distinct approvers who are not its author,
 * and a customer sign-off when the business requires one. In direct mode
 * (0.40, the signer's operator's setting for the business, which never
 * coexists with customer sign-off) it needs none: the signer activates it at
 * admission. A policy activated that way carries no approvals, so it stops
 * meeting the quorum the moment the business leaves direct mode.
 */
export function policyQuorum(doc: PolicyDoc, approvals: PolicyApproval[], customerSignoff: boolean, direct = false): boolean {
  if (direct) return !customerSignoff;
  const approvers = new Set(approvals.filter((a) => a.role === 'approver' && a.userId !== doc.createdBy.userId).map((a) => a.userId));
  if (approvers.size < APPROVALS_REQUIRED.high) return false;
  if (customerSignoff && !approvals.some((a) => a.role === 'customer' && a.userId !== doc.createdBy.userId && !approvers.has(a.userId))) return false;
  return true;
}

/**
 * Is this plan inside the policy? Every refusal is a distinct code, because
 * each is a different thing a compromised portal might try.
 */
export function evaluatePolicyPlan(s: PolicyState, r: PolicyPlanRequest, opts: { now: Date; customerSignoff: boolean; direct?: boolean }): PolicyDecision {
  // 0.54: a restart plan is decided by its own rule, after the same standing checks.
  if (r.plan.action.id === REBOOT_SCHEDULE.id && r.plan.action.version === REBOOT_SCHEDULE.version) return evaluatePolicyRestartPlan(s, r, opts);
  const standing = policyStanding(s, r, opts);
  if (standing) return standing;
  const { doc } = s, p = r.plan;

  // The action and what it installs.
  if (p.action.id !== UPDATE_INSTALL.id || p.action.version !== UPDATE_INSTALL.version) return no('action_not_in_policy', 'A patch policy signs Windows update installs only.');
  const params = p.params as { updates?: { updateId: string; revision: number }[]; reboot?: unknown; allow?: unknown; ignoreRemoteSession?: unknown };
  if (!rebootWithin(params.reboot, doc.reboot)) return no('reboot_not_allowed', `The plan's restart rule asks for more than the policy allows (${doc.reboot === 'never' ? 'never restart' : 'restart if required, inside the window'}).`);
  if (params.ignoreRemoteSession !== undefined && !(params.ignoreRemoteSession === true && doc.ignoreRemoteSession === true)) return no('override_not_allowed', 'The plan asks to restart even with a technician connected through RustDesk, which this policy does not allow.');
  return evaluateInstallPlan(s, r, opts, params);
}

/**
 * The policy's own standing, the same for an install and a restart plan:
 * revoked, signature, digest, expiry, status, quorum, and the plan inside
 * its life. Null when it may sign.
 */
function policyStanding(s: PolicyState, r: PolicyPlanRequest, opts: { now: Date; customerSignoff: boolean; direct?: boolean }): PolicyDecision | null {
  const { doc } = s, p = r.plan, now = opts.now;
  // The policy itself.
  if (s.revokedAt || s.status === 'REVOKED') return no('policy_revoked', 'This policy was revoked; nothing more is signed under it.');
  if (!s.signatureValid) return no('policy_signature_invalid', 'The stored policy does not verify against this signer\'s key.');
  if (policyDigest(doc) !== s.digest || r.policyDigest !== s.digest) return no('policy_digest_mismatch', 'The policy digest does not match the approved policy.');
  // Expiry is checked before status: an expired policy's status is EXPIRED, and the code should say why.
  // 0.63: a signed "never" never expires; a document saying neither, both or anything else is refused, never read as "never".
  const exp = expiryMsOf(doc);
  if (exp === null) return no('expiry_unknown', 'The policy\'s expiry is not one this signer knows; nothing is signed under it.');
  if (now.getTime() >= exp) return no('policy_expired', 'This policy has expired. Approve a new one.');
  if (s.status !== 'ACTIVE') return no('policy_not_active', `This policy is ${s.status.toLowerCase().replace(/_/g, ' ')}.`);
  if (!policyQuorum(doc, s.approvals, false, opts.direct === true)) return no('policy_not_approved', 'This policy does not carry two approvals from people other than its author (a policy activated in direct mode stops counting when the business leaves direct mode).');
  if (!policyQuorum(doc, s.approvals, opts.customerSignoff, opts.direct === true)) return no('policy_mismatch', 'This business now requires customer sign-off, which this policy was not approved with. Approve a new policy.');
  if (Date.parse(p.window.notAfter) > exp) return no('policy_expired', 'The plan would run past the policy\'s expiry.');
  return null;
}

function evaluateInstallPlan(s: PolicyState, r: PolicyPlanRequest, opts: { now: Date }, params: { updates?: { updateId: string; revision: number }[]; allow?: unknown }): PolicyDecision {
  const { doc } = s, p = r.plan, now = opts.now;
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
  if (!occ || na > occ.end) return no('outside_window', `The plan must run inside the policy's maintenance window (${describePolicyWindow(doc.window)}).`);
  if (nb.getTime() < now.getTime() - CLOCK_SKEW_MS) return no('outside_window', 'The plan starts in the past.');
  if (na.getTime() - nb.getTime() > MAX_WINDOW_HOURS * 3_600_000) return no('outside_window', 'A plan runs for at most 24 hours.');

  // 0.62: the staging the signed document asks for. Unknown is refused, never read as either.
  const staging = stagingOf(doc);
  if (!staging) return no('staging_unknown', 'The policy\'s staging is not one this signer knows; nothing is signed under it.');

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
  if (staging === 'canary' && ring === 0 && p.targets.length !== 1) return no('computer_not_in_policy', 'Ring 0 is the canary alone.');

  // Ring order, from this signer's own ledger.
  const mine = s.ledger.filter((e) => e.kind !== 'restart' && e.deploymentId === dep.id);
  if (staging === 'none') {
    // 0.62, all at once: each ring is its own plan inside the window, gated
    // on nothing. Still once at a time per ring, and at most three times.
    if (r.evidence) return no('bad_evidence', 'A policy that installs all at once carries no evidence: no ring waits for another.');
    const same = mine.filter((e) => e.ring === ring);
    if (same.some((e) => Date.parse(e.notAfter) > now.getTime())) return no('ring_already_signed', `Ring ${ring} of this deployment is already signed and its window is still open.`);
    if (same.length >= MAX_RING_ATTEMPTS) return no('ring_retry_limit', `Ring ${ring} has been signed ${same.length} times under this policy. Retry it as an ordinary deployment, with approvals.`);
    return { ok: true };
  }
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
  // v0.34: the gate below reads only facts the computers signed.
  const verified = verifiedGateTargets(doc.rings[ring - 1], prev, r.evidence, now);
  if (!verified.ok) return verified;
  const gate = evaluateRingGate({
    ring: ring - 1, jobStatus: r.evidence.jobStatus, targets: verified.targets,
    updates: prev.updates.map((k) => { const [updateId, rev] = k.split('@'); return { updateId, revision: Number(rev) }; }),
    failureThreshold: doc.failureThreshold, soakHours: doc.soakHours,
  }, new Date(Math.max(now.getTime(), nb.getTime())));
  if (!gate.ok) return no(gate.reason === 'canary_not_effective' || gate.reason === 'canary_proved_nothing' ? gate.reason : 'gate_not_passed', gate.detail);
  if (nb.getTime() < Date.parse(prev.signedAt)) return no('ring_out_of_order', 'A ring cannot start before the ring before it was signed.');
  return { ok: true };
}

/**
 * 0.54: a restart plan (windows.reboot.schedule) under a policy's restart
 * rule. The portal proposes one per computer reporting a required restart
 * (or, under `always`, per computer) inside an open restart window; this
 * decides whether it is inside the signed document. Every refusal is its own
 * code.
 */
export function evaluatePolicyRestartPlan(s: PolicyState, r: PolicyPlanRequest, opts: { now: Date; customerSignoff: boolean; direct?: boolean }): PolicyDecision {
  const standing = policyStanding(s, r, opts);
  if (standing) return standing;
  const { doc } = s, p = r.plan, now = opts.now;
  if (!doc.restart) return no('restart_not_in_policy', 'This policy has no restart window, so it signs no restart plan.');
  const rule = restartRuleOf(doc);
  if (!rule) return no('restart_rule_unknown', 'The policy\'s restart rule is not one this signer knows; nothing is restarted under it.');
  if (p.action.id !== REBOOT_SCHEDULE.id || p.action.version !== REBOOT_SCHEDULE.version) return no('action_not_in_policy', 'A policy restart is windows.reboot.schedule@1 only.');
  const params = p.params as Record<string, unknown>;
  const allowed = new Set(['delayMinutes', 'onlyIfRequired', 'ignoreRemoteSession']);
  if (Object.keys(params).some((k) => !allowed.has(k)) || params.delayMinutes !== POLICY_RESTART_DELAY_MINUTES) return no('restart_params_not_allowed', `A policy restart gives the fixed ${POLICY_RESTART_DELAY_MINUTES}-minute warning and nothing else.`);
  if (rule === 'if_required' ? params.onlyIfRequired !== true : params.onlyIfRequired !== undefined) return no('restart_params_not_allowed', rule === 'if_required' ? 'Under "restart if required" the computer must decide from Windows\' own state (onlyIfRequired).' : 'A maintenance restart restarts whether or not one is required.');
  if (params.ignoreRemoteSession !== undefined && !(params.ignoreRemoteSession === true && doc.ignoreRemoteSession === true)) return no('override_not_allowed', 'The plan asks to restart even with a technician connected through RustDesk, which this policy does not allow.');
  if (r.evidence) return no('bad_evidence', 'A restart plan carries no evidence.');
  if (p.display?.policy?.id !== doc.policyId || p.display.policy.digest !== s.digest) return no('bad_display', 'The plan must name this policy.');
  if (p.display.deployment || (p.display.updates ?? []).length) return no('bad_display', 'A restart plan names no deployment and no update.');
  if (p.requestedBy.userId !== doc.createdBy.userId) return no('requester_mismatch', 'A policy plan is requested on behalf of the policy\'s author.');
  if (p.targets.length !== 1) return no('computer_not_in_policy', 'A restart plan names one computer.');
  const t = p.targets[0];
  const c = doc.rings.flat().find((x) => x.endpointId === t.endpointId);
  if (!c || t.businessId !== doc.businessId || t.rustdeskId !== c.rustdeskId || t.deviceSecretSha256 !== c.deviceSecretSha256) {
    return no('computer_not_in_policy', `${t.hostname} is not in this policy, or is not the computer that was approved (its enrolled identity differs).`);
  }
  // Inside the restart window: received at the latest at notAfter, restarted the fixed warning later, before the window closes.
  const nb = new Date(p.window.notBefore), na = new Date(p.window.notAfter);
  const occ = occurrenceAt(nb, doc.restart.window);
  if (!occ || na.getTime() + POLICY_RESTART_DELAY_MINUTES * 60_000 > occ.end.getTime()) return no('outside_restart_window', `The restart must happen inside the policy's restart window (${describePolicyWindow(doc.restart.window)}).`);
  if (nb.getTime() < now.getTime() - CLOCK_SKEW_MS) return no('outside_restart_window', 'The plan starts in the past.');
  if (na.getTime() - nb.getTime() > MAX_RESTART_PLAN_HOURS * 3_600_000) return no('outside_restart_window', `A restart plan runs for at most ${MAX_RESTART_PLAN_HOURS} hours.`);
  const key = occ.start.toISOString();
  const mine = s.ledger.filter((e) => e.kind === 'restart' && e.restartWindow === key && e.endpointIds.includes(t.endpointId));
  if (mine.some((e) => Date.parse(e.notAfter) > now.getTime())) return no('restart_already_signed', `A restart of ${t.hostname} in this window is already signed and its plan is still open.`);
  if (mine.length >= MAX_RESTART_ATTEMPTS) return no('restart_retry_limit', `${t.hostname} has had ${mine.length} restart plans signed in this window. The next window tries again.`);
  return { ok: true };
}

// ── Signed evidence (v0.34) ─────────────────────────────────────────────────

/** A signed scan older than this is not evidence about the canary now. The Patches tab calls a scan stale at the same age. */
export const SIGNED_SCAN_MAX_AGE_HOURS = 36;
/** The agent gives an install four hours; a result is dated at most this long after its plan's window closes. */
const RESULT_AFTER_WINDOW_MS = 4 * 3_600_000 + CLOCK_SKEW_MS;

/**
 * The previous ring's targets as the gate needs them, built from what each
 * computer signed, after checking every signature against the key this
 * policy binds to that computer. Refuses — never ignores — a signature that
 * is invalid, another computer's, about another plan, or dated outside its
 * plan's run. A computer that sent no signed result can only count against
 * the ring: it is counted as failed (and for the canary, which must prove
 * something, it is refused).
 */
export function verifiedGateTargets(
  computers: PolicyComputer[], prev: LedgerEntry, ev: RingEvidence, now: Date,
): { ok: true; targets: GateTarget[] } | { ok: false; code: string; message: string } {
  const canary = prev.ring === 0;
  const byId = new Map(computers.map((c) => [c.endpointId, c]));
  const nb = Date.parse(prev.notBefore), na = Date.parse(prev.notAfter);
  const out: GateTarget[] = [];
  for (const t of ev.targets) {
    const c = byId.get(t.endpointId);
    if (!c) return { ok: false, code: 'evidence_mismatch', message: 'The evidence names a computer this ring of the policy does not.' };
    const name = c.hostname;
    if (!c.resultKey) {
      return { ok: false, code: 'result_key_not_pinned', message: `${name} has no result-signing key in this policy (it was approved before 0.34, or for an older agent), so its results cannot be verified and no later ring is signed under it. Update the agent, let it scan, and approve a new policy.` };
    }
    if (t.signedResult == null) {
      if (canary) return { ok: false, code: 'result_signature_missing', message: `The canary, ${name}, has no signed result for ring 0. Only a result the canary signed can open ring 1.` };
      if (t.status === 'SUCCEEDED') return { ok: false, code: 'result_signature_missing', message: `${name} is reported succeeded, but its result is not signed by it.` };
      // Not answered yet: the gate waits. Anything else counts against the ring.
      const waiting = t.status === 'PENDING' || t.status === 'DISPATCHED';
      out.push({
        endpointId: t.endpointId, status: waiting ? t.status : t.status === 'UNKNOWN' ? 'UNKNOWN' : 'FAILED',
        statusReason: 'no signed result', reconciled: t.status === 'UNKNOWN' ? t.reconciled : false, reconcileNote: null, resultAt: null, result: null, scan: null,
      });
      continue;
    }
    const res = openDeviceStatement('result', t.signedResult, c.resultKey);
    if (!res.ok) return { ok: false, code: res.code, message: `${name}: ${res.message}` };
    const st = res.statement;
    if (st.rustdeskId !== c.rustdeskId || st.deviceSecretSha256 !== c.deviceSecretSha256) {
      return { ok: false, code: 'result_wrong_device', message: `${name}: the signed result names another enrolled identity.` };
    }
    if (st.jobId !== prev.jobId || (prev.planSha256 && st.planSha256 !== prev.planSha256)) {
      return { ok: false, code: 'result_wrong_plan', message: `${name}: the signed result is about another plan, not ring ${prev.ring} as this signer signed it.` };
    }
    const at = Date.parse(st.completedAt);
    if (at < nb - CLOCK_SKEW_MS || at > na + RESULT_AFTER_WINDOW_MS || at > now.getTime() + CLOCK_SKEW_MS) {
      return { ok: false, code: 'result_stale', message: `${name}: the signed result is dated ${st.completedAt}, outside ring ${prev.ring}'s run (${prev.notBefore} to four hours after ${prev.notAfter}).` };
    }
    let scan: PostureLike | null = null;
    if (t.signedScan != null) {
      const sc = openDeviceStatement('scan', t.signedScan, c.resultKey);
      if (!sc.ok) return { ok: false, code: sc.code, message: `${name}: ${sc.message}` };
      const ss = sc.statement;
      if (ss.rustdeskId !== c.rustdeskId || ss.deviceSecretSha256 !== c.deviceSecretSha256) {
        return { ok: false, code: 'result_wrong_device', message: `${name}: the signed scan names another enrolled identity.` };
      }
      const sAt = Date.parse(ss.scannedAt);
      if (sAt > now.getTime() + CLOCK_SKEW_MS) return { ok: false, code: 'result_stale', message: `${name}: the signed scan is dated in the future (${ss.scannedAt}).` };
      const old = now.getTime() - sAt > SIGNED_SCAN_MAX_AGE_HOURS * 3_600_000;
      if (old && canary && sAt > at) return { ok: false, code: 'result_stale', message: `The canary's latest signed scan is from ${ss.scannedAt}, more than ${SIGNED_SCAN_MAX_AGE_HOURS} hours ago. It must scan again before it can open ring 1.` };
      const split = (k: string) => { const [updateId, rev] = k.split('@'); return { updateId, revision: Number(rev) }; };
      if (!old) {
        scan = {
          scannedAt: ss.scannedAt, error: ss.error ? 'reported' : undefined, reboot: { pending: ss.rebootPending },
          updates: ss.offered.map(split), history: ss.installed.map((k) => ({ ...split(k), operation: 'install', result: 'succeeded' })),
        };
      }
    } else if (canary) {
      return { ok: false, code: 'result_signature_missing', message: `The canary, ${name}, has no signed scan. Only a scan the canary signed can show its updates took effect.` };
    }
    out.push({
      endpointId: t.endpointId, status: RESULT_STATUS[st.outcome], statusReason: st.reason ?? null,
      // Reconciliation is a person's note in the portal; it only ever turns an uncertain computer into a failed one.
      reconciled: st.outcome === 'uncertain' ? t.reconciled : false, reconcileNote: null,
      resultAt: new Date(at),
      result: { outcome: st.outcome, ...(st.reason ? { reason: st.reason } : {}), ...(st.updates ? { updates: st.updates.map((u) => ({ updateId: u.updateId, revision: u.revision, state: u.state, ...(u.hresult ? { hresult: u.hresult } : {}) })) } : {}) },
      scan,
    });
  }
  return { ok: true, targets: out };
}
