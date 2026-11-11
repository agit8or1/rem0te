#!/usr/bin/env node
// Tests for the 0.33 system-inventory snapshots — process list, full service
// list and network adapter details — run against dist:
//
//   cd apps/api && npx nest build && node scripts/unit-system-inventory.mjs
//
// Pure parts: the three catalog entries, their sanitizers (hostile input,
// redaction, charsets), row and byte bounds, and the build-time guard on the
// heartbeat's snapshot block (each refusal proven by mutating the script).
// With pwsh available (on PATH, or PWSH=/path/to/pwsh) it also parses both
// installer variants and the heartbeat with PowerShell's own parser, and runs
// the diagnostics block for the three keys against stub cmdlets, checking
// every post it would make and that the result survives the server side.
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
const SNAP = ['process_list', 'service_list', 'network_adapters'];
const bytes = (v) => Buffer.byteLength(JSON.stringify(v), 'utf8');

// ── The catalog entries ─────────────────────────────────────────────────────
{
  check('the three snapshot keys are catalog keys, last, in order', JSON.stringify(c.DIAGNOSTIC_KEYS.slice(-3)) === JSON.stringify(SNAP) && SNAP.every((k) => c.isCatalogKey(k)));
  check('SNAPSHOT_KEYS is exactly those three', JSON.stringify(c.SNAPSHOT_KEYS) === JSON.stringify(SNAP));
  const tabs = Object.fromEntries(SNAP.map((k) => [k, c.catalogEntry(k).tab]));
  check('each names its workspace tab', JSON.stringify(tabs) === '{"process_list":"processes","service_list":"services","network_adapters":"network"}', JSON.stringify(tabs));
  check('no other entry has a tab', c.CATALOG.filter((e) => e.tab).length === 3);
  for (const k of SNAP) {
    const e = c.catalogEntry(k);
    check(`${k}: read-only, no impact, no approvals, Windows, seconds`, e.risk === 'read_only' && e.expectedImpact === 'none' && e.approvals === 'none (read-only)' && JSON.stringify(e.supportedOs) === '["windows"]' && e.duration === 'seconds');
    check(`${k}: needs computers:view, with a reason`, e.capability === 'computers:view' && e.capabilityReason.length > 20);
  }
  for (const k of ['top_processes', 'service_health', 'process_list ', 'Process_List', '__proto__', null, ['process_list']]) check(`isSnapshotKey refuses ${JSON.stringify(k)}`, !c.isSnapshotKey(k));
  check('snapshots get the 128 KB cap, everything else keeps 32 KB', SNAP.every((k) => c.resultCapFor(k) === 131_072) && c.resultCapFor('top_processes') === 32_768 && c.resultCapFor('nope') === 32_768);
  check('row bounds: 1000 processes, 1000 services, 32 adapters', JSON.stringify(c.SNAPSHOT_ROWS) === '{"process_list":1000,"service_list":1000,"network_adapters":32}');
  const mig = readFileSync(join(here, '..', 'prisma', 'migrations', '0042_system_inventory', 'migration.sql'), 'utf8');
  check('the database backstop is 256 KB for snapshots and 64 KB for the rest',
    /octet_length\("result"::text\) <= \(CASE WHEN "key" IN \('process_list', 'service_list', 'network_adapters'\) THEN 262144 ELSE 65536 END\)/.test(mig));
  check('the snapshot cap sits well under its backstop (jsonb text adds spacing)', c.MAX_SNAPSHOT_BYTES * 2 === 262144);
}

