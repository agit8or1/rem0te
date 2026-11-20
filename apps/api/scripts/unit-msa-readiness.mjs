#!/usr/bin/env node
// Managed Secure Access readiness (0.69), run against dist:
//
//   node apps/api/scripts/unit-msa-readiness.mjs
//
// Pure functions only: src/msa/preflight.ts (the heartbeat block's parser)
// and src/msa/readiness.ts (the state decision). The preflight blocks are the
// shape the signed agent writes (tools/windows-installer/internal/msa), with
// the file versions RustDesk really reports ("1.4.7+65", from the Windows
// lab's evidence).

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const p = require(join(here, '..', 'dist', 'msa', 'preflight.js'));
const r = require(join(here, '..', 'dist', 'msa', 'readiness.js'));

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => { if (ok) passed++; else failures.push(`${name}${detail ? ` — ${detail}` : ''}`); };
const J = JSON.stringify;

const NOW = Date.parse('2026-11-19T12:00:00Z');
const iso = (msAgo) => new Date(NOW - msAgo).toISOString().replace(/\.\d{3}Z$/, 'Z');
const allKeys = (v = 'ok') => Object.fromEntries(p.PREFLIGHT_KEYS.map((k) => [k, v]));
const block = (over = {}) => ({
  schema: 'rem0te-rustdesk-preflight/1', checkedAt: iso(3600_000), installed: true, expectedPath: true, version: '1.4.7+65',
  build: 'flutter', service: 'running', cli: 'ok', keys: allKeys(), durationMs: 1200, ...over,
});

// ── The key list agrees with the agent's ────────────────────────────────────
{
  check('eleven keys', p.PREFLIGHT_KEYS.length === 11 && r.PREFLIGHT_KEY_COUNT === 11);
  const go = readFileSync(join(here, '..', '..', '..', 'tools', 'windows-installer', 'internal', 'msa', 'preflight.go'), 'utf8');
  const m = /var Keys = \[\]string\{([^}]*)\}/.exec(go);
  const goKeys = m ? [...m[1].matchAll(/"([a-z-]+)"/g)].map((x) => x[1]) : [];
  check('the agent\'s msa.Keys is the same list, in the same order', J(goKeys) === J([...p.PREFLIGHT_KEYS]), J(goKeys));
  const probe = readFileSync(join(here, '..', '..', '..', 'tools', 'lab', 'windows', 'rustdesk-probe.ps1'), 'utf8');
  check('every key is one the Windows lab probed', p.PREFLIGHT_KEYS.every((k) => probe.includes(`'${k}'`)));
}

// ── parsePreflight ──────────────────────────────────────────────────────────
{
  const ok = p.parsePreflight(block(), NOW);
  check('a well-formed block parses', ok && ok.keysOk === 11 && ok.checkedAtDate instanceof Date, J(ok));
  for (const v of ['1.4.7+65', '1.4.1', '1.5.3.0', '10.20.30+123456']) check(`version ${v} accepted`, !!p.parsePreflight(block({ version: v }), NOW));
  for (const v of ['1.4', '1.4.7-beta', '1.4.7+65 ', 'C:\\Users\\bob', '1.4.7+1234567', '<script>']) check(`version ${J(v)} refused`, p.parsePreflight(block({ version: v }), NOW) === null);
  check('version null accepted', !!p.parsePreflight(block({ version: null }), NOW));
  const bad = [
    ['not an object', 'x'], ['an array', [block()]], ['null', null], ['a number', 7],
    ['unknown schema', block({ schema: 'rem0te-rustdesk-preflight/2' })],
    ['an unknown field (a path)', { ...block(), path: 'C:\\Users\\alice\\AppData\\Local\\rustdesk\\rustdesk.exe' }],
    ['an unknown field (a value)', { ...block(), values: { 'access-mode': 'full' } }],
    ['an unknown key', block({ keys: { ...allKeys(), password: 'ok' } })],
    ['an unknown key result', block({ keys: { ...allKeys(), 'access-mode': 'full' } })],
    ['an unknown build', block({ build: 'qt' })],
    ['an unknown service state', block({ service: 'paused' })],
    ['an unknown cli', block({ cli: 'yes' })],
    ['checkedAt with millis', block({ checkedAt: '2026-11-19T11:00:00.000Z' })],
    ['checkedAt not UTC', block({ checkedAt: '2026-11-19T11:00:00+01:00' })],
    ['checkedAt in the future', block({ checkedAt: iso(-3600_000) })],
    ['durationMs negative', block({ durationMs: -1 })],
    ['durationMs huge', block({ durationMs: 600_001 })],
    ['durationMs fractional', block({ durationMs: 1.5 })],
    ['installed as a string', block({ installed: 'true' })],
    ['cli ok but a key failed', block({ keys: { ...allKeys(), 'enable-audio': 'timeout' } })],
    ['cli partial but every key ok', block({ cli: 'partial' })],
    ['cli failed but one key ok', block({ cli: 'failed', keys: { ...allKeys('error'), 'access-mode': 'ok' } })],
    ['cli ok with a key missing', block({ keys: Object.fromEntries(p.PREFLIGHT_KEYS.slice(1).map((k) => [k, 'ok'])) })],
    ['not_run with keys', block({ cli: 'not_run' })],
    ['ran though not installed', block({ installed: false })],
    ['ran though another exe', block({ expectedPath: false })],
    ['oversized', { ...block(), keys: allKeys(), pad: 'x'.repeat(9000) }],
  ];
  for (const [name, b] of bad) {
    let res; let threw = false;
    try { res = p.parsePreflight(b, NOW); } catch { threw = true; }
    check(`refused, never thrown: ${name}`, !threw && res === null, J(res));
  }
  check('not_run with no keys parses', !!p.parsePreflight(block({ cli: 'not_run', keys: {}, installed: false, expectedPath: false }), NOW));
  check('partial parses', p.parsePreflight(block({ cli: 'partial', keys: { ...allKeys(), 'enable-tunnel': 'unparsed' } }), NOW)?.keysOk === 10);
  check('failed parses', p.parsePreflight(block({ cli: 'failed', keys: allKeys('timeout') }), NOW)?.keysOk === 0);
  check('a clock up to 10 minutes ahead is tolerated', !!p.parsePreflight(block({ checkedAt: iso(-9 * 60_000) }), NOW));
}

