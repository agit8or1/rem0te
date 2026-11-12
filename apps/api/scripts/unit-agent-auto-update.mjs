#!/usr/bin/env node
// Tests for automatic agent self-update (0.36), run against dist:
//
//   cd apps/api && npx nest build && node scripts/unit-agent-auto-update.mjs
//
// The pure scheduling (agent-auto-update/schedule.ts): which agent has which
// update path, what it updates to and whether it is behind, which policy's
// mode governs, and decide() — opt-outs, holds, the attempt window, the
// back-off, the attempt cap and the failing state — plus the settings
// validation and the off switch. Then the generated scripts: the signed
// heartbeat's periodic self-check is present only in the signed variant and
// has no download or iex; both Windows variants parse with the PowerShell
// parser and the self-check runs against a stub agent under pwsh (when pwsh
// is on PATH or in PWSH); the Linux and macOS agents pass `sh -n` and still
// ignore every update flag.

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const s = require(join(here, '..', 'dist', 'agent-auto-update', 'schedule.js'));
const W = require(join(here, '..', 'dist', 'public', 'windows-script.js'));
const L = require(join(here, '..', 'dist', 'public', 'linux-agent.js'));
const M = require(join(here, '..', 'dist', 'public', 'macos-agent.js'));

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => { if (ok) passed++; else failures.push(`${name}${detail ? ` — ${detail}` : ''}`); };

const NOW = new Date('2026-11-12T12:00:00Z');
const MIN = 60_000, H = 60 * MIN;
const at = (ms) => new Date(NOW.getTime() + ms);
const SHA_A = 'a'.repeat(64), SHA_B = 'b'.repeat(64);
const served = { version: '0.36.0', signedSha256: SHA_A };
const std = (v = '0.30.1') => ({ platform: 'Windows', updateChannel: 'legacy', agentVersion: v, agentSha256: null, hasSecret: true });
const SET = { enabled: true, perHour: 120, maxAttempts: 3, processOn: true };
const base = (o = {}) => ({
  now: NOW, settings: SET, archived: false, facts: std(), served, gate: 'pass', mode: 'ANY_TIME', windowOpen: true, skipLoggedOnUser: false,
  paused: false, rollout: false, pendingRequest: false, sessionOpen: false, loggedOnUser: '', attempts: 0, lastAt: null, ...o,
});
const D = (o) => s.decide(base(o));

// ── Which agent, which path ─────────────────────────────────────────────────
{
  const ch = (f) => { const r = s.agentChannel(f); return r.channel ?? r.none; };
  check('0.15+ standard Windows agent → standard (reinstallAgent)', ch(std('0.18.25')) === 'standard' && s.flagFor('standard') === 'reinstallAgent');
  check('no reported version but a device secret → standard_pre015 (0.13–0.14), asked with updateRustdesk', ch(std(null)) === 'standard_pre015' && s.flagFor('standard_pre015') === 'updateRustdesk');
  check('no device secret → no path (older than 0.13.0: nothing the server says is acted on)', ch({ ...std(), hasSecret: false }) === 'no_device_secret');
  check('signed agent → signed (reinstallAgent → rem0te-agent.exe update)', ch({ ...std('0.34.0'), updateChannel: 'signed', agentSha256: SHA_B }) === 'signed' && s.flagFor('signed') === 'reinstallAgent');
  check('Linux and macOS → read-only agent, never updated from here', ch({ ...std(), platform: 'Linux' }) === 'read_only_agent' && ch({ ...std(), platform: 'macOS' }) === 'read_only_agent');
  check('an unknown platform is not Windows', ch({ ...std(), platform: null }) === 'not_windows');
}

