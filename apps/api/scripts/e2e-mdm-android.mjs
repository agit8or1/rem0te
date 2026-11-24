#!/usr/bin/env node
/**
 * End-to-end proof of Rem0te as the EMM for Android (0.85 Mooring,
 * docs/own-mdm.md M3, invariant §94), against the real built API, a scratch
 * database and a loopback stand-in in the shape of Google's Android
 * Management API. No Google host is called: the API runs under NODE_ENV=test
 * with AMAPI_TEST_BASE_URL on 127.0.0.1, and the service-account key is a
 * TEST ONLY stand-in made at run time (lib/test-pki.mjs).
 *
 *   - Platform Admin only; every write asks for fresh authentication on
 *     `ask` (mdm.setup; a token names mdm.enroll);
 *   - the connection test: a JWT-bearer token exchange (the JWT verifies
 *     under the uploaded key) and one read call; a refused key is
 *     `bad_key`; a global integration pause refuses it before any request;
 *     a new key resets the result;
 *   - sign-up: signupUrls.create with a callback naming a one-time state;
 *     only the state's SHA-256 is stored; Google's redirect (simulated) is
 *     claimed once — five racing callbacks bind one enterprise; a replay,
 *     an expired or unknown state, a missing enterprise token, an admin who
 *     is no longer a Platform Admin and a pause each fail with a code;
 *   - the default policy: policies.patch with exactly software and app
 *     reports; a token before it is refused;
 *   - enrollment tokens: one-time, an hour by default, work profile or fully
 *     managed per token, a QR code and the value shown once and never
 *     stored or audited;
 *   - the quota, recorded by hand;
 *   - the sync (MDM_SWEEP on): one `android` connector per bound enterprise,
 *     a paged devices.list asking only DEVICE_FIELDS, a personal device's
 *     serial dropped, an unknown state skipped, Operations as commands
 *     (accepted ≠ completed), a device gone from a complete listing marked
 *     not reported, a business pause skipping that enterprise, an
 *     unfinished sign-up expired;
 *   - nothing secret in a response, an audit row or the API's output; no
 *     command or device deletion was ever sent.
 *
 *   cd apps/api && npx nest build
 *   DATABASE_URL=postgresql://…/<name containing scratch or test> node scripts/e2e-mdm-android.mjs
 *
 * Ports 4081 (API), 4082 (the second API, with the MDM sweep on), 4083 (the
 * stand-in). Never 3001.
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { spawn } from 'node:child_process';
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, URL, URLSearchParams } from 'node:url';
import { confirmEverythingAsks } from './lib/confirm-asks.mjs';
import { serviceAccountJson } from './lib/test-pki.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const DB = process.env.DATABASE_URL ?? '';
const dbName = DB.split('/').pop()?.split('?')[0] ?? '';
if (!/scratch|test/.test(dbName)) { console.error(`Refusing to run against database "${dbName}": name must contain "scratch" or "test".`); process.exit(2); }
const PORT = Number(process.env.MDM_ANDROID_API_PORT ?? 4081);
const STANDIN = PORT + 2;
if (PORT < 4081 || PORT > 4082 || STANDIN > 4084) { console.error(`Refusing port ${PORT}: this suite uses 4081–4083.`); process.exit(2); }
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex').toUpperCase();
const PW = 'mdm-android-e2e-password-123';

let pass = 0, fail = 0;
const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;
const J = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? String(x) : x));
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

// ── The AMAPI-shaped stand-in ───────────────────────────────────────────────
const G = {
  hits: [], tokens: 0, rejectKey: false, failPolicyOnce: false, signups: new Map(), enterprises: [], policies: new Map(), tokensMade: [],
  devices: new Map(), issuedAccess: new Set(), enrollValues: [],
};
const DEVICE_FIELDS_SEEN = [];
function device(e, n, o = {}) {
  return {
    name: `enterprises/${e}/devices/dev${n}`, state: 'ACTIVE', ownership: 'COMPANY_OWNED', managementMode: 'DEVICE_OWNER',
    enrollmentTime: '2026-11-20T10:00:00Z', lastStatusReportTime: new Date().toISOString(), policyCompliant: true,
    hardwareInfo: { brand: 'google', model: 'Pixel 8', manufacturer: 'Google', serialNumber: `SER${n}` }, softwareInfo: { androidVersion: '15' },
    // What a real server could send if `fields` were ignored: never kept.
    networkInfo: { imei: `49015420323${String(n).padStart(4, '0')}`, wifiMacAddress: 'aa:bb:cc:dd:ee:ff', telephonyInfos: [{ phoneNumber: '+15555550100' }] },
    userName: `enterprises/${e}/users/u${n}`, ...o,
  };
}
const standin = http.createServer((req, res) => {
  let raw = ''; req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    const hit = { method: req.method, path: u.pathname, q: Object.fromEntries(u.searchParams), auth: req.headers.authorization ?? null, body: raw };
    G.hits.push(hit);
    const send = (s, j) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(J(j)); };
    if (u.pathname === '/token' && req.method === 'POST') {
      const f = new URLSearchParams(raw);
      hit.assertion = f.get('assertion');
      if (G.rejectKey || f.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:jwt-bearer') return send(400, { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' });
      const t = `ya29.standin-${++G.tokens}-${randomBytes(8).toString('hex')}`;
      G.issuedAccess.add(t);
      return send(200, { access_token: t, expires_in: 3599, token_type: 'Bearer' });
    }
    if (!G.issuedAccess.has((req.headers.authorization ?? '').replace(/^Bearer /, ''))) return send(401, { error: { code: 401, status: 'UNAUTHENTICATED' } });
    let m;
    if (u.pathname === '/v1/enterprises' && req.method === 'GET') return send(200, {});
    if (u.pathname === '/v1/signupUrls' && req.method === 'POST') {
      const name = `signupUrls/C${randomBytes(8).toString('hex')}`;
      const enterpriseToken = `EAH${randomBytes(12).toString('base64url')}`;
      G.signups.set(name, { callbackUrl: u.searchParams.get('callbackUrl'), enterpriseToken, projectId: u.searchParams.get('projectId') });
      return send(200, { name, url: `https://signup.example.com/adminsignup?token=${randomBytes(6).toString('hex')}` });
    }
    if (u.pathname === '/v1/enterprises' && req.method === 'POST') {
      const s = G.signups.get(u.searchParams.get('signupUrlName'));
      if (!s || s.enterpriseToken !== u.searchParams.get('enterpriseToken') || s.used) return send(400, { error: { code: 400, status: 'INVALID_ARGUMENT' } });
      s.used = true;
      const id = `LC0${randomBytes(5).toString('hex')}`;
      G.enterprises.push(id);
      return send(200, { name: `enterprises/${id}`, enterpriseDisplayName: 'x' });
    }
    if ((m = u.pathname.match(/^\/v1\/enterprises\/([A-Za-z0-9_-]+)\/policies\/([A-Za-z0-9_-]+)$/)) && req.method === 'PATCH') {
      if (G.failPolicyOnce) { G.failPolicyOnce = false; return send(503, { error: { code: 503, status: 'UNAVAILABLE' } }); }
      const v = (G.policies.get(m[1])?.version ?? 0) + 1;
      G.policies.set(m[1], { id: m[2], body: JSON.parse(raw), version: v });
      return send(200, { name: `enterprises/${m[1]}/policies/${m[2]}`, version: String(v), ...JSON.parse(raw) });
    }
    if ((m = u.pathname.match(/^\/v1\/enterprises\/([A-Za-z0-9_-]+)\/enrollmentTokens$/)) && req.method === 'POST') {
      const b = JSON.parse(raw);
      G.tokensMade.push({ enterprise: m[1], body: b });
      const value = randomBytes(10).toString('hex').toUpperCase();
      G.enrollValues.push(value);
      const secs = Number(String(b.duration).replace(/s$/, ''));
      return send(200, {
        name: `enterprises/${m[1]}/enrollmentTokens/tok${G.tokensMade.length}`, value, policyName: b.policyName, oneTimeOnly: b.oneTimeOnly, allowPersonalUsage: b.allowPersonalUsage,
        expirationTimestamp: new Date(Date.now() + secs * 1000).toISOString(),
        qrCode: J({ 'android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME': 'com.google.android.apps.work.clouddpc/.receivers.CloudDeviceAdminReceiver', 'android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE': { 'com.google.android.apps.work.clouddpc.EXTRA_ENROLLMENT_TOKEN': value } }),
      });
    }
    if ((m = u.pathname.match(/^\/v1\/enterprises\/([A-Za-z0-9_-]+)\/devices$/)) && req.method === 'GET') {
      DEVICE_FIELDS_SEEN.push(u.searchParams.get('fields'));
      const all = G.devices.get(m[1]) ?? [];
      const start = Number(u.searchParams.get('pageToken')?.replace(/^p/, '') ?? 0);
      const size = Math.min(100, Number(u.searchParams.get('pageSize') ?? 100));
      const page = all.slice(start, start + size);
      return send(200, { devices: page, ...(start + size < all.length ? { nextPageToken: `p${start + size}` } : {}) });
    }
    if ((m = u.pathname.match(/^\/v1\/enterprises\/([A-Za-z0-9_-]+)\/devices\/([A-Za-z0-9._:-]+)\/operations$/)) && req.method === 'GET') {
      const d = m[2];
      if (d === 'dev1') return send(200, { operations: [
        { name: `enterprises/${m[1]}/devices/dev1/operations/1700000000001`, metadata: { type: 'LOCK', createTime: '2026-11-24T08:00:00Z', duration: '600s' }, done: true },
        { name: `enterprises/${m[1]}/devices/dev1/operations/1700000000002`, metadata: { type: 'REBOOT', createTime: '2026-11-24T08:00:00Z' }, done: true },
      ] });
      if (d === 'dev2') return send(200, { operations: [
        { name: `enterprises/${m[1]}/devices/dev2/operations/1700000000003`, metadata: { type: 'WIPE', createTime: new Date().toISOString(), duration: '86400s' }, done: true, error: { code: 9, message: 'internal detail' } },
        { name: `enterprises/${m[1]}/devices/dev2/operations/1700000000004`, metadata: { type: 'START_LOST_MODE', createTime: new Date().toISOString(), duration: '86400s' } },
      ] });
      if (d === 'dev3') return send(501, { error: { code: 501, status: 'UNIMPLEMENTED' } });
      return send(200, {});
    }
    return send(404, { error: { code: 404, status: 'NOT_FOUND' } });
  });
});

// ── The API ─────────────────────────────────────────────────────────────────
const JWT = randomBytes(32).toString('hex'), LTS = randomBytes(32).toString('hex'), ENC = randomBytes(32).toString('hex');
const OFF = {
  INTEGRATION_PEERS_FILE: '', REPORT_SCHEDULE_SWEEP: 'off', AUDIT_SEALER: 'off', STALE_SWEEP: 'off', MONITOR_SWEEP: 'off',
  CLIENT_UPDATE_SWEEP: 'off', PATCH_POLICY_SWEEP: 'off', METRIC_SWEEP: 'off', RETENTION_SWEEP: 'off', CHAT_RETENTION_SWEEP: 'off', TRAY_SWEEP: 'off',
  SCRIPT_OUTPUT_SWEEP: 'off', AUTO_MIGRATION_SWEEP: 'off', WINGET_INDEX_SWEEP: 'off', SNAPSHOT_SWEEP: 'off', AGENT_AUTO_UPDATE: 'off',
  WARRANTY_SWEEP: 'off', AUTOMATION_SWEEP: 'off', RESTART_WINDOW_SWEEP: 'off', SSO_SESSION_SWEEP: 'off', TERMINAL_SWEEP: 'off',
  BACKUP_SYNC_SWEEP: 'off',
};
function startApi(port, extra = {}) {
  const p = spawn(process.execPath, [path.join(dist, 'main.js')], {
    env: {
      ...process.env, NODE_ENV: 'test', PORT: String(port), DATABASE_URL: DB, JWT_SECRET: JWT, LAUNCHER_TOKEN_SECRET: LTS, ENCRYPTION_KEY: ENC,
      TRUSTED_PROXIES: 'loopback', HBBS_PRESENCE_HOST: '127.0.0.2', VERSION_FILE: path.resolve(here, '..', '..', '..', 'version.json'),
      FRONTEND_URL: 'https://rmm.example.com', PUBLIC_API_URL: 'https://rmm.example.com', GEOIP_DB_PATH: path.join(here, 'no-geoip.mmdb'),
      AMAPI_TEST_BASE_URL: `http://127.0.0.1:${STANDIN}`,
      ...OFF, MDM_SWEEP: 'off', ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.log = ''; p.stdout.on('data', (d) => { p.log += d; }); p.stderr.on('data', (d) => { p.log += d; });
  return p;
}
async function waitUp(port, p) {
  for (let i = 0; i < 120; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/api/v1/health`); if (r.status < 500) return; } catch { /* */ } await sleep(300); }
  throw new Error(`api did not come up:\n${p.log.slice(-3000)}`);
}
async function stop(p) { if (p && p.exitCode === null && p.signalCode === null) await new Promise((r) => { p.once('exit', r); p.kill('SIGTERM'); }); }

