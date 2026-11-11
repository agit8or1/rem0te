/**
 * Metric history (0.33) — the arithmetic, with no database and no Nest.
 *
 * Everything that decides a number lives here so it can be proved on its own
 * (scripts/unit-metric-history.mjs): what a heartbeat's values become as a
 * sample, what an hour rolls up to, which window a sweep pass may roll, what it
 * may prune, and where the gaps are. The service only moves rows.
 *
 * Two rules shape it.
 *
 * **A gap is a gap.** Nothing here interpolates, carries a value forward or
 * fills a missing hour. A computer that did not report for longer than its
 * gap threshold has a gap in its history, returned as one, and the chart
 * draws nothing there. A line drawn across eight hours of silence would say
 * the machine was fine while nobody knew.
 *
 * **Bounded.** Every pass of the sweep touches a capped number of hours and
 * rows, and retention has floors and ceilings, so a misconfiguration can make
 * history short or long but never unbounded.
 */

export const HOUR_MS = 3_600_000;
export const MINUTE_MS = 60_000;

/**
 * A heartbeat-cadence series has a gap after this long without a sample. The
 * same 10 minutes after which markStaleEndpointsOffline sweeps a computer
 * offline: the agent checks in every three minutes, so two missed check-ins
 * are tolerated and a third is the computer being away.
 */
export const RAW_GAP_MS = 10 * MINUTE_MS;

/**
 * Per-volume samples come from the inventory pass (every 6 h). A gap after
 * two missed passes plus an hour of slack.
 */
export const INVENTORY_HOURS = 6;
export const DISK_GAP_MS = (2 * INVENTORY_HOURS + 1) * HOUR_MS;

/** An hour's roll-up is written once the hour has been over this long, so a heartbeat in flight at :59 is in it. */
export const ROLLUP_GRACE_MS = 2 * MINUTE_MS;

export type Range = '24h' | '7d' | '30d' | '90d';
export const RANGES: Record<Range, { ms: number; resolution: 'raw' | 'hour' }> = {
  '24h': { ms: 24 * HOUR_MS, resolution: 'raw' },
  '7d': { ms: 7 * 24 * HOUR_MS, resolution: 'hour' },
  '30d': { ms: 30 * 24 * HOUR_MS, resolution: 'hour' },
  '90d': { ms: 90 * 24 * HOUR_MS, resolution: 'hour' },
};
export function parseRange(raw: unknown): Range | null {
  if (raw === undefined || raw === null || raw === '') return '24h';
  return typeof raw === 'string' && Object.prototype.hasOwnProperty.call(RANGES, raw) ? (raw as Range) : null;
}

// ── Configuration ────────────────────────────────────────────────────────────

export interface MetricConfig {
  /** Raw samples are kept this long. Floor 24 h: the 24 h range reads raw. */
  rawHours: number;
  /** Hourly roll-ups and per-volume samples are kept this long. */
  hourlyDays: number;
  /** At most one sample per computer per this many seconds. */
  minIntervalSeconds: number;
  /** Sweep cadence. */
  sweepSeconds: number;
  /** Hours rolled up per pass. */
  rollupHoursPerPass: number;
  /** Rows deleted per DELETE, and DELETEs per table per pass. */
  pruneBatch: number;
  pruneBatches: number;
  /**
   * Every this many passes (and on a process's first) the roll-up looks for
   * unrolled hours across all of raw, not only after the newest rolled hour.
   * See MetricsService.rollUp.
   */
  fullScanPasses: number;
}

export const METRIC_LIMITS = {
  rawHours: { def: 48, min: 24, max: 168 },
  hourlyDays: { def: 90, min: 7, max: 400 },
  minIntervalSeconds: { def: 60, min: 30, max: 900 },
  sweepSeconds: { def: 300, min: 2, max: 3600 },
  rollupHoursPerPass: { def: 6, min: 1, max: 48 },
  pruneBatch: { def: 5000, min: 1, max: 50_000 },
  pruneBatches: { def: 10, min: 1, max: 100 },
  fullScanPasses: { def: 12, min: 1, max: 288 },
} as const;

function bounded(raw: string | undefined, lim: { def: number; min: number; max: number }): number {
  if (raw === undefined || raw.trim() === '') return lim.def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return lim.def;
  return Math.min(lim.max, Math.max(lim.min, Math.round(n)));
}

