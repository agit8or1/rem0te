#!/usr/bin/env node
/**
 * End-to-end: automatic migration to the signed agent, canary first (0.37),
 * and the Full agent page's API.
 *
 * Builds a throwaway signed update repository with the release tool (as
 * e2e-agent-upgrade does), starts its own API from dist/ with UPDATE_REPO_DIR
 * pointing at it and the sweep every second, and proves:
 *
 *   - nothing happens until a signed agent is published, nor in Signed only,
 *     nor with the mode off; turning it on (or shortening the soak) needs
 *     fresh authentication, turning it off does not; all audited; Platform
 *     Admin only;
 *   - canary selection: one computer, reporting and most recently heard
 *     from; never one under an updates pause, a staged rollout, an opt-out
 *     (business or device-group policy), offline, without a device secret,
 *     or whose move a person cancelled; the request is an ordinary
 *     AgentMigration (automatic, no requester, no per-computer audit entry)
 *     and the heartbeat hands that computer — only — the nonce, which serves
 *     the migration script pinned to the published digest;
 *   - the soak gate: another build does not confirm; the published build
 *     does; nothing else moves during the soak; after it, the canary must
 *     check in once more;
 *   - rolling, paced by the 0.36 per-hour number, skipping the same holds;
 *     mode off stops it, on resumes it;
 *   - a new build starts a new rollout and does not touch signed agents;
 *     a failed update result halts it (reason kept, the canary's request
 *     stopped, nobody else asked); resume (fresh) asks the same canary
 *     again; a timeout halts it; restart (fresh) picks another canary;
 *   - GET /agent-signing/overview: computers:view, counts only from visible
 *     computers (business A / B isolation), the canary named only to someone
 *     who can see it, fleet progress only for a Platform Admin, the step
 *     commands verbatim, the timestamp step's honesty;
 *   - AUTO_MIGRATION_SWEEP=off: a second API on its own port does nothing.
 *
 *   cd apps/api && npx nest build
 *   RELEASE_BIN=/path/to/rem0te-release DATABASE_URL=…/rem0te_auto_migration_test node scripts/e2e-auto-migration.mjs
 *
 * Self-starting on AUTO_MIGRATION_API_PORT (3911) and +1 (3912). Scratch
 * databases only. It refuses a database where other computers would be
 * migrated, because the sweep acts on every computer in it.
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const DB = process.env.DATABASE_URL ?? '';
const dbName = DB.split('/').pop()?.split('?')[0] ?? '';
if (!/scratch|test/.test(dbName)) { console.error(`Refusing to run against database "${dbName}": name must contain "scratch" or "test".`); process.exit(2); }
const BIN = process.env.RELEASE_BIN;
if (!BIN) { console.error('RELEASE_BIN (rem0te-release) is required'); process.exit(2); }
const PORT = Number(process.env.AUTO_MIGRATION_API_PORT ?? 3911);
const PORT2 = PORT + 1;
for (const p of [PORT, PORT2]) if ([3000, 3001, 443, 4000, 4001].includes(p)) { console.error(`Refusing port ${p}: that is a production or docs port.`); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const TAG = `AM${sfx}`;
const PW = 'auto-migration-e2e-password-1';
const MIN = 60_000, H = 60 * MIN;

let pass = 0, fail = 0; const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const ago = (ms) => new Date(Date.now() - ms);
async function waitFor(fn, ms = 15_000) {
  const end = Date.now() + ms;
  let v;
  while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(250); }
  return v;
}

// ── A throwaway repository, as rem0te-signed-publish would leave it ────────
const work = mkdtempSync(path.join(tmpdir(), 'rem0te-automig-'));
const keys = path.join(work, 'keys'); mkdirSync(keys);
const repo = path.join(work, 'repo');
const rel = (...a) => execFileSync(BIN, a, { encoding: 'utf8' });
for (const k of ['r1', 'r2', 'targets', 'snapshot', 'timestamp']) rel('keygen', '-out', path.join(keys, `${k}.pem`));
rel('init', '-repo', repo, '-root-key', path.join(keys, 'r1.pem'), '-root-key', path.join(keys, 'r2.pem'), '-root-threshold', '2',
  '-targets-key', path.join(keys, 'targets.pem'), '-snapshot-key', path.join(keys, 'snapshot.pem'), '-timestamp-key', path.join(keys, 'timestamp.pem'));
const files = path.join(work, 'files'); mkdirSync(files);
execFileSync(process.execPath, [path.join(here, 'build-signed-installer.mjs'), '--out', path.join(files, 'install.ps1')]);
const T = (n) => ['-targets-key', path.join(keys, 'targets.pem'), '-snapshot-key', path.join(keys, 'snapshot.pem'), '-timestamp-key', path.join(keys, 'timestamp.pem'), ...n];
const slot = Buffer.concat([Buffer.from('REM0TE_INST_URL:'), Buffer.alloc(240)]);
const fakeAgent = (label) => Buffer.concat([Buffer.from(`MZ fake signed agent ${label} `), randomBytes(64), slot, Buffer.from(' trailer')]);
rel('release', '-repo', repo, ...T(['-add', `windows/install.ps1=${path.join(files, 'install.ps1')}`]));
const VERSION_FILE = path.resolve(here, '..', '..', '..', 'version.json');
const VERSION = JSON.parse(readFileSync(VERSION_FILE, 'utf8')).version;
const COMMIT = 'c'.repeat(40);
function publishAgent(label, version = VERSION) {
  const bin = fakeAgent(label);
  const f = path.join(files, `agent-${label}.exe`);
  writeFileSync(f, bin);
  rel('release', '-repo', repo, ...T(['-add', `windows/rem0te-agent.exe=${f}`, '-custom', `windows/rem0te-agent.exe={"version":"${version}","commit":"${COMMIT}"}`]));
  return sha(bin);
}
const tsFile = path.join(repo, 'metadata', 'timestamp.json');
const withoutRepo = async (fn) => { renameSync(tsFile, `${tsFile}.off`); try { return await fn(); } finally { renameSync(`${tsFile}.off`, tsFile); } };

// ── API ─────────────────────────────────────────────────────────────────────
const baseEnv = {
  ...process.env, NODE_ENV: 'test', DATABASE_URL: DB, UPDATE_REPO_DIR: repo,
  JWT_SECRET: randomBytes(32).toString('hex'), LAUNCHER_TOKEN_SECRET: randomBytes(32).toString('hex'),
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? randomBytes(32).toString('hex'), TRUSTED_PROXIES: 'loopback',
  HBBS_PRESENCE_HOST: '127.0.0.2', MONITOR_SWEEP: 'off', CLIENT_UPDATE_SWEEP: 'off', PATCH_POLICY_SWEEP: 'off', METRIC_SWEEP: 'off', AUDIT_SEALER: 'off',
  STALE_SWEEP: 'off', SNAPSHOT_SWEEP: 'off', AGENT_AUTO_UPDATE: 'off', TRAY_SWEEP: 'off', RETENTION_SWEEP: 'off',
  AUTO_MIGRATION_SWEEP_SECONDS: '1', VERSION_FILE,
};
delete baseEnv.PUBLIC_API_URL;
delete baseEnv.AUTO_MIGRATION_SWEEP;
const apis = [];
async function startApi(port, extra = {}) {
  const a = spawn(process.execPath, [path.join(dist, 'main.js')], { env: { ...baseEnv, PORT: String(port), ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  a.log = ''; a.stdout.on('data', (d) => { a.log += d; }); a.stderr.on('data', (d) => { a.log += d; });
  apis.push(a);
  for (let i = 0; i < 150; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/api/v1/health`); if (r.status < 500) return a; } catch { /* not yet */ } await sleep(300); }
  throw new Error(`API on ${port} did not come up:\n${a.log.slice(-3000)}`);
}
const stopApi = (a) => (a && a.exitCode === null && a.signalCode === null ? new Promise((r) => { a.once('exit', r); a.kill('SIGTERM'); }) : undefined);

