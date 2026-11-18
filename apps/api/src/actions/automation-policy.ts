import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '../integration/crypto';
import { APPROVALS_REQUIRED, MAX_RING_TARGETS, MAX_WINDOW_HOURS, REBOOT_SCHEDULE, SoftwareDisplay, SoftwareParams, type Plan } from './catalog';
import { SCRIPT_RUN_ACTION, ScriptBlock, ScriptRunParams, argumentsProblem, canonical, definitionSha256 } from './script-run';
import { EXPIRY_NEVER, MAX_POLICY_DAYS, MAX_RESTART_PLAN_HOURS, POLICY_PROPOSAL_DAYS, POLICY_RESTART_DELAY_MINUTES, PolicyWindow, RESTART_RULES, describePolicyWindow, expiryMsOf, expiryProblem, expiryUntil, localTime, nextOccurrence, occurrenceAt, validTimezone, windowKind, zonedToUtc } from './patch-policy';

/**
 * Automation policies (0.58): a library script or a catalog software package,
 * run on a recurring schedule, approved once.
 *
 * Shared, as code, by the portal and the approval signer, like
 * patch-policy.ts. Pure: no clock but the one passed in, no I/O, no Nest, no
 * Prisma. It is on build-approval-signer.mjs's allowed list.
 *
 * The document two approvers sign (or, in direct mode, the signer activates
 * at admission, §58) names exactly what runs and where:
 *
 *   task        a windows.script.run@1 of one APPROVED library version —
 *               its parameters (version, content SHA-256, typed arguments,
 *               timeout) and the signer allowlist block for it — or a
 *               windows.software.install@1 / uninstall@1 of one catalog
 *               entry at one revision (its closed SoftwareParams and display);
 *   targets     named computers, bound to their enrolled identity as a patch
 *               policy binds them, or one device group resolved by the portal
 *               at each occurrence and capped by `maxTargets`;
 *   recurrence  hourly (this file's own closed shape), or the patch policy's
 *               weekly / monthly windows (patch-policy.ts PolicyWindow,
 *               unchanged: daily is a weekly window on every day);
 *   offline     what happens to a computer that is not online when the
 *               occurrence opens, carried into each plan as its signed
 *               notAfter;
 *   limits      plans per occurrence, and (before 0.63, or when one is
 *               asked for through the API) an expiry at most 90 days out;
 *               from 0.63 a document may carry a signed `expiry: "never"`
 *               instead and stands until it is revoked or paused.
 *
 * 0.60 adds a third task, `restart` (the simple restart window): a
 * windows.reboot.schedule@1 of one computer at a time, inside a daily,
 * weekly or monthly window, under "only if Windows needs a restart" or
 * "always", with the fixed 15-minute warning. Its targets may also be the
 * whole business, or every member of one device group, because a restart
 * window is a business's (or a group's) default. Those two target kinds are
 * for the restart task only, and the restart task is decided by its own
 * function (evaluateAutomationRestart): one computer per plan, at most
 * `maxRunsPerOccurrence` plans per computer per occurrence, none while that
 * computer's earlier plan is still open — never the script/software rule
 * that runs never overlap across computers.
 *
 * After that the signer — not the portal — signs each occurrence's plan,
 * but only if `evaluateAutomationPlan` finds it inside the document AND the
 * signer's ordinary admission passes (`admitPlan`: the script still ACTIVE
 * and unrevoked on its own allowlist, the software entry not revoked). So a
 * revoked script or package stops every later occurrence at the signer, and
 * a compromised portal cannot widen the computers, the task, its arguments
 * or the schedule. Nothing here creates a second way to run anything: an
 * occurrence is an ordinary signed plan, and the agent verifies it exactly as
 * any other (it needs no change for automation).
 */

export const AUTOMATION_SCHEMA = 'rem0te-automation-policy/1';
/** Domain separation for the document's digest and for the signer's signature over an approved one. */
export const AUTOMATION_DIGEST_PREFIX = 'rem0te-automation-policy-v1\n';
export const AUTOMATION_SIGNING_PREFIX = 'rem0te-automation-policy-approved-v1\n';
/** The most computers one occurrence's plan names (the actions' own maxTargets). */
export const MAX_AUTOMATION_TARGETS = MAX_RING_TARGETS;
/** Plans the signer signs in one occurrence: the first and at most two more for computers that were missed. */
export const MAX_RUNS_PER_OCCURRENCE = 3;
/** An hourly schedule runs every this many hours, counted from local midnight. */
export const HOURLY_EVERY = [1, 2, 3, 4, 6, 8, 12] as const;
/** "Skip a computer that is offline": its plan is valid this long after it is signed, so a computer must be online when the occurrence opens. */
export const SKIP_GRACE_MINUTES = 15;
/** "Expire after N hours": N is 1 to this. */
export const MAX_EXPIRE_HOURS = 24;
export const MAX_AUTOMATION_DAYS = MAX_POLICY_DAYS;
export const AUTOMATION_PROPOSAL_DAYS = POLICY_PROPOSAL_DAYS;
/** The signer accepts plans this many minutes behind its clock. */
const CLOCK_SKEW_MS = 5 * 60_000;

