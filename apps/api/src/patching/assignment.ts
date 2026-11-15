import { createHash } from 'node:crypto';
import { z } from 'zod';
import { MAX_RING_TARGETS, UpdateReboot } from '../actions/catalog';
import { MAX_POLICY_DAYS, MAX_POLICY_RINGS, PolicyAllow, PolicyWindow, type PolicyComputer, PolicyRestart } from '../actions/patch-policy';

/**
 * Company-wide and assignable patch policies (0.50): the pure part.
 *
 * A series is a policy that revises itself. Its signed document is still a
 * closed list of named computers in rings — exactly what a policy made by
 * hand is — so the approval signer's guarantee does not change: it signs a
 * ring plan only inside the document it holds. What changes is who writes the
 * list. For a series, the portal does, from the business's computers and each
 * one's Patch policy setting, and proposes a *revision* (a new document,
 * through the same admission path) when the list it would write differs from
 * the one running, or the running one is about to expire.
 *
 * No clock but the one passed in, no I/O, no Nest, no Prisma: the unit suite
 * (scripts/unit-patch-assignment.mjs) runs these directly.
 */

export const SERIES_SCOPES = ['business', 'assigned'] as const;
export type SeriesScope = (typeof SERIES_SCOPES)[number];
export const OVERRIDE_MODES = ['inherit', 'exclude', 'policy'] as const;
export type OverrideMode = (typeof OVERRIDE_MODES)[number];

/** A canary and four rings of 25. */
export const MAX_POLICY_COMPUTERS = 1 + (MAX_POLICY_RINGS - 1) * MAX_RING_TARGETS;

/** The floor on the bound: one minute (a test stack, NODE_ENV=test, may go to three seconds). */
export function revisionFloorMinutes(): number { return process.env.NODE_ENV === 'test' ? 0.05 : 1; }
/** Revisions proposed by the sweep: at most one pass per business per this many minutes (default 60). */
export function revisionMinutes(): number {
  const n = Number(process.env.PATCH_POLICY_REVISION_MINUTES);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.max(n, revisionFloorMinutes()), 24 * 60) : 60;
}
/** A change of computers must hold this long before it is proposed (debounce). */
export function settleMinutes(): number {
  const n = Number(process.env.PATCH_POLICY_SETTLE_MINUTES);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 24 * 60) : 10;
}
/** Renew this long before expiry: seven days, or a third of a short policy's life. */
export function renewLeadMs(expiresInDays: number): number {
  return Math.min(7 * 86_400_000, Math.floor((expiresInDays * 86_400_000) / 3));
}

const Id = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

/** What a series is created with, fixed for its life (retire it and create another to change it). */
export const SeriesSettings = z.object({
  allow: PolicyAllow,
  soakHours: z.number().int().min(0).max(168).default(24),
  failureThreshold: z.number().int().min(0).max(MAX_RING_TARGETS).default(0),
  window: PolicyWindow,
  reboot: UpdateReboot.default('never'),
  /** 0.54: a restart window and rule, carried into every revision. Absent in series made before 0.54. */
  restart: PolicyRestart.optional(),
  /** 0.54: the RustDesk-session exception for the series' restarts. Present only when ticked. */
  ignoreRemoteSession: z.literal(true).optional(),
  expiresInDays: z.number().int().min(1).max(MAX_POLICY_DAYS).default(30),
  /** Optional: the canary to use while it is eligible. Otherwise the portal picks one. */
  canaryEndpointId: Id.optional(),
  reason: z.string().trim().min(3).max(300),
}).strict();
export type SeriesSettings = z.infer<typeof SeriesSettings>;

export const CreateSeriesDto = SeriesSettings.extend({
  businessId: Id,
  scope: z.enum(SERIES_SCOPES),
  name: z.string().trim().min(3).max(100),
}).strict();

/** One computer's Patch policy setting. */
export const OverrideDto = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('inherit') }).strict(),
  z.object({ mode: z.literal('exclude') }).strict(),
  z.object({ mode: z.literal('policy'), seriesId: Id }).strict(),
]);
export type OverrideDto = z.infer<typeof OverrideDto>;

