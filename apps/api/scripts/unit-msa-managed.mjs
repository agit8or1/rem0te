#!/usr/bin/env node
// Managed Secure Access build step 4 (0.72), run against dist:
//
//   node apps/api/scripts/unit-msa-managed.mjs
//
// The closed vocabulary the portal and the signed agent share
// (src/msa/managed.ts against tools/windows-installer/internal/msa/enforce),
// the pure decisions (ceiling, rotation hold, legacy refusal, the report
// body) and the grant-key target names (portal, agent, deploy/release).

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..', '..');
const require = createRequire(import.meta.url);
const m = require(join(here, '..', 'dist', 'msa', 'managed.js'));
const pf = require(join(here, '..', 'dist', 'msa', 'preflight.js'));
const gk = require(join(here, '..', 'dist', 'msa', 'grant-key-commands.js'));
const G = require(join(here, '..', 'dist', 'msa', 'grant.js'));

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => { if (ok) passed++; else failures.push(`${name}${detail ? ` — ${detail}` : ''}`); };
const J = JSON.stringify;
const go = (f) => readFileSync(join(ROOT, 'tools', 'windows-installer', f), 'utf8');

// ── The same vocabulary on both sides ───────────────────────────────────────
{
  const enf = go('internal/msa/enforce/enforce.go');
  const outs = /var Outcomes = \[\]string\{([^}]*)\}/.exec(enf)?.[1] ?? '';
  const consts = Object.fromEntries([...enf.matchAll(/^\s+([A-Z][A-Za-z]+)\s+= "([a-z_]+)"$/gm)].map((x) => [x[1], x[2]]));
  const goOutcomes = [...outs.matchAll(/([A-Z][A-Za-z]+)/g)].map((x) => consts[x[1]]);
  check('the agent\'s outcome codes are the portal\'s, in order', J(goOutcomes) === J([...m.AGENT_OUTCOMES]), J(goOutcomes));
  const poller = go('internal/msa/enforce/poller.go');
  const goEvents = [...new Set([...poller.matchAll(/Event: "([a-z_]+)"/g)].map((x) => x[1]))].sort();
  check('every event the agent reports is one the portal accepts, and every one is reported', J(goEvents) === J([...m.REPORT_EVENTS].sort()), J(goEvents));
  // 0.78.1 (F1): the preflight's eleven, then the six permissions no grant turns on.
  const LOCKED = ['enable-terminal', 'enable-camera', 'enable-remote-printer', 'enable-block-input', 'enable-privacy-mode', 'enable-record-session'];
  check('the managed keys are the preflight\'s eleven, then the six locked permissions',
    J([...m.MANAGED_KEYS]) === J([...pf.PREFLIGHT_KEYS, ...LOCKED]) && pf.PREFLIGHT_KEYS.length === 11 && J([...m.LOCKED_KEYS]) === J(LOCKED));
  const goLocked = [...(/var Locked = \[\]string\{([^}]*)\}/.exec(go('internal/msa/enforce/args.go'))?.[1] ?? '').matchAll(/"([a-z-]+)"/g)].map((x) => x[1]);
  check('the agent locks the same six, in the same order (enforce.Locked)', J(goLocked) === J(LOCKED), J(goLocked));
  check('a failed readback may name the password, nothing else', J([...m.REPORT_KEYS]) === J([...pf.PREFLIGHT_KEYS, ...LOCKED, 'password']));
  check('0098 takes exactly the report keys', (() => {
    const sql = readFileSync(join(ROOT, 'apps', 'api', 'prisma', 'migrations', '0098_msa_locked_keys', 'migration.sql'), 'utf8');
    const lists = [...sql.matchAll(/ARRAY\[([^\]]*)\]::TEXT\[\]/g)].map((x) => [...x[1].matchAll(/'([a-z-]+)'/g)].map((y) => y[1]));
    return lists.length === 2 && lists.every((l) => J(l) === J([...m.REPORT_KEYS])) && (sql.match(/cardinality\("failedKeys"\) <= 18/g) ?? []).length === 2;
  })());
  check('the access modes the agent writes are view and custom, never full',
    J([...m.MANAGED_ACCESS_MODES]) === J(['view', 'custom'])
      && /"access-mode":\s+\{"view": true, "custom": true\},/.test(go('internal/msa/enforce/args.go')));
  // 0.73: control with clipboard, file transfer and audio; never a tunnel or a remote restart.
  check('the agent\'s compiled ceiling is control with clipboard, files and audio, never tunnel or restart',
    /var Ceiling = grant\.Ceiling\{Mode: "control", Permissions: grant\.Permissions\{Clipboard: true, Files: true, Audio: true\}\}/.test(enf) && !/Tunnel: true|Restart: true/.test(enf));
  check('the portal\'s ceiling is the same', J(m.MANAGED_CEILING) === J({ mode: 'control', permissions: { clipboard: true, files: true, audio: true, tunnel: false, restart: false } }));
  check('every verifier reason fits the outcome charset', G.REASONS.every((x) => /^[a-z_]{1,40}$/.test(x)));
}

