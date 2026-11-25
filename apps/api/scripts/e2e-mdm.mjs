#!/usr/bin/env node
/**
 * End-to-end proof of mobile devices (0.80 Tablet, roadmap 3.1,
 * check-security-invariants §90), against the real built API and a loopback
 * MDM stand-in only. No real provider exists or is called; every device and
 * identifier here is synthetic.
 *
 *   - Default deny: a Business User without mobile:view, and an MSP
 *     technician from a preset, get 403 on all four routes. A technician
 *     with mobile:view on a whole-business assignment reads that business.
 *   - Scope: an owner sees only their business; another business's device
 *     or its commands is a 404; naming another business is a 403; a business
 *     in another TENANT is the same. A Platform Admin sees every business.
 *   - Requires setup: with no connector, or the stand-in not reachable
 *     (MDM_TEST_BASE_URL unset), the setup route says requires_setup and the
 *     sync records not_ready without one request to the stand-in.
 *   - The sync (MDM_SWEEP on, fast): pages through devices and commands,
 *     drops a malformed record, keeps a BYOD device's serial out and never
 *     stores an IMEI, marks a device the provider stopped returning as
 *     not_reported only after a COMPLETE listing, stops at its page bound
 *     (partial), skips an integration-paused business (paused), and records
 *     bad_response for a page that is not one.
 *   - Accepted ≠ completed: a command the provider accepted but the device
 *     has not finished is acknowledged with providerAcceptedAt and no
 *     deviceCompletedAt; it becomes completed only when the device reports;
 *     a completion the provider never accepted is refused and the command
 *     stays sent; a rejection is failed with no acceptance.
 *   - The database refuses a cross-business row, a completion without an
 *     acceptance, a BYOD serial and moving a final command.
 *   - The API has no write route for mobile devices (0.86: one, for lost-device
 *     commands; a wipe is refused and the stand-in takes none).
 *
 *   cd apps/api && npx nest build
 *   DATABASE_URL=postgresql://…/<name containing scratch or test> node scripts/e2e-mdm.mjs
 *
 * Ports 4021 (API) and 4022 (stand-in). Never 3000/3001/3201/3202/443/4000/4001.
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const DB = process.env.DATABASE_URL ?? '';
const dbName = DB.split('/').pop()?.split('?')[0] ?? '';
if (!/scratch|test/.test(dbName)) { console.error(`Refusing to run against database "${dbName}": name must contain "scratch" or "test".`); process.exit(2); }
const PORT = Number(process.env.MDM_API_PORT ?? 4021);
const STUB_PORT = PORT + 1;
for (const p of [PORT, STUB_PORT]) if (p < 4021 || p > 4022) { console.error(`Refusing port ${p}: this suite uses 4021–4022.`); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'mdm-e2e-password-123';
const IMEI = '35693803564' + String(1000 + ((Math.random() * 8999) | 0));
const BYOD_SERIAL = `BYOD${randomBytes(4).toString('hex').toUpperCase()}`;

let pass = 0, fail = 0;
const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;
const J = (x) => JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
const iso = (ms) => new Date(Date.now() + ms).toISOString();
const MIN = 60_000;

// ── The stand-in ──────────────────────────────────────────────────────────
// Each provider tenant id maps to a scripted provider. Everything it
// receives is recorded, so the suite can say what left the API.
const T = { A: `ta-${sfx}`, B: `tb-${sfx}`, C: `tc-${sfx}`, E: `te-${sfx}`, F: `tf-${sfx}` };
const hits = [];
const world = {
  [T.A]: {
    devicePages: () => [
      [
        { id: 'a-ipad-1', name: 'Front desk iPad', platform: 'ipados', ownership: 'corporate', managementScope: 'device', enrollmentState: 'enrolled', enrolledAt: '2026-01-05T09:00:00Z',
          complianceState: 'compliant', model: 'iPad (10th generation)', manufacturer: 'Apple', osVersion: '18.1', serialNumber: 'dmpxk12abcd', storageTotalBytes: 64e9, storageFreeBytes: 20e9, lastCheckInAt: iso(-5 * MIN) },
        ...(world[T.A].keepA2 ? [{ id: 'a-iphone-2', name: 'Sales iPhone', platform: 'ios', ownership: 'corporate', managementScope: 'device', enrollmentState: 'enrolled',
          complianceState: 'noncompliant', complianceReason: 'OS version below the minimum (17.0)', model: 'iPhone 13', manufacturer: 'Apple', osVersion: '16.7.2', serialNumber: 'f2lxq0abcd12', lastCheckInAt: iso(-60 * MIN) }] : []),
      ],
      [
        { id: 'a-pixel-3', name: 'Jo\u0007 personal Pixel', platform: 'android', ownership: 'byod', managementScope: 'work_profile', enrollmentState: 'enrolled',
          complianceState: 'in_grace_period', complianceReason: 'Screen lock‮ required', model: 'Pixel 8', manufacturer: 'Google', osVersion: '15',
          serialNumber: BYOD_SERIAL, imei: IMEI, phoneNumber: '+15555550123', wifiMac: '02:00:00:aa:bb:cc', userPrincipalName: `jo-${sfx}@example.com`, lastCheckInAt: iso(-2 * MIN) },
        { id: 'a-bad-4', name: 'Not a phone', platform: 'windows', ownership: 'corporate', managementScope: 'device', enrollmentState: 'enrolled', complianceState: 'compliant' },
      ],
    ],
    keepA2: true,
    commands: () => [
      { id: 'c-accepted', deviceId: 'a-ipad-1', kind: 'lock', requestedAt: iso(-30 * MIN), acceptedAt: iso(-29 * MIN), completedAt: world[T.A].finishAccepted ? iso(-1 * MIN) : null, expiresAt: iso(24 * 60 * MIN) },
      { id: 'c-done', deviceId: 'a-ipad-1', kind: 'sync', requestedAt: iso(-90 * MIN), acceptedAt: iso(-89 * MIN), completedAt: iso(-88 * MIN) },
      { id: 'c-noaccept', deviceId: 'a-iphone-2', kind: 'locate', requestedAt: iso(-20 * MIN), completedAt: iso(-19 * MIN) },
      { id: 'c-rejected', deviceId: 'a-pixel-3', kind: 'wipe', requestedAt: iso(-10 * MIN), rejectedAt: iso(-10 * MIN), rejectCode: 'not_supported_for_work_profile' },
      { id: 'c-elsewhere', deviceId: 'not-a-known-device', kind: 'lock', requestedAt: iso(-10 * MIN) },
    ],
  },
  // B: a provider that always has another page — the sync must stop at its bound.
  [T.B]: { devicePages: 'endless', commands: () => [] },
  [T.C]: {
    devicePages: () => [[{ id: 'c-tab-1', name: 'Other tenant tablet', platform: 'android', ownership: 'corporate', managementScope: 'device', enrollmentState: 'enrolled', complianceState: 'compliant', model: 'Galaxy Tab', osVersion: '14' }]],
    commands: () => [{ id: 'c-c-1', deviceId: 'c-tab-1', kind: 'lock', requestedAt: iso(-5 * MIN), acceptedAt: iso(-4 * MIN) }],
  },
  [T.E]: { devicePages: () => [[{ id: 'e-1', platform: 'ios', ownership: 'corporate', managementScope: 'device', enrollmentState: 'enrolled', complianceState: 'compliant' }]], commands: () => [] },
  [T.F]: { garbage: true },
};
const stub = http.createServer((req, res) => {
  hits.push({ method: req.method, url: req.url, headers: req.headers });
  res.setHeader('content-type', 'application/json');
  const u = new URL(req.url, 'http://x');
  const m = u.pathname.match(/^\/mdm\/v1\/tenants\/([A-Za-z0-9._-]+)\/(devices|commands)$/);
  const w = m && world[m[1]];
  if (req.method !== 'GET' || !w) { res.statusCode = 404; return res.end('{}'); }
  if (w.garbage) return res.end('{"devices": "nope"}');
  const cursor = u.searchParams.get('cursor');
  if (m[2] === 'commands') return res.end(J({ commands: w.commands(), next: null }));
  if (w.devicePages === 'endless') {
    const n = Number((cursor ?? 'p0').slice(1));
    return res.end(J({ devices: [{ id: `b-${n % 3}`, platform: 'android', ownership: 'corporate', managementScope: 'device', enrollmentState: 'enrolled', complianceState: 'unknown' }], next: `p${n + 1}` }));
  }
  const pages = w.devicePages();
  const i = cursor ? Number(cursor.slice(1)) : 0;
  return res.end(J({ devices: pages[i] ?? [], next: i + 1 < pages.length ? `p${i + 1}` : null }));
});

// ── The API ───────────────────────────────────────────────────────────────
const JWT = randomBytes(32).toString('hex'), LTS = randomBytes(32).toString('hex'), ENC = randomBytes(32).toString('hex');
let api;
function startApi(extra) {
  const env = {
    ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATABASE_URL: DB, JWT_SECRET: JWT, LAUNCHER_TOKEN_SECRET: LTS, ENCRYPTION_KEY: ENC,
    TRUSTED_PROXIES: 'loopback', HBBS_PRESENCE_HOST: '127.0.0.2', VERSION_FILE: path.resolve(here, '..', '..', '..', 'version.json'),
    GEOIP_DB_PATH: path.join(here, 'no-geoip.mmdb'), INTEGRATION_PEERS_FILE: '',
    REPORT_SCHEDULE_SWEEP: 'off', AUDIT_SEALER: 'off', STALE_SWEEP: 'off', CLIENT_UPDATE_SWEEP: 'off', PATCH_POLICY_SWEEP: 'off', METRIC_SWEEP: 'off',
    RETENTION_SWEEP: 'off', CHAT_RETENTION_SWEEP: 'off', TRAY_SWEEP: 'off', SCRIPT_OUTPUT_SWEEP: 'off', AUTO_MIGRATION_SWEEP: 'off', WINGET_INDEX_SWEEP: 'off',
    SNAPSHOT_SWEEP: 'off', AGENT_AUTO_UPDATE: 'off', MONITOR_SWEEP: 'off', WARRANTY_SWEEP: 'off', AUTOMATION_SWEEP: 'off', RESTART_WINDOW_SWEEP: 'off',
    SSO_SESSION_SWEEP: 'off', TERMINAL_SWEEP: 'off',
    // This suite proves the MDM sync, fast.
    MDM_SWEEP: 'on', MDM_SWEEP_SECONDS: '2', MDM_SYNC_MINUTES: '0.05',
    ...extra,
  };
  delete env.PUBLIC_API_URL;
  delete env.MDM_TEST_BASE_URL;
  if (extra.MDM_TEST_BASE_URL) env.MDM_TEST_BASE_URL = extra.MDM_TEST_BASE_URL;
  const p = spawn(process.execPath, [path.join(dist, 'main.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  p.log = ''; p.stdout.on('data', (d) => { p.log += d; }); p.stderr.on('data', (d) => { p.log += d; });
  return p;
}
async function waitUp() {
  for (let i = 0; i < 150; i++) { try { const r = await fetch(`${API}/health`); if (r.status < 500) return; } catch { /* not yet */ } await sleep(300); }
  throw new Error(`api did not come up:\n${api.log.slice(-3000)}`);
}
async function stopApi() { if (api && api.exitCode === null && api.signalCode === null) await new Promise((r) => { api.once('exit', r); api.kill('SIGTERM'); }); }
let allLogs = '';

