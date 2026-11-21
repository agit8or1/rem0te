#!/usr/bin/env node
// Windows lab (0.76): the read-only diagnostics palette on a real Windows.
//
//   node --experimental-strip-types --no-warnings tools/lab/windows/diagnostics-lab.mjs --part <dir> [--work C:\lab\diag]
//   node --experimental-strip-types --no-warnings tools/lab/windows/diagnostics-lab.mjs --dry-run
//
// What runs is the agent's own code: the heartbeat's diagnostics region
// (functions and the dispatcher), cut out of buildSignedWindowsScript() exactly
// as the portal serves it. The one thing replaced is Invoke-RestMethod, so the
// results are written to a file instead of posted to a portal. Each run goes
// through the real dispatcher in batches of three, as heartbeats hand them
// out, under Windows PowerShell 5.1:
//   - as the runner's administrator, directly;
//   - as SYSTEM, from a scheduled task (what the heartbeat task runs as).
// Each result then goes through the portal's own sanitizeResult() and
// interpret() (catalog.ts and interpret.ts, loaded with --experimental-strip-types).
//
// Read-only proof: a fingerprint of the computer's configuration is taken
// before and after each caller's runs — service names and start types,
// firewall profiles, scheduled task paths and enabled state, BitLocker volume
// statuses, the Windows Time parameters — and must be unchanged. Service and
// task run states are recorded too, but only reported: a Windows runner
// starts and stops trigger-start services on its own. BITS's start type is
// reported the same way, because Windows changes it on its own (see below).
//
// Network: none beyond the computer itself. Windows Update is pointed by
// policy at a WSUS on 127.0.0.1:8530 that does not exist first (the registry
// part of lab_windows_test.go's wuBlockScript); no check reads or touches
// Windows Update. The DNS lookup asks for "localhost" and the TCP tests dial
// 127.0.0.1 only.
//
// Writes to the part directory: diagnostics-evidence.jsonl (one line per key
// per caller, plus parse and read-only lines) and diagnostics-os.json.

