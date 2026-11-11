#!/usr/bin/env node
/**
 * Metric history (0.33): the arithmetic in src/metrics/metrics-math.ts.
 * Samples from heartbeat values, the hourly roll-up, which hours a pass rolls,
 * retention cutoffs and their caps, gap detection and the hourly merge.
 * Pure: no database, no API. Needs a built dist (`npx nest build`).
 *
 *   node scripts/unit-metric-history.mjs
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const M = require(path.join(dist, 'metrics/metrics-math.js'));

let pass = 0, fail = 0; const failures = [];
const check = (c, m, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${m}`); } else { fail++; failures.push(m); console.log(`  \x1b[31m✗\x1b[0m ${m}${d ? `\n      ${d}` : ''}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const H = M.HOUR_MS, MIN = M.MINUTE_MS;
const T0 = Date.parse('2026-11-10T00:00:00Z');

section('Samples from heartbeat values');
check(eq(M.sampleFromLive({ cpuLoadPercent: 37, memoryTotalMb: 16000, memoryFreeMb: 4000, systemDiskTotalMb: 500000, systemDiskFreeMb: 125000 }), { cpu: 37, memory: 75, disk: 75 }),
  'cpu as sent; memory and disk as used share of total');
check(eq(M.sampleFromLive({ memoryTotalMb: 3, memoryFreeMb: 1 }), { cpu: null, memory: 66.7, disk: null }), 'rounded to one decimal; missing metrics are null, not 0');
check(M.sampleFromLive({}) === null, 'a heartbeat with none of the three writes no sample');
check(M.sampleFromLive({ memoryTotalMb: 0, memoryFreeMb: 0 }) === null, 'a zero total is not a reading');
check(M.sampleFromLive({ memoryTotalMb: 100, memoryFreeMb: 200 }) === null, 'free above total is not a reading');
check(M.sampleFromLive({ cpuLoadPercent: 140 }) === null && M.sampleFromLive({ cpuLoadPercent: -1 }) === null, 'cpu outside 0..100 is not a reading');
check(M.sampleFromLive({ cpuLoadPercent: NaN, memoryTotalMb: Infinity, memoryFreeMb: 1 }) === null, 'NaN and Infinity are not readings');
check(M.usedPercent(100, 0) === 100 && M.usedPercent(100, 100) === 0, 'full and empty are 100 and 0');

section('Per-volume samples from an inventory pass');
const vols = M.diskSamples([
  { drive: 'C:', totalBytes: 1000, freeBytes: 250 }, { drive: 'D:', totalBytes: 2000, freeBytes: 2000 },
  { drive: 'C:', totalBytes: 1000, freeBytes: 0 }, { drive: 'E:', totalBytes: null, freeBytes: 5 }, { drive: '', totalBytes: 1, freeBytes: 0 },
]);
check(eq(vols, [{ drive: 'C:', used: 75 }, { drive: 'D:', used: 0 }]), 'one sample per drive (first wins), unreadable volumes skipped', JSON.stringify(vols));
check(M.diskSamples(Array.from({ length: 40 }, (_, i) => ({ drive: `/m${i}`, totalBytes: 10, freeBytes: 5 }))).length === 32, 'at most 32 volumes');
check(eq(M.diskSamples(null), []), 'no list, no samples');

section('Hourly roll-up');
const samples = [
  { at: T0 + 1 * MIN, cpu: 10, memory: 50, disk: 70 },
  { at: T0 + 4 * MIN, cpu: 30, memory: 60, disk: null },
  { at: T0 + 59 * MIN, cpu: 20, memory: 55, disk: 72 },
  { at: T0 + H, cpu: 90, memory: null, disk: null },
  { at: T0 + 3 * H + 5 * MIN, cpu: null, memory: null, disk: 80 },
];
const r = M.rollup(samples);
check(r.length === 3 && r[0].hour === T0 && r[1].hour === T0 + H && r[2].hour === T0 + 3 * H, 'grouped by the hour each sample falls in; 3:00 is not 2:00', JSON.stringify(r.map((x) => x.hour - T0)));
check(r[0].samples === 3 && r[0].cpuMin === 10 && r[0].cpuMax === 30 && r[0].cpuAvg === 20, 'min / mean / max of cpu over the hour');
check(r[0].memoryAvg === 55 && r[0].diskMin === 70 && r[0].diskMax === 72 && r[0].diskAvg === 71, 'a null in one sample is left out of that metric\'s mean, not counted as 0');
check(r[1].samples === 1 && r[1].memoryAvg === null && r[1].diskAvg === null && r[1].cpuAvg === 90, 'an hour whose samples never carried a metric has null for it');
check(r.every((x) => x.hour % H === 0), 'bucket starts are whole hours');
check(M.rollup([]).length === 0, 'no samples, no hours');
check(eq(M.rollup([...samples].reverse()), r), 'order of input does not matter');

section('Which hours a pass rolls');
const now = T0 + 10 * H + 1 * MIN; // 10:01 — inside the grace after 10:00
check(M.lastCompleteHour(now) === T0 + 9 * H, 'at 10:01 the 9:00 hour is still in its grace period');
check(M.lastCompleteHour(T0 + 10 * H + 3 * MIN) === T0 + 10 * H, 'at 10:03 everything before 10:00 is complete');
const cands = [T0 + 9 * H + 5 * MIN, T0 + 2 * H, T0 + 2 * H + 30 * MIN, T0 + 5 * H, T0 + 7 * H, T0 + 3 * H];
check(eq(M.hoursToRoll(cands, now, 3), [T0 + 2 * H, T0 + 3 * H, T0 + 5 * H]), 'oldest first, distinct, at most maxHours');
check(!M.hoursToRoll(cands, now, 48).includes(T0 + 9 * H), 'the hour in progress (or in its grace) is never rolled');
check(eq(M.hoursToRoll([], now, 6), []), 'nothing waiting, nothing rolled');

section('Retention and caps');
const def = M.metricConfig({});
check(def.rawHours === 48 && def.hourlyDays === 90 && def.minIntervalSeconds === 60 && def.sweepSeconds === 300, 'defaults: 48 h raw, 90 d hourly, 1 sample a minute, sweep every 5 min');
check(def.rollupHoursPerPass === 6 && def.pruneBatch === 5000 && def.pruneBatches === 10, 'defaults: 6 hours and ≤ 10 × 5000 deletes per table per pass');
const lo = M.metricConfig({ METRIC_RAW_HOURS: '1', METRIC_HOURLY_DAYS: '0', METRIC_MIN_INTERVAL_SECONDS: '1', METRIC_PRUNE_BATCH: '-5' });
check(lo.rawHours === 24 && lo.hourlyDays === 7 && lo.minIntervalSeconds === 30 && lo.pruneBatch === 1, 'floors: raw 24 h (the 24 h range reads raw), hourly 7 d, 30 s');
const hi = M.metricConfig({ METRIC_RAW_HOURS: '100000', METRIC_HOURLY_DAYS: '99999', METRIC_ROLLUP_HOURS_PER_PASS: '1000', METRIC_PRUNE_BATCHES: '1e9' });
check(hi.rawHours === 168 && hi.hourlyDays === 400 && hi.rollupHoursPerPass === 48 && hi.pruneBatches === 100, 'ceilings: raw 7 d, hourly 400 d, 48 hours and 100 batches per pass');
check(M.metricConfig({ METRIC_RAW_HOURS: 'lots', METRIC_HOURLY_DAYS: '' }).rawHours === 48, 'unparsable values take the default');
const c = M.pruneCutoffs({ now: T0, rawHours: 48, hourlyDays: 90 });
check(c.raw === T0 - 48 * H && c.hourly === T0 - 90 * 24 * H && c.disk === c.hourly, 'cutoffs: raw at now − 48 h, hourly and per-volume at now − 90 d');

section('Ranges');
check(M.parseRange(undefined) === '24h' && M.parseRange('7d') === '7d' && M.parseRange('90d') === '90d', 'default 24h; the four ranges parse');
check(M.parseRange('1y') === null && M.parseRange('toString') === null && M.parseRange(['7d']) === null, 'anything else is refused (including prototype keys and arrays)');
check(M.RANGES['24h'].resolution === 'raw' && M.RANGES['7d'].resolution === 'hour', '24 h reads raw, longer ranges hourly');

section('Gaps');
const beat = (n) => Array.from({ length: n }, (_, i) => T0 + i * 3 * MIN);
check(eq(M.findGaps(beat(20), { from: T0, to: T0 + 57 * MIN, maxGapMs: M.RAW_GAP_MS }), []), 'a heartbeat every 3 minutes has no gaps');
const missed = [T0, T0 + 3 * MIN, T0 + 6 * MIN, T0 + 15 * MIN, T0 + 18 * MIN];
check(eq(M.findGaps(missed, { from: T0, to: T0 + 18 * MIN, maxGapMs: M.RAW_GAP_MS }), []), 'two missed check-ins (9 min) are not a gap');
const off = [T0, T0 + 3 * MIN, T0 + 60 * MIN, T0 + 63 * MIN];
check(eq(M.findGaps(off, { from: T0, to: T0 + 63 * MIN, maxGapMs: M.RAW_GAP_MS }), [{ from: T0 + 3 * MIN, to: T0 + 60 * MIN }]), 'an hour offline is one gap, from the last sample to the next — nothing in between');
check(eq(M.findGaps([T0 + 30 * MIN], { from: T0, to: T0 + 31 * MIN, maxGapMs: M.RAW_GAP_MS }), [{ from: T0, to: T0 + 30 * MIN }]), 'a gap before the first sample');
check(eq(M.findGaps([T0], { from: T0, to: T0 + 30 * MIN, maxGapMs: M.RAW_GAP_MS }), [{ from: T0, to: T0 + 30 * MIN }]), 'a gap after the last sample (offline now)');
check(eq(M.findGaps([], { from: T0, to: T0 + H, maxGapMs: M.RAW_GAP_MS }), [{ from: T0, to: T0 + H }]), 'no samples at all is one gap over the window');
const hours = [T0, T0 + H, T0 + 2 * H, T0 + 5 * H, T0 + 6 * H];
check(eq(M.findGaps(hours, { from: T0, to: T0 + 6 * H + 30 * MIN, maxGapMs: H, span: H }), [{ from: T0 + 3 * H, to: T0 + 5 * H }]), 'hourly: consecutive buckets are continuous; two missing hours are one gap from the end of the last bucket');
check(eq(M.findGaps([T0, T0 + 13 * H], { from: T0, to: T0 + 13 * H, maxGapMs: M.DISK_GAP_MS }), []) && M.findGaps([T0, T0 + 14 * H], { from: T0, to: T0 + 14 * H, maxGapMs: M.DISK_GAP_MS }).length === 1,
  'per-volume (every 6 h): 13 h is two missed passes plus slack, 14 h is a gap');

section('Hourly merge (rolled + not yet rolled)');
const row = (h, avg) => ({ hour: T0 + h * H, samples: 1, cpuMin: avg, cpuAvg: avg, cpuMax: avg, memoryMin: null, memoryAvg: null, memoryMax: null, diskMin: null, diskAvg: null, diskMax: null });
const merged = M.mergeHourly([row(0, 1), row(1, 2)], [row(1, 99), row(2, 3)]);
check(eq(merged.map((x) => [x.hour - T0, x.cpuAvg]), [[0, 1], [H, 2], [2 * H, 3]]), 'a rolled hour wins over its live recomputation; unrolled hours are added; sorted');
check(M.round1(12.345) === 12.3 && M.round1(null) === null && M.round1(NaN) === null, 'round1 leaves nulls null');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1); }
console.log('ALL PASSED');
