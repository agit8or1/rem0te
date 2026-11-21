/**
 * Backups (0.81 Vault, roadmap 4.1): the closed lists and the provider feed.
 *
 * Pure: zod only. The same lists are CHECKed by migration 0097, and §91
 * compares them.
 *
 * A provider (the St0r push, a pull driver, or the e2e suites' loopback
 * stand-in) hands Rem0te one FEED: the assets it protects, with each asset's
 * recent jobs, recovery points and restore drills. The feed is parsed
 * strictly here before anything is written, and it can never say a job is
 * "verified". A job has three separate facts:
 *
 *   completion   did the job finish, and how — the provider says;
 *   integrity    did the provider verify the stored data — the provider says;
 *   restoreTest  was a restore from this job's recovery point validated in an
 *                isolated drill — Rem0te decides it, from the drills, in
 *                deriveRestoreTests() below. There is no such field in the feed.
 *
 * A drill marked `simulated` is stored and shown, and never counts.
 */
import { z } from 'zod';

export const CONNECTION_KINDS = ['standin', 'st0r', 'comet'] as const;
export type ConnectionKind = (typeof CONNECTION_KINDS)[number];
export const TRANSPORTS = ['pull', 'push'] as const;
export type Transport = (typeof TRANSPORTS)[number];
/** Decision 17: St0r pushes to Rem0te; Comet and the stand-in are read. Migration 0097 CHECKs the same pairs. */
export const TRANSPORT_OF: Record<ConnectionKind, Transport> = { standin: 'pull', st0r: 'push', comet: 'pull' };

export const ASSET_TYPES = ['computer', 'server', 'virtual_machine', 'database', 'files', 'mailbox', 'other'] as const;
export const JOB_COMPLETIONS = ['running', 'succeeded', 'partial', 'failed', 'cancelled', 'unknown'] as const;
export const JOB_INTEGRITIES = ['not_checked', 'passed', 'failed'] as const;
export const RESTORE_TESTS = ['not_tested', 'verified', 'failed'] as const;
export const POINT_LOCATIONS = ['local', 'offsite', 'cloud', 'unknown'] as const;
export const DRILL_TARGETS = ['isolated_vm', 'isolated_path', 'sandbox', 'other'] as const;
export const DRILL_SCOPES = ['file', 'volume', 'full_image', 'application'] as const;
export const DRILL_RESULTS = ['running', 'passed', 'failed', 'partial', 'unknown'] as const;
export const DRILL_VALIDATIONS = ['sha256', 'file_compare', 'service_running', 'boot', 'manual', 'none'] as const;

export type JobCompletion = (typeof JOB_COMPLETIONS)[number];
export type JobIntegrity = (typeof JOB_INTEGRITIES)[number];
export type RestoreTest = (typeof RESTORE_TESTS)[number];
export type DrillResult = (typeof DRILL_RESULTS)[number];