const Id = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
const Hex32 = z.string().regex(/^[a-f0-9]{32}$/);
const Hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const Iso = z.string().datetime();
const Timezone = z.string().min(1).max(64).refine(validTimezone, 'not a timezone this runtime knows (IANA name, e.g. America/Chicago)');

// ── The task ────────────────────────────────────────────────────────────────

/** Run one approved library version: exactly the windows.script.run@1 params and the signer allowlist block a one-off run carries. */
export const ScriptTask = z.object({
  kind: z.literal('script'),
  params: ScriptRunParams,
  script: ScriptBlock,
}).strict();
/** Install or uninstall one catalog entry, at the revision it had when the policy was made. */
export const SOFTWARE_OPERATIONS = ['install', 'uninstall'] as const;
export const SoftwareTask = z.object({
  kind: z.literal('software'),
  operation: z.enum(SOFTWARE_OPERATIONS),
  params: SoftwareParams,
  display: SoftwareDisplay,
}).strict();
/**
 * 0.60: restart computers inside the schedule's windows (the simple restart
 * window). `if_required`: only a computer Windows says needs a restart is
 * planned, and the plan carries onlyIfRequired, so the agent decides again
 * from Windows' own state. `always`: a maintenance restart, once per window.
 * `ignoreRemoteSession` is present only when true and only if a person ticked
 * it (never by default, §67); the 15-minute warning always shows.
 */
export const RestartTask = z.object({
  kind: z.literal('restart'),
  rule: z.enum(RESTART_RULES),
  ignoreRemoteSession: z.literal(true).optional(),
}).strict();
export type RestartTask = z.infer<typeof RestartTask>;
export const AutomationTask = z.discriminatedUnion('kind', [ScriptTask, SoftwareTask, RestartTask]);
export type AutomationTask = z.infer<typeof AutomationTask>;

/** The fixed warning before a restart window's restart: the update restart's 15 minutes. The signer accepts no other. */
export const RESTART_WINDOW_DELAY_MINUTES = POLICY_RESTART_DELAY_MINUTES;
/** A restart window shorter than this cannot fit a plan and its warning; it is refused. */
export const MIN_RESTART_WINDOW_MINUTES = 30;

/** The exact windows.reboot.schedule params a restart task's plans carry. The signer compares them canonically. */
export function restartParamsFor(t: Pick<RestartTask, 'rule' | 'ignoreRemoteSession'>): { delayMinutes: number; onlyIfRequired?: true; ignoreRemoteSession?: true } {
  return {
    delayMinutes: RESTART_WINDOW_DELAY_MINUTES,
    ...(t.rule === 'if_required' ? { onlyIfRequired: true as const } : {}),
    ...(t.ignoreRemoteSession === true ? { ignoreRemoteSession: true as const } : {}),
  };
}

/** The catalog action a task's plans name. */
export function taskAction(t: Pick<AutomationTask, 'kind'> & { operation?: string }): { id: string; version: 1 } {
  if (t.kind === 'restart') return { id: REBOOT_SCHEDULE.id, version: 1 };
  if (t.kind === 'script') return { id: SCRIPT_RUN_ACTION, version: 1 };
  return { id: t.operation === 'uninstall' ? 'windows.software.uninstall' : 'windows.software.install', version: 1 };
}

// ── The targets ─────────────────────────────────────────────────────────────

/** One computer, as enrolled: the identity the agent checks, so a re-enrolled computer is a different one. */
export const AutomationComputer = z.object({
  endpointId: Id,
  hostname: z.string().max(64),
  rustdeskId: z.string().regex(/^[0-9]{6,15}$/),
  deviceSecretSha256: Hex64,
}).strict();
export type AutomationComputer = z.infer<typeof AutomationComputer>;
export const ComputersTarget = z.object({
  kind: z.literal('computers'),
  computers: z.array(AutomationComputer).min(1).max(MAX_AUTOMATION_TARGETS),
}).strict();
/**
 * One device group of the policy's business. Its members are worked out by
 * the portal at each occurrence (the group-policy membership code), and the
 * signer can check only that each one is of this business and that there
 * are at most `maxTargets` — it cannot know the group. The approval page
 * says so; name computers instead where that matters.
 */
export const GroupTarget = z.object({
  kind: z.literal('group'),
  groupId: Id,
  groupName: z.string().min(1).max(120),
  maxTargets: z.number().int().min(1).max(MAX_AUTOMATION_TARGETS),
}).strict();
/**
 * 0.60, restart task only: every computer of the policy's business. The
 * portal decides which of them this window governs (a computer's own
 * setting, then a device group's, then the business's); the signer checks
 * only that the computer is of this business. The approval page says so.
 */
export const BusinessTarget = z.object({ kind: z.literal('business') }).strict();
/**
 * 0.60, restart task only: every member of one device group, with no
 * per-run cap (a restart plan names one computer, and a group may be larger
 * than 25). The signer cannot see the group; it checks the business only.
 */
export const GroupMembersTarget = z.object({
  kind: z.literal('group_members'),
  groupId: Id,
  groupName: z.string().min(1).max(120),
}).strict();
export const RESTART_ONLY_TARGETS = ['business', 'group_members'] as const;
export const AutomationTargets = z.discriminatedUnion('kind', [ComputersTarget, GroupTarget, BusinessTarget, GroupMembersTarget]);
export type AutomationTargets = z.infer<typeof AutomationTargets>;