/** Read from the environment; anything missing or unparsable takes the default, anything out of range is clamped. */
export function metricConfig(env: Record<string, string | undefined>): MetricConfig {
  return {
    rawHours: bounded(env.METRIC_RAW_HOURS, METRIC_LIMITS.rawHours),
    hourlyDays: bounded(env.METRIC_HOURLY_DAYS, METRIC_LIMITS.hourlyDays),
    minIntervalSeconds: bounded(env.METRIC_MIN_INTERVAL_SECONDS, METRIC_LIMITS.minIntervalSeconds),
    sweepSeconds: bounded(env.METRIC_SWEEP_SECONDS, METRIC_LIMITS.sweepSeconds),
    rollupHoursPerPass: bounded(env.METRIC_ROLLUP_HOURS_PER_PASS, METRIC_LIMITS.rollupHoursPerPass),
    pruneBatch: bounded(env.METRIC_PRUNE_BATCH, METRIC_LIMITS.pruneBatch),
    pruneBatches: bounded(env.METRIC_PRUNE_BATCHES, METRIC_LIMITS.pruneBatches),
    fullScanPasses: bounded(env.METRIC_FULL_SCAN_PASSES, METRIC_LIMITS.fullScanPasses),
  };
}

// ── Samples ─────────────────────────────────────────────────────────────────

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const pct = (v: number) => Math.round(Math.min(100, Math.max(0, v)) * 10) / 10;

/** Used share of a total, or null when the pair does not describe one. */
export function usedPercent(total: unknown, free: unknown): number | null {
  if (!finite(total) || !finite(free) || total <= 0 || free < 0 || free > total) return null;
  return pct(((total - free) / total) * 100);
}

/**
 * What a heartbeat's (already sanitised) live values become as a sample.
 * Null when it carried none of the three: a row of nulls is not evidence of
 * anything and would hide a gap.
 */
export function sampleFromLive(live: {
  cpuLoadPercent?: number | null; memoryTotalMb?: number | null; memoryFreeMb?: number | null;
  systemDiskTotalMb?: number | null; systemDiskFreeMb?: number | null;
}): { cpu: number | null; memory: number | null; disk: number | null } | null {
  const cpu = finite(live.cpuLoadPercent) && live.cpuLoadPercent >= 0 && live.cpuLoadPercent <= 100 ? pct(live.cpuLoadPercent) : null;
  const memory = usedPercent(live.memoryTotalMb, live.memoryFreeMb);
  const disk = usedPercent(live.systemDiskTotalMb, live.systemDiskFreeMb);
  if (cpu === null && memory === null && disk === null) return null;
  return { cpu, memory, disk };
}

/** Each volume's used share from an inventory pass's (sanitised) disk list; one per drive, at most 32. */
export function diskSamples(disks: { drive: string; totalBytes: number | null; freeBytes: number | null }[] | null | undefined) {
  const seen = new Set<string>();
  const out: { drive: string; used: number }[] = [];
  for (const d of disks ?? []) {
    if (!d?.drive || seen.has(d.drive) || out.length >= 32) continue;
    const used = usedPercent(d.totalBytes, d.freeBytes);
    if (used === null) continue;
    seen.add(d.drive);
    out.push({ drive: d.drive, used });
  }
  return out;
}

// ── Roll-up ─────────────────────────────────────────────────────────────────

export function hourStart(t: number): number { return Math.floor(t / HOUR_MS) * HOUR_MS; }

export interface HourRow {
  hour: number; samples: number;
  cpuMin: number | null; cpuAvg: number | null; cpuMax: number | null;
  memoryMin: number | null; memoryAvg: number | null; memoryMax: number | null;
  diskMin: number | null; diskAvg: number | null; diskMax: number | null;
}

function stats(vs: (number | null)[]) {
  const xs = vs.filter(finite);
  if (!xs.length) return { min: null, avg: null, max: null };
  return { min: Math.min(...xs), avg: xs.reduce((a, b) => a + b, 0) / xs.length, max: Math.max(...xs) };
}

/**
 * The roll-up of samples, grouped by the hour they fall in. The reference the
 * SQL in MetricsService.rollUp must agree with (e2e proves it does): min,
 * mean and max over the samples that carried the metric, and `samples` the
 * number of heartbeats the hour actually had. A metric no sample carried is
 * null, not zero.
 */