// ── Target and behind ───────────────────────────────────────────────────────
{
  check('standard target is the served platform version', s.targetFor('standard', served) === '0.36.0');
  check('an unreadable version.json gives no target', s.targetFor('standard', { ...served, version: 'unknown' }) === null);
  check('signed target is the published build digest; none published → null', s.targetFor('signed', served) === SHA_A && s.targetFor('signed', { ...served, signedSha256: null }) === null);
  check('0.30.1 and 0.18.25 are behind 0.36.0 (numeric, not text)', s.isBehind('standard', std('0.30.1'), '0.36.0') === true && s.isBehind('standard', std('0.18.25'), '0.36.0') === true);
  check('0.9.0 is behind 0.36.0 and 0.36.0 is not; a newer agent is not behind', s.isBehind('standard', std('0.9.0'), '0.36.0') === true && s.isBehind('standard', std('0.36.0'), '0.36.0') === false && s.isBehind('standard', std('0.37.1'), '0.36.0') === false);
  check('a non-numeric version cannot be compared', s.isBehind('standard', std('beta'), '0.36.0') === null);
  check('pre-0.15 is behind by definition', s.isBehind('standard_pre015', std(null), '0.36.0') === true);
  check('signed: behind when its digest differs, current when equal, unknown when unreported', s.isBehind('signed', { agentSha256: SHA_B }, SHA_A) === true && s.isBehind('signed', { agentSha256: SHA_A }, SHA_A) === false && s.isBehind('signed', { agentSha256: null }, SHA_A) === null);
}

// ── Which mode governs ──────────────────────────────────────────────────────
{
  const P = (id, scope, agentMode) => ({ id, scope, agentMode, skipLoggedOnUser: false });
  check('no policy sets a mode → any time (the default)', s.resolveMode([]).mode === 'ANY_TIME' && s.resolveMode([P('b', 'business', null)]).policy === null);
  check('the most specific policy that sets one decides', s.resolveMode([P('g', 'group', 'WINDOW'), P('b', 'business', 'OFF')]).mode === 'WINDOW');
  check('one that leaves it unset passes to the next (group inherits the business opt-out)', (() => { const r = s.resolveMode([P('g', 'group', null), P('s', 'site', null), P('b', 'business', 'OFF')]); return r.mode === 'OFF' && r.policy.id === 'b'; })());
  check('a site that opts back in beats the business opt-out', s.resolveMode([P('s', 'site', 'ANY_TIME'), P('b', 'business', 'OFF')]).mode === 'ANY_TIME');
}

// ── decide(): the states ────────────────────────────────────────────────────
{
  let d = D();
  check('outdated 0.30.1, any time, nothing on record → queued, dispatch new', d.state === 'queued' && d.reason === 'next_heartbeat' && d.dispatch === 'new' && d.target === '0.36.0' && d.channel === 'standard', JSON.stringify(d));
  d = D({ facts: std('0.36.0') });
  check('up to date → no dispatch', d.state === 'up_to_date' && d.dispatch === null);
  d = D({ facts: std(null) });
  check('pre-0.15 → dispatch, channel standard_pre015', d.dispatch === 'new' && d.channel === 'standard_pre015');
  check('archived → unknown, never dispatched', D({ archived: true }).dispatch === null && D({ archived: true }).reason === 'archived');
  check('Linux → manual (read_only_agent)', D({ facts: { ...std(), platform: 'Linux' } }).state === 'manual');
  check('no device secret → manual', D({ facts: { ...std(), hasSecret: false } }).reason === 'no_device_secret');
  check('no readable target → unknown', D({ served: { version: 'unknown', signedSha256: null } }).reason === 'no_target');
  check('platform switch off → opted out', D({ settings: { ...SET, enabled: false } }).reason === 'platform_off' && D({ settings: { ...SET, enabled: false } }).dispatch === null);
  check('AGENT_AUTO_UPDATE=off → opted out (process_off)', D({ settings: { ...SET, processOn: false } }).reason === 'process_off');
  check('policy OFF → opted out', D({ mode: 'OFF' }).state === 'opted_out' && D({ mode: 'OFF' }).reason === 'policy_off');
  check('Signed only (withhold) → manual for a standard agent', D({ gate: 'withhold' }).reason === 'signed_only' && D({ gate: 'withhold' }).dispatch === null);
  check('Signed only + portal migration → queued (the portal migrates it), no dispatch of its own', D({ gate: 'migrate' }).reason === 'portal_migration' && D({ gate: 'migrate' }).dispatch === null);
  check('the legacy gate does not apply to a signed agent', D({ facts: { ...std('0.34.0'), updateChannel: 'signed', agentSha256: SHA_B }, gate: 'withhold' }).dispatch === 'new');
  for (const [k, v, r] of [['paused', true, 'paused'], ['rollout', true, 'rollout'], ['pendingRequest', true, 'pending_request'], ['sessionOpen', true, 'session_open']]) {
    const x = D({ [k]: v });
    check(`${k} → held (${r}), nothing dispatched`, x.state === 'queued' && x.reason === r && x.dispatch === null, JSON.stringify(x));
  }
  check('WINDOW mode, window closed → outside_window', D({ mode: 'WINDOW', windowOpen: false }).reason === 'outside_window');
  check('WINDOW mode, window open → dispatch', D({ mode: 'WINDOW', windowOpen: true }).dispatch === 'new');
  check('ANY_TIME ignores the window', D({ mode: 'ANY_TIME', windowOpen: false }).dispatch === 'new');
  check('WINDOW + skip logged-on: someone on → held; unknown → held; nobody → go',
    D({ mode: 'WINDOW', skipLoggedOnUser: true, loggedOnUser: 'CORP\\alice' }).reason === 'user_logged_on'
    && D({ mode: 'WINDOW', skipLoggedOnUser: true, loggedOnUser: undefined }).reason === 'user_unknown'
    && D({ mode: 'WINDOW', skipLoggedOnUser: true, loggedOnUser: '' }).dispatch === 'new');
  check('ANY_TIME never looks at who is logged on', D({ skipLoggedOnUser: true, loggedOnUser: 'CORP\\alice' }).dispatch === 'new');
}