// ── process_list ────────────────────────────────────────────────────────────
{
  const tok = 'Z'.repeat(48);
  const raw = {
    processCount: 3, userNamesRead: true,
    processes: [
      { name: 'chrome', pid: 100, cpuSeconds: 12.34, workingSetBytes: 9e8, user: 'CORP\\alice', startedAt: '2026-11-11T08:00:00Z', commandLine: '--token=hunter2', path: 'C:\\Program Files\\chrome.exe' },
      { name: 'C:\\Users\\eve\\evil.exe', pid: 200, user: 'eve;whoami', startedAt: '1970-01-01T00:00:00Z' },
      { name: `svc${tok}`, pid: 300, user: 'NT AUTHORITY\\SYSTEM', startedAt: 'not a date' },
      { name: 'x\u0000y\u001b', pid: -5, cpuSeconds: 'NaN', workingSetBytes: -1 },
      { pid: 7 },
      'not an object',
    ],
    environment: { PATH: 'C:\\x' },
  };
  const p = c.sanitizeResult('process_list', raw);
  const all = JSON.stringify(p);
  check('process_list: no command line, path or environment survives', !/hunter2|Program Files|environment|commandLine|"path"/.test(all), all.slice(0, 300));
  check('process_list: a row is exactly name, pid, cpu, memory, user, start', Object.keys(p.processes[0]).sort().join() === 'cpuSeconds,name,pid,startedAt,user,workingSetBytes', Object.keys(p.processes[0]).join());
  check('process_list: a path in the name is cut to the file name and the profile redacted', p.processes[1].name === 'evil.exe');
  check('process_list: a user failing the account charset is dropped, a real one kept', p.processes[1].user === null && p.processes[0].user === 'CORP\\alice' && p.processes[2].user === 'NT AUTHORITY\\SYSTEM');
  check('process_list: long tokens in a name are redacted', p.processes[2].name.includes('[redacted]') && !all.includes(tok));
  check('process_list: control characters stripped, bad numbers nulled', p.processes[3].name === 'x y' && p.processes[3].pid === null && p.processes[3].cpuSeconds === null && p.processes[3].workingSetBytes === null, JSON.stringify(p.processes[3]));
  check('process_list: a 1970 or unparseable start time is dropped', p.processes[1].startedAt === null && p.processes[2].startedAt === null && p.processes[0].startedAt === '2026-11-11T08:00:00.000Z');
  check('process_list: rows without a name are dropped', p.processes.length === 4);
  check('process_list: userNamesRead defaults to false', c.sanitizeResult('process_list', {}).userNamesRead === false && p.userNamesRead === true);
  const many = c.sanitizeResult('process_list', { processes: Array.from({ length: 1500 }, (_, i) => ({ name: `proc${i}`, pid: i, cpuSeconds: i, workingSetBytes: i * 1000, user: 'NT AUTHORITY\\SYSTEM', startedAt: '2026-11-11T08:00:00Z' })) });
  check('process_list: at most 1000 rows', many.processes.length === 1000);
  const capped = c.capResult(many, c.resultCapFor('process_list'));
  check('process_list: 1000 full rows are cut to the 128 KB cap and marked truncated', capped.bytes <= 131_072 && capped.truncated && capped.result.processes.length < 1000 && capped.result.processes.length >= 400, `${capped.bytes} bytes, ${capped.result.processes.length} rows`);
  const typical = c.sanitizeResult('process_list', { processes: many.processes.slice(0, 300) });
  check('process_list: a typical 300-process machine fits untruncated', !c.capResult(typical, c.resultCapFor('process_list')).truncated, String(bytes(typical)));
}

