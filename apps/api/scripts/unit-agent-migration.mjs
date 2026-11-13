#!/usr/bin/env node
// Unit tests for the per-computer agent upgrade (0.34), against dist with no
// database:
//
//   - migrationBlock(): every precondition refuses with its own code, in the
//     order a person would fix them, and the mode boundary — Signed only
//     without portal migration refuses; Legacy allowed and Signed only +
//     portal migration allow;
//   - migrationState(): pending → dispatched → downloaded → completed, held
//     while a hold is newer than the last dispatch, not confirmed two hours
//     after it was handed out, cancelled;
//   - buildMigrationScript(): refuses a bad digest or host, downloads by the
//     digest, checks it before running migrate, and stages in a fresh
//     directory; MIGRATION_UNAVAILABLE runs nothing; nonces have one shape;
//   - with PWSH (or pwsh on PATH): the migration script parses, and the
//     heartbeat's agent-status block runs against fixture files and reports
//     only a well-formed time and a printable, capped result.
//
// Build first: pnpm --filter @reboot-remote/api build
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const M = require(join(here, '..', 'dist', 'update-trust', 'agent-migration.js'));
const W = require(join(here, '..', 'dist', 'public', 'windows-script.js'));

let pass = 0, fail = 0;
const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

const SHA = 'a'.repeat(64);
const ok = {
  platform: 'Windows', updateChannel: 'legacy', status: 'ACTIVE', hasSecret: true, repoConfigured: true, signedAgentPublished: true,
  portalHost: 'remote.example.com', mode: 'legacy_allowed', legacyPortalMigration: false, updatesPause: null, inRollout: false,
};
const code = (f) => M.migrationBlock({ ...ok, ...f })?.code ?? null;

section('Preconditions');
check(code({}) === null, 'a standard Windows agent with a secret, a signed agent published, Legacy allowed: allowed');
check(code({ updateChannel: null }) === null, 'a channel never reported counts as standard');
check(code({ platform: 'linux' }) === 'LINUX_AGENT_READ_ONLY', 'Linux: LINUX_AGENT_READ_ONLY');
check(code({ platform: 'macOS' }) === 'MACOS_AGENT_READ_ONLY' && code({ platform: 'darwin' }) === 'MACOS_AGENT_READ_ONLY', 'macOS (any name): MACOS_AGENT_READ_ONLY');
check(code({ platform: null }) === 'NOT_WINDOWS' && code({ platform: 'FreeBSD' }) === 'NOT_WINDOWS', 'not Windows, or never reported: NOT_WINDOWS');
check(code({ updateChannel: 'signed' }) === 'ALREADY_SIGNED', 'signed: ALREADY_SIGNED');
check(code({ status: 'ARCHIVED' }) === 'ARCHIVED', 'archived: ARCHIVED');
check(code({ hasSecret: false }) === 'NO_DEVICE_SECRET', 'no device secret: NO_DEVICE_SECRET');
{
  const b = M.migrationBlock({ ...ok, repoConfigured: false });
  check(b?.code === 'NO_SIGNED_RELEASE' && /^No signed release is published/.test(b.reason) && b.fix.includes('sudo ./deploy/release/rem0te-signed-setup.sh') && b.link?.href === '/endpoints/full-agent',
    'no repository: "No signed release is published …", the setup command, linked to the Full agent page', JSON.stringify(b));
  const c = M.migrationBlock({ ...ok, signedAgentPublished: false });
  check(c?.code === 'NO_SIGNED_RELEASE' && /windows\/rem0te-agent\.exe/.test(c.reason) && c.fix.includes('sudo rem0te-signed-publish') && c.link?.href === '/endpoints/full-agent', 'a repository without the agent: the same code, naming the target and the publish command');
}
check(code({ portalHost: null }) === 'NO_PORTAL_ADDRESS', 'no portal address: NO_PORTAL_ADDRESS');
check(code({ mode: 'signed_only', legacyPortalMigration: false }) === 'SIGNED_ONLY', 'Signed only: SIGNED_ONLY (a per-computer request must not reopen what the mode closed)');
check(code({ mode: 'signed_only', legacyPortalMigration: true }) === null, 'Signed only + portal migration: allowed (every legacy agent is already handed this script)');
check(code({ mode: 'legacy_allowed', legacyPortalMigration: true }) === null, 'Legacy allowed: allowed');
check(code({ updatesPause: 'A global write pause is in effect' }) === 'CONTAINED' && M.migrationBlock({ ...ok, updatesPause: 'X: reason' }).reason === 'X: reason', 'an updates pause: CONTAINED, with the pause message');
check(code({ inRollout: true }) === 'IN_ROLLOUT', 'a rollout in progress: IN_ROLLOUT');
check(code({ platform: 'linux', hasSecret: false, repoConfigured: false }) === 'LINUX_AGENT_READ_ONLY', 'the first unmet precondition wins (platform before secret before repository)');
check(code({ hasSecret: false, mode: 'signed_only' }) === 'NO_DEVICE_SECRET' && code({ repoConfigured: false, mode: 'signed_only' }) === 'NO_SIGNED_RELEASE', 'what is missing is named before the mode');

