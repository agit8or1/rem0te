#!/usr/bin/env node
// Tests for what the console shows as a computer's agent version (0.70.1),
// run against dist:
//
//   cd apps/api && npx nest build && node scripts/unit-agent-version-view.mjs
//
// The signed agent's binary is reproducible and carries no version, so it was
// byte-identical from 0.63.0 through 0.68.3 and production's four computers,
// all on the published build, showed 0.64.0, 0.67.0, 0.67.0 and 0.68.0 — the
// labels they last recorded. common/agent-version-view.ts shows the
// published release for a signed agent on the published build.
//
// Covered: the pure rule (same hash, different hash, no published target, no
// reported hash, standard / Linux / macOS, the sticky signed rule, a bad
// custom.version); UpdateTrustService.servedAgent() reading custom.version
// from a scratch repository; and that the display rule agrees with, and did
// not change, automatic update's own comparison (schedule.ts isBehind,
// decide), which this release does not touch.

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const V = require(join(here, '..', 'dist', 'common', 'agent-version-view.js'));
const S = require(join(here, '..', 'dist', 'agent-auto-update', 'schedule.js'));
const { UpdateTrustService } = require(join(here, '..', 'dist', 'update-trust', 'update-trust.service.js'));

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => { if (ok) passed++; else failures.push(`${name}${detail ? ` — ${detail}` : ''}`); };
const j = (x) => JSON.stringify(x);

const SHA = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const served = { sha256: SHA, version: '0.69.0' };
const NOW = new Date('2026-11-19T12:00:00Z');

