#!/usr/bin/env node
// Tests for the read-only diagnostics catalog (0.31), run against dist:
//
//   cd apps/api && npx nest build && node scripts/unit-diagnostics-catalog.mjs
//
// Pure parts: the catalog itself, key checks, result sanitising and
// redaction, and the size cap. Then the generated heartbeat: its dispatch
// switch must carry exactly the catalog keys. With pwsh available (on PATH,
// or PWSH=/path/to/pwsh) it also parses both installer variants and the
// heartbeat with PowerShell's own parser, and runs the diagnostics block
// against stub cmdlets, checking every post it would make.
//
// SIMULATED: stubs stand in for Windows. Nothing here ran on Windows.

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const c = require(join(here, '..', 'dist', 'diagnostics-catalog', 'catalog.js'));
const w = require(join(here, '..', 'dist', 'public', 'windows-script.js'));

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => { if (ok) passed++; else failures.push(`${name}${detail ? ` — ${detail}` : ''}`); };

// The 0.31 nine; this suite runs them under pwsh. The 0.33 snapshot keys are
// run under pwsh by unit-system-inventory.mjs.
const KEYS = ['refresh_inventory', 'disk_space', 'service_health', 'recent_system_errors', 'top_processes', 'network_connectivity', 'dns_resolution', 'pending_updates', 'reboot_status'];
const ALL_KEYS = [...KEYS, 'process_list', 'service_list', 'network_adapters'];

// ── The catalog ─────────────────────────────────────────────────────────────
{
  check('the catalog has exactly the twelve stable keys, in order', JSON.stringify(c.DIAGNOSTIC_KEYS) === JSON.stringify(ALL_KEYS) && JSON.stringify(c.CATALOG.map((e) => e.key)) === JSON.stringify(ALL_KEYS));
  for (const e of c.CATALOG) {
    check(`${e.key}: read-only, no impact, no approvals, Windows`, e.risk === 'read_only' && e.expectedImpact === 'none' && e.approvals === 'none (read-only)' && JSON.stringify(e.supportedOs) === '["windows"]');
    check(`${e.key}: label, description, duration and a justified capability`, !!e.label && e.description.length > 20 && ['seconds', 'minute', 'minutes'].includes(e.duration) && ['computers:view', 'computers:event_logs'].includes(e.capability) && e.capabilityReason.length > 10);
  }
  check('recent_system_errors needs computers:event_logs (it returns log text)', c.catalogEntry('recent_system_errors').capability === 'computers:event_logs');
  check('every other diagnostic needs only computers:view', c.CATALOG.filter((e) => e.key !== 'recent_system_errors').every((e) => e.capability === 'computers:view'));
  check('pending_updates is the slow one', c.catalogEntry('pending_updates').duration === 'minutes');
  for (const k of ['run_script', '__proto__', 'constructor', 'toString', 'Disk_Space', 'disk_space ', '', null, 1, ['disk_space']]) check(`isCatalogKey refuses ${JSON.stringify(k)}`, !c.isCatalogKey(k));
  check('isCatalogKey accepts each catalog key', ALL_KEYS.every((k) => c.isCatalogKey(k)));
  check('publicCatalog is a copy (mutating it does not change the catalog)', (() => { const p = c.publicCatalog(); p[0].key = 'x'; return c.CATALOG[0].key === 'refresh_inventory'; })());
}