section('States');
{
  const now = Date.now();
  const at = (msAgo) => new Date(now - msAgo);
  const base = { requestedAt: at(60_000), dispatchedAt: null, lastDispatchedAt: null, fetchedAt: null, holdReason: null, holdAt: null, completedAt: null, cancelledAt: null };
  const st = (r) => M.migrationState({ ...base, ...r }, now).state;
  check(st({}) === 'pending', 'not handed out yet: pending');
  check(st({ dispatchedAt: at(30_000), lastDispatchedAt: at(30_000) }) === 'dispatched', 'handed out: dispatched');
  check(st({ dispatchedAt: at(30_000), lastDispatchedAt: at(30_000), fetchedAt: at(20_000) }) === 'downloaded', 'script fetched: downloaded');
  check(st({ holdReason: 'contained', holdAt: at(10_000) }) === 'held', 'held before any dispatch: held');
  check(st({ dispatchedAt: at(60_000), lastDispatchedAt: at(30_000), holdReason: 'signed_only', holdAt: at(10_000) }) === 'held', 'a hold newer than the last dispatch: held');
  check(st({ dispatchedAt: at(60_000), lastDispatchedAt: at(10_000), holdReason: 'signed_only', holdAt: at(30_000) }) === 'dispatched', 'a dispatch newer than the hold: dispatched');
  check(st({ dispatchedAt: at(3 * 3600_000), lastDispatchedAt: at(3 * 3600_000) }) === 'not_confirmed', 'handed out 3 h ago, still standard: not confirmed');
  check(st({ dispatchedAt: at(3 * 3600_000), lastDispatchedAt: at(3 * 3600_000), fetchedAt: at(60_000) }) === 'downloaded', 'a fresh download resets the clock');
  check(st({ dispatchedAt: at(3 * 3600_000), lastDispatchedAt: at(3 * 3600_000), completedAt: at(60_000) }) === 'completed', 'completed wins');
  check(st({ cancelledAt: at(60_000) }) === 'cancelled', 'cancelled');
  check(/Signed only/.test(M.migrationState({ ...base, holdReason: 'signed_only', holdAt: at(1000) }, now).text), 'a hold says why');
}

section('The migration script');
{
  const s = M.buildMigrationScript('remote.example.com', SHA);
  check(s.includes(`https://remote.example.com/api/v1/public/updates/targets/windows/${SHA}.rem0te-agent.exe`), 'downloads the target by its digest (consistent-snapshot name)');
  check(s.indexOf(`-ne '${SHA}'`) > 0 && s.indexOf(`-ne '${SHA}'`) < s.indexOf('& $exe migrate'), 'checks the digest before it runs migrate');
  check(s.includes("& $exe migrate --portal 'remote.example.com'") && s.trimEnd().endsWith('exit $LASTEXITCODE'), 'runs migrate against the portal and returns its exit code');
  check(s.includes("('Rem0te-migrate-' + [guid]::NewGuid().ToString('N'))") && !/-Force -Path \$dir/.test(s), 'stages in a fresh, unpredictable directory (no -Force onto an existing one)');
  check(!/Rem0tesetup|C:Users/.test(s), 'no Windows path lost its separator');
  check(M.buildMigrationScript('remote.example.com:8443', SHA).includes("--portal 'remote.example.com:8443'"), 'host:port is accepted');
  for (const [h, d, why] of [["x';calc;'", SHA, 'a hostile host'], ['a..b', SHA, 'a dotted-dot host'], ['h:0', SHA, 'port 0'], ['remote.example.com', 'A'.repeat(64), 'an upper-case digest'], ['remote.example.com', 'a'.repeat(63), 'a short digest'], ['remote.example.com', `${SHA}'`, 'a quote in the digest']]) {
    let threw = false; try { M.buildMigrationScript(h, d); } catch { threw = true; }
    check(threw, `refuses ${why}`);
  }
  check(!/Invoke-|iex|Start-|&\s*\$|http/.test(M.MIGRATION_UNAVAILABLE) && /exit 1/.test(M.MIGRATION_UNAVAILABLE), 'MIGRATION_UNAVAILABLE runs nothing');
  const n = M.newMigrationNonce();
  check(M.MIGRATION_NONCE_RE.test(n) && n !== M.newMigrationNonce(), 'nonces: mig_ + 40 base64url, fresh each time', n);
  check(/^[A-Za-z0-9_-]{16,64}$/.test(n), 'a nonce fits the heartbeat\'s own nonce charset (the agent appends it to the URL)');
}