// ── service_list ────────────────────────────────────────────────────────────
{
  const s = c.sanitizeResult('service_list', {
    serviceCount: 5,
    services: [
      { name: 'Spooler', displayName: 'Print Spooler', state: 'Running', startMode: 'Automatic', account: 'LocalSystem', pathName: 'C:\\Windows\\System32\\spoolsv.exe' },
      { name: 'bad;name', displayName: 'x', state: 'Running' },
      { name: 'MSSQL$SQLEXPRESS', displayName: 'SQL Server (C:\\Users\\dba\\x)', state: 'Exploded', startMode: 'Whenever', account: 'CORP\\svc-sql' },
      { name: 'evil', account: 'a"b' },
      { name: 'gupdate', state: 'Stopped', startMode: 'AutomaticDelayedStart', account: 'NT AUTHORITY\\LocalService' },
    ],
    binaryPaths: ['C:\\x'],
  });
  const all = JSON.stringify(s);
  check('service_list: no binary path or extra field', !/spoolsv|pathName|binaryPaths/.test(all));
  check('service_list: a name failing the service charset is dropped ($ allowed)', s.services.length === 4 && !s.services.some((v) => v.name === 'bad;name') && s.services[1].name === 'MSSQL$SQLEXPRESS');
  check('service_list: states and start modes are from a fixed list', s.services[1].state === 'Unknown' && s.services[1].startMode === 'Unknown' && s.services[3].startMode === 'AutomaticDelayedStart');
  check('service_list: an account failing its charset is dropped, real ones kept', s.services[2].account === null && s.services[0].account === 'LocalSystem' && s.services[1].account === 'CORP\\svc-sql');
  check('service_list: profile paths in a display name are redacted', s.services[1].displayName.includes('%USERPROFILE%') && !all.includes('dba'));
  check('service_list: at most 1000 rows', c.sanitizeResult('service_list', { services: Array.from({ length: 1200 }, (_, i) => ({ name: `s${i}` })) }).services.length === 1000);
  const big = c.sanitizeResult('service_list', { services: Array.from({ length: 1000 }, (_, i) => ({ name: `Service${'ab.'.repeat(20)}${i}`, displayName: 'D'.repeat(256), state: 'Running', startMode: 'Manual', account: 'NT AUTHORITY\\LocalService' })) });
  const capped = c.capResult(big, c.resultCapFor('service_list'));
  check('service_list: an oversized list is cut to 128 KB and marked truncated', capped.bytes <= 131_072 && capped.truncated, `${capped.bytes}`);
}

// ── network_adapters ────────────────────────────────────────────────────────
{
  const n = c.sanitizeResult('network_adapters', {
    adapters: [
      { name: 'Intel Ethernet', connectionId: 'Ethernet', status: 'Connected', up: true, mac: '00-11-22-aa-bb-cc', speedBps: 1e9, ipv4: ['10.0.0.5', 'x; rm'], ipv6: ['fe80::1%12'], gateway: ['10.0.0.1'], dnsServers: ['10.0.0.1', '1.1.1.1', '<script>'], dnsSuffix: 'corp.example.com', dhcpEnabled: true, dhcpServer: '10.0.0.1', dhcpLeaseObtainedAt: '2026-11-11T00:00:00Z', dhcpLeaseExpiresAt: '2026-11-12T00:00:00Z', password: 'x' },
      { name: 'Wi-Fi', mac: 'not a mac', speedBps: 2 ** 63, dnsSuffix: 'bad suffix/x', dhcpServer: 'evil host', dhcpEnabled: 'yes' },
      { connectionId: 'no name' },
    ],
  });
  const a = n.adapters[0], b = n.adapters[1];
  check('network_adapters: rows without a name are dropped', n.adapters.length === 2);
  check('network_adapters: MAC normalised to colons, upper case; a non-MAC dropped', a.mac === '00:11:22:AA:BB:CC' && b.mac === null);
  check('network_adapters: addresses must look like addresses', JSON.stringify(a.ipv4) === '["10.0.0.5"]' && JSON.stringify(a.dnsServers) === '["10.0.0.1","1.1.1.1"]' && JSON.stringify(a.ipv6) === '["fe80::1%12"]');
  check('network_adapters: a bogus "unknown" speed (Int64 max) is dropped', a.speedBps === 1e9 && b.speedBps === null);
  check('network_adapters: DNS suffix and DHCP server checked against charsets', a.dnsSuffix === 'corp.example.com' && b.dnsSuffix === null && a.dhcpServer === '10.0.0.1' && b.dhcpServer === null);
  check('network_adapters: DHCP flag is a boolean or nothing', a.dhcpEnabled === true && b.dhcpEnabled === null);
  check('network_adapters: lease times kept as ISO', a.dhcpLeaseObtainedAt === '2026-11-11T00:00:00.000Z' && a.dhcpLeaseExpiresAt === '2026-11-12T00:00:00.000Z');
  check('network_adapters: no unknown field', !('password' in a));
  check('network_adapters: at most 32 adapters, 16 addresses each', c.sanitizeResult('network_adapters', { adapters: Array.from({ length: 40 }, (_, i) => ({ name: `a${i}`, ipv4: Array.from({ length: 30 }, (_, j) => `10.0.${i}.${j}`) })) }).adapters.every((x, _, arr) => arr.length === 32 && x.ipv4.length === 16));
}