// ── decide(): attempts, window, back-off, cap ───────────────────────────────
{
  let d = D({ attempts: 1, lastAt: at(-5 * MIN) });
  check('inside the 20-minute attempt window → resend (no new attempt)', d.state === 'updating' && d.dispatch === 'resend' && d.nextAt?.getTime() === at(15 * MIN).getTime(), JSON.stringify(d));
  d = D({ attempts: 1, lastAt: at(-19 * MIN) });
  check('at 19 minutes still resend', d.dispatch === 'resend');
  d = D({ attempts: 1, lastAt: at(-20 * MIN) });
  check('at 20 minutes the flag stops (verifying), under the agent\'s own 30-minute floor', d.dispatch === null && d.reason === 'verifying', JSON.stringify(d));
  d = D({ attempts: 1, lastAt: at(-79 * MIN) });
  check('verifying until 80 minutes (window + grace)', d.reason === 'verifying' && d.nextAt.getTime() === at(MIN).getTime());
  d = D({ attempts: 1, lastAt: at(-90 * MIN) });
  check('then back-off: attempt 2 not before 2 h after attempt 1', d.reason === 'backoff' && d.nextAt.getTime() === at(30 * MIN).getTime() && d.dispatch === null, JSON.stringify(d));
  d = D({ attempts: 1, lastAt: at(-2 * H) });
  check('at 2 h attempt 2 may start', d.dispatch === 'new');
  d = D({ attempts: 2, lastAt: at(-3 * H) });
  check('attempt 3 not before 8 h after attempt 2', d.reason === 'backoff' && d.nextAt.getTime() === at(5 * H).getTime());
  check('back-off schedule 0, 2 h, 8 h, then 24 h', s.backoffMs(0) === 0 && s.backoffMs(1) === 2 * H && s.backoffMs(2) === 8 * H && s.backoffMs(3) === 24 * H && s.backoffMs(9) === 24 * H);
  check('every back-off step is longer than the attempt window plus grace (no overlap)', [1, 2, 3].every((n) => s.backoffMs(n) > s.ATTEMPT_WINDOW_MS + s.VERIFY_GRACE_MS));
  check('the attempt window is shorter than the agent\'s 30-minute floor (one run per attempt)', s.ATTEMPT_WINDOW_MS < 30 * MIN);
  d = D({ attempts: 3, lastAt: at(-10 * MIN) });
  check('the last attempt still resends inside its window', d.dispatch === 'resend');
  d = D({ attempts: 3, lastAt: at(-30 * MIN) });
  check('after the last attempt: verifying first', d.state === 'updating' && d.reason === 'verifying');
  d = D({ attempts: 3, lastAt: at(-2 * H) });
  check('then failing, and never dispatched again', d.state === 'failing' && d.reason === 'attempts_exhausted' && d.dispatch === null);
  d = D({ attempts: 3, lastAt: at(-200 * H) });
  check('failing stays failing however long it waits', d.state === 'failing' && d.dispatch === null);
  check('a higher cap allows a 4th attempt after 24 h', D({ settings: { ...SET, maxAttempts: 4 }, attempts: 3, lastAt: at(-25 * H) }).dispatch === 'new');
  check('failing outranks the holds (it says what is wrong)', D({ attempts: 3, lastAt: at(-3 * H), paused: true }).state === 'failing');
  check('a hold stops a resend too (a pause mid-attempt)', D({ attempts: 1, lastAt: at(-5 * MIN), paused: true }).dispatch === null && D({ attempts: 1, lastAt: at(-5 * MIN), sessionOpen: true }).dispatch === null);
  check('up to date with attempts on record → up_to_date', D({ facts: std('0.36.0'), attempts: 3, lastAt: at(-3 * H) }).state === 'up_to_date');
}

