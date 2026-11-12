#!/usr/bin/env node
// Tests for the shared hbbs peer snapshot (src/enrollment/hbbs-peer-snapshot.ts),
// run against dist:
//
//   node apps/api/scripts/unit-hbbs-peer-snapshot.mjs
//
// The property under test is the fail-safe one: a snapshot is never used once
// its window has passed, a failed read never falls back to an older snapshot,
// an unreadable table answers null (unknown), and the window cannot be
// configured past its ceiling. With sqlite3 on PATH it also reads a real
// scratch peer table through the production query, including a peer ID that
// tries to smuggle a second ID in with a newline.

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync, execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const m = require(join(here, '..', 'dist', 'enrollment', 'hbbs-peer-snapshot.js'));

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => { if (ok) passed++; else failures.push(`${name}${detail ? ` — ${detail}` : ''}`); };

let clock = 1_000_000;
const now = () => clock;
function fakeTable(initial) {
  const t = { ids: new Set(initial), fail: false, delayMs: 0, reads: 0 };
  t.load = async () => {
    t.reads++;
    if (t.delayMs) await new Promise((r) => setTimeout(r, t.delayMs));
    if (t.fail) throw new Error('unreadable');
    return new Set(t.ids);
  };
  return t;
}

// ── window clamping ──
check('default window is 10 s', m.clampWindowMs(undefined) === 10_000 && m.DEFAULT_WINDOW_MS === 10_000);
check('window is clamped to at most 30 s', m.clampWindowMs(3_600_000) === 30_000 && m.MAX_WINDOW_MS === 30_000);
check('window is clamped to at least 1 s', m.clampWindowMs(5) === 1_000);
check('nonsense window falls back to the default', m.clampWindowMs('abc') === 10_000 && m.clampWindowMs(-5) === 10_000 && m.clampWindowMs(0) === 10_000 && m.clampWindowMs(Infinity) === 10_000);
check('the snapshot applies the clamp itself', new m.HbbsPeerSnapshot(async () => new Set(), 86_400_000).windowMs === 30_000);

// ── parsing ──
{
  const ids = m.parsePeerIds('123456789\n\n  987654321 \nabc123456\n12345\n1234567890123456\n555555\n');
  check('parsePeerIds keeps 6–15 digit IDs only', ids.size === 3 && ids.has('123456789') && ids.has('987654321') && ids.has('555555'), [...ids].join(','));
}

// ── answers and staleness ──
{
  clock = 1_000_000;
  const t = fakeTable(['111111111']);
  const s = new m.HbbsPeerSnapshot(t.load, 10_000, now);
  check('registered ID answers true', (await s.has('111111111')) === true);
  check('unregistered ID answers false', (await s.has('222222222')) === false);
  check('invalid ID answers null without a read', (await s.has('abc')) === null && (await s.has('12345')) === null && (await s.has("1'; DROP")) === null && t.reads === 1);
  for (let i = 0; i < 500; i++) await s.has(String(300_000_000 + i));
  check('500 lookups inside the window share one read', t.reads === 1, `reads=${t.reads}`);

  // Deleted from hbbs: true for at most the window, then false.
  t.ids.delete('111111111');
  clock += 9_999;
  check('a deleted ID may still answer true inside the window', (await s.has('111111111')) === true && t.reads === 1);
  clock += 1;
  check('a deleted ID answers false once the window has passed', (await s.has('111111111')) === false && t.reads === 2);

  // Registered later: picked up after at most the window.
  t.ids.add('222222222');
  check('a newly registered ID may answer false inside the window', (await s.has('222222222')) === false && t.reads === 2);
  clock += 10_000;
  check('a newly registered ID answers true after the window', (await s.has('222222222')) === true && t.reads === 3);

  // Unreadable: null, never the older snapshot.
  t.fail = true;
  clock += 10_000;
  check('an unreadable table answers null, not the expired snapshot', (await s.has('222222222')) === null && t.reads === 4);
  check('an unreadable table answers null for an unknown ID too', (await s.has('999999999')) === null);
  check('the failure is remembered for the window (no read per call)', t.reads === 4, `reads=${t.reads}`);
  clock += 10_000;
  check('after the window it tries again', (await s.has('222222222')) === null && t.reads === 5);
  t.fail = false;
  clock += 10_000;
  check('a readable table answers again after recovering', (await s.has('222222222')) === true && t.reads === 6);

  // Clock moved backwards: treated as stale, re-read.
  clock -= 60_000;
  t.ids.delete('222222222');
  check('a clock that went backwards forces a re-read', (await s.has('222222222')) === false && t.reads === 7);
}

