#!/usr/bin/env node
/**
 * End-to-end: signed releases on one host (0.37) — deploy/release/.
 *
 * Runs the real setup, publish, refresh, status and export-root commands,
 * entirely inside a temporary directory as the current user
 * (`--prefix DIR --no-user --no-systemd`: no sudo, no useradd, no systemd,
 * nothing under /var/lib or /etc). The source is a throwaway git repository
 * made from this checkout's files, so commits, version bumps and a dirty
 * trust root can be staged without touching the real one. RustDesk comes from
 * a loopback stand-in for GitHub's release API (port 3902). Proves:
 *
 *   - setup creates the key store (0700, keys 0600), the published repository
 *     (2750 / 0640), the configuration, the commands, and adds UPDATE_REPO_DIR
 *     to the portal env file with --apply-env; no key is ever printed;
 *   - a second setup changes no key and does not re-initialise;
 *   - a scratch API (port 3901) with UPDATE_REPO_DIR pointing at the published
 *     directory: before the first publish a Windows computer's Agent card says
 *     NO_SIGNED_RELEASE; after it, the upgrade is offered, the mirror serves
 *     what the agents' own client accepts (`rem0te-release verify -mirror`),
 *     /admin/update-trust lists {version, commit} on the agent and tray, and
 *     the served agent embeds the owner's root while the git tree keeps `{}`;
 *     another business still gets a 404;
 *   - the RustDesk build is the one the portal pins (read from the database
 *     through the portal env file), checked against GitHub's published digest;
 *     a wrong digest or no digest is refused;
 *   - install.ps1 built from the archive equals the one built from dist;
 *   - refusals that leave the published repository byte-identical: a
 *     downgrade, the same version from another commit, a real root.json in
 *     the checkout, a bad RustDesk digest, and a corrupted staging copy;
 *   - the daily refresh publishes a new timestamp and nothing else;
 *   - export-root keeps the keys unless told `yes`, refuses a directory in a
 *     git tree, copies byte for byte, and publishing still works afterwards.
 *
 *   cd apps/api && npx nest build
 *   DATABASE_URL=…/rem0te_signed_release_test node scripts/e2e-signed-release.mjs
 *
 * Needs Go (GO, or go on PATH, or /usr/local/go/bin/go; setup picks the
 * toolchain go.mod needs) and pnpm's TypeScript. Scratch databases only.
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..', '..', '..');
const dist = path.join(here, '..', 'dist');
const DB = process.env.DATABASE_URL ?? '';
const dbName = DB.split('/').pop()?.split('?')[0] ?? '';
if (!/scratch|test/.test(dbName)) { console.error(`Refusing to run against database "${dbName}": name must contain "scratch" or "test".`); process.exit(2); }
const PORT = Number(process.env.SIGNED_RELEASE_API_PORT ?? 3901);
const GH_PORT = Number(process.env.SIGNED_RELEASE_GH_PORT ?? 3902);
for (const p of [PORT, GH_PORT]) if ([3000, 3001, 443, 4000, 4001].includes(p)) { console.error(`Refusing port ${p}: that is a production port.`); process.exit(2); }
const GO = process.env.GO || (() => { try { return execFileSync('sh', ['-c', 'command -v go'], { encoding: 'utf8' }).trim(); } catch { return ''; } })() || '/usr/local/go/bin/go';
if (!existsSync(GO)) { console.error('Go is required (GO, go on PATH, or /usr/local/go/bin/go)'); process.exit(2); }
const TS = path.join(here, '..', 'node_modules', 'typescript');
if (!existsSync(path.join(TS, 'package.json'))) { console.error(`TypeScript not found at ${TS} (pnpm install)`); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
// The pin is read through psql (deploy/release/portal-pin.mjs); without it publish falls back to the latest release.
const HAVE_PSQL = (() => { try { execFileSync('sh', ['-c', 'command -v psql'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const TAG = `SR${sfx}`;
const PW = 'signed-release-e2e-password-1';

let pass = 0, fail = 0; const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${String(d).slice(0, 1500)}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const mode = (p) => (statSync(p).mode & 0o7777).toString(8);

// ── Places ──────────────────────────────────────────────────────────────────
const work = mkdtempSync(path.join(tmpdir(), 'rem0te-signed-release-'));
const SRC = path.join(work, 'src');
const P = path.join(work, 'p');
const STATE = path.join(P, 'var/lib/rem0te-release');
const KEYS = path.join(STATE, 'keys');
const PUB = path.join(P, 'var/lib/rem0te-updates');
const BIN = path.join(P, 'usr/local/sbin');
const TOOL = path.join(P, 'usr/local/lib/rem0te-release/rem0te-release');
const CONF = path.join(P, 'etc/rem0te-release/release.conf');
const ENVF = path.join(P, 'etc/reboot-remote/api.env');
const USB = path.join(work, 'usb'); mkdirSync(USB);
const goEnv = (k) => { try { return execFileSync(GO, ['env', k], { encoding: 'utf8', env: { ...process.env, GOTOOLCHAIN: 'local' } }).trim(); } catch { return ''; } };

/** Run a command without blocking the event loop (the stand-in GitHub server lives in this process). */
function run(cmd, args, { input, env: extra } = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { env: { ...process.env, ...extra }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
    p.stdin.end(input ?? '');
  });
}
const git = (...a) => execFileSync('git', ['-C', SRC, ...a], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@example.com', GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@example.com' } });
const commit = (msg) => { git('add', '-A'); git('commit', '-q', '--allow-empty', '-m', msg); return git('rev-parse', 'HEAD').trim(); };
const setVersion = (v) => {
  const f = path.join(SRC, 'version.json');
  const j = JSON.parse(readFileSync(f, 'utf8')); j.version = v; writeFileSync(f, `${JSON.stringify(j, null, 2)}\n`);
  return commit(`v${v}`);
};
const setup = (extra = []) => run('bash', [path.join(SRC, 'deploy/release/rem0te-signed-setup.sh'), '--prefix', P, '--no-user', '--no-systemd', '--source', SRC, '--typescript', TS,
  '--go', GO, '--gomodcache', goEnv('GOMODCACHE') || path.join(work, 'gomod'), '--gocache', goEnv('GOCACHE') || path.join(work, 'gocache'),
  '--rustdesk-api', `http://127.0.0.1:${GH_PORT}/repos/rustdesk/rustdesk/releases`, ...extra]);
