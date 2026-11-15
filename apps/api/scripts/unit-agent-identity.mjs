#!/usr/bin/env node
// Tests for "which agent a computer runs is sticky to signed" (0.51, §64),
// run against dist:
//
//   cd apps/api && npx nest build && node scripts/unit-agent-identity.mjs
//
// The pure rule (common/agent-identity.ts): runsSignedAgent over the sticky
// window, heartbeatKind for every report shape the computer can send — the
// signed heartbeat, a standard heartbeat, and the installers' own check-ins
// (Register, Test-Registered, the Rem0teEnrollment retry), which carry the
// device secret and no channel and are what flipped DS-HOME1 and
// DEWEY-WKS2022 to "legacy" — heartbeatMayAct, isInstallerCheckIn, and the
// Agent card's warning. Then the generated scripts: Test-Registered sends the
// agent version, the standard heartbeat's hand-over runs only the installed
// signed agent's own update, and (with PWSH or pwsh on PATH) every script
// parses and the hand-over runs against a stub agent.

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const I = require(join(here, '..', 'dist', 'common', 'agent-identity.js'));
const W = require(join(here, '..', 'dist', 'public', 'windows-script.js'));

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => { if (ok) passed++; else failures.push(`${name}${detail ? ` — ${detail}` : ''}`); };

const NOW = new Date('2026-11-14T23:30:00Z');
const MIN = 60_000, H = 60 * MIN, D = 24 * H;
const ago = (ms) => new Date(NOW.getTime() - ms);

// ── runsSignedAgent ──────────────────────────────────────────────────────────
check('signed, seen a minute ago, now reading legacy: still signed', I.runsSignedAgent({ updateChannel: 'legacy', signedSeenAt: ago(MIN) }, NOW));
check('signed seen 6 days 23 h ago: still signed', I.runsSignedAgent({ updateChannel: 'legacy', signedSeenAt: ago(7 * D - H) }, NOW));
check('no signed heartbeat for 7 days: not sticky any more', !I.runsSignedAgent({ updateChannel: 'legacy', signedSeenAt: ago(7 * D) }, NOW));
check('nothing on record, reports signed: signed', I.runsSignedAgent({ updateChannel: 'signed', signedSeenAt: null }, NOW));
check('nothing on record, reports legacy: standard', !I.runsSignedAgent({ updateChannel: 'legacy', signedSeenAt: null }, NOW));
check('nothing on record at all: standard', !I.runsSignedAgent({ updateChannel: null, signedSeenAt: null }, NOW));
check('the window is seven days', I.SIGNED_STICKY_MS === 7 * D);

// ── heartbeatKind: the shapes from production ─────────────────────────────────
const signedEp = { updateChannel: 'signed', signedSeenAt: ago(3 * MIN) };
const stdEp = { updateChannel: 'legacy', signedSeenAt: null };
const beat = { loggedOnUser: 'DEWEY\\owner', uptimeSeconds: 4000, agentVersion: '0.47.0' };
// install.ps1 step 6 Register: version and password, no channel, no live state.
const register = { agentVersion: '0.47.0' };
// Test-Registered before 0.51: device secret only.
const testRegistered = {};
const kinds = [
  ['the signed heartbeat', { ...beat, updateChannel: 'signed' }, signedEp, 'signed'],
  ['the signed heartbeat on a computer that read legacy (DEWEY after 23:24)', { ...beat, updateChannel: 'signed' }, { updateChannel: 'legacy', signedSeenAt: null }, 'signed'],
  ['a standard heartbeat on a standard computer', { ...beat, updateChannel: 'legacy' }, stdEp, 'standard'],
  ['Register on a signed computer', register, signedEp, 'installer_on_signed'],
  ['Test-Registered on a signed computer (DS-HOME1 18:17:39)', testRegistered, signedEp, 'installer_on_signed'],
  ['a standard heartbeat still running on a signed computer', { ...beat, updateChannel: 'legacy', agentVersion: '0.46.0' }, signedEp, 'legacy_on_signed'],
  ['a pre-0.24 standard heartbeat (no channel) on a signed computer', { ...beat, updateChannel: undefined }, signedEp, 'legacy_on_signed'],
  ['an empty logged-on user still counts as live state', { loggedOnUser: '' }, signedEp, 'legacy_on_signed'],
  ['Register on a standard computer', register, stdEp, 'standard'],
  ['a standard heartbeat a week after the last signed one', { ...beat }, { updateChannel: 'signed', signedSeenAt: ago(8 * D) }, 'standard'],
];
for (const [name, dto, ep, want] of kinds) {
  const got = I.heartbeatKind(dto, ep, NOW);
  check(`heartbeatKind: ${name}`, got === want, `got ${got}, want ${want}`);
}
check('only signed and standard heartbeats may act',
  I.heartbeatMayAct('signed') && I.heartbeatMayAct('standard') && !I.heartbeatMayAct('legacy_on_signed') && !I.heartbeatMayAct('installer_on_signed'));