// ── Sanitising ──────────────────────────────────────────────────────────────
{
  check('an unknown key has no sanitizer (the result is refused)', c.sanitizeResult('run_script', { out: 'x' }) === null);
  const d = c.sanitizeResult('disk_space', { disks: [{ drive: 'C:', label: 'OS', fsType: 'NTFS', totalBytes: 1000, freeBytes: 100, extra: 'drop me' }, { drive: 'D:', totalBytes: 100, freeBytes: 900 }, { label: 'no drive' }], cmd: 'rm -rf' });
  check('disk_space: percent free computed server side', d.disks[0].percentFree === 10, JSON.stringify(d));
  check('disk_space: free > total is not a percentage', d.disks[1].percentFree === null);
  check('disk_space: unknown fields and rows without a drive are dropped', !('extra' in d.disks[0]) && !('cmd' in d) && d.disks.length === 2);

  const msg = 'Faulting application C:\\Users\\alice.smith\\AppData\\Local\\app.exe with token ' + 'a'.repeat(48) + ' and C:\\Documents and Settings\\bob\\x';
  const e = c.sanitizeResult('recent_system_errors', { scanned: 12, groups: [{ log: 'System', provider: 'disk', eventId: 7, level: 2, count: 3, firstAt: '2026-11-10T10:00:00Z', lastAt: '2026-11-11T10:00:00Z', message: msg }, { log: 'Security', provider: 'x', eventId: 1, level: 2, count: 1 }, { log: 'System', eventId: 'NaN', count: 1 }] });
  check('recent_system_errors: profile paths become %USERPROFILE%', !/alice|bob/.test(e.groups[0].message) && e.groups[0].message.includes('%USERPROFILE%'), e.groups[0].message);
  check('recent_system_errors: long tokens are redacted', e.groups[0].message.includes('[redacted]') && !e.groups[0].message.includes('a'.repeat(40)));
  check('recent_system_errors: a log outside System/Application is relabelled, not trusted', e.groups[1].log === 'System');
  check('recent_system_errors: rows without an event id are dropped', e.groups.length === 2);
  check('recent_system_errors: messages are capped at 300', c.sanitizeResult('recent_system_errors', { groups: [{ eventId: 1, count: 1, message: 'word '.repeat(1000) }] }).groups[0].message.length === 300);
  check('recent_system_errors: at most 50 groups', c.sanitizeResult('recent_system_errors', { groups: Array.from({ length: 80 }, (_, i) => ({ eventId: i, count: 1 })) }).groups.length === 50);

  const p = c.sanitizeResult('top_processes', { processCount: 99, byCpu: Array.from({ length: 15 }, (_, i) => ({ name: i === 0 ? 'C:\\Users\\eve\\evil.exe' : `p${i}`, pid: i, cpuSeconds: 1.5, workingSetBytes: 10, commandLine: '--password hunter2', path: 'C:\\x' })), byMemory: [] });
  check('top_processes: at most 10 rows', p.byCpu.length === 10);
  check('top_processes: no command line or path survives, and a name is only a name', !JSON.stringify(p).includes('hunter2') && !JSON.stringify(p).includes('C:\\\\x') && p.byCpu[0].name === 'evil.exe' && !('commandLine' in p.byCpu[1]), JSON.stringify(p.byCpu[0]));

  const s = c.sanitizeResult('service_health', { totalServices: 200, stoppedAutomatic: [{ name: 'Spooler', displayName: 'Print Spooler', status: 'Stopped', startType: 'Automatic', path: 'C:\\Windows\\spoolsv.exe' }, { name: 'bad;name', status: 'Stopped' }, { name: 'gupdate', status: 'Exploded', startType: 'Whenever' }], monitored: [] });
  check('service_health: a name failing the charset is dropped', s.stoppedAutomatic.length === 2 && s.stoppedAutomatic.every((x) => x.name !== 'bad;name'));
  check('service_health: states and start types are from a fixed list', s.stoppedAutomatic[1].status === 'Unknown' && s.stoppedAutomatic[1].startType === 'Unknown');
  check('service_health: no binary path', !('path' in s.stoppedAutomatic[0]));

  const n = c.sanitizeResult('network_connectivity', { target: { host: 'portal.example.com', port: 443, reachable: true, latencyMs: 20 }, adapters: [{ name: 'Ethernet', up: true, ipv4: ['10.0.0.5', 'not-an-ip; rm'], ipv6: ['fe80::1'], gateway: ['10.0.0.1'] }] });
  check('network_connectivity: addresses must look like addresses', JSON.stringify(n.adapters[0].ipv4) === '["10.0.0.5"]' && n.target.reachable === true);
  check('network_connectivity: a host with a path or scheme is refused', c.sanitizeResult('network_connectivity', { target: { host: 'https://evil/x' } }).target.host === null);

  const r = c.sanitizeResult('reboot_status', { pending: false, sources: ['windows_update', 'component_servicing', 'made_up', 'windows_update'], lastBootAt: '2026-11-01T00:00:00Z', uptimeSeconds: 3600 });
  check('reboot_status: only known sources, deduplicated and sorted', JSON.stringify(r.sources) === '["component_servicing","windows_update"]');
  check('reboot_status: pending is derived from the sources, not the agent\'s flag', r.pending === true && c.sanitizeResult('reboot_status', { pending: true, sources: [] }).pending === false);
  check('reboot_status: a 1980 boot time is dropped (bad clock)', c.sanitizeResult('reboot_status', { lastBootAt: '1980-01-01T00:00:00Z' }).lastBootAt === null);

  const dn = c.sanitizeResult('dns_resolution', { resolvers: ['10.0.0.1', '1.1.1.1', 'x y'], lookups: [{ name: 'portal.example.com', ok: true, addresses: ['203.0.113.4'], latencyMs: 12 }, { name: 'dns.msftncsi.com', ok: false, error: 'No such host' }, { name: 'third.example.com' }] });
  check('dns_resolution: two lookups at most, resolvers filtered', dn.lookups.length === 2 && JSON.stringify(dn.resolvers) === '["10.0.0.1","1.1.1.1"]');
  check('control characters are stripped', c.sanitizeResult('disk_space', { disks: [{ drive: 'C:', label: 'a\u0000b\u001bc' }] }).disks[0].label === 'a b c');
}