// ── decideReadiness ─────────────────────────────────────────────────────────
const pf = (over = {}) => ({ checkedAt: new Date(NOW - 3600_000), installed: true, expectedPath: true, version: '1.4.7+65', build: 'flutter', service: 'running', cli: 'ok', keysOk: 11, ...over });
const facts = (over = {}) => ({ platform: 'windows', signedAgent: true, agentVersion: '0.69.0', isOnline: true, lastSeenAt: new Date(NOW - 60_000), preflight: pf(), ...over });
const d = (over = {}) => r.decideReadiness(facts(over), NOW);
const is = (name, f, state, re) => {
  const x = d(f);
  check(`${name} → ${state}`, x.state === state && (!re || x.reasons.some((t) => re.test(t))), `${x.state}: ${x.reasons.join(' | ')}`);
  return x;
};
{
  const c = is('a lab-tested release, all reads answered', {}, 'compatible', /lab-tested release/);
  check('compatible says nothing changed', c.reasons.some((t) => /Nothing has been changed/.test(t)) && c.labTested === true && c.label === 'Compatible');
  const c2 = is('1.4.3, inside the tested range', { preflight: pf({ version: '1.4.3+60' }) }, 'compatible', /not itself run in the lab/);
  check('1.4.3 is not claimed lab-tested', c2.labTested === false);
  is('Linux', { platform: 'linux' }, 'unsupported', /Linux is not supported/);
  is('macOS', { platform: 'macos' }, 'unsupported', /macOS is not supported/);
  is('no platform', { platform: null }, 'unknown');
  is('the standard agent', { signedAgent: false }, 'unsupported', /standard agent/);
  is('offline', { isOnline: false }, 'unknown', /not reporting/);
  is('agent silent (reachable, no heartbeat for an hour)', { lastSeenAt: new Date(NOW - 3600_000) }, 'unknown', /not reporting/);
  is('never seen', { lastSeenAt: null }, 'unknown', /never reported/);
  is('signed agent 0.68.3', { agentVersion: '0.68.3' }, 'upgrade_available', /too old to check RustDesk/);
  is('signed agent with no version', { agentVersion: null }, 'upgrade_available');
  is('signed agent 0.70.1', { agentVersion: '0.70.1' }, 'compatible');
  is('no report yet', { preflight: null }, 'unknown', /No readiness report yet/);
  is('a report 8 days old', { preflight: pf({ checkedAt: new Date(NOW - 8 * 86400_000) }) }, 'unknown', /older than 7 days/);
  is('a report 6 days old', { preflight: pf({ checkedAt: new Date(NOW - 6 * 86400_000) }) }, 'compatible');
  is('not installed', { preflight: pf({ installed: false, expectedPath: false, cli: 'not_run', keysOk: 0 }) }, 'upgrade_available', /not installed where/);
  is('service runs another copy', { preflight: pf({ expectedPath: false, cli: 'not_run', keysOk: 0 }) }, 'upgrade_available', /does not run the copy/);
  is('no service', { preflight: pf({ expectedPath: false, service: 'missing', cli: 'not_run', keysOk: 0 }) }, 'upgrade_available', /no Windows service/);
  is('Sciter', { preflight: pf({ build: 'sciter' }) }, 'unsupported', /Sciter/);
  is('build not recognised', { preflight: pf({ build: 'unknown' }) }, 'unknown', /could not be identified/);
  is('version unreadable', { preflight: pf({ version: null }) }, 'unknown', /could not be read/);
  const old = is('RustDesk 1.3.9', { preflight: pf({ version: '1.3.9+57' }) }, 'upgrade_available', /not lab-tested — not known to be broken/);
  check('below the minimum never says broken', !old.reasons.some((t) => /\bbroken\b/.test(t.replace('not known to be broken', ''))));
  is('RustDesk 1.2.3', { preflight: pf({ version: '1.2.3' }) }, 'upgrade_available', /older than the oldest lab-tested/);
  is('RustDesk 1.6.0 (newer than the lab)', { preflight: pf({ version: '1.6.0+70' }) }, 'unknown', /newer than the newest lab-tested/);
  is('service stopped', { preflight: pf({ service: 'stopped' }) }, 'unknown', /stopped/);
  is('10 of 11 reads', { preflight: pf({ cli: 'partial', keysOk: 10 }) }, 'unknown', /10 of 11/);
  is('no read answered', { preflight: pf({ cli: 'failed', keysOk: 0 }) }, 'unknown', /0 of 11/);
  for (const b of ['1.4.1', '1.4.6', '1.4.7', '1.4.9', '1.5.3']) is(`lab-tested ${b}`, { preflight: pf({ version: `${b}+1` }) }, 'compatible');
  // Order: an old agent that is offline is unknown, not upgrade.
  is('old agent, offline', { agentVersion: '0.60.0', isOnline: false }, 'unknown');
  // A string date (as Prisma JSON round-trips) works.
  is('checkedAt as a string', { preflight: pf({ checkedAt: new Date(NOW - 3600_000).toISOString() }) }, 'compatible');
}

