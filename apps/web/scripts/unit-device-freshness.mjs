#!/usr/bin/env node
// Tests for how old each device tab's data is (0.88, UX P1-2),
// apps/web/lib/device-freshness.ts.
//
//   node apps/web/scripts/unit-device-freshness.mjs
//
// The module is pure (no imports), so it is transpiled with the workspace's
// TypeScript and run as it is. Covered: every freshness tab, the label and
// source each uses, that "stale" is said only under an existing rule (the
// heartbeat window, the server's patch-scan verdict, the snapshot tabs' own
// window), that a missing or unreadable time is "not reported yet" and never
// fresh, the boundary of each window, relative ages, and that the page wires
// the rule to HEARTBEAT_STALE_MS and the snapshot tabs' OLD_MS, never a literal.

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const WEB = join(here, '..');
const require = createRequire(join(WEB, 'package.json'));
const ts = require('typescript');
const src = readFileSync(join(WEB, 'lib', 'device-freshness.ts'), 'utf8');
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText;
if (/\brequire\s*\(/.test(js)) throw new Error('lib/device-freshness.ts imports a module: it must stay pure');
if (/Date\.now\(\)|new Date\(\)/.test(src)) throw new Error('lib/device-freshness.ts reads the clock: it must take `now`');
const mod = { exports: {} };
new Function('module', 'exports', js)(mod, mod.exports);
const F = mod.exports;

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => { if (ok) passed++; else failures.push(`${name}${detail ? ` — ${detail}` : ''}`); };
const j = (x) => JSON.stringify(x);

const NOW = Date.parse('2026-11-26T12:00:00Z');
const HB = 30 * 60_000;
const DAY = 24 * 3600_000;
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const fr = (tab, facts) => F.tabFreshness(tab, facts, NOW, HB);

// Every freshness tab is a real device tab, and only these have a line.
const model = readFileSync(join(WEB, 'components', 'endpoints', 'workspace', 'device-model.ts'), 'utf8');
const groups = model.match(/export const TAB_GROUPS[\s\S]*?\n\];/)?.[0] ?? '';
for (const t of F.FRESHNESS_TABS) check(`${t} is a device tab`, groups.includes(`'${t}'`));
for (const t of ['events', 'diagnostics', 'actions', 'terminal', 'files', 'chat', 'history', 'nonsense']) {
  check(`${t} has no freshness line (its rows carry their own times)`, fr(t, { lastSeenAt: iso(0), inventoryAt: iso(0) }) === null);
}

// Overview and Software: the inventory's age, no verdict.
for (const t of ['overview', 'software']) {
  const x = fr(t, { inventoryAt: iso(5 * DAY), lastSeenAt: iso(0) });
  check(`${t}: Inventory collected, age only — no rule says when an inventory is stale`, x.label === 'Inventory collected' && x.verdict === 'none' && x.at === iso(5 * DAY), j(x));
  const n = fr(t, { inventoryAt: null, lastSeenAt: iso(0) });
  check(`${t}: no inventory is "not reported yet", never fresh`, n.at === null && n.verdict === 'unknown', j(n));
}

// Performance: the heartbeat window, at its boundary.
check('performance: a check-in inside the window is fresh', fr('performance', { lastSeenAt: iso(HB) }).verdict === 'fresh');
check('performance: one millisecond past the window is stale', fr('performance', { lastSeenAt: iso(HB + 1) }).verdict === 'stale');
check('performance: Last check-in is the label', fr('performance', { lastSeenAt: iso(0) }).label === 'Last check-in');
check('performance: never checked in is unknown', fr('performance', {}).verdict === 'unknown');

// Monitoring: the agent's report, age only.
const m = fr('monitoring', { monitorReportAt: iso(3 * DAY) });
check('monitoring: Last monitoring report, age only', m.label === 'Last monitoring report' && m.verdict === 'none', j(m));
check('monitoring: no report is unknown', fr('monitoring', { monitorReportAt: null }).verdict === 'unknown');

