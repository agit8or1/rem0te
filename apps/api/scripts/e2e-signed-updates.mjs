#!/usr/bin/env node
/**
 * End-to-end: the signed update chain through a real API (0.24).
 *
 * Builds a real TUF repository with the offline release tool, starts its own
 * API with UPDATE_REPO_DIR pointing at it, and checks:
 *   - the mirror serves what go-tuf's client accepts (the real Go client is
 *     run against the API: `rem0te-release verify -mirror`),
 *   - nothing outside the repository is reachable through it,
 *   - the parameters route is data only and offers only signed RustDesk builds,
 *   - signed_only containment: legacy agents are handed nothing to run, the
 *     legacy installer route refuses, the migration path is opt-in and
 *     reviewed, the download is the signed agent,
 *   - tightening is immediate, loosening needs an independent reviewer,
 *   - the agent inventory reflects what heartbeats report.
 *
 *   cd apps/api && npx nest build
 *   RELEASE_BIN=/path/to/rem0te-release \
 *   DATABASE_URL=postgresql://…/reboot_remote_it_scratch node scripts/e2e-signed-updates.mjs
 *
 * RELEASE_BIN: `go build -o rem0te-release ./cmd/rem0te-release` in
 * tools/windows-installer. Scratch databases only.
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const DB = process.env.DATABASE_URL ?? '';
const dbName = DB.split('/').pop()?.split('?')[0] ?? '';
if (!/scratch|test/.test(dbName)) {
  console.error(`Refusing to run against database "${dbName}": name must contain "scratch" or "test".`);
  process.exit(2);
}
const BIN = process.env.RELEASE_BIN;
if (!BIN) { console.error('RELEASE_BIN (rem0te-release) is required'); process.exit(2); }
const PORT = Number(process.env.SIGNED_API_PORT ?? 3131);
const API = `http://127.0.0.1:${PORT}/api/v1`;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'signed-e2e-password-123';

let pass = 0, fail = 0; const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;
const sha = (b) => createHash('sha256').update(b).digest('hex');

// ── The release machine: keys and repository, outside anything served ──────
const work = mkdtempSync(path.join(tmpdir(), 'rem0te-signed-'));
const keys = path.join(work, 'keys'); mkdirSync(keys);
const repo = path.join(work, 'repo');
const rel = (...a) => execFileSync(BIN, a, { encoding: 'utf8' });
for (const k of ['r1', 'r2', 'r3', 'targets', 'snapshot', 'timestamp']) rel('keygen', '-out', path.join(keys, `${k}.pem`));
rel('init', '-repo', repo, '-root-key', path.join(keys, 'r1.pem'), '-root-key', path.join(keys, 'r2.pem'), '-root-key', path.join(keys, 'r3.pem'),
  '-root-threshold', '2', '-targets-key', path.join(keys, 'targets.pem'), '-snapshot-key', path.join(keys, 'snapshot.pem'), '-timestamp-key', path.join(keys, 'timestamp.pem'));
const files = path.join(work, 'files'); mkdirSync(files);
execFileSync(process.execPath, [path.join(here, 'build-signed-installer.mjs'), '--out', path.join(files, 'install.ps1')]);
// A stand-in agent binary carrying the slot the portal patches.
const slot = Buffer.concat([Buffer.from('REM0TE_INST_URL:'), Buffer.alloc(240)]);
const agentBin = Buffer.concat([Buffer.from('MZ fake signed agent '), randomBytes(64), slot, Buffer.from(' trailer')]);
writeFileSync(path.join(files, 'agent.exe'), agentBin);
writeFileSync(path.join(files, 'rustdesk.exe'), Buffer.from('rustdesk 1.4.6 ' + randomBytes(32).toString('hex')));
const T = (n) => ['-targets-key', path.join(keys, 'targets.pem'), '-snapshot-key', path.join(keys, 'snapshot.pem'), '-timestamp-key', path.join(keys, 'timestamp.pem'), ...n];
rel('release', '-repo', repo, ...T(['-add', `windows/install.ps1=${path.join(files, 'install.ps1')}`, '-add', `windows/rem0te-agent.exe=${path.join(files, 'agent.exe')}`,
  '-add', `windows/rustdesk/rustdesk-1.4.6-x86_64.exe=${path.join(files, 'rustdesk.exe')}`, '-custom', 'windows/rustdesk/rustdesk-1.4.6-x86_64.exe={"version":"1.4.6"}']));
// A planted symlink inside targets/ pointing outside the repository.
symlinkSync('/etc/hostname', path.join(repo, 'targets', 'windows', 'escape.txt'));

// ── API ─────────────────────────────────────────────────────────────────────
const env = {
  ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATABASE_URL: DB, UPDATE_REPO_DIR: repo,
  JWT_SECRET: randomBytes(32).toString('hex'), LAUNCHER_TOKEN_SECRET: randomBytes(32).toString('hex'),
  ENCRYPTION_KEY: randomBytes(32).toString('hex'), TRUSTED_PROXIES: 'loopback',
  VERSION_FILE: path.resolve(here, '..', '..', '..', 'version.json'),
};
const api = spawn(process.execPath, [path.join(dist, 'main.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
api.log = ''; api.stdout.on('data', (d) => { api.log += d; }); api.stderr.on('data', (d) => { api.log += d; });
async function waitUp() {
  for (let i = 0; i < 120; i++) { try { const r = await fetch(`${API}/health`); if (r.status < 500) return; } catch { /* not yet */ } await sleep(300); }
  throw new Error(`API did not come up:\n${api.log.slice(-3000)}`);
}