async function req(method, p, { s, body, business } = {}) {
  await sleep(40);
  const h = { 'content-type': 'application/json', 'x-forwarded-for': ip() };
  if (s) h.cookie = s.cookie;
  if (business) h['x-rem0te-business'] = business;
  const r = await fetch(`${API}${p}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j, data: j?.data, text };
}
async function login(email) {
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip() }, body: JSON.stringify({ email, password: PW }) });
  const mm = (r.headers.get('set-cookie') ?? '').match(/access_token=([^;]+)/);
  if (r.status !== 200 || !mm) throw new Error(`login ${email}: ${r.status} ${await r.text()}`);
  return { cookie: `access_token=${mm[1]}` };
}
const msg = (r) => `HTTP ${r.status} ${(typeof r.body === 'string' ? r.body : J(r.body)).slice(0, 300)}`;
const code = (r) => r.body?.code ?? r.body?.message?.code ?? r.body?.error?.code;
const conn = (id) => prisma.mdmConnector.findUnique({ where: { id } });
async function waitFor(fn, ms = 25_000) {
  const until = Date.now() + ms;
  let v;
  while (Date.now() < until) { v = await fn(); if (v) return v; await sleep(250); }
  return v;
}
/** Wait until the connector has finished a sync that started after `since`. */
const syncedAfter = (id, since, ms) => waitFor(async () => { const c = await conn(id); return c?.lastSyncAt && c.lastSyncAt > since && !c.syncStartedAt ? c : null; }, ms);

const created = { tenants: [], businesses: [], users: [], pauses: [] };

async function all() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });
  const roleUser = await prisma.role.findFirst({ where: { type: 'BUSINESS_USER' } });

  section('Fixtures (synthetic): businesses A, B, D (no connector), E (paused), F (garbage) in one tenant; C in a second tenant; users and technicians');
  const tenant2 = await prisma.tenant.create({ data: { name: `MDM other tenant ${sfx}`, slug: `mdm-other-${sfx}` } });
  created.tenants.push(tenant2.id);
  const biz = async (tag, t = tenant) => { const b = await prisma.customer.create({ data: { tenantId: t.id, name: `MDM ${tag} ${sfx}` } }); created.businesses.push(b.id); return b; };
  const A = await biz('A'), B = await biz('B'), D = await biz('D'), E = await biz('E'), F = await biz('F');
  const C = await biz('C', tenant2);
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag, b, role, { capabilities = [], admin = false, t = tenant } = {}) => {
    const u = await prisma.user.create({ data: { email: `mdm-${tag}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'Mdm', lastName: tag, status: 'ACTIVE', isPlatformAdmin: admin } });
    created.users.push(u.id);
    if (b) await prisma.membership.create({ data: { userId: u.id, tenantId: t.id, customerId: b.id, roleId: role.id, capabilities } });
    return u;
  };
  const admin = await mkUser('admin', null, null, { admin: true });
  const ownerA = await mkUser('owner-a', A, roleOwner);
  const ownerC = await mkUser('owner-c', C, roleOwner, { t: tenant2 });
  const ownerD = await mkUser('owner-d', D, roleOwner);
  const userA = await mkUser('user-a', A, roleUser, { capabilities: ['computers:view', 'computers:edit', 'computers:connect', 'monitoring:alerts'] });
  const userAm = await mkUser('user-a-mobile', A, roleUser, { capabilities: ['computers:view', 'mobile:view'] });
  const techP = await mkUser('tech-preset', null, null);
  const techM = await mkUser('tech-mobile', null, null);
  const techN = await mkUser('tech-named', null, null);

  const mkConn = (b, ext, t = tenant, enabled = true) => prisma.mdmConnector.create({ data: { tenantId: t.id, customerId: b.id, provider: 'standin', externalTenantId: ext, enabled } });
  const kA = await mkConn(A, T.A), kB = await mkConn(B, T.B), kC = await mkConn(C, T.C, tenant2), kE = await mkConn(E, T.E), kF = await mkConn(F, T.F);
  created.pauses.push((await prisma.containmentPause.create({ data: { scope: 'BUSINESS', customerId: E.id, kinds: ['integration'], reason: 'e2e mdm stop', setById: admin.id, setBy: 'msp' } })).id);

  // ── 1. Requires setup: the stand-in not reachable ──────────────────────
  section('Requires setup: MDM_TEST_BASE_URL unset — every connector is not_ready and nothing is asked');
  const t0 = new Date();
  api = startApi({});
  await waitUp();
  const preset = await prisma.technicianPreset.findUnique({ where: { key: 'l2-technician' } });
  if (!preset) throw new Error('the l2-technician preset is missing after the API started');
  await prisma.technicianAssignment.create({ data: { tenantId: tenant.id, customerId: A.id, userId: techP.id, presetId: preset.id, capabilities: [] } });
  await prisma.technicianAssignment.create({ data: { tenantId: tenant.id, customerId: A.id, userId: techM.id, capabilities: ['computers:view', 'mobile:view'] } });
  await prisma.technicianAssignment.create({ data: { tenantId: tenant.id, customerId: A.id, userId: techN.id, capabilities: ['computers:view', 'mobile:view'], endpointIds: ['some-computer-id'] } });
  const SAd = await login(admin.email);
  const SOA = await login(ownerA.email);
  let k = await syncedAfter(kA.id, t0);
  check(k?.lastSyncResult === 'not_ready' && hits.length === 0, 'a pass ran: connector A is not_ready, and the stand-in received no request', J({ k, hits: hits.length }));
  let r = await req('GET', '/mobile-devices/setup', { s: SOA });
  check(r.status === 200 && r.data.state === 'requires_setup' && r.data.connectors.length === 1 && r.data.connectors[0].ready === false && /test suites/.test(r.data.connectors[0].reason) && r.data.readOnly === true,
    'the owner\'s setup panel: requires setup, the connector not ready, with the reason', msg(r));
  check(Array.isArray(r.data.prerequisites) && r.data.prerequisites.map((p) => p.key).join() === 'third_party,android,apple', 'the setup answer lists the three provider routes\' prerequisites', msg(r));
  await stopApi(); allLogs += api.log;

  // ── 2. The sync against the stand-in ───────────────────────────────────
  section('Sync: MDM_TEST_BASE_URL is the loopback stand-in');
  const t1 = new Date();
  api = startApi({ MDM_TEST_BASE_URL: `http://127.0.0.1:${STUB_PORT}` });
  await waitUp();
  const SAdm = await login(admin.email);
  const SOAm = await login(ownerA.email);
  const SOC = await login(ownerC.email);
  const SOD = await login(ownerD.email);
  const SUA = await login(userA.email);
  const SUAm = await login(userAm.email);
  const STP = await login(techP.email);
  const STM = await login(techM.email);
  const STN = await login(techN.email);
  k = await syncedAfter(kA.id, t1);
  check(k?.lastSyncResult === 'ok' && k.lastSyncDevices === 3, 'connector A: ok, three devices (the malformed fourth skipped)', J(k));
  const devs = await prisma.mobileDevice.findMany({ where: { connectorId: kA.id } });
  const byId = Object.fromEntries(devs.map((d) => [d.providerDeviceId, d]));
  check(devs.length === 3 && !byId['a-bad-4'], 'three rows stored; the Windows "device" was refused', J(devs.map((d) => d.providerDeviceId)));
  check(byId['a-ipad-1']?.serialNumber === 'DMPXK12ABCD' && byId['a-ipad-1'].storageTotalBytes === 64000000000n, 'a corporate device keeps its serial and storage', J(byId['a-ipad-1']));
  const byod = byId['a-pixel-3'];
  check(byod?.serialNumber === null && byod.ownership === 'byod' && byod.managementScope === 'work_profile', 'the BYOD work-profile phone: no serial kept', J(byod));
  check(byod?.name === 'Jo personal Pixel' && byod.complianceReason === 'Screen lock required', 'its free text arrived with the control characters removed', J({ n: byod?.name, r: byod?.complianceReason }));
  const rawRows = J(await prisma.$queryRawUnsafe(`SELECT * FROM "MobileDevice" WHERE "connectorId" = $1`, kA.id));
  check(!rawRows.includes(IMEI) && !rawRows.includes(BYOD_SERIAL) && !rawRows.includes('5555550123') && !rawRows.includes(`jo-${sfx}`) && !rawRows.includes('02:00:00'),
    'no IMEI, BYOD serial, phone number, user or MAC anywhere in the stored rows', rawRows.slice(0, 200));
  const aHits = hits.filter((h) => h.url.includes(T.A));
  check(hits.every((h) => h.method === 'GET' && /^\/mdm\/v1\/tenants\/[A-Za-z0-9._-]+\/(devices|commands)(\?cursor=p[0-9]+)?$/.test(h.url) && !h.headers.authorization && !h.headers.cookie)
    && aHits.some((h) => h.url.endsWith('/devices?cursor=p1')),
  'the stand-in received only GETs naming the provider tenant and a cursor (it paged), with no credential or cookie', J(hits.slice(0, 4).map((h) => h.url)));

  // ── 3. Accepted ≠ completed ─────────────────────────────────────────────
  section('Commands: provider acceptance and device completion are separate facts');
  const cmds = Object.fromEntries((await prisma.mdmCommand.findMany({ where: { connectorId: kA.id } })).map((c) => [c.providerCommandId, c]));
  const acc = cmds['c-accepted'];
  check(acc?.state === 'acknowledged' && acc.providerAcceptedAt && acc.deviceCompletedAt === null && acc.origin === 'provider' && acc.requestedById === null,
    'accepted by the provider, not done by the device: acknowledged, providerAcceptedAt set, deviceCompletedAt null', J(acc));
  const done = cmds['c-done'];
  check(done?.state === 'completed' && done.providerAcceptedAt && done.deviceCompletedAt && done.deviceCompletedAt > done.providerAcceptedAt, 'accepted then completed: completed, both timestamps, in order', J(done));
  const na = cmds['c-noaccept'];
  check(na?.state === 'sent' && na.deviceCompletedAt === null && na.providerAcceptedAt === null, 'a completion the provider never accepted is refused: the command stays sent, no completion recorded', J(na));
  const rej = cmds['c-rejected'];
  check(rej?.state === 'failed' && rej.failureCode === 'provider_rejected:not_supported_for_work_profile' && rej.providerAcceptedAt === null, 'a rejected wipe is failed, with the provider\'s code and no acceptance', J(rej));
  check(!cmds['c-elsewhere'] && Object.keys(cmds).length === 4, 'a command for a device the provider never listed is skipped', J(Object.keys(cmds)));

  const ipad = byId['a-ipad-1'];
  r = await req('GET', `/mobile-devices/${ipad.id}/commands`, { s: SOAm });
  const vAcc = r.data?.commands?.find((c) => c.kind === 'lock');
  check(r.status === 200 && vAcc?.state === 'acknowledged' && vAcc.stateLabel === 'Accepted by provider' && vAcc.providerAccepted.done === true && vAcc.deviceCompleted.done === false && vAcc.waitingFor === 'device'
    // 0.86: a Business Owner holds mobile:act, but the read-only stand-in takes no command.
    && r.data.canSend === true && r.data.actions.length === 3 && r.data.actions.every((a) => !a.available && a.code === 'MOBILE_COMMAND_UNSUPPORTED'),
    'the command history shows the lock as accepted by the provider and NOT completed on the device', msg(r));
  const vDone = r.data?.commands?.find((c) => c.kind === 'sync');
  check(vDone?.providerAccepted.done && vDone.deviceCompleted.done && vDone.providerAccepted.at !== vDone.deviceCompleted.at, 'the completed sync shows both, each with its own time', J(vDone));
  r = await req('GET', `/mobile-devices/${byod.id}/commands`, { s: SOAm });
  const vRej = r.data?.commands?.[0];
  check(vRej?.kind === 'wipe' && vRej.destructive === true && vRej.state === 'failed' && vRej.providerAccepted.done === false, 'the rejected wipe: destructive, failed, never accepted', msg(r));

  // The device reports the lock done; the provider stops listing the sales iPhone.
  world[T.A].finishAccepted = true;
  world[T.A].keepA2 = false;
  const t2 = new Date();
  await syncedAfter(kA.id, t2);
  const acc2 = await prisma.mdmCommand.findUnique({ where: { id: acc.id } });
  check(acc2?.state === 'completed' && +acc2.providerAcceptedAt === +acc.providerAcceptedAt && acc2.deviceCompletedAt !== null,
    'the next sync: the device reported the lock done — completed, the acceptance time unchanged', J(acc2));
  const iphone = await prisma.mobileDevice.findUnique({ where: { id: byId['a-iphone-2'].id } });
  check(iphone?.enrollmentState === 'not_reported' && iphone.notReportedSince, 'a device the complete listing no longer returns is not_reported', J(iphone));
  const na2 = await prisma.mdmCommand.findUnique({ where: { id: na.id } });
  check(na2?.state === 'sent', 'the unaccepted completion is still refused on every pass', J(na2));

  // ── 4. Bounds, pauses, bad answers ──────────────────────────────────────
  section('Bounds, pause and bad answers');
  k = await syncedAfter(kB.id, t1);
  const bHits = hits.filter((h) => h.url.includes(`${T.B}/devices`));
  const firsts = bHits.filter((h) => !h.url.includes('cursor')).length;
  check(k?.lastSyncResult === 'partial' && firsts >= 1 && bHits.length <= 20 * firsts && bHits.length >= 20 * (firsts - 1) + 1,
    'an endless provider: the sync stops at 20 pages a pass and records partial', J({ result: k?.lastSyncResult, pages: bHits.length, passes: firsts }));
  check((await prisma.mobileDevice.count({ where: { connectorId: kB.id } })) === 3 && (await prisma.mobileDevice.count({ where: { connectorId: kB.id, enrollmentState: 'not_reported' } })) === 0,
    'a partial listing marks nothing not_reported', '');
  k = await syncedAfter(kE.id, t1);
  check(k?.lastSyncResult === 'paused' && !hits.some((h) => h.url.includes(T.E)), 'an integration-paused business: paused, and its provider was not asked', J(k));
  k = await syncedAfter(kF.id, t1);
  check(k?.lastSyncResult === 'bad_response' && (await prisma.mobileDevice.count({ where: { connectorId: kF.id } })) === 0, 'a page that is not a page: bad_response, nothing stored', J(k));
  k = await syncedAfter(kC.id, t1);
  check(k?.lastSyncResult === 'ok', 'the other tenant\'s connector syncs on its own', J(k));

  // ── 5. Default deny ─────────────────────────────────────────────────────
  section('Default deny: mobile:view is required, and a technician needs it on the whole business');
  const routes = (id) => ['/mobile-devices/setup', '/mobile-devices', `/mobile-devices/${id}`, `/mobile-devices/${id}/commands`];
  for (const [who, s, business] of [['a Business User with every computer capability but not mobile:view', SUA], ['an MSP technician from the L2 preset', STP, A.id], ['a technician whose mobile:view grant names computers', STN, A.id]]) {
    const rs = [];
    for (const p of routes(ipad.id)) rs.push(await req('GET', p, { s, business }));
    check(rs.every((x) => x.status === 403), `${who}: 403 on all four routes`, rs.map(msg).join(' | '));
  }
  r = await req('GET', '/mobile-devices', { s: SUAm });
  check(r.status === 200 && r.data.devices.length === 2 && r.data.devices.every((d) => d.business.id === A.id), 'a Business User granted mobile:view reads their business (two current devices)', msg(r));
  r = await req('GET', '/mobile-devices', { s: STM, business: A.id });
  check(r.status === 200 && r.data.devices.length === 2, 'a technician with mobile:view on the whole business reads that business', msg(r));
  r = await req('GET', `/mobile-devices?businessId=${B.id}`, { s: STM, business: A.id });
  check(r.status === 403, 'the same technician naming another business: 403', msg(r));

  // ── 6. Scope ────────────────────────────────────────────────────────────
  section('Scope: own business only; other businesses and tenants are 404 by id and 403 by name');
  r = await req('GET', '/mobile-devices', { s: SOAm });
  check(r.status === 200 && r.data.total === 2 && r.data.devices.map((d) => d.name).sort().join() === 'Front desk iPad,Jo personal Pixel', 'owner A lists exactly A\'s current devices', msg(r));
  check(r.data.counts.compliant === 1 && r.data.counts.in_grace_period === 1 && r.data.counts.noncompliant === 0, 'compliance counts cover the current devices', J(r.data?.counts));
  check(!r.text.includes(IMEI) && !r.text.includes(BYOD_SERIAL), 'the list carries no IMEI or BYOD serial');
  r = await req('GET', '/mobile-devices?enrollment=not_reported', { s: SOAm });
  check(r.status === 200 && r.data.total === 1 && r.data.devices[0].name === 'Sales iPhone' && r.data.devices[0].enrollmentLabel === 'No longer reported', 'the device the provider dropped is shown only when asked for', msg(r));
  r = await req('GET', '/mobile-devices?platform=android&ownership=byod', { s: SOAm });
  check(r.status === 200 && r.data.total === 1 && r.data.devices[0].managementScopeLabel === 'Work profile only', 'filters: Android + BYOD is the work-profile phone', msg(r));
  r = await req('GET', '/mobile-devices?search=ipad', { s: SOAm });
  check(r.status === 200 && r.data.total === 1, 'search by name', msg(r));
  r = await req('GET', `/mobile-devices/${ipad.id}`, { s: SOAm });
  check(r.status === 200 && r.data.device.ownershipLabel === 'Corporate' && r.data.device.complianceLabel === 'Compliant' && r.data.device.serialNumber === 'DMPXK12ABCD' && r.data.device.storage.totalBytes === 64e9 && r.data.readOnly === true,
    'the detail: ownership, compliance, serial, storage', msg(r));
  const cDev = await prisma.mobileDevice.findFirst({ where: { connectorId: kC.id } });
  r = await req('GET', `/mobile-devices/${cDev.id}`, { s: SOAm });
  check(r.status === 404, 'owner A reading the other tenant\'s tablet: 404', msg(r));
  r = await req('GET', `/mobile-devices/${cDev.id}/commands`, { s: SOAm });
  check(r.status === 404, 'and its commands: 404', msg(r));
  r = await req('GET', `/mobile-devices?businessId=${C.id}`, { s: SOAm });
  check(r.status === 403, 'owner A naming the other tenant\'s business: 403', msg(r));
  r = await req('GET', `/mobile-devices?businessId=${B.id}`, { s: SOAm });
  check(r.status === 403, 'owner A naming business B: 403', msg(r));
  r = await req('GET', `/mobile-devices/${ipad.id}`, { s: SOC });
  check(r.status === 404, 'the other tenant\'s owner reading A\'s iPad: 404', msg(r));
  r = await req('GET', '/mobile-devices', { s: SOC });
  check(r.status === 200 && r.data.total === 1 && r.data.devices[0].business.id === C.id, 'the other tenant\'s owner sees only their tablet', msg(r));
  r = await req('GET', `/mobile-devices/${cDev.id}/commands`, { s: SOC });
  check(r.status === 200 && r.data.commands[0]?.state === 'acknowledged', 'and its accepted-but-not-completed lock', msg(r));
  r = await req('GET', '/mobile-devices/setup', { s: SOD });
  check(r.status === 200 && r.data.state === 'requires_setup' && r.data.connectors.length === 0, 'a business with no connector: requires setup, no connectors', msg(r));
  r = await req('GET', '/mobile-devices', { s: SOD });
  check(r.status === 200 && r.data.total === 0, 'and an empty list', msg(r));
  r = await req('GET', '/mobile-devices/setup', { s: SOAm });
  check(r.status === 200 && r.data.state === 'available' && r.data.connectors[0].ready && r.data.connectors[0].lastSyncResult === 'ok' && r.data.connectors[0].devices === 3,
    'owner A\'s setup: available, connector ready, last sync ok', msg(r));
  r = await req('GET', '/mobile-devices?pageSize=500', { s: SAdm });
  const bizSeen = new Set((r.data?.devices ?? []).map((d) => d.business.id));
  check(r.status === 200 && r.data.pageSize === 100 && bizSeen.has(A.id) && bizSeen.has(C.id) && bizSeen.has(B.id), 'a Platform Admin sees every business (page size capped at 100)', msg(r));
  r = await req('GET', `/mobile-devices?businessId=${C.id}`, { s: SAdm });
  check(r.status === 200 && r.data.total === 1, 'and may narrow to one', msg(r));
  r = await req('GET', '/mobile-devices/not a valid id', { s: SOAm });
  check(r.status === 404, 'a malformed id: 404', msg(r));

  // ── 7. No writes ────────────────────────────────────────────────────────
  section('No write route but the lost-device one (0.86), which sends nothing destructive and nothing to the stand-in');
  for (const [m, p] of [['POST', '/mobile-devices'], ['PUT', `/mobile-devices/${ipad.id}`], ['DELETE', `/mobile-devices/${ipad.id}`], ['POST', '/mobile-devices/setup']]) {
    r = await req(m, p, { s: SAdm, body: { kind: 'wipe' } });
    check(r.status === 404, `${m} ${p.replace(ipad.id, ':id')}: 404`, msg(r));
  }
  r = await req('POST', `/mobile-devices/${ipad.id}/commands`, { s: SAdm, body: { kind: 'wipe' } });
  check(r.status === 400 && code(r) === 'MOBILE_COMMAND_INVALID', 'POST :id/commands with a wipe: 400, not a kind Rem0te sends', msg(r));
  check((await prisma.mdmCommand.count({ where: { origin: 'portal' } })) === 0, 'no portal-origin command exists');

  // ── 8. The database's own rules ─────────────────────────────────────────
  section('Migration 0096 refuses what the code never writes');
  const refused = async (fn) => { try { await fn(); return false; } catch { return true; } };
  check(await refused(() => prisma.mobileDevice.create({ data: { tenantId: tenant.id, customerId: B.id, connectorId: kA.id, provider: 'standin', providerDeviceId: 'x-cross', platform: 'ios', ownership: 'corporate', managementScope: 'device', enrollmentState: 'enrolled', complianceState: 'unknown' } })),
    'a device in business B under A\'s connector is refused (trigger)');
  check(await refused(() => prisma.mdmConnector.create({ data: { tenantId: tenant2.id, customerId: A.id, provider: 'standin', externalTenantId: 'x' } })), 'a connector whose tenant is not its business\'s is refused (trigger)');
  check(await refused(() => prisma.mobileDevice.create({ data: { tenantId: tenant.id, customerId: A.id, connectorId: kA.id, provider: 'standin', providerDeviceId: 'x-byod', platform: 'ios', ownership: 'byod', managementScope: 'user_enrollment', enrollmentState: 'enrolled', complianceState: 'unknown', serialNumber: 'ABCD1234' } })),
    'a BYOD device with a serial is refused (CHECK)');
  const base = { tenantId: tenant.id, customerId: A.id, mobileDeviceId: ipad.id, connectorId: kA.id, kind: 'lock', origin: 'portal', requestedAt: new Date() };
  check(await refused(() => prisma.mdmCommand.create({ data: { ...base, state: 'completed', sentAt: new Date(), deviceCompletedAt: new Date() } })), 'a completed command without a provider acceptance is refused (CHECK)');
  check(await refused(() => prisma.mdmCommand.create({ data: { ...base, state: 'acknowledged', sentAt: new Date(), providerAcceptedAt: new Date(), deviceCompletedAt: new Date() } })), 'an acknowledged command with a device completion is refused (CHECK)');
  check(await refused(() => prisma.mdmCommand.create({ data: { ...base, kind: 'factory_reset', state: 'queued' } })), 'an unknown kind is refused (CHECK)');
  check(await refused(() => prisma.mdmCommand.create({ data: { ...base, customerId: B.id, state: 'queued' } })), 'a command in another business than its device is refused (trigger)');
  check(await refused(() => prisma.mdmCommand.update({ where: { id: done.id }, data: { state: 'sent', deviceCompletedAt: null, providerAcceptedAt: null } })), 'a completed command cannot be moved back (trigger)');

  // ── 9. Logs ─────────────────────────────────────────────────────────────
  section('Logs');
  await stopApi(); allLogs += api.log;
  check(!allLogs.includes(IMEI) && !allLogs.includes(BYOD_SERIAL) && !allLogs.includes(T.A), 'the API logged no IMEI, serial or provider tenant id');
}

try {
  await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r));
  await all();
} catch (err) {
  fail++; failures.push(String(err?.stack ?? err));
  console.error(err);
  if (api?.log) console.error(api.log.slice(-2000));
} finally {
  await stopApi();
  stub.close();
  await prisma.containmentPause.deleteMany({ where: { id: { in: created.pauses } } }).catch(() => {});
  // Connectors cascade to devices and commands.
  await prisma.mdmConnector.deleteMany({ where: { customerId: { in: created.businesses } } }).catch(() => {});
  await prisma.technicianAssignment.deleteMany({ where: { customerId: { in: created.businesses } } }).catch(() => {});
  await prisma.membership.deleteMany({ where: { userId: { in: created.users } } }).catch(() => {});
  await prisma.user.updateMany({ where: { id: { in: created.users } }, data: { status: 'SUSPENDED' } }).catch(() => {});
  await prisma.customer.updateMany({ where: { id: { in: created.businesses } }, data: { isArchived: true, isActive: false } }).catch(() => {});
  await prisma.$disconnect();
}
console.log(`\nmdm: ${pass} passed, ${fail} failed`);
if (fail) { for (const f of failures) console.error(`  ✗ ${f}`); process.exit(1); }