// ── The recurrence ──────────────────────────────────────────────────────────

/**
 * Every `everyHours` hours from local midnight, at `minute` past, for
 * `windowMinutes`. This shape is automation's own: the patch policy's window
 * union (§66) is not widened, so no patch document changes.
 */
export const HourlyRecurrence = z.object({
  kind: z.literal('hourly'),
  everyHours: z.number().int().refine((n) => (HOURLY_EVERY as readonly number[]).includes(n), `one of ${HOURLY_EVERY.join(', ')} hours`),
  minute: z.number().int().min(0).max(59),
  windowMinutes: z.number().int().min(15).max(12 * 60),
  timezone: Timezone,
}).strict().refine((r) => r.windowMinutes <= r.everyHours * 60, 'the window must close before the next run opens');
export type HourlyRecurrence = z.infer<typeof HourlyRecurrence>;

/**
 * The schedule: a closed union of hourly and the patch policy's three window
 * shapes (weekly — every day of the week is "daily" — and the two monthly
 * ones). Anything else matches none of them and is refused by the portal and
 * the signer; the occurrence functions below fail closed on it too.
 */
export const AutomationRecurrence = z.union([HourlyRecurrence, PolicyWindow]);
export type AutomationRecurrence = z.infer<typeof AutomationRecurrence>;

/** Which kind of schedule this is, or null for any other shape (never opens). */
export function recurrenceKind(r: unknown): 'hourly' | 'weekly' | 'monthly' | null {
  if (!r || typeof r !== 'object') return null;
  const o = r as Record<string, unknown>;
  if (o.kind === 'hourly') {
    return (HOURLY_EVERY as readonly unknown[]).includes(o.everyHours) && Number.isInteger(o.minute) && (o.minute as number) >= 0 && (o.minute as number) <= 59
      && Number.isInteger(o.windowMinutes) && (o.windowMinutes as number) >= 15 && (o.windowMinutes as number) <= (o.everyHours as number) * 60
      && typeof o.timezone === 'string' && !('days' in o) ? 'hourly' : null;
  }
  return windowKind(r);
}

const addDays = (y: number, m: number, d: number, n: number) => { const t = new Date(Date.UTC(y, m - 1, d + n)); return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }; };
type Occ = { start: Date; end: Date };
type PatchWindowArg = Parameters<typeof occurrenceAt>[1];

/** The hourly occurrences that begin on these local days, de-duplicated (a skipped DST hour lands on the next), in order. */
function hourlyOn(around: Date, r: HourlyRecurrence, days: number[]): Occ[] {
  const l = localTime(around, r.timezone);
  const out = new Map<number, Occ>();
  for (const n of days) {
    const d = addDays(l.y, l.m, l.d, n);
    for (let h = 0; h < 24; h += r.everyHours) {
      const start = zonedToUtc(d.y, d.m, d.d, h, r.minute, r.timezone);
      if (!out.has(start.getTime())) out.set(start.getTime(), { start, end: new Date(start.getTime() + r.windowMinutes * 60_000) });
    }
  }
  return [...out.values()].sort((a, b) => a.start.getTime() - b.start.getTime());
}

/** The occurrence of the schedule that contains instant t, or null. The signer and the portal both decide from this. */
export function automationOccurrenceAt(t: Date, r: AutomationRecurrence): Occ | null {
  const kind = recurrenceKind(r);
  if (!kind) return null;
  if (kind !== 'hourly') return occurrenceAt(t, r as PatchWindowArg);
  return hourlyOn(t, r as HourlyRecurrence, [-1, 0]).find((o) => o.start <= t && t < o.end) ?? null;
}

/** The first occurrence that has not ended by `after` (it may be open now), before `until` if given. */
export function automationNextOccurrence(after: Date, r: AutomationRecurrence, until?: Date): Occ | null {
  const kind = recurrenceKind(r);
  if (!kind) return null;
  if (kind !== 'hourly') return nextOccurrence(after, r as PatchWindowArg, until);
  const o = hourlyOn(after, r as HourlyRecurrence, [-1, 0, 1, 2]).find((x) => x.end > after) ?? null;
  return !o || (until && o.start >= until) ? null : o;
}

/** The next `count` occurrences (at most 12). What the editor previews and the pages show. */
export function automationNextOccurrences(after: Date, r: AutomationRecurrence, count: number, until?: Date): Occ[] {
  const out: Occ[] = [];
  let t = after;
  for (let i = 0; i < Math.min(Math.max(count, 0), 12); i++) {
    const o = automationNextOccurrence(t, r, until);
    if (!o) break;
    out.push(o);
    t = o.end;
  }
  return out;
}