async function req(method, p, { s, body, base = API } = {}) {
  const h = { 'content-type': 'application/json', 'x-forwarded-for': ip() };
  if (s) h.cookie = s.cookie + (s.stepUp ? `; step_up=${s.stepUp}` : '');
  const r = await fetch(`${base}${p}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j, data: j?.data, text, setCookie: r.headers.get('set-cookie') ?? '' };
}
async function login(email) {
  const r = await req('POST', '/auth/login', { body: { email, password: PW } });
  const m = r.setCookie.match(/access_token=([^;]+)/);
  if (r.status !== 200 || !m) throw new Error(`login ${email}: ${r.status} ${r.text.slice(0, 200)}`);
  return { cookie: `access_token=${m[1]}` };
}
async function stepUp(s) {
  const r = await req('POST', '/auth/step-up', { s, body: { password: PW } });
  const m = r.setCookie.match(/step_up=([^;]+)/);
  if (r.status !== 200 || !m) throw new Error(`step-up: ${r.status} ${r.text.slice(0, 200)}`);
  return { ...s, stepUp: m[1] };
}
const code = (r) => r.body?.code ?? r.body?.message?.code;
const msg = (r) => `HTTP ${r.status} ${r.text.slice(0, 300)}`;
const hb = (ep, extra = {}) => req('POST', '/enrollment/heartbeat', { body: { rustdeskId: ep.rid, agentSecret: ep.secret, ...extra } }).then((r) => r.body?.data ?? r.body);
const signedHb = (ep, digest, extra = {}) => hb(ep, { updateChannel: 'signed', trustRootVersion: 1, targetsVersion: 3, agentSha256: digest, ...extra });
const setMode = (mode, legacyPortalMigration = false) => prisma.platformSettings.upsert({ where: { id: 'singleton' }, update: { updateTrustMode: mode, legacyPortalMigration }, create: { id: 'singleton', updateTrustMode: mode, legacyPortalMigration } });
const rolloutOf = (digest) => prisma.agentAutoMigration.findUnique({ where: { targetSha256: digest } });
const autoMigs = (where = {}) => prisma.agentMigration.findMany({ where: { automatic: true, endpointId: { in: fixtureIds }, ...where }, orderBy: { requestedAt: 'asc' } });
const overview = (s, q = '') => req('GET', `/agent-signing/overview${q}`, { s });
const settingsPut = (s, body) => req('PUT', '/admin/agent-auto-migration', { s, body });

const created = { users: [], businesses: [], groups: [], rollouts: [], digests: [] };
let fixtureIds = [];
let savedSettings = null;

let S;
async function main() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  const relay = (await prisma.tenantSettings.findFirst({ orderBy: { createdAt: 'asc' }, select: { rustdeskRelayHost: true } }))?.rustdeskRelayHost;
  if (!relay) throw new Error('the scratch database needs a relay host (seed with RUSTDESK_RELAY_HOST)');
  // The sweep acts on every computer in the database. Refuse one where it
  // would ask someone else's fixtures to migrate.
  const foreign = await prisma.endpoint.count({
    where: {
      platform: { startsWith: 'windows', mode: 'insensitive' }, OR: [{ updateChannel: null }, { updateChannel: { not: 'signed' } }],
      status: { not: 'ARCHIVED' }, isOnline: true, lastSeenAt: { gte: ago(30 * MIN) }, rustdeskNode: { agentSecretHash: { not: null } },
    },
  });
  if (foreign > 0) throw new Error(`Refusing: ${foreign} standard Windows computer(s) in this database are checking in, and the automatic migration would ask them to migrate. Use an empty scratch database.`);
  savedSettings = await prisma.platformSettings.findUnique({ where: { id: 'singleton' } });
  await setMode('legacy_allowed', false);
  await prisma.platformSettings.update({ where: { id: 'singleton' }, data: { agentAutoMigrationMode: 'canary_then_all', agentAutoMigrationSoakMinutes: 60, agentAutoUpdatePerHour: 120 } });

  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });
  const roleUser = await prisma.role.findFirst({ where: { type: 'BUSINESS_USER' } });
  const mkBiz = async (n) => { const b = await prisma.customer.create({ data: { tenantId: tenant.id, name: `${TAG} ${n}` } }); created.businesses.push(b.id); return b; };
  const A = await mkBiz('Acme'), B = await mkBiz('Birch'), C = await mkBiz('Contained'), D = await mkBiz('OptedOut');
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (t, extra = {}) => { const u = await prisma.user.create({ data: { email: `am-${t}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'AM', lastName: t, status: 'ACTIVE', ...extra } }); created.users.push(u.id); return u; };
  const admin = await mkUser('admin', { isPlatformAdmin: true });
  const ownerA = await mkUser('owner-a'), ownerB = await mkUser('owner-b'), userA = await mkUser('user-a');
  await prisma.membership.create({ data: { userId: ownerA.id, tenantId: tenant.id, customerId: A.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: ownerB.id, tenantId: tenant.id, customerId: B.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: userA.id, tenantId: tenant.id, customerId: A.id, roleId: roleUser.id, capabilities: ['computers:view'] } });

  const mkEp = async (biz, name, { platform = 'Windows', channel = null, agentVersion = VERSION, secret = true, online = true, seen = 10 * MIN, agentSha256 = null } = {}) => {
    const e = await prisma.endpoint.create({ data: {
      tenantId: tenant.id, customerId: biz.id, name, hostname: name.toLowerCase(), platform, status: 'ACTIVE', isOnline: online, isManaged: true,
      accessMode: 'COMPANY_WIDE', lastSeenAt: ago(seen), updateChannel: channel, agentVersion, agentSha256, deviceClass: 'WORKSTATION',
    } });
    const s = secret ? randomBytes(16).toString('hex') : null;
    const node = await prisma.rustdeskNode.create({ data: { tenantId: tenant.id, endpointId: e.id, rustdeskId: String(100000000 + ((Math.random() * 899999999) | 0)), ...(s ? { agentSecretHash: sha(s) } : {}) } });
    fixtureIds.push(e.id);
    return { id: e.id, rid: node.rustdeskId, secret: s, name };
  };
  // Every fixture is created "not checking in" (seen an hour ago) so that the
  // sweep cannot act before the API is up; each section sets lastSeenAt.
  const E = {};
  for (const [k, biz, o] of [
    ['a1', A, {}], ['a2', A, {}], ['a3', A, {}], ['aOld', A, { online: false }], ['aNoSecret', A, { secret: false }], ['aRoll', A, {}],
    ['aCancelled', A, {}], ['aGroup', A, {}], ['aSigned', A, { channel: 'signed' }], ['aLinux', A, { platform: 'linux' }], ['aMac', A, { platform: 'macos' }],
    ['b1', B, {}], ['b2', B, {}], ['c1', C, {}], ['d1', D, {}],
  ]) E[k] = await mkEp(biz, `${TAG}-${k.toUpperCase()}`, { seen: H, ...o });
  const reportNow = async (k, ms = 10_000) => prisma.endpoint.update({ where: { id: E[k].id }, data: { lastSeenAt: ago(ms), isOnline: true } });

  // Holds: C has an updates pause; D's business policy opts out; aGroup is in
  // a device group whose policy opts out; aRoll is owned by a staged rollout;
  // aCancelled had a move a person cancelled.
  await prisma.containmentPause.create({ data: { scope: 'BUSINESS', customerId: C.id, kinds: ['updates'], reason: `${TAG}: incident`, setById: admin.id, setBy: 'msp' } });
  await prisma.clientUpdatePolicy.create({ data: { tenantId: tenant.id, customerId: D.id, enabled: false, timeZone: 'UTC', windows: [{ days: [0, 1, 2, 3, 4, 5, 6], start: '01:00', end: '02:00' }], agentMode: 'OFF' } });
  const grp = await prisma.endpointGroup.create({ data: { tenantId: tenant.id, customerId: A.id, name: `${TAG} kiosks` } });
  created.groups.push(grp.id);
  await prisma.endpointGroupMember.create({ data: { endpointGroupId: grp.id, endpointId: E.aGroup.id } });
  await prisma.clientUpdatePolicy.create({ data: { tenantId: tenant.id, customerId: A.id, groupId: grp.id, priority: 1, enabled: false, timeZone: 'UTC', windows: [{ days: [0, 1, 2, 3, 4, 5, 6], start: '01:00', end: '02:00' }], agentMode: 'OFF' } });
  const ur = await prisma.updateRollout.create({ data: { name: `${TAG}`, component: 'AGENT', targetVersion: VERSION, status: 'PAUSED', createdById: admin.id } });
  created.rollouts.push(ur.id);
  await prisma.updateJob.create({ data: { rolloutId: ur.id, endpointId: E.aRoll.id, customerId: A.id, status: 'REQUESTED' } });
  await prisma.agentMigration.create({ data: { endpointId: E.aCancelled.id, tenantId: tenant.id, customerId: A.id, nonce: `mig_${randomBytes(30).toString('base64url')}`, reason: 'pilot, then not', requestedById: ownerA.id, cancelledAt: ago(H), cancelledById: ownerA.id } });
  check(true, 'fixtures: businesses A–D; standard, offline, unbound, rollout-owned, cancelled, group-opted-out, signed, Linux and macOS computers');

  const api = await startApi(PORT);
  S = {
    admin: await login(admin.email), ownerA: await login(ownerA.email), ownerB: await login(ownerB.email), userA: await login(userA.email),
  };
  S.adminUp = await stepUp(S.admin);
  S.ownerAUp = await stepUp(S.ownerA);

  // ── Nothing before a signed agent is published ─────────────────────────────
  section('Steps 1–3, and nothing before a signed agent is published');
  {
    for (const k of ['a1', 'a2', 'a3', 'b1', 'b2']) await reportNow(k);
    const noRepo = await withoutRepo(() => overview(S.ownerA));
    const s1 = noRepo.data?.steps?.signing;
    check(noRepo.status === 200 && s1?.done === false && s1.command === 'sudo ./deploy/release/rem0te-signed-setup.sh' && s1.docs === '/docs/update-signing#the-easy-way',
      'no repository: step 1 not done, with the setup command and the docs link', msg(noRepo));
    check(noRepo.data?.steps?.computers?.auto?.gate === 'no_repository', 'and the automatic migration waits for step 1', JSON.stringify(noRepo.data?.steps?.computers?.auto));
    const r = await overview(S.ownerA);
    const st = r.data?.steps;
    check(st?.signing?.done === true && st.published?.done === false && st.published.command === 'sudo rem0te-signed-publish' && st.published.portalVersion === VERSION,
      'repository, no agent: step 1 done, step 2 not, with the publish command', JSON.stringify(st?.published));
    check(st?.timestamp?.state === 'fresh' && st.timestamp.done === true && st.timestamp.command === 'sudo rem0te-signed-status' && st.timestamp.timer === 'rem0te-timestamp-refresh.timer' && !!st.timestamp.expires,
      'step 3: the timestamp\'s expiry, the status command and the timer name', JSON.stringify(st?.timestamp));
    check(!('timerActive' in (st?.timestamp ?? {})) && !/running/i.test(JSON.stringify(st?.timestamp ?? {})), 'the timestamp step never claims the timer runs');
    check(st?.computers?.auto?.gate === 'no_release' && st.computers.auto.mode === 'canary_then_all', 'the default mode is canary_then_all, waiting for step 2', JSON.stringify(st?.computers?.auto));
    await sleep(2500);
    check((await prisma.agentAutoMigration.count()) === 0 && (await autoMigs()).length === 0, 'the sweep made no rollout and asked no computer');
  }

  // ── Signed only, and the mode switch ───────────────────────────────────────
  section('Signed only, mode off, and changing the setting');
  let D1;
  {
    await setMode('signed_only', false);
    D1 = publishAgent('one'); created.digests.push(D1);
    await sleep(2500);
    check(!(await rolloutOf(D1)) && (await autoMigs()).length === 0, 'published, but the portal is in Signed only: nothing');
    let o = await overview(S.admin);
    check(o.data?.steps?.computers?.auto?.gate === 'signed_only' && o.data.steps.published.done && o.data.steps.published.agent?.sha256 === D1 && o.data.steps.published.agent.version === VERSION && o.data.steps.published.agent.commit === COMMIT,
      'the page says why, and shows the published version and commit from the signed target', JSON.stringify(o.data?.steps?.published));
    await setMode('signed_only', true);
    await sleep(2000);
    check(!(await rolloutOf(D1)), 'Signed only + portal migration: still nothing (every standard agent is handed the migration anyway)');

    let r = await settingsPut(S.ownerAUp, { mode: 'off' });
    check(r.status === 403, 'a business owner cannot change it', msg(r));
    r = await settingsPut(S.admin, { mode: 'off' });
    check(r.status === 200 && r.data?.mode === 'off', 'turning it off needs no fresh sign-in', msg(r));
    await setMode('legacy_allowed', false);
    await sleep(2500);
    check(!(await rolloutOf(D1)), 'mode off: nothing, though everything else is ready');
    r = await settingsPut(S.admin, { mode: 'canary_then_all' });
    check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED', 'turning it on without a fresh sign-in: refused (STEP_UP_REQUIRED)', msg(r));
    r = await settingsPut(S.adminUp, { mode: 'canary_then_all', soakMinutes: 14 });
    check(r.status === 400, 'a soak under 15 minutes is refused', msg(r));
    r = await settingsPut(S.adminUp, { soakMinutes: 120 });
    check(r.status === 200 && r.data?.soakMinutes === 120 && r.data.mode === 'off', 'lengthening the soak while off', msg(r));
    // Place the fixtures before it goes on: the most recent check-ins are all
    // held computers; A2 is the newest eligible one, A1 older; aOld is
    // offline; A3, B1 and B2 are not checking in yet.
    await prisma.$transaction([
      ...['c1', 'd1', 'aRoll', 'aCancelled', 'aGroup', 'aNoSecret'].map((k) => prisma.endpoint.update({ where: { id: E[k].id }, data: { lastSeenAt: ago(5_000), isOnline: true } })),
      prisma.endpoint.update({ where: { id: E.a2.id }, data: { lastSeenAt: ago(60_000), isOnline: true } }),
      prisma.endpoint.update({ where: { id: E.a1.id }, data: { lastSeenAt: ago(5 * MIN), isOnline: true } }),
      prisma.endpoint.update({ where: { id: E.aOld.id }, data: { lastSeenAt: ago(5_000), isOnline: false } }),
      ...['a3', 'b1', 'b2'].map((k) => prisma.endpoint.update({ where: { id: E[k].id }, data: { lastSeenAt: ago(H) } })),
    ]);
    r = await settingsPut(S.adminUp, { mode: 'canary_then_all', soakMinutes: 60 });
    check(r.status === 200 && r.data?.mode === 'canary_then_all' && r.data.soakMinutes === 60, 'turning it on with a fresh sign-in', msg(r));
    const au = await prisma.activityLog.findMany({ where: { action: 'AGENT_AUTO_MIGRATION_SETTINGS_CHANGED', actorId: admin.id }, orderBy: { createdAt: 'asc' } });
    check(au.length === 3 && au[2].metadata?.before?.mode === 'off' && au[2].metadata?.after?.mode === 'canary_then_all', 'each change audited with before and after', JSON.stringify(au.map((x) => x.metadata)));
    r = await settingsPut(S.admin, { soakMinutes: 30 });
    check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED', 'shortening the soak while on needs a fresh sign-in', msg(r));
    o = await req('GET', '/admin/agent-auto-migration', { s: S.ownerA });
    check(o.status === 403, 'the settings route is Platform Admin only', msg(o));
  }

  // ── The canary ─────────────────────────────────────────────────────────────
  section('Canary: one computer, reporting, most recently heard from, never a held one');
  let canaryMig;
  {
    const ro = await waitFor(async () => { const x = await rolloutOf(D1); return x?.state === 'canary' ? x : null; });
    check(!!ro && ro.canaryEndpointId === E.a2.id, 'the canary is A2: the most recently heard-from computer that is eligible', JSON.stringify({ state: ro?.state, canary: ro?.canaryEndpointId, a2: E.a2.id }));
    const migs = await autoMigs();
    check(migs.length === 1 && migs[0].endpointId === E.a2.id && migs[0].requestedById === null && migs[0].rolloutId === ro?.id,
      'exactly one automatic request, for the canary, with no requester', JSON.stringify(migs.map((m) => m.endpointId)));
    canaryMig = migs[0];
    check(!migs.some((m) => [E.c1, E.d1, E.aRoll, E.aCancelled, E.aGroup, E.aNoSecret, E.aOld].some((e) => e.id === m.endpointId)),
      'not the contained, opted-out (business and group), rollout-owned, cancelled, unbound or offline ones');
    check((await prisma.activityLog.count({ where: { action: 'AGENT_MIGRATION_REQUESTED', resourceId: E.a2.id } })) === 0
      && (await prisma.activityLog.count({ where: { action: 'AGENT_AUTO_MIGRATION_CANARY_CHOSEN', resourceId: ro?.id, actorId: null } })) === 1,
    'audited once as the system (CANARY_CHOSEN), not as a per-computer request');
    const d = await hb(E.a2);
    check(d?.reinstallAgent?.nonce === canaryMig.nonce, 'the canary\'s heartbeat is handed its nonce', JSON.stringify(d?.reinstallAgent));
    const other = await hb(E.a1);
    check(!other?.reinstallAgent?.nonce, 'another computer\'s heartbeat is not', JSON.stringify(other?.reinstallAgent));
    const ps = await req('GET', `/public/install/windows.ps1?updateNonce=${canaryMig.nonce}`);
    check(ps.status === 200 && ps.text.includes(`/api/v1/public/updates/targets/windows/${D1}.rem0te-agent.exe`) && ps.text.includes(`-ne '${D1}'`),
      'the nonce serves the same migration script, pinned to the published digest', ps.text.slice(0, 300));
    const ctr = await prisma.platformSettings.findUnique({ where: { id: 'singleton' }, select: { updateTrustMode: true, legacyPortalMigration: true } });
    check(ctr.updateTrustMode === 'legacy_allowed' && ctr.legacyPortalMigration === false, 'the update-trust mode is untouched');
  }

  // ── The soak gate ──────────────────────────────────────────────────────────
  section('The soak gate');
  {
    await signedHb(E.a2, 'e'.repeat(64));
    await sleep(2000);
    check((await rolloutOf(D1))?.state === 'canary', 'the canary on another signed build does not confirm');
    await signedHb(E.a2, D1, { agentUpdateCheckedAt: new Date().toISOString(), agentUpdateResult: 'installer exit 0' });
    const ro = await waitFor(async () => { const x = await rolloutOf(D1); return x?.state === 'soaking' ? x : null; });
    check(!!ro && !!ro.canaryConfirmedAt, 'on the published build: soaking', JSON.stringify(ro));
    check(!!(await prisma.agentMigration.findUnique({ where: { id: canaryMig.id } }))?.completedAt, 'its request completed by the signed heartbeat, as any request');
    for (const k of ['a1', 'a3', 'b1', 'b2']) await reportNow(k);
    await sleep(2500);
    check((await autoMigs()).length === 1, 'during the soak nobody else is asked');
    const o = await overview(S.admin);
    const ra = o.data?.steps?.computers?.auto?.rollout;
    check(ra?.state === 'soaking' && !!ra.soakEndsAt && Math.abs(new Date(ra.soakEndsAt).getTime() - (ro.canaryConfirmedAt.getTime() + 60 * MIN)) < 2000 && ra.canary?.id === E.a2.id,
      'the page: soaking, the soak\'s end, and the canary', JSON.stringify(ra));
    // Soak over, but the canary's last check-in was before it ended.
    await prisma.$transaction([
      prisma.agentAutoMigration.update({ where: { id: ro.id }, data: { canaryConfirmedAt: ago(61 * MIN) } }),
      prisma.endpoint.update({ where: { id: E.a2.id }, data: { lastSeenAt: ago(2 * MIN) } }),
    ]);
    await sleep(2500);
    check((await rolloutOf(D1))?.state === 'soaking' && (await autoMigs()).length === 1, 'soak over, no check-in since: still soaking, nobody asked');
    await signedHb(E.a2, D1);
    const rr = await waitFor(async () => { const x = await rolloutOf(D1); return x?.state === 'rolling' ? x : null; });
    check(!!rr && !!rr.rollingAt, 'the canary checks in on the build after the soak: rolling', JSON.stringify(rr?.state));
    check((await prisma.activityLog.count({ where: { action: { in: ['AGENT_AUTO_MIGRATION_CANARY_CONFIRMED', 'AGENT_AUTO_MIGRATION_ROLLING'] }, resourceId: ro.id, actorId: null } })) === 2, 'confirmed and rolling audited as the system');
  }

  // ── Rolling, paced ─────────────────────────────────────────────────────────
  section('Rolling: paced, skipping the same holds');
  const R1 = await rolloutOf(D1);
  {
    // The pace (0.36's per-hour number) is 3; the canary already used one this hour.
    await prisma.platformSettings.update({ where: { id: 'singleton' }, data: { agentAutoUpdatePerHour: 3 } });
    await sleep(2500);
    let migs = await autoMigs({ rolloutId: R1.id });
    check(migs.length === 3, 'per hour 3, one used by the canary: two more asked', JSON.stringify(migs.map((m) => m.endpointId)));
    await sleep(2000);
    check((await autoMigs({ rolloutId: R1.id })).length === 3, 'and no more this hour');
    const r = await settingsPut(S.admin, { mode: 'off' });
    check(r.status === 200, 'mode off mid-rollout');
    await prisma.agentMigration.updateMany({ where: { rolloutId: R1.id }, data: { requestedAt: ago(2 * H) } });
    await sleep(2500);
    check((await autoMigs({ rolloutId: R1.id })).length === 3, 'mode off: nothing more, though the pace allows it');
    await settingsPut(S.adminUp, { mode: 'canary_then_all' });
    migs = await waitFor(async () => { const x = await autoMigs({ rolloutId: R1.id }); return x.length >= 5 ? x : null; });
    const asked = new Set((migs ?? []).map((m) => m.endpointId));
    check(!!migs && ['a1', 'a2', 'a3', 'b1', 'b2'].every((k) => asked.has(E[k].id)), 'on again: the rest of the eligible computers are asked', JSON.stringify([...asked]));
    await sleep(2000);
    const all = new Set((await autoMigs()).map((m) => m.endpointId));
    const held = ['c1', 'd1', 'aRoll', 'aCancelled', 'aGroup', 'aNoSecret', 'aOld', 'aSigned', 'aLinux', 'aMac'];
    check(held.every((k) => !all.has(E[k].id)), 'never: updates pause, business opt-out, group opt-out, staged rollout, cancelled by a person, no device secret, offline, signed, Linux, macOS',
      JSON.stringify(held.filter((k) => all.has(E[k].id))));
    const d = await hb(E.b1);
    check(!!d?.reinstallAgent?.nonce, 'B1\'s heartbeat is handed its own nonce');

    // The page, scoped.
    const oa = await overview(S.ownerA), ob = await overview(S.ownerB), ou = await overview(S.userA), oadm = await overview(S.admin);
    const ca = oa.data?.steps?.computers, cb = ob.data?.steps?.computers;
    const aIds = new Set(['a1', 'a2', 'a3', 'aOld', 'aNoSecret', 'aRoll', 'aCancelled', 'aGroup', 'aSigned', 'aLinux', 'aMac'].map((k) => E[k].id));
    check(oa.status === 200 && ca.total === 11 && ca.rows.every((x) => aIds.has(x.id)), 'owner A: only business A\'s 11 computers', JSON.stringify({ total: ca?.total }));
    check(ob.status === 200 && cb.total === 2 && cb.rows.every((x) => x.id === E.b1.id || x.id === E.b2.id) && cb.counts.migrating === 2,
      'owner B: only business B\'s 2 computers, both migrating', JSON.stringify(cb?.counts));
    check(ca.counts.signed === 2 && ca.counts.migrating === 2 && ca.counts.not_eligible === 2 && ca.notEligible.linux === 1 && ca.notEligible.macos === 1,
      'A: signed 2 (the canary and the signed one), migrating 2, not eligible 2 (Linux, macOS)', JSON.stringify({ c: ca.counts, n: ca.notEligible }));
    check(ca.counts.held === 5 && ca.holds.rollout === 1 && ca.holds.opted_out === 1 && ca.holds.cancelled_by_person === 1 && ca.holds.no_device_secret === 1 && ca.holds.offline === 1,
      'A held 5, with reasons: rollout, group opt-out, cancelled by a person, no device secret, offline', JSON.stringify(ca.holds));
    check(ca.signedOnBuild === 1, 'A: one computer on the published build');
    check(ca.auto.rollout?.canary?.id === E.a2.id && cb.auto.rollout?.canary?.id === null && /another business/.test(cb.auto.rollout?.canary?.name ?? ''),
      'the canary is named to A, and to B only as "a computer in another business"', JSON.stringify(cb.auto.rollout?.canary));
    check(ca.auto.rollout?.progress === null && cb.auto.rollout?.progress === null && oadm.data?.steps?.computers?.auto?.rollout?.progress?.requested >= 5,
      'fleet-wide progress only for a Platform Admin', JSON.stringify(oadm.data?.steps?.computers?.auto?.rollout?.progress));
    check(ou.status === 200 && ou.data.steps.computers.total === 11, 'a business user with computers:view sees the page (A\'s computers)');
    const anon = await req('GET', '/agent-signing/overview');
    check(anon.status === 401, 'not signed in: 401', msg(anon));
    const cross = await overview(S.ownerA, `?businessId=${B.id}`);
    check(cross.status !== 200 || cross.data.steps.computers.rows.every((x) => aIds.has(x.id)), 'owner A asking for business B gets none of B\'s computers', msg(cross));
  }

  // ── A new build: a new rollout, a failed canary, resume, timeout, restart ──
  section('A new build: a new canary; a failure halts; resume; a timeout halts; restart');
  let D2;
  {
    // R1's computers finish on build one; two fresh standard computers appear.
    for (const k of ['a1', 'a3', 'b1']) await signedHb(E[k], D1);
    E.a6 = await mkEp(A, `${TAG}-A6`, { seen: H }); E.a7 = await mkEp(A, `${TAG}-A7`, { seen: H });
    await prisma.platformSettings.update({ where: { id: 'singleton' }, data: { agentAutoUpdatePerHour: 120 } });
    D2 = publishAgent('two'); created.digests.push(D2);
    await prisma.$transaction([
      prisma.endpoint.update({ where: { id: E.a6.id }, data: { lastSeenAt: ago(10_000), isOnline: true } }),
      prisma.endpoint.update({ where: { id: E.a7.id }, data: { lastSeenAt: ago(60_000), isOnline: true } }),
    ]);
    const ro = await waitFor(async () => { const x = await rolloutOf(D2); return x?.state === 'canary' ? x : null; });
    check(!!ro && ro.canaryEndpointId === E.a6.id, 'build two: a new rollout with its own canary (A6)', JSON.stringify(ro));
    const signedAgain = await prisma.agentMigration.count({ where: { endpointId: { in: [E.a1.id, E.a2.id, E.a3.id, E.b1.id, E.aSigned.id] }, rolloutId: ro?.id } });
    check(signedAgain === 0, 'computers already on the signed agent are not migrated again (they update themselves)');
    const m6 = (await autoMigs({ rolloutId: ro.id }))[0];
    await hb(E.a6, { agentUpdateCheckedAt: new Date().toISOString(), agentUpdateResult: 'installer exit 12' });
    const h = await waitFor(async () => { const x = await rolloutOf(D2); return x?.state === 'halted' ? x : null; });
    check(!!h && h.haltCode === 'canary_failed' && /installer exit 12/.test(h.haltReason), 'the canary reports a failed update: halted, with the result', JSON.stringify(h));
    const m6b = await prisma.agentMigration.findUnique({ where: { id: m6.id } });
    check(!!m6b.cancelledAt && m6b.cancelledById === null, 'its automatic request is stopped (by the system), so it is not re-run every 30 minutes');
    await sleep(2000);
    check((await autoMigs({ rolloutId: ro.id })).length === 1, 'halted: nobody else is asked (A7 waits)');
    const o = await overview(S.ownerA);
    check(o.data?.steps?.computers?.auto?.rollout?.state === 'halted' && /installer exit 12/.test(o.data.steps.computers.auto.rollout.halted?.reason ?? ''), 'the page shows the halt and its reason');
    check((await prisma.activityLog.count({ where: { action: 'AGENT_AUTO_MIGRATION_HALTED', resourceId: ro.id } })) === 1, 'halt audited');

    let r = await req('POST', '/admin/agent-auto-migration/resume', { s: S.admin });
    check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED', 'resume without a fresh sign-in: refused', msg(r));
    r = await req('POST', '/admin/agent-auto-migration/resume', { s: S.ownerAUp });
    check(r.status === 403, 'resume as a business owner: refused', msg(r));
    r = await req('POST', '/admin/agent-auto-migration/resume', { s: S.adminUp });
    check(r.status === 200 && r.data?.state === 'canary', 'resume (fresh): the same canary is asked again', msg(r));
    const ro2 = await rolloutOf(D2);
    check(ro2.canaryEndpointId === E.a6.id && ro2.canaryMigrationId !== m6.id && !ro2.haltCode, 'a new request for A6, halt cleared');
    // The canary never reports: two hours pass.
    // (Its earlier failed result moves back with the clock: it was reported before this request.)
    await prisma.$transaction([
      prisma.agentAutoMigration.update({ where: { id: ro2.id }, data: { canaryRequestedAt: ago(2 * H + MIN) } }),
      prisma.endpoint.update({ where: { id: E.a6.id }, data: { agentUpdateCheckedAt: ago(3 * H) } }),
    ]);
    const h2 = await waitFor(async () => { const x = await rolloutOf(D2); return x?.state === 'halted' ? x : null; });
    check(!!h2 && h2.haltCode === 'canary_not_confirmed', 'not confirmed within 2 hours: halted', JSON.stringify(h2?.haltCode));
    r = await req('POST', '/admin/agent-auto-migration/restart', { s: S.admin });
    check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED', 'restart without a fresh sign-in: refused', msg(r));
    r = await req('POST', '/admin/agent-auto-migration/restart', { s: S.adminUp });
    check(r.status === 200 && r.data?.state === 'choosing_canary', 'restart (fresh): choosing another canary', msg(r));
    const ro3 = await waitFor(async () => { const x = await rolloutOf(D2); return x?.state === 'canary' ? x : null; });
    check(!!ro3 && ro3.canaryEndpointId === E.a7.id && ro3.rejectedCanaryIds.includes(E.a6.id), 'another canary: A7; A6 is not picked again for this build', JSON.stringify(ro3));
    check((await prisma.activityLog.count({ where: { action: { in: ['AGENT_AUTO_MIGRATION_RESUMED', 'AGENT_AUTO_MIGRATION_RESTARTED'] }, resourceId: ro.id, actorId: admin.id } })) === 2, 'resume and restart audited with the admin');
    r = await req('POST', '/admin/agent-auto-migration/resume', { s: S.adminUp });
    check(r.status === 409 && code(r) === 'NOT_HALTED', 'resume when not halted: 409 NOT_HALTED', msg(r));
  }

  await stopApi(api);

  // ── The off switch ─────────────────────────────────────────────────────────
  section('AUTO_MIGRATION_SWEEP=off');
  {
    const api2 = await startApi(PORT2, { AUTO_MIGRATION_SWEEP: 'off' });
    const D3 = publishAgent('three'); created.digests.push(D3);
    E.a8 = await mkEp(A, `${TAG}-A8`, { seen: 5_000 });
    await sleep(3500);
    check(!(await rolloutOf(D3)) && (await prisma.agentMigration.count({ where: { endpointId: E.a8.id } })) === 0, 'a published build and an eligible computer, but the sweep is off: nothing');
    const o = await req('GET', '/agent-signing/overview', { s: S.admin, base: `http://127.0.0.1:${PORT2}/api/v1` });
    check(o.data?.steps?.computers?.auto?.gate === 'process_off' && /AUTO_MIGRATION_SWEEP=off/.test(o.data.steps.computers.auto.gateText), 'and the page says so', JSON.stringify(o.data?.steps?.computers?.auto?.gate));
    await stopApi(api2);
  }
}