// ── attemptsFor: a new target starts from zero ──────────────────────────────
{
  const n = { agentAutoTarget: '0.35.0', agentAutoAttempts: 3, agentAutoLastAt: at(-H) };
  const a = s.attemptsFor(n, '0.36.0');
  check('a new release resets the attempts (a failing computer gets a fresh run)', a.attempts === 0 && a.lastAt === null);
  const b = s.attemptsFor(n, '0.35.0');
  check('the same target keeps them', b.attempts === 3 && b.lastAt.getTime() === at(-H).getTime());
  check('nothing on record → zero', s.attemptsFor({ agentAutoTarget: null, agentAutoAttempts: 0, agentAutoLastAt: null }, '0.36.0').attempts === 0);
}

// ── Signed self-check permission ────────────────────────────────────────────
{
  const sc = (o) => s.selfCheckAllowed({ settings: SET, mode: 'ANY_TIME', windowOpen: true, paused: false, rollout: false, sessionOpen: false, ...o });
  check('self-check allowed by default', sc({}));
  check('not when opted out, outside a WINDOW policy\'s window, paused, in a rollout, during a session, or switched off',
    !sc({ mode: 'OFF' }) && !sc({ mode: 'WINDOW', windowOpen: false }) && sc({ mode: 'WINDOW', windowOpen: true }) && !sc({ paused: true }) && !sc({ rollout: true }) && !sc({ sessionOpen: true })
    && !sc({ settings: { ...SET, enabled: false } }) && !sc({ settings: { ...SET, processOn: false } }));
}

// ── Settings ────────────────────────────────────────────────────────────────
{
  const d0 = s.settingsFrom(null, {});
  check('defaults: on, 120 an hour, 3 attempts, process on', d0.enabled === true && d0.perHour === 120 && d0.maxAttempts === 3 && d0.processOn === true);
  check('AGENT_AUTO_UPDATE=off turns the process off', s.settingsFrom(null, { AGENT_AUTO_UPDATE: 'off' }).processOn === false);
  check('stored out-of-range values fall back to the defaults', s.settingsFrom({ agentAutoUpdatePerHour: 0, agentAutoUpdateMaxAttempts: 99 }, {}).perHour === 120 && s.settingsFrom({ agentAutoUpdateMaxAttempts: 99 }, {}).maxAttempts === 3);
  const bad = (b) => { try { s.parseSettingsUpdate(b); return false; } catch { return true; } };
  check('the update validates: ranges, types, unknown fields, empty', bad({ perHour: 0 }) && bad({ perHour: 2001 }) && bad({ maxAttempts: 0 }) && bad({ maxAttempts: 11 }) && bad({ enabled: 'yes' }) && bad({ everySeconds: 1 }) && bad({}) && bad(null));
  check('a valid update parses', JSON.stringify(s.parseSettingsUpdate({ enabled: false, perHour: 30, maxAttempts: 5 })) === JSON.stringify({ enabled: false, perHour: 30, maxAttempts: 5 }));
  check('every reason has text', Object.keys(s.REASON_TEXT).length >= 25 && Object.values(s.REASON_TEXT).every((t) => typeof t === 'string' && t.length > 10));
}

