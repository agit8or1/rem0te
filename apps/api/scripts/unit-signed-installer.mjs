#!/usr/bin/env node
// Tests for the two Windows installer variants (src/public/windows-script.ts),
// run against the compiled dist.
//
//   node apps/api/scripts/unit-signed-installer.mjs
//
// Static checks always run. When PowerShell is available (`pwsh` on PATH, as
// on GitHub's ubuntu runners, or PWSH=/path/to/pwsh) it also parses both
// variants and the heartbeat each one writes, and *executes* the signed
// variant's parameter block against hostile parameter files — the part of the
// script that stands between a portal-supplied value and an elevated shell.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { buildLegacyWindowsScript, buildSignedWindowsScript } = require(join(here, '..', 'dist', 'public', 'windows-script.js'));

let passed = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

const KEY = 'OeVuKk5nlHiXp+APNn0Y3pC1Iwpwn44JGqrQCsWqmBw=';
const legacy = buildLegacyWindowsScript({
  version: '1.4.6', host: 'remote.example.com', key: KEY, enrollToken: '0123456789abcdef0123456789abcdef',
  clientSha256: 'a'.repeat(64), updateNonce: 'nonce_ABCDEFGH12345678', agentVersion: '0.24.0', fallbackVersion: '1.4.6',
});
const signed = buildSignedWindowsScript('0.24.0');

// ── 0.37.3: the start-up cleanup keeps the agent's staging and heartbeat.ps1 ─
// The signed agent stages install.ps1, params.json and the verified RustDesk
// build in $STATEDIR\setup\signed. The cleanup used to remove all of setup
// (and heartbeat.ps1), so every migration failed at step 1 with the build gone
// and left the heartbeat task running a missing file.
const CLEAN_START = "# setup\\signed is rem0te-agent's locked staging directory";
const cleanupOf = (script) => {
  const i = script.indexOf(CLEAN_START);
  if (i < 0) return '';
  const j = script.indexOf('\n\n', i);
  return script.slice(i, j < 0 ? undefined : j);
};
for (const [label, script] of [['legacy', legacy], ['signed', signed]]) {
  const head = script.slice(0, script.indexOf('Rem0te installer starting'));
  check(`${label}: the start-up cleanup never removes heartbeat.ps1 or the whole setup directory`,
    !/Remove-Item[^\n]*heartbeat\.ps1/.test(head) && !/@\('heartbeat\.ps1', 'setup'\)/.test(head) && !/Remove-Item -LiteralPath \$SETUP_DIR/.test(head));
  check(`${label}: the cleanup clears setup's children except signed`,
    /Get-ChildItem -LiteralPath \$SETUP_DIR -Force -ErrorAction SilentlyContinue \|\s*Where-Object \{ \$_\.Name -ne 'signed' \} \|\s*Remove-Item -Recurse/.test(cleanupOf(script)));
}