async function req(method, p, { s, body, headers = {} } = {}) {
  const h = { 'content-type': 'application/json', 'x-forwarded-for': s?.ip ?? ip(), ...headers };
  if (s) h.cookie = s.cookie + (s.stepUp ? `; step_up=${s.stepUp}` : '');
  const r = await fetch(`${API}${p}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const buf = Buffer.from(await r.arrayBuffer());
  let j; try { j = JSON.parse(buf.toString('utf8')); } catch { j = buf.toString('utf8'); }
  return { status: r.status, body: j, buf, headers: r.headers, setCookie: r.headers.get('set-cookie') ?? '' };
}
async function login(email) {
  const s = { ip: ip() };
  const r = await req('POST', '/auth/login', { body: { email, password: PW }, s });
  const m = r.setCookie.match(/access_token=([^;]+)/);
  if (r.status !== 200 || !m) throw new Error(`login ${email}: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  return { ...s, cookie: `access_token=${m[1]}` };
}
async function stepUp(s) {
  const r = await req('POST', '/auth/step-up', { s, body: { password: PW } });
  const m = r.setCookie.match(/step_up=([^;]+)/);
  if (r.status !== 200 || !m) throw new Error(`step-up: ${r.status}`);
  return { ...s, stepUp: m[1] };
}
const code = (r) => r.body?.code ?? r.body?.message?.code;
const heartbeat = (ep, extra = {}) => req('POST', '/enrollment/heartbeat', { body: { rustdeskId: ep.rid, agentSecret: ep.secret, ...extra } });

const created = { users: [], endpoints: [], business: null };
let savedSettings = null;

async function main() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first');
  savedSettings = await prisma.platformSettings.findUnique({ where: { id: 'singleton' } });
  await prisma.platformSettings.upsert({ where: { id: 'singleton' }, update: { updateTrustMode: 'legacy_allowed', legacyPortalMigration: false, rustdeskPinnedVersion: '1.4.5' }, create: { id: 'singleton', rustdeskPinnedVersion: '1.4.5' } });
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag, extra = {}) => { const u = await prisma.user.create({ data: { email: `su-${tag}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'SU', lastName: tag, status: 'ACTIVE', ...extra } }); created.users.push(u.id); return u; };
  const admin1 = await mkUser('admin1', { isPlatformAdmin: true });
  const admin2 = await mkUser('admin2', { isPlatformAdmin: true });
  const plain = await mkUser('plain');
  const biz = await prisma.customer.create({ data: { tenantId: tenant.id, name: `Signed Lab ${sfx}` } });
  created.business = biz.id;
  const roleUser = await prisma.role.findFirst({ where: { type: 'BUSINESS_USER' } });
  await prisma.membership.create({ data: { userId: plain.id, tenantId: tenant.id, customerId: biz.id, roleId: roleUser.id, capabilities: ['computers:view'] } });
  const mkEp = async (name) => {
    const e = await prisma.endpoint.create({ data: { tenantId: tenant.id, customerId: biz.id, name, hostname: name, platform: 'Windows', status: 'ACTIVE', isOnline: true, isManaged: true, lastSeenAt: new Date() } });
    created.endpoints.push(e.id);
    const secret = randomBytes(16).toString('hex');
    const node = await prisma.rustdeskNode.create({ data: { tenantId: tenant.id, endpointId: e.id, rustdeskId: String(100000000 + ((Math.random() * 899999999) | 0)), agentSecretHash: sha(secret), reinstallRequestedAt: new Date() } });
    return { id: e.id, rid: node.rustdeskId, secret };
  };
  const legacyEp = await mkEp(`LEGACY-${sfx}`);
  const signedEp = await mkEp(`SIGNED-${sfx}`);

  await waitUp();
  const A1 = await stepUp(await login(admin1.email));
  const A2 = await stepUp(await login(admin2.email));
  const P = await login(plain.email);

  section('Mirror: serves the repository, and only the repository');
  {
    const ts = await req('GET', '/public/updates/metadata/timestamp.json');
    check(ts.status === 200 && ts.body?.signed?._type === 'timestamp', 'timestamp.json served', `${ts.status}`);
    check(ts.headers.get('cache-control') === 'no-store', 'timestamp.json is never cacheable (a cached timestamp is a freeze)', ts.headers.get('cache-control'));
    const r1 = await req('GET', '/public/updates/metadata/1.root.json');
    check(r1.status === 200 && /immutable/.test(r1.headers.get('cache-control') ?? ''), 'versioned root is immutable-cacheable');
    check(r1.buf.equals(readFileSync(path.join(repo, 'metadata', '1.root.json'))), 'served bytes are exactly the signed file');
    const agentName = `${sha(agentBin)}.rem0te-agent.exe`;
    const t = await req('GET', `/public/updates/targets/windows/${agentName}`);
    check(t.status === 200 && t.buf.equals(agentBin), 'target served by its consistent-snapshot name', `${t.status}`);
    for (const [p, what] of [
      ['/public/updates/metadata/..%2F..%2Fkeys%2Fr1.pem', 'encoded traversal to a key'],
      ['/public/updates/metadata/root.json.bak', 'non-metadata name'],
      ['/public/updates/metadata/0.root.json', 'version 0'],
      ['/public/updates/targets/windows/..%2F..%2Fmetadata%2Froot.json', 'traversal out of targets'],
      ['/public/updates/targets/windows/escape.txt', 'symlink out of the repository'],
      ['/public/updates/targets/Windows/x.exe', 'segment outside the charset'],
      ['/public/updates/targets/windows/nope.exe', 'absent file'],
    ]) {
      const r = await req('GET', p);
      check(r.status === 404, `404: ${what}`, `${r.status} ${String(r.buf).slice(0, 80)}`);
    }
    // The real endpoint client, through the API, from root v1.
    let out;
    try { out = execFileSync(BIN, ['verify', '-trusted-root', path.join(repo, 'metadata', '1.root.json'), '-mirror', `${API}/public/updates`], { encoding: 'utf8' }); } catch (e) { out = String(e.stdout ?? '') + String(e.stderr ?? e); }
    check(/verified: root v1, targets v2, 3 target\(s\)/.test(out), 'go-tuf client verifies every target through the API mirror', out.trim().slice(-300));
  }

  section('Parameters: data only, signed builds only');
  {
    const r = await req('GET', '/public/install/windows-params.json');
    const d = r.body?.data ?? {};
    check(r.status === 200 && d.schema === 'rem0te-install-params/1' && /^[a-zA-Z0-9.-]+$/.test(d.host ?? ''), 'params served', JSON.stringify(r.body).slice(0, 200));
    check(d.rustdeskVersion === '1.4.6', 'pin 1.4.5 is not signed: the newest signed build (1.4.6) is offered instead', d.rustdeskVersion);
    check(!('claimToken' in d) && !('script' in d), 'no token and no code in the parameters');
    const bogus = await req('GET', '/public/install/windows-params.json?updateNonce=nonce_DOESNOTEXIST000');
    check(bogus.status === 200 && !bogus.body?.data?.updateNonce, 'an unknown nonce changes nothing');
  }

  section('Admin status and inventory');
  {
    const denied = await req('GET', '/admin/update-trust', { s: P });
    check(denied.status === 403, 'non-admin refused', `${denied.status}`);
    const r = await req('GET', '/admin/update-trust', { s: A1 });
    const m = r.body?.data?.mirror;
    check(r.status === 200 && m?.configured && m.roles.root.version === 1 && m.roles.root.threshold === 2 && m.roles.targets.version === 2, 'mirror status as served', JSON.stringify(m ?? r.body).slice(0, 300));
    check(m?.targets?.map((x) => x.name).join(',') === 'windows/install.ps1,windows/rem0te-agent.exe,windows/rustdesk/rustdesk-1.4.6-x86_64.exe', 'targets listed', JSON.stringify(m?.targets?.map((x) => x.name)));
    check(Array.isArray(m?.warnings) && m.warnings.length === 0, 'no warnings for a healthy repository', JSON.stringify(m?.warnings));
    check(r.body?.data?.mode === 'legacy_allowed', 'starts in legacy_allowed (upgrade changes nothing)');
  }

  section('legacy_allowed: today’s behaviour is unchanged');
  {
    const hb = await heartbeat(legacyEp);
    check(hb.status === 200 || hb.status === 201, 'legacy heartbeat accepted', `${hb.status}`);
    check(!!hb.body?.data?.reinstallAgent || !!hb.body?.reinstallAgent, 'a requested reinstall is still handed to a legacy agent', JSON.stringify(hb.body).slice(0, 200));
    const ps = await req('GET', '/public/install/windows.ps1');
    check(ps.status === 200 && /\$UPDATE_CHANNEL = 'legacy'/.test(String(ps.buf)), 'windows.ps1 still serves the legacy installer');
    const e = await prisma.endpoint.findUnique({ where: { id: legacyEp.id } });
    check(e.updateChannel === 'legacy' && e.trustRootVersion === null, 'agent recorded as legacy', JSON.stringify({ c: e.updateChannel, r: e.trustRootVersion }));
  }

  section('Tightening is immediate, but needs fresh authentication');
  {
    const noFresh = await req('PUT', '/admin/update-trust/mode', { s: { ...A1, stepUp: undefined }, body: { mode: 'signed_only', legacyPortalMigration: false } });
    check(noFresh.status === 403 && code(noFresh) === 'STEP_UP_REQUIRED', 'no step-up: refused', `${noFresh.status} ${code(noFresh)}`);
    // Without a repository there is nothing to be signed-only about.
    renameSync(path.join(repo, 'metadata', 'timestamp.json'), path.join(repo, 'metadata', 'timestamp.json.off'));
    const noRepo = await req('PUT', '/admin/update-trust/mode', { s: A1, body: { mode: 'signed_only', legacyPortalMigration: false } });
    renameSync(path.join(repo, 'metadata', 'timestamp.json.off'), path.join(repo, 'metadata', 'timestamp.json'));
    check(noRepo.status === 400 && code(noRepo) === 'UPDATE_REPO_NOT_CONFIGURED', 'signed_only refused while the repository is incomplete', `${noRepo.status} ${code(noRepo)}`);
    const r = await req('PUT', '/admin/update-trust/mode', { s: A1, body: { mode: 'signed_only', legacyPortalMigration: false } });
    check(r.status === 200 && r.body?.data?.pendingReview === false && r.body?.data?.mode === 'signed_only', 'signed_only applied at once', JSON.stringify(r.body).slice(0, 200));
  }

  section('signed_only: legacy agents are handed nothing to run');
  {
    const hb = await heartbeat(legacyEp);
    const d = hb.body?.data ?? hb.body;
    check(d?.reinstallAgent === null && d?.updateRustdesk === null, 'legacy heartbeat: reinstall and update withheld', JSON.stringify(d).slice(0, 200));
    const ps = await req('GET', '/public/install/windows.ps1');
    const txt = String(ps.buf);
    check(/Refused: signed-only update policy/.test(txt) && !/irm|iex|Invoke-WebRequest|rustdesk\.exe/i.test(txt), 'windows.ps1 serves a refusal and nothing that runs anything', txt.slice(0, 120));
    const sh = await heartbeat(signedEp, { updateChannel: 'signed', trustRootVersion: 1, targetsVersion: 2 });
    const sd = sh.body?.data ?? sh.body;
    check(!!sd?.reinstallAgent, 'signed agent still told to update (it verifies what it gets)', JSON.stringify(sd).slice(0, 200));
    const e = await prisma.endpoint.findUnique({ where: { id: signedEp.id } });
    check(e.updateChannel === 'signed' && e.trustRootVersion === 1 && e.targetsVersion === 2, 'signed agent recorded with its root and targets versions');
    const exe = await req('GET', '/public/install/windows.exe');
    const i = exe.buf.indexOf(Buffer.from('REM0TE_INST_URL:'));
    check(exe.status === 200 && i > 0 && exe.buf.subarray(0, i).equals(agentBin.subarray(0, i)), 'download is the signed agent binary (bytes before the slot identical)', `${exe.status}`);
    const url = exe.buf.subarray(i + 16, i + 256).toString('utf8').replace(/\0.*$/s, '');
    check(/\/api\/v1\/public\/install\/windows\.ps1$/.test(url), 'slot carries the portal address for the agent to parse', url);
    const inv = (await req('GET', '/admin/update-trust', { s: A1 })).body?.data?.inventory;
    check(inv?.legacy?.some((x) => x.id === legacyEp.id) && !inv?.legacy?.some((x) => x.id === signedEp.id), 'inventory lists the legacy agent, not the signed one');
  }

  section('Loosening needs an independent reviewer');
  {
    const r = await req('PUT', '/admin/update-trust/mode', { s: A1, body: { mode: 'signed_only', legacyPortalMigration: true } });
    const rid = r.body?.data?.request?.id;
    check(r.status === 200 && r.body?.data?.pendingReview === true && !!rid, 'enabling portal migration goes to review', JSON.stringify(r.body).slice(0, 200));
    const still = await prisma.platformSettings.findUnique({ where: { id: 'singleton' } });
    check(still.legacyPortalMigration === false, 'nothing changed while pending');
    const self = await req('POST', `/security-controls/trust-changes/${rid}/decision`, { s: A1, body: { decision: 'APPROVE' } });
    check(self.status === 403, 'requester cannot approve their own widening', `${self.status}`);
    const ok = await req('POST', `/security-controls/trust-changes/${rid}/decision`, { s: A2, body: { decision: 'APPROVE' } });
    check(ok.status === 200 || ok.status === 201, 'second admin approves', `${ok.status} ${JSON.stringify(ok.body).slice(0, 160)}`);
    const now = await prisma.platformSettings.findUnique({ where: { id: 'singleton' } });
    check(now.legacyPortalMigration === true && now.updateTrustMode === 'signed_only', 'applied after approval');
  }

  section('Portal-mediated migration (opt-in)');
  {
    const hb = await heartbeat(legacyEp);
    const d = hb.body?.data ?? hb.body;
    check(!!d?.reinstallAgent && d?.updateRustdesk === null, 'legacy agent gets only the reinstall flag', JSON.stringify(d).slice(0, 200));
    const ps = String((await req('GET', '/public/install/windows.ps1')).buf);
    check(ps.includes(sha(agentBin)) && /migrate --portal '/.test(ps) && /Get-FileHash/.test(ps), 'windows.ps1 is the migration script, pinned to the signed agent digest', ps.slice(0, 200));
    check(!/\biex\b|Invoke-Expression/i.test(ps), 'migration script pipes nothing into a shell');
  }

  section('Back to legacy_allowed (also reviewed)');
  {
    const r = await req('PUT', '/admin/update-trust/mode', { s: A2, body: { mode: 'legacy_allowed', legacyPortalMigration: false } });
    const rid = r.body?.data?.request?.id;
    check(r.body?.data?.pendingReview === true, 'loosening to legacy_allowed is a reviewed change');
    const ok = await req('POST', `/security-controls/trust-changes/${rid}/decision`, { s: A1, body: { decision: 'APPROVE' } });
    const now = await prisma.platformSettings.findUnique({ where: { id: 'singleton' } });
    check((ok.status === 200 || ok.status === 201) && now.updateTrustMode === 'legacy_allowed', 'approved by the other admin and applied');
  }
}

let crashed = null;
try { await main(); } catch (e) { crashed = e; console.error(e); }
finally {
  try {
    await prisma.trustChangeRequest.deleteMany({ where: { kind: 'update_trust', requestedById: { in: created.users } } });
    await prisma.rustdeskNode.deleteMany({ where: { endpointId: { in: created.endpoints } } });
    await prisma.endpoint.deleteMany({ where: { id: { in: created.endpoints } } });
    if (created.business) await prisma.customer.delete({ where: { id: created.business } }).catch(() => {});
    await prisma.securityAlert?.deleteMany?.({ where: { identity: { in: created.users.map((u) => `user:${u}`) } } }).catch(() => {});
    await prisma.membership.deleteMany({ where: { userId: { in: created.users } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: created.users } } }).catch(() => {});
    if (savedSettings) await prisma.platformSettings.update({ where: { id: 'singleton' }, data: { updateTrustMode: savedSettings.updateTrustMode, legacyPortalMigration: savedSettings.legacyPortalMigration, rustdeskPinnedVersion: savedSettings.rustdeskPinnedVersion } });
  } catch (e) { console.error('cleanup:', e.message); }
  api.kill('SIGTERM');
  await prisma.$disconnect();
}
console.log(`\n${fail ? '\x1b[31m✗' : '\x1b[32m✓'} ${pass} passed, ${fail} failed\x1b[0m`);
if (failures.length) for (const f of failures) console.log('  - ' + f);
process.exit(fail || crashed ? 1 : 0);