import { mkdirSync, writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const dryRun = args.includes('--dry-run');

const ws = await import(pathToFileURL(join(root, 'apps/api/src/public/windows-script.ts')).href);
const cat = await import(pathToFileURL(join(root, 'apps/api/src/diagnostics-catalog/catalog.ts')).href);
const itp = await import(pathToFileURL(join(root, 'apps/api/src/diagnostics-catalog/interpret.ts')).href);

// ── The agent's diagnostics region, as served ──────────────────────────────
const script = ws.buildSignedWindowsScript('0.76.0');
const hb = /\$hbBody = @'\r?\n([\s\S]*?)\r?\n'@/.exec(script)?.[1];
if (!hb) throw new Error('no heartbeat body in the signed installer');
const a = hb.indexOf('# ---- Diagnostics catalog (0.31)');
const b = hb.indexOf('# ---- Monitoring (0.29)');
if (a < 0 || b < a) throw new Error('no diagnostics region in the heartbeat');
const region = hb.slice(a, b);

// The thirteen palette keys, and the runs asked of each caller.
const PALETTE = ['defender_status', 'firewall_status', 'bitlocker_status', 'secure_boot_tpm', 'local_admins', 'dns_lookup', 'tcp_port', 'route_table', 'time_sync', 'windows_activation', 'unexpected_shutdowns', 'scheduled_tasks', 'signed_in_sessions'];
for (const k of PALETTE) if (!cat.isCatalogKey(k)) throw new Error(`${k} is not a catalog key`);
const RUNS = PALETTE.map((key) => ({ id: `lab-${key.replace(/_/g, '-')}`, key, ...(key === 'dns_lookup' ? { params: { name: 'localhost' } } : key === 'tcp_port' ? { params: { host: '127.0.0.1', port: 135, timeoutSeconds: 2 } } : {}) }));
// The refused case: nothing listens on port 1. Five seconds, because Windows
// retries a refused connect for about a second before it gives up.
RUNS.push({ id: 'lab-tcp-port-refused', key: 'tcp_port', params: { host: '127.0.0.1', port: 1, timeoutSeconds: 5 } });
// Every parameter set must pass the portal's own check, as a request would.
for (const r of RUNS) { const p = cat.parseDiagnosticParams(r.key, r.params); if (!p.ok) throw new Error(`${r.id}: ${p.error}`); r.params = p.params ?? undefined; }
const BATCHES = [];
for (let i = 0; i < RUNS.length; i += 3) BATCHES.push({ data: { monitor: null, diagnostics: RUNS.slice(i, i + 3).map(({ id, key, params }) => (params ? { id, key, params } : { id, key })) } });

// ── The runner: fingerprint, parse, run every batch, fingerprint ───────────
const RUNNER = String.raw`param([Parameter(Mandatory = $true)][string]$Caller, [Parameter(Mandatory = $true)][string]$Dir)
# Lab harness (0.76), not agent code. Runs the heartbeat's diagnostics region
# in batches of three, with Invoke-RestMethod replaced by a file write.
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$regionFile = Join-Path $here 'region.ps1'
$posts = Join-Path $Dir 'posts.txt'
$enc = New-Object Text.UTF8Encoding($false)
function Save([string]$name, $obj) { [IO.File]::WriteAllText((Join-Path $Dir $name), ($obj | ConvertTo-Json -Depth 8), $enc) }
function Fingerprint {
    $cfg = New-Object System.Collections.Generic.List[string]
    $states = New-Object System.Collections.Generic.List[string]
    foreach ($s in @(Get-CimInstance Win32_Service -ErrorAction SilentlyContinue | Sort-Object Name)) { $cfg.Add('svc|' + $s.Name + '|' + $s.StartMode) | Out-Null; $states.Add('svc|' + $s.Name + '|' + $s.State) | Out-Null }
    foreach ($p in @(Get-NetFirewallProfile -ErrorAction SilentlyContinue | Sort-Object Name)) { $cfg.Add('fw|' + $p.Name + '|' + $p.Enabled + '|' + $p.DefaultInboundAction + '|' + $p.DefaultOutboundAction) | Out-Null }
    foreach ($p in @(Get-NetFirewallProfile -PolicyStore ActiveStore -ErrorAction SilentlyContinue | Sort-Object Name)) { $cfg.Add('fwa|' + $p.Name + '|' + $p.Enabled + '|' + $p.DefaultInboundAction + '|' + $p.DefaultOutboundAction) | Out-Null }
    foreach ($t in @(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -notlike 'rem0te-lab-*' } | Sort-Object TaskPath, TaskName)) {
        $cfg.Add('task|' + $t.TaskPath + $t.TaskName + '|' + ([string]$t.State -eq 'Disabled')) | Out-Null
        $states.Add('task|' + $t.TaskPath + $t.TaskName + '|' + $t.State) | Out-Null
    }
    if (Get-Command Get-BitLockerVolume -ErrorAction SilentlyContinue) {
        try { foreach ($v in @(Get-BitLockerVolume -ErrorAction Stop | Sort-Object MountPoint)) { $cfg.Add('bl|' + $v.MountPoint + '|' + $v.ProtectionStatus + '|' + $v.VolumeStatus + '|' + $v.EncryptionMethod) | Out-Null } } catch { $cfg.Add('bl|unavailable') | Out-Null }
    } else { $cfg.Add('bl|no cmdlet') | Out-Null }
    $tp = Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Services\W32Time\Parameters' -ErrorAction SilentlyContinue
    if ($tp) { foreach ($n in @($tp.PSObject.Properties | Where-Object { $_.Name -notlike 'PS*' } | Sort-Object Name)) { $cfg.Add('w32|' + $n.Name + '|' + [string]$n.Value) | Out-Null } }
    return @{ config = @($cfg); states = @($states) }
}
New-Item -ItemType Directory -Force -Path $Dir | Out-Null
Remove-Item -LiteralPath $posts -ErrorAction SilentlyContinue
$who = @{ caller = $Caller; identity = $null; isSystem = $false; elevated = $false; psVersion = [string]$PSVersionTable.PSVersion; session = [Diagnostics.Process]::GetCurrentProcess().SessionId }
try {
    $me = [Security.Principal.WindowsIdentity]::GetCurrent()
    $who.identity = $me.Name; $who.isSystem = $me.IsSystem
    $who.elevated = ([Security.Principal.WindowsPrincipal]$me).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
} catch { $who.identity = 'unknown (' + $_.Exception.Message + ')' }
$parse = @()
foreach ($f in @($regionFile, $MyInvocation.MyCommand.Path)) {
    $tk = $null; $er = $null
    [System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$tk, [ref]$er) | Out-Null
    foreach ($x in @($er)) { if ($x) { $parse += ((Split-Path -Leaf $f) + ': ' + $x.Message + ' @ line ' + $x.Extent.StartLineNumber) } }
}
$before = Fingerprint
Save 'fingerprint-before.json' $before
# The only stub: where the agent would post to its portal, write a line.
function Invoke-RestMethod { param($Uri, $Method, $Body, $ContentType, [switch]$UseBasicParsing, $TimeoutSec, $ErrorAction) [IO.File]::AppendAllText($posts, ([string]$Uri + ' ' + [string]$Body + [Environment]::NewLine), $enc) }
$id = '123456789'
$state = [pscustomobject]@{ agentSecret = 'lab-secret-not-a-secret'; host = 'lab.invalid' }
$timing = @()
foreach ($bf in @(Get-ChildItem -LiteralPath $here -Filter 'batch-*.json' | Sort-Object Name)) {
    $resp = [IO.File]::ReadAllText($bf.FullName) | ConvertFrom-Json
    $sw = [Diagnostics.Stopwatch]::StartNew()
    . $regionFile
    $timing += @{ batch = $bf.Name; ms = [int]$sw.ElapsedMilliseconds }
}
$after = Fingerprint
Save 'fingerprint-after.json' $after
Save 'runner.json' @{ who = $who; parseErrors = $parse; timing = $timing }
[IO.File]::WriteAllText((Join-Path $Dir 'done.txt'), 'done', $enc)
`;

// Windows Update off the network: the policy part of lab_windows_test.go's
// wuBlockScript (no firewall rules or hosts entries: nothing here talks to
// Windows Update, so the policy alone keeps a stray scan local).
const WU_BLOCK = String.raw`$ErrorActionPreference = 'Stop'
$wu = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate'
New-Item -Path "$wu\AU" -Force | Out-Null
Set-ItemProperty -Path $wu -Name WUServer -Value 'http://127.0.0.1:8530'
Set-ItemProperty -Path $wu -Name WUStatusServer -Value 'http://127.0.0.1:8530'
Set-ItemProperty -Path $wu -Name DoNotConnectToWindowsUpdateInternetLocations -Value 1 -Type DWord
Set-ItemProperty -Path "$wu\AU" -Name UseWUServer -Value 1 -Type DWord
Set-ItemProperty -Path "$wu\AU" -Name NoAutoUpdate -Value 1 -Type DWord
(Get-ItemProperty -Path $wu).WUServer
`;

// SYSTEM: a one-off scheduled task running the runner, waited for, removed.
const AS_SYSTEM = String.raw`param([string]$Runner, [string]$Dir, [string]$Ps)
$ErrorActionPreference = 'Stop'
$name = 'rem0te-lab-diagnostics-system'
Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
$act = New-ScheduledTaskAction -Execute $Ps -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $Runner + '" -Caller system -Dir "' + $Dir + '"')
$set = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 25) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $name -Action $act -User 'NT AUTHORITY\SYSTEM' -RunLevel Highest -Settings $set | Out-Null
Start-ScheduledTask -TaskName $name
$deadline = (Get-Date).AddMinutes(25)
$done = Join-Path $Dir 'done.txt'
while (-not (Test-Path -LiteralPath $done) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 5
    $st = (Get-ScheduledTask -TaskName $name).State
    if ([string]$st -eq 'Ready' -and -not (Test-Path -LiteralPath $done)) { Start-Sleep -Seconds 5; if (-not (Test-Path -LiteralPath $done)) { break } }
}
$info = Get-ScheduledTaskInfo -TaskName $name
Unregister-ScheduledTask -TaskName $name -Confirm:$false
'last result 0x{0:X}, done {1}' -f [int64]$info.LastTaskResult, (Test-Path -LiteralPath $done)
`;

function writeFiles(work) {
  mkdirSync(work, { recursive: true });
  const crlf = (s) => s.replace(/\r?\n/g, '\r\n');
  // A UTF-8 byte-order mark: Windows PowerShell 5.1 reads a file without one as the ANSI code page.
  const put = (name, s) => writeFileSync(join(work, name), '\ufeff' + crlf(s), 'utf8');
  put('region.ps1', region);
  put('runner.ps1', RUNNER);
  put('wu-block.ps1', WU_BLOCK);
  put('as-system.ps1', AS_SYSTEM);
  BATCHES.forEach((bt, i) => writeFileSync(join(work, `batch-${String(i).padStart(2, '0')}.json`), JSON.stringify(bt)));
}

const lines = [];
const add = (id, status, detail, extra = {}) => { lines.push({ id, status, detail, real: true, ...extra }); console.log(`${status.padEnd(4)} ${id}: ${detail}`); };
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8').replace(/^\ufeff/, ''));
const nowIso = () => new Date().toISOString();

// A Healthy finding must rest on a value that was read (unknown is never healthy).
function healthyFromNull(key, s, it) {
  const bad = [];
  const H = (id) => it.findings.filter((f) => f.state === 'healthy' && (id instanceof RegExp ? id.test(f.id) : f.id === id));
  for (const f of it.findings) if (/NaN|undefined/.test(f.detail)) bad.push(`${f.id} detail "${f.detail}"`);
  const need = (cond, id, why) => { if (H(id).length && !cond) bad.push(`${id} healthy without ${why}`); };
  switch (key) {
    case 'defender_status':
      need(s.realTimeProtectionEnabled === true || (s.registeredAntivirus ?? []).length > 0, 'antivirus', 'real-time protection read as on');
      need(s.isTamperProtected === true, 'tamper', 'tamper protection read as on');
      need(!!s.signatureLastUpdated || typeof s.signatureAgeDays === 'number', 'signatures', 'a signature date');
      need(!!s.quickScanEndAt || !!s.fullScanEndAt, 'scan', 'a scan date');
      break;
    case 'firewall_status':
      for (const p of ['domain', 'private', 'public']) need((s.profiles ?? []).some((x) => x.name?.toLowerCase() === p && x.enabled === true), p, `the ${p} profile read as on`);
      break;
    case 'bitlocker_status':
      for (const f of H(/^volume-/)) { const v = (s.volumes ?? []).find((x) => `volume-${String(x.mountPoint).replace(/[^A-Za-z0-9]/g, '').slice(0, 40).toLowerCase()}` === f.id); if (!(v?.protectionStatus === 'On' && v?.volumeStatus === 'FullyEncrypted')) bad.push(`${f.id} healthy without that volume read as protected and encrypted`); }
      break;
    case 'secure_boot_tpm':
      need(s.secureBoot === 'on', 'secure-boot', 'Secure Boot read as on');
      need(s.tpm?.present === true && s.tpm?.ready === true, 'tpm', 'a TPM read as present and ready');
      break;
    case 'local_admins': need(s.method !== 'none', 'members', 'a membership read'); break;
    case 'dns_lookup': need(s.lookup?.ok === true && (s.lookup?.addresses ?? []).length > 0, 'lookup', 'an answer'); break;
    case 'tcp_port': need(s.outcome === 'open', 'port', 'an open connection'); break;
    case 'route_table': need((s.routes ?? []).length > 0, 'default-route', 'routes'); break;
    case 'time_sync': need(!!s.status?.lastSyncAt, 'sync', 'a last sync time'); break;
    case 'windows_activation': for (const f of H(/^activation-/)) { const i = Number(f.id.split('-')[1]); if (s.products?.[i]?.licenseStatus !== 1) bad.push(`${f.id} healthy without licence status 1`); } break;
    case 'signed_in_sessions': need(s.userNamesRead === true || (s.sessions ?? []).length === 0, 'sessions', 'names read'); break;
    default: break;
  }
  return bad;
}

// One caller's run: the harness, parse, read-only and one line per run.
function evaluate(caller, dir, r, secs) {
  if (!existsSync(join(dir, 'done.txt'))) {
    add(`diagnostics/${caller}/harness`, 'fail', `the runner did not finish in ${secs} s (exit ${r.status}): ${(r.stdout + r.stderr).slice(-800)}`);
    for (const k of PALETTE) add(`diagnostics/${caller}/${k}`, 'fail', 'not run: the harness did not finish');
    return;
  }
  const meta = readJson(join(dir, 'runner.json'));
  const who = `${meta.who.identity} (system ${meta.who.isSystem}, elevated ${meta.who.elevated}, session ${meta.who.session}, PowerShell ${meta.who.psVersion})`;
  add(`diagnostics/${caller}/harness`, caller === 'dry' || (caller === 'system') === !!meta.who.isSystem ? 'pass' : 'fail', `ran as ${who} in ${secs} s; batches ${(meta.timing ?? []).map((t) => `${t.ms} ms`).join(', ')}; only Invoke-RestMethod was stubbed (results written to a file, not posted)${caller === 'system' ? `; task: ${r.stdout.trim()}` : ''}`);
  const perr = [].concat(meta.parseErrors ?? []).filter(Boolean);
  add(`diagnostics/${caller}/parse`, perr.length ? 'fail' : 'pass', perr.length ? perr.join('; ').slice(0, 800) : `region.ps1 (the agent's diagnostics region, ${region.length} characters) and runner.ps1 parse under PowerShell ${meta.who.psVersion}`);

  const fb = readJson(join(dir, 'fingerprint-before.json')), fa = readJson(join(dir, 'fingerprint-after.json'));
  const diff = (x, y) => { const sx = new Set(x), sy = new Set(y); return [...x.filter((l) => !sy.has(l)).map((l) => `-${l}`), ...y.filter((l) => !sx.has(l)).map((l) => `+${l}`)]; };
  // Windows-managed configuration: Windows itself moves BITS's start type
  // between Auto and Manual (it is delayed auto-start and is demoted when idle,
  // then restored by its triggers). It happened during the SYSTEM run on #189
  // and again on #191, with no check touching it. So BITS's start type is not
  // compared; a change is reported with the run states, not attributed.
  const WINDOWS_MANAGED = /^svc\|BITS\|/i;
  const cfg = (f) => [].concat(f.config ?? []).filter((l) => !WINDOWS_MANAGED.test(l));
  const managed = (f) => [].concat(f.config ?? []).filter((l) => WINDOWS_MANAGED.test(l));
  const cfgDiff = diff(cfg(fb), cfg(fa));
  const stDiff = [...diff(managed(fb), managed(fa)).map((l) => `${l} (Windows-managed start type)`), ...diff([].concat(fb.states ?? []), [].concat(fa.states ?? []))];
  add(`diagnostics/${caller}/read-only`, cfgDiff.length ? 'fail' : 'pass',
    `${(fb.config ?? []).length} configuration facts before and after (service start types, firewall profiles, task enabled state, BitLocker, W32Time parameters): ${cfgDiff.length ? `changed ${cfgDiff.slice(0, 12).join(', ')}` : 'unchanged'}; run states that moved meanwhile, not attributed: ${stDiff.length ? stDiff.slice(0, 10).join(', ') : 'none'}`);

  const posts = existsSync(join(dir, 'posts.txt')) ? readFileSync(join(dir, 'posts.txt'), 'utf8').replace(/^\ufeff/, '').split(/\r?\n/).filter(Boolean) : [];
  const byRun = {};
  for (const l of posts) {
    const i = l.indexOf(' ');
    const uri = l.slice(0, i);
    let body; try { body = JSON.parse(l.slice(i + 1)); } catch { continue; }
    (byRun[body.runId] ??= []).push({ uri, body });
  }
  for (const run of RUNS) {
    const id = `diagnostics/${caller}/${run.id === 'lab-tcp-port-refused' ? 'tcp_port-refused' : run.key}`;
    const seq = byRun[run.id] ?? [];
    const states = seq.map((x) => x.body.state);
    const final = seq.find((x) => x.body.state === 'completed' || x.body.state === 'failed');
    if (!final) { add(id, 'fail', `no result posted (states: ${states.join(',') || 'none'})`); continue; }
    if (seq.some((x) => x.uri !== 'https://lab.invalid/api/v1/enrollment/diagnostic-result')) { add(id, 'fail', `posted somewhere else: ${seq.map((x) => x.uri).join(', ')}`); continue; }
    if (final.body.state === 'failed') { add(id, 'fail', `the agent reported failed: ${final.body.error}`); continue; }
    const raw = final.body.result;
    const size = JSON.stringify(raw ?? null).length;
    const s = cat.sanitizeResult(run.key, raw);
    if (!s) { add(id, 'fail', 'the portal\'s sanitizer refused the result'); continue; }
    const capped = cat.capResult(s, cat.resultCapFor(run.key));
    const it = itp.interpret(run.key, capped.result, nowIso());
    if (!it || !it.findings.length || !itp.HEALTH_STATES.includes(it.overall)) { add(id, 'fail', 'interpret() produced no findings'); continue; }
    const viol = healthyFromNull(run.key, capped.result, it);
    let ok = states[0] === 'running' && viol.length === 0;
    let extra = '';
    if (run.id === 'lab-tcp-port-refused') { ok = ok && capped.result.outcome === 'refused'; extra = ` (expected refused, got ${capped.result.outcome})`; }
    if (run.key === 'tcp_port' && run.id !== 'lab-tcp-port-refused') { ok = ok && capped.result.outcome === 'open'; extra = ` (expected open on 127.0.0.1:135, got ${capped.result.outcome})`; }
    const f = it.findings.map((x) => `${x.label}: ${x.state} — ${x.detail}`).join('; ');
    add(id, ok ? 'pass' : 'fail', `${it.overall}${extra}. ${f}${viol.length ? ` | UNKNOWN SHOWN AS HEALTHY: ${viol.join('; ')}` : ''} [${states.join('→')}; ${size} characters posted, ${capped.bytes} bytes stored${capped.truncated ? ', truncated' : ''}]`, { overall: it.overall, key: run.key, caller });
  }
}

if (dryRun) {
  // Off Windows: write the files, parse them with pwsh, and run the harness
  // under pwsh. Nearly every Windows command is missing here, so the results
  // say nothing about Windows. What this proves is the plumbing: every run
  // reaches the dispatcher, posts running then a final state to the one URL,
  // and every completed result goes through sanitizeResult() and interpret()
  // without a Healthy built on a value that was not read.
  const work = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'rem0te-diaglab-'));
  writeFiles(work);
  const pwsh = process.env.PWSH || 'pwsh';
  const probe = spawnSync(pwsh, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    console.log(`dry run: ${RUNS.length} runs in ${BATCHES.length} batches; no pwsh (set PWSH), nothing parsed or run`);
    rmSync(work, { recursive: true, force: true });
    process.exit(0);
  }
  writeFileSync(join(work, 'parse.ps1'), "$bad = 0\nforeach ($f in $args) { $t = $null; $e = $null; [System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$t, [ref]$e) | Out-Null; foreach ($x in $e) { $bad++; Write-Output (\"$f : \" + $x.Message + ' @ ' + $x.Extent.StartLineNumber) } }\nexit $bad\n");
  const pr = spawnSync(pwsh, ['-NoProfile', '-File', join(work, 'parse.ps1'), ...['region.ps1', 'runner.ps1', 'wu-block.ps1', 'as-system.ps1'].map((f) => join(work, f))], { encoding: 'utf8' });
  if (pr.status !== 0) { console.error(`parse errors:\n${pr.stdout}${pr.stderr}`); process.exit(1); }
  const dir = join(work, 'dry');
  const started = Date.now();
  const r = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-File', join(work, 'runner.ps1'), '-Caller', 'dry', '-Dir', dir], { encoding: 'utf8', timeout: 10 * 60_000 });
  evaluate('dry', dir, r, Math.round((Date.now() - started) / 1000));
  const PLUMBING = /^(the runner did not finish|no result posted|posted somewhere else|the portal's sanitizer refused|interpret\(\) produced no findings)|UNKNOWN SHOWN AS HEALTHY/;
  const broken = lines.filter((l) => (/\/parse$/.test(l.id) && l.status === 'fail') || PLUMBING.test(l.detail));
  const reported = lines.filter((l) => l.key).length;
  const agentFailed = lines.filter((l) => /^the agent reported failed/.test(l.detail)).length;
  console.log(`\ndry run (pwsh ${probe.stdout.trim()}): ${RUNS.length} runs in ${BATCHES.length} batches, region ${region.length} characters; all four files parse; ${reported} results sanitized and interpreted, ${agentFailed} reported failed by the agent (expected off Windows); ${broken.length} plumbing failures`);
  for (const l of broken) console.error(`  ${l.id}: ${l.detail.slice(0, 300)}`);
  // --part with --dry-run keeps these lines (marked not real) to exercise merge-evidence.mjs.
  if (opt('--part')) {
    mkdirSync(opt('--part'), { recursive: true });
    writeFileSync(join(opt('--part'), 'diagnostics-evidence.jsonl'), lines.map((l) => JSON.stringify({ ...l, real: false })).join('\n') + '\n');
  }
  rmSync(work, { recursive: true, force: true });
  process.exit(broken.length ? 1 : 0);
}