// ── The generated scripts ───────────────────────────────────────────────────
const KEY = 'A'.repeat(43) + '=';
const legacy = W.buildLegacyWindowsScript({ version: '1.4.6', host: 'portal.example.com', key: KEY, agentVersion: '0.36.0', fallbackVersion: '1.4.6' });
const signed = W.buildSignedWindowsScript('0.36.0');
const HOOK_START = "try {\n    $agentExe = Join-Path $env:ProgramFiles 'Rem0te\\rem0te-agent.exe'\n    if ($resp.data.agentSelfCheck -eq $true";
{
  check('the signed heartbeat has the periodic self-check', signed.includes(HOOK_START) && signed.includes('update-check.next'));
  check('the legacy heartbeat does not', !legacy.includes('agentSelfCheck') && !legacy.includes('update-check.next') && legacy.includes('# Periodic self-check: signed channel only.'));
  const i = signed.indexOf(HOOK_START), hook = signed.slice(i, signed.indexOf('\n} catch {}', i) + 11);
  check('the self-check runs only `rem0te-agent.exe update`: no iex, no download, no other process', !/iex|Invoke-Expression|Invoke-WebRequest|DownloadFile|Start-Process|irm /i.test(hook) && (hook.match(/& \$agentExe/g) ?? []).length === 1 && hook.includes("& $agentExe @('update')"));
  check('jitter: 20 h plus up to 8 h', hook.includes('AddMinutes(1200 + (Get-Random -Minimum 0 -Maximum 480))'));
  check('the hook sits after the flag-driven update in the heartbeat body', signed.indexOf('update-check.next') > signed.indexOf("$aargs = @('update')"));
}