// ── withinCeiling ───────────────────────────────────────────────────────────
{
  const none = { clipboard: false, files: false, audio: false, tunnel: false, restart: false };
  check('view with nothing beyond is within', m.withinCeiling('view', none));
  check('control with nothing beyond is within (0.73)', m.withinCeiling('control', none));
  check('control with clipboard, files and audio is within', m.withinCeiling('control', { ...none, clipboard: true, files: true, audio: true }));
  for (const k of ['tunnel', 'restart']) {
    check(`control + ${k} is above`, !m.withinCeiling('control', { ...none, [k]: true }));
    check(`view + ${k} is above`, !m.withinCeiling('view', { ...none, [k]: true }));
  }
}

// ── rotationHeld / legacyRefused ────────────────────────────────────────────
{
  check('Legacy: a rotation is never held', m.rotationHeld(null, true) === false);
  check('pending, nothing in flight: the rotation goes out (Legacy works between test sessions)', m.rotationHeld({ state: 'pending' }, false) === false);
  check('pending with a grant in flight: held', m.rotationHeld({ state: 'pending' }, true) === true);
  for (const s of ['verified', 'enforcement_failure', 'rollback_pending']) check(`${s}: held`, m.rotationHeld({ state: s }, false) === true);
  check('legacy Connect refused only once verified', m.legacyRefused({ verifiedAt: new Date() }) && !m.legacyRefused({ verifiedAt: null }) && !m.legacyRefused(null));
  check('the refusal says how to connect meanwhile', /roll it back to Legacy/.test(m.LEGACY_REFUSED_MESSAGE));
}

// ── The report body ─────────────────────────────────────────────────────────
{
  const base = { rustdeskId: '555666777', agentSecret: 'a'.repeat(48) };
  const gid = '00112233445566778899aabbccddeeff';
  const ok = (b) => m.ReportBody.safeParse(b).success;
  check('applied with a grant id', ok({ ...base, event: 'applied', grantId: gid }));
  check('failed with an outcome and keys', ok({ ...base, event: 'failed', grantId: gid, outcome: 'readback_mismatch', keys: ['access-mode', 'password'] }));
  check('secured with no grant id', ok({ ...base, event: 'secured' }));
  check('restore_failed with keys', ok({ ...base, event: 'restore_failed', keys: ['approve-mode'] }));
  const bad = [
    ['applied without a grant id', { ...base, event: 'applied' }],
    ['secured with a grant id', { ...base, event: 'secured', grantId: gid }],
    ['an unknown event', { ...base, event: 'password_set' }],
    ['a password field', { ...base, event: 'applied', grantId: gid, password: 'ZZZZyyyyXXXXwwww00001111' }],
    ['an unknown key', { ...base, event: 'drift', keys: ['custom-rendezvous-server'] }],
    ['free text as the outcome', { ...base, event: 'failed', grantId: gid, outcome: 'RustDesk said: no' }],
    ['a bad grant id', { ...base, event: 'applied', grantId: 'x' }],
    ['a short secret', { ...base, agentSecret: 'short', event: 'secured' }],
    ['a non-numeric RustDesk ID', { ...base, rustdeskId: 'abc', event: 'secured' }],
    ['a value for a key', { ...base, event: 'drift', keys: ['access-mode'], values: { 'access-mode': 'full' } }],
  ];
  for (const [n, b] of bad) check(`refused: ${n}`, !ok(b));
}

// ── The grant-key target: one name, one schema, everywhere ──────────────────
{
  const keysGo = go('internal/msa/grant/keys.go');
  check('the agent reads the same target', keysGo.includes(`KeysTarget = "${gk.MSA_GRANT_KEYS_TARGET}"`));
  check('and the same schema', keysGo.includes(`KeysSchema = "${gk.MSA_GRANT_KEYS_SCHEMA}"`));
  const publish = readFileSync(join(ROOT, 'deploy', 'release', 'rem0te-signed-publish'), 'utf8');
  const addKey = readFileSync(join(ROOT, 'deploy', 'release', 'rem0te-signed-grant-key'), 'utf8');
  check('rem0te-signed-publish signs it in under that name', publish.includes(`-add "${gk.MSA_GRANT_KEYS_TARGET}=$msa_build"`));
  check('rem0te-signed-grant-key writes that schema', addKey.includes(`const SCHEMA = "${gk.MSA_GRANT_KEYS_SCHEMA}"`));
  check('the console\'s commands name the installed commands', gk.MSA_GRANT_KEY_ADD_COMMAND === 'sudo rem0te-signed-grant-key add' && gk.MSA_GRANT_KEY_PUBLISH_COMMAND === 'sudo rem0te-signed-publish --republish');
  const setup = readFileSync(join(ROOT, 'deploy', 'release', 'rem0te-signed-setup.sh'), 'utf8');
  check('setup installs rem0te-signed-grant-key', /for c in [^;]*rem0te-signed-grant-key; do/.test(setup));
}

console.log(`unit-msa-managed: ${passed} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1); }