// ── Who is in, who is left out ──────────────────────────────────────────────

export type LeftOutCode = 'not_windows' | 'no_signed_agent' | 'no_identity' | 'in_other_policy' | 'not_allowed' | 'no_result_key' | 'policy_full';
export interface LeftOut { endpointId: string; hostname: string; code: LeftOutCode; message: string }

export interface Candidate {
  endpointId: string;
  hostname: string;
  createdAt: number;
  rustdeskId: string;
  deviceSecretSha256: string;
  /** The key its own latest signed scan names, or null (no 0.34+ signed scan). */
  resultKey: string | null;
  /** Could it be the canary now (the update action is ready on it)? */
  canaryReady: boolean;
  /** Hours with a check-in in the last seven days (EndpointMetricHourly rows). */
  reliability: number;
}

/** Stable order: oldest enrolment first, then id. A new computer joins at the end. */
export function stableOrder<T extends { createdAt: number; endpointId: string }>(xs: T[]): T[] {
  return [...xs].sort((a, b) => a.createdAt - b.createdAt || (a.endpointId < b.endpointId ? -1 : a.endpointId > b.endpointId ? 1 : 0));
}

/**
 * The rings after the canary. Computers with a result key fill the gating
 * rings; computers without one (whose results cannot be verified, §38) go
 * only in the last ring, whose results open nothing. Rings are as even as
 * they can be, in stable order, at most `per` each, at most `maxRings`.
 */
export function laterRings(keyed: string[], keyless: string[], maxRings = MAX_POLICY_RINGS - 1, per = MAX_RING_TARGETS): { rings: string[][]; overflow: { id: string; code: 'no_result_key' | 'policy_full' }[] } {
  const overflow: { id: string; code: 'no_result_key' | 'policy_full' }[] = [];
  let u = keyless;
  if (u.length > per) { overflow.push(...u.slice(per).map((id) => ({ id, code: 'no_result_key' as const }))); u = u.slice(0, per); }
  let k = keyed;
  const capK = maxRings * per - u.length;
  if (k.length > capK) { overflow.push(...k.slice(capK).map((id) => ({ id, code: 'policy_full' as const }))); k = k.slice(0, capK); }
  const total = k.length + u.length;
  if (!total) return { rings: [], overflow };
  const n = Math.ceil(total / per);
  const lastSize = Math.max(u.length, Math.floor(total / n));
  const fromK = lastSize - u.length;
  const rest = k.slice(0, k.length - fromK);
  const last = [...k.slice(k.length - fromK), ...u];
  const m = n - 1;
  const rings: string[][] = [];
  let at = 0;
  for (let i = 0; i < m; i++) {
    const size = Math.floor(rest.length / m) + (i < rest.length % m ? 1 : 0);
    rings.push(rest.slice(at, at + size));
    at += size;
  }
  return { rings: [...rings.filter((r) => r.length), last], overflow };
}

export interface RingPlan {
  ok: true;
  rings: string[][];
  canary: { endpointId: string; hostname: string; why: string };
  leftOut: LeftOut[];
  /** Computers in the last ring because they have no result key. */
  lastRingOnly: string[];
}