/** The schedule in words, as the signer's page and the portal's list say it. */
export function recurrenceInWords(r: AutomationRecurrence): string {
  const kind = recurrenceKind(r);
  if (kind === 'hourly') {
    const h = r as HourlyRecurrence;
    const mm = String(h.minute).padStart(2, '0');
    return `${h.everyHours === 1 ? 'Every hour' : `Every ${h.everyHours} hours`} at :${mm} (from 00:${mm}), running for up to ${h.windowMinutes} minutes, ${h.timezone}`;
  }
  if (kind === 'weekly' && (r as { days: string[] }).days.length === 7) {
    const w = r as { start: string; end: string; timezone: string };
    return `Daily ${w.start}–${w.end} ${w.timezone}`;
  }
  if (kind) return describePolicyWindow(r as PatchWindowArg);
  return 'an unrecognised schedule (it never runs)';
}

// ── Offline behaviour ───────────────────────────────────────────────────────

/**
 * What happens to a computer that is not online when an occurrence opens.
 * It is never a portal-side guess: the choice is signed, and becomes each
 * plan's signed notAfter, past which the agent refuses the plan as expired.
 *
 *   run_when_online   the plan stays valid until the occurrence's window
 *                     closes: a computer that comes online inside the window
 *                     runs it then.
 *   skip_if_offline   the plan is valid for SKIP_GRACE_MINUTES only, and the
 *                     portal names only computers online at that moment: a
 *                     computer offline when the window opens misses it.
 *   expire_after      the plan is valid for `hours` after the occurrence
 *                     opened, even past the window's end.
 */
export const OFFLINE_MODES = ['run_when_online', 'skip_if_offline', 'expire_after'] as const;
export type OfflineMode = (typeof OFFLINE_MODES)[number];
export const AutomationOffline = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('run_when_online') }).strict(),
  z.object({ mode: z.literal('skip_if_offline') }).strict(),
  z.object({ mode: z.literal('expire_after'), hours: z.number().int().min(1).max(MAX_EXPIRE_HOURS) }).strict(),
]);
export type AutomationOffline = z.infer<typeof AutomationOffline>;

export function offlineInWords(o: AutomationOffline): string {
  if (o.mode === 'run_when_online') return 'a computer that is offline runs it when it is next online, while the window is still open';
  if (o.mode === 'skip_if_offline') return `a computer that is offline when the window opens is skipped (each plan is valid for ${SKIP_GRACE_MINUTES} minutes)`;
  if (o.mode === 'expire_after') return `a computer that is offline runs it when it is next online, up to ${o.hours} hour${o.hours === 1 ? '' : 's'} after the window opened`;
  return 'an unrecognised offline rule (nothing is signed)';
}

/**
 * The latest notAfter a plan starting at `notBefore` in occurrence `occ` may
 * carry under this document. The portal uses exactly this; the signer refuses
 * anything later (offline_rule_mismatch). Never past expiry (if it has one), never longer than
 * any plan's 24 hours. Null for an unknown offline rule (fail closed).
 */
export function latestNotAfter(doc: Pick<AutomationDoc, 'offline' | 'expiresAt' | 'expiry'>, occ: Occ, notBefore: Date): Date | null {
  const o = doc.offline as { mode?: unknown; hours?: unknown };
  let end: number;
  if (o.mode === 'run_when_online') end = occ.end.getTime();
  else if (o.mode === 'skip_if_offline') end = Math.min(occ.end.getTime(), notBefore.getTime() + SKIP_GRACE_MINUTES * 60_000);
  else if (o.mode === 'expire_after' && Number.isInteger(o.hours) && (o.hours as number) >= 1 && (o.hours as number) <= MAX_EXPIRE_HOURS) end = occ.start.getTime() + (o.hours as number) * 3_600_000;
  else return null;
  // 0.63: Infinity for a signed "never"; an unreadable expiry signs nothing.
  const exp = expiryMsOf(doc);
  if (exp === null) return null;
  return new Date(Math.min(end, notBefore.getTime() + MAX_WINDOW_HOURS * 3_600_000, exp));
}

// ── The document ────────────────────────────────────────────────────────────

export const AutomationDoc = z.object({
  schema: z.literal(AUTOMATION_SCHEMA),
  policyId: Hex32,
  name: z.string().min(3).max(120),
  businessId: Id,
  businessName: z.string().max(120),
  task: AutomationTask,
  targets: AutomationTargets,
  recurrence: AutomationRecurrence,
  offline: AutomationOffline,
  /** Plans the signer signs per occurrence: 1, or up to 3 when computers missed by the first may be tried again inside the window. */
  maxRunsPerOccurrence: z.number().int().min(1).max(MAX_RUNS_PER_OCCURRENCE),
  /** A revision names the policy it replaces. Widening is always a new document, approved again; never an edit. */
  supersedes: Hex32.optional(),
  createdAt: Iso,
  /** When the policy stops. Present in every document before 0.63, which keep their bytes and expiry. Absent exactly when `expiry` is "never". */
  expiresAt: Iso.optional(),
  /** 0.63: "never" — stands until revoked or paused. The same field and rules as a patch policy's (`expiryMsOf`). */
  expiry: z.literal(EXPIRY_NEVER).optional(),
  createdBy: z.object({ userId: Id, name: z.string().max(120) }).strict(),
  reason: z.string().min(3).max(500),
}).strict();
export type AutomationDoc = z.infer<typeof AutomationDoc>;

export function automationDigest(doc: AutomationDoc): string {
  return createHash('sha256').update(AUTOMATION_DIGEST_PREFIX).update(canonicalJson(doc)).digest('hex');
}