async function cleanup() {
  try {
    const ids = created.businesses;
    const epIds = fixtureIds;
    await prisma.agentAutoMigration.deleteMany({ where: { targetSha256: { in: created.digests } } });
    await prisma.agentMigration.deleteMany({ where: { endpointId: { in: epIds } } });
    await prisma.containmentPause.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.updateRollout.deleteMany({ where: { id: { in: created.rollouts } } });
    await prisma.clientUpdatePolicy.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.endpointGroupMember.deleteMany({ where: { endpointGroupId: { in: created.groups } } });
    await prisma.endpointGroup.deleteMany({ where: { id: { in: created.groups } } });
    await prisma.endpointCommand.deleteMany({ where: { endpointId: { in: epIds } } });
    await prisma.rustdeskNode.deleteMany({ where: { endpointId: { in: epIds } } });
    await prisma.endpoint.deleteMany({ where: { id: { in: epIds } } });
    await prisma.membership.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.customer.deleteMany({ where: { id: { in: ids } } });
    if (created.users.length) {
      await prisma.privilegedActivity.deleteMany({ where: { identity: { in: created.users.map((u) => `user:${u}`) } } }).catch(() => undefined);
      await prisma.user.deleteMany({ where: { id: { in: created.users } } });
    }
    if (savedSettings) {
      await prisma.platformSettings.update({ where: { id: 'singleton' }, data: {
        updateTrustMode: savedSettings.updateTrustMode, legacyPortalMigration: savedSettings.legacyPortalMigration,
        agentAutoMigrationMode: savedSettings.agentAutoMigrationMode, agentAutoMigrationSoakMinutes: savedSettings.agentAutoMigrationSoakMinutes,
        agentAutoUpdatePerHour: savedSettings.agentAutoUpdatePerHour,
      } });
    }
    rmSync(work, { recursive: true, force: true });
  } catch (e) { console.error('cleanup:', e.message); }
}

main()
  .catch((e) => { fail++; failures.push(`crashed: ${e.stack ?? e}`); console.error(e); for (const a of apis) if (a?.log) console.error(a.log.slice(-2000)); })
  .finally(async () => {
    for (const a of apis) await stopApi(a);
    await cleanup();
    await prisma.$disconnect();
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
    console.log('ALL PASSED');
  });
