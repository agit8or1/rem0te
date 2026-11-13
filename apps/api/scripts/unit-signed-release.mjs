#!/usr/bin/env node
/**
 * Unit: the helpers behind deploy/release/ (0.37) — no Go, no database.
 *
 *   - rustdesk-asset.mjs: a RustDesk release needs a published SHA-256, and
 *     the download URL must be RustDesk's own GitHub release asset (or, for a
 *     loopback test API, that same loopback server);
 *   - repo-info.mjs: what it reports from unverified metadata is charset-
 *     checked, and prune-list keeps every file the newest two targets
 *     versions list and nothing else;
 *   - portal-pin.mjs: no DATABASE_URL, or not a postgres one, reads nothing;
 *   - lib.sh's ver_lt orders versions numerically, not as text.
 *
 *   node apps/api/scripts/unit-signed-release.mjs
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const R = path.resolve(here, '..', '..', '..', 'deploy', 'release');
let pass = 0, fail = 0;
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}\n      ${d}`); } };
const work = mkdtempSync(path.join(tmpdir(), 'rem0te-unit-release-'));
const node = (script, args) => spawnSync(process.execPath, [path.join(R, script), ...args], { encoding: 'utf8' });
const json = (name, v) => { const f = path.join(work, name); writeFileSync(f, JSON.stringify(v)); return f; };
const SHA = 'a'.repeat(64);
const GH = 'https://api.github.com/repos/rustdesk/rustdesk/releases';

try {
  console.log('rustdesk-asset.mjs');
  const rel = (asset) => json('rel.json', { tag_name: '1.4.9', assets: [{ name: 'rustdesk-1.4.9-x86_64.exe', digest: `sha256:${SHA}`, browser_download_url: 'https://github.com/rustdesk/rustdesk/releases/download/1.4.9/rustdesk-1.4.9-x86_64.exe', ...asset }] });
  let r = node('rustdesk-asset.mjs', ['asset', rel({}), '1.4.9', GH]);
  check(r.status === 0 && r.stdout.includes(`SHA256=${SHA}`) && r.stdout.includes('URL=https://github.com/rustdesk/rustdesk/releases/download/1.4.9/rustdesk-1.4.9-x86_64.exe'), 'GitHub asset with a digest: accepted', r.stderr);
  r = node('rustdesk-asset.mjs', ['asset', rel({ digest: undefined }), '1.4.9', GH]);
  check(r.status !== 0 && /no SHA-256 digest/.test(r.stderr), 'no published digest: refused', r.stdout);
  r = node('rustdesk-asset.mjs', ['asset', rel({ digest: 'sha1:abc' }), '1.4.9', GH]);
  check(r.status !== 0, 'a digest that is not sha256: refused');
  r = node('rustdesk-asset.mjs', ['asset', rel({ browser_download_url: 'https://evil.example.com/rustdesk-1.4.9-x86_64.exe' }), '1.4.9', GH]);
  check(r.status !== 0 && /unexpected download URL/.test(r.stderr), 'a download URL off RustDesk\'s GitHub release: refused');
  r = node('rustdesk-asset.mjs', ['asset', rel({ browser_download_url: 'https://github.com/rustdesk/rustdesk/releases/download/1.4.8/rustdesk-1.4.9-x86_64.exe' }), '1.4.9', GH]);
  check(r.status !== 0, 'another release\'s path: refused');
  r = node('rustdesk-asset.mjs', ['asset', rel({ browser_download_url: 'http://127.0.0.1:3902/download/x.exe' }), '1.4.9', 'http://127.0.0.1:3902/repos/rustdesk/rustdesk/releases']);
  check(r.status === 0, 'a loopback test API: its own server\'s URL accepted', r.stderr);
  r = node('rustdesk-asset.mjs', ['asset', rel({ browser_download_url: 'http://127.0.0.1:3999/download/x.exe' }), '1.4.9', 'http://127.0.0.1:3902/repos/rustdesk/rustdesk/releases']);
  check(r.status !== 0, 'a loopback test API: another port refused');
  r = node('rustdesk-asset.mjs', ['asset', rel({ browser_download_url: 'https://api.example.com/rustdesk-1.4.9-x86_64.exe' }), '1.4.9', 'https://api.example.com/']);
  check(r.status !== 0, 'a non-loopback API base cannot vouch for its own download URL: only GitHub\'s exact asset URL is accepted');
  r = node('rustdesk-asset.mjs', ['tag', json('t.json', { tag_name: 'v1.4.9' })]);
  check(r.status === 0 && r.stdout.trim() === 'VERSION=1.4.9', 'tag: a leading v is dropped');
  r = node('rustdesk-asset.mjs', ['tag', json('t.json', { tag_name: '1.4.9-rc1' })]);
  check(r.status !== 0, 'tag: anything but x.y.z refused');

  console.log('repo-info.mjs');
  const repo = path.join(work, 'repo');
  mkdirSync(path.join(repo, 'metadata'), { recursive: true });
  mkdirSync(path.join(repo, 'targets/windows/rustdesk'), { recursive: true });
  const meta = (f, signed) => writeFileSync(path.join(repo, 'metadata', f), JSON.stringify({ signed, signatures: [] }));
  const far = new Date(Date.now() + 7 * 86400_000).toISOString();
  const tgt = (sha, custom) => ({ length: 1, hashes: { sha256: sha }, ...(custom ? { custom } : {}) });
  const s = (c) => c.repeat(64);
  meta('root.json', { version: 1, expires: far, roles: {} });
  meta('timestamp.json', { version: 9, expires: far, meta: { 'snapshot.json': { version: 5 } } });
  meta('5.snapshot.json', { version: 5, expires: far, meta: { 'targets.json': { version: 3 } } });
  meta('3.targets.json', { version: 3, expires: far, targets: {
    'windows/rem0te-agent.exe': tgt(s('3'), { version: '1.2.3; rm -rf /', commit: 'nothex' }),
    'windows/rustdesk/rustdesk-1.4.9-x86_64.exe': tgt(s('b'), { version: '1.4.9' }),
  } });
  meta('2.targets.json', { version: 2, expires: far, targets: { 'windows/rem0te-agent.exe': tgt(s('2')) } });
  meta('1.targets.json', { version: 1, expires: far, targets: { 'windows/rem0te-agent.exe': tgt(s('1')) } });
  for (const f of [`windows/${s('3')}.rem0te-agent.exe`, `windows/${s('2')}.rem0te-agent.exe`, `windows/${s('1')}.rem0te-agent.exe`, `windows/rustdesk/${s('b')}.rustdesk-1.4.9-x86_64.exe`, `windows/${s('3')}.rem0te-agent.exe.tmp`]) {
    writeFileSync(path.join(repo, 'targets', f), 'x');
  }
  r = node('repo-info.mjs', [repo, 'summary']);
  const kv = Object.fromEntries(r.stdout.trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  check(kv.CONFIGURED === '1' && kv.TIMESTAMP_VERSION === '9' && kv.TARGETS_VERSION === '3' && kv.RUSTDESK_VERSIONS === '1.4.9', 'summary follows timestamp → snapshot → targets', r.stdout);
  check(kv.AGENT_VERSION === '' && kv.AGENT_COMMIT === '' && kv.AGENT_SHA256 === s('3'), 'a version or commit outside its charset is reported as empty, never passed to the shell', JSON.stringify(kv));
  check(Number(kv.TIMESTAMP_LEFT_H) >= 167 && Number(kv.TIMESTAMP_LEFT_H) <= 168, 'hours left computed from expires', kv.TIMESTAMP_LEFT_H);
  r = node('repo-info.mjs', [repo, 'prune-list']);
  const stale = r.stdout.trim().split('\n').sort();
  check(JSON.stringify(stale) === JSON.stringify([`targets/windows/${s('1')}.rem0te-agent.exe`, `targets/windows/${s('3')}.rem0te-agent.exe.tmp`].sort()),
    'prune-list: keeps the newest two targets versions\' files, lists only the older one and a leftover .tmp', JSON.stringify(stale));
  r = node('repo-info.mjs', [repo, 'target', 'windows/rustdesk/rustdesk-1.4.9-x86_64.exe']);
  check(r.stdout.trim() === s('b'), 'target NAME prints its signed sha256');
  rmSync(path.join(repo, 'metadata/3.targets.json'));
  r = node('repo-info.mjs', [repo, 'prune-list']);
  check(r.status === 0 && r.stdout.trim() === '', 'a broken chain: prune-list removes nothing', r.stdout);
  r = node('repo-info.mjs', [path.join(work, 'nothing'), 'summary']);
  check(r.status === 0 && /^CONFIGURED=0$/m.test(r.stdout) && /^AGENT_VERSION=$/m.test(r.stdout), 'an empty directory: CONFIGURED=0, nothing published');

  console.log('portal-pin.mjs');
  writeFileSync(path.join(work, 'a.env'), 'JWT_SECRET=x\n');
  r = node('portal-pin.mjs', [path.join(work, 'a.env')]);
  check(r.status === 0 && r.stdout === '', 'no DATABASE_URL: no pin, nothing run');
  writeFileSync(path.join(work, 'b.env'), 'DATABASE_URL=mysql://u:p@localhost/db\n');
  r = node('portal-pin.mjs', [path.join(work, 'b.env')]);
  check(r.status === 0 && r.stdout === '', 'not a postgres URL: no pin');
  r = node('portal-pin.mjs', [path.join(work, 'missing.env')]);
  check(r.status === 0 && r.stdout === '', 'an unreadable env file: no pin');

  console.log('lib.sh');
  const vlt = (a, b) => spawnSync('bash', ['-c', `source "${R}/lib.sh"; ver_lt "$1" "$2"`, 'x', a, b]).status === 0;
  check(vlt('0.9.0', '0.10.0') && !vlt('0.10.0', '0.9.0') && !vlt('1.2.3', '1.2.3') && vlt('0.36.2', '0.37.0') && !vlt('1.0.0', '0.99.99'), 'ver_lt compares numerically: 0.9.0 < 0.10.0, equal is not less');
  const head = execFileSync('bash', ['-c', `source "${R}/lib.sh"; printf '%s|%s' "$TRUSTROOT" "$DEFAULT_RUSTDESK_API"`], { encoding: 'utf8' });
  check(head === `tools/windows-installer/trustroot/root.json|${GH}`, 'lib.sh names the trust root and GitHub\'s RustDesk releases API', head);
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