const publish = (args = [], env = {}) => run(path.join(BIN, 'rem0te-signed-publish'), args, { env });
function tree(dir) {
  const out = {};
  const walk = (rel) => { for (const n of readdirSync(path.join(dir, rel))) { const r = rel ? `${rel}/${n}` : n; const a = path.join(dir, r); if (statSync(a).isDirectory()) walk(r); else out[r] = sha(readFileSync(a)); } };
  if (existsSync(dir)) walk('');
  return out;
}
const sameTree = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keyHashes = () => Object.fromEntries(readdirSync(KEYS).filter((f) => f.endsWith('.pem')).map((f) => [f, sha(readFileSync(path.join(KEYS, f)))]));
const pubDoc = (f) => JSON.parse(readFileSync(path.join(PUB, 'metadata', f), 'utf8'));
const servedTargets = () => { const ts = pubDoc('timestamp.json'); const sn = pubDoc(`${ts.signed.meta['snapshot.json'].version}.snapshot.json`); return pubDoc(`${sn.signed.meta['targets.json'].version}.targets.json`).signed.targets; };
const noKeyMaterial = (s) => !/PRIVATE KEY|BEGIN [A-Z ]*KEY/.test(s);
let allOutput = '';
const note = (r) => { allOutput += r.out; return r; };

// ── The stand-in for GitHub's RustDesk releases ─────────────────────────────
const rdBytes = { '9.9.1': randomBytes(200_000), '9.9.2': randomBytes(150_000), '9.9.3': randomBytes(100_000), '9.9.4': randomBytes(120_000) };
const ghBase = `http://127.0.0.1:${GH_PORT}`;
const releaseDoc = (v) => {
  const name = `rustdesk-${v}-x86_64.exe`;
  // 9.9.2 publishes a digest that does not match the file; 9.9.3 publishes none.
  const digest = v === '9.9.2' ? `sha256:${sha(Buffer.from('something else'))}` : v === '9.9.3' ? undefined : `sha256:${sha(rdBytes[v])}`;
  return { tag_name: v, assets: [{ name, ...(digest ? { digest } : {}), browser_download_url: `${ghBase}/download/${v}/${name}` }] };
};
const ghHits = [];
const gh = createServer((req, res) => {
  ghHits.push(req.url);
  let m;
  if (req.url === '/repos/rustdesk/rustdesk/releases/latest') { res.end(JSON.stringify(releaseDoc('9.9.4'))); return; }
  if ((m = /^\/repos\/rustdesk\/rustdesk\/releases\/tags\/(\d+\.\d+\.\d+)$/.exec(req.url)) && rdBytes[m[1]]) { res.end(JSON.stringify(releaseDoc(m[1]))); return; }
  if ((m = /^\/download\/(\d+\.\d+\.\d+)\/rustdesk-\1-x86_64\.exe$/.exec(req.url)) && rdBytes[m[1]]) { res.end(rdBytes[m[1]]); return; }
  res.statusCode = 404; res.end('{}');
});