/** A provider's own identifier for an asset, job, point or drill. The same charset as 0097. */
export const EXTERNAL_ID = /^[A-Za-z0-9._:-]{1,128}$/;
/** An asset's name, reduced to an inert charset (0097 CHECK). */
export const ASSET_NAME = /^[A-Za-z0-9À-ɏ .,:;()/&+'#_@-]{1,200}$/;
export const CODE = /^[A-Za-z0-9_.-]{1,64}$/;
const HOSTNAME = /^[A-Za-z0-9.-]{1,253}$/;
const CUID = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * What one feed may carry. A bigger feed is refused whole, never cut. 1 MB is
 * the API's JSON body limit (main.ts), so a pushed feed and a fetched one have
 * the same ceiling. A feed is a delta, not a census: an asset missing from it
 * is kept as it was, so a provider with more sends several.
 */
export const FEED_LIMITS = { assets: 500, jobs: 50, points: 50, drills: 20, bytes: 1024 * 1024 } as const;

const when = z.string().datetime({ offset: true }).transform((s) => new Date(s))
  .refine((d) => d.getUTCFullYear() >= 2000 && d.getTime() <= Date.now() + 86_400_000, 'a date between 2000 and tomorrow');

export const FeedJob = z.object({
  externalId: z.string().regex(EXTERNAL_ID),
  startedAt: when,
  finishedAt: when.nullable().optional(),
  completion: z.enum(JOB_COMPLETIONS),
  integrity: z.enum(JOB_INTEGRITIES).default('not_checked'),
  integrityCheckedAt: when.nullable().optional(),
  bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  errorCode: z.string().regex(CODE).nullable().optional(),
}).strict().refine((j) => j.completion !== 'running' || !j.finishedAt, { message: 'a running job has no finishedAt' });

export const FeedPoint = z.object({
  externalId: z.string().regex(EXTERNAL_ID),
  pointAt: when,
  location: z.enum(POINT_LOCATIONS).default('unknown'),
  jobExternalId: z.string().regex(EXTERNAL_ID).nullable().optional(),
}).strict();

export const FeedDrill = z.object({
  externalId: z.string().regex(EXTERNAL_ID),
  /**
   * The recovery point this drill restored. Required from 0.82 (contract
   * version 1, docs/st0r-push-contract.md): a drill that does not say what it
   * restored cannot verify anything. A point Rem0te has not stored (in this
   * feed or an earlier one) is kept as the drill's claim and counts for no job.
   */
  recoveryPointExternalId: z.string().regex(EXTERNAL_ID),
  recoveryPointAt: when.nullable().optional(),
  target: z.enum(DRILL_TARGETS),
  scope: z.enum(DRILL_SCOPES),
  result: z.enum(DRILL_RESULTS),
  /** Required, never defaulted: a feed that does not say is refused. */
  simulated: z.boolean(),
  validation: z.enum(DRILL_VALIDATIONS),
  startedAt: when,
  finishedAt: when.nullable().optional(),
  elapsedSeconds: z.number().int().min(0).max(2_592_000).nullable().optional(),
  failureCode: z.string().regex(CODE).nullable().optional(),
}).strict()
  .refine((d) => d.result !== 'passed' || d.validation !== 'none', { message: 'a drill that validated nothing did not pass' })
  .refine((d) => ['running', 'unknown'].includes(d.result) || !!d.finishedAt, { message: 'a finished drill needs finishedAt' });

export const FeedAsset = z.object({
  externalId: z.string().regex(EXTERNAL_ID),
  name: z.string().trim().regex(ASSET_NAME, 'letters, digits and . , : ; ( ) / & + \' # _ @ - only'),
  type: z.enum(ASSET_TYPES),
  /**
   * Which Rem0te computer this is, if the provider knows: its Rem0te id, or
   * its hostname. Either is linked only to a computer of the connection's own
   * business; anything else leaves the asset unlinked.
   */
  computer: z.object({
    rem0teId: z.string().regex(CUID).optional(),
    hostname: z.string().regex(HOSTNAME).optional(),
  }).strict().optional(),
  jobs: z.array(FeedJob).max(FEED_LIMITS.jobs).default([]),
  recoveryPoints: z.array(FeedPoint).max(FEED_LIMITS.points).default([]),
  drills: z.array(FeedDrill).max(FEED_LIMITS.drills).default([]),
}).strict();

/**
 * One feed. It carries no business, tenant or connection: those come from
 * the credential it arrived with (the push token) or the connection that
 * fetched it, never from the body.
 */
export const Feed = z.object({
  /** The contract version (CONTRACT_VERSION). */
  v: z.literal(1),
  assets: z.array(FeedAsset).max(FEED_LIMITS.assets),
}).strict().superRefine((f, ctx) => {
  const ids = new Set<string>();
  for (const [i, a] of f.assets.entries()) {
    if (ids.has(a.externalId)) ctx.addIssue({ code: 'custom', path: ['assets', i, 'externalId'], message: 'duplicate asset' });
    ids.add(a.externalId);
    for (const k of ['jobs', 'recoveryPoints', 'drills'] as const) {
      const seen = new Set<string>();
      for (const [j, x] of a[k].entries()) {
        if (seen.has(x.externalId)) ctx.addIssue({ code: 'custom', path: ['assets', i, k, j, 'externalId'], message: 'duplicate id' });
        seen.add(x.externalId);
      }
    }
  }
});
export type FeedT = z.infer<typeof Feed>;
export type FeedAssetT = z.infer<typeof FeedAsset>;

/** The St0r push contract's version (docs/st0r-push-contract.md). A feed's `v` must equal it. */
export const CONTRACT_VERSION = 1 as const;

export interface FeedIssue { path: string; message: string }
/** At most this many issues are reported for one refused feed. */
export const MAX_ISSUES = 20;

/**
 * Parse a feed strictly. A refused feed gives its first issues (path and
 * rule, as Rem0te words them — never a value from the feed beyond what zod's
 * message names) and a one-line `error` of the first five.
 */
export function parseFeed(raw: unknown): { ok: true; feed: FeedT } | { ok: false; error: string; issues: FeedIssue[] } {
  const r = Feed.safeParse(raw);
  if (!r.success) {
    const issues = r.error.issues.slice(0, MAX_ISSUES).map((i) => ({ path: i.path.join('.') || 'feed', message: i.message }));
    return { ok: false, error: issues.slice(0, 5).map((i) => `${i.path}: ${i.message}`).join('; '), issues };
  }
  return { ok: true, feed: r.data };
}

/**
 * A refusal Rem0te keeps on the connection (BackupConnection.lastError, 0099
 * CHECK): printable ASCII only, at most 300 characters.
 */
export function errorLine(s: string): string {
  const t = s.replace(/[^\x20-\x7e]/g, '?').trim().slice(0, 300);
  return t || 'refused';
}

// ── Idempotency: re-sending is safe, in any order (contract §Idempotency) ──

const JOB_TERMINAL: ReadonlySet<string> = new Set(['succeeded', 'partial', 'failed', 'cancelled']);
const DRILL_TERMINAL: ReadonlySet<string> = new Set(['passed', 'failed', 'partial']);

export interface StoredJobFacts { completion: string; finishedAt: Date | null; integrity: string; integrityCheckedAt: Date | null }
export interface StoredDrillFacts { result: string; finishedAt: Date | null }

/**
 * What a re-sent job writes over the stored one. Every item is keyed by its
 * externalId, so the same id never makes a second row; its fields are
 * replaced by the newest report, except that a fact never moves backwards:
 *
 *   - a finished job (succeeded, partial, failed, cancelled) is never put
 *     back to running or unknown — an older report retried late cannot undo
 *     a newer one. A finished job may still be corrected to another finished
 *     completion (the provider is the source of truth for its own job);
 *   - an integrity result (passed or failed) is never put back to not_checked.
 *
 * `regressed` names what was kept, for the push's answer.
 */
export function mergeJob(stored: StoredJobFacts | null, incoming: StoredJobFacts): { facts: StoredJobFacts; regressed: string[] } {
  if (!stored) return { facts: incoming, regressed: [] };
  const out = { ...incoming };
  const regressed: string[] = [];
  if (JOB_TERMINAL.has(stored.completion) && !JOB_TERMINAL.has(incoming.completion)) {
    out.completion = stored.completion; out.finishedAt = stored.finishedAt; regressed.push('completion');
  }
  if (stored.integrity !== 'not_checked' && incoming.integrity === 'not_checked') {
    out.integrity = stored.integrity; out.integrityCheckedAt = stored.integrityCheckedAt; regressed.push('integrity');
  }
  return { facts: out, regressed };
}

/**
 * The same rule for a drill: a finished drill (passed, failed, partial) is
 * never put back to running or unknown. Such a report is skipped whole — its
 * other fields belong to the older, unfinished drill.
 */
export function drillRegresses(stored: StoredDrillFacts | null, incoming: StoredDrillFacts): boolean {
  return !!stored && DRILL_TERMINAL.has(stored.result) && !DRILL_TERMINAL.has(incoming.result);
}

// ── Restore tests: decided here, from drills ───────────────────────────────

export interface PointLike { id: string; jobId: string | null }
export interface DrillLike { id: string; recoveryPointId: string | null; result: string; simulated: boolean; finishedAt: Date | null; startedAt: Date }

/**
 * Each job's restoreTest, from the drills of its own recovery points:
 * 'verified' if the newest non-simulated finished drill of one of its points
 * passed, 'failed' if it failed (or partly failed), otherwise 'not_tested'.
 * A simulated drill never counts, and a job's own completion never enters
 * into it. Migration 0097's trigger refuses anything else.
 */
export function deriveRestoreTests(jobIds: string[], points: PointLike[], drills: DrillLike[]): Map<string, { restoreTest: RestoreTest; drillId: string | null }> {
  const jobOfPoint = new Map(points.filter((p) => p.jobId).map((p) => [p.id, p.jobId!]));
  const out = new Map<string, { restoreTest: RestoreTest; drillId: string | null }>(jobIds.map((j) => [j, { restoreTest: 'not_tested', drillId: null }]));
  const at = (d: DrillLike) => (d.finishedAt ?? d.startedAt).getTime();
  const counted = drills.filter((d) => !d.simulated && d.recoveryPointId && ['passed', 'failed', 'partial'].includes(d.result)).sort((a, b) => at(b) - at(a) || (a.id < b.id ? -1 : 1));
  for (const d of counted) {
    const job = jobOfPoint.get(d.recoveryPointId!);
    if (!job || !out.has(job) || out.get(job)!.drillId) continue;
    out.set(job, { restoreTest: d.result === 'passed' ? 'verified' : 'failed', drillId: d.id });
  }
  return out;
}