// ── The rule ─────────────────────────────────────────────────────────────────
{
  const v = V.agentVersionView({ updateChannel: 'signed', agentVersion: '0.67.0', agentSha256: SHA }, served, NOW);
  check('same hash: current', v.current === true && v.reason === 'same_build', j(v));
  check('same hash: shows the published release', v.label === '0.69.0', j(v));
  check('same hash: the recorded label is kept', v.recorded === '0.67.0', j(v));
  check('same hash: the detail names both and says it is the same agent', /0\.69\.0/.test(v.detail) && /0\.67\.0/.test(v.detail) && /same agent/.test(v.detail), v.detail);
}
{
  const v = V.agentVersionView({ updateChannel: 'signed', agentVersion: '0.69.0', agentSha256: SHA }, served, NOW);
  check('same hash, same label: current, no "recorded" sentence', v.current === true && v.label === '0.69.0' && !/recorded/.test(v.detail), j(v));
}
{
  const v = V.agentVersionView({ updateChannel: 'signed', agentVersion: '0.67.0', agentSha256: SHA.toUpperCase() }, served, NOW);
  check('same hash in upper case: still current', v.current === true, j(v));
}
{
  const v = V.agentVersionView({ updateChannel: 'signed', agentVersion: '0.62.0', agentSha256: OTHER }, served, NOW);
  check('different hash: not current, shows what it recorded', v.current === false && v.reason === 'different_build' && v.label === '0.62.0', j(v));
  check('different hash: says an update is due', /update is due/.test(v.detail), v.detail);
}
{
  const v = V.agentVersionView({ updateChannel: 'signed', agentVersion: '0.67.0', agentSha256: SHA }, null, NOW);
  check('no published target: unchanged, current unknown', v.current === null && v.label === '0.67.0' && v.reason === 'no_published_build' && v.detail === null, j(v));
}
{
  const v = V.agentVersionView({ updateChannel: 'signed', agentVersion: '0.67.0', agentSha256: SHA }, { sha256: 'not-a-hash', version: '0.69.0' }, NOW);
  check('a malformed published hash counts as none', v.current === null && v.reason === 'no_published_build', j(v));
}
{
  const v = V.agentVersionView({ updateChannel: 'signed', agentVersion: '0.67.0', agentSha256: null }, served, NOW);
  check('null sha: unchanged, current unknown', v.current === null && v.label === '0.67.0' && v.reason === 'no_build_reported', j(v));
}
{
  const v = V.agentVersionView({ updateChannel: 'legacy', agentVersion: '0.60.0', agentSha256: SHA }, served, NOW);
  check('standard channel: the recorded label, current unknown, even with a matching hash', v.current === null && v.label === '0.60.0' && v.reason === 'not_signed', j(v));
}
for (const ch of [null, 'standard', 'legacy']) {
  const v = V.agentVersionView({ updateChannel: ch, agentVersion: '0.33.0', agentSha256: null }, served, NOW);
  check(`channel ${ch} (Linux / macOS / standard): unchanged`, v.current === null && v.label === '0.33.0' && v.reason === 'not_signed', j(v));
}
{
  const v = V.agentVersionView({ updateChannel: null, agentVersion: null, agentSha256: null }, served, NOW);
  check('no agent report: label null', v.label === null && v.recorded === null && v.current === null, j(v));
}
{
  // The sticky rule (§64): a signed heartbeat a day ago keeps it signed while a check-in reads legacy.
  const v = V.agentVersionView({ updateChannel: 'legacy', agentVersion: '0.67.0', agentSha256: SHA, signedSeenAt: new Date(NOW.getTime() - 86_400_000) }, served, NOW);
  check('sticky signed: a signed computer reading legacy is still compared', v.current === true && v.label === '0.69.0', j(v));
  const gone = V.agentVersionView({ updateChannel: 'legacy', agentVersion: '0.67.0', agentSha256: SHA, signedSeenAt: new Date(NOW.getTime() - 8 * 86_400_000) }, served, NOW);
  check('sticky signed: gone after 7 days', gone.reason === 'not_signed', j(gone));
}
{
  const v = V.agentVersionView({ updateChannel: 'signed', agentVersion: '0.67.0', agentSha256: SHA }, { sha256: SHA, version: null }, NOW);
  check('same hash, no published label: current, shows the recorded label', v.current === true && v.label === '0.67.0', j(v));
  const bad = V.agentVersionView({ updateChannel: 'signed', agentVersion: '0.67.0', agentSha256: SHA }, { sha256: SHA, version: '<b>1</b>' }, NOW);
  check('same hash, a published label that is not a version: never shown', bad.label === '0.67.0' && !/<b>/.test(bad.detail), j(bad));
}
check('servedVersionOf: a dotted version', V.servedVersionOf({ version: '0.69.0', commit: 'abc' }) === '0.69.0');
check('servedVersionOf: anything else is null', [undefined, null, {}, { version: 69 }, { version: '0.69.0-rc1' }, { version: '1.2.3.4.5' }, { version: '' }].every((c) => V.servedVersionOf(c) === null));

// ── servedAgent() from a repository ──────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'rem0te-avv-'));
  mkdirSync(join(dir, 'metadata'), { recursive: true });
  mkdirSync(join(dir, 'targets', 'windows'), { recursive: true });
  const body = Buffer.from('the agent');
  const sha = createHash('sha256').update(body).digest('hex');
  writeFileSync(join(dir, 'targets', 'windows', `${sha}.rem0te-agent.exe`), body);
  const w = (f, o) => writeFileSync(join(dir, 'metadata', f), JSON.stringify(o));
  w('root.json', { signed: { version: 1, expires: '2030-01-01T00:00:00Z', roles: { root: { keyids: ['k'], threshold: 1 } } } });
  w('timestamp.json', { signed: { version: 1, expires: '2030-01-01T00:00:00Z', meta: { 'snapshot.json': { version: 3 } } } });
  w('3.snapshot.json', { signed: { version: 3, expires: '2030-01-01T00:00:00Z', meta: { 'targets.json': { version: 7 } } } });
  const targets = (custom) => w('7.targets.json', { signed: { version: 7, expires: '2030-01-01T00:00:00Z', targets: { 'windows/rem0te-agent.exe': { length: body.length, hashes: { sha256: sha }, ...(custom ? { custom } : {}) } } } });
  const prev = process.env.UPDATE_REPO_DIR;
  process.env.UPDATE_REPO_DIR = dir;
  const t = new UpdateTrustService(null, null, null);
  targets({ version: '0.68.3', commit: 'f'.repeat(40) });
  check('servedAgent: the target hash and custom.version', j(t.servedAgent()) === j({ sha256: sha, version: '0.68.3' }), j(t.servedAgent()));
  const view = t.agentVersionOf({ updateChannel: 'signed', agentVersion: '0.64.0', agentSha256: sha });
  check('agentVersionOf: a 0.64.0 label on the published 0.68.3 build is shown as 0.68.3, current', view.label === '0.68.3' && view.current === true, j(view));
  targets(null);
  check('servedAgent: no custom → version null', j(t.servedAgent()) === j({ sha256: sha, version: null }), j(t.servedAgent()));
  process.env.UPDATE_REPO_DIR = '';
  check('servedAgent: no repository → null', t.servedAgent() === null);
  if (prev === undefined) delete process.env.UPDATE_REPO_DIR; else process.env.UPDATE_REPO_DIR = prev;
}

