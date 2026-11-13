#!/usr/bin/env node
// Tests for automatic migration to the signed agent (0.37), run against dist:
//
//   cd apps/api && npx nest build && node scripts/unit-auto-migration.mjs
//
// The pure rules (agent-auto-migration/rollout.ts): the settings and their
// bounds, what widens (and so needs fresh authentication), the off switch,
// which update results are failures, the gate (mode, process, repository,
// release, Signed only), the rollout's state machine — canary confirmed only
// on the exact published build, halted on a failed result, a cancel, a
// missing computer or a timeout, the soak gate and the check-in after it —
// canary ordering, the pace budget, and the hold mapping from the 0.34
// precondition codes. Plus the 0.34 precondition messages that now point at
// the Full agent page and the setup command.

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const R = require(join(here, '..', 'dist', 'agent-auto-migration', 'rollout.js'));
const M = require(join(here, '..', 'dist', 'update-trust', 'agent-migration.js'));

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => { if (ok) passed++; else failures.push(`${name}${detail ? ` — ${detail}` : ''}`); };

const NOW = new Date('2026-11-13T12:00:00Z');
const MIN = 60_000, H = 60 * MIN;
const at = (ms) => new Date(NOW.getTime() + ms);
const SHA = 'a'.repeat(64), OTHER = 'b'.repeat(64);

// ── Settings ────────────────────────────────────────────────────────────────
{
  const d = R.settingsFrom(null, {});
  check('default: canary_then_all, 60-minute soak, process on', d.mode === 'canary_then_all' && d.soakMinutes === 60 && d.processOn === true, JSON.stringify(d));
  check('AUTO_MIGRATION_SWEEP=off: process off', R.settingsFrom(null, { AUTO_MIGRATION_SWEEP: 'off' }).processOn === false);
  check('only the exact value "off" turns the process off', R.settingsFrom(null, { AUTO_MIGRATION_SWEEP: 'OFF' }).processOn === true && R.settingsFrom(null, { AUTO_MIGRATION_SWEEP: '0' }).processOn === true);
  check('a stored off is read', R.settingsFrom({ agentAutoMigrationMode: 'off', agentAutoMigrationSoakMinutes: 90 }, {}).mode === 'off');
  check('an unknown stored mode falls back to the default', R.settingsFrom({ agentAutoMigrationMode: 'all_at_once' }, {}).mode === 'canary_then_all');
  for (const bad of [14, 1441, 0, -5, 60.5, null]) check(`a stored soak of ${bad} falls back to 60`, R.settingsFrom({ agentAutoMigrationSoakMinutes: bad }, {}).soakMinutes === 60);
  for (const ok of [15, 1440, 240]) check(`a stored soak of ${ok} is kept`, R.settingsFrom({ agentAutoMigrationSoakMinutes: ok }, {}).soakMinutes === ok);
  const bad = (b) => { try { R.parseSettingsUpdate(b); return false; } catch { return true; } };
  check('a change must name something', bad({}) && bad(null));
  check('soak bounds 15–1440 are enforced on input', bad({ soakMinutes: 14 }) && bad({ soakMinutes: 1441 }) && bad({ soakMinutes: 30.5 }) && !bad({ soakMinutes: 15 }) && !bad({ soakMinutes: 1440 }));
  check('unknown keys and modes are refused', bad({ mode: 'all' }) && bad({ mode: 'off', canary: 'x' }) && bad({ perHour: 5 }));
}

// ── What widens ─────────────────────────────────────────────────────────────
{
  const on = { mode: 'canary_then_all', soakMinutes: 60 }, off = { mode: 'off', soakMinutes: 60 };
  check('turning it on widens', R.isWidening(off, on));
  check('turning it off never widens', !R.isWidening(on, off) && !R.isWidening({ ...on, soakMinutes: 600 }, { mode: 'off', soakMinutes: 15 }));
  check('shortening the soak while on widens', R.isWidening(on, { ...on, soakMinutes: 30 }));
  check('lengthening the soak does not', !R.isWidening(on, { ...on, soakMinutes: 120 }));
  check('no change does not', !R.isWidening(on, on));
  check('changing the soak while off does not', !R.isWidening(off, { mode: 'off', soakMinutes: 15 }));
}