// ── the window is measured from when the read started ──
{
  clock = 5_000_000;
  const t = fakeTable(['111111111']);
  t.delayMs = 30;
  const s = new m.HbbsPeerSnapshot(t.load, 10_000, now);
  const p = s.has('111111111');
  clock += 4_000; // the read "took" 4 s
  check('answer from a slow read', (await p) === true);
  t.delayMs = 0;
  t.ids.delete('111111111');
  clock += 6_000; // 10 s after the read started, 6 s after it finished
  check('a slow read does not stretch the window', (await s.has('111111111')) === false && t.reads === 2, `reads=${t.reads}`);
}

// ── concurrent callers share one read ──
{
  clock = 9_000_000;
  const t = fakeTable(['111111111']);
  t.delayMs = 20;
  const s = new m.HbbsPeerSnapshot(t.load, 10_000, now);
  const answers = await Promise.all(Array.from({ length: 50 }, (_, i) => s.has(i % 2 ? '111111111' : '222222222')));
  check('50 concurrent callers share one read', t.reads === 1 && answers.filter((a) => a === true).length === 25 && answers.filter((a) => a === false).length === 25, `reads=${t.reads}`);
  t.fail = true;
  clock += 10_000;
  const failed = await Promise.all(Array.from({ length: 20 }, () => s.has('111111111')));
  check('concurrent callers of a failed read all get null', t.reads === 2 && failed.every((a) => a === null));
}

// ── the real query against a scratch sqlite database ──
const haveSqlite = spawnSync('sqlite3', ['-version']).status === 0;
if (haveSqlite) {
  const dir = mkdtempSync(join(tmpdir(), 'rem0te-peers-'));
  try {
    const db = join(dir, 'db_v2.sqlite3');
    execFileSync('sqlite3', [db, "CREATE TABLE peer(id TEXT PRIMARY KEY); INSERT INTO peer VALUES('123456789'),('987654321'),('abcdefghi'),('1234'),('55555555' || char(10) || '444444444');"]);
    const out = execFileSync('sqlite3', [`file:${db}?mode=ro`, m.PEER_SNAPSHOT_SQL]).toString();
    const ids = m.parsePeerIds(out);
    check('the production query returns the digit IDs', ids.has('123456789') && ids.has('987654321'));
    check('a peer ID with a newline cannot smuggle a second ID in', !ids.has('444444444') && !ids.has('55555555'), JSON.stringify(out));
    check('non-digit and short IDs are not returned', !ids.has('abcdefghi') && !ids.has('1234') && ids.size === 2);
    const r = spawnSync('sqlite3', [`file:${join(dir, 'missing.sqlite3')}?mode=ro`, m.PEER_SNAPSHOT_SQL]);
    check('a missing database is an error (so null), not an empty table', r.status !== 0);
    execFileSync('sqlite3', [join(dir, 'empty.sqlite3'), 'CREATE TABLE other(x);']);
    const r2 = spawnSync('sqlite3', [`file:${join(dir, 'empty.sqlite3')}?mode=ro`, m.PEER_SNAPSHOT_SQL]);
    check('a database without a peer table is an error (so null)', r2.status !== 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
} else {
  console.log('SKIP: sqlite3 not on PATH — the real-query checks did not run');
  // CI must not pass by skipping the one check against real SQLite.
  check('sqlite3 is available in CI', !process.env.CI, 'install sqlite3 on the runner');
}

if (failures.length) {
  console.error(`\n${failures.length} FAILED, ${passed} passed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`\n${passed} passed`);