// ── Managed states only from a managed fact (0.72) ──────────────────────────
{
  const managed = ['managed', 'managed_verified', 'enforcement_failure'];
  check('the type names every state of the design', J([...r.MSA_STATES]) === J(['unsupported', 'upgrade_available', 'compatible', 'unknown', ...managed]));
  check('a preflight alone produces only the four readiness states', J([...r.READINESS_STATES]) === J(['unsupported', 'upgrade_available', 'compatible', 'unknown']));
  check('the managed states are exactly the three', J([...r.MANAGED_READINESS_STATES]) === J(managed) && r.PRODUCIBLE_STATES.length === 7);
  // Every combination of facts the function reads, with no managed fact: never a managed state.
  const seen = new Set();
  let n = 0;
  let verifiedEver = false;
  const combos = function* () {
    for (const platform of ['windows', 'Windows 11', 'linux', 'macos', null, 'solaris'])
      for (const signedAgent of [true, false])
        for (const agentVersion of ['0.69.0', '0.68.3', null, '1.0.0', 'garbage'])
          for (const isOnline of [true, false])
            for (const lastSeen of [60_000, 3600_000, null])
              for (const pre of [null, 'fresh', 'old'])
                for (const version of ['1.4.7+65', '1.3.9', '1.6.0', null])
                  for (const build of ['flutter', 'sciter', 'unknown'])
                    for (const service of ['running', 'stopped', 'missing', 'other'])
                      for (const cli of ['ok', 'partial', 'failed', 'not_run'])
                        for (const placed of [[true, true], [true, false], [false, false]])
                          yield {
                            platform, signedAgent, agentVersion, isOnline, lastSeenAt: lastSeen === null ? null : new Date(NOW - lastSeen),
                            preflight: pre === null ? null : { checkedAt: new Date(NOW - (pre === 'old' ? 9 * 86400_000 : 600_000)), installed: placed[0], expectedPath: placed[1], version, build, service, cli, keysOk: cli === 'ok' ? 11 : cli === 'partial' ? 5 : 0 },
                          };
  };
  for (const f of combos()) {
    for (const m of [undefined, null]) {
      const x = r.decideReadiness({ ...f, managed: m }, NOW);
      n++; seen.add(x.state);
      if (x.verified !== false) verifiedEver = true;
      if (!r.READINESS_STATES.includes(x.state)) failures.push(`produced ${x.state} with no managed fact for ${J({ ...f, preflight: !!f.preflight })}`);
      if (!x.reasons.length || x.label !== r.STATE_LABEL[x.state]) failures.push(`no reason or wrong label: ${J(x)}`);
    }
  }
  check(`${n} combinations without a managed fact: none managed, managed_verified or enforcement_failure`, managed.every((m) => !seen.has(m)) && seen.size === 4, J([...seen]));
  check('verified is false on every one of them', !verifiedEver);

  // With a managed fact.
  const reporting = { platform: 'windows', signedAgent: true, agentVersion: '0.72.0', isOnline: true, lastSeenAt: new Date(NOW - 60_000),
    preflight: { checkedAt: new Date(NOW - 600_000), installed: true, expectedPath: true, version: '1.4.7+65', build: 'flutter', service: 'running', cli: 'ok', keysOk: 11 } };
  const m = (over) => ({ state: 'pending', requestedAt: new Date(NOW - 3600_000), verifiedAt: null, readbackOkAt: null, failReason: null, failedKeys: [], ...over });
  const d = (managedFact, base = reporting) => r.decideReadiness({ ...base, managed: managedFact }, NOW);
  let x = d(m({}));
  check('pending: Managed (pending), not verified', x.state === 'managed' && x.verified === false && x.label === 'Managed (pending)' && /Legacy Connect still works/.test(x.reasons[0]), J(x));
  x = d(m({ state: 'rollback_pending', }));
  check('rolling back: still managed until the agent restores', x.state === 'managed' && x.verified === false && /Rolling back/.test(x.reasons[0]), J(x));
  x = d(m({ state: 'enforcement_failure', failReason: 'readback_mismatch', failedKeys: ['access-mode'] }));
  check('enforcement failure names the reason and keys', x.state === 'enforcement_failure' && x.verified === false && /readback_mismatch \(access-mode\)/.test(x.reasons[0]), J(x));
  x = d(m({ state: 'verified', verifiedAt: new Date(NOW - 7200_000), readbackOkAt: new Date(NOW - 600_000) }));
  check('verified with a readback this week: managed_verified, verified true', x.state === 'managed_verified' && x.verified === true, J(x));
  x = d(m({ state: 'verified', verifiedAt: new Date(NOW - 7200_000), readbackOkAt: new Date(NOW - 8 * 86400_000) }));
  check('verified but no readback for 8 days: unknown, never shown as enforced', x.state === 'unknown' && x.verified === false, J(x));
  x = d(m({ state: 'verified', verifiedAt: new Date(NOW - 7200_000), readbackOkAt: null }));
  check('verified with no readback at all: unknown', x.state === 'unknown' && x.verified === false, J(x));
  x = d(m({ state: 'verified', verifiedAt: new Date(NOW - 7200_000), readbackOkAt: new Date(NOW - 600_000) }), { ...reporting, platform: 'linux' });
  check('a managed fact never overrides rules 1–3 (not Windows)', x.state === 'unsupported' && x.verified === false, J(x));
  x = d(m({ state: 'verified', verifiedAt: new Date(NOW - 7200_000), readbackOkAt: new Date(NOW - 600_000) }), { ...reporting, isOnline: false, lastSeenAt: null });
  check('a managed fact never overrides rules 1–3 (not reporting)', !managed.includes(x.state) && x.verified === false, J(x));
  // Only one line in decideReadiness produces managed_verified, from the verified row.
  const src = readFileSync(join(here, '..', 'src', 'msa', 'readiness.ts'), 'utf8');
  const body = src.slice(src.indexOf('export function decideReadiness'));
  check('managed states appear only inside the managed-fact branch', (() => {
    const branch = body.slice(body.indexOf('const m = f.managed;'), body.indexOf('// 4. An agent that can report.'));
    // The one other mention: `verified` is true exactly for managed_verified.
    const rest = body.replace(branch, '').replace("verified: state === 'managed_verified'", '');
    return branch.length > 0 && !/'managed'|'managed_verified'|'enforcement_failure'/.test(rest);
  })());
  check('the readiness note still says nothing changed', /nothing has changed on this computer/.test(r.READINESS_NOTE));
  check('the managed note says where it has run', /only in the Windows lab/.test(r.MANAGED_NOTE) && /never on a Windows 10 or 11 desktop or on the fleet/.test(r.MANAGED_NOTE));
}

// ── Versions ────────────────────────────────────────────────────────────────
{
  check('compareVersion ignores the build number', r.compareVersion('1.4.7+65', '1.4.7') === 0 && r.compareVersion('1.4.10', '1.4.9') === 1 && r.compareVersion('1.3.9', '1.4.1') === -1);
  check('compareVersion null on junk', r.compareVersion('x', '1.4.1') === null && r.compareVersion(null, '1.4.1') === null);
  check('releaseOf', r.releaseOf('1.5.3+77') === '1.5.3' && r.releaseOf('1.5') === null);
}

console.log(`unit-msa-readiness: ${passed} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures.slice(0, 40)) console.log(`  ✗ ${f}`); process.exit(1); }