export interface AutomationApproval { userId: string; name: string; role: 'approver' | 'customer'; credentialSha256: string; at: string }

/** The bytes the signer signs when a document reaches its quorum: the document and who approved it. */
export function automationSigningBytes(doc: AutomationDoc, approvals: AutomationApproval[]): Buffer {
  return Buffer.from(AUTOMATION_SIGNING_PREFIX + canonicalJson({ digest: automationDigest(doc), approvals }), 'utf8');
}

type Problem = { ok: true } | { ok: false; reason: string; message: string };
const bad = (reason: string, message: string): Problem => ({ ok: false, reason, message });

/** Rules a schema cannot say. Checked by the portal before it proposes, and by the signer before it admits. */
export function validateAutomationDoc(doc: AutomationDoc, now: Date): Problem {
  // 0.63: an expiry date (0.58's rules), or a signed "never"; anything else is refused.
  const ex = expiryProblem(doc, now, MAX_AUTOMATION_DAYS, 'automation policy');
  if (ex) return bad(ex.reason, ex.message);
  const until = expiryUntil(doc), created = Date.parse(doc.createdAt);
  if (created > now.getTime() + CLOCK_SKEW_MS) return bad('bad_created', 'The policy is dated in the future.');
  if (!recurrenceKind(doc.recurrence)) return bad('schedule_unknown', 'The schedule is not one this version knows.');
  if (!automationNextOccurrence(now, doc.recurrence, until)) return bad('never_runs', 'The schedule never opens before the policy expires.');
  const o = doc.offline as { mode?: unknown };
  if (!(OFFLINE_MODES as readonly unknown[]).includes(o.mode)) return bad('offline_rule_unknown', 'The offline rule is not one this version knows.');
  const t = doc.task;
  if (t.kind === 'script') {
    const s = t.script;
    if (t.params.sha256 !== s.contentSha256 || t.params.scriptVersionId !== s.versionId) return bad('script_mismatch', 'The script parameters do not name the allowlisted version.');
    if (definitionSha256(s) !== s.definitionSha256) return bad('script_mismatch', 'The script block does not hash to its definition.');
    if (s.businessId !== null && s.businessId !== doc.businessId) return bad('script_wrong_business', 'This script belongs to another business.');
    const why = argumentsProblem(s.parameters, t.params.parameters);
    if (why) return bad('arguments_not_allowed', `The arguments do not match the script's declared parameters: ${why}.`);
  }
  if (doc.targets.kind === 'computers') {
    const cs = doc.targets.computers;
    if (new Set(cs.map((c) => c.endpointId)).size !== cs.length || new Set(cs.map((c) => c.rustdeskId)).size !== cs.length) return bad('duplicate_target', 'A computer is named twice.');
  }
  // 0.60: the restart task and its two target kinds go together, and only together.
  const restartOnly = (RESTART_ONLY_TARGETS as readonly string[]).includes(doc.targets.kind);
  if (t.kind !== 'restart') {
    if (restartOnly) return bad('target_restart_only', 'Only a restart window may name a whole business or every member of a group.');
    return { ok: true };
  }
  if (doc.targets.kind === 'group') return bad('restart_target_kind', 'A restart window names computers, a business, or every member of a group (group_members).');
  if (recurrenceKind(doc.recurrence) === 'hourly') return bad('restart_schedule_kind', 'A restart window is daily, weekly or monthly, never hourly.');
  if (doc.offline.mode !== 'run_when_online') return bad('restart_offline_rule', 'A restart window\'s plans are bounded by the window and the warning; its offline rule is run_when_online.');
  const first = automationNextOccurrence(now, doc.recurrence, until);
  if (first && first.end.getTime() - first.start.getTime() < MIN_RESTART_WINDOW_MINUTES * 60_000) {
    return bad('restart_window_too_short', `A restart window is at least ${MIN_RESTART_WINDOW_MINUTES} minutes long: the computer picks the plan up and then warns for ${RESTART_WINDOW_DELAY_MINUTES} minutes, and the restart must fall inside the window.`);
  }
  return { ok: true };
}

/**
 * The quorum a document needs: two distinct approvers who are not its author
 * (every task here is high impact), and a customer sign-off where the
 * business requires one. In direct mode (§58) none: the signer activates it at
 * admission, and it stops counting the moment the business leaves direct mode.
 */
export function automationQuorum(doc: Pick<AutomationDoc, 'createdBy'>, approvals: AutomationApproval[], customerSignoff: boolean, direct = false): boolean {
  if (direct) return !customerSignoff;
  const approvers = new Set(approvals.filter((a) => a.role === 'approver' && a.userId !== doc.createdBy.userId).map((a) => a.userId));
  if (approvers.size < APPROVALS_REQUIRED.high) return false;
  if (customerSignoff && !approvals.some((a) => a.role === 'customer' && a.userId !== doc.createdBy.userId && !approvers.has(a.userId))) return false;
  return true;
}

// ── The signer's decision ───────────────────────────────────────────────────