// ── API ─────────────────────────────────────────────────────────────────────
const env = {
  ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATABASE_URL: DB, UPDATE_REPO_DIR: PUB,
  JWT_SECRET: randomBytes(32).toString('hex'), LAUNCHER_TOKEN_SECRET: randomBytes(32).toString('hex'),
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? randomBytes(32).toString('hex'), TRUSTED_PROXIES: 'loopback',
  HBBS_PRESENCE_HOST: '127.0.0.2', MONITOR_SWEEP: 'off', CLIENT_UPDATE_SWEEP: 'off', PATCH_POLICY_SWEEP: 'off', METRIC_SWEEP: 'off', AUDIT_SEALER: 'off',
  RETENTION_SWEEP: 'off', REPORT_SCHEDULE_SWEEP: 'off', CHAT_RETENTION_SWEEP: 'off', SCRIPT_OUTPUT_SWEEP: 'off', SNAPSHOT_SWEEP: 'off', AGENT_AUTO_UPDATE: 'off', TRAY_SWEEP: 'off',
  VERSION_FILE: path.join(ROOT, 'version.json'),
};
delete env.PUBLIC_API_URL;
let api;
async function waitUp() {
  for (let i = 0; i < 150; i++) { try { const r = await fetch(`${API}/health`); if (r.status < 500) return; } catch { /* not yet */ } await sleep(300); }
  throw new Error(`API did not come up:\n${api.log.slice(-3000)}`);
}
async function req(method, p, { s, body } = {}) {
  const h = { 'content-type': 'application/json', 'x-forwarded-for': ip() };
  if (s) h.cookie = s.cookie;
  const r = await fetch(`${API}${p}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const buf = Buffer.from(await r.arrayBuffer());
  const text = buf.toString('utf8');
  let j; try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j, data: j?.data, text, buf, setCookie: r.headers.get('set-cookie') ?? '' };
}
async function login(email) {
  const r = await req('POST', '/auth/login', { body: { email, password: PW } });
  const m = r.setCookie.match(/access_token=([^;]+)/);
  if (r.status !== 200 || !m) throw new Error(`login ${email}: ${r.status} ${r.text.slice(0, 200)}`);
  return { cookie: `access_token=${m[1]}` };
}
const msg = (r) => `HTTP ${r.status} ${r.text.slice(0, 300)}`;
const verifyMirror = () => { try { return execFileSync(TOOL, ['verify', '-trusted-root', path.join(STATE, 'repo/metadata/1.root.json'), '-mirror', `${API}/public/updates`], { encoding: 'utf8' }); } catch (e) { return `FAILED ${e.stdout ?? ''}${e.stderr ?? e}`; } };

const created = { users: [], businesses: [] };
let savedPin;

async function main() {
  // ── The throwaway source repository ──────────────────────────────────────
  section('A throwaway git checkout made from this tree (HEAD is what gets built)');
  {
    const files = execFileSync('git', ['-C', ROOT, 'ls-files', '-co', '--exclude-standard', '--', 'tools/windows-installer', 'apps/api/src/public/windows-script.ts',
      'apps/api/scripts/build-signed-installer.mjs', 'version.json', 'deploy/release'], { encoding: 'utf8' }).split('\n').filter((f) => f && existsSync(path.join(ROOT, f)));
    for (const f of files) { mkdirSync(path.dirname(path.join(SRC, f)), { recursive: true }); writeFileSync(path.join(SRC, f), readFileSync(path.join(ROOT, f))); }
    execFileSync('chmod', ['+x', ...readdirSync(path.join(SRC, 'deploy/release')).filter((f) => /^rem0te-signed-|\.sh$/.test(f)).map((f) => path.join(SRC, 'deploy/release', f))]);
    git('init', '-q'); commit('initial');
    check(readFileSync(path.join(SRC, 'tools/windows-installer/trustroot/root.json'), 'utf8').trim() === '{}', 'the checkout carries the {} placeholder root', '');
  }
  await new Promise((r) => gh.listen(GH_PORT, '127.0.0.1', r));

  // ── Fixtures and the API ─────────────────────────────────────────────────
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  savedPin = (await prisma.platformSettings.findUnique({ where: { id: 'singleton' } }))?.rustdeskPinnedVersion ?? null;
  await prisma.platformSettings.upsert({ where: { id: 'singleton' }, update: { rustdeskPinnedVersion: '9.9.1', updateTrustMode: 'legacy_allowed', legacyPortalMigration: false }, create: { id: 'singleton', rustdeskPinnedVersion: '9.9.1' } });
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });
  const A = await prisma.customer.create({ data: { tenantId: tenant.id, name: `${TAG} Acme` } });
  const B = await prisma.customer.create({ data: { tenantId: tenant.id, name: `${TAG} Birch` } });
  created.businesses.push(A.id, B.id);
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (t, extra = {}) => { const u = await prisma.user.create({ data: { email: `sr-${t}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'SR', lastName: t, status: 'ACTIVE', ...extra } }); created.users.push(u.id); return u; };
  const admin = await mkUser('admin', { isPlatformAdmin: true });
  const ownerA = await mkUser('owner-a'), ownerB = await mkUser('owner-b');
  await prisma.membership.create({ data: { userId: ownerA.id, tenantId: tenant.id, customerId: A.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: ownerB.id, tenantId: tenant.id, customerId: B.id, roleId: roleOwner.id } });
  const e = await prisma.endpoint.create({ data: {
    tenantId: tenant.id, customerId: A.id, name: `${TAG}-STD`, hostname: `${TAG.toLowerCase()}-std`, platform: 'Windows', status: 'ACTIVE', isOnline: true, isManaged: true,
    accessMode: 'COMPANY_WIDE', lastSeenAt: new Date(), agentVersion: '0.36.2', deviceClass: 'WORKSTATION',
  } });
  await prisma.rustdeskNode.create({ data: { tenantId: tenant.id, endpointId: e.id, rustdeskId: String(100000000 + ((Math.random() * 899999999) | 0)), agentSecretHash: sha(randomBytes(16).toString('hex')) } });

  // ── Setup ────────────────────────────────────────────────────────────────
  section('Setup: user-less test install inside a prefix, keys, repository, commands, env line');
  mkdirSync(path.dirname(ENVF), { recursive: true });
  writeFileSync(ENVF, `# scratch portal env\nDATABASE_URL=${DB}\n`, { mode: 0o600 });
  {
    const r = note(await setup(['--apply-env', '--no-publish']));
    check(r.code === 0, 'setup exits 0', r.out.slice(-2500));
    const ks = keyHashes();
    check(JSON.stringify(Object.keys(ks).sort()) === JSON.stringify(['root1.pem', 'root2.pem', 'root3.pem', 'snapshot.pem', 'targets.pem', 'timestamp.pem']), 'six keys: three root, targets, snapshot, timestamp', JSON.stringify(Object.keys(ks)));
    check(mode(STATE) === '700' && mode(KEYS) === '700' && readdirSync(KEYS).filter((f) => f.endsWith('.pem')).every((f) => mode(path.join(KEYS, f)) === '600'),
      'state and key directories 0700, every key 0600', `${mode(STATE)} ${mode(KEYS)}`);
    check(mode(PUB) === '2750', 'published directory 2750 (setgid: files take the portal group)', mode(PUB));
    check(mode(CONF) === '644' && /^PUB_DIR=/m.test(readFileSync(CONF, 'utf8')), 'configuration written, 0644', mode(CONF));
    check(['rem0te-signed-publish', 'rem0te-signed-status', 'rem0te-signed-export-root', 'rem0te-signed-refresh'].every((c) => existsSync(path.join(BIN, c))) && existsSync(TOOL),
      'commands and the release tool installed', readdirSync(BIN).join(' '));
    check(readFileSync(ENVF, 'utf8').includes(`\nUPDATE_REPO_DIR=${PUB}\n`), '--apply-env adds UPDATE_REPO_DIR to the portal env file', readFileSync(ENVF, 'utf8'));
    const root = JSON.parse(readFileSync(path.join(STATE, 'repo/metadata/1.root.json'), 'utf8'));
    check(root.signed.roles.root.threshold === 2 && root.signed.roles.root.keyids.length === 3, 'root: threshold 2 of 3 keys', JSON.stringify(root.signed.roles.root));
    check(noKeyMaterial(r.out) && /generated targets key, id [0-9a-f]{64}/.test(r.out), 'setup prints key ids, never key material', '');
    check(!existsSync(path.join(PUB, 'metadata')), '--no-publish: nothing published yet', readdirSync(PUB).join(' '));
  }
  const keysAfterSetup = keyHashes();
  const root1 = readFileSync(path.join(STATE, 'repo/metadata/1.root.json'));
  {
    const r = note(await setup(['--apply-env', '--no-publish']));
    check(r.code === 0 && /keys already exist/.test(r.out) && /already initialised/.test(r.out), 'a second setup succeeds and says keys and repository exist', r.out.slice(-1500));
    check(sameTree(keyHashes(), keysAfterSetup) && root1.equals(readFileSync(path.join(STATE, 'repo/metadata/1.root.json'))), 'a second setup changed no key and did not re-initialise', '');
    check(readFileSync(ENVF, 'utf8').split('\n').filter((l) => l.startsWith('UPDATE_REPO_DIR=')).length === 1, 'and did not add the env line twice', '');
    rmSync(path.join(KEYS, 'snapshot.pem.bak'), { force: true });
    writeFileSync(path.join(work, 'snap.bak'), readFileSync(path.join(KEYS, 'snapshot.pem')));
    rmSync(path.join(KEYS, 'snapshot.pem'));
    const r2 = note(await setup(['--no-publish']));
    check(r2.code !== 0 && /incomplete key set/.test(r2.out) && !existsSync(path.join(KEYS, 'snapshot.pem')), 'a half-present key set: setup refuses and generates nothing', r2.out.slice(-800));
    writeFileSync(path.join(KEYS, 'snapshot.pem'), readFileSync(path.join(work, 'snap.bak')), { mode: 0o600 });
    check(sameTree(keyHashes(), keysAfterSetup), 'key set restored for the rest of the run', '');
  }

  api = spawn(process.execPath, [path.join(dist, 'main.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  api.log = ''; api.stdout.on('data', (d) => { api.log += d; }); api.stderr.on('data', (d) => { api.log += d; });
  await waitUp();
  const S = { admin: await login(admin.email), ownerA: await login(ownerA.email), ownerB: await login(ownerB.email) };

  section('Before the first publish: the portal sees no signed release');
  {
    const c = await req('GET', `/endpoints/${e.id}/agent`, { s: S.ownerA });
    check(c.status === 200 && c.data?.migration?.possible === false && c.data?.migration?.code === 'NO_SIGNED_RELEASE', 'Agent card: Upgrade to full agent refused, NO_SIGNED_RELEASE', JSON.stringify(c.data?.migration));
    const m = await req('GET', '/public/updates/metadata/timestamp.json');
    check(m.status === 404, 'the mirror serves nothing', msg(m));
  }

  // ── First publish ────────────────────────────────────────────────────────
  section('First publish: built from git archive, root only in the build copy, RustDesk the portal pins');
  const c1 = git('rev-parse', 'HEAD').trim();
  const v1 = JSON.parse(readFileSync(path.join(SRC, 'version.json'), 'utf8')).version;
  {
    const r = note(await publish());
    check(r.code === 0 && /Published /.test(r.out), 'publish exits 0', r.out.slice(-3000));
    if (HAVE_PSQL) {
      check(/RustDesk 9\.9\.1: the version the portal pins/.test(r.out) && /matches GitHub's published digest/.test(r.out), 'RustDesk: the pinned 9.9.1, read from the portal database, digest checked', r.out.slice(-1500));
      check(ghHits.some((u) => u.endsWith('/tags/9.9.1')) && !ghHits.some((u) => u.endsWith('/latest')), 'asked for the pinned release, not the latest', JSON.stringify(ghHits));
    } else {
      console.log('  (psql is not on PATH: the portal pin cannot be read, so publish takes the latest release; the pin check is not run)');
    }
    const v = execFileSync(TOOL, ['verify', '-repo', PUB, '-trusted-root', path.join(STATE, 'repo/metadata/1.root.json')], { encoding: 'utf8' });
    check(/verified: root v1, targets v\d+, 4 target\(s\)/.test(v), 'rem0te-release verify accepts the published directory: agent, tray, installer, RustDesk', v);
    const t = servedTargets();
    check(t['windows/rem0te-agent.exe']?.custom?.version === v1 && t['windows/rem0te-agent.exe']?.custom?.commit === c1
      && t['windows/rem0te-tray.exe']?.custom?.version === v1 && t['windows/rem0te-tray.exe']?.custom?.commit === c1,
      `agent and tray targets carry {"version":"${v1}","commit":"<HEAD>"}`, JSON.stringify(t['windows/rem0te-agent.exe']?.custom));
    const rdV = HAVE_PSQL ? '9.9.1' : '9.9.4';
    check(t[`windows/rustdesk/rustdesk-${rdV}-x86_64.exe`]?.hashes?.sha256 === sha(rdBytes[rdV]), 'the RustDesk target is the downloaded build', JSON.stringify(Object.keys(t)));
    const dirs = [], filesM = [];
    const walk = (d) => { for (const n of readdirSync(d)) { const a = path.join(d, n); if (statSync(a).isDirectory()) { dirs.push(a); walk(a); } else filesM.push(a); } };
    walk(PUB);
    check(dirs.every((d) => mode(d) === '2750') && filesM.every((f) => mode(f) === '640'), 'published: directories 2750, files 0640 (group-readable, not group-writable)',
      [...dirs, ...filesM].filter((f) => !['2750', '640'].includes(mode(f))).map((f) => `${mode(f)} ${f}`).join('\n'));
    check(!readdirSync(PUB).some((n) => n.startsWith('.staging')), 'no staging directory left behind', readdirSync(PUB).join(' '));
    check(readFileSync(path.join(SRC, 'tools/windows-installer/trustroot/root.json'), 'utf8').trim() === '{}' && git('status', '--porcelain').trim() === '',
      'the git tree is untouched: root.json still {}, nothing modified or untracked', git('status', '--porcelain'));
    const dist1 = path.join(work, 'dist-install.ps1');
    execFileSync(process.execPath, [path.join(here, 'build-signed-installer.mjs'), '--out', dist1]);
    check(t['windows/install.ps1']?.hashes?.sha256 === sha(readFileSync(dist1)), 'install.ps1 built from the archive (no node_modules, no dist) equals the one built from dist', '');
    const log = readFileSync(path.join(STATE, 'publish.log'), 'utf8');
    check(/published \d+ new file/.test(log) || /Published /.test(log), 'the publish is logged under the state directory', log.slice(-500));
  }

  section('The portal serves it, and the migration preconditions now see a published signed agent');
  {
    const v = verifyMirror();
    check(/verified: root v1, targets v\d+, 4 target\(s\)/.test(v), 'the agents\' client accepts what the API serves (verify -mirror)', v);
    const st = await req('GET', '/admin/update-trust', { s: S.admin });
    const tg = st.data?.mirror?.targets ?? [];
    const ag = tg.find((x) => x.name === 'windows/rem0te-agent.exe');
    const tr = tg.find((x) => x.name === 'windows/rem0te-tray.exe');
    check(st.status === 200 && ag?.custom?.version === v1 && ag?.custom?.commit === c1 && tr?.custom?.commit === c1, 'UpdateTrustService.status lists {version, commit} on the agent and tray targets', msg(st));
    const agentSha = servedTargets()['windows/rem0te-agent.exe'].hashes.sha256;
    const bin = await req('GET', `/public/updates/targets/windows/${agentSha}.rem0te-agent.exe`);
    check(bin.status === 200 && sha(bin.buf) === agentSha && bin.buf.indexOf(root1) >= 0, 'the served rem0te-agent.exe has the signed digest and embeds the owner\'s root', `HTTP ${bin.status}`);
    const c = await req('GET', `/endpoints/${e.id}/agent`, { s: S.ownerA });
    check(c.status === 200 && c.data?.migration?.possible === true, 'Agent card: Upgrade to full agent is now offered', JSON.stringify(c.data?.migration));
    const other = await req('GET', `/endpoints/${e.id}/agent`, { s: S.ownerB });
    check(other.status === 404, 'another business\'s computer is still a 404', msg(other));
  }

  // ── Refusals that leave the published repository alone ─────────────────
  section('Refusals: the published repository stays byte-identical');
  const before = tree(PUB);
  {
    const r0 = note(await publish());
    check(r0.code === 0 && /already published; nothing to do/.test(r0.out) && sameTree(tree(PUB), before), 'the same version and commit again: nothing to do', r0.out.slice(-600));
    setVersion('0.1.0');
    let r = note(await publish());
    check(r.code !== 0 && /downgrade/.test(r.out) && sameTree(tree(PUB), before), `a version older than ${v1}: refused as a downgrade`, r.out.slice(-600));
    git('reset', '-q', '--hard', c1);
    writeFileSync(path.join(SRC, 'NOTES.txt'), 'an unversioned change\n'); commit('change without a bump');
    r = note(await publish());
    check(r.code !== 0 && /already published from/.test(r.out) && sameTree(tree(PUB), before), 'another commit under the same version: refused', r.out.slice(-600));
    const vNext = setVersion('99.0.1');
    writeFileSync(path.join(SRC, 'tools/windows-installer/trustroot/root.json'), root1);
    r = note(await publish());
    check(r.code !== 0 && /not the \{\} placeholder/.test(r.out) && sameTree(tree(PUB), before), 'a real root.json in the checkout\'s working tree: refused', r.out.slice(-600));
    git('checkout', '--', 'tools/windows-installer/trustroot/root.json');
    writeFileSync(path.join(SRC, 'tools/windows-installer/trustroot/root.json'), root1); const bad = commit('committed root');
    writeFileSync(path.join(SRC, 'tools/windows-installer/trustroot/root.json'), '{}\n'); // the working tree is clean again; HEAD is not
    r = note(await publish());
    check(r.code !== 0 && /HEAD:tools\/windows-installer\/trustroot\/root\.json is not the \{\} placeholder/.test(r.out) && sameTree(tree(PUB), before), 'a root.json committed to HEAD: refused', r.out.slice(-600));
    git('reset', '-q', '--hard', vNext);
    check(bad !== vNext && readFileSync(path.join(SRC, 'tools/windows-installer/trustroot/root.json'), 'utf8').trim() === '{}', 'placeholder restored', '');
    r = note(await publish(['--rustdesk-version', '9.9.2']));
    check(r.code !== 0 && /does not match the digest GitHub publishes/.test(r.out) && sameTree(tree(PUB), before), 'a RustDesk build that does not match GitHub\'s digest: refused, nothing signed', r.out.slice(-600));
    r = note(await publish(['--rustdesk-version', '9.9.3']));
    check(r.code !== 0 && /publishes no SHA-256 digest/.test(r.out) && sameTree(tree(PUB), before), 'a RustDesk release with no published digest: refused', r.out.slice(-600));
    r = note(await publish([], { REM0TE_SIGNED_TEST_CORRUPT_STAGING: '1' }));
    check(r.code !== 0 && /staged repository failed verification; the published repository was not changed/.test(r.out) && sameTree(tree(PUB), before),
      'a corrupted staging copy: refused by verify, the published repository never replaced', r.out.slice(-800));
    check(!readdirSync(PUB).some((n) => n.startsWith('.staging')), 'and the damaged staging copy is removed', readdirSync(PUB).join(' '));
    const v = verifyMirror();
    check(/verified: root v1/.test(v) && servedTargets()['windows/rem0te-agent.exe'].custom.version === v1, 'the API still serves the previous release, verifiably', v);
  }

  section('A newer release publishes over it');
  {
    const c2 = git('rev-parse', 'HEAD').trim();
    const tsBefore = pubDoc('timestamp.json').signed.version;
    const r = note(await publish());
    check(r.code === 0, 'publish 99.0.1 exits 0', r.out.slice(-2000));
    const t = servedTargets();
    check(t['windows/rem0te-agent.exe']?.custom?.version === '99.0.1' && t['windows/rem0te-agent.exe']?.custom?.commit === c2, 'the agent target now carries 99.0.1 and its commit', JSON.stringify(t['windows/rem0te-agent.exe']?.custom));
    check(pubDoc('timestamp.json').signed.version > tsBefore && Object.keys(t).filter((n) => n.startsWith('windows/rustdesk/')).length === 1, 'a newer timestamp; the RustDesk build stays listed', JSON.stringify(Object.keys(t)));
    const v = verifyMirror();
    check(/verified: root v1/.test(v), 'verify -mirror accepts it through the API', v);
  }

  section('0.38: --approval-keys signs the approval signer\'s public key list in, and later publishes keep it');
  {
    // What `approval-signer keygen` prints: keysDocument() — public halves only.
    const pub = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
    const doc = { schema: 'rem0te-approval-keys/1', keys: [{ kid: sha(pub).slice(0, 16), ed25519: pub.toString('base64') }] };
    const good = path.join(work, 'approval-keys.json');
    writeFileSync(good, JSON.stringify(doc));
    const bad = path.join(work, 'approval-private.json');
    writeFileSync(bad, '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEI\n-----END PRIVATE KEY-----\n');
    const before = tree(PUB);
    const rb = note(await publish(['--approval-keys', bad]));
    check(rb.code !== 0 && /looks like it holds key material/.test(rb.out) && sameTree(before, tree(PUB)), 'a file holding a private key is refused, and nothing is published', rb.out.slice(-600));
    const r = note(await publish(['--approval-keys', good]));
    const t = servedTargets();
    check(r.code === 0 && t['approval/keys.json']?.hashes?.sha256 === sha(readFileSync(good)), 'approval/keys.json is a signed target with the file\'s digest', JSON.stringify(t['approval/keys.json'] ?? null) + r.out.slice(-800));
    check(existsSync(path.join(STATE, 'approval-keys.json')), 'the list is kept in the release user\'s state directory');
    check(/verified: root v1/.test(verifyMirror()), 'verify -mirror accepts the release that carries it');
    const st = note(await run(path.join(BIN, 'rem0te-signed-status')));
    check(st.out.includes(`approval/keys.json ${sha(readFileSync(good)).slice(0, 12)}`), 'rem0te-signed-status shows the published approval keys', st.out.slice(-1200));
    const r2 = note(await publish(['--republish']));
    check(r2.code === 0 && servedTargets()['approval/keys.json']?.hashes?.sha256 === sha(readFileSync(good)), 'a later publish signs it again from the kept copy', r2.out.slice(-600));
  }

  section('The daily refresh: a new timestamp, and nothing else');
  {
    const t0 = tree(PUB);
    const ts0 = pubDoc('timestamp.json').signed.version;
    const r = note(await run(path.join(BIN, 'rem0te-signed-refresh')));
    check(r.code === 0, 'rem0te-signed-refresh exits 0', r.out.slice(-1500));
    const t1 = tree(PUB);
    const changed = Object.keys({ ...t0, ...t1 }).filter((k) => t0[k] !== t1[k]);
    check(JSON.stringify(changed) === JSON.stringify(['metadata/timestamp.json']) && pubDoc('timestamp.json').signed.version === ts0 + 1, 'only metadata/timestamp.json changed, one version up', JSON.stringify(changed));
    check(/verified: root v1/.test(verifyMirror()), 'and the API still serves a verifiable repository', '');
  }

  section('Status');
  {
    const r = note(await run(path.join(BIN, 'rem0te-signed-status')));
    check(/Signing keys\s+targets ✓\s+snapshot ✓\s+timestamp ✓/.test(r.out) && /3 of 3 ON THIS HOST/.test(r.out) && /agent\s+99\.0\.1/.test(r.out)
      && /timestamp\s+v\d+ expires .*\(6d left\)/.test(r.out) && /Last publish\s+\S+ 99\.0\.1/.test(r.out) && new RegExp(`UPDATE_REPO_DIR=${PUB.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} in`).test(r.out),
      'one screen: keys, root keys on host, published agent, timestamp expiry, last publish, portal env', r.out);
  }

  section('Export the root keys');
  {
    let r = note(await run(path.join(BIN, 'rem0te-signed-export-root'), [path.join(SRC, 'tools')]));
    check(r.code !== 0 && /inside/.test(r.out), 'a directory inside the source checkout: refused', r.out.slice(-400));
    r = note(await run(path.join(BIN, 'rem0te-signed-export-root'), [USB], { input: 'no\n' }));
    check(r.code === 0 && /Root keys kept/.test(r.out) && sameTree(keyHashes(), keysAfterSetup), 'answered "no": copies made, nothing deleted from the host', r.out.slice(-600));
    for (const f of readdirSync(USB)) rmSync(path.join(USB, f));
    r = note(await run(path.join(BIN, 'rem0te-signed-export-root'), [USB], { input: 'yes\n' }));
    const copies = Object.fromEntries(readdirSync(USB).map((f) => [f.replace(/^rem0te-/, ''), sha(readFileSync(path.join(USB, f)))]));
    check(r.code === 0 && ['root1.pem', 'root2.pem', 'root3.pem'].every((k) => copies[k] === keysAfterSetup[k]) && readdirSync(USB).every((f) => mode(path.join(USB, f)) === '600'),
      'answered "yes": three byte-identical copies, mode 0600', r.out.slice(-600));
    check(!['root1.pem', 'root2.pem', 'root3.pem'].some((k) => existsSync(path.join(KEYS, k))) && existsSync(path.join(KEYS, 'ROOT_EXPORTED'))
      && ['targets.pem', 'snapshot.pem', 'timestamp.pem'].every((k) => keyHashes()[k] === keysAfterSetup[k]), 'root keys gone from the host; the signing keys untouched', readdirSync(KEYS).join(' '));
    const s = note(await run(path.join(BIN, 'rem0te-signed-status')));
    check(/0 of 3 on this host; exported/.test(s.out), 'status reports the root keys as exported', s.out);
    const again = note(await setup(['--no-publish']));
    check(again.code === 0 && /keys already exist/.test(again.out) && !existsSync(path.join(KEYS, 'root1.pem')), 'setup after export: recognises it, generates no new root', again.out.slice(-800));
    setVersion('99.0.2');
    await prisma.platformSettings.update({ where: { id: 'singleton' }, data: { rustdeskPinnedVersion: null } });
    const p = note(await publish());
    check(p.code === 0 && servedTargets()['windows/rem0te-agent.exe']?.custom?.version === '99.0.2' && /verified: root v1/.test(verifyMirror()), 'publishing works without the root keys on the host', p.out.slice(-1500));
    const t = servedTargets();
    check(/RustDesk 9\.9\.4: the latest release \(the portal pins none\)/.test(p.out) && t['windows/rustdesk/rustdesk-9.9.4-x86_64.exe']?.hashes?.sha256 === sha(rdBytes['9.9.4'])
      && t['windows/rustdesk/rustdesk-9.9.4-x86_64.exe']?.custom?.version === '9.9.4' && (!HAVE_PSQL || !!t['windows/rustdesk/rustdesk-9.9.1-x86_64.exe']),
      'no pin: the latest RustDesk release is added (digest checked), and earlier builds stay listed', JSON.stringify(Object.keys(t)));
  }

  section('No key material anywhere it should not be');
  {
    const log = readFileSync(path.join(STATE, 'publish.log'), 'utf8');
    check(noKeyMaterial(allOutput) && noKeyMaterial(log), 'no command output and no log line contains a private key', '');
    const pubFiles = Object.keys(tree(PUB));
    check(!pubFiles.some((f) => /\.pem$/.test(f)) && !pubFiles.some((f) => noKeyMaterial(readFileSync(path.join(PUB, f)).toString('latin1')) === false), 'the published repository holds no key file and no PEM private key', '');
    check(git('status', '--porcelain').trim() === '' && git('ls-files').split('\n').every((f) => !/\.pem$/.test(f)), 'the checkout gained no file, and git tracks no key', git('status', '--porcelain'));
  }
}

async function cleanup() {
  try {
    const ids = created.businesses;
    const eps = await prisma.endpoint.findMany({ where: { customerId: { in: ids } }, select: { id: true } });
    const epIds = eps.map((x) => x.id);
    await prisma.agentMigration.deleteMany({ where: { endpointId: { in: epIds } } });
    await prisma.endpointCommand.deleteMany({ where: { endpointId: { in: epIds } } });
    await prisma.rustdeskNode.deleteMany({ where: { endpointId: { in: epIds } } });
    await prisma.endpoint.deleteMany({ where: { id: { in: epIds } } });
    await prisma.membership.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.customer.deleteMany({ where: { id: { in: ids } } });
    if (created.users.length) {
      await prisma.privilegedActivity.deleteMany({ where: { identity: { in: created.users.map((u) => `user:${u}`) } } }).catch(() => undefined);
      await prisma.user.deleteMany({ where: { id: { in: created.users } } });
    }
    if (savedPin !== undefined) await prisma.platformSettings.update({ where: { id: 'singleton' }, data: { rustdeskPinnedVersion: savedPin } });
  } catch (err) { console.error('cleanup:', err.message); }
  rmSync(work, { recursive: true, force: true });
}

main()
  .catch((err) => { fail++; failures.push(`fatal: ${err.stack ?? err}`); console.error(err); })
  .finally(async () => {
    if (api) api.kill('SIGTERM');
    gh.close();
    await cleanup();
    await prisma.$disconnect();
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) { console.log(failures.map((f) => `  ✗ ${f}`).join('\n')); process.exit(1); }
    process.exit(0);
  });