// ── On Windows ──────────────────────────────────────────────────────────────
if (process.platform !== 'win32') { console.error('run this on Windows (or pass --dry-run)'); process.exit(2); }
const part = resolve(opt('--part', join(process.env.RUNNER_TEMP ?? tmpdir(), 'lab-part')));
const work = opt('--work', 'C:\\lab\\diag');
mkdirSync(part, { recursive: true });
writeFiles(work);
const ps51 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const ps = (file, extra = [], timeout = 30 * 60_000) => spawnSync(ps51, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(work, file), ...extra], { encoding: 'utf8', timeout });

const osr = spawnSync(ps51, ['-NoProfile', '-NonInteractive', '-Command', "$o = Get-CimInstance Win32_OperatingSystem; $c = Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion'; @{ caption = $o.Caption; version = $o.Version; build = $o.BuildNumber; ubr = $c.UBR; displayVersion = $c.DisplayVersion; productType = $o.ProductType } | ConvertTo-Json -Compress"], { encoding: 'utf8' });
const os = (() => { try { return JSON.parse(osr.stdout.trim()); } catch { return { caption: null, error: osr.stderr } } })();
writeFileSync(join(part, 'diagnostics-os.json'), JSON.stringify(os, null, 2));
console.log('Windows:', JSON.stringify(os));

const wu = ps('wu-block.ps1', [], 120_000);
console.log(`Windows Update policy: ${wu.status === 0 ? `WUServer ${wu.stdout.trim()}` : `FAILED ${wu.stderr}`}`);

for (const caller of ['admin', 'system']) {
  const dir = join(work, caller);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const started = Date.now();
  const r = caller === 'admin'
    ? ps('runner.ps1', ['-Caller', 'admin', '-Dir', dir])
    : ps('as-system.ps1', ['-Runner', join(work, 'runner.ps1'), '-Dir', dir, '-Ps', ps51]);
  const secs = Math.round((Date.now() - started) / 1000);
  evaluate(caller, dir, r, secs);
}

writeFileSync(join(part, 'diagnostics-evidence.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
const failed = lines.filter((l) => l.status === 'fail');
console.log(`\n${lines.length} results, ${failed.length} failed`);
// A red job is a finding about Windows or a broken lab (as the Go job is); the
// merge tells them apart: a harness that never finished is a lab problem.
process.exit(failed.length ? 1 : 0);