const API = `http://127.0.0.1:${PORT}/api/v1`;
const bodies = [];
async function req(method, p, { s, body } = {}) {
  await sleep(30);
  const h = { 'content-type': 'application/json', 'x-forwarded-for': ip() };
  if (s) h.cookie = s.cookie + (s.stepUp ? `; step_up=${s.stepUp}` : '');
  const r = await fetch(`${API}${p}`, { method, headers: h, body: body === undefined ? undefined : J(body) });
  const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = text; }
  bodies.push(text);
  return { status: r.status, body: j, data: j?.data, text };
}
/** Google's redirect of the admin's browser, simulated: no cookie, as SameSite=Strict would send none. */
async function callback(query) {
  const r = await fetch(`${API}/mdm/android/signup/callback?${query}`, { redirect: 'manual', headers: { 'x-forwarded-for': ip() } });
  const loc = r.headers.get('location') ?? '';
  return { status: r.status, loc, q: Object.fromEntries(new URL(loc, 'https://x').searchParams) };
}
async function login(email) {
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip() }, body: J({ email, password: PW }) });
  const mm = (r.headers.get('set-cookie') ?? '').match(/access_token=([^;]+)/);
  if (r.status !== 200 || !mm) throw new Error(`login ${email}: ${r.status} ${await r.text()}`);
  return { cookie: `access_token=${mm[1]}` };
}
async function stepUp(s) {
  const r = await fetch(`${API}/auth/step-up`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip(), cookie: s.cookie }, body: J({ password: PW }) });
  const mm = (r.headers.get('set-cookie') ?? '').match(/step_up=([^;]+)/);
  if (r.status !== 200 || !mm) throw new Error(`step-up: ${r.status}`);
  return { ...s, stepUp: mm[1] };
}
const code = (r) => r.body?.code ?? r.body?.message?.code ?? r.body?.error?.code;
const msg = (r) => `HTTP ${r.status} ${typeof r.body === 'string' ? r.body.slice(0, 300) : J(r.body).slice(0, 600)}`;
const created = { businesses: [], users: [], pauses: [] };
const resetRow = () => prisma.$executeRawUnsafe(`UPDATE "MdmPlatformSetup" SET "androidKeyEnc" = NULL, "androidProjectId" = NULL, "androidClientEmail" = NULL, "androidKeyIdLast4" = NULL, "androidKeySetAt" = NULL,
  "androidTestedAt" = NULL, "androidTestResult" = NULL, "androidQuotaDevices" = NULL, "androidQuotaSetAt" = NULL, "updatedAt" = now() WHERE id = 'platform'`);