/** Rings for these candidates, or why there can be none. */
export function planRings(cands: Candidate[], opts: { preferredCanary?: string | null; previousCanary?: string | null } = {}): RingPlan | { ok: false; code: string; message: string; leftOut: LeftOut[] } {
  const all = stableOrder(cands);
  if (!all.length) return { ok: false, code: 'no_computers', message: 'No computer of this business is eligible for this policy.', leftOut: [] };
  const alone = all.length === 1;
  const canCanary = (c: Candidate) => c.canaryReady && (alone || !!c.resultKey);
  const by = (id: string | null | undefined) => (id ? all.find((c) => c.endpointId === id && canCanary(c)) : undefined);
  let canary = by(opts.preferredCanary);
  let why = canary ? 'chosen for this policy' : '';
  if (!canary) { canary = by(opts.previousCanary); if (canary) why = 'the canary of the revision before'; }
  if (!canary) {
    const pool = all.filter(canCanary).sort((a, b) => b.reliability - a.reliability || a.createdAt - b.createdAt || (a.endpointId < b.endpointId ? -1 : 1));
    canary = pool[0];
    if (canary) why = `checks in most reliably (${canary.reliability} of the last 168 hours)`;
  }
  if (!canary) {
    return {
      ok: false, code: 'no_canary',
      message: 'No computer can be the canary: it needs the update action ready on the published signed agent and, with other computers after it, a signed scan from a 0.34+ agent (its result key).',
      leftOut: [],
    };
  }
  const rest = all.filter((c) => c.endpointId !== canary!.endpointId);
  const keyed = rest.filter((c) => !!c.resultKey).map((c) => c.endpointId);
  const keyless = rest.filter((c) => !c.resultKey).map((c) => c.endpointId);
  const { rings, overflow } = laterRings(keyed, keyless);
  const host = new Map(all.map((c) => [c.endpointId, c.hostname]));
  const leftOut: LeftOut[] = overflow.map((o) => ({
    endpointId: o.id, hostname: host.get(o.id) ?? o.id, code: o.code,
    message: o.code === 'no_result_key'
      ? 'no result-signing key (no signed scan from a 0.34+ agent), and the last ring — the only place a computer without one can be — is full.'
      : `the policy is full (${MAX_POLICY_COMPUTERS} computers: a canary and ${MAX_POLICY_RINGS - 1} rings of ${MAX_RING_TARGETS}). Give the rest their own policy.`,
  }));
  const inPlan = new Set(rings.flat());
  return { ok: true, rings: [[canary.endpointId], ...rings], canary: { endpointId: canary.endpointId, hostname: canary.hostname, why }, leftOut, lastRingOnly: keyless.filter((id) => inPlan.has(id)) };
}

/** The identity of a ring list, as the signed document binds it. Two documents with the same fingerprint name the same computers in the same rings. */
export function membershipFingerprint(rings: Pick<PolicyComputer, 'endpointId' | 'rustdeskId' | 'deviceSecretSha256' | 'resultKey'>[][]): string {
  const flat = rings.map((r) => r.map((c) => [c.endpointId, c.rustdeskId, c.deviceSecretSha256, c.resultKey ?? null]));
  return createHash('sha256').update('rem0te-patch-membership-v1\n').update(JSON.stringify(flat)).digest('hex');
}

// ── When a revision is proposed ─────────────────────────────────────────────

export interface RevisionInput {
  now: Date;
  /** The rings the portal would write now, or null if it can write none. */
  desired: { fingerprint: string } | null;
  /** The revision the sweep runs. */
  current: { fingerprint: string; expiresAt: Date; status: string } | null;
  /** The newest revision not yet running: awaiting approval, or active and waiting to take over. */
  pending: { fingerprint: string; status: string; revision: number } | null;
  /** The fingerprint of the newest revision the approvers rejected, if any. */
  rejected: string | null;
  settle: { fingerprint: string | null; since: Date | null };
  /** When this business last had an automatic revision, from its claim row. */
  lastClaimAt: Date | null;
  /** The running revision has a deployment that is active or paused. */
  midRing: boolean;
  expiresInDays: number;
}
export type RevisionDecision =
  | { act: 'none'; code: 'up_to_date' | 'awaiting_approval' | 'waiting_to_take_over'; message: string }
  | { act: 'hold'; code: 'no_computers' | 'settling' | 'rate_limited' | 'mid_ring' | 'rejected'; message: string; until?: Date; settle?: { fingerprint: string; since: Date } }
  | { act: 'propose'; trigger: 'membership' | 'renewal' | 'restart'; message: string }
  | { act: 'withdraw'; code: 'no_computers'; message: string }
  | { act: 'drop_pending'; code: 'pending_stale'; message: string };

/**
 * Whether to propose a revision now. Every path to `propose` passes the
 * three bounds: not while the running revision is mid-ring, a change of
 * computers only after it has settled, and at most one automatic revision
 * per business per `revisionMinutes()`.
 */
