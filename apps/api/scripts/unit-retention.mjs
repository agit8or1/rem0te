#!/usr/bin/env node
/**
 * Data retention (0.34): the policy in src/retention/retention-policy.ts.
 * Defaults, clamps and parsing of every RETENTION_* variable, the cutoffs,
 * the per-pass cap and the batch loop, report coverage, and the table
 * inventory (the audit chain is evidence and never swept).
 * Pure: no database, no API. Needs a built dist (`npx nest build`).
 *
 *   node scripts/unit-retention.mjs
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const R = require(path.join(dist, 'retention/retention-policy.js'));

let pass = 0, fail = 0; const failures = [];
const check = (c, m, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${m}`); } else { fail++; failures.push(m); console.log(`  \x1b[31m✗\x1b[0m ${m}${d ? `\n      ${d}` : ''}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const DAY = R.DAY_MS;

section('Defaults');
const d = R.retentionConfig({});
check(eq(d, { commandDays: 90, diagnosticDays: 90, changeDays: 400, alertDays: 400, sessionDetailDays: 400, tokenDays: 30, privilegedDays: 30, sweepSeconds: 3600, batch: 2000, batches: 10 }),
  'an empty environment gives the documented defaults', JSON.stringify(d));
check(d.alertDays > 365, 'the default alert window covers the longest report period (365 days)');
check(R.RETENTION_LIMITS.privilegedDays.min * DAY > 1440 * 60_000, 'the privileged-activity floor is longer than the longest abuse-guard window (1,440 min)');
const envNames = Object.values(R.RETENTION_LIMITS).map((l) => l.env);
check(new Set(envNames).size === envNames.length && envNames.every((n) => /^RETENTION_[A-Z_]+$/.test(n)), 'every setting has its own RETENTION_* variable');

section('Clamps and parsing');
for (const [k, lim] of Object.entries(R.RETENTION_LIMITS)) {
  const lo = R.retentionConfig({ [lim.env]: String(lim.min - 1) })[k], hi = R.retentionConfig({ [lim.env]: String(lim.max * 10) })[k];
  const neg = R.retentionConfig({ [lim.env]: '-5' })[k];
  check(lo === lim.min && hi === lim.max && neg === lim.min, `${lim.env}: below ${lim.min} → ${lim.min}, above ${lim.max} → ${lim.max}`, `${lo} ${hi} ${neg}`);
}
check(R.retentionConfig({ RETENTION_ALERT_DAYS: 'forever' }).alertDays === 400, 'unparsable → default, never 0 or NaN');
check(R.retentionConfig({ RETENTION_ALERT_DAYS: '   ' }).alertDays === 400, 'blank → default');
check(R.retentionConfig({ RETENTION_ALERT_DAYS: 'Infinity' }).alertDays === 400, 'Infinity → default');
check(R.retentionConfig({ RETENTION_COMMAND_DAYS: '30.6' }).commandDays === 31, 'fractions are rounded');
check(R.retentionConfig({ RETENTION_ALERT_DAYS: '0' }).alertDays === 30, '0 cannot mean "delete everything": clamped to the floor');
check(R.retentionConfig({ RETENTION_COMMAND_DAYS: '1e9' }).commandDays === 3650, 'a huge value is the ceiling');
check(R.retentionConfig({ RETENTION_ALERT_DAYS: '500', RETENTION_COMMAND_DAYS: '14' }).alertDays === 500
  && R.retentionConfig({ RETENTION_ALERT_DAYS: '500', RETENTION_COMMAND_DAYS: '14' }).commandDays === 14, 'in-range values are taken as given');

section('Switch');
check(R.sweepEnabled({}) === true && R.sweepEnabled({ RETENTION_SWEEP: 'on' }) === true, 'on by default');
check(R.sweepEnabled({ RETENTION_SWEEP: 'off' }) === false, 'RETENTION_SWEEP=off turns it off');
check(R.sweepEnabled({ RETENTION_SWEEP: 'OFF ' }) === true, 'only the exact word off (the other sweeps use the same rule)');

section('Cutoffs');
const now = Date.parse('2026-11-11T12:00:00Z');
const c = R.cutoffs(now, d);
check(c.commands === now - 90 * DAY && c.diagnostics === now - 90 * DAY, 'commands and diagnostics: now − 90 d');
check(c.changes === now - 400 * DAY && c.alerts === now - 400 * DAY && c.sessionDetail === now - 400 * DAY, 'changes, alerts, session detail: now − 400 d');
check(c.tokens === now - 30 * DAY && c.privileged === now - 30 * DAY, 'tokens and privileged activity: now − 30 d');
const c2 = R.cutoffs(now, R.retentionConfig({ RETENTION_ALERT_DAYS: '1' }));
check(c2.alerts === now - 30 * DAY, 'a cutoff uses the clamped value, not the raw one');
check(Object.values(c).every((t) => t < now), 'every cutoff is in the past');

section('Bounded passes');
check(R.perPassCap(d) === 20_000, 'per-pass cap is batch × batches (2,000 × 10)');
const sim = async (backlog, batch, batches) => {
  let left = backlog, calls = 0;
  const total = await R.drain(async () => { calls++; const k = Math.min(batch, left); left -= k; return k; }, batch, batches);
  return { total, calls, left };
};
let r = await sim(25_000, 2000, 10);
check(r.total === 20_000 && r.calls === 10 && r.left === 5000, 'a backlog larger than the cap: exactly the cap, then stop', JSON.stringify(r));
r = await sim(3500, 2000, 10);
check(r.total === 3500 && r.calls === 2, 'a short batch ends the loop early', JSON.stringify(r));
r = await sim(0, 2000, 10);
check(r.total === 0 && r.calls === 1, 'nothing due: one statement, nothing removed');
r = await sim(4000, 2000, 10);
check(r.total === 4000 && r.calls === 3, 'an exact multiple takes one more (empty) statement to notice', JSON.stringify(r));
r = await sim(10, 1, 3);
check(r.total === 3 && r.left === 7, 'RETENTION_BATCH=1, RETENTION_BATCHES=3: three rows per pass', JSON.stringify(r));

section('Report coverage');
check(eq(R.reportCoverage(400, 365), { alertDays: 400, periodDays: 365, complete: true, coversDays: 365 }), '400-day retention: a 365-day report is complete');
check(eq(R.reportCoverage(90, 365), { alertDays: 90, periodDays: 365, complete: false, coversDays: 90 }), '90-day retention: a 365-day report covers 90 days and says so');
check(R.reportCoverage(90, 90).complete === true && R.reportCoverage(89, 90).complete === false, 'the boundary: period ≤ retention is complete');

section('Table inventory');
const T = R.RETENTION_TABLES;
const by = Object.fromEntries(T.map((t) => [t.table, t]));
check(by.ActivityLog?.class === 'evidence' && by.ActivityLog.sweep === 'none' && by.AuditCheckpoint?.class === 'evidence' && by.AuditCheckpoint.sweep === 'none',
  'the audit log and its checkpoints are evidence, swept by nothing');
check(!R.SWEPT_TABLES.some((t) => R.NEVER_SWEPT.includes(t)), 'no swept table is on the never-swept list', R.SWEPT_TABLES.join(','));
check(T.filter((t) => t.class === 'evidence').every((t) => t.sweep === 'none' && !t.windowKey), 'no evidence table has a window or a sweep');
check(T.filter((t) => t.sweep === 'retention').every((t) => t.windowKey && t.windowKey in d), 'every swept table names its window');
check(['EndpointCommand', 'DiagnosticRun', 'EndpointChange', 'MonitorAlert', 'SupportSessionEvent', 'LauncherToken', 'ConnectionGrant', 'PrivilegedActivity'].every((t) => by[t]?.sweep === 'retention'),
  'the retention sweep covers commands, diagnostics, changes, alerts, session detail, tokens, grants and the abuse-guard window');
check(['EndpointMetricSample', 'EndpointMetricHourly', 'EndpointDiskSample'].every((t) => by[t]?.sweep === 'metrics'), 'metric tables are left to the metric sweep');
check(new Set(T.map((t) => t.key)).size === T.length && new Set(T.map((t) => t.table)).size === T.length, 'keys and tables are unique');
check(T.every((t) => /^[A-Za-z]+$/.test(t.table) && /^[A-Za-z]+$/.test(t.timeColumn)), 'table and column names are plain identifiers (they are interpolated into the count query)');
check(by.SupportSession?.class === 'evidence', 'session rows are kept; only their events\' detail is trimmed');

console.log(`\n${fail ? `\x1b[31m${fail} FAILED\x1b[0m, ` : ''}${pass} passed`);
if (fail) { for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1); }