const pwsh = process.env.PWSH || (spawnSync('pwsh', ['-v']).status === 0 ? 'pwsh' : null);
section('PowerShell');
if (!pwsh) {
  console.log('  (pwsh not found: parse and execution checks skipped)');
} else {
  const dir = mkdtempSync(join(tmpdir(), 'rem0te-agentmig-'));
  const mf = join(dir, 'migrate.ps1');
  writeFileSync(mf, M.buildMigrationScript('remote.example.com', SHA));
  const parser = join(dir, 'parse.ps1');
  writeFileSync(parser, `$t=$null; $e=$null
[System.Management.Automation.Language.Parser]::ParseFile($args[0],[ref]$t,[ref]$e) | Out-Null
if ($e.Count) { Write-Output ($e[0].Message + " @" + $e[0].Extent.StartLineNumber); exit 1 }`);
  const pr = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-File', parser, mf], { encoding: 'utf8' });
  check(pr.status === 0, 'the migration script parses', pr.stdout + pr.stderr);

  // The heartbeat's agent-status block, cut out of the real generated script,
  // pointed at a fixture file, and run.
  const KEY = 'A'.repeat(43) + '=';
  for (const [variant, text] of [['legacy', W.buildLegacyWindowsScript({ version: '1.4.6', host: 'relay.example.com', key: KEY, agentVersion: '0.34.0', fallbackVersion: '1.4.6' })], ['signed', W.buildSignedWindowsScript('0.34.0')]]) {
    const hb = (text.match(/\$hbBody = @'\r?\n([\s\S]*?)\r?\n'@/) || [])[1] ?? '';
    const start = hb.indexOf("# The agent's own last update check (0.34)");
    const end = hb.indexOf('} catch {}', start) + '} catch {}'.length;
    const block = start > 0 ? hb.slice(start, end) : '';
    check(block.length > 300 && block.includes("'C:\\ProgramData\\Rem0te\\agent-status.json'"), `${variant}: the heartbeat reads agent-status.json`, block.slice(0, 200));
    const cases = [
      ['go', { channel: 'signed', lastCheck: '2026-11-11T10:00:00.123456789Z', lastResult: 'installer exit 0' }, (o) => o.agentUpdateCheckedAt === '2026-11-11T10:00:00.123456789Z' && o.agentUpdateResult === 'installer exit 0'],
      // eslint-disable-next-line no-control-regex -- control characters are what this checks for
      ['controls', { lastCheck: '2026-11-11T10:00:00Z', lastResult: 'bad\u001b[31m\u0007 ' + 'x'.repeat(400) }, (o) => o.agentUpdateResult.length === 300 && !/[\x00-\x1f]/.test(o.agentUpdateResult)],
      ['nodate', { lastResult: 'x' }, (o) => !('agentUpdateCheckedAt' in o)],
      ['junkdate', { lastCheck: "2026-01-01'; calc", lastResult: 'x' }, (o) => !('agentUpdateCheckedAt' in o)],
    ];
    for (const [name, fixture, want] of cases) {
      const fx = join(dir, `${variant}-${name}.json`);
      writeFileSync(fx, JSON.stringify(fixture));
      const run = join(dir, `${variant}-${name}.ps1`);
      writeFileSync(run, `$body = @{}\n${block.replace("'C:\\ProgramData\\Rem0te\\agent-status.json'", `'${fx}'`)}\n$body | ConvertTo-Json -Compress`);
      const r = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-File', run], { encoding: 'utf8' });
      let o = {}; try { o = JSON.parse(r.stdout.trim() || '{}'); } catch { /* reported below */ }
      check(r.status === 0 && want(o), `${variant}: ${name}`, r.stdout + r.stderr);
    }
    const missing = join(dir, `${variant}-missing.ps1`);
    writeFileSync(missing, `$body = @{}\n${block.replace("'C:\\ProgramData\\Rem0te\\agent-status.json'", `'${join(dir, 'nope.json')}'`)}\n$body | ConvertTo-Json -Compress`);
    const r = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-File', missing], { encoding: 'utf8' });
    check(r.status === 0 && r.stdout.trim() === '{}', `${variant}: no status file, nothing reported`, r.stdout + r.stderr);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
console.log(`✓ ${pass} agent-migration checks passed`);