export type AutomationStatus = 'AWAITING_APPROVAL' | 'ACTIVE' | 'REJECTED' | 'REVOKED' | 'EXPIRED';
/** One plan the signer signed under a policy: its ledger, on the signer's own disk. */
export interface AutomationLedgerEntry {
  jobId: string;
  /** The occurrence's UTC start: the key the per-occurrence limits count by. */
  occurrence: string;
  signedAt: string; notBefore: string; notAfter: string; endpointIds: string[];
  planSha256: string;
}
export interface AutomationState {
  doc: AutomationDoc;
  digest: string;
  status: AutomationStatus;
  approvals: AutomationApproval[];
  /** Did this signer's signature over (doc, approvals) verify? Computed by the signer with its own key. */
  signatureValid: boolean;
  revokedAt: string | null;
  ledger: AutomationLedgerEntry[];
}
export interface AutomationPlanRequest { plan: Plan; policyDigest: string }
export type AutomationDecision = { ok: true; occurrence: string } | { ok: false; code: string; message: string };

const no = (code: string, message: string): AutomationDecision => ({ ok: false, code, message });

/**
 * Is this plan inside the automation policy? Every refusal is its own code,
 * because each is a different thing a compromised portal might try. The
 * signer runs its ordinary admission (admitPlan) as well: the catalog, the
 * script allowlist and the software revocations decide there.
 */
export function evaluateAutomationPlan(s: AutomationState, r: AutomationPlanRequest, opts: { now: Date; customerSignoff: boolean; direct?: boolean }): AutomationDecision {
  const { doc } = s, p = r.plan, now = opts.now;
  // The policy itself.
  if (s.revokedAt || s.status === 'REVOKED') return no('policy_revoked', 'This automation policy was revoked; nothing more is signed under it.');
  if (automationDigest(doc) !== s.digest || r.policyDigest !== s.digest) return no('policy_digest_mismatch', 'The policy digest does not match the approved policy.');
  // 0.63: a signed "never" never expires; neither, both or anything else is refused, never read as "never".
  const exp = expiryMsOf(doc);
  if (exp === null) return no('expiry_unknown', 'The policy\'s expiry is not one this signer knows; nothing is signed under it.');
  if (now.getTime() >= exp) return no('policy_expired', 'This automation policy has expired. Approve a new one.');
  if (s.status !== 'ACTIVE') return no('policy_not_active', `This automation policy is ${s.status.toLowerCase().replace(/_/g, ' ')}.`);
  if (!s.signatureValid) return no('policy_signature_invalid', 'The stored policy does not verify against this signer\'s key.');
  if (!automationQuorum(doc, s.approvals, false, opts.direct === true)) return no('policy_not_approved', 'This policy does not carry two approvals from people other than its author (a policy activated in direct mode stops counting when the business leaves direct mode).');
  if (!automationQuorum(doc, s.approvals, opts.customerSignoff, opts.direct === true)) return no('policy_mismatch', 'This business now requires customer sign-off, which this policy was not approved with. Approve a new policy.');
  if (Date.parse(p.window.notAfter) > exp) return no('policy_expired', 'The plan would run past the policy\'s expiry.');
  // 0.60: a restart window is decided by its own rules, after the same standing checks.
  if (doc.task.kind === 'restart') return evaluateAutomationRestart(s, r, now);

  // The task: exactly the signed one.
  const want = taskAction(doc.task);
  if (p.action.id !== want.id || p.action.version !== want.version) return no('action_not_in_policy', `This policy signs ${want.id}@${want.version} only.`);
  if (canonical(p.params) !== canonical(doc.task.params)) return no('params_not_in_policy', 'The plan\'s parameters are not exactly the policy\'s.');
  if (doc.task.kind === 'script') {
    if (!p.script || canonical(p.script) !== canonical(doc.task.script)) return no('script_not_in_policy', 'The plan does not run the script version this policy names.');
    if (p.display?.software) return no('bad_display', 'A script plan names no software.');
  } else if (doc.task.kind === 'software') {
    if (p.script) return no('script_not_in_policy', 'A software plan runs no script.');
    if (!p.display?.software || canonical(p.display.software) !== canonical(doc.task.display)) return no('software_not_in_policy', 'The plan does not name the catalog entry and revision this policy names.');
  } else return no('action_not_in_policy', 'The policy\'s task is not one this signer knows.');
  if (p.display?.policy?.id !== doc.policyId || p.display.policy.digest !== s.digest) return no('bad_display', 'The plan must name this policy.');
  if (p.display.deployment || (p.display.updates ?? []).length) return no('bad_display', 'An automation plan names no deployment and no update.');
  if (p.requestedBy.userId !== doc.createdBy.userId) return no('requester_mismatch', 'An automation plan is requested on behalf of the policy\'s author.');

  // The computers.
  if (p.targets.some((t) => t.businessId !== doc.businessId)) return no('computer_not_in_policy', 'A computer of another business.');
  if (doc.targets.kind === 'computers') {
    const allowed = new Map(doc.targets.computers.map((c) => [c.endpointId, c]));
    for (const t of p.targets) {
      const c = allowed.get(t.endpointId);
      if (!c || t.rustdeskId !== c.rustdeskId || t.deviceSecretSha256 !== c.deviceSecretSha256) {
        return no('computer_not_in_policy', `${t.hostname} is not named by this policy, or is not the computer that was approved (its enrolled identity differs).`);
      }
    }
  } else if (doc.targets.kind === 'group') {
    if (p.targets.length > doc.targets.maxTargets) return no('too_many_targets', `This policy runs on at most ${doc.targets.maxTargets} computer(s) of "${doc.targets.groupName}" per occurrence.`);
  } else return no('computer_not_in_policy', 'The policy\'s targets are not a kind this signer knows.');

  // When: inside an occurrence, and no longer than the offline rule allows.
  const nb = new Date(p.window.notBefore), na = new Date(p.window.notAfter);
  const occ = automationOccurrenceAt(nb, doc.recurrence);
  if (!occ) return no('outside_schedule', `The plan must start inside the policy's schedule (${recurrenceInWords(doc.recurrence)}).`);
  if (nb.getTime() < now.getTime() - CLOCK_SKEW_MS) return no('outside_schedule', 'The plan starts in the past.');
  if (nb.getTime() > now.getTime() + CLOCK_SKEW_MS) return no('outside_schedule', 'An automation plan starts when it is signed, not later.');
  const latest = latestNotAfter(doc, occ, nb);
  if (!latest) return no('offline_rule_unknown', 'The policy\'s offline rule is not one this signer knows; nothing is signed under it.');
  if (!(na > nb) || na.getTime() > latest.getTime()) return no('offline_rule_mismatch', `The plan must close by ${latest.toISOString()} (${offlineInWords(doc.offline)}).`);

  // No overlap and the per-occurrence limit, from this signer's own ledger.
  const key = occ.start.toISOString();
  const open = s.ledger.find((e) => Date.parse(e.notAfter) > now.getTime());
  if (open) return no('previous_run_open', `An earlier plan under this policy (${open.jobId}) is still open until ${open.notAfter}. Runs never overlap.`);
  const mine = s.ledger.filter((e) => e.occurrence === key);
  if (mine.length >= doc.maxRunsPerOccurrence) return no('occurrence_run_limit', `${mine.length} plan(s) were already signed in this occurrence; the policy allows ${doc.maxRunsPerOccurrence}.`);
  const done = new Set(mine.flatMap((e) => e.endpointIds));
  const again = p.targets.find((t) => done.has(t.endpointId));
  if (again) return no('already_ran_this_occurrence', `${again.hostname} was already named in a plan of this occurrence.`);
  return { ok: true, occurrence: key };
}