// ── Automatic update is unchanged, and agrees ────────────────────────────────
// isBehind is what decide() acts on; this release does not touch it. These
// are its 0.36 answers, and for every signed case the display rule's
// `current` is exactly its negation.
check('isBehind: signed, same hash → false', S.isBehind('signed', { agentVersion: '0.64.0', agentSha256: SHA }, SHA) === false);
check('isBehind: signed, other hash → true', S.isBehind('signed', { agentVersion: '0.69.0', agentSha256: OTHER }, SHA) === true);
check('isBehind: signed, no hash → null', S.isBehind('signed', { agentVersion: '0.69.0', agentSha256: null }, SHA) === null);
check('isBehind: no target → null', S.isBehind('signed', { agentVersion: '0.69.0', agentSha256: SHA }, null) === null);
check('isBehind: standard compares the label', S.isBehind('standard', { agentVersion: '0.68.0', agentSha256: null }, '0.69.0') === true
  && S.isBehind('standard', { agentVersion: '0.69.0', agentSha256: null }, '0.69.0') === false);
check('isBehind: standard_pre015 always behind', S.isBehind('standard_pre015', { agentVersion: '0.14.0', agentSha256: null }, '0.69.0') === true);
for (const [label, sha] of [['0.64.0', SHA], ['0.69.0', OTHER], ['0.67.0', null]]) {
  const behind = S.isBehind('signed', { agentVersion: label, agentSha256: sha }, SHA);
  const view = V.agentVersionView({ updateChannel: 'signed', agentVersion: label, agentSha256: sha }, served, NOW);
  check(`display agrees with isBehind (${label}, ${sha ? sha[0] : 'null'})`, behind === null ? view.current === null : view.current === !behind, j({ behind, view }));
}
// The display module is pure and decides nothing: it imports only the identity rule.
{
  const src = readFileSync(join(here, '..', 'src', 'common', 'agent-version-view.ts'), 'utf8');
  const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
  check('agent-version-view.ts imports only ./agent-identity', j(imports) === j(['./agent-identity']), j(imports));
  const auto = readFileSync(join(here, '..', 'src', 'agent-auto-update', 'schedule.ts'), 'utf8');
  check('schedule.ts (decide / isBehind) does not use the display rule', !/agent-version-view|agentVersionView|servedAgent/.test(auto));
  const svc = readFileSync(join(here, '..', 'src', 'agent-auto-update', 'agent-auto-update.service.ts'), 'utf8');
  const decideCalls = svc.split('decide({').slice(1).map((s) => s.slice(0, s.indexOf('});')));
  check('decide() is never handed a display view', decideCalls.length > 0 && decideCalls.every((c) => !/versionView|agentVersionOf|servedAgent/.test(c)));
}

console.log(`\nagent version view: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