// ── Update results ──────────────────────────────────────────────────────────
{
  const F = R.updateResultFailed;
  check('installer exit 0 is not a failure', !F('installer exit 0') && !F('installer exit 0; tray: placed'));
  check('installer exit 1 / 12 / 10 are failures', F('installer exit 1') && F('installer exit 12') && F('installer exit 10'));
  check('installer failed / metadata-refused are failures', F('installer failed: access denied') && F('metadata-refused: timestamp expired'));
  check('a signed pause is not a failure', !F('paused: incident 42'));
  check('nothing reported is not a failure', !F(null) && !F('') && !F(undefined));
}

// ── The gate ────────────────────────────────────────────────────────────────
{
  const s = { mode: 'canary_then_all', soakMinutes: 60, processOn: true };
  const g = (o) => R.gate({ settings: s, repoConfigured: true, publishedSha256: SHA, trustMode: 'legacy_allowed', ...o });
  check('everything in place: runs', g({}) === null);
  check('mode off', g({ settings: { ...s, mode: 'off' } }) === 'mode_off');
  check('process off', g({ settings: { ...s, processOn: false } }) === 'process_off');
  check('no repository', g({ repoConfigured: false }) === 'no_repository');
  check('no signed agent published', g({ publishedSha256: null }) === 'no_release' && g({ publishedSha256: 'xyz' }) === 'no_release');
  check('Signed only: nothing, whatever portal migration says', g({ trustMode: 'signed_only' }) === 'signed_only');
  check('every gate reason has a sentence', Object.keys(R.GATE_TEXT).length === 5 && Object.values(R.GATE_TEXT).every((t) => t.length > 20));
}