/**
 * 0.60: a restart plan under a restart window. Reached only from
 * evaluateAutomationPlan, after the policy's own standing (revocation,
 * digest, expiry, status, signature, quorum). Every refusal is its own code.
 *
 * One computer per plan, with exactly the rule's params (the fixed warning,
 * onlyIfRequired under "if required", the RustDesk exception only if the
 * document has it); a computer of this business (or, for named computers,
 * that enrolled identity); received by notAfter and restarted the warning
 * later, still inside the window; at most MAX_RESTART_PLAN_HOURS long; never
 * while that computer's earlier plan is open; and at most
 * `maxRunsPerOccurrence` plans per computer per occurrence — the retry
 * budget. The next occurrence starts afresh.
 */
export function evaluateAutomationRestart(s: AutomationState, r: AutomationPlanRequest, now: Date): AutomationDecision {
  const { doc } = s, p = r.plan;
  const t = doc.task as { kind: string; rule?: unknown; ignoreRemoteSession?: unknown };
  if (t.kind !== 'restart' || !(RESTART_RULES as readonly unknown[]).includes(t.rule)) return no('restart_rule_unknown', 'The restart rule is not one this signer knows; nothing is restarted under it.');
  if (p.action.id !== REBOOT_SCHEDULE.id || p.action.version !== REBOOT_SCHEDULE.version) return no('action_not_in_policy', 'A restart window signs windows.reboot.schedule@1 only.');
  const want = restartParamsFor({ rule: t.rule as RestartTask['rule'], ignoreRemoteSession: t.ignoreRemoteSession === true ? true : undefined });
  const got = p.params as Record<string, unknown>;
  if (got.ignoreRemoteSession !== undefined && want.ignoreRemoteSession !== true) return no('override_not_allowed', 'The plan asks to restart even with a technician connected through RustDesk, which this restart window does not allow.');
  if (canonical(got) !== canonical(want)) return no('restart_params_not_allowed', `A restart window's plan gives the fixed ${RESTART_WINDOW_DELAY_MINUTES}-minute warning${want.onlyIfRequired ? ', asks the computer to restart only if Windows needs it (onlyIfRequired),' : ''} and nothing else.`);
  if (p.script) return no('script_not_in_policy', 'A restart plan runs no script.');
  if (p.display?.software || p.display?.deployment || (p.display?.updates ?? []).length) return no('bad_display', 'A restart plan names no software, deployment or update.');
  if (p.display?.policy?.id !== doc.policyId || p.display.policy.digest !== s.digest) return no('bad_display', 'The plan must name this restart window.');
  if (p.requestedBy.userId !== doc.createdBy.userId) return no('requester_mismatch', 'A restart window\'s plan is requested on behalf of the person who set the window.');
  if (p.targets.length !== 1) return no('computer_not_in_policy', 'A restart plan names one computer.');
  const tg = p.targets[0];
  if (tg.businessId !== doc.businessId) return no('computer_not_in_policy', `${tg.hostname} is not a computer of ${doc.businessName}.`);
  if (doc.targets.kind === 'computers') {
    const c = doc.targets.computers.find((x) => x.endpointId === tg.endpointId);
    if (!c || tg.rustdeskId !== c.rustdeskId || tg.deviceSecretSha256 !== c.deviceSecretSha256) return no('computer_not_in_policy', `${tg.hostname} is not named by this restart window, or is not the computer that was approved (its enrolled identity differs).`);
  } else if (doc.targets.kind !== 'business' && doc.targets.kind !== 'group_members') {
    return no('computer_not_in_policy', 'The restart window\'s targets are not a kind this signer knows.');
  }
  // Inside the window: picked up by notAfter at the latest, restarted the fixed warning later, before the window closes.
  const nb = new Date(p.window.notBefore), na = new Date(p.window.notAfter);
  const occ = recurrenceKind(doc.recurrence) === 'hourly' ? null : automationOccurrenceAt(nb, doc.recurrence);
  if (!occ || na.getTime() + RESTART_WINDOW_DELAY_MINUTES * 60_000 > occ.end.getTime()) return no('outside_restart_window', `The restart must happen inside the restart window (${recurrenceInWords(doc.recurrence)}).`);
  if (nb.getTime() < now.getTime() - CLOCK_SKEW_MS) return no('outside_restart_window', 'The plan starts in the past.');
  if (nb.getTime() > now.getTime() + CLOCK_SKEW_MS) return no('outside_restart_window', 'A restart window\'s plan starts when it is signed, not later.');
  if (!(na > nb) || na.getTime() - nb.getTime() > MAX_RESTART_PLAN_HOURS * 3_600_000) return no('outside_restart_window', `A restart plan runs for at most ${MAX_RESTART_PLAN_HOURS} hours.`);
  // Per computer, from this signer's own ledger.
  const key = occ.start.toISOString();
  const mine = s.ledger.filter((e) => e.occurrence === key && e.endpointIds.includes(tg.endpointId));
  if (mine.some((e) => Date.parse(e.notAfter) > now.getTime())) return no('restart_already_signed', `A restart of ${tg.hostname} in this window is already signed and its plan is still open.`);
  if (mine.length >= doc.maxRunsPerOccurrence) return no('restart_retry_limit', `${tg.hostname} has had ${mine.length} restart plan(s) signed in this window; the window allows ${doc.maxRunsPerOccurrence}. The next window tries again.`);
  return { ok: true, occurrence: key };
}

