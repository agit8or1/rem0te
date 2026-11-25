/**
 * Backups (0.81): what the page and the monitors conclude from stored rows.
 * Pure — every function takes `now`, and imports only ./model. Unit-tested by
 * apps/api/scripts/unit-backups.mjs.
 *
 * The one rule every function here keeps: completion, integrity and a
 * verified restore are three separate facts. "Last backup succeeded" is never
 * "verified"; only a drill that passed, was not simulated and validated
 * something is, and the page shows each of the three on its own.
 */
import type { JobCompletion, JobIntegrity, RestoreTest } from './model';

export const HOUR = 3_600_000;
export const MINUTE = 60_000;
/** With no RPO target, the page calls a backup stale after this long without a success (a daily backup, plus slack). */
export const DEFAULT_STALE_HOURS = 26;

export interface JobRow { id: string; startedAt: Date; finishedAt: Date | null; completion: string; integrity: string; restoreTest: string; errorCode?: string | null }
export interface PointRow { id: string; pointAt: Date; location: string; jobId: string | null }
export interface DrillRow {
  id: string; startedAt: Date; finishedAt: Date | null; result: string; simulated: boolean; validation: string; target: string; scope: string;
  elapsedSeconds: number | null; recoveryPointId: string | null; recoveryPointAt: Date | null; failureCode?: string | null;
}
export interface Objective { rpoMinutes: number | null; rtoMinutes: number | null }
export interface AssetFacts {
  firstSeenAt: Date;
  /** Newest first is not assumed; every function sorts. */
  jobs: JobRow[]; points: PointRow[]; drills: DrillRow[];
  /** The asset's own target, then the business default (either may be null). */
  objective: Objective | null; businessObjective: Objective | null;
}

const t = (d: Date | null | undefined) => (d ? d.getTime() : 0);
const newestJobs = (jobs: JobRow[]) => [...jobs].sort((a, b) => t(b.finishedAt ?? b.startedAt) - t(a.finishedAt ?? a.startedAt) || (a.id < b.id ? -1 : 1));
const finished = (j: JobRow) => j.completion !== 'running' && j.completion !== 'unknown' && !!j.finishedAt;
const drillAt = (d: DrillRow) => t(d.finishedAt ?? d.startedAt);

/** Targets: the asset's own, else the business default, field by field. */
export function targetsOf(f: Pick<AssetFacts, 'objective' | 'businessObjective'>): { rpoMinutes: number | null; rtoMinutes: number | null; rpoFrom: 'asset' | 'business' | null; rtoFrom: 'asset' | 'business' | null } {
  const rpoA = f.objective?.rpoMinutes ?? null, rpoB = f.businessObjective?.rpoMinutes ?? null;
  const rtoA = f.objective?.rtoMinutes ?? null, rtoB = f.businessObjective?.rtoMinutes ?? null;
  return {
    rpoMinutes: rpoA ?? rpoB, rpoFrom: rpoA !== null ? 'asset' : rpoB !== null ? 'business' : null,
    rtoMinutes: rtoA ?? rtoB, rtoFrom: rtoA !== null ? 'asset' : rtoB !== null ? 'business' : null,
  };
}

/** The newest successful job's end. "partial" is not a success. */
export function lastSuccessAt(jobs: JobRow[]): Date | null {
  const s = newestJobs(jobs).find((j) => j.completion === 'succeeded' && j.finishedAt);
  return s?.finishedAt ?? null;
}

/** The newest restorable moment: the newest recovery point, else the newest successful job's end. */
export function newestRestorableAt(f: Pick<AssetFacts, 'jobs' | 'points'>): Date | null {
  const p = [...f.points].sort((a, b) => t(b.pointAt) - t(a.pointAt))[0];
  return p?.pointAt ?? lastSuccessAt(f.jobs);
}

/**
 * The newest VERIFIED restore: a drill that passed, was not simulated, and
 * validated something (0097 refuses a pass with validation 'none' anyway).
 * Null when there is none — whatever the jobs say.
 */
export function lastVerifiedRestore(drills: DrillRow[]): DrillRow | null {
  return [...drills].filter((d) => d.result === 'passed' && !d.simulated && d.validation !== 'none' && d.finishedAt).sort((a, b) => drillAt(b) - drillAt(a))[0] ?? null;
}

export type BackupHealth = 'never' | 'ok' | 'stale' | 'failing' | 'running';
export type DrillHealth = 'never_tested' | 'verified' | 'failed' | 'simulated_only';
export type Measure = { targetMinutes: number | null; measuredMinutes: number | null; exceeded: boolean | null; from: 'asset' | 'business' | null };