const pwsh = process.env.PWSH || (spawnSync('pwsh', ['-v']).status === 0 ? 'pwsh' : null);
if (!pwsh || (process.env.PWSH && !existsSync(process.env.PWSH))) console.log('  (pwsh not found: the PowerShell is not parsed or executed)');
else {
  const dir = mkdtempSync(join(tmpdir(), 'rem0te-autoupd-'));
  // The heartbeat body is a here-string inside the installer; parse it on its own too.
  const hbOf = (t) => { const a = t.indexOf("$hbBody = @'\n") + "$hbBody = @'\n".length; return t.slice(a, t.indexOf("\n'@\nSet-Content -Path $hbScript", a)).replace(/\\\$/g, '$'); };
  writeFileSync(join(dir, 'signed.ps1'), signed);
  writeFileSync(join(dir, 'legacy.ps1'), legacy);
  writeFileSync(join(dir, 'hb-signed.ps1'), hbOf(signed));
  writeFileSync(join(dir, 'hb-legacy.ps1'), hbOf(legacy));
  writeFileSync(join(dir, 'parse.ps1'), `
$bad = 0
foreach ($f in $args) { $t = $null; $e = $null; [System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$t, [ref]$e) | Out-Null; if ($e.Count) { $bad++; Write-Output ("$f : " + $e[0].Message + ' @ line ' + $e[0].Extent.StartLineNumber) } }
exit $bad`);
  const pr = spawnSync(pwsh, ['-NoProfile', '-File', join(dir, 'parse.ps1'), ...['signed', 'legacy', 'hb-signed', 'hb-legacy'].map((n) => join(dir, `${n}.ps1`))], { encoding: 'utf8' });
  check('pwsh: both installers and both heartbeat bodies parse with no errors', pr.status === 0, pr.stdout + pr.stderr);

  // Run the self-check hook itself against a stub agent that records each run.
  const i = signed.indexOf(HOOK_START);
  const hook = hbOf(signed).slice(hbOf(signed).indexOf(HOOK_START)).split('\n} catch {}')[0] + '\n} catch {}';
  check('the hook was found in the heartbeat body', i > 0 && hook.length > 200);
  const stamp = join(dir, 'update-check.next'), runs = join(dir, 'runs.txt');
  writeFileSync(join(dir, 'agent.ps1'), `# A native exe flattens the argument array; a script stub is handed it whole.
Add-Content -LiteralPath '${runs}' -Value (@($args | ForEach-Object { $_ }) -join ' ')`);
  const body = hook.replace("Join-Path $env:ProgramFiles 'Rem0te\\rem0te-agent.exe'", `'${join(dir, 'agent.ps1')}'`).replace("'C:\\ProgramData\\Rem0te\\update-check.next'", `'${stamp}'`);
  check('the stub paths were substituted', body.includes(join(dir, 'agent.ps1')) && body.includes(stamp));
  const run = (resp, upd = '$null') => {
    writeFileSync(join(dir, 'run.ps1'), `$resp = '${JSON.stringify(resp)}' | ConvertFrom-Json\n$upd = ${upd}\n${body}`);
    return spawnSync(pwsh, ['-NoProfile', '-File', join(dir, 'run.ps1')], { encoding: 'utf8' });
  };
  const runCount = () => (existsSync(runs) ? readFileSync(runs, 'utf8').trim().split('\n').filter(Boolean).length : 0);
  const due = () => (existsSync(stamp) ? new Date(readFileSync(stamp, 'utf8').trim()).getTime() : null);
  run({ data: { agentSelfCheck: false } });
  check('agentSelfCheck false: nothing scheduled, nothing run', due() === null && runCount() === 0);
  run({ data: { agentSelfCheck: true } });
  const d1 = due();
  check('first sighting only schedules, 20–28 h out', d1 !== null && d1 - Date.now() > 19.9 * H && d1 - Date.now() < 28.1 * H && runCount() === 0, String(d1 && (d1 - Date.now()) / H));
  run({ data: { agentSelfCheck: true } });
  check('not due: nothing run, schedule kept', due() === d1 && runCount() === 0);
  writeFileSync(stamp, new Date(Date.now() - MIN).toISOString());
  run({ data: { agentSelfCheck: false } });
  check('due but the portal says no: nothing run', runCount() === 0);
  run({ data: { agentSelfCheck: true } }, "[pscustomobject]@{ targetVersion = '0.36.0' }");
  check('due, but a flag already ran update this check-in: not run twice', runCount() === 0);
  writeFileSync(stamp, new Date(Date.now() - MIN).toISOString());
  run({ data: { agentSelfCheck: true } });
  check('due and allowed: `update` runs once and the next check is rescheduled 20–28 h out', runCount() === 1 && readFileSync(runs, 'utf8').trim() === 'update' && due() - Date.now() > 19.9 * H, readFileSync(runs, 'utf8'));
  writeFileSync(stamp, new Date(Date.now() + 5 * 24 * H).toISOString());
  run({ data: { agentSelfCheck: true } });
  check('a due time more than two days out (clock jump) is rescheduled, not acted on', runCount() === 1 && due() - Date.now() < 28.1 * H);
  writeFileSync(stamp, 'garbage');
  run({ data: { agentSelfCheck: true } });
  check('an unreadable schedule is rescheduled, not acted on', runCount() === 1 && due() !== null && !Number.isNaN(due()));
}

// ── Linux and macOS: still read-only, and well-formed sh ────────────────────
{
  for (const [name, text] of [['linux', L.buildLinuxAgentScript('0.36.0')], ['macos', M.buildMacosAgentScript('0.36.0')]]) {
    const f = join(mkdtempSync(join(tmpdir(), 'rem0te-sh-')), `${name}.sh`);
    writeFileSync(f, text);
    const r = spawnSync('sh', ['-n', f], { encoding: 'utf8' });
    check(`sh -n: the ${name} agent parses`, r.status === 0, r.stderr);
    check(`the ${name} agent still acts on no update flag (read-only, invariants §24/§32)`, !/reinstallAgent|updateRustdesk|agentSelfCheck/.test(text));
  }
}

console.log(`\nunit-agent-auto-update: ${passed} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1); }