// ── The state machine ───────────────────────────────────────────────────────
const row = (o = {}) => ({ state: 'canary', targetSha256: SHA, canaryEndpointId: 'ep1', canaryRequestedAt: at(-10 * MIN), canaryConfirmedAt: null, ...o });
const facts = (o = {}) => ({ exists: true, updateChannel: 'legacy', agentSha256: null, lastSeenAt: at(-1 * MIN), agentUpdateCheckedAt: null, agentUpdateResult: null, requestCancelledByPerson: false, ...o });
const signed = (o = {}) => facts({ updateChannel: 'signed', agentSha256: SHA, ...o });
const step = (r, f, now = NOW, soak = 60) => R.nextStep(r, f, now, soak);
{
  check('choosing_canary: choose one', step(row({ state: 'choosing_canary', canaryEndpointId: null }), null).do === 'choose_canary');
  check('halted: nothing, ever', step(row({ state: 'halted' }), signed()).do === 'none');
  check('rolling: migrate the rest', step(row({ state: 'rolling' }), signed()).do === 'migrate_rest');

  // canary
  const w = step(row(), facts());
  check('canary, still standard, inside 2 h: wait until requestedAt + 2 h', w.do === 'wait' && w.until.getTime() === at(-10 * MIN + 2 * H).getTime(), JSON.stringify(w));
  check('canary on the exact published build: confirm', step(row(), signed()).do === 'confirm');
  check('canary signed but on another build: not confirmed, waits', step(row(), signed({ agentSha256: OTHER })).do === 'wait');
  check('canary signed with no digest reported: waits', step(row(), signed({ agentSha256: null })).do === 'wait');
  const t1 = step(row({ canaryRequestedAt: at(-2 * H - 1) }), facts());
  check('canary not confirmed after 2 h: halt canary_not_confirmed', t1.do === 'halt' && t1.code === 'canary_not_confirmed' && /2 hours/.test(t1.reason), JSON.stringify(t1));
  const t2 = step(row({ canaryRequestedAt: at(-3 * H) }), signed({ agentSha256: OTHER }));
  check('canary signed on another build after 2 h: halt, saying so', t2.do === 'halt' && t2.code === 'canary_not_confirmed' && /did not report the published build/.test(t2.reason));
  check('exactly 2 h: still waiting (strictly more halts)', step(row({ canaryRequestedAt: at(-2 * H) }), facts()).do === 'wait');
  const f1 = step(row(), facts({ agentUpdateCheckedAt: at(-1 * MIN), agentUpdateResult: 'installer exit 12' }));
  check('canary reports a failed result after it was asked: halt canary_failed with the result', f1.do === 'halt' && f1.code === 'canary_failed' && /installer exit 12/.test(f1.reason));
  check('a failed result from before it was asked does not count', step(row(), facts({ agentUpdateCheckedAt: at(-60 * MIN), agentUpdateResult: 'installer exit 12' })).do === 'wait');
  check('a signed pause result does not halt', step(row(), facts({ agentUpdateCheckedAt: at(-1 * MIN), agentUpdateResult: 'paused: incident' })).do === 'wait');
  const c1 = step(row(), facts({ requestCancelledByPerson: true }));
  check('a person cancelled the canary\'s request: halt canary_cancelled', c1.do === 'halt' && c1.code === 'canary_cancelled');
  check('canary removed: halt canary_gone', step(row(), null).code === 'canary_gone' && step(row(), facts({ exists: false })).code === 'canary_gone');
  check('a confirmed build wins over an old failed result', step(row(), signed({ agentUpdateCheckedAt: at(-1 * MIN), agentUpdateResult: 'installer exit 1' })).do === 'confirm');

  // soaking
  const conf = at(-30 * MIN);
  const soak = (o = {}) => row({ state: 'soaking', canaryConfirmedAt: conf, ...o });
  const s1 = step(soak(), signed());
  check('soaking, inside the soak: wait until confirmedAt + soak', s1.do === 'wait' && s1.until.getTime() === conf.getTime() + 60 * MIN, JSON.stringify(s1));
  check('a longer soak waits longer', step(soak(), signed(), NOW, 240).until.getTime() === conf.getTime() + 240 * MIN);
  check('soak over and the canary checked in after it: start rolling', step(soak({ canaryConfirmedAt: at(-61 * MIN) }), signed({ lastSeenAt: at(-30 * 1000) })).do === 'start_rolling');
  const s2 = step(soak({ canaryConfirmedAt: at(-61 * MIN) }), signed({ lastSeenAt: at(-2 * MIN) }));
  check('soak over but the last check-in was before it ended: wait for one more', s2.do === 'wait' && /check in/.test(s2.text));
  const s3 = step(soak({ canaryConfirmedAt: at(-60 * MIN - 2 * H - 1) }), signed({ lastSeenAt: at(-2 * H - 30 * MIN) }));
  check('no check-in within 2 h of the soak ending: halt canary_silent', s3.do === 'halt' && s3.code === 'canary_silent');
  const s4 = step(soak(), facts());
  check('canary back on the standard agent during the soak: halt canary_left_build', s4.do === 'halt' && s4.code === 'canary_left_build');
  check('canary on another build during the soak: halt canary_left_build', step(soak(), signed({ agentSha256: OTHER })).code === 'canary_left_build');
  const s5 = step(soak(), signed({ agentUpdateCheckedAt: at(-5 * MIN), agentUpdateResult: 'metadata-refused: bad sig' }));
  check('a failed result during the soak: halt canary_failed', s5.do === 'halt' && s5.code === 'canary_failed');
  check('a failed result from before confirmation does not halt the soak', step(soak(), signed({ agentUpdateCheckedAt: at(-40 * MIN), agentUpdateResult: 'installer exit 1' })).do === 'wait');
  check('canary gone during the soak: halt', step(soak(), null).code === 'canary_gone');
  check('a soak never moves on before its end, however recently heard from', step(soak(), signed({ lastSeenAt: NOW })).do === 'wait');

  // Every path out of canary/soaking is wait, confirm, start_rolling or halt.
  const outs = new Set();
  for (const st of ['canary', 'soaking']) for (const f of [null, facts(), signed(), signed({ agentSha256: OTHER }), facts({ requestCancelledByPerson: true })]) {
    for (const d of [-5 * MIN, -90 * MIN, -3 * H, -10 * H]) outs.add(step(row({ state: st, canaryRequestedAt: at(d), canaryConfirmedAt: st === 'soaking' ? at(d) : null }), f).do);
  }
  check('canary and soaking only ever wait, confirm, start rolling or halt', [...outs].every((o) => ['wait', 'confirm', 'start_rolling', 'halt'].includes(o)), [...outs].join(','));
}