// ── The build-time guard on the snapshot block ──────────────────────────────
const signed = w.buildSignedWindowsScript('0.33.0');
const legacy = w.buildLegacyWindowsScript({ version: '1.4.1', host: 'portal.example.com', key: 'A'.repeat(43) + '=', agentVersion: '0.33.0', fallbackVersion: '1.4.1' });
const hbOf = (s) => /\$hbBody = @'\r?\n([\s\S]*?)\r?\n'@/.exec(s)[1];
const diagOf = (hb) => hb.slice(hb.indexOf('# ---- Diagnostics catalog (0.31)'), hb.indexOf('# ---- Monitoring (0.29)'));
const snapOf = (hb) => hb.slice(hb.indexOf(w.SNAPSHOT_BLOCK_START), hb.indexOf('if ($state.agentSecret -and $resp -and $resp.data -and $resp.data.diagnostics) {'));
{
  const snap = snapOf(hbOf(signed));
  check('both installer variants carry the same snapshot block', snap.length > 4000 && snap === snapOf(hbOf(legacy)));
  check('the guard passes the shipped script', w.assertSnapshotBlockSafe(signed) === signed);
  const refuses = (label, from, to) => {
    if (!signed.includes(from)) { failures.push(`guard mutation "${label}": anchor not found`); return; }
    let threw = null;
    try { w.assertSnapshotBlockSafe(signed.replace(from, to)); } catch (e) { threw = String(e.message); }
    check(`the guard refuses ${label}`, !!threw, 'it accepted the mutated script');
  };
  refuses('Invoke-Expression', '$withUser = $true', '$withUser = $true; Invoke-Expression $x');
  refuses('a Stop-Service', '$all = @(Get-CimInstance Win32_Service -ErrorAction Stop)', '$all = @(Get-CimInstance Win32_Service -ErrorAction Stop); Stop-Service Spooler');
  refuses('a non-Get cmdlet (Restart-Computer)', '$withUser = $true', '$withUser = $true; Restart-Computer');
  refuses('the call operator', '$withUser = $true', "$withUser = $true; & 'sc.exe' stop x");
  refuses('reading the service binary path', 'account = $acct }', 'account = $acct; bin = (Get-Rem0teSnapText $s.PathName 200) }');
  refuses('reading a process command line', 'startedAt = $st }', 'startedAt = $st; cmd = (Get-Rem0teSnapText $pr.CommandLine 200) }');
  refuses('reading a process path', 'startedAt = $st }', 'startedAt = $st; p = (Get-Rem0teSnapText $pr.Path 200) }');
  refuses('a field that skips the charset helpers', 'displayName = (Get-Rem0teSnapText $s.DisplayName 256)', 'displayName = [string]$s.DisplayName');
  refuses('a variable fed from an unchecked string', '$acct = Get-Rem0teSnapMatch $s.StartName', '$acct = [string]$s.StartName; $zz = Get-Rem0teSnapMatch $s.StartName');
  refuses('Get-Rem0teSnapText without the control-character strip', "-replace '[\\x00-\\x1f\\x7f]', ' '", "-replace 'q', ' '");
  refuses('Get-Rem0teSnapMatch that keeps a failing value', 'if ($null -eq $t -or $t -notmatch $re) { return $null }', 'if ($null -eq $t) { return $null }');
  refuses('an environment read', '$withUser = $true', '$withUser = $true; $q = $env:PATH');
  refuses('a missing block', w.SNAPSHOT_BLOCK_START, '# gone');
  check('the snapshot functions are dispatched only through the catalog switch', /'process_list' \{ \$out = Get-Rem0teSnapProcesses \}/.test(diagOf(hbOf(signed))) && /'service_list' \{ \$out = Get-Rem0teSnapServices \}/.test(diagOf(hbOf(signed))) && /'network_adapters' \{ \$out = Get-Rem0teSnapNetwork \}/.test(diagOf(hbOf(signed))));
  check('the agent bounds its own rows: 1000 processes, 1000 services, 32 adapters', /Select-Object -First 1000\)\) \{\s*# A name/.test(snap) && /Sort-Object -Property Name \| Select-Object -First 1000/.test(snap) && /if \(\$ads\.Count -ge 32\) \{ break \}/.test(snap));
}