export function rollup(samples: { at: number; cpu: number | null; memory: number | null; disk: number | null }[]): HourRow[] {
  const by = new Map<number, typeof samples>();
  for (const s of samples) {
    const h = hourStart(s.at);
    const list = by.get(h) ?? [];
    list.push(s);
    by.set(h, list);
  }
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([hour, xs]) => {
    const c = stats(xs.map((x) => x.cpu)), m = stats(xs.map((x) => x.memory)), d = stats(xs.map((x) => x.disk));
    return {
      hour, samples: xs.length,
      cpuMin: c.min, cpuAvg: c.avg, cpuMax: c.max,
      memoryMin: m.min, memoryAvg: m.avg, memoryMax: m.max,
      diskMin: d.min, diskAvg: d.avg, diskMax: d.max,
    };
  });
}

/**
 * The exclusive end of what a pass may roll: hours that started before this
 * are complete (with ROLLUP_GRACE_MS, so a heartbeat in flight at :59 is in
 * its hour). The current hour is never rolled; reads compute it from raw.
 */
export function lastCompleteHour(now: number): number { return hourStart(now - ROLLUP_GRACE_MS); }

/**
 * Which of the hours that have samples but no roll-up a pass takes: the
 * oldest first, complete ones only, at most `maxHours`. Oldest first is what
 * keeps a backlog (the sweep was off for a week) from starving: every pass
 * moves the oldest hours, which are also the ones closest to being pruned.
 */
export function hoursToRoll(candidates: number[], now: number, maxHours: number): number[] {
  const end = lastCompleteHour(now);
  return [...new Set(candidates.map(hourStart))].filter((h) => h < end).sort((x, y) => x - y).slice(0, Math.max(0, maxHours));
}

/**
 * What a pass may delete, as cutoffs. Raw samples additionally go only once
 * their hour has been rolled up (the DELETE checks that), so a backlog the
 * bounded roll-up has not reached yet is kept until it has — turning the sweep
 * back on after a week loses nothing the raw table still held.
 */
export function pruneCutoffs(a: { now: number; rawHours: number; hourlyDays: number }) {
  return {
    raw: a.now - a.rawHours * HOUR_MS,
    hourly: a.now - a.hourlyDays * 24 * HOUR_MS,
    disk: a.now - a.hourlyDays * 24 * HOUR_MS,
  };
}

// ── Gaps ────────────────────────────────────────────────────────────────────

/**
 * Where a series has no data, as intervals. `times` are sorted sample (or
 * bucket-start) times; each covers `span` ms (0 for an instant, an hour for a
 * bucket). A gap is any stretch longer than `maxGapMs` with nothing in it,
 * including before the first point (from `from`) and after the last (to `to`).
 * No points at all is one gap over the whole window.
 */
export function findGaps(times: number[], o: { from: number; to: number; maxGapMs: number; span?: number }): { from: number; to: number }[] {
  const span = o.span ?? 0;
  if (o.to <= o.from) return [];
  if (!times.length) return [{ from: o.from, to: o.to }];
  const gaps: { from: number; to: number }[] = [];
  if (times[0] - o.from > o.maxGapMs) gaps.push({ from: o.from, to: times[0] });
  for (let i = 1; i < times.length; i++) {
    const end = times[i - 1] + span;
    if (times[i] - times[i - 1] > Math.max(o.maxGapMs, span)) gaps.push({ from: end, to: times[i] });
  }
  const last = times[times.length - 1] + span;
  if (o.to - last > o.maxGapMs) gaps.push({ from: last, to: o.to });
  return gaps;
}

/**
 * The hourly series for a window: the rolled-up rows, plus the hours the sweep
 * has not rolled yet computed from raw on the fly (the current hour, and any
 * backlog). A rolled row wins over a live one for the same hour.
 */
export function mergeHourly(rolled: HourRow[], live: HourRow[]): HourRow[] {
  const by = new Map<number, HourRow>();
  for (const r of live) by.set(r.hour, r);
  for (const r of rolled) by.set(r.hour, r);
  return [...by.values()].sort((a, b) => a.hour - b.hour);
}

export const round1 = (v: number | null | undefined) => (finite(v) ? Math.round(v * 10) / 10 : null);
