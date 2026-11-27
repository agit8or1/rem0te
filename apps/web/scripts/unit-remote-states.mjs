#!/usr/bin/env node
// Tests for the eight remote-support states (0.91, UX P1-5),
// apps/web/lib/remote-states.ts.
//
//   node apps/web/scripts/unit-remote-states.mjs
//
// The module is pure (no imports), so it is transpiled with the workspace's
// TypeScript and run as it is. Covered: the directive's eight stages in its
// order; every SessionStatus in the schema maps to exactly one; "Session
// active" needs the computer's agent and a recent signal, and nothing else
// gets it; a released credential or an opened client never reads as a
// connection; the API's STATUS_LABEL says the same words; every Managed
// Secure Access timeline step maps, and Launched is never a connection; no
// page prints a raw status.

import { createRequire } from 'node:module';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const WEB = join(here, '..');
const ROOT = join(WEB, '..', '..');
const require = createRequire(join(WEB, 'package.json'));
const ts = require('typescript');
const src = readFileSync(join(WEB, 'lib', 'remote-states.ts'), 'utf8');
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText;
if (/\brequire\s*\(/.test(js)) throw new Error('lib/remote-states.ts imports a module: it must stay pure');
const mod = { exports: {} };
new Function('module', 'exports', js)(mod, mod.exports);
const R = mod.exports;

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => { if (ok) passed++; else failures.push(`${name}${detail ? ` — ${detail}` : ''}`); };

// The directive's eight, in its order (§12 "Clearly distinguish").
const DIRECTIVE = ['Launch requested', 'Authorization granted', 'Client opened', 'Device connection confirmed', 'Session active', 'Session ended', 'Session failed', 'Connection state unknown'];
check('the eight stages are the directive\'s, in its order', JSON.stringify(R.STAGES.map((s) => s.label)) === JSON.stringify(DIRECTIVE), R.STAGES.map((s) => s.label).join(', '));
check('every stage says what it means', R.STAGES.every((s) => s.meaning.length > 15));

// Every status the API can store.
const schema = readFileSync(join(ROOT, 'apps', 'api', 'prisma', 'schema.prisma'), 'utf8');
const statuses = [...((schema.match(/enum SessionStatus \{([\s\S]*?)\}/) ?? ['', ''])[1]).matchAll(/^\s*([A-Z_]+)\s*$/gm)].map((m) => m[1]);
check('the schema has the nine statuses', statuses.length === 9, statuses.join(','));
for (const st of statuses) check(`${st} maps to a stage`, typeof R.STATUS_STAGE[st] === 'string' && R.STAGES.some((s) => s.id === R.STATUS_STAGE[st]));
check('no status maps that the schema does not have', Object.keys(R.STATUS_STAGE).every((k) => statuses.includes(k)));

const now = Date.parse('2026-11-26T12:00:00Z');
const min = (m) => new Date(now - m * 60_000).toISOString();
const st = (s) => R.stageOf(s, now).stage;
// Before any connection: never a connection.
for (const s of ['PENDING', 'LAUNCH_REQUESTED', 'LAUNCHER_ACKNOWLEDGED', 'CLIENT_OPENED']) {
  const v = R.stageOf({ status: s, statusSource: 'endpoint_agent', lastSignalAt: min(1) }, now);
  check(`${s} is not a connection, whatever else the row says`, !['connection_confirmed', 'active', 'ended'].includes(v.stage), v.stage);
  check(`${s}'s words do not claim a connection`, !/connected|active/i.test(v.label) && !/(?<!not |no )connection (was )?confirmed/i.test(v.detail), `${v.label}: ${v.detail}`);
}
check('a released credential is "Authorization granted"', st({ status: 'LAUNCH_REQUESTED' }) === 'authorized');
check('a recorded launch is "Launch requested"', st({ status: 'PENDING' }) === 'launch_requested');
check('RustDesk opening is "Client opened"', st({ status: 'CLIENT_OPENED' }) === 'client_opened');
// Active: the agent, recently.
check('the agent seeing it 2 min ago is "Session active"', st({ status: 'SESSION_STARTED', statusSource: 'endpoint_agent', lastSignalAt: min(2) }) === 'active');
check('…and 10 min ago still is', st({ status: 'SESSION_STARTED', statusSource: 'endpoint_agent', lastSignalAt: min(10) }) === 'active');
check('…but 11 min ago is "Device connection confirmed"', st({ status: 'SESSION_STARTED', statusSource: 'endpoint_agent', lastSignalAt: min(11) }) === 'connection_confirmed');
check('no signal at all is never active', st({ status: 'SESSION_STARTED', statusSource: 'endpoint_agent', lastSignalAt: null }) === 'connection_confirmed');
check('a technician\'s "I\'m connected" is never active, even with a fresh signal', st({ status: 'SESSION_STARTED', statusSource: 'technician', lastSignalAt: min(0) }) === 'connection_confirmed');
check('…and says it was the technician', /you reported/i.test(R.stageOf({ status: 'SESSION_STARTED', statusSource: 'technician' }, now).detail));
check('an unparseable signal time is not active', st({ status: 'SESSION_STARTED', statusSource: 'endpoint_agent', lastSignalAt: 'nonsense' }) === 'connection_confirmed');
// Ends.
check('an inferred end says so', /inferred/.test(R.stageOf({ status: 'SESSION_COMPLETED', endInferred: true }, now).detail));
check('a technician-finished end says so', /technician/.test(R.stageOf({ status: 'SESSION_COMPLETED', endReason: 'technician_completed_unconfirmed' }, now).detail));
check('canceled is "Session ended", not failed', st({ status: 'CANCELED' }) === 'ended');
check('failed is "Session failed"', st({ status: 'FAILED' }) === 'failed');
check('STATUS_UNKNOWN is "Connection state unknown"', st({ status: 'STATUS_UNKNOWN' }) === 'unknown');
check('a status nobody knows is "Connection state unknown", never success', st({ status: 'WHATEVER' }) === 'unknown' && st({ status: '' }) === 'unknown');
check('lower-case statuses are read the same', st({ status: 'client_opened' }) === 'client_opened');

// The API's labels are the same words.
const stateTs = readFileSync(join(ROOT, 'apps', 'api', 'src', 'sessions', 'session-state.ts'), 'utf8');
const block = (stateTs.match(/export const STATUS_LABEL[^=]*= \{([\s\S]*?)\};/) ?? ['', ''])[1];
const apiLabel = Object.fromEntries([...block.matchAll(/([A-Z_]+): '([^']+)'/g)].map((m) => [m[1], m[2]]));
for (const s of statuses) check(`the API calls ${s} "${R.stageOf({ status: s }, now).label}" too`, apiLabel[s] === R.stageOf({ status: s }, now).label, apiLabel[s]);

// Managed Secure Access timeline steps.
const tl = readFileSync(join(ROOT, 'apps', 'api', 'src', 'msa', 'session-timeline.ts'), 'utf8');
const steps = [...((tl.match(/export const TIMELINE_STEPS = \[([^\]]*)\]/) ?? ['', ''])[1]).matchAll(/'([^']+)'/g)].map((m) => m[1]);
check('the MSA timeline has ten steps', steps.length === 10, steps.join(','));
for (const s of steps) check(`MSA step ${s} maps to a stage`, typeof R.MSA_STEP_STAGE[s] === 'string');
check('MSA Launched (the password handed over) is authorization, never a connection', R.MSA_STEP_STAGE.launched === 'authorized');
check('MSA Connected (the agent saw it) is the only active step', Object.entries(R.MSA_STEP_STAGE).filter(([, v]) => v === 'active').map(([k]) => k).join() === 'connected');
check('a cancelled grant is no longer a failure in the timeline', /case 'cancelled':[\s\S]{0,200}current = 'revoked';/.test(tl));
check('an unknown MSA step is unknown', R.msaStageOf('nope').stage === 'unknown');

// No page prints a raw status, and the badge uses no amber, yellow, orange or emerald.
const walk = (d, out = []) => { for (const n of readdirSync(d)) { const p = join(d, n); if (n === 'node_modules' || n.startsWith('.')) continue; if (statSync(p).isDirectory()) walk(p, out); else if (/\.tsx?$/.test(n)) out.push(p); } return out; };
const raw = walk(join(WEB, 'app')).concat(walk(join(WEB, 'components'))).filter((f) => /s\.status\.replace\(\/_\/g/.test(readFileSync(f, 'utf8')));
check('no page prints a session status as its raw enum', raw.length === 0, raw.join(', '));
const badge = readFileSync(join(WEB, 'components', 'sessions', 'session-status-badge.tsx'), 'utf8');
check('the badge uses no amber, yellow, orange or emerald, and no hex colour', !/\b(amber|yellow|orange|emerald)-|#[0-9a-fA-F]{3,6}\b/.test(badge));
check('Quick Connect no longer says "Session open"', !/Session open with/.test(readFileSync(join(WEB, 'app', '(app)', 'quick-connect', 'page.tsx'), 'utf8')));
check('the dashboard offers no updatedAt as a signal', !/lastSignalAt: iso\(s\.lastSignalAt \?\? s\.updatedAt\)/.test(readFileSync(join(ROOT, 'apps', 'api', 'src', 'dashboard', 'overview.service.ts'), 'utf8')));

if (failures.length) { console.error(failures.map((f) => `✗ ${f}`).join('\n')); }
console.log(`unit-remote-states: ${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