// ── The size cap ────────────────────────────────────────────────────────────
{
  const big = { groups: Array.from({ length: 50 }, (_, i) => ({ eventId: i, count: 1, message: 'x'.repeat(300), provider: 'p'.repeat(128) })) };
  const capped = c.capResult(big, 8_000);
  check('capResult: an oversized result is cut to fit and marked truncated', capped.bytes <= 8_000 && capped.truncated && capped.result.groups.length < 50, `${capped.bytes} bytes, ${capped.result.groups?.length} groups`);
  const small = c.capResult({ a: [1, 2, 3] });
  check('capResult: a small result is untouched', !small.truncated && small.result.a.length === 3);
  check('capResult: an unshrinkable result becomes a marker', c.capResult({ s: 'y'.repeat(10_000) }, 1_000).result.tooLarge === true);
  check('the stored cap is 32 KB and under the database backstop of 64 KB', c.MAX_RESULT_BYTES === 32_768 && /octet_length\("result"::text\) <= 65536/.test(readFileSync(join(here, '..', 'prisma', 'migrations', '0031_diagnostic_runs', 'migration.sql'), 'utf8')));
  // The newest migration that redefines the constraint (0042 added the snapshot keys).
  const mig = readFileSync(join(here, '..', 'prisma', 'migrations', '0042_system_inventory', 'migration.sql'), 'utf8');
  const dbKeys = [...(/"DiagnosticRun_key_catalog" CHECK \("key" IN \(([\s\S]*?)\)\)/.exec(mig)?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  check('the database CHECK lists exactly the catalog keys', JSON.stringify(dbKeys) === JSON.stringify(ALL_KEYS), JSON.stringify(dbKeys));
}

// ── The generated agent ─────────────────────────────────────────────────────
const signed = w.buildSignedWindowsScript('0.31.0');
const legacy = w.buildLegacyWindowsScript({ version: '1.4.1', host: 'portal.example.com', key: 'A'.repeat(43) + '=', agentVersion: '0.31.0', fallbackVersion: '1.4.1' });
const hbOf = (s) => /\$hbBody = @'\r?\n([\s\S]*?)\r?\n'@/.exec(s)[1];
const blockOf = (hb) => hb.slice(hb.indexOf('# ---- Diagnostics catalog (0.31)'), hb.indexOf('# ---- Monitoring (0.29)'));
const blk = blockOf(hbOf(signed));
{
  check('both installer variants carry the same diagnostics block', blk.length > 5000 && blk === blockOf(hbOf(legacy)));
  const sw = /switch -Exact \(\$dk\) \{([\s\S]*?)\n {12}\}/.exec(blk)?.[1] ?? '';
  const arms = [...sw.matchAll(/^\s+'([a-z_]+)' \{/gm)].map((m) => m[1]);
  check('the agent switch has exactly the catalog keys, and a default that throws', JSON.stringify(arms) === JSON.stringify(ALL_KEYS) && /default \{ throw /.test(sw), JSON.stringify(arms));
  const list = [...(/\$diagKeys = @\(([^)]*)\)/.exec(blk)?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  check('the agent refuses any key not in its own list of the catalog keys', JSON.stringify(list) === JSON.stringify(ALL_KEYS) && /if \(-not \(\$diagKeys -contains \$dk\)\)/.test(blk));
  check('the block runs no process, expression or download, and changes nothing',
    !/Invoke-Expression|\biex\b|Start-Process|Invoke-WebRequest|DownloadString|DownloadFile|Net\.WebClient|Invoke-Command|\bStart-Job\b|(Set|Stop|Start|Restart|Suspend|Remove|Clear|New)-(Service|Item|ItemProperty|EventLog)|Set-Content|Out-File|Add-Content|\bsc(\.exe)? |\bcmd(\.exe)? \/c|& \$/i.test(blk));
  check('one network post, to diagnostic-result', (blk.match(/Invoke-RestMethod/g) ?? []).length === 1 && /enrollment\/diagnostic-result/.test(blk));
  check('only with the device secret', /^if \(\$state\.agentSecret -and \$resp -and \$resp\.data -and \$resp\.data\.diagnostics\)/m.test(blk));
  check('the agent caps what it posts', /if \(\$j\.Length -gt 600000\)/.test(blk) && c.MAX_AGENT_RESULT_CHARS === 600_000);
  check('at most three runs per beat', /\$resp\.data\.diagnostics \| Select-Object -First 3/.test(blk) && c.RUNS_PER_HEARTBEAT === 3);
}

// ── PowerShell: parse, then run the block against stubs (optional) ─────────
const pwsh = process.env.PWSH || (spawnSync('pwsh', ['-v']).status === 0 ? 'pwsh' : null);
if (!pwsh || (process.env.PWSH && !existsSync(process.env.PWSH))) console.log('  (pwsh not found: the PowerShell is not parsed or executed)');
else {
  const dir = mkdtempSync(join(tmpdir(), 'rem0te-psdiag-'));
  writeFileSync(join(dir, 'signed.ps1'), signed);
  writeFileSync(join(dir, 'legacy.ps1'), legacy);
  writeFileSync(join(dir, 'hb.ps1'), hbOf(signed));
  writeFileSync(join(dir, 'parse.ps1'), `
$bad = 0
foreach ($f in $args) { $t = $null; $e = $null; [System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$t, [ref]$e) | Out-Null; if ($e.Count) { $bad++; Write-Output ("$f : " + $e[0].Message + ' @ line ' + $e[0].Extent.StartLineNumber) } }
exit $bad`);
  const pr = spawnSync(pwsh, ['-NoProfile', '-File', join(dir, 'parse.ps1'), join(dir, 'signed.ps1'), join(dir, 'legacy.ps1'), join(dir, 'hb.ps1')], { encoding: 'utf8' });
  check('pwsh: the signed and legacy installers and the heartbeat parse with no errors', pr.status === 0, pr.stdout + pr.stderr);

  const resp = { data: { monitor: { v: 1, services: ['Spooler', 'bad name;x'], events: [] }, diagnostics: [
    ...KEYS.map((k, i) => ({ id: `run${i}aaaaaaaaaaaaaaaaaaaa`, key: k })),
    { id: 'runXaaaaaaaaaaaaaaaaaaaa', key: 'run_anything' },
    { id: 'bad id; rm', key: 'disk_space' },
  ] } };
  writeFileSync(join(dir, 'resp.json'), JSON.stringify(resp));
  const posts = join(dir, 'posts.txt');
  writeFileSync(join(dir, 'run.ps1'), `
$ErrorActionPreference = 'Continue'
$id = '123456789'; $state = [pscustomobject]@{ agentSecret = 'secretsecretsecret'; host = 'portal.test' }
$resp = Get-Content -Raw '${join(dir, 'resp.json')}' | ConvertFrom-Json
function Invoke-RestMethod { param($Uri, $Method, $Body, $ContentType, [switch]$UseBasicParsing, $TimeoutSec, $ErrorAction) Add-Content -LiteralPath '${posts}' -Value ($Uri + ' ' + $Body) }
function Get-Rem0teInventory { return @{ osCaption = 'Windows 11 Pro'; osBuild = '26100'; disks = @(@{ drive = 'C:' }); networks = @(); software = @(@{ name = 'App' }) } }
function Get-Rem0tePendingUpdates { return @{ pending = @(@{ title = 'Cumulative Update (KB5000001)'; kb = 'KB5000001'; severity = 'Critical'; sizeBytes = 1000 }); rebootRequired = $true } }
function Get-CimInstance { param($ClassName, $Filter, $ErrorAction)
  switch ($ClassName) {
    'Win32_LogicalDisk' { return @([pscustomobject]@{ DeviceID = 'C:'; VolumeName = 'OS'; FileSystem = 'NTFS'; Size = 500GB; FreeSpace = 50GB }, [pscustomobject]@{ DeviceID = 'D:'; VolumeName = 'Data'; FileSystem = 'NTFS'; Size = 1TB; FreeSpace = 900GB }) }
    'Win32_NetworkAdapterConfiguration' { return @([pscustomobject]@{ Index = 1; IPAddress = @('10.0.0.5', 'fe80::1'); DefaultIPGateway = @('10.0.0.1'); DNSServerSearchOrder = @('10.0.0.1', '1.1.1.1') }) }
    'Win32_NetworkAdapter' { return @([pscustomobject]@{ Index = 1; Name = 'Intel Ethernet'; NetConnectionID = 'Ethernet'; NetConnectionStatus = 2; MACAddress = '00:11:22:33:44:55' }, [pscustomobject]@{ Index = 2; Name = 'Wi-Fi'; NetConnectionID = 'Wi-Fi'; NetConnectionStatus = 7; MACAddress = '00:11:22:33:44:66' }) }
    'Win32_OperatingSystem' { return [pscustomobject]@{ LastBootUpTime = (Get-Date).AddHours(-50) } }
  } }
function Get-Service { param($Name, $ErrorAction)
  $all = @([pscustomobject]@{ Name = 'Spooler'; DisplayName = 'Print Spooler'; Status = 'Stopped'; StartType = 'Automatic'; BinaryPathName = 'C:\\Windows\\System32\\spoolsv.exe' }, [pscustomobject]@{ Name = 'W32Time'; DisplayName = 'Windows Time'; Status = 'Running'; StartType = 'Automatic' }, [pscustomobject]@{ Name = 'gupdate'; DisplayName = 'Google Update'; Status = 'Stopped'; StartType = 'AutomaticDelayedStart' }, [pscustomobject]@{ Name = 'Fax'; DisplayName = 'Fax'; Status = 'Stopped'; StartType = 'Manual' })
  if ($Name) { return ($all | Where-Object { $_.Name -eq $Name }) } else { return $all } }
function Get-WinEvent { param($FilterHashtable, $MaxEvents, $ErrorAction)
  Add-Content -LiteralPath '${join(dir, 'filters.txt')}' -Value ($FilterHashtable | ConvertTo-Json -Compress -Depth 4)
  if ($FilterHashtable.LogName -eq 'System') { return @(
    [pscustomobject]@{ Id = 7; Level = 2; ProviderName = 'disk'; TimeCreated = (Get-Date); Message = ('The device C:\\Users\\alice\\AppData\\x had a bad block. ' + ('z' * 400)) },
    [pscustomobject]@{ Id = 7; Level = 2; ProviderName = 'disk'; TimeCreated = (Get-Date).AddHours(-3); Message = 'older' },
    [pscustomobject]@{ Id = 41; Level = 1; ProviderName = 'Microsoft-Windows-Kernel-Power'; TimeCreated = (Get-Date).AddHours(-5); Message = 'The system has rebooted without cleanly shutting down first.' }) }
  throw ([System.Management.Automation.ErrorRecord]::new([Exception]::new('none'), 'NoMatchingEventsFound,Microsoft.PowerShell.Commands.GetWinEventCommand', [System.Management.Automation.ErrorCategory]::ObjectNotFound, $null)) }
function Get-Process { param($ErrorAction) return @(
  [pscustomobject]@{ ProcessName = 'chrome'; Id = 100; CPU = 120.55; WorkingSet64 = 900MB; Path = 'C:\\Users\\alice\\chrome.exe'; CommandLine = '--token=abc' },
  [pscustomobject]@{ ProcessName = 'sqlservr'; Id = 200; CPU = 30; WorkingSet64 = 4GB },
  [pscustomobject]@{ ProcessName = 'Idle'; Id = 0; CPU = $null; WorkingSet64 = 8KB }) }
function Test-Path { param($Path) return ($Path -like '*Component Based Servicing*') }
function Get-Item { param($LiteralPath, $ErrorAction) $o = [pscustomobject]@{}; $o | Add-Member -MemberType ScriptMethod -Name GetValueNames -Value { return @('PendingFileRenameOperations', 'Other') }; return $o }
function New-Object { param($TypeName, $ComObject, $ArgumentList)
  if ($ComObject) { return [pscustomobject]@{ RebootRequired = $false } }
  if ($TypeName -eq 'System.Net.Sockets.TcpClient') {
    $t = [pscustomobject]@{}
    $t | Add-Member -MemberType ScriptMethod -Name BeginConnect -Value { param($h, $p, $a, $b) Add-Content -LiteralPath '${join(dir, 'tcp.txt')}' -Value ($h + ':' + $p); $w = [pscustomobject]@{}; $w | Add-Member -MemberType ScriptMethod -Name WaitOne -Value { param($ms) return $true }; return [pscustomobject]@{ AsyncWaitHandle = $w } }
    $t | Add-Member -MemberType ScriptMethod -Name EndConnect -Value { param($ar) }
    $t | Add-Member -MemberType ScriptMethod -Name Close -Value { }
    return $t }
  return Microsoft.PowerShell.Utility\\New-Object -TypeName $TypeName -ArgumentList $ArgumentList }
${blk}
`);
  const r = spawnSync(pwsh, ['-NoProfile', '-File', join(dir, 'run.ps1')], { encoding: 'utf8', timeout: 120_000 });
  const lines = existsSync(posts) ? readFileSync(posts, 'utf8').trim().split('\n') : [];
  const sent = lines.map((l) => { const i = l.indexOf(' '); return { uri: l.slice(0, i), body: JSON.parse(l.slice(i + 1)) }; });
  check('pwsh: the block runs and every post goes to /enrollment/diagnostic-result', r.status === 0 && sent.length > 0 && sent.every((s) => s.uri === 'https://portal.test/api/v1/enrollment/diagnostic-result'), r.stderr || JSON.stringify(sent.map((s) => s.uri)));
  check('pwsh: every post carries the device secret', sent.every((s) => s.body.agentSecret === 'secretsecretsecret' && s.body.rustdeskId === '123456789'));
  const of = (k, st) => sent.find((s) => s.body.key === k && s.body.state === st);
  check('pwsh: only the first three runs are taken from one heartbeat', sent.filter((s) => s.body.state === 'running').length === 3, JSON.stringify(sent.map((s) => `${s.body.key}:${s.body.state}`)));
  // The rest are exercised three at a time, the way successive beats would hand them out.
  const results = {};
  for (let i = 0; i < KEYS.length + 2; i += 3) {
    const slice = [...KEYS.map((k, j) => ({ id: `run${j}aaaaaaaaaaaaaaaaaaaa`, key: k })), { id: 'runXaaaaaaaaaaaaaaaaaaaa', key: 'run_anything' }, { id: 'bad id; rm', key: 'disk_space' }].slice(i, i + 3);
    writeFileSync(join(dir, 'resp.json'), JSON.stringify({ data: { ...resp.data, diagnostics: slice } }));
    rmSync(posts, { force: true });
    const rr = spawnSync(pwsh, ['-NoProfile', '-File', join(dir, 'run.ps1')], { encoding: 'utf8', timeout: 120_000 });
    if (rr.status !== 0) failures.push(`pwsh batch ${i}: ${rr.stderr}`);
    const ls = existsSync(posts) ? readFileSync(posts, 'utf8').trim().split('\n').filter(Boolean) : [];
    for (const l of ls) { const b = JSON.parse(l.slice(l.indexOf(' ') + 1)); (results[b.runId] ??= []).push(b); }
  }
  for (const [j, k] of KEYS.entries()) {
    const seq = results[`run${j}aaaaaaaaaaaaaaaaaaaa`] ?? [];
    check(`pwsh: ${k} reports running, then completed`, seq.length === 2 && seq[0].state === 'running' && seq[1].state === 'completed' && seq[1].key === k, JSON.stringify(seq).slice(0, 400));
  }
  check('pwsh: an unknown key is refused by the agent and reported failed, nothing run', JSON.stringify((results.runXaaaaaaaaaaaaaaaaaaaa ?? []).map((b) => b.state)) === '["failed"]' && results.runXaaaaaaaaaaaaaaaaaaaa[0].key === 'unknown');
  check('pwsh: a malformed run id is ignored entirely', !results['bad id; rm']);
  const res = (k) => (results[`run${KEYS.indexOf(k)}aaaaaaaaaaaaaaaaaaaa`] ?? []).find((b) => b.state === 'completed')?.result ?? {};
  const all = JSON.stringify(results);
  check('pwsh: no command line, binary path or user path in any result', !/--token|spoolsv|BinaryPathName|alice/.test(all), all.match(/.{40}(--token|spoolsv|alice).{20}/)?.[0]);
  const ds = res('disk_space'); check('pwsh: disk_space lists both volumes', ds.disks?.length === 2 && ds.disks[0].drive === 'C:');
  const sh = res('service_health');
  check('pwsh: service_health lists stopped automatic (and delayed) services, not manual ones', JSON.stringify(sh.stoppedAutomatic?.map((s) => s.name)) === '["Spooler","gupdate"]' && sh.totalServices === 4, JSON.stringify(sh));
  check('pwsh: service_health reads monitored services, skipping a name failing the charset', JSON.stringify(sh.monitored?.map((s) => s.name)) === '["Spooler"]');
  const er = res('recent_system_errors');
  const g7 = er.groups?.find((g) => g.eventId === 7);
  check('pwsh: recent_system_errors groups by source and id with a count', er.scanned === 3 && er.groups.length === 2 && g7?.count === 2 && new Date(g7.firstAt) < new Date(g7.lastAt), JSON.stringify(er).slice(0, 300));
  check('pwsh: the newest message is kept, one line, 300 characters, profile path replaced', g7?.message.length === 300 && g7.message.includes('%USERPROFILE%') && !g7.message.includes('\n'));
  const filters = readFileSync(join(dir, 'filters.txt'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  check('pwsh: only System and Application are read, Critical and Error only', filters.every((f) => ['System', 'Application'].includes(f.LogName) && JSON.stringify(f.Level) === '[1,2]'), JSON.stringify(filters));
  const tp = res('top_processes');
  check('pwsh: top_processes ranks by CPU and by memory, names only', tp.byCpu?.[0]?.name === 'chrome' && tp.byMemory?.[0]?.name === 'sqlservr' && tp.processCount === 3 && Object.keys(tp.byCpu[0]).sort().join() === 'cpuSeconds,name,pid,workingSetBytes', JSON.stringify(tp).slice(0, 300));
  const nc = res('network_connectivity');
  check('pwsh: network_connectivity dials only this agent\'s server on 443', readFileSync(join(dir, 'tcp.txt'), 'utf8').trim() === 'portal.test:443' && nc.target?.reachable === true && nc.target.port === 443, JSON.stringify(nc.target));
  check('pwsh: adapters report up/down and addresses', nc.adapters?.length === 2 && nc.adapters[0].up === true && nc.adapters[1].up === false && nc.adapters[1].status === 'Media disconnected' && JSON.stringify(nc.adapters[0].ipv4) === '["10.0.0.5"]');
  const dn = res('dns_resolution');
  check('pwsh: dns_resolution asks exactly the server name and dns.msftncsi.com, with resolvers', JSON.stringify(dn.lookups?.map((l) => l.name)) === '["portal.test","dns.msftncsi.com"]' && JSON.stringify(dn.resolvers) === '["10.0.0.1","1.1.1.1"]' && dn.lookups.every((l) => typeof l.latencyMs === 'number'), JSON.stringify(dn));
  const rb = res('reboot_status');
  check('pwsh: reboot_status names the signals present', JSON.stringify(rb.sources) === '["component_servicing","pending_file_rename"]' && rb.pending === true && rb.uptimeSeconds > 170000, JSON.stringify(rb));
  check('pwsh: pending_updates and refresh_inventory reuse the existing collections', res('pending_updates').updates?.pending?.[0]?.kb === 'KB5000001' && res('refresh_inventory').inventory?.osBuild === '26100');
  // Round trip: what the agent sent survives the server's sanitizer.
  for (const k of ['disk_space', 'service_health', 'recent_system_errors', 'top_processes', 'network_connectivity', 'dns_resolution', 'reboot_status']) {
    const s = c.sanitizeResult(k, res(k));
    check(`pwsh → server: ${k} survives sanitising and fits the cap`, !!s && c.capResult(s).truncated === false, JSON.stringify(s).slice(0, 200));
  }
  rmSync(dir, { recursive: true, force: true });
}

console.log(`unit-diagnostics-catalog: ${passed} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1); }