export function revisionDecision(i: RevisionInput, minutes = revisionMinutes(), settle = settleMinutes()): RevisionDecision {
  const now = i.now.getTime();
  const live = i.current && i.current.status === 'ACTIVE' && i.current.expiresAt.getTime() > now ? i.current : null;
  if (!i.desired) {
    if (!live) return { act: 'hold', code: 'no_computers', message: 'No computer is eligible, so there is nothing to propose.' };
    if (i.midRing) return { act: 'hold', code: 'mid_ring', message: 'No computer is eligible any more; the running revision is withdrawn once its deployment finishes.' };
    return { act: 'withdraw', code: 'no_computers', message: 'No computer is eligible any more: the running revision is withdrawn.' };
  }
  const want = i.desired.fingerprint;
  if (i.pending && i.pending.fingerprint === want) {
    return i.pending.status === 'ACTIVE'
      ? { act: 'none', code: 'waiting_to_take_over', message: `Revision ${i.pending.revision} is active and takes over when the running revision has no deployment in progress.` }
      : { act: 'none', code: 'awaiting_approval', message: `Revision ${i.pending.revision} awaits approval on the approval signer; the running revision keeps running meanwhile.` };
  }
  let trigger: 'membership' | 'renewal' | 'restart';
  if (!live) trigger = 'restart';
  else if (live.fingerprint !== want) trigger = 'membership';
  else if (live.expiresAt.getTime() - now <= renewLeadMs(i.expiresInDays)) trigger = 'renewal';
  else if (i.pending) return { act: 'drop_pending', code: 'pending_stale', message: `Revision ${i.pending.revision} no longer matches the computers (the running revision already does); it is withdrawn before anyone approves it.` };
  else return { act: 'none', code: 'up_to_date', message: 'The running revision names exactly these computers.' };

  if (trigger !== 'renewal' && i.rejected === want) return { act: 'hold', code: 'rejected', message: 'The approvers rejected a revision naming exactly these computers. It is proposed again only when the computers change.' };
  if (i.midRing) return { act: 'hold', code: 'mid_ring', message: 'A deployment of the running revision is in progress; a revision is proposed only between deployments.' };
  if (trigger === 'membership') {
    if (i.settle.fingerprint !== want || !i.settle.since) {
      return { act: 'hold', code: 'settling', message: `The computers changed; the change is proposed once it has held for ${settle} minute(s).`, settle: { fingerprint: want, since: i.now }, until: new Date(now + settle * 60_000) };
    }
    const due = i.settle.since.getTime() + settle * 60_000;
    if (now < due) return { act: 'hold', code: 'settling', message: `The computers changed; the change is proposed once it has held for ${settle} minute(s).`, until: new Date(due) };
  }
  if (i.lastClaimAt) {
    const next = i.lastClaimAt.getTime() + minutes * 60_000;
    if (now < next) return { act: 'hold', code: 'rate_limited', message: `This business had an automatic revision less than ${minutes} minute(s) ago; the next is proposed after ${new Date(next).toISOString()}.`, until: new Date(next) };
  }
  return {
    act: 'propose', trigger,
    message: trigger === 'renewal' ? 'The running revision expires soon: renewed by revision.' : trigger === 'restart' ? 'No revision is running: proposed again.' : 'The computers changed: proposed by revision.',
  };
}

/** The reason written into a revision's signed document (what approvers read). */
export function revisionReason(seriesName: string, scope: SeriesScope, revision: number, trigger: string, added: string[], removed: string[]): string {
  const what = scope === 'business' ? 'Company-wide policy' : 'Assignable policy';
  const changes = [added.length ? `adds ${added.slice(0, 5).join(', ')}${added.length > 5 ? ` and ${added.length - 5} more` : ''}` : '', removed.length ? `removes ${removed.slice(0, 5).join(', ')}${removed.length > 5 ? ` and ${removed.length - 5} more` : ''}` : ''].filter(Boolean).join('; ');
  const why = trigger === 'initial' ? 'first revision' : trigger === 'renewal' ? 'renewal before expiry' : trigger === 'restart' ? 'proposed again' : 'the computers changed';
  return `${what} "${seriesName}", revision ${revision} (${why})${changes ? `: ${changes}` : ''}.`.slice(0, 500);
}