// ── Picking ─────────────────────────────────────────────────────────────────
{
  const STALE = 30 * MIN;
  const c = (id, ago, online = true) => ({ id, isOnline: online, lastSeenAt: ago === null ? null : at(-ago) });
  const order = R.canaryOrder([c('a', 20 * MIN), c('b', 1 * MIN), c('c', 40 * MIN), c('d', 2 * MIN, false), c('e', null), c('f', 3 * MIN)], ['f'], NOW, STALE);
  check('canary: reporting only, most recently heard from first, never one already tried', order.map((x) => x.id).join() === 'b,a', order.map((x) => x.id).join());
  check('ties broken by id (stable)', R.canaryOrder([c('z', MIN), c('y', MIN)], [], NOW, STALE).map((x) => x.id).join() === 'y,z');
  check('reporting: online and inside the window', R.reporting(c('a', 29 * MIN), NOW, STALE) && !R.reporting(c('a', 31 * MIN), NOW, STALE) && !R.reporting(c('a', MIN, false), NOW, STALE));
  check('budget: the hour\'s pace less what it used', R.budget(10, 3) === 7 && R.budget(10, 10) === 0 && R.budget(10, 14) === 0);
  check('budget: never more than one batch per tick', R.budget(2000, 0) === R.BATCH_PER_TICK && R.BATCH_PER_TICK === 50);
}

// ── Holds ───────────────────────────────────────────────────────────────────
{
  check('a containment pause is a hold', R.holdOf('CONTAINED') === 'contained');
  check('a staged rollout is a hold', R.holdOf('IN_ROLLOUT') === 'rollout');
  check('no device secret / archived are holds', R.holdOf('NO_DEVICE_SECRET') === 'no_device_secret' && R.holdOf('ARCHIVED') === 'archived');
  check('eligible, signed, Linux, macOS: not holds', [null, 'ALREADY_SIGNED', 'LINUX_AGENT_READ_ONLY', 'MACOS_AGENT_READ_ONLY', 'NOT_WINDOWS'].every((x) => R.holdOf(x) === null));
  check('platform-wide refusals are the steps\', not a computer\'s', ['NO_SIGNED_RELEASE', 'NO_PORTAL_ADDRESS', 'SIGNED_ONLY'].every((x) => R.holdOf(x) === null));
  check('anything else is "other", never dropped', R.holdOf('SOMETHING_NEW') === 'other');
  check('every hold has a label', Object.keys(R.HOLD_LABEL).length === 9);
}

// ── The precondition messages point at the page ─────────────────────────────
{
  const base = { platform: 'Windows', updateChannel: 'legacy', status: 'ACTIVE', hasSecret: true, repoConfigured: true, signedAgentPublished: true, portalHost: 'p.example.com', mode: 'legacy_allowed', legacyPortalMigration: false, updatesPause: null, inRollout: false };
  const a = M.migrationBlock({ ...base, repoConfigured: false });
  check('no repository: the setup command and the Full agent page', a.code === 'NO_SIGNED_RELEASE' && a.fix.includes('sudo ./deploy/release/rem0te-signed-setup.sh') && a.link.href === '/endpoints/full-agent' && !/offline signing keys/.test(a.reason));
  const b = M.migrationBlock({ ...base, signedAgentPublished: false });
  check('no signed agent: the publish command and the Full agent page', b.code === 'NO_SIGNED_RELEASE' && b.fix.includes('sudo rem0te-signed-publish') && b.link.href === '/endpoints/full-agent');
  check('the command strings are the interface\'s, verbatim', M.SETUP_COMMAND === 'sudo ./deploy/release/rem0te-signed-setup.sh' && M.PUBLISH_COMMAND === 'sudo rem0te-signed-publish' && M.STATUS_COMMAND === 'sudo rem0te-signed-status' && M.TIMESTAMP_TIMER === 'rem0te-timestamp-refresh.timer');
  const st = M.migrationState({ requestedAt: at(-H), dispatchedAt: null, lastDispatchedAt: null, fetchedAt: null, holdReason: null, holdAt: null, completedAt: null, cancelledAt: at(-1), automatic: true, cancelledById: null });
  check('an automatic request stopped by its halted rollout says so', st.state === 'cancelled' && /automatic migration/.test(st.text));
  const st2 = M.migrationState({ requestedAt: at(-H), dispatchedAt: null, lastDispatchedAt: null, fetchedAt: null, holdReason: null, holdAt: null, completedAt: null, cancelledAt: at(-1), automatic: true, cancelledById: 'u1' });
  check('one a person cancelled is just cancelled', st2.text === 'Cancelled.');
}

console.log(`\nunit-auto-migration: ${passed} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1); }