/** 0.60: a restart window's ledger keeps this long; its decisions never look further back than one occurrence (at most a day). */
export const RESTART_LEDGER_KEEP_DAYS = 8;

/** The ledger entry the signer appends when it signs a plan under a policy. */
export function automationLedgerEntry(p: Plan, occurrence: string, signedAt: Date, planSha256: string): AutomationLedgerEntry {
  return { jobId: p.jobId, occurrence, signedAt: signedAt.toISOString(), notBefore: p.window.notBefore, notAfter: p.window.notAfter, endpointIds: p.targets.map((t) => t.endpointId), planSha256 };
}

/** The task in words for the approval page and the portal's list. */
export function taskInWords(t: AutomationTask): string {
  if (t.kind === 'restart') {
    const base = t.rule === 'if_required'
      ? `Restart a computer if Windows says it needs a restart (the computer checks again first), with the fixed ${RESTART_WINDOW_DELAY_MINUTES}-minute warning`
      : t.rule === 'always'
        ? `Restart every computer once in each window, whether or not Windows asks for it (maintenance restart), with the fixed ${RESTART_WINDOW_DELAY_MINUTES}-minute warning`
        : 'an unrecognised restart rule (nothing is restarted)';
    return `${base}${t.ignoreRemoteSession === true ? '; it restarts even if a technician is connected through RustDesk (their session is dropped)' : '; never while a technician is connected through RustDesk'}`;
  }
  if (t.kind === 'script') {
    const args = Object.entries(t.params.parameters);
    return `Run "${t.script.name}" v${t.script.version} (SHA-256 ${t.script.contentSha256.slice(0, 12)}…)${args.length ? ` with ${args.map(([k, v]) => `-${k} ${JSON.stringify(v)}`).join(' ')}` : ''}, timeout ${t.params.timeoutMinutes} min`;
  }
  return `${t.operation === 'install' ? 'Install' : 'Uninstall'} ${t.display.name} ${t.params.version} (winget ${t.params.packageId})`;
}

/** 0.60: the targets in words, for the approval page and the portal. */
export function targetsInWords(t: AutomationTargets, businessName: string): string {
  if (t.kind === 'computers') return t.computers.length === 1 ? t.computers[0].hostname : `${t.computers.length} named computers`;
  if (t.kind === 'group') return `group "${t.groupName}" (at most ${t.maxTargets} per run)`;
  if (t.kind === 'business') return `every computer of ${businessName} that this window governs`;
  if (t.kind === 'group_members') return `every member of group "${t.groupName}" that this window governs`;
  return 'unrecognised targets';
}
