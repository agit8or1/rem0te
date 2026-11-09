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
check('both variants share the body (same line count ±40)', Math.abs(legacy.split('\n').length - signed.split('\n').length) < 40);
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
}

if (failures.length) {
  console.error(`✗ ${failures.length} failed, ${passed} passed`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log(`✓ ${passed} signed-installer checks passed`);