// Patches: the server's verdict, never recomputed here.
check('patches: the server says fresh — fresh, even when old by the clock', fr('patches', { patchScan: { at: iso(40 * DAY), freshness: 'fresh' } }).verdict === 'fresh');
check('patches: the server says stale — stale, even when recent', fr('patches', { patchScan: { at: iso(60_000), freshness: 'stale' } }).verdict === 'stale');
check('patches: no scan is unknown', fr('patches', { patchScan: { at: null, freshness: 'none' } }).verdict === 'unknown');
check('patches: the server says none with a time — still unknown', fr('patches', { patchScan: { at: iso(0), freshness: 'none' } }).verdict === 'unknown');
check('patches: summary not read is unknown', fr('patches', { patchScan: null }).verdict === 'unknown');
check('patches: Update scan is the label', fr('patches', { patchScan: null }).label === 'Update scan');

// Snapshots: the snapshot tabs' own window when given, age only without it.
for (const t of ['processes', 'services', 'network']) {
  check(`${t}: under the window, fresh`, fr(t, { snapshotAt: iso(DAY), snapshotStaleMs: DAY }).verdict === 'fresh');
  check(`${t}: over the window, stale`, fr(t, { snapshotAt: iso(DAY + 1), snapshotStaleMs: DAY }).verdict === 'stale');
  check(`${t}: without a window, age only`, fr(t, { snapshotAt: iso(10 * DAY) }).verdict === 'none');
  check(`${t}: never taken is unknown`, fr(t, { snapshotAt: null, snapshotStaleMs: DAY }).verdict === 'unknown');
  check(`${t}: Snapshot taken is the label`, fr(t, {}).label === 'Snapshot taken');
}

// An unreadable time is treated as missing, everywhere.
for (const t of F.FRESHNESS_TABS) {
  const x = fr(t, { lastSeenAt: 'garbage', inventoryAt: 'garbage', monitorReportAt: 'garbage', snapshotAt: 'garbage', snapshotStaleMs: DAY, patchScan: { at: 'garbage', freshness: 'fresh' } });
  check(`${t}: an unreadable time is unknown, never fresh`, x.verdict === 'unknown' && x.at === null, j(x));
}

// Relative ages and the sentence.
const ages = [[0, 'just now'], [59_000, 'just now'], [60_000, '1 min ago'], [59 * 60_000, '59 min ago'], [60 * 60_000, '1 h ago'], [47 * 3600_000, '47 h ago'], [48 * 3600_000, '2 days ago']];
for (const [ms, want] of ages) check(`relativeAge(${ms}) = ${want}`, F.relativeAge(iso(ms), NOW) === want, F.relativeAge(iso(ms), NOW));
check('a time in the future is "just now", never negative', F.relativeAge(iso(-3600_000), NOW) === 'just now');
check('the sentence names stale', F.freshnessText({ label: 'Last check-in', at: iso(2 * HB), verdict: 'stale' }, NOW) === 'Last check-in 1 h ago — stale');
check('the sentence says not reported yet', F.freshnessText({ label: 'Update scan', at: null, verdict: 'unknown' }, NOW) === 'Update scan: not reported yet');

// The page passes the existing constants, never literals.
const page = readFileSync(join(WEB, 'app', '(app)', 'endpoints', '[id]', 'page.tsx'), 'utf8');
check('the page passes HEARTBEAT_STALE_MS from lib/connectivity', /tabFreshness\(active, \{[\s\S]*?\}, Date\.now\(\), HEARTBEAT_STALE_MS\)/.test(page) && /import \{ HEARTBEAT_STALE_MS \} from '@\/lib\/connectivity'/.test(page));
check('the page passes the snapshot tabs\' own OLD_MS', /snapshotStaleMs: SNAPSHOT_OLD_MS/.test(page) && /OLD_MS as SNAPSHOT_OLD_MS/.test(page));
check('the page says nothing until the source has loaded', /const freshness = !loaded \? null : tabFreshness\(/.test(page));
const snap = readFileSync(join(WEB, 'components', 'endpoints', 'workspace', 'snapshot-tabs.tsx'), 'utf8');
const hook = snap.match(/export function useSnapshotTakenAt[\s\S]*?\n\}/)?.[0] ?? '';
const own = snap.match(/function useSnapshot\([\s\S]*?\n\}/)?.[0] ?? '';
check('the snapshot time is read through the tab\'s own query key and route',
  /queryKey: \['diagnostics-snapshot', endpointId, key\]/.test(hook) && /queryKey: \['diagnostics-snapshot', endpointId, key\]/.test(own)
    && hook.includes('/diagnostics/snapshots/${key}') && own.includes('/diagnostics/snapshots/${key}') && /enabled: !!key/.test(hook));

console.log(`unit-device-freshness: ${passed} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1); }