// ── static: what the signed variant must never contain ─────────────────────
for (const [re, what] of [
  [/\biex\b/i, 'iex'],
  [/Invoke-Expression/i, 'Invoke-Expression'],
  [/Invoke-WebRequest/i, 'a download (Invoke-WebRequest)'],
  [/github\.com\/rustdesk/i, 'a GitHub download URL'],
  [/remote\.example\.com/, 'a portal-chosen host'],
  [/0123456789abcdef0123456789abcdef/, 'a claim token'],
]) check(`signed variant contains no ${what}`, !re.test(signed));
check('signed variant starts with a mandatory param block',
  /^(#[^\n]*\n|\s*\n)*param\(\[Parameter\(Mandatory = \$true\)\]\[string\]\$ParamsFile\)/.test(signed));
for (const f of ['host', 'key', 'claimToken', 'rustdeskVersion', 'rustdeskSha256', 'rustdeskExe', 'updateNonce'])
  check(`signed variant validates parameter ${f}`, new RegExp(`Need '${f}' \\$P\\.${f} '`).test(signed));
check('signed heartbeat runs rem0te-agent.exe update', /& \$agentExe @aargs/.test(signed));
check('signed heartbeat reports updateChannel=signed', signed.includes("$body['updateChannel'] = 'signed'"));
check('signed variant pins the agent version literally', signed.includes("$AGENT_VERSION = '0.24.0'"));
// The digest is mandatory in the signed variant, so the Authenticode-only
// branch (any trusted signer) can never be the one that accepts the build.
check('signed variant makes the RustDesk digest mandatory', /\$RD_SHA256\s+= Need 'rustdeskSha256'/.test(signed));
check('legacy variant still carries its update hook (documented, contained by trust mode)', /irm '\$iu' \| iex/.test(legacy));
check('legacy heartbeat reports updateChannel=legacy', legacy.includes("$body['updateChannel'] = 'legacy'"));
// ±140: the signed variant also carries the approved-action hook (0.26),
// the patch posture and scan hook (0.27) and the periodic self-check (0.36,
// 14 lines; the legacy variant has a one-line comment in its place).
check('both variants share the body (same line count ±140)', Math.abs(legacy.split('\n').length - signed.split('\n').length) < 140);
// Approved actions (0.26): the signed heartbeat hands envelopes to the signed
// agent and nothing else; the legacy heartbeat never runs one.
check('signed heartbeat hands envelopes to rem0te-agent.exe action, detached',
  /\$aargs = @\('action', '--job', \$jid, '--envelope', \$ef\)/.test(signed) && /Start-Process -FilePath \$agentExe -ArgumentList \$aargs -WindowStyle Hidden/.test(signed));
// 0.34: a script run's content is handed over as a file of base64, never on the
// command line, and only when it is base64 and bounded; the agent hashes it.
check('signed heartbeat hands a script run\'s content over as a bounded base64 file, never as an argument',
  /if \(\$sc -and \$sc\.Length -le 100000 -and \$sc -cmatch '\^\[A-Za-z0-9\+\/\]\+=\{0,2\}\$'\) \{\s*\$sf = Join-Path \$inbox "\$jid\.script"\s*Set-Content -LiteralPath \$sf -Value \$sc -Encoding ASCII -NoNewline\s*\$aargs \+= @\('--script', \$sf\)/.test(signed)
    && !/--script', \$sc/.test(signed) && !legacy.includes('--script'));
check('signed heartbeat reports patch posture and runs only patch-scan when asked', signed.includes("$body['patchPosture'] = $po") && /\$resp\.data\.patchScan -eq \$true[\s\S]{0,600}-ArgumentList @\('patch-scan'\)/.test(signed));
check('legacy heartbeat neither reports posture nor scans', !legacy.includes('patchPosture') && !legacy.includes('patch-scan'));
check('signed heartbeat validates the job id before using it in a path', signed.includes("$jid -cnotmatch '^[0-9a-f]{32}$'"));
check('signed heartbeat reports agentActions and agentSha256', signed.includes("$body['agentActions']") && signed.includes("$body['agentSha256']"));
check('signed heartbeat reports actionResults and deletes acknowledged ones', signed.includes("$body['actionResults']") && signed.includes('$resp.data.actionAcks'));
check('heartbeat body serialises nested results (ConvertTo-Json -Depth 6)', /\$body = \$body \| ConvertTo-Json -Compress -Depth 6/.test(signed));
check('legacy heartbeat has no action hook', !/agentExe action/.test(legacy) && !legacy.includes("$body['agentActions']"));
check('the action hook runs nothing but the agent (no iex, no script block from the response)', !/\$resp\.data\.actions[^\n]*(iex|Invoke-Expression|ScriptBlock|& \$aj)/i.test(signed));
check('signed build is deterministic', buildSignedWindowsScript('0.24.0') === signed);
let threw = false;
try { buildSignedWindowsScript("0.24.0'; calc") } catch { threw = true }
check('signed build refuses a hostile version literal', threw);
threw = false;
try { buildLegacyWindowsScript({ version: '1.4.6', host: "x';calc;'", key: KEY, agentVersion: '0.24.0', fallbackVersion: '1.4.6' }) } catch { threw = true }
check('legacy build refuses a hostile host', threw);

// ── PowerShell: parse and execute the parameter block ──────────────────────
const pwsh = process.env.PWSH || (spawnSync('pwsh', ['-v']).status === 0 ? 'pwsh' : null);
if (!pwsh) {
  console.log('  (pwsh not found: parse and parameter-execution checks skipped)');
} else {
  const dir = mkdtempSync(join(tmpdir(), 'rem0te-installer-'));
  const files = { legacy: join(dir, 'legacy.ps1'), signed: join(dir, 'signed.ps1') };
  writeFileSync(files.legacy, legacy);
  writeFileSync(files.signed, signed);
  const hb = (txt) => (txt.match(/\$hbBody = @'\r?\n([\s\S]*?)\r?\n'@/) || [])[1] ?? '';
  writeFileSync(join(dir, 'hb-legacy.ps1'), hb(legacy));
  writeFileSync(join(dir, 'hb-signed.ps1'), hb(signed));
  const parser = join(dir, 'parse.ps1');
  writeFileSync(parser, `$bad = 0
foreach ($f in $args) { $t=$null; $e=$null
  [System.Management.Automation.Language.Parser]::ParseFile($f,[ref]$t,[ref]$e) | Out-Null
  if ($e.Count) { $bad++; Write-Output ("PARSE " + $f + ": " + $e[0].Message + " @" + $e[0].Extent.StartLineNumber) } }
exit $bad`);
  const pr = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-File', parser, files.legacy, files.signed, join(dir, 'hb-legacy.ps1'), join(dir, 'hb-signed.ps1')], { encoding: 'utf8' });
  check('legacy, signed and both heartbeats parse', pr.status === 0, pr.stdout + pr.stderr);
  check('heartbeat bodies were found', hb(legacy).length > 1000 && hb(signed).length > 1000);

  // Windows PowerShell 5.1 (what the agent runs, by -File) reads a BOM-less
  // script as the ANSI code page, not UTF-8. On 2026-11-13 the first real
  // migration exited 1 before running a line: an em dash's 0x94 byte became
  // U+201D, a closing quote to PowerShell. PowerShell 7 reads UTF-8 whatever
  // the BOM, so the parse above could never see it. Read the built file as
  // 5.1 would: UTF-8 after a BOM, Windows-1252 without one.
  const built = join(dir, 'install.ps1');
  const b = spawnSync(process.execPath, [join(here, 'build-signed-installer.mjs'), '--out', built], { encoding: 'utf8', cwd: join(here, '..') });
  check('build-signed-installer.mjs writes install.ps1', b.status === 0, b.stdout + b.stderr);
  const raw = readFileSync(built);
  check('the signed install.ps1 starts with a UTF-8 byte-order mark', raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf);
  const ps51 = join(dir, 'ps51.ps1');
  writeFileSync(ps51, `param([string]$Path, [switch]$StripBom)
[System.Text.Encoding]::RegisterProvider([System.Text.CodePagesEncodingProvider]::Instance)
$bytes = [IO.File]::ReadAllBytes($Path)
if ($StripBom -and $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) { $bytes = $bytes[3..($bytes.Length - 1)] }
$hasBom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
$text = if ($hasBom) { [Text.UTF8Encoding]::new($false).GetString($bytes, 3, $bytes.Length - 3) } else { [Text.Encoding]::GetEncoding(1252).GetString($bytes) }
$t = $null; $e = $null
[System.Management.Automation.Language.Parser]::ParseInput($text, [ref]$t, [ref]$e) | Out-Null
Write-Output ("ERRORS " + $e.Count)
if ($e.Count) { Write-Output ($e[0].Message + " @" + $e[0].Extent.StartLineNumber) }
`);
  const p51 = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-File', ps51, '-Path', built], { encoding: 'utf8' });
  check('install.ps1 parses as Windows PowerShell 5.1 reads it (UTF-8 after the BOM)', /^ERRORS 0$/m.test(p51.stdout), p51.stdout + p51.stderr);
  const noBom = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-File', ps51, '-Path', built, '-StripBom'], { encoding: 'utf8' });
  check('without the BOM it would not parse under 5.1 (so this check can fail)', /^ERRORS [1-9]/m.test(noBom.stdout), noBom.stdout + noBom.stderr);

  // Harness: the signed script up to the end of its parameter block, then
  // print what it accepted. Nothing after the block runs.
  const end = signed.indexOf("$UPDATE_CHANNEL = 'signed'") + "$UPDATE_CHANNEL = 'signed'".length;
  const harness = join(dir, 'harness.ps1');
  writeFileSync(harness, signed.slice(0, end) + '\nWrite-Output ("ACCEPTED|" + $REM0TE_HOST + "|" + $VERSION + "|" + $RD_LOCAL + "|" + $CLAIM_TOKEN)\nexit 0\n');
  const good = {
    schema: 'rem0te-install-params/1', mode: 'install', host: 'relay.example.com', key: KEY,
    claimToken: '0123456789abcdef0123456789abcdef', rustdeskVersion: '1.4.6', rustdeskSha256: 'b'.repeat(64),
    rustdeskExe: 'C:\\ProgramData\\Rem0te\\setup\\signed\\rustdesk-1.4.6-x86_64.exe', updateNonce: '',
  };
  const run = (params) => {
    const pf = join(dir, `p-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(pf, typeof params === 'string' ? params : JSON.stringify(params));
    return spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-File', harness, '-ParamsFile', pf], { encoding: 'utf8' });
  };
  const ok = run(good);
  check('valid parameters are accepted', ok.status === 0 && ok.stdout.includes('ACCEPTED|relay.example.com|1.4.6|C:\\ProgramData\\Rem0te\\setup\\signed\\rustdesk-1.4.6-x86_64.exe|0123456789abcdef0123456789abcdef'), ok.stdout + ok.stderr);
  const hostile = {
    'host with a quote': { host: "relay.example.com';calc;'" },
    'host with a subexpression': { host: '$(calc).example.com' },
    'key with a space': { key: 'AAAA AAAAAAAAAAAAAAAAAAAA' },
    'version with a command': { rustdeskVersion: '1.4.6;calc' },
    'digest not hex': { rustdeskSha256: 'z'.repeat(64) },
    'digest missing': { rustdeskSha256: '' },
    'exe path with a quote': { rustdeskExe: "C:\\x'.exe" },
    'exe path with $()': { rustdeskExe: 'C:\\$(calc).exe' },
    'exe path not a .exe': { rustdeskExe: 'C:\\ProgramData\\Rem0te\\setup\\signed\\x.ps1' },
    'exe path UNC': { rustdeskExe: '\\\\attacker\\share\\rustdesk.exe' },
    'claim token not hex': { claimToken: 'zzzzzzzzzzzzzzzzzzzz' },
    'nonce with a quote': { updateNonce: "nonce_ABCDEFGH1234'567" },
    'wrong schema': { schema: 'rem0te-install-params/2' },
    'schema case-folded': { schema: 'REM0TE-INSTALL-PARAMS/1' },
  };
  for (const [name, patch] of Object.entries(hostile)) {
    const r = run({ ...good, ...patch });
    check(`refused: ${name}`, r.status === 64 && !r.stdout.includes('ACCEPTED'), `exit ${r.status} ${r.stdout.trim()}`);
  }
  const notJson = run('this is not json');
  check('refused: parameters file is not JSON', notJson.status === 64, `exit ${notJson.status}`);

  // Execute the cleanup block itself against a state directory laid out the
  // way the signed agent leaves it.
  const st = mkdtempSync(join(tmpdir(), 'rem0te-cleanup-'));
  const setup = join(st, 'setup');
  execFileSync('mkdir', ['-p', join(setup, 'signed'), join(setup, 'old-dir')]);
  writeFileSync(join(setup, 'signed', 'rustdesk-1.5.3-x86_64.exe'), 'verified');
  writeFileSync(join(setup, 'signed', 'install.ps1'), 'script');
  writeFileSync(join(setup, 'rustdesk-1.4.6.exe'), 'stale');
  writeFileSync(join(setup, 'old-dir', 'x'), 'stale');
  writeFileSync(join(st, 'heartbeat.ps1'), 'old heartbeat');
  const block = cleanupOf(signed);
  const cl = join(dir, 'cleanup.ps1');
  writeFileSync(cl, `$STATEDIR = '${st}'\n$SETUP_DIR = '${setup}'\n${block}\n`);
  const cr = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-File', cl], { encoding: 'utf8' });
  const exists = (f) => spawnSync('test', ['-e', f]).status === 0;
  check('pwsh: the cleanup keeps setup/signed and the verified RustDesk build in it',
    cr.status === 0 && exists(join(setup, 'signed', 'rustdesk-1.5.3-x86_64.exe')) && exists(join(setup, 'signed', 'install.ps1')), `exit ${cr.status} ${cr.stderr}`);
  check('pwsh: the cleanup removes everything else under setup', !exists(join(setup, 'rustdesk-1.4.6.exe')) && !exists(join(setup, 'old-dir')));
  check('pwsh: the cleanup leaves heartbeat.ps1 for the rewrite to replace', exists(join(st, 'heartbeat.ps1')));
}

if (failures.length) {
  console.error(`✗ ${failures.length} failed, ${passed} passed`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log(`✓ ${passed} signed-installer checks passed`);