/** Wait for a sync of this connector that STARTED after now (an in-flight one may finish first). */
async function resync(id) {
  for (let i = 0; i < 30 && (await prisma.mdmConnector.findUnique({ where: { id } })).syncStartedAt; i++) await sleep(500);
  const t0 = new Date();
  await prisma.mdmConnector.update({ where: { id }, data: { lastSyncAt: null } });
  for (let i = 0; i < 40; i++) { const c = await prisma.mdmConnector.findUnique({ where: { id } }); if (c.lastSyncAt && c.lastSyncAt >= t0 && !c.syncStartedAt) return c; await sleep(500); }
  throw new Error('no sync came');
}
const stateOf = (cbUrl) => new URL(cbUrl).searchParams.get('state');

let api, api2;
async function all() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  if (!(await prisma.mdmPlatformSetup.findUnique({ where: { id: 'platform' } }))) throw new Error('migration 0100 has not run');
  await confirmEverythingAsks(prisma);
  await resetRow();
  const started = new Date();
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });
  await new Promise((ok) => standin.listen(STANDIN, '127.0.0.1', ok));

  section('Fixtures (synthetic): Platform Admins, a Business Owner, five businesses');
  const mkBiz = async (n) => { const b = await prisma.customer.create({ data: { tenantId: tenant.id, name: `Mooring ${n} ${sfx}` } }); created.businesses.push(b.id); return b; };
  const [A, B, C, Dz, E] = [await mkBiz('A'), await mkBiz('B'), await mkBiz('C'), await mkBiz('D'), await mkBiz('E')];
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag, extra = {}) => { const u = await prisma.user.create({ data: { email: `mo-${tag}-${sfx.toLowerCase()}@test.invalid`, passwordHash: hash, firstName: 'MO', lastName: tag, status: 'ACTIVE', ...extra } }); created.users.push(u.id); return u; };
  const admin = await mkUser('admin', { isPlatformAdmin: true });
  const admin2 = await mkUser('admin2', { isPlatformAdmin: true });
  const owner = await mkUser('owner');
  await prisma.membership.create({ data: { userId: owner.id, tenantId: tenant.id, customerId: A.id, roleId: roleOwner.id } });

  api = startApi(PORT);
  await waitUp(PORT, api);
  const S = { admin: await login(admin.email), owner: await login(owner.email), admin2: await login(admin2.email) };

  section('Platform Admin only');
  const routes = [['GET', '/mdm/android'], ['POST', '/mdm/android/test', {}], ['POST', '/mdm/android/signup', { businessId: A.id }],
    ['POST', `/mdm/android/enterprises/${A.id}/policy`, {}], ['POST', '/mdm/android/enrollment-tokens', { businessId: A.id, personalUsage: 'allowed' }], ['PUT', '/mdm/setup/android/quota', { devices: 5 }]];
  const own = [];
  for (const [m, p, b] of routes) own.push((await req(m, p, { s: S.owner, body: b })).status);
  check(own.every((x) => x === 403), 'a Business Owner gets 403 on every Android route', own.join(','));

  section('Step 3: the connection test');
  let F = await stepUp(S.admin);
  let r = await req('POST', '/mdm/android/test', { s: F });
  check(r.status === 409 && code(r) === 'NO_ANDROID_KEY' && G.hits.length === 0, 'no key: refused before any request', msg(r));
  r = await req('POST', '/mdm/android/signup', { s: F, body: { businessId: A.id } });
  check(r.status === 409 && code(r) === 'ANDROID_TEST_FIRST' && G.hits.length === 0, 'sign-up before a passed test is refused before any request', msg(r));
  const saText = serviceAccountJson();
  const sa = JSON.parse(saText);
  r = await req('PUT', '/mdm/setup/android/service-account', { s: F, body: { keyFile: saText } });
  check(r.status === 200 && r.data.android.connectionTest === null, 'the key is sealed and not yet tested', msg(r));
  r = await req('POST', '/mdm/android/test', { s: S.admin });
  check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED' && r.body?.action === 'mdm.setup', 'the test asks for a fresh confirmation (mdm.setup)', msg(r));
  G.rejectKey = true;
  r = await req('POST', '/mdm/android/test', { s: F });
  check(r.status === 200 && r.data.result === 'bad_key' && r.data.setup.android.connectionTest.result === 'bad_key'
    && r.data.setup.capabilities.find((c) => c.key === 'android.connection_test').state === 'requires_setup', 'Google refusing the key: bad_key, recorded, not available', msg(r));
  G.rejectKey = false;
  G.hits.length = 0;
  r = await req('POST', '/mdm/android/test', { s: F });
  const tok = G.hits.find((h) => h.path === '/token');
  const [jh, jb, js] = (tok?.assertion ?? '..').split('.');
  const claims = JSON.parse(Buffer.from(jb || 'e30', 'base64url').toString());
  check(r.status === 200 && r.data.result === 'ok' && r.data.setup.capabilities.find((c) => c.key === 'android.connection_test').state === 'available',
    'a good key: ok, and the capability is available', msg(r));
  check(!!tok && verify('sha256', Buffer.from(`${jh}.${jb}`), createPublicKey(sa.private_key), Buffer.from(js, 'base64url')) && claims.iss === sa.client_email
    && claims.scope === 'https://www.googleapis.com/auth/androidmanagement' && JSON.parse(Buffer.from(jh, 'base64url')).kid === sa.private_key_id,
    'the token exchange is a JWT signed by the uploaded key, for the androidmanagement scope', J(claims));
  check(G.hits.length === 2 && G.hits[1].path === '/v1/enterprises' && G.hits[1].method === 'GET' && G.hits[1].q.projectId === sa.project_id, 'then exactly one read call (enterprises.list for the key\'s project)', J(G.hits.map((h) => h.path)));
  const gp = await prisma.containmentPause.create({ data: { scope: 'GLOBAL', kinds: ['integration'], reason: `e2e-mdm-android ${sfx}`, setById: admin.id, setBy: 'msp' } });
  created.pauses.push(gp.id);
  G.hits.length = 0;
  r = await req('POST', '/mdm/android/test', { s: F });
  check(r.status === 409 && code(r) === 'INTEGRATION_PAUSED' && G.hits.length === 0, 'a global integration pause refuses the test before any request', msg(r));
  await prisma.containmentPause.update({ where: { id: gp.id }, data: { clearedAt: new Date() } });

  section('Step 4: the quota, recorded by hand');
  r = await req('PUT', '/mdm/setup/android/quota', { s: S.admin, body: { devices: 500 } });
  check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED', 'recording the quota asks', msg(r));
  r = await req('PUT', '/mdm/setup/android/quota', { s: F, body: { devices: -1 } });
  check(r.status === 400, 'a negative quota is refused', msg(r));
  r = await req('PUT', '/mdm/setup/android/quota', { s: F, body: { devices: 500 } });
  check(r.status === 200 && r.data.android.quota.devices === 500 && r.data.capabilities.find((c) => c.key === 'android.quota').state === 'available' && G.hits.length === 0,
    'recorded: 500 devices, available, and nothing was asked of Google', msg(r));

  section('Step 5: enterprise sign-up');
  r = await req('POST', '/mdm/android/signup', { s: S.admin, body: { businessId: A.id } });
  check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED', 'starting a sign-up asks (mdm.setup)', msg(r));
  r = await req('POST', '/mdm/android/signup', { s: F, body: { businessId: 'nope' } });
  check(r.status === 404, 'an unknown business is a 404', msg(r));
  const bp = await prisma.containmentPause.create({ data: { scope: 'BUSINESS', customerId: E.id, kinds: ['integration'], reason: `e2e-mdm-android ${sfx}`, setById: admin.id, setBy: 'msp' } });
  created.pauses.push(bp.id);
  G.hits.length = 0;
  r = await req('POST', '/mdm/android/signup', { s: F, body: { businessId: E.id } });
  check(r.status === 409 && code(r) === 'INTEGRATION_PAUSED' && G.hits.length === 0, 'the business\'s own integration pause refuses it before any request', msg(r));
  r = await req('POST', '/mdm/android/signup', { s: F, body: { businessId: A.id } });
  const signA = [...G.signups.values()].at(-1);
  const stateA = stateOf(signA?.callbackUrl ?? 'https://x');
  check(r.status === 200 && r.data.url.startsWith('https://signup.example.com/') && signA.projectId === sa.project_id
    && signA.callbackUrl.startsWith('https://rmm.example.com/api/v1/mdm/android/signup/callback?state=') && /^[A-Za-z0-9_-]{43}$/.test(stateA),
    'signupUrls.create with a callback on the server\'s public address carrying a 32-byte state; the admin is sent to Google\'s URL', msg(r));
  const rowA = await prisma.androidSignup.findFirst({ where: { customerId: A.id }, orderBy: { createdAt: 'desc' } });
  check(rowA?.state === 'open' && rowA.stateSha256 === sha(stateA) && rowA.createdById === admin.id && rowA.expiresAt - rowA.createdAt === 30 * 60_000
    && !J(rowA).includes(stateA) && !r.text.includes(stateA), 'stored: only the state\'s SHA-256, bound to the business and the admin, 30 minutes; the state is not in the answer', J(rowA));

  const cb = await callback(`state=${stateA}&enterpriseToken=${encodeURIComponent(signA.enterpriseToken)}`);
  const entA = await prisma.androidEnterprise.findUnique({ where: { customerId: A.id } });
  const polA = G.policies.get(entA?.enterpriseId);
  check(cb.status === 303 && cb.loc.startsWith('/settings/mobile-devices?') && cb.q.android === 'bound' && cb.q.business === A.id && cb.q.policy === 'set', 'Google\'s redirect (no session cookie): 303 back to the settings page, bound, policy set', `${cb.status} ${cb.loc}`);
  check(!!entA && entA.enterpriseId === G.enterprises[0] && entA.boundById === admin.id && entA.policyVersion === '1' && !!entA.policySetAt
    && (await prisma.androidSignup.findUnique({ where: { id: rowA.id } })).state === 'bound', 'enterprises.create bound the business, in the admin\'s name; the sign-up is bound', J(entA));
  check(J(polA?.body) === J({ statusReportingSettings: { softwareInfoEnabled: true, applicationReportsEnabled: true } }) && polA.id === 'rem0te-default',
    'the default policy, patched once: exactly software and app reports, never network info', J(polA));
  const replay = await callback(`state=${stateA}&enterpriseToken=${encodeURIComponent(signA.enterpriseToken)}`);
  check(replay.status === 303 && replay.q.android === 'failed' && replay.q.code === 'signup_not_found' && G.enterprises.length === 1, 'a replayed callback is refused: one-time, and Google is not asked again', replay.loc);
  r = await req('POST', '/mdm/android/signup', { s: F, body: { businessId: A.id } });
  check(r.status === 409 && code(r) === 'ENTERPRISE_BOUND', 'a second sign-up for a bound business is refused', msg(r));
  const unk = await callback(`state=${'A'.repeat(43)}&enterpriseToken=x`);
  const junk = await callback('state=../../etc&enterpriseToken=x');
  check(unk.q.code === 'signup_not_found' && junk.q.code === 'signup_not_found', 'an unknown or malformed state is the same failure');

  // Five racing redirects for one state: exactly one binds.
  G.failPolicyOnce = true;
  await req('POST', '/mdm/android/signup', { s: F, body: { businessId: B.id } });
  const signB = [...G.signups.values()].at(-1);
  const qB = `state=${stateOf(signB.callbackUrl)}&enterpriseToken=${encodeURIComponent(signB.enterpriseToken)}`;
  const race = await Promise.all([1, 2, 3, 4, 5].map(() => callback(qB)));
  const bound = race.filter((x) => x.q.android === 'bound');
  check(bound.length === 1 && race.filter((x) => x.q.code === 'signup_not_found').length === 4 && G.enterprises.length === 2
    && (await prisma.androidEnterprise.count({ where: { customerId: B.id } })) === 1, 'five racing callbacks: one conditional claim wins, the others are refused, one enterprise', J(race.map((x) => x.q)));
  check(bound[0]?.q.policy === 'not_set' && !(await prisma.androidEnterprise.findUnique({ where: { customerId: B.id } })).policySetAt, 'Google failing the policy leaves the business bound without one, and says so');

  // A missing enterprise token.
  await req('POST', '/mdm/android/signup', { s: F, body: { businessId: C.id } });
  const signC = [...G.signups.values()].at(-1);
  const cbC = await callback(`state=${stateOf(signC.callbackUrl)}`);
  const rowC = await prisma.androidSignup.findFirst({ where: { customerId: C.id } });
  check(cbC.q.android === 'failed' && cbC.q.code === 'bad_token' && rowC.state === 'failed' && rowC.failureCode === 'bad_token', 'no enterprise token: failed (bad_token), and the state is spent', cbC.loc);
  // An admin who stopped being one.
  const S2 = await stepUp(S.admin2);
  await req('POST', '/mdm/android/signup', { s: S2, body: { businessId: Dz.id } });
  const signD = [...G.signups.values()].at(-1);
  await prisma.user.update({ where: { id: admin2.id }, data: { isPlatformAdmin: false } });
  const cbD = await callback(`state=${stateOf(signD.callbackUrl)}&enterpriseToken=${encodeURIComponent(signD.enterpriseToken)}`);
  check(cbD.q.code === 'admin_gone' && !signD.used, 'the admin who started it is no longer a Platform Admin: refused before Google is asked', cbD.loc);
  // A pause between start and callback.
  await prisma.containmentPause.update({ where: { id: bp.id }, data: { clearedAt: new Date() } });
  await req('POST', '/mdm/android/signup', { s: F, body: { businessId: E.id } });
  const signE = [...G.signups.values()].at(-1);
  const bp2 = await prisma.containmentPause.create({ data: { scope: 'BUSINESS', customerId: E.id, kinds: ['integration'], reason: `e2e-mdm-android ${sfx}`, setById: admin.id, setBy: 'msp' } });
  created.pauses.push(bp2.id);
  const cbE = await callback(`state=${stateOf(signE.callbackUrl)}&enterpriseToken=${encodeURIComponent(signE.enterpriseToken)}`);
  check(cbE.q.code === 'paused' && !signE.used, 'a pause set after the start: refused at the callback, Google not asked', cbE.loc);
  // An expired sign-up (written directly: the trigger never lets an expiry move).
  const expState = randomBytes(32).toString('base64url');
  const past = new Date(Date.now() - 2 * 3600_000);
  await prisma.androidSignup.create({ data: { tenantId: tenant.id, customerId: E.id, stateSha256: sha(expState), signupUrlName: 'signupUrls/Cexpired', createdById: admin.id, createdAt: past, expiresAt: new Date(past.getTime() + 30 * 60_000) } });
  const cbX = await callback(`state=${expState}&enterpriseToken=x`);
  check(cbX.q.code === 'signup_not_found', 'an expired state is the same failure', cbX.loc);
  let refused = null;
  try { await prisma.$executeRawUnsafe(`UPDATE "AndroidSignup" SET "state" = 'open' WHERE "customerId" = '${C.id}'`); } catch (e) { refused = String(e.message); }
  check(/never reopened|finished/.test(refused ?? ''), '0102 refuses reopening a finished sign-up', String(refused));
  refused = null;
  try { await prisma.$executeRawUnsafe(`INSERT INTO "AndroidSignup" ("id","tenantId","customerId","stateSha256","signupUrlName","createdById","expiresAt","updatedAt") VALUES ('x${sfx}','${tenant.id}','${A.id}','${sha('x')}','signupUrls/Cx','${admin.id}', now() + interval '2 hours', now())`); } catch (e) { refused = String(e.message); }
  check(/AndroidSignup_expiresAt_check/.test(refused ?? ''), '0102 refuses a sign-up living longer than an hour', String(refused));

  section('Step 6: the default policy and one-time enrollment tokens');
  r = await req('POST', '/mdm/android/enrollment-tokens', { s: F, body: { businessId: B.id, personalUsage: 'allowed' } });
  check(r.status === 409 && code(r) === 'POLICY_FIRST', 'no token before the default policy', msg(r));
  r = await req('POST', `/mdm/android/enterprises/${B.id}/policy`, { s: S.admin });
  check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED', 'applying the policy asks (mdm.setup)', msg(r));
  r = await req('POST', `/mdm/android/enterprises/${B.id}/policy`, { s: F });
  check(r.status === 200 && r.data.policyVersion === '1' && J(G.policies.get(r.data.enterpriseId).body) === J({ statusReportingSettings: { softwareInfoEnabled: true, applicationReportsEnabled: true } }), 'applied: the same policy, nothing else', msg(r));
  r = await req('POST', '/mdm/android/enrollment-tokens', { s: S.admin, body: { businessId: A.id, personalUsage: 'allowed' } });
  check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED' && r.body?.action === 'mdm.enroll', 'a token asks, naming mdm.enroll', msg(r));
  r = await req('POST', '/mdm/android/enrollment-tokens', { s: F, body: { businessId: A.id, personalUsage: 'sometimes' } });
  const r61 = await req('POST', '/mdm/android/enrollment-tokens', { s: F, body: { businessId: A.id, personalUsage: 'allowed', expiresInMinutes: 61 } });
  check(r.status === 400 && r61.status === 400, 'an unknown usage or more than an hour is refused', `${msg(r)} / ${msg(r61)}`);
  r = await req('POST', '/mdm/android/enrollment-tokens', { s: F, body: { businessId: A.id, personalUsage: 'allowed' } });
  const t1 = G.tokensMade.at(-1);
  check(r.status === 200 && r.data.value === G.enrollValues.at(-1) && /^data:image\/png;base64,/.test(r.data.qrDataUrl) && r.data.oneTimeOnly === true && r.data.shownOnce === true,
    'a work-profile token: the value and a QR code, shown once', msg(r).slice(0, 200));
  check(J(t1.body) === J({ policyName: `enterprises/${entA.enterpriseId}/policies/rem0te-default`, duration: '3600s', oneTimeOnly: true, allowPersonalUsage: 'PERSONAL_USAGE_ALLOWED' }),
    'enrollmentTokens.create: one-time, an hour, personal usage allowed, the default policy', J(t1.body));
  r = await req('POST', '/mdm/android/enrollment-tokens', { s: F, body: { businessId: A.id, personalUsage: 'disallowed', expiresInMinutes: 20 } });
  check(r.status === 200 && G.tokensMade.at(-1).body.allowPersonalUsage === 'PERSONAL_USAGE_DISALLOWED' && G.tokensMade.at(-1).body.duration === '1200s', 'fully managed, 20 minutes: personal usage disallowed', msg(r).slice(0, 200));
  const tokAudits = await prisma.activityLog.findMany({ where: { action: 'MDM_ANDROID_TOKEN_CREATED', createdAt: { gte: started } } });
  const storedText = J(await prisma.androidEnterprise.findMany()) + J(await prisma.androidSignup.findMany()) + J(tokAudits);
  check(tokAudits.length === 2 && G.enrollValues.every((v) => !storedText.includes(v)) && tokAudits.every((a) => a.metadata.oneTimeOnly === true && !('value' in a.metadata)),
    'each token audited (ids only) before it is shown; no value is stored or audited anywhere', J(tokAudits.map((a) => a.metadata)));
  r = await req('GET', '/mdm/android', { s: S.admin });
  check(r.status === 200 && r.data.enterprises.length >= 2 && r.data.provenAgainstGoogle === false && !/stateSha256/.test(r.text), 'the admin view lists the enterprises; it says nothing was proven against Google', msg(r).slice(0, 200));

  section('The sync: devices and Operations (MDM_SWEEP on)');
  const entB = await prisma.androidEnterprise.findUnique({ where: { customerId: B.id } });
  // A: 130 devices over two pages; one personal (work profile), one in an unknown state, one deleted.
  const devsA = Array.from({ length: 130 }, (_, i) => device(entA.enterpriseId, i + 1));
  devsA[4] = device(entA.enterpriseId, 5, { ownership: 'PERSONALLY_OWNED', managementMode: 'PROFILE_OWNER' });
  devsA[5] = device(entA.enterpriseId, 6, { state: 'SOMETHING_NEW' });
  devsA[6] = device(entA.enterpriseId, 7, { state: 'DELETED' });
  G.devices.set(entA.enterpriseId, devsA);
  G.devices.set(entB.enterpriseId, [device(entB.enterpriseId, 1)]);
  G.hits.length = 0;
  await stop(api); api = null;
  api2 = startApi(PORT + 1, { MDM_SWEEP: 'on', MDM_SWEEP_SECONDS: '2', MDM_SYNC_MINUTES: '0.02' });
  await waitUp(PORT + 1, api2);
  let conA = null;
  for (let i = 0; i < 60; i++) {
    conA = await prisma.mdmConnector.findFirst({ where: { customerId: A.id, provider: 'android' } });
    if (conA?.lastSyncResult) break;
    await sleep(1000);
  }
  const conB = await prisma.mdmConnector.findFirst({ where: { customerId: B.id, provider: 'android' } });
  check(conA?.externalTenantId === entA.enterpriseId && conA.enabled && conB?.externalTenantId === entB.enterpriseId, 'one enabled android connector per bound enterprise, named by its enterprise id', J(conA));
  check(conA?.lastSyncResult === 'ok' && conA.lastSyncDevices === 129, 'a complete sync: 129 devices kept (the unknown state skipped)', J(conA));
  check(DEVICE_FIELDS_SEEN.length >= 2 && DEVICE_FIELDS_SEEN.every((f) => f && !/network|imei|telephony|user/i.test(f)) && G.hits.some((h) => h.q.pageToken === 'p100'),
    'devices.list was paged and asked only the fields Rem0te keeps', String(DEVICE_FIELDS_SEEN[0]));
  const mdA = await prisma.mobileDevice.findMany({ where: { connectorId: conA?.id } });
  const d5 = mdA.find((d) => d.providerDeviceId === 'dev5'), d1 = mdA.find((d) => d.providerDeviceId === 'dev1'), d7 = mdA.find((d) => d.providerDeviceId === 'dev7');
  check(d1?.ownership === 'corporate' && d1.serialNumber === 'SER1' && d1.platform === 'android' && d1.managementScope === 'device' && d1.osVersion === 'Android 15' && d1.model === 'Pixel 8',
    'a company phone: corporate, fully managed, its serial, model and Android version', J(d1));
  check(d5?.ownership === 'byod' && d5.managementScope === 'work_profile' && d5.serialNumber === null, 'a work profile on a personal phone: byod, and no serial', J(d5));
  check(d7?.enrollmentState === 'unenrolled' && !mdA.some((d) => d.providerDeviceId === 'dev6'), 'a deleted device is unenrolled; an unknown state is not kept');
  check(!/49015420323|aa:bb:cc|5555550100|users\/u/.test(J(mdA)), 'no IMEI, MAC, phone number or user in any stored device');
  const cmds = await prisma.mdmCommand.findMany({ where: { connectorId: conA?.id } });
  const lock = cmds.find((c) => c.kind === 'lock'), wipe = cmds.find((c) => c.kind === 'wipe'), lost = cmds.find((c) => c.kind === 'lost_mode_start');
  check(lock?.state === 'completed' && !!lock.providerAcceptedAt && !!lock.deviceCompletedAt && lock.origin === 'provider', 'a done LOCK: accepted by Google and completed, as two facts', J(lock));
  check(wipe?.state === 'failed' && /android:grpc_9/.test(wipe.failureCode ?? '') && lost?.state === 'acknowledged' && !lost.deviceCompletedAt && !cmds.some((c) => /REBOOT/i.test(c.kind)),
    'a failed WIPE has a code (never Google\'s text); a pending lost mode is accepted, not completed; a REBOOT is not shown', J(cmds.map((c) => [c.kind, c.state, c.failureCode])));
  check(!G.hits.some((h) => /operations\/|:cancel|issueCommand|\/devices\/[^/]+$/.test(h.path) && h.method !== 'GET') && !G.hits.some((h) => h.method === 'DELETE'),
    'nothing was sent to a device: no issueCommand, no cancel, no devices.delete', J([...new Set(G.hits.map((h) => `${h.method} ${h.path.replace(/dev\d+/, 'dev*')}`))]));

  // A device gone from a complete listing; then a business pause.
  G.devices.set(entA.enterpriseId, devsA.filter((d) => !d.name.endsWith('/dev2')));
  await resync(conA.id);
  const d2 = await prisma.mobileDevice.findFirst({ where: { connectorId: conA.id, providerDeviceId: 'dev2' } });
  check(d2?.enrollmentState === 'not_reported' && !!d2.notReportedSince, 'a device missing from a complete listing is marked not reported', J(d2));
  const pA = await prisma.containmentPause.create({ data: { scope: 'BUSINESS', customerId: A.id, kinds: ['integration'], reason: `e2e-mdm-android ${sfx}`, setById: admin.id, setBy: 'msp' } });
  created.pauses.push(pA.id);
  await resync(conA.id);
  G.hits.length = 0;
  await sleep(4000);
  check((await prisma.mdmConnector.findUnique({ where: { id: conA.id } })).lastSyncResult === 'paused' && !G.hits.some((h) => h.path.includes(entA.enterpriseId)),
    'under the business\'s integration pause the sync makes no call for its enterprise', J(G.hits.map((h) => h.path)).slice(0, 300));
  const exp = await prisma.androidSignup.findFirst({ where: { stateSha256: sha(expState) } });
  check(exp?.state === 'expired', 'the sweep expired the sign-up nobody finished', J(exp));

  section('Nothing secret in any answer, audit row or the API\'s output');
  const audits = await prisma.activityLog.findMany({ where: { action: { in: ['MDM_ANDROID_TESTED', 'MDM_ANDROID_SIGNUP_STARTED', 'MDM_ANDROID_SIGNUP_FAILED', 'MDM_ANDROID_ENTERPRISE_BOUND', 'MDM_ANDROID_POLICY_SET', 'MDM_ANDROID_TOKEN_CREATED'] }, createdAt: { gte: started } } });
  const acts = new Set(audits.map((a) => a.action));
  check(['MDM_ANDROID_TESTED', 'MDM_ANDROID_SIGNUP_STARTED', 'MDM_ANDROID_SIGNUP_FAILED', 'MDM_ANDROID_ENTERPRISE_BOUND', 'MDM_ANDROID_POLICY_SET', 'MDM_ANDROID_TOKEN_CREATED'].every((a) => acts.has(a)),
    'every step is audited', [...acts].join(','));
  const auditText = J(audits.map((a) => a.metadata));
  const secrets = [sa.private_key.slice(40, 80), sa.private_key_id, stateA, signA.enterpriseToken, ...G.issuedAccess, ...G.enrollValues];
  check(secrets.every((x) => !auditText.includes(x)) && !/signup\.example\.com|callback/.test(auditText), 'no key, key id, state, enterprise token, access token, enrollment value or URL in any audit row');
  const answers = bodies.join('\n');
  check([sa.private_key.slice(40, 80), stateA, signA.enterpriseToken, ...G.issuedAccess].every((x) => !answers.includes(x)), 'no key, state, enterprise token or access token in any API answer');
  const logs = (api?.log ?? '') + (api2?.log ?? '');
  check(secrets.every((x) => !logs.includes(x)) && !/googleapis\.com|PRIVATE KEY/.test(logs), 'none of them, and no Google host, in the API\'s output');
}

try {
  await all();
} catch (e) {
  fail++; failures.push(String(e?.stack ?? e)); console.error(e);
} finally {
  await stop(api); await stop(api2);
  standin.close();
  await resetRow().catch(() => {});
  await prisma.containmentPause.updateMany({ where: { id: { in: created.pauses }, clearedAt: null }, data: { clearedAt: new Date() } }).catch(() => {});
  await prisma.mdmConnector.deleteMany({ where: { customerId: { in: created.businesses } } }).catch(() => {});
  await prisma.membership.deleteMany({ where: { userId: { in: created.users } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: created.users } } }).catch(() => {});
  await prisma.customer.deleteMany({ where: { id: { in: created.businesses } } }).catch(() => {});
  await prisma.$disconnect();
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