export interface AssetState {
  /** The newest job, its three facts kept apart. */
  lastJob: { id: string; startedAt: Date; finishedAt: Date | null; completion: JobCompletion; integrity: JobIntegrity; restoreTest: RestoreTest; errorCode: string | null } | null;
  lastSuccessAt: Date | null;
  backup: BackupHealth;
  /** Hours without a success after which `backup` is 'stale' (the RPO target, else DEFAULT_STALE_HOURS). */
  staleAfterHours: number;
  drill: DrillHealth;
  verified: null | { drillId: string; at: Date; recoveryPointAt: Date | null; scope: string; target: string; validation: string; elapsedSeconds: number | null };
  lastFailedDrill: null | { drillId: string; at: Date; failureCode: string | null; scope: string; target: string };
  rpo: Measure;
  rto: Measure;
  /** One line a person reads. Never says "verified" without a verified restore. */
  summary: string;
}

/**
 * Everything the Backups page says about one asset.
 *
 * - backup: 'running' only when the newest job runs and the last success is
 *   still inside the stale window; 'failing' when the newest finished job
 *   failed; 'stale' when the last success (or, with none, the asset's first
 *   sighting) is older than the window; 'never' when nothing succeeded yet
 *   inside the window.
 * - rpo: now − the newest restorable moment, against the target.
 * - rto: the elapsed time of the newest verified restore — the only measured
 *   restore time there is — against the target. Null without one.
 */
export function assetState(f: AssetFacts, now: Date): AssetState {
  const jobs = newestJobs(f.jobs);
  const last = jobs[0] ?? null;
  const lastOk = lastSuccessAt(jobs);
  const tg = targetsOf(f);
  const staleAfterHours = tg.rpoMinutes !== null ? tg.rpoMinutes / 60 : DEFAULT_STALE_HOURS;
  const lastFinished = jobs.find(finished) ?? null;
  const since = lastOk ?? f.firstSeenAt;
  const stale = now.getTime() - since.getTime() > staleAfterHours * HOUR;
  let backup: BackupHealth;
  if (lastFinished && lastFinished.completion === 'failed') backup = 'failing';
  else if (stale) backup = 'stale';
  else if (last && last.completion === 'running') backup = 'running';
  else backup = lastOk ? 'ok' : 'never';

  const real = f.drills.filter((d) => !d.simulated);
  const verified = lastVerifiedRestore(f.drills);
  const newestReal = real.filter((d) => ['passed', 'failed', 'partial'].includes(d.result) && d.finishedAt).sort((a, b) => drillAt(b) - drillAt(a))[0] ?? null;
  const drill: DrillHealth = newestReal ? (newestReal.result === 'passed' ? 'verified' : 'failed') : f.drills.length ? 'simulated_only' : 'never_tested';
  const failed = real.filter((d) => d.result === 'failed' || d.result === 'partial').sort((a, b) => drillAt(b) - drillAt(a))[0] ?? null;

  const restorable = newestRestorableAt({ jobs, points: f.points });
  const rpoMeasured = restorable ? Math.max(0, Math.floor((now.getTime() - restorable.getTime()) / MINUTE)) : null;
  const rtoMeasured = verified?.elapsedSeconds != null ? Math.ceil(verified.elapsedSeconds / 60) : null;
  const rpo: Measure = { targetMinutes: tg.rpoMinutes, measuredMinutes: rpoMeasured, exceeded: tg.rpoMinutes === null || rpoMeasured === null ? null : rpoMeasured > tg.rpoMinutes, from: tg.rpoFrom };
  const rto: Measure = { targetMinutes: tg.rtoMinutes, measuredMinutes: rtoMeasured, exceeded: tg.rtoMinutes === null || rtoMeasured === null ? null : rtoMeasured > tg.rtoMinutes, from: tg.rtoFrom };

  const backupWord: Record<BackupHealth, string> = { never: 'No successful backup yet', ok: 'Backed up', stale: 'Backup stale', failing: 'Last backup failed', running: 'Backup running' };
  const drillWord: Record<DrillHealth, string> = { never_tested: 'restore never tested', verified: 'restore verified', failed: 'last restore drill failed', simulated_only: 'only simulated drills (not verified)' };
  return {
    lastJob: last ? { id: last.id, startedAt: last.startedAt, finishedAt: last.finishedAt, completion: last.completion as JobCompletion, integrity: last.integrity as JobIntegrity, restoreTest: last.restoreTest as RestoreTest, errorCode: last.errorCode ?? null } : null,
    lastSuccessAt: lastOk, backup, staleAfterHours, drill,
    verified: verified ? { drillId: verified.id, at: verified.finishedAt!, recoveryPointAt: verified.recoveryPointAt, scope: verified.scope, target: verified.target, validation: verified.validation, elapsedSeconds: verified.elapsedSeconds } : null,
    lastFailedDrill: failed ? { drillId: failed.id, at: failed.finishedAt ?? failed.startedAt, failureCode: failed.failureCode ?? null, scope: failed.scope, target: failed.target } : null,
    rpo, rto,
    summary: `${backupWord[backup]}; ${drillWord[drill === 'verified' && !verified ? 'never_tested' : drill]}`,
  };
}

export type PageState = 'requires_setup' | 'awaiting_data' | 'connected';
/**
 * The Backups page's state for one business: requires setup until a provider
 * is connected; awaiting data until it has reported once.
 */