// ── isInstallerCheckIn ───────────────────────────────────────────────────────
check('Test-Registered (pre-0.51) is an installer check-in', I.isInstallerCheckIn({}));
check('Test-Registered (0.51, with a version) is an installer check-in', I.isInstallerCheckIn({ agentVersion: '0.51.0' }));
check('Register is an installer check-in', I.isInstallerCheckIn(register));
check('a heartbeat is not', !I.isInstallerCheckIn(beat));
check('a signed report is never one', !I.isInstallerCheckIn({ updateChannel: 'signed' }));

// ── the Agent card's warning ──────────────────────────────────────────────────
const w = I.dualAgentWarning({ updateChannel: 'signed', signedSeenAt: ago(2 * MIN), legacySeenAt: ago(MIN), legacySeenVersion: '0.46.0' }, NOW);
check('warning: both seen recently', !!w && /^Two agents are reporting from this computer: /.test(w.text) && /0\.46\.0/.test(w.text) && w.command === I.STANDARD_RETIRE_COMMAND, JSON.stringify(w));
check('warning: the command is the installed signed agent\'s own update', /rem0te-agent\.exe" update$/.test(I.STANDARD_RETIRE_COMMAND) && !/irm|iex|http/i.test(I.STANDARD_RETIRE_COMMAND));
const w2 = I.dualAgentWarning({ updateChannel: 'signed', signedSeenAt: ago(5 * H), legacySeenAt: ago(MIN), legacySeenVersion: null }, NOW);
check('warning: says when the standard one has taken over', !!w2 && /taken the signed one's place/.test(w2.fix));
check('warning: none without a legacy report', I.dualAgentWarning({ updateChannel: 'signed', signedSeenAt: ago(MIN), legacySeenAt: null, legacySeenVersion: null }, NOW) === null);
check('warning: none a day after the last legacy report', I.dualAgentWarning({ updateChannel: 'signed', signedSeenAt: ago(MIN), legacySeenAt: ago(D + MIN), legacySeenVersion: null }, NOW) === null);
check('warning: none once the computer is no longer signed', I.dualAgentWarning({ updateChannel: 'legacy', signedSeenAt: ago(8 * D), legacySeenAt: ago(MIN), legacySeenVersion: null }, NOW) === null);

// ── the generated scripts ────────────────────────────────────────────────────
const SHA = 'a'.repeat(64);
const legacy = W.buildLegacyWindowsScript({ version: '1.4.6', host: 'relay.example.com', key: 'OeVuKk5nlHiXp+APNn0Y3pC1Iwpwn44JGqrQCsWqmBw=', enrollToken: '', clientSha256: SHA, updateNonce: null, agentVersion: '0.51.0', fallbackVersion: '1.4.6', traySha256: SHA });
const signed = W.buildSignedWindowsScript('0.51.0');
const hbOf = (s) => (/\$hbBody = @'\r?\n([\s\S]*?)\r?\n'@/.exec(s) ?? ['', ''])[1];
const lhb = hbOf(legacy), shb = hbOf(signed);
for (const [n, s] of [['standard', legacy], ['signed', signed]]) {
  check(`${n} installer: Test-Registered sends the agent version`, /\$b = @\{ rustdeskId = \$id; hostname = \$env:COMPUTERNAME; platform = 'Windows'; agentSecret = \$AGENT_SECRET; agentVersion = \$AGENT_VERSION \}/.test(s));
}
const hStart = lhb.indexOf('if ($resp.data.retireStandard -eq $true)');
const hand = hStart < 0 ? '' : lhb.slice(hStart, lhb.indexOf('\n} catch {}', hStart));
check('standard heartbeat: hands over on retireStandard', hand.length > 100);
check('standard heartbeat: the hand-over runs only the installed signed agent\'s update',
  /\$agentExe = Join-Path \$env:ProgramFiles 'Rem0te\\rem0te-agent\.exe'/.test(hand) && /& \$agentExe @\('update'\)/.test(hand)
    && !/irm|iex|Invoke-WebRequest|Invoke-Expression|\$iu|\$resp\.data\.[a-zA-Z]+\.(url|path|exe)/i.test(hand));
check('standard heartbeat: only when agent-status.json names a signed build, at most every 30 minutes',
  /\[string\]\$rst\.agentSha256 -cmatch '\^\[0-9a-f\]\{64\}\$'/.test(hand) && /TotalMinutes -ge 30/.test(hand));
check('signed heartbeat: no hand-over code', !/retireStandard/.test(shb) && /# Handing over to the signed agent: standard channel only\./.test(shb));
check('the standard heartbeat marker the Go agent looks for is only in the standard heartbeat',
  lhb.includes("$body['updateChannel'] = 'legacy'") && !shb.includes("$body['updateChannel'] = 'legacy'"));

const pwsh = process.env.PWSH || (spawnSync('pwsh', ['-v']).status === 0 ? 'pwsh' : null);
if (pwsh && existsSync(pwsh) || pwsh === 'pwsh') {
  const dir = mkdtempSync(join(tmpdir(), 'rem0te-identity-'));
  for (const [n, s] of [['legacy.ps1', legacy], ['signed.ps1', signed], ['legacy-heartbeat.ps1', lhb], ['signed-heartbeat.ps1', shb]]) {
    const f = join(dir, n);
    writeFileSync(f, s);
    const r = spawnSync(pwsh, ['-NoProfile', '-Command', `$e=$null;$t=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${f}',[ref]$t,[ref]$e); if ($e.Count) { $e | % { $_.ToString() }; exit 1 }`], { encoding: 'utf8' });
    check(`pwsh parses ${n}`, r.status === 0, (r.stdout + r.stderr).slice(0, 300));
  }
  // Run the hand-over against a stub agent: it runs `update` once, then not again within 30 minutes.
  const stubDir = join(dir, 'pf', 'Rem0te');
  const pd = join(dir, 'pd');
  spawnSync('mkdir', ['-p', stubDir, pd]);
  const marker = join(dir, 'ran.txt');
  writeFileSync(join(stubDir, 'rem0te-agent.ps1'), `param([Parameter(ValueFromRemainingArguments=$true)]$a)\nAdd-Content -LiteralPath '${marker}' -Value ($a -join ' ')\n`);
  const run = (status) => {
    writeFileSync(join(pd, 'agent-status.json'), JSON.stringify(status));
    const body = hand + '\n} catch {}';
    const prog = [
      `$env:ProgramFiles = '${join(dir, 'pf')}'`,
      `$STATE_FILE = '${join(pd, 'heartbeat.dat')}'`,
      `if (-not (Test-Path -LiteralPath $STATE_FILE)) { '{}' | Set-Content -LiteralPath $STATE_FILE }`,
      `$state = Get-Content -Raw -LiteralPath $STATE_FILE | ConvertFrom-Json`,
      `$resp = [pscustomobject]@{ data = [pscustomobject]@{ retireStandard = $true } }`,
      // The heartbeat names the .exe; the stub is a .ps1 beside it.
      ('try { ' + body.replace("'Rem0te\\rem0te-agent.exe'", "'Rem0te\\rem0te-agent.ps1'").replace(/C:\\ProgramData\\Rem0te\\agent-status\.json/g, join(pd, 'agent-status.json'))),
    ].join('\n');
    const f = join(dir, 'run.ps1');
    writeFileSync(f, prog);
    return spawnSync(pwsh, ['-NoProfile', '-File', f], { encoding: 'utf8' });
  };
  run({ agentSha256: 'not a digest' });
  check('hand-over: nothing runs without a signed build on record', !existsSync(marker));
  run({ agentSha256: SHA });
  check('hand-over: runs the installed agent\'s update', existsSync(marker) && readFileSync(marker, 'utf8').trim() === 'update', existsSync(marker) ? readFileSync(marker, 'utf8') : 'not run');
  run({ agentSha256: SHA });
  check('hand-over: not again within 30 minutes', existsSync(marker) && readFileSync(marker, 'utf8').trim().split('\n').length === 1);
} else {
  console.log('  (pwsh not found: PowerShell parsing and the stub run skipped; set PWSH)');
}

console.log(`\nagent identity: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
