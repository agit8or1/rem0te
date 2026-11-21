#!/usr/bin/env node
/**
 * End-to-end proof of backups (0.81 Vault), against the real built API, a
 * scratch database and a loopback stand-in provider only — no real St0r or
 * Comet is ever called, and every asset here is synthetic.
 *
 *   - default deny: a Business User without backups:view is refused; with it,
 *     only assets on computers they can see (never an unlinked one);
 *   - another business is refused (owner of B asking for A);
 *   - "requires setup" until a provider is connected; empty states say why;
 *   - connections: Platform Admin only, fresh authentication, Comet refused
 *     (planned), the St0r token shown once and stored only as a hash;
 *   - the push: no token, a wrong secret, a revoked token and an unknown
 *     connection all the same 401; a body naming a business, or a job saying
 *     it was verified, is 400; the scope is the token's, so a feed naming
 *     another business's computer links nothing;
 *   - a successful job without a drill is never "verified", nor with only a
 *     simulated drill; a passed real drill of its own point is;
 *   - the stand-in pull sweep (BACKUP_SYNC_SWEEP on, 2 s) reads the stub and
 *     skips a business under an integration pause;
 *   - BACKUP_STALE (MONITOR_SWEEP on, 2 s; inventory cadence 1 s): a stale
 *     backup raises one alert per asset, on its computer, and clears when a
 *     fresh success arrives; DRILL_FAILED raises on a failed real drill;
 *     RPO_EXCEEDED measures against the target set on the page;
 *   - nothing secret in an audit row or the API's output.
 *
 *   cd apps/api && npx nest build
 *   DATABASE_URL=postgresql://…/<name containing scratch or test> node scripts/e2e-backups.mjs
 *
 * Ports 4051 (API), 4052 (stand-in provider), 4053 (spare). Never 3001.
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { confirmEverythingAsks } from './lib/confirm-asks.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const DB = process.env.DATABASE_URL ?? '';
const dbName = DB.split('/').pop()?.split('?')[0] ?? '';
if (!/scratch|test/.test(dbName)) { console.error(`Refusing to run against database "${dbName}": name must contain "scratch" or "test".`); process.exit(2); }
const PORT = Number(process.env.BACKUPS_API_PORT ?? 4051);
const STUB_PORT = PORT + 1;
for (const p of [PORT, STUB_PORT]) if (p < 4051 || p > 4053) { console.error(`Refusing port ${p}: this suite uses 4051–4053.`); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex').toUpperCase();
const PW = 'backups-e2e-password-123';
const STANDIN_TOKEN = `standin-${randomBytes(12).toString('hex')}`;

let pass = 0, fail = 0;
const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;
const HOUR = 3_600_000;
const ago = (h) => new Date(Date.now() - h * HOUR).toISOString();

// ── The stand-in provider ─────────────────────────────────────────────────────
const hits = [];
let standinFeed = { v: 1, assets: [] };
const stub = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; });
  req.on('end', () => {
    hits.push({ method: req.method, url: req.url, headers: req.headers, body: b });
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && req.url === '/backups/v1/feed') {
      if (req.headers.authorization !== `Bearer ${STANDIN_TOKEN}`) { res.statusCode = 401; return res.end('{}'); }
      return res.end(JSON.stringify(standinFeed));
    }
    res.statusCode = 404; res.end('{}');
  });
});

// ── The API ───────────────────────────────────────────────────────────────────
const JWT = randomBytes(32).toString('hex'), LTS = randomBytes(32).toString('hex'), ENC = randomBytes(32).toString('hex');
let api;
function startApi(extra) {
  const p = spawn(process.execPath, [path.join(dist, 'main.js')], {
    env: {
      ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATABASE_URL: DB, JWT_SECRET: JWT, LAUNCHER_TOKEN_SECRET: LTS, ENCRYPTION_KEY: ENC,
      TRUSTED_PROXIES: 'loopback', HBBS_PRESENCE_HOST: '127.0.0.2', VERSION_FILE: path.resolve(here, '..', '..', '..', 'version.json'), FRONTEND_URL: 'https://rmm.example.test',
      BACKUP_TEST_BASE_URL: `http://127.0.0.1:${STUB_PORT}`,
      // Never production's GeoIP file (§54): a path that does not exist.
      GEOIP_DB_PATH: path.join(here, 'no-geoip.mmdb'),
      INTEGRATION_PEERS_FILE: '', REPORT_SCHEDULE_SWEEP: 'off', AUDIT_SEALER: 'off', STALE_SWEEP: 'off',
      CLIENT_UPDATE_SWEEP: 'off', PATCH_POLICY_SWEEP: 'off', METRIC_SWEEP: 'off', RETENTION_SWEEP: 'off', CHAT_RETENTION_SWEEP: 'off', TRAY_SWEEP: 'off',
      SCRIPT_OUTPUT_SWEEP: 'off', AUTO_MIGRATION_SWEEP: 'off', WINGET_INDEX_SWEEP: 'off', SNAPSHOT_SWEEP: 'off', AGENT_AUTO_UPDATE: 'off',
      WARRANTY_SWEEP: 'off', AUTOMATION_SWEEP: 'off', RESTART_WINDOW_SWEEP: 'off', SSO_SESSION_SWEEP: 'off', TERMINAL_SWEEP: 'off',
      // This suite's own: the monitoring sweep and the pull sweep on, fast.
      MONITOR_SWEEP: 'on', MONITOR_SWEEP_SECONDS: '2', MONITOR_INVENTORY_SECONDS: '1',
      BACKUP_SYNC_SWEEP: 'on', BACKUP_SYNC_SECONDS: '2',
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.log = ''; p.stdout.on('data', (d) => { p.log += d; }); p.stderr.on('data', (d) => { p.log += d; });
  return p;
}
async function waitUp() {
  for (let i = 0; i < 120; i++) { try { const r = await fetch(`${API}/health`); if (r.status < 500) return; } catch { /* */ } await sleep(300); }
  throw new Error(`api did not come up:\n${api.log.slice(-3000)}`);
}
async function stopApi() { if (api && api.exitCode === null) await new Promise((r) => { api.once('exit', r); api.kill('SIGTERM'); }); }
async function req(method, p, { s, body, business, auth } = {}) {
  await sleep(40);
  const h = { 'content-type': 'application/json', 'x-forwarded-for': ip() };
  if (s) h.cookie = s.cookie + (s.stepUp ? `; step_up=${s.stepUp}` : '');
  if (business) h['x-rem0te-business'] = business;
  if (auth) h.authorization = auth;
  const r = await fetch(`${API}${p}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j, data: j?.data, text, setCookie: r.headers.get('set-cookie') ?? '' };
}
async function login(email) {
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip() }, body: JSON.stringify({ email, password: PW }) });
  const mm = (r.headers.get('set-cookie') ?? '').match(/access_token=([^;]+)/);
  if (r.status !== 200 || !mm) throw new Error(`login ${email}: ${r.status} ${await r.text()}`);
  return { cookie: `access_token=${mm[1]}` };
}
async function stepUp(s) {
  const r = await req('POST', '/auth/step-up', { s, body: { password: PW } });
  const mm = r.setCookie.match(/step_up=([^;]+)/);
  if (r.status !== 200 || !mm) throw new Error(`step-up: ${r.status} ${JSON.stringify(r.body)}`);
  return { ...s, stepUp: mm[1] };
}
const code = (r) => r.body?.code ?? r.body?.message?.code ?? r.body?.error?.code;
const msg = (r) => `HTTP ${r.status} ${typeof r.body === 'string' ? r.body.slice(0, 300) : JSON.stringify(r.body).slice(0, 500)}`;
const created = { businesses: [], users: [], pauses: [] };
async function waitFor(fn, ms = 20_000) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(400); } return null; }

const job = (id, hoursAgo, o = {}) => ({ externalId: id, startedAt: ago(hoursAgo + 0.5), finishedAt: ago(hoursAgo), completion: 'succeeded', integrity: 'passed', ...o });

async function all() {
  await new Promise((r, j) => { stub.once('error', j); stub.listen(STUB_PORT, '127.0.0.1', r); });
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  if (await prisma.monitorRule.count({ where: { scopeKey: 'global' } })) throw new Error('This database has global monitors, which the monitoring sweep here would act on; use a fresh scratch database.');
  if (await prisma.backupConnection.count({ where: { revokedAt: null } })) throw new Error('This database has live backup connections, which the pull sweep here would read; use a fresh scratch database.');
  await confirmEverythingAsks(prisma);
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });
  const roleUser = await prisma.role.findFirst({ where: { type: 'BUSINESS_USER' } });

  section('Fixtures (synthetic): Acme (A), Birch (B) and Cedar (C)');
  const A = await prisma.customer.create({ data: { tenantId: tenant.id, name: `Acme Backups ${sfx}` } });
  const B = await prisma.customer.create({ data: { tenantId: tenant.id, name: `Birch Backups ${sfx}` } });
  const C = await prisma.customer.create({ data: { tenantId: tenant.id, name: `Cedar Backups ${sfx}` } });
  created.businesses.push(A.id, B.id, C.id);
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag, extra = {}) => { const u = await prisma.user.create({ data: { email: `bk-${tag}-${sfx.toLowerCase()}@test.invalid`, passwordHash: hash, firstName: 'BK', lastName: tag, status: 'ACTIVE', ...extra } }); created.users.push(u.id); return u; };
  const admin = await mkUser('admin', { isPlatformAdmin: true });
  const ownerA = await mkUser('owner-a'), ownerB = await mkUser('owner-b'), plain = await mkUser('plain-a'), viewer = await mkUser('viewer-a');
  await prisma.membership.create({ data: { userId: ownerA.id, tenantId: tenant.id, customerId: A.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: ownerB.id, tenantId: tenant.id, customerId: B.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: plain.id, tenantId: tenant.id, customerId: A.id, roleId: roleUser.id, capabilities: ['computers:view', 'monitoring:alerts'] } });
  await prisma.membership.create({ data: { userId: viewer.id, tenantId: tenant.id, customerId: A.id, roleId: roleUser.id, capabilities: ['computers:view', 'monitoring:alerts', 'backups:view'] } });
  const mk = (biz, name) => prisma.endpoint.create({ data: { tenantId: tenant.id, customerId: biz.id, name: `${name}-${sfx}`, hostname: `${name.toLowerCase()}-${sfx.toLowerCase()}.example.test`, platform: 'Windows', status: 'ACTIVE', isOnline: true, isManaged: true, lastSeenAt: new Date(), accessMode: 'COMPANY_WIDE' } });
  const fs1 = await mk(A, 'FS1'), sql1 = await mk(A, 'SQL1'), birch1 = await mk(B, 'BIRCH1'), cedar1 = await mk(C, 'CEDAR1');

  api = startApi({});
  await waitUp();
  const S = { admin: await login(admin.email), ownerA: await login(ownerA.email), ownerB: await login(ownerB.email), plain: await login(plain.email), viewer: await login(viewer.email) };

  section('Default deny, another business, requires setup');
  let r = await req('GET', '/backups', { s: S.plain, business: A.id });
  check(r.status === 403 && code(r) === 'NOT_ALLOWED', 'a Business User without backups:view is refused', msg(r));
  r = await req('GET', `/backups?businessId=${A.id}`, { s: S.ownerB });
  check(r.status === 403 || r.status === 404, 'Birch\'s owner asking for Acme is refused', msg(r));
  r = await req('GET', '/backups', { s: S.ownerA, business: A.id });
  check(r.status === 200 && r.data.state === 'requires_setup' && /No backup provider is connected/.test(r.data.needs) && r.data.assets.length === 0 && r.data.may.connect === false,
    'Acme with no provider: "requires setup", saying what is needed', msg(r));
  check(r.status === 200 && r.data.providers.some((p) => p.kind === 'st0r' && p.transport === 'push') && r.data.providers.some((p) => /Comet/.test(p.label) && p.state === 'planned'), 'the page lists St0r and Comet (planned) with their limitations', JSON.stringify(r.data?.providers?.map((p) => [p.label, p.state])));

  section('Connections: Platform Admin, fresh authentication, Comet refused, a token shown once');
  r = await req('POST', '/backups/connections', { s: S.ownerA, body: { businessId: A.id, kind: 'st0r' } });
  check(r.status === 403, 'a Business Owner cannot connect a provider', msg(r));
  r = await req('POST', '/backups/connections', { s: S.admin, body: { businessId: A.id, kind: 'st0r' } });
  check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED' && r.body.action === 'backup.connection', 'a Platform Admin needs fresh authentication (backup.connection)', msg(r));
  const adminUp = await stepUp(S.admin);
  r = await req('POST', '/backups/connections', { s: adminUp, body: { businessId: A.id, kind: 'comet' } });
  check(r.status === 400 && code(r) === 'BACKUP_PROVIDER_NOT_AVAILABLE', 'Comet is refused: planned, not built', msg(r));
  r = await req('POST', '/backups/connections', { s: adminUp, body: { businessId: A.id, kind: 'st0r', credential: 'not-for-a-push-provider' } });
  check(r.status === 400, 'a push provider takes no credential', msg(r));
  r = await req('POST', '/backups/connections', { s: adminUp, body: { businessId: A.id, kind: 'st0r' } });
  const tokA = r.data?.pushToken;
  const connA = r.data?.connection?.id;
  check(r.status === 201 && /^rbk_bkc[0-9a-f]{24}_[0-9a-f]{64}$/.test(tokA ?? '') && r.data.shownOnce === true && r.data.connection.pushTokenLast4 === tokA.slice(-4), 'St0r for Acme: a push token, shown once', msg(r));
  r = await req('POST', '/backups/connections', { s: adminUp, body: { businessId: A.id, kind: 'st0r' } });
  check(r.status === 409 && code(r) === 'BACKUP_CONNECTION_EXISTS', 'one live connection per provider per business', msg(r));
  const rowA = await prisma.backupConnection.findUnique({ where: { id: connA } });
  check(!!rowA && /^[0-9a-f]{64}$/.test(rowA.pushTokenHash) && !JSON.stringify(rowA).includes(tokA.split('_').pop()), 'only the SHA-256 of the secret is stored');
  r = await req('GET', '/backups/connections', { s: adminUp });
  check(r.status === 200 && !r.text.includes(tokA.split('_').pop()) && !/pushTokenHash|credentialEnc/.test(r.text), 'the connection list carries no token, hash or credential', msg(r));
  r = await req('POST', '/backups/connections', { s: adminUp, body: { businessId: B.id, kind: 'st0r' } });
  const tokB = r.data?.pushToken;
  check(r.status === 201 && !!tokB, 'St0r for Birch', msg(r));
  r = await req('GET', '/backups', { s: S.ownerA, business: A.id });
  check(r.status === 200 && r.data.state === 'awaiting_data' && /not reported yet/.test(r.data.needs), 'Acme: connected, awaiting its first report', msg(r));

  section('The push: the token is the scope');
  const feedA = (assets) => ({ v: 1, assets });
  const fsAsset = (jobs, extra = {}) => ({ externalId: 'fs1-c', name: 'FS1 C: volume', type: 'server', computer: { rem0teId: fs1.id }, jobs, recoveryPoints: [{ externalId: 'p-fs1-1', pointAt: jobs[0]?.finishedAt ?? ago(1), location: 'offsite', jobExternalId: jobs[0]?.externalId }], drills: [], ...extra });
  const body1 = feedA([
    fsAsset([job('fs1-j1', 50)]),
    { externalId: 'sql1-db', name: 'SQL1 Finance DB', type: 'database', computer: { hostname: `sql1-${sfx.toLowerCase()}.example.test` }, jobs: [job('sql1-j1', 2)], recoveryPoints: [{ externalId: 'p-sql1-1', pointAt: ago(2), location: 'local', jobExternalId: 'sql1-j1' }], drills: [] },
    { externalId: 'mbx-ceo', name: 'CEO mailbox', type: 'mailbox', jobs: [job('mbx-j1', 3)], recoveryPoints: [], drills: [] },
    // Names another business's computer: the token is Acme's, so nothing links.
    { externalId: 'stray', name: 'Stray volume', type: 'files', computer: { rem0teId: birch1.id }, jobs: [job('stray-j1', 2)], recoveryPoints: [], drills: [] },
  ]);
  r = await req('POST', '/backups/push', { body: body1 });
  check(r.status === 401 && code(r) === 'BACKUP_PUSH_UNAUTHORIZED', 'no token: 401', msg(r));
  r = await req('POST', '/backups/push', { body: body1, auth: `Bearer ${tokA.slice(0, -1)}${tokA.endsWith('0') ? '1' : '0'}` });
  check(r.status === 401 && code(r) === 'BACKUP_PUSH_UNAUTHORIZED', 'a wrong secret: the same 401', msg(r));
  r = await req('POST', '/backups/push', { body: body1, auth: `Bearer ${tokA.replace(connA, 'bkc' + '0'.repeat(24))}` });
  check(r.status === 401 && code(r) === 'BACKUP_PUSH_UNAUTHORIZED', 'an unknown connection: the same 401', msg(r));
  r = await req('POST', '/backups/push', { body: { ...body1, businessId: B.id }, auth: `Bearer ${tokA}` });
  check(r.status === 400 && code(r) === 'BAD_FEED', 'a body naming a business is refused (strict)', msg(r));
  r = await req('POST', '/backups/push', { body: feedA([fsAsset([job('fs1-j1', 50, { restoreTest: 'verified' })])]), auth: `Bearer ${tokA}` });
  check(r.status === 400 && code(r) === 'BAD_FEED', 'a job saying it was verified is refused: there is no such field', msg(r));
  r = await req('POST', '/backups/push', { body: body1, auth: `Bearer ${tokA}` });
  check(r.status === 200 && r.data.assets === 4 && r.data.jobs === 4, 'Acme\'s feed accepted', msg(r));
  const assetsA = await prisma.backupProtectedAsset.findMany({ where: { connectionId: connA } });
  const byExt = Object.fromEntries(assetsA.map((x) => [x.externalId, x]));
  check(assetsA.length === 4 && assetsA.every((x) => x.customerId === A.id), 'every row is Acme\'s, the token\'s business');
  check(byExt['fs1-c']?.endpointId === fs1.id && byExt['sql1-db']?.endpointId === sql1.id, 'linked by Rem0te id and by hostname, inside Acme');
  check(byExt.stray?.endpointId === null && byExt['mbx-ceo']?.endpointId === null, 'Birch\'s computer named in Acme\'s feed links nothing');
  check((await prisma.backupProtectedAsset.count({ where: { customerId: B.id } })) === 0, 'nothing was written into Birch');

  section('A successful job is not a verified restore');
  r = await req('GET', '/backups', { s: S.ownerA, business: A.id });
  const row = (d, ext) => d.assets.find((x) => x.id === byExt[ext].id);
  let sq = row(r.data, 'sql1-db');
  check(r.status === 200 && r.data.state === 'connected' && sq.state.backup === 'ok' && sq.state.lastJob.completion === 'succeeded' && sq.state.lastJob.integrity === 'passed'
    && sq.state.lastJob.restoreTest === 'not_tested' && sq.state.drill === 'never_tested' && sq.state.verified === null,
    'SQL1: succeeded, integrity passed, restore NOT tested — three facts, never "verified"', JSON.stringify(sq?.state));
  check(row(r.data, 'fs1-c').state.backup === 'stale', 'FS1: last success 50 h ago is stale');
  check(r.data.totals.verified === 0 && r.data.totals.unlinked === 2, 'totals: nothing verified, two unlinked assets', JSON.stringify(r.data.totals));
  // A simulated drill of SQL1's point, then a real one.
  const sqlDrill = (o) => ({ externalId: 'd1', target: 'isolated_vm', scope: 'application', result: 'passed', simulated: true, validation: 'service_running', startedAt: ago(1.5), finishedAt: ago(1), elapsedSeconds: 1200, recoveryPointExternalId: 'p-sql1-1', ...o });
  const sqlAsset = (drills) => ({ externalId: 'sql1-db', name: 'SQL1 Finance DB', type: 'database', computer: { rem0teId: sql1.id }, jobs: [job('sql1-j1', 2)], recoveryPoints: [{ externalId: 'p-sql1-1', pointAt: ago(2), location: 'local', jobExternalId: 'sql1-j1' }], drills });
  r = await req('POST', '/backups/push', { body: feedA([sqlAsset([sqlDrill({})])]), auth: `Bearer ${tokA}` });
  check(r.status === 200, 'a simulated drill reported', msg(r));
  r = await req('GET', '/backups', { s: S.ownerA, business: A.id });
  sq = row(r.data, 'sql1-db');
  check(sq.state.drill === 'simulated_only' && sq.state.verified === null && sq.state.lastJob.restoreTest === 'not_tested' && sq.simulatedDrills === 1, 'a simulated pass verifies nothing', JSON.stringify(sq.state));
  r = await req('POST', '/backups/push', { body: feedA([sqlAsset([sqlDrill({}), sqlDrill({ externalId: 'd2', simulated: false })])]), auth: `Bearer ${tokA}` });
  check(r.status === 200, 'the real drill reported', msg(r));
  r = await req('GET', '/backups', { s: S.ownerA, business: A.id });
  sq = row(r.data, 'sql1-db');
  check(sq.state.drill === 'verified' && sq.state.lastJob.restoreTest === 'verified' && sq.state.verified?.scope === 'application' && sq.state.verified?.elapsedSeconds === 1200 && !!sq.state.verified?.recoveryPointAt,
    'a passed real drill of the job\'s own point: verified, with recovery point, scope and elapsed time', JSON.stringify(sq.state));
  const jobRow = await prisma.backupJob.findFirst({ where: { assetId: byExt['sql1-db'].id, externalId: 'sql1-j1' } });
  check(jobRow?.restoreTest === 'verified' && !!jobRow.restoreDrillId, 'the job row records the drill that verified it');
  let refused = false;
  try { await prisma.backupJob.update({ where: { id: (await prisma.backupJob.findFirst({ where: { assetId: byExt['fs1-c'].id } })).id }, data: { restoreTest: 'verified', restoreDrillId: jobRow.restoreDrillId } }); } catch { refused = true; }
  check(refused, '0097 refuses marking a job verified by another asset\'s drill');

  section('What a Business User with backups:view sees');
  r = await req('GET', '/backups', { s: S.viewer, business: A.id });
  check(r.status === 200 && r.data.assets.length === 2 && r.data.assets.every((x) => x.computer) && r.data.may.configure === false, 'only assets on computers they can see; never an unlinked one', msg(r));
  r = await req('GET', `/backups/assets/${byExt['mbx-ceo'].id}`, { s: S.viewer, business: A.id });
  check(r.status === 404, 'an unlinked asset is a 404 for them', msg(r));
  r = await req('GET', `/backups/assets/${byExt['sql1-db'].id}`, { s: S.ownerB });
  check(r.status === 404 || r.status === 403, 'Birch\'s owner cannot read an Acme asset', msg(r));
  r = await req('PUT', '/backups/objectives', { s: S.viewer, body: { businessId: A.id, rpoMinutes: 60, rtoMinutes: 120 } });
  check(r.status === 403, 'setting targets needs monitoring:configure', msg(r));

  section('BACKUP_STALE, DRILL_FAILED, RPO_EXCEEDED (MONITOR_SWEEP on)');
  r = await req('POST', '/monitoring/rules', { s: S.ownerA, business: A.id, body: { scope: 'business', businessId: A.id, key: 'bk-stale', kind: 'BACKUP_STALE', name: 'Backup stale', params: {} } });
  check(r.status === 201 || r.status === 200, 'a business BACKUP_STALE monitor (26 h)', msg(r));
  const open = (kind, epId) => prisma.monitorAlert.findMany({ where: { kind, endpointId: epId, state: { not: 'RESOLVED' } } });
  let al = await waitFor(async () => { const x = await open('BACKUP_STALE', fs1.id); return x.length ? x : null; });
  check(al?.length === 1 && al[0].dedupKey === `bk-stale:${fs1.id}:${byExt['fs1-c'].id}` && /FS1 C: volume/.test(al[0].title) && /no successful backup for 2 d/.test(al[0].title), 'FS1\'s stale backup raises one alert, keyed to the asset, on its computer', JSON.stringify(al?.map((a) => [a.dedupKey, a.title])));
  await sleep(3000);
  check((await open('BACKUP_STALE', sql1.id)).length === 0 && (await prisma.monitorAlert.count({ where: { kind: 'BACKUP_STALE', endpointId: fs1.id } })) === 1, 'SQL1 (fresh) raises nothing; FS1 still one alert after more ticks');
  check((await prisma.monitorAlert.count({ where: { kind: 'BACKUP_STALE', customerId: { in: [B.id, C.id] } } })) === 0, 'Birch and Cedar have no monitor and no alert');
  r = await req('GET', '/monitoring/alerts', { s: S.viewer, business: A.id });
  check(r.status === 200 && JSON.stringify(r.body).includes('bk-stale'), 'the alert is in the ordinary alert list for someone who can see FS1', msg(r));
  r = await req('POST', '/backups/push', { body: feedA([fsAsset([job('fs1-j2', 1), job('fs1-j1', 50)])]), auth: `Bearer ${tokA}` });
  const cleared = await waitFor(async () => ((await open('BACKUP_STALE', fs1.id)).length === 0 ? true : null));
  check(r.status === 200 && cleared === true, 'a fresh success clears it', msg(r));

  r = await req('POST', '/monitoring/rules', { s: S.ownerA, business: A.id, body: { scope: 'business', businessId: A.id, key: 'bk-drill', kind: 'DRILL_FAILED', name: 'Drill failed', params: {} } });
  check(r.status === 201 || r.status === 200, 'a DRILL_FAILED monitor', msg(r));
  r = await req('POST', '/backups/push', { body: feedA([sqlAsset([sqlDrill({}), sqlDrill({ externalId: 'd2', simulated: false }), sqlDrill({ externalId: 'd3', simulated: true, result: 'failed', startedAt: ago(0.4), finishedAt: ago(0.3) })])]), auth: `Bearer ${tokA}` });
  check(r.status === 200, 'a failed simulated drill reported', msg(r));
  await sleep(3500);
  check((await open('DRILL_FAILED', sql1.id)).length === 0, 'a failed SIMULATED drill raises nothing');
  r = await req('POST', '/backups/push', { body: feedA([sqlAsset([sqlDrill({}), sqlDrill({ externalId: 'd2', simulated: false }), sqlDrill({ externalId: 'd4', simulated: false, result: 'failed', validation: 'service_running', failureCode: 'SERVICE_DID_NOT_START', startedAt: ago(0.2), finishedAt: ago(0.1) })])]), auth: `Bearer ${tokA}` });
  check(r.status === 200, 'a failed real drill reported', msg(r));
  al = await waitFor(async () => { const x = await open('DRILL_FAILED', sql1.id); return x.length ? x : null; });
  check(al?.length === 1 && /restore drill failed/.test(al[0].title), 'a failed real drill raises DRILL_FAILED', JSON.stringify(al?.map((a) => a.title)));
  r = await req('GET', '/backups', { s: S.ownerA, business: A.id });
  sq = row(r.data, 'sql1-db');
  check(sq.state.drill === 'failed' && sq.failedDrills[0]?.failureCode === 'SERVICE_DID_NOT_START' && sq.state.verified?.drillId, 'the page shows the failed drill and still the last verified restore', JSON.stringify(sq.state));

  r = await req('PUT', '/backups/objectives', { s: S.ownerA, body: { businessId: A.id, assetId: byExt['sql1-db'].id, rpoMinutes: 30, rtoMinutes: null } });
  check(r.status === 200, 'Acme\'s owner sets a 30-minute RPO on SQL1', msg(r));
  r = await req('POST', '/monitoring/rules', { s: S.ownerA, business: A.id, body: { scope: 'business', businessId: A.id, key: 'bk-rpo', kind: 'RPO_EXCEEDED', name: 'RPO exceeded', params: {} } });
  check(r.status === 201 || r.status === 200, 'an RPO_EXCEEDED monitor', msg(r));
  al = await waitFor(async () => { const x = await open('RPO_EXCEEDED', sql1.id); return x.length ? x : null; });
  check(al?.length === 1 && al[0].detail?.targetMinutes === 30 && al[0].detail?.measuredMinutes >= 119, 'SQL1\'s 2-hour-old point against a 30-minute target raises RPO_EXCEEDED', JSON.stringify(al?.map((a) => a.detail)));
  check((await open('RPO_EXCEEDED', fs1.id)).length === 0, 'FS1 has no target: RPO_EXCEEDED skips it');
  const objAudit = await prisma.activityLog.findFirst({ where: { action: 'BACKUP_OBJECTIVE_SET', customerId: A.id } });
  check(objAudit?.metadata?.after?.rpoMinutes === 30 && objAudit.metadata.before === null, 'the target is audited with before and after');

  section('The stand-in pull sweep');
  const C_conn = await req('POST', '/backups/connections', { s: adminUp, body: { businessId: C.id, kind: 'standin', credential: STANDIN_TOKEN } });
  check(C_conn.status === 201 && !C_conn.data.pushToken && C_conn.data.connection.credentialLast4 === STANDIN_TOKEN.slice(-4), 'a stand-in pull connection for Cedar (test only), credential sealed', msg(C_conn));
  const pause = await prisma.containmentPause.create({ data: { scope: 'BUSINESS', customerId: C.id, kinds: ['integration'], reason: 'e2e backups stop', setById: admin.id, setBy: 'msp' } });
  created.pauses.push(pause.id);
  standinFeed = { v: 1, assets: [{ externalId: 'cedar-c', name: 'CEDAR1 C:', type: 'computer', computer: { rem0teId: cedar1.id }, jobs: [job('c-j1', 1)], recoveryPoints: [], drills: [] }] };
  await sleep(5000);
  check(hits.length === 0, 'under an integration pause, the stand-in is not asked', `hits=${hits.length}`);
  await prisma.containmentPause.update({ where: { id: pause.id }, data: { clearedAt: new Date(), clearedById: admin.id, clearReason: 'e2e' } });
  const pulled = await waitFor(async () => (await prisma.backupProtectedAsset.findFirst({ where: { customerId: C.id, externalId: 'cedar-c' } })) ?? null);
  check(!!pulled && pulled.endpointId === cedar1.id && hits.some((h) => h.headers.authorization === `Bearer ${STANDIN_TOKEN}` && h.body === '{}'), 'after the pause, the sweep pulled Cedar\'s feed (bearer credential, empty body)', `hits=${hits.length}`);

  section('Revoking a token ends the push');
  r = await req('POST', `/backups/connections/${connA}/revoke`, { s: S.admin });
  check(r.status === 200, 'revoking never asks for fresh authentication', msg(r));
  r = await req('POST', '/backups/push', { body: feedA([fsAsset([job('fs1-j3', 0.5)])]), auth: `Bearer ${tokA}` });
  check(r.status === 401 && code(r) === 'BACKUP_PUSH_UNAUTHORIZED', 'the revoked token: the same 401', msg(r));
  const rev = await prisma.backupConnection.findUnique({ where: { id: connA } });
  check(rev.pushTokenHash === null && rev.enabled === false, 'the hash is dropped');

  section('Nothing secret was kept or printed');
  const rows = await prisma.activityLog.findMany({ where: { action: { in: ['BACKUP_CONNECTION_CREATED', 'BACKUP_CONNECTION_REVOKED', 'BACKUP_OBJECTIVE_SET'] }, customerId: { in: created.businesses } } });
  const blob = JSON.stringify(rows.map((x) => x.metadata));
  const secrets = [tokA.split('_').pop(), tokB.split('_').pop(), STANDIN_TOKEN];
  check(rows.length >= 5 && !secrets.some((k) => blob.includes(k)), `no token or credential in ${rows.length} audit rows`);
  check(!secrets.some((k) => api.log.includes(k)), 'no token or credential in the API\'s output');
}

async function cleanup() {
  await stopApi();
  stub.close();
  try {
    const ids = created.businesses;
    const eps = (await prisma.endpoint.findMany({ where: { customerId: { in: ids } }, select: { id: true } })).map((e) => e.id);
    const alerts = (await prisma.monitorAlert.findMany({ where: { customerId: { in: ids } }, select: { id: true } })).map((a) => a.id);
    await prisma.monitorAlertEvent.deleteMany({ where: { alertId: { in: alerts } } });
    await prisma.monitorAlert.deleteMany({ where: { id: { in: alerts } } });
    await prisma.endpointMonitorState.deleteMany({ where: { endpointId: { in: eps } } }).catch(() => undefined);
    await prisma.monitorRule.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.backupJob.updateMany({ where: { customerId: { in: ids } }, data: { restoreTest: 'not_tested', restoreDrillId: null } }).catch(() => undefined);
    await prisma.backupProtectedAsset.deleteMany({ where: { customerId: { in: ids } } }).catch((e) => console.error('assets:', e.message.slice(0, 200)));
    await prisma.backupObjective.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.backupConnection.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.endpoint.deleteMany({ where: { id: { in: eps } } });
    await prisma.containmentPause.deleteMany({ where: { id: { in: created.pauses } } }).catch(() => undefined);
    await prisma.membership.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.customer.deleteMany({ where: { id: { in: ids } } }).catch((e) => console.error('businesses:', e.message.slice(0, 200)));
    await prisma.activityLog.updateMany({ where: { actorId: { in: created.users } }, data: { actorId: null } }).catch(() => undefined);
    if (created.users.length) await prisma.user.deleteMany({ where: { id: { in: created.users } } }).catch((e) => console.error('users:', e.message.slice(0, 200)));
  } catch (e) { console.error('cleanup:', e.message); }
  await prisma.$disconnect();
}

all().catch((e) => { fail++; failures.push(`crashed: ${e.stack ?? e}`); console.error(e); })
  .finally(async () => {
    const logs = api?.log ?? '';
    await cleanup();
    console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
    if (failures.length) { for (const f of failures) console.log(`  - ${f}`); console.log(`\n── API output (last 4000 characters)\n${logs.slice(-4000)}`); process.exit(1); }
    process.exit(0);
  });