export function pageState(conns: { enabled: boolean; revokedAt: Date | null; lastSyncAt: Date | null }[]): PageState {
  const live = conns.filter((c) => c.enabled && !c.revokedAt);
  if (!live.length) return 'requires_setup';
  return live.some((c) => c.lastSyncAt) ? 'connected' : 'awaiting_data';
}

// ── Monitor verdicts (engine.ts wraps these per rule) ──────────────────────

export type BackupVerdict =
  | { verdict: 'skip'; reason: string }
  | { verdict: 'ok' }
  | { verdict: 'hold' }
  | { verdict: 'breach'; title: string; detail: Record<string, unknown> };

const ago = (ms: number) => (ms < 48 * HOUR ? `${Math.floor(ms / HOUR)} h` : `${Math.floor(ms / (24 * HOUR))} d`);

/** BACKUP_STALE: no successful backup within `hours` (with none ever, counted from when the asset was first seen). */
export function staleVerdict(name: string, f: AssetFacts, hours: number, now: Date): BackupVerdict {
  const ok = lastSuccessAt(f.jobs);
  const since = ok ?? f.firstSeenAt;
  const age = now.getTime() - since.getTime();
  if (age <= hours * HOUR) return ok ? { verdict: 'ok' } : { verdict: 'skip', reason: 'no successful backup yet, but the asset is newer than the window' };
  return {
    verdict: 'breach',
    title: ok ? `${name}: no successful backup for ${ago(age)}` : `${name}: no successful backup recorded`,
    detail: { lastSuccessAt: ok?.toISOString() ?? null, firstSeenAt: f.firstSeenAt.toISOString(), hours, note: 'a successful job is not a verified restore' },
  };
}

/** BACKUP_FAILED: the newest `consecutive` finished jobs all failed. Clears when the newest finished job succeeded (or partly). */
export function failedVerdict(name: string, f: AssetFacts, consecutive: number): BackupVerdict {
  const fin = newestJobs(f.jobs).filter(finished);
  if (!fin.length) return { verdict: 'skip', reason: 'no finished job' };
  if (fin[0].completion === 'succeeded' || fin[0].completion === 'partial') return { verdict: 'ok' };
  const run = fin.slice(0, consecutive);
  if (run.length < consecutive || !run.every((j) => j.completion === 'failed')) return { verdict: 'hold' };
  return {
    verdict: 'breach',
    title: consecutive === 1 ? `${name}: the last backup failed` : `${name}: the last ${consecutive} backups failed`,
    detail: { jobs: run.map((j) => ({ finishedAt: j.finishedAt?.toISOString() ?? null, errorCode: j.errorCode ?? null })), consecutive },
  };
}

/** DRILL_FAILED: the newest non-simulated finished drill within `days` failed or partly failed. Simulated drills never count. */
export function drillVerdict(name: string, f: AssetFacts, days: number, now: Date): BackupVerdict {
  const recent = f.drills.filter((d) => !d.simulated && d.finishedAt && ['passed', 'failed', 'partial'].includes(d.result) && now.getTime() - d.finishedAt.getTime() <= days * 24 * HOUR)
    .sort((a, b) => drillAt(b) - drillAt(a));
  const d = recent[0];
  if (!d || d.result === 'passed') return { verdict: 'ok' };
  return {
    verdict: 'breach',
    title: `${name}: restore drill ${d.result === 'partial' ? 'partly failed' : 'failed'} (${d.scope.replace('_', ' ')})`,
    detail: { drillAt: d.finishedAt!.toISOString(), result: d.result, scope: d.scope, target: d.target, validation: d.validation, failureCode: d.failureCode ?? null, recoveryPointAt: d.recoveryPointAt?.toISOString() ?? null, days },
  };
}

/**
 * RPO_EXCEEDED: the newest restorable moment is older than the target (the
 * asset's, else the business's, else the monitor's fallbackHours). No target
 * anywhere: skip — an RPO nobody set cannot be exceeded.
 */
export function rpoVerdict(name: string, f: AssetFacts, fallbackHours: number | undefined, now: Date): BackupVerdict {
  const tg = targetsOf(f);
  const target = tg.rpoMinutes ?? (fallbackHours ? fallbackHours * 60 : null);
  if (target === null) return { verdict: 'skip', reason: 'no RPO target for this asset or customer' };
  const at = newestRestorableAt(f);
  const age = now.getTime() - (at ?? f.firstSeenAt).getTime();
  if (age <= target * MINUTE) return at ? { verdict: 'ok' } : { verdict: 'skip', reason: 'no recovery point yet, but the asset is newer than the target' };
  return {
    verdict: 'breach',
    title: at ? `${name}: newest recovery point is ${ago(age)} old (RPO ${target >= 120 ? `${Math.round(target / 60)} h` : `${target} min`})` : `${name}: no recovery point recorded (RPO ${target} min)`,
    detail: { newestRestorableAt: at?.toISOString() ?? null, measuredMinutes: Math.floor(age / MINUTE), targetMinutes: target, targetFrom: tg.rpoFrom ?? 'monitor' },
  };
}