// ── PowerShell: parse, then run the three keys against stubs (optional) ─────
const pwsh = process.env.PWSH || (spawnSync('pwsh', ['-v']).status === 0 ? 'pwsh' : null);
if (!pwsh || (process.env.PWSH && !existsSync(process.env.PWSH))) console.log('  (pwsh not found: the PowerShell is not parsed or executed)');
else {
  const dir = mkdtempSync(join(tmpdir(), 'rem0te-pssnap-'));
  writeFileSync(join(dir, 'signed.ps1'), signed);
  writeFileSync(join(dir, 'legacy.ps1'), legacy);
  writeFileSync(join(dir, 'hb.ps1'), hbOf(signed));
  writeFileSync(join(dir, 'parse.ps1'), `
$bad = 0
foreach ($f in $args) { $t = $null; $e = $null; [System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$t, [ref]$e) | Out-Null; if ($e.Count) { $bad++; Write-Output ("$f : " + $e[0].Message + ' @ line ' + $e[0].Extent.StartLineNumber) } }
exit $bad`);
  const pr = spawnSync(pwsh, ['-NoProfile', '-File', join(dir, 'parse.ps1'), join(dir, 'signed.ps1'), join(dir, 'legacy.ps1'), join(dir, 'hb.ps1')], { encoding: 'utf8' });
  check('pwsh: the signed and legacy installers and the heartbeat parse with no errors (ParseFile)', pr.status === 0, pr.stdout + pr.stderr);

  const posts = join(dir, 'posts.txt');
  const calls = join(dir, 'calls.txt');
  const runOnce = (elevated, nProcs) => {
    writeFileSync(join(dir, 'resp.json'), JSON.stringify({ data: { diagnostics: [
      { id: 'runPaaaaaaaaaaaaaaaaaaaa', key: 'process_list' },
      { id: 'runSaaaaaaaaaaaaaaaaaaaa', key: 'service_list' },
      { id: 'runNaaaaaaaaaaaaaaaaaaaa', key: 'network_adapters' },
    ] } }));
    rmSync(posts, { force: true }); rmSync(calls, { force: true });
    writeFileSync(join(dir, 'run.ps1'), `
$ErrorActionPreference = 'Continue'
$id = '123456789'; $state = [pscustomobject]@{ agentSecret = 'secretsecretsecret'; host = 'portal.test' }
$resp = Get-Content -Raw '${join(dir, 'resp.json')}' | ConvertFrom-Json
$elevated = $${elevated ? 'true' : 'false'}
function Invoke-RestMethod { param($Uri, $Method, $Body, $ContentType, [switch]$UseBasicParsing, $TimeoutSec, $ErrorAction) Add-Content -LiteralPath '${posts}' -Value ($Uri + ' ' + $Body) }
function Get-Process { param($Name, [switch]$IncludeUserName, $ErrorAction)
  Add-Content -LiteralPath '${calls}' -Value ('Get-Process IncludeUserName=' + [string][bool]$IncludeUserName)
  if ($IncludeUserName -and -not $elevated) { throw 'The IncludeUserName parameter requires elevated user rights.' }
  $list = @(
    [pscustomobject]@{ ProcessName = 'chrome'; Id = 100; CPU = 120.55; WorkingSet64 = 900MB; UserName = 'CORP\\alice'; StartTime = (Get-Date).AddHours(-2); Path = 'C:\\Users\\alice\\chrome.exe'; CommandLine = '--token=abc' },
    [pscustomobject]@{ ProcessName = 'sqlservr'; Id = 200; CPU = 30; WorkingSet64 = 4GB; UserName = 'NT SERVICE\\MSSQLSERVER'; StartTime = (Get-Date).AddDays(-3) },
    [pscustomobject]@{ ProcessName = 'C:\\evil\\x'; Id = 300; CPU = 1; WorkingSet64 = 1MB; UserName = 'x' },
    [pscustomobject]@{ ProcessName = 'weird'; Id = 400; CPU = 1; WorkingSet64 = 2MB; UserName = 'bob;whoami'; StartTime = (Get-Date) })
  $idle = [pscustomobject]@{ ProcessName = 'Idle'; Id = 0; CPU = $null; WorkingSet64 = 8KB; UserName = $null }
  $idle | Add-Member -MemberType ScriptProperty -Name StartTime -Value { throw 'Access is denied' }
  $list += $idle
  for ($i = 0; $i -lt ${nProcs}; $i++) { $list += [pscustomobject]@{ ProcessName = ('filler' + $i); Id = 1000 + $i; CPU = 0.1; WorkingSet64 = 4KB + $i; UserName = 'NT AUTHORITY\\SYSTEM'; StartTime = (Get-Date) } }
  return $list }
function Get-CimInstance { param($ClassName, $Filter, $ErrorAction, $Property)
  Add-Content -LiteralPath '${calls}' -Value ('Get-CimInstance ' + $ClassName)
  switch ($ClassName) {
    'Win32_Service' { return @(
      [pscustomobject]@{ Name = 'Spooler'; DisplayName = 'Print Spooler'; State = 'Running'; StartMode = 'Auto'; StartName = 'LocalSystem'; DelayedAutoStart = $false; PathName = 'C:\\Windows\\System32\\spoolsv.exe --secret hunter2' },
      [pscustomobject]@{ Name = 'gupdate'; DisplayName = 'Google Update'; State = 'Stopped'; StartMode = 'Auto'; StartName = 'LocalSystem'; DelayedAutoStart = $true },
      [pscustomobject]@{ Name = 'MSSQL$SQLEXPRESS'; DisplayName = "SQL Server\`tExpress"; State = 'Start Pending'; StartMode = 'Manual'; StartName = 'CORP\\svc-sql' },
      [pscustomobject]@{ Name = 'bad;name'; DisplayName = 'x'; State = 'Running'; StartMode = 'Auto'; StartName = 'LocalSystem' },
      [pscustomobject]@{ Name = 'Fax'; DisplayName = 'Fax'; State = 'Stopped'; StartMode = 'Disabled'; StartName = 'a"b' }) }
    'Win32_NetworkAdapterConfiguration' { return @(
      [pscustomobject]@{ Index = 1; IPAddress = @('10.0.0.5', 'fe80::1%12', 'not an ip; rm'); DefaultIPGateway = @('10.0.0.1'); DNSServerSearchOrder = @('10.0.0.1', '1.1.1.1'); DHCPEnabled = $true; DHCPServer = '10.0.0.1'; DHCPLeaseObtained = (Get-Date).AddHours(-4); DHCPLeaseExpires = (Get-Date).AddHours(20); DNSDomain = 'corp.example.com' },
      [pscustomobject]@{ Index = 2; IPAddress = $null; DHCPEnabled = $false; DNSDomain = 'bad domain/x' }) }
    'Win32_NetworkAdapter' { return @(
      [pscustomobject]@{ Index = 1; Name = 'Intel Ethernet'; NetConnectionID = 'Ethernet'; NetConnectionStatus = 2; MACAddress = '00:11:22:33:44:55'; Speed = 1000000000 },
      [pscustomobject]@{ Index = 2; Name = 'Wi-Fi'; NetConnectionID = 'Wi-Fi'; NetConnectionStatus = 7; MACAddress = 'zz'; Speed = 9223372036854775807 },
      [pscustomobject]@{ Index = 3; Name = 'WAN Miniport (IP)'; NetConnectionID = $null; NetConnectionStatus = $null; MACAddress = $null }) }
  } }
${diagOf(hbOf(signed))}
`);
    const r = spawnSync(pwsh, ['-NoProfile', '-File', join(dir, 'run.ps1')], { encoding: 'utf8', timeout: 180_000 });
    const lines = existsSync(posts) ? readFileSync(posts, 'utf8').trim().split('\n').filter(Boolean) : [];
    const sent = lines.map((l) => { const i = l.indexOf(' '); return { uri: l.slice(0, i), size: l.length - i - 1, body: JSON.parse(l.slice(i + 1)) }; });
    const cl = existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [];
    return { r, sent, calls: cl, res: (k) => sent.find((s) => s.body.key === k && s.body.state === 'completed')?.body.result ?? {} };
  };

  const a = runOnce(true, 20);
  check('pwsh: the block runs and every post goes to /enrollment/diagnostic-result with the device secret', a.r.status === 0 && a.sent.length === 6 && a.sent.every((s) => s.uri === 'https://portal.test/api/v1/enrollment/diagnostic-result' && s.body.agentSecret === 'secretsecretsecret'), a.r.stderr || JSON.stringify(a.sent.map((s) => `${s.body.key}:${s.body.state}`)));
  for (const k of SNAP) check(`pwsh: ${k} reports running, then completed`, JSON.stringify(a.sent.filter((s) => s.body.key === k).map((s) => s.body.state)) === '["running","completed"]', JSON.stringify(a.sent.filter((s) => s.body.key === k).map((s) => s.body.error ?? s.body.state)));
  check('pwsh: only Get-Process and Get-CimInstance (Win32_Service, Win32_NetworkAdapter[Configuration]) are called', a.calls.every((l) => /^Get-Process IncludeUserName=True$|^Get-CimInstance (Win32_Service|Win32_NetworkAdapter|Win32_NetworkAdapterConfiguration)$/.test(l)), JSON.stringify(a.calls));
  const all = JSON.stringify(a.sent);
  check('pwsh: no command line, binary path or executable path in any result', !/--token|--secret|hunter2|spoolsv|chrome\.exe|PathName|CommandLine/.test(all), all.match(/.{30}(--token|hunter2|spoolsv|chrome\.exe).{20}/)?.[0]);
  const p = a.res('process_list');
  check('pwsh: process_list is sorted by memory, names only, a path-shaped name dropped', p.processes?.[0]?.name === 'sqlservr' && p.processes[1].name === 'chrome' && !p.processes.some((x) => /evil/.test(x.name)) && p.processCount === 25, JSON.stringify(p).slice(0, 300));
  check('pwsh: process_list reads the user, drops one failing the charset', p.userNamesRead === true && p.processes[0].user === 'NT SERVICE\\MSSQLSERVER' && p.processes.find((x) => x.name === 'weird')?.user === null);
  check('pwsh: process_list keeps start times, and a protected process (StartTime throws) has none', typeof p.processes[0].startedAt === 'string' && p.processes.find((x) => x.name === 'Idle')?.startedAt === null && p.processes.find((x) => x.name === 'Idle')?.cpuSeconds === null);
  const s = a.res('service_list');
  check('pwsh: service_list lists every service but the one failing the name charset', s.serviceCount === 5 && JSON.stringify(s.services?.map((x) => x.name)) === '["Fax","gupdate","MSSQL$SQLEXPRESS","Spooler"]', JSON.stringify(s).slice(0, 400));
  const sv = Object.fromEntries((s.services ?? []).map((x) => [x.name, x]));
  check('pwsh: start mode Auto → Automatic, delayed → AutomaticDelayedStart', sv.Spooler?.startMode === 'Automatic' && sv.gupdate?.startMode === 'AutomaticDelayedStart' && sv.Fax?.startMode === 'Disabled');
  check('pwsh: "Start Pending" → StartPending; accounts read, a bad one dropped', sv.MSSQL$SQLEXPRESS?.state === 'StartPending' && sv.MSSQL$SQLEXPRESS.account === 'CORP\\svc-sql' && sv.Fax.account === null && sv.Spooler.account === 'LocalSystem');
  check('pwsh: control characters in a display name are replaced', sv.MSSQL$SQLEXPRESS?.displayName === 'SQL Server Express');
  const n = a.res('network_adapters');
  check('pwsh: network_adapters lists the connections with a name, not WAN miniports', JSON.stringify(n.adapters?.map((x) => x.connectionId)) === '["Ethernet","Wi-Fi"]', JSON.stringify(n).slice(0, 300));
  const e0 = n.adapters?.[0] ?? {}, e1 = n.adapters?.[1] ?? {};
  check('pwsh: addresses split v4/v6, a non-address dropped, gateway and DNS servers', JSON.stringify(e0.ipv4) === '["10.0.0.5"]' && JSON.stringify(e0.ipv6) === '["fe80::1%12"]' && JSON.stringify(e0.gateway) === '["10.0.0.1"]' && JSON.stringify(e0.dnsServers) === '["10.0.0.1","1.1.1.1"]', JSON.stringify(e0));
  check('pwsh: DHCP server and lease read when DHCP is on, suffix checked', e0.dhcpEnabled === true && e0.dhcpServer === '10.0.0.1' && typeof e0.dhcpLeaseExpiresAt === 'string' && e0.dnsSuffix === 'corp.example.com' && e1.dnsSuffix === null && e1.dhcpEnabled === false && e1.dhcpServer === null);
  check('pwsh: status, up and speed; a MAC failing its charset dropped', e0.status === 'Connected' && e0.up === true && e0.speedBps === 1e9 && e1.status === 'Media disconnected' && e1.up === false && e0.mac === '00:11:22:33:44:55' && e1.mac === null);
  for (const k of SNAP) {
    const san = c.sanitizeResult(k, a.res(k));
    const cap = san && c.capResult(san, c.resultCapFor(k));
    check(`pwsh → server: ${k} survives sanitising and fits its cap`, !!cap && !cap.truncated, JSON.stringify(san).slice(0, 200));
  }
  const pe = c.sanitizeResult('network_adapters', n);
  check('pwsh → server: the "unknown" Wi-Fi speed is dropped server side', pe.adapters[1].speedBps === null && pe.adapters[0].mac === '00:11:22:33:44:55');

  const b = runOnce(false, 0);
  const pb = b.res('process_list');
  check('pwsh: without elevation the list is still taken, with userNamesRead false and no users', b.r.status === 0 && pb.userNamesRead === false && pb.processes?.length === 4 && pb.processes.every((x) => x.user === null) && b.calls.includes('Get-Process IncludeUserName=False'), b.r.stderr || JSON.stringify(pb).slice(0, 200));

  const big = runOnce(true, 1500);
  const pbig = big.res('process_list');
  // The agent takes the 1000 largest, then drops the one whose name fails the charset.
  check('pwsh: 1505 processes → the agent sends the 1000 largest (less one bad name)', pbig.processCount === 1505 && pbig.processes?.length === 999 && pbig.processes[0].name === 'sqlservr', `${pbig.processCount} / ${pbig.processes?.length}`);
  const bigPost = big.sent.find((s) => s.body.key === 'process_list' && s.body.state === 'completed');
  check('pwsh: the 1000-row post stays under the agent\'s 600000-character cap', !!bigPost && bigPost.size < 600_000, String(bigPost?.size));
  const sbig = c.capResult(c.sanitizeResult('process_list', pbig), c.resultCapFor('process_list'));
  check('pwsh → server: 1000 rows are stored within 128 KB (truncated if they must be)', sbig.bytes <= 131_072, `${sbig.bytes} bytes, ${sbig.result.processes?.length} rows, truncated ${sbig.truncated}`);
  rmSync(dir, { recursive: true, force: true });
}

console.log(`unit-system-inventory: ${passed} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1); }
