#!/usr/bin/env node
/**
 * End-to-end proof of 0.55's alert conditions and automatic PSA tickets,
 * against the real built API, its own monitoring sweep and a loopback webhook
 * stub — no real PSA is ever called.
 *
 *   - the four new monitor kinds raise from stored evidence alone: a low
 *     drive D: (one alert per drive, C: and E: fine), a computer not
 *     restarted for 40 days, a security update outstanding for 20 days, and a
 *     failed update install — and a drive that recovers resolves;
 *   - Settings → Monitoring → Automatic tickets: who may change it, fresh
 *     authentication (monitoring.autoticket), audited before and after;
 *   - exactly one ticket per alert, through the business's own connector,
 *     carrying a manual alert ticket's draft (no detail) and audited before
 *     the send with ids only; the alert and the dashboard show the reference;
 *   - never for the backlog (an alert first seen before the rule was on),
 *     below the severity floor or outside the rule's kinds, inside a
 *     maintenance window, or under a `notifications` pause (sent once it is
 *     lifted); only after an OFFLINE alert's correlation hold;
 *   - a per-business hourly budget; a failed send recorded, retried after
 *     the backoff, given up after four sends; an interrupted send given up;
 *   - the dashboard's Recent alerts: monitoring:alerts AND the device
 *     visibility rule, and an empty state when no monitor applies.
 *
 *   cd apps/api && npx nest build
 *   DATABASE_URL=postgresql://…/<scratch or test> node scripts/e2e-alert-tickets.mjs
 *
 * Ports 3811 (API) and 3812 (webhook stub). The suite owns the platform
 * ticket rule and the platform PSA connector while it runs, so it refuses a
 * database that already has either, or any global monitor.
 */
import { PrismaClient } from '@prisma/client';
import { confirmEverythingAsks } from './lib/confirm-asks.mjs';
import argon2 from 'argon2';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const DB = process.env.DATABASE_URL ?? '';
const dbName = DB.split('/').pop()?.split('?')[0] ?? '';
if (!/scratch|test/.test(dbName)) { console.error(`Refusing to run against database "${dbName}": name must contain "scratch" or "test".`); process.exit(2); }
const PORT = Number(process.env.ALERT_TICKETS_API_PORT ?? 3811);
const HOOK_PORT = PORT + 1;
for (const p of [PORT, HOOK_PORT]) if (p < 3811 || p > 3813) { console.error(`Refusing port ${p}: this suite uses 3811–3813.`); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
const prisma = new PrismaClient();
// 0.64: every confirmation defaults to off. This suite proves step-ups, so it
// asks for them all before its API reads the policy.
await confirmEverythingAsks(prisma);
const sfx = randomBytes(3).toString('hex');
const PW = 'alerttk-e2e-password-123';
const WEB = 'https://rmm.example.test';
const BUDGET = 8;
const HOLD_S = 8;

let pass = 0, fail = 0;
const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;
const J = (x) => JSON.stringify(x);

// ── Webhook stub ────────────────────────────────────────────────────────────
const hookHits = [];
let ticketNo = 0;
const hookServer = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; });
  req.on('end', () => {
    let j = null; try { j = JSON.parse(b); } catch { /* */ }
    hookHits.push({ path: req.url, at: Date.now(), body: b, json: j });
    res.setHeader('content-type', 'application/json');
    if (req.url?.startsWith('/fail')) { res.statusCode = 503; return res.end('{"error":"down"}'); }
    ticketNo++;
    res.end(J({ ticket_id: `T-${sfx}-${ticketNo}`, url: `https://psa.example.com/tickets/${ticketNo}` }));
  });
});
const hitsFor = (alertId) => hookHits.filter((h) => h.json?.ticket?.alert?.id === alertId);

// ── API ─────────────────────────────────────────────────────────────────────
let api;
function startApi() {
  const p = spawn(process.execPath, [path.join(dist, 'main.js')], {
    env: {
      ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATABASE_URL: DB,
      JWT_SECRET: randomBytes(32).toString('hex'), LAUNCHER_TOKEN_SECRET: randomBytes(32).toString('hex'), ENCRYPTION_KEY: randomBytes(32).toString('hex'),
      TRUSTED_PROXIES: 'loopback', HBBS_PRESENCE_HOST: '127.0.0.2', VERSION_FILE: path.resolve(here, '..', '..', '..', 'version.json'), FRONTEND_URL: WEB,
      INTEGRATION_PEERS_FILE: '',
      // The monitoring sweep is what is under test; every other sweep is off.
      MONITOR_SWEEP: 'on', MONITOR_SWEEP_SECONDS: '2', MONITOR_INVENTORY_SECONDS: '1', MONITOR_OFFLINE_HOLD_SECONDS: String(HOLD_S),
      PSA_AUTO_TICKETS_PER_HOUR: String(BUDGET),
      REPORT_SCHEDULE_SWEEP: 'off', AUDIT_SEALER: 'off', ENDPOINT_STALE_SWEEP: 'off', STALE_SWEEP: 'off', SNAPSHOT_SWEEP: 'off', RETENTION_SWEEP: 'off',
      CHAT_RETENTION_SWEEP: 'off', TRAY_SWEEP: 'off', AGENT_AUTO_UPDATE: 'off', AUTO_MIGRATION_SWEEP: 'off', WINGET_INDEX_SWEEP: 'off', PATCH_POLICY_SWEEP: 'off',
      SCRIPT_OUTPUT_SWEEP: 'off', METRIC_SWEEP: 'off', CLIENT_UPDATE_SWEEP: 'off',
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
async function req(method, p, { s, body, business } = {}) {
  await sleep(40);
  const h = { 'content-type': 'application/json', 'x-forwarded-for': ip() };
  if (s) h.cookie = s.cookie + (s.stepUp ? `; step_up=${s.stepUp}` : '');
  if (business) h['x-rem0te-business'] = business;
  const r = await fetch(`${API}${p}`, { method, headers: h, body: body ? J(body) : undefined });
  const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j, data: j?.data, text, setCookie: r.headers.get('set-cookie') ?? '' };
}
async function login(email) {
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip() }, body: J({ email, password: PW }) });
  const mm = (r.headers.get('set-cookie') ?? '').match(/access_token=([^;]+)/);
  if (r.status !== 200 || !mm) throw new Error(`login ${email}: ${r.status} ${await r.text()}`);
  return { cookie: `access_token=${mm[1]}` };
}
async function stepUp(s) {
  const r = await req('POST', '/auth/step-up', { s, body: { password: PW } });
  const mm = r.setCookie.match(/step_up=([^;]+)/);
  if (r.status !== 200 || !mm) throw new Error(`step-up: ${r.status} ${J(r.body)}`);
  return { ...s, stepUp: mm[1] };
}
const code = (r) => r.body?.code ?? r.body?.message?.code ?? r.body?.error?.code;
const msg = (r) => `HTTP ${r.status} ${typeof r.body === 'string' ? r.body.slice(0, 300) : J(r.body).slice(0, 400)}`;
async function until(fn, ms = 30_000, step = 500) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return v; await sleep(step); }
}
const created = { businesses: [], users: [], pauses: [] };

const GB = 1024 ** 3;
const SEC = '0fa1201d-4330-4fa8-8ae9-b877473b6441';
const gid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const DAY = 86_400_000;

async function all() {
  await new Promise((r, j) => { hookServer.once('error', j); hookServer.listen(HOOK_PORT, '127.0.0.1', r); });
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  if (await prisma.monitorTicketPolicy.findUnique({ where: { scopeKey: 'global' } })) throw new Error('This database already has a platform ticket rule; use a fresh scratch database.');
  if (await prisma.psaConnector.findUnique({ where: { scopeKey: 'global' } })) throw new Error('This database already has a platform PSA connector; use a fresh scratch database.');
  if (await prisma.monitorRule.count({ where: { scopeKey: 'global' } })) throw new Error('This database already has global monitors, which the sweep would apply to these fixtures; use a fresh scratch database.');
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });
  const roleUser = await prisma.role.findFirst({ where: { type: 'BUSINESS_USER' } });

  section('Fixtures (synthetic): Acme (A), Birch (B), Cedar (C), Pine (P)');
  const mkBiz = async (n) => { const c = await prisma.customer.create({ data: { tenantId: tenant.id, name: `${n} ${sfx}` } }); created.businesses.push(c.id); return c; };
  const A = await mkBiz('Acme Widgets'), B = await mkBiz('Birch Partners'), C = await mkBiz('Cedar Clinic'), P = await mkBiz('Pine Legal');
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag, extra = {}) => { const u = await prisma.user.create({ data: { email: `at-${tag}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'AT', lastName: tag, status: 'ACTIVE', ...extra } }); created.users.push(u.id); return u; };
  const admin = await mkUser('admin', { isPlatformAdmin: true });
  const ownerA = await mkUser('owner-a'), ownerB = await mkUser('owner-b'), userA = await mkUser('user-a'), viewerA = await mkUser('viewer-a');
  await prisma.membership.create({ data: { userId: ownerA.id, tenantId: tenant.id, customerId: A.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: ownerB.id, tenantId: tenant.id, customerId: B.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: userA.id, tenantId: tenant.id, customerId: A.id, roleId: roleUser.id, capabilities: ['computers:view', 'monitoring:alerts'] } });
  await prisma.membership.create({ data: { userId: viewerA.id, tenantId: tenant.id, customerId: A.id, roleId: roleUser.id, capabilities: ['computers:view'] } });

  const now = Date.now();
  const okDisks = [{ drive: 'C:', label: 'OS', fsType: 'NTFS', totalBytes: 200 * GB, freeBytes: 120 * GB }];
  const lowD = [...okDisks, { drive: 'D:', label: 'Data', fsType: 'NTFS', totalBytes: 100 * GB, freeBytes: 3 * GB }];
  const mkEp = async (biz, tag, { inv = {}, ep = {} } = {}) => {
    const e = await prisma.endpoint.create({ data: { tenantId: tenant.id, customerId: biz.id, name: `${tag}-${sfx}`.toUpperCase(), hostname: `${tag}-${sfx}.example.test`, osVersion: 'Windows 11 Pro', platform: 'Windows', status: 'ACTIVE', isOnline: true, isManaged: true, lastSeenAt: new Date(), accessMode: 'COMPANY_WIDE', ...ep } });
    await prisma.endpointInventory.create({ data: { endpointId: e.id, disks: okDisks, collectedAt: new Date(now - 3_600_000), lastBootAt: new Date(now - 2 * DAY), liveSampledAt: new Date(), ...inv } });
    return e;
  };
  const posture = {
    schema: 'rem0te-patch-posture/1', scannedAt: new Date(now - 3_600_000).toISOString(),
    updates: [{ updateId: gid(1), revision: 1, kb: 'KB5050001', title: 'Security Update 1', classification: SEC, downloaded: false, rebootBehavior: 0, userInput: false, eulaAccepted: true, browseOnly: false, sizeBytes: 1000 }],
    history: [{ updateId: gid(2), revision: 1, kb: 'KB5050002', title: 'Cumulative Update 2', result: 'failed', hresult: '0x80070005', operation: 'install', date: new Date(now - 2 * DAY).toISOString() }],
    reboot: { pending: false, sources: [] }, managers: [], autoUpdate: 'enabled',
  };
  const NAME_A1 = `acme-pc1-${sfx}`.toUpperCase();
  const a1 = await mkEp(A, 'acme-pc1', { inv: { disks: [...lowD, { drive: 'E:', label: 'Media', fsType: 'NTFS', totalBytes: 100 * GB, freeBytes: 60 * GB }], lastBootAt: new Date(now - 40 * DAY), patchPosture: posture } });
  const a2 = await mkEp(A, 'acme-pc2');
  const a3 = await mkEp(A, 'acme-pc3', { inv: { disks: lowD } }); // in a maintenance window
  const a4 = await mkEp(A, 'acme-pc4', { inv: { disks: lowD }, ep: { accessMode: 'ASSIGNED_USERS' } }); // not visible to userA
  const aOff = await mkEp(A, 'acme-off', { ep: { isOnline: false, lastSeenAt: new Date(now - 3_600_000) }, inv: { liveSampledAt: null } });
  const b1 = await mkEp(B, 'birch-pc1', { inv: { disks: lowD, lastBootAt: new Date(now - 40 * DAY) } });
  const b2 = await mkEp(B, 'birch-pc2', { inv: { disks: lowD } });
  const cs = []; for (let i = 0; i < BUDGET + 2; i++) cs.push(await mkEp(C, `cedar-pc${i}`, { inv: { disks: lowD } }));
  const cUp = await mkEp(C, 'cedar-up', { inv: { lastBootAt: new Date(now - 40 * DAY) } });
  const p1 = await mkEp(P, 'pine-pc1', { inv: { disks: lowD } });

  api = startApi();
  await waitUp();
  const S = { admin: await login(admin.email), ownerA: await login(ownerA.email), ownerB: await login(ownerB.email), userA: await login(userA.email), viewerA: await login(viewerA.email) };
  const up = { admin: await stepUp(S.admin), ownerA: await stepUp(S.ownerA), ownerB: await stepUp(S.ownerB), userA: await stepUp(S.userA) };

  // ── Dashboard before any monitor ─────────────────────────────────────────
  section('Dashboard: with no monitor, Recent alerts says so');
  let r = await req('GET', `/dashboard/overview?businessId=${B.id}`, { s: S.ownerB, business: B.id });
  check(r.status === 200 && r.data?.recentAlerts?.monitorsConfigured === 0 && r.data.recentAlerts.list.length === 0, 'Birch has no monitors: monitorsConfigured 0, an empty list', msg(r));

  // ── Rules ─────────────────────────────────────────────────────────────────
  const mkRule = async (biz, key, kind, severity, params) => {
    const x = await req('POST', '/monitoring/rules', { s: S.admin, body: { scope: 'business', businessId: biz.id, key, kind, name: key, severity, params } });
    if (x.status !== 200 && x.status !== 201) throw new Error(`rule ${key}: ${msg(x)}`);
    return x.data;
  };
  // The backlog: Acme's uptime monitor exists, and its alert on a1 is open,
  // before any ticket rule is switched on.
  await mkRule(A, 'uptime', 'UPTIME_LONG', 'WARNING', { days: 30 });
  const backlog = await until(async () => (await prisma.monitorAlert.findMany({ where: { endpointId: a1.id, kind: 'UPTIME_LONG', state: 'OPEN' } }))[0], 20_000);
  if (!backlog) throw new Error('the uptime alert never opened');
  await sleep(1100);
  section('Automatic tickets: who may change the rule, fresh authentication, audited');
  const pol = (o = {}) => ({ scope: 'business', businessId: A.id, enabled: true, minSeverity: 'WARNING', kinds: [], ...o });
  r = await req('PUT', '/monitoring/ticket-policy', { s: S.ownerA, business: A.id, body: pol() });
  check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED', 'a Business Owner without fresh authentication is refused (monitoring.autoticket)', msg(r));
  r = await req('PUT', '/monitoring/ticket-policy', { s: up.userA, business: A.id, body: pol() });
  check(r.status === 403, 'a Business User cannot set it, even freshly authenticated', msg(r));
  r = await req('PUT', '/monitoring/ticket-policy', { s: up.ownerB, business: B.id, body: pol() });
  check(r.status === 403 || r.status === 404, 'another business\'s owner cannot set Acme\'s', msg(r));
  r = await req('PUT', '/monitoring/ticket-policy', { s: up.ownerA, business: A.id, body: { scope: 'global', enabled: true } });
  check(r.status === 403, 'a Business Owner cannot set the platform rule', msg(r));
  r = await req('PUT', '/monitoring/ticket-policy', { s: up.ownerA, business: A.id, body: pol({ kinds: ['SITE_OUTAGE'] }) });
  check(r.status === 400, 'a site outage is not a kind a rule may name (strict input)', msg(r));
  r = await req('PUT', '/monitoring/ticket-policy', { s: up.ownerA, business: A.id, body: { ...pol(), url: 'https://evil.example' } });
  check(r.status === 400, 'unknown fields are refused', msg(r));
  check((await prisma.monitorTicketPolicy.count({ where: { customerId: A.id } })) === 0, 'and nothing was written');
  r = await req('PUT', '/monitoring/ticket-policy', { s: up.ownerA, business: A.id, body: pol() });
  check(r.status === 200 && r.data?.business?.enabled === true && r.data.business.minSeverity === 'WARNING' && r.data.effective === 'business' && !!r.data.business.enabledAt, 'Acme\'s owner switches it on (warning and above), freshly authenticated', msg(r));
  const auditA = await prisma.activityLog.findFirst({ where: { action: 'MONITOR_TICKET_POLICY_CHANGED', customerId: A.id }, orderBy: { createdAt: 'desc' } });
  check(!!auditA && auditA.metadata?.before === null && auditA.metadata?.after?.enabled === true && auditA.metadata?.after?.minSeverity === 'WARNING', 'audited: MONITOR_TICKET_POLICY_CHANGED, before null, after on', J(auditA?.metadata));
  r = await req('PUT', '/monitoring/ticket-policy', { s: up.ownerB, business: B.id, body: pol({ businessId: B.id, minSeverity: 'CRITICAL' }) });
  check(r.status === 200 && r.data?.business?.minSeverity === 'CRITICAL', 'Birch: critical only', msg(r));
  r = await req('PUT', '/monitoring/ticket-policy', { s: S.admin, body: { scope: 'global', enabled: true, minSeverity: 'CRITICAL', kinds: ['DRIVE_FREE'] } });
  check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED', 'the platform rule needs fresh authentication too', msg(r));
  r = await req('PUT', '/monitoring/ticket-policy', { s: up.admin, body: { scope: 'global', enabled: true, minSeverity: 'CRITICAL', kinds: ['DRIVE_FREE'] } });
  check(r.status === 200 && r.data?.global?.enabled === true && J(r.data.global.kinds) === J(['DRIVE_FREE']), 'the Platform Admin sets the platform rule: critical drive-space alerts', msg(r));
  r = await req('GET', `/monitoring/ticket-policy?businessId=${C.id}`, { s: S.admin });
  check(r.status === 200 && r.data?.effective === 'global' && r.data.business === null, 'Cedar has no rule of its own, so the platform rule applies', msg(r));
  r = await req('GET', `/monitoring/ticket-policy?businessId=${A.id}`, { s: S.ownerA, business: A.id });
  check(r.status === 200 && r.data?.effective === 'business' && r.data.may.business === true && r.data.may.global === false, 'Acme\'s owner sees its own rule in effect and may change only that', msg(r));

  section('PSA connectors: Acme and Birch their own, the platform default for the rest');
  const hook = (pathPart) => `http://127.0.0.1:${HOOK_PORT}/${pathPart}-${sfx}`;
  r = await req('PUT', '/psa/connectors', { s: up.ownerA, business: A.id, body: { scope: 'business', businessId: A.id, kind: 'webhook', enabled: true, label: 'Acme PSA', webhookUrl: hook('acme') } });
  check(r.status === 200, 'Acme: a webhook', msg(r));
  r = await req('PUT', '/psa/connectors', { s: up.ownerB, business: B.id, body: { scope: 'business', businessId: B.id, kind: 'webhook', enabled: true, label: 'Birch PSA', webhookUrl: hook('fail/birch') } });
  check(r.status === 200, 'Birch: a webhook that is down', msg(r));
  r = await req('PUT', '/psa/connectors', { s: up.admin, body: { scope: 'global', kind: 'webhook', enabled: true, label: 'MSP PSA', webhookUrl: hook('msp') } });
  check(r.status === 200, 'the platform default: a webhook', msg(r));

  section('A maintenance window on one computer, and a notifications pause on Pine');
  r = await req('POST', '/monitoring/suppressions', { s: S.admin, body: { scope: 'endpoint', endpointId: a3.id, reason: 'Disk swap', endsAt: new Date(Date.now() + 3_600_000).toISOString() } });
  check(r.status === 200 || r.status === 201, 'a window for acme-pc3', msg(r));
  const pause = await prisma.containmentPause.create({ data: { scope: 'BUSINESS', customerId: P.id, kinds: ['notifications'], reason: 'e2e stop notifications', setById: admin.id, setBy: 'msp' } });
  created.pauses.push(pause.id);

  section('Monitors (business scope): drives, uptime, outstanding and failed updates, offline');
  r = await req('POST', '/monitoring/rules', { s: S.admin, body: { scope: 'business', businessId: A.id, key: 'drive', kind: 'DRIVE_FREE', name: 'bad', severity: 'CRITICAL', params: { drives: ['/mnt'] } } });
  check(r.status === 400, 'a drive outside the letter charset is refused', msg(r));
  // The 14-day clock for a1's security update started 20 days ago.
  await prisma.endpointMonitorState.create({ data: { endpointId: a1.id, ruleKey: 'missing', lastValue: { seen: { [gid(1)]: new Date(now - 20 * DAY).toISOString() } } } });
  await mkRule(A, 'drive', 'DRIVE_FREE', 'CRITICAL', { minFreePercent: 10 });
  await mkRule(A, 'missing', 'UPDATES_MISSING', 'WARNING', { days: 14 });
  await mkRule(A, 'failed', 'UPDATE_FAILED', 'WARNING', { days: 7 });
  await mkRule(A, 'offline', 'OFFLINE', 'CRITICAL', { minutes: 5 });
  await mkRule(B, 'drive', 'DRIVE_FREE', 'CRITICAL', { minFreePercent: 10 });
  await mkRule(B, 'uptime', 'UPTIME_LONG', 'WARNING', { days: 30 });
  await mkRule(C, 'drive', 'DRIVE_FREE', 'CRITICAL', { minFreePercent: 10 });
  await mkRule(C, 'uptime', 'UPTIME_LONG', 'CRITICAL', { days: 30 });
  await mkRule(P, 'drive', 'DRIVE_FREE', 'CRITICAL', { minFreePercent: 10 });

  section('The four new kinds raise from stored evidence');
  const openOf = (where) => prisma.monitorAlert.findMany({ where: { state: { not: 'RESOLVED' }, ...where }, include: { autoTicket: true } });
  const a1Alerts = await until(async () => { const l = await openOf({ endpointId: a1.id }); return l.length >= 4 && l.some((x) => x.kind === 'UPDATES_MISSING') && l.some((x) => x.kind === 'UPDATE_FAILED') ? l : null; }, 40_000) ?? await openOf({ endpointId: a1.id });
  const by = (k) => a1Alerts.filter((x) => x.kind === k);
  const drive = by('DRIVE_FREE');
  check(drive.length === 1 && drive[0].dedupKey === `drive:${a1.id}:D` && /drive D: 3\.0% free/.test(drive[0].title) && drive[0].severity === 'CRITICAL', 'drive D: at 3% free: one alert, keyed by the drive; C: and E: raise nothing', J(drive.map((x) => [x.dedupKey, x.title])));
  check(by('UPTIME_LONG').length === 1 && by('UPTIME_LONG')[0].id === backlog.id, 'not restarted for 40 days: the alert opened before the ticket rule, still the one alert');
  check(by('UPDATES_MISSING').length === 1 && /security or critical update outstanding for over 14 days/.test(by('UPDATES_MISSING')[0].title), 'a security update outstanding for 20 days', J(by('UPDATES_MISSING').map((x) => x.title)));
  check(by('UPDATE_FAILED').length === 1 && by('UPDATE_FAILED')[0].detail?.failures?.[0]?.hresult === '0x80070005', 'a failed install from Windows Update history, with its code', J(by('UPDATE_FAILED').map((x) => x.detail)));
  check((await openOf({ endpointId: a2.id })).length === 0, 'a healthy computer raises nothing');

  section('One ticket per alert, after the hold, outside windows and pauses');
  const ticketedA = await until(async () => {
    const l = await openOf({ customerId: A.id, autoTicket: { status: 'sent' } });
    return l.length >= 4 ? l : null;
  }, 40_000) ?? [];
  const sentKeys = ticketedA.map((x) => x.dedupKey).sort();
  check(J(sentKeys) === J([`drive:${a1.id}:D`, `drive:${a4.id}:D`, `failed:${a1.id}`, `missing:${a1.id}`].sort()), 'Acme: drive (a1, a4), outstanding and failed updates ticketed', J(sentKeys));
  for (const al of ticketedA) {
    const h = hitsFor(al.id);
    check(h.length === 1 && h[0].path === `/acme-${sfx}` && new RegExp(`^T-${sfx}-\\d+$`).test(al.autoTicket.ref ?? '') && /^https:\/\/psa\.example\.com\/tickets\/\d+$/.test(al.autoTicket.url ?? ''),
      `${al.kind}: one send to Acme's connector, its reference and link recorded`, J({ hits: h.length, ref: al.autoTicket.ref, url: al.autoTicket.url }));
  }
  const d1 = hitsFor(drive[0]?.id)[0]?.json?.ticket;
  check(!!d1 && d1.alert?.kind === 'DRIVE_FREE' && d1.source_ref === `alert:${drive[0].id}` && d1.link === `${WEB}/alerts?alert=${drive[0].id}` && d1.requested_by === 'Rem0te monitoring (automatic)',
    'the ticket: the alert, its source_ref, a link back, requested by Rem0te monitoring (automatic)', J(d1).slice(0, 500));
  const d1s = J(d1 ?? {});
  check(!/freeMb|freePercent|minFreePercent/.test(d1s) && !/"note":"[^"]/.test(d1s), 'and no alert detail and no note (what a manual alert ticket sends)', d1s.slice(0, 400));
  const backlogNow = await prisma.monitorAlert.findUnique({ where: { id: backlog.id }, include: { autoTicket: true } });
  check(backlogNow?.state !== 'RESOLVED' && !backlogNow?.autoTicket && hitsFor(backlog.id).length === 0, 'the backlog alert (first seen before the rule was on) is never ticketed');
  const a3Alert = (await openOf({ endpointId: a3.id }))[0];
  check(!!a3Alert && !a3Alert.autoTicket && hitsFor(a3Alert.id).length === 0, 'the computer in a maintenance window: alert open, no ticket', J(a3Alert));

  // OFFLINE's correlation hold.
  const off = await until(async () => (await openOf({ endpointId: aOff.id, kind: 'OFFLINE' }))[0], 20_000);
  check(!!off && off.notifyFrom > off.firstSeenAt, 'the offline alert carries its correlation hold', J(off));
  if (off) {
    if (Date.now() < off.notifyFrom.getTime() - 2000) {
      const early = await prisma.monitorAlertTicket.findUnique({ where: { alertId: off.id } });
      check(!early && hitsFor(off.id).length === 0, 'no ticket while the hold runs');
    }
    const offT = await until(async () => (await prisma.monitorAlertTicket.findUnique({ where: { alertId: off.id } }))?.status === 'sent', (HOLD_S + 15) * 1000);
    const sentAt = hitsFor(off.id)[0]?.at ?? 0;
    check(!!offT && sentAt >= off.notifyFrom.getTime(), 'after the hold it is ticketed, not before', `sent ${new Date(sentAt).toISOString()} hold ${off.notifyFrom.toISOString()}`);
  }

  // Severity and kind.
  const bUp = (await openOf({ endpointId: b1.id, kind: 'UPTIME_LONG' }))[0];
  check(!!bUp && !bUp.autoTicket, 'Birch (critical only): its warning uptime alert is not ticketed', J(bUp));
  const cUpA = await until(async () => (await openOf({ endpointId: cUp.id, kind: 'UPTIME_LONG' }))[0], 10_000);
  check(!!cUpA && cUpA.severity === 'CRITICAL' && !cUpA.autoTicket, 'Cedar (platform rule, drive space only): a critical uptime alert is not ticketed', J(cUpA));

  // Pause.
  const pAlert = (await openOf({ endpointId: p1.id }))[0];
  check(!!pAlert && !pAlert.autoTicket && hitsFor(pAlert.id).length === 0, 'Pine, under a notifications pause: alert open, nothing sent', J(pAlert));

  section('Never twice');
  const before = hookHits.length;
  await sleep(7000);
  const again = await prisma.monitorAlertTicket.groupBy({ by: ['alertId'], _count: true, where: { customerId: A.id } });
  check(again.every((g) => g._count === 1) && hookHits.filter((h) => h.path === `/acme-${sfx}`).length === 5, 'after more sweeps Acme still has one ticket per alert (five sends)', `hits ${hookHits.length - before} new; ${J(again)}`);

  section('A notifications pause lifted: the alert is ticketed then');
  await prisma.containmentPause.update({ where: { id: pause.id }, data: { clearedAt: new Date() } });
  const pT = await until(async () => (await prisma.monitorAlertTicket.findUnique({ where: { alertId: pAlert?.id ?? '-' } }))?.status === 'sent', 15_000);
  check(!!pT && hitsFor(pAlert.id).length === 1 && hitsFor(pAlert.id)[0].path === `/msp-${sfx}`, 'sent once, through the platform connector');

  section('The per-business hourly budget');
  const cRows = await prisma.monitorAlertTicket.findMany({ where: { customerId: C.id } });
  const cOpen = await openOf({ customerId: C.id, kind: 'DRIVE_FREE' });
  check(cOpen.length === BUDGET + 2 && cRows.length === BUDGET && cRows.every((x) => x.status === 'sent'), `Cedar: ${BUDGET + 2} drive alerts, ${BUDGET} tickets (PSA_AUTO_TICKETS_PER_HOUR=${BUDGET})`, `alerts ${cOpen.length}, rows ${cRows.length}`);

  section('A failed send: recorded, retried after the backoff, given up after four');
  const bAlerts = await openOf({ customerId: B.id, kind: 'DRIVE_FREE' });
  const bA1 = bAlerts.find((x) => x.endpointId === b1.id), bA2 = bAlerts.find((x) => x.endpointId === b2.id);
  const row1 = await prisma.monitorAlertTicket.findUnique({ where: { alertId: bA1?.id ?? '-' } });
  check(row1?.status === 'failed' && row1.attempts === 1 && !!row1.lastStatus,
    'the first send failed: status failed, one attempt', J(row1));
  const wait = row1?.nextAttemptAt ? row1.nextAttemptAt.getTime() - row1.lastAttemptAt.getTime() : 0;
  check(wait >= 4.9 * 60_000 && wait <= 5.1 * 60_000, 'the next try is five minutes later', `${wait} ms`);
  const ev = await prisma.monitorAlertEvent.findFirst({ where: { alertId: bA1?.id, type: 'ticket_failed' } });
  check(!!ev && ev.detail?.attempt === 1 && typeof ev.detail?.retryAt === 'string', 'the alert history says it was not sent, and when it will be tried again', J(ev?.detail));
  const fAud = await prisma.activityLog.findFirst({ where: { action: 'PSA_TICKET_FAILED', resourceId: bA1?.id } });
  check(!!fAud && fAud.metadata?.attempt === 1 && fAud.metadata?.source === 'monitoring', 'audited: PSA_TICKET_FAILED', J(fAud?.metadata));
  await sleep(5000);
  check((await prisma.monitorAlertTicket.findUnique({ where: { alertId: bA1.id } }))?.attempts === 1 && hitsFor(bA1.id).length === 1, 'nothing more is sent before the retry time');
  const waits = [];
  for (const n of [2, 3, 4]) {
    const cur = await prisma.monitorAlertTicket.findUnique({ where: { alertId: bA1.id } });
    await prisma.monitorAlertTicket.update({ where: { id: cur.id }, data: { nextAttemptAt: new Date(Date.now() - 1000), lastAttemptAt: new Date(Date.now() - 3_000_000) } });
    const nx = await until(async () => { const x = await prisma.monitorAlertTicket.findUnique({ where: { alertId: bA1.id } }); return x.attempts === n ? x : null; }, 15_000);
    waits.push(nx ? (nx.nextAttemptAt ? Math.round((nx.nextAttemptAt.getTime() - nx.lastAttemptAt.getTime()) / 60_000) : null) : 'stuck');
  }
  const gave = await prisma.monitorAlertTicket.findUnique({ where: { alertId: bA1.id } });
  check(J(waits) === J([30, 120, null]) && gave.status === 'gave_up' && gave.attempts === 4 && hitsFor(bA1.id).length === 4, 'then 30 and 120 minutes, and after the fourth send it gives up', J({ waits, status: gave.status, attempts: gave.attempts, hits: hitsFor(bA1.id).length }));
  await sleep(5000);
  check(hitsFor(bA1.id).length === 4, 'a given-up ticket is never sent again');
  r = await req('PUT', '/psa/connectors', { s: up.ownerB, business: B.id, body: { scope: 'business', businessId: B.id, kind: 'webhook', enabled: true, label: 'Birch PSA', webhookUrl: hook('birch') } });
  check(r.status === 200, 'Birch\'s PSA is fixed', msg(r));
  const row2 = await prisma.monitorAlertTicket.findUnique({ where: { alertId: bA2.id } });
  await prisma.monitorAlertTicket.update({ where: { id: row2.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
  const sent2 = await until(async () => { const x = await prisma.monitorAlertTicket.findUnique({ where: { alertId: bA2.id } }); return x.status === 'sent' ? x : null; }, 15_000);
  check(!!sent2 && sent2.attempts === 2 && !!sent2.ref && !!sent2.psaTicketId, 'the retry succeeds: sent on the second try, the reference recorded', J(sent2));

  section('An interrupted send is given up, never resent');
  const spare = cOpen.find((x) => !cRows.some((y) => y.alertId === x.id));
  const stuck = await prisma.monitorAlertTicket.create({ data: { alertId: spare.id, customerId: C.id, status: 'sending', attempts: 1, lastAttemptAt: new Date(Date.now() - 20 * 60_000), connectorKind: 'webhook', connectorScope: 'global' } });
  const unstuck = await until(async () => { const x = await prisma.monitorAlertTicket.findUnique({ where: { id: stuck.id } }); return x.status === 'gave_up' ? x : null; }, 10_000);
  check(unstuck?.lastStatus === 'interrupted' && hitsFor(spare.id).length === 0, 'a send left "sending" for 20 minutes becomes "given up (interrupted)"', J(unstuck));

  section('Audit: before the send, ids only');
  const reqRows = await prisma.activityLog.findMany({ where: { action: 'PSA_AUTO_TICKET_REQUESTED', customerId: { in: created.businesses } } });
  const createdRows = await prisma.activityLog.findMany({ where: { action: 'PSA_TICKET_CREATED', customerId: { in: created.businesses }, metadata: { path: ['source'], equals: 'monitoring' } } });
  check(reqRows.length >= 16 && createdRows.length >= 12, 'a PSA_AUTO_TICKET_REQUESTED row for every send and a PSA_TICKET_CREATED row for every ticket', `${reqRows.length} requested, ${createdRows.length} created`);
  const ordered = createdRows.every((c) => reqRows.some((q) => q.resourceId === c.resourceId && q.metadata?.attempt === c.metadata?.attempt && BigInt(q.seq) < BigInt(c.seq)));
  check(ordered, 'each one written before its ticket existed');
  const metaText = J([...reqRows, ...createdRows].map((x) => x.metadata));
  check(!metaText.includes(NAME_A1) && !/"(subject|body|title|note|text)"/.test(metaText) && !/drive D:/.test(metaText), 'no subject, body, title or computer name in any of them', metaText.slice(0, 300));
  check(reqRows.every((x) => x.actorId === null && x.metadata?.source === 'monitoring' && typeof x.metadata?.alertId === 'string' && typeof x.metadata?.kind === 'string'), 'no actor; source monitoring, the alert id and kind');

  section('Alerts and the device page show the reference');
  const dA = drive[0];
  r = await req('GET', `/monitoring/alerts/${dA.id}`, { s: S.userA, business: A.id });
  check(r.status === 200 && r.data?.autoTicket?.status === 'sent' && /^T-/.test(r.data.autoTicket.ref ?? '') && /^https:\/\//.test(r.data.autoTicket.url ?? ''), 'the alert: the ticket reference and its link', msg(r));
  r = await req('GET', `/monitoring/alerts?endpointId=${a1.id}`, { s: S.userA, business: A.id });
  const rows = r.data?.alerts ?? r.data?.items ?? r.data ?? [];
  check(r.status === 200 && Array.isArray(rows) && rows.some((x) => x.id === dA.id && x.autoTicket?.ref), 'the list (Alerts page, device Monitoring tab) carries it too', msg(r));
  const evs = await prisma.monitorAlertEvent.findMany({ where: { alertId: dA.id, type: 'ticketed' } });
  check(evs.length === 1 && evs[0].detail?.ref === ticketedA.find((x) => x.id === dA.id)?.autoTicket.ref, 'the alert history: "Ticket opened in the PSA" once');

  section('Dashboard: Recent alerts, inside the alerts capability and the device visibility rule');
  r = await req('GET', '/dashboard/overview', { s: S.userA, business: A.id });
  const listU = r.data?.recentAlerts?.list ?? [];
  check(r.status === 200 && listU.length > 0 && listU.every((x) => !x.device || [a1.id, a2.id, a3.id, aOff.id].includes(x.device.id)), 'a Business User sees Acme\'s alerts, never another business\'s', J(listU.map((x) => x.device?.id)));
  check(!listU.some((x) => x.device?.id === a4.id), 'and not the alert of a computer assigned to other people (endpointVisibilityWhere)');
  const dRow = listU.find((x) => x.id === dA.id);
  check(!!dRow && dRow.severity === 'CRITICAL' && dRow.ticket?.ref && dRow.href === `/alerts?alert=${dA.id}` && dRow.business?.id === A.id && typeof dRow.since === 'string', 'each row: severity, computer, business, since, the ticket reference and a link', J(dRow));
  check(r.data?.recentAlerts?.monitorsConfigured >= 5, 'monitorsConfigured counts the monitors that apply');
  r = await req('GET', '/dashboard/overview', { s: S.ownerA, business: A.id });
  check((r.data?.recentAlerts?.list ?? []).some((x) => x.device?.id === a4.id), 'the Business Owner sees that one too');
  r = await req('GET', '/dashboard/overview', { s: S.viewerA, business: A.id });
  check(r.status === 200 && r.data?.recentAlerts === null, 'without monitoring:alerts there is no Recent alerts at all', msg(r));
  r = await req('GET', `/dashboard/overview?businessId=${A.id}`, { s: S.ownerB, business: B.id });
  check(!(r.data?.recentAlerts?.list ?? []).some((x) => x.business?.id === A.id), 'Birch\'s owner never sees Acme\'s, even asking for it', msg(r));

  section('A drive that recovers resolves; the ticket stays');
  await prisma.endpointInventory.update({ where: { endpointId: a1.id }, data: { disks: [okDisks[0], { drive: 'D:', label: 'Data', fsType: 'NTFS', totalBytes: 100 * GB, freeBytes: 50 * GB }] } });
  const res = await until(async () => (await prisma.monitorAlert.findUnique({ where: { id: dA.id } }))?.state === 'RESOLVED', 15_000);
  check(!!res, 'D: back to 50% free: the alert resolves');
  check((await prisma.monitorAlertTicket.findUnique({ where: { alertId: dA.id } }))?.status === 'sent', 'the ticket row is kept (no connector can close a ticket)');

  section('Removing a business\'s rule hands it back to the platform rule');
  r = await req('DELETE', `/monitoring/ticket-policy?scope=business&businessId=${B.id}`, { s: S.ownerB, business: B.id });
  check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED', 'removing needs fresh authentication', msg(r));
  r = await req('DELETE', `/monitoring/ticket-policy?scope=business&businessId=${B.id}`, { s: up.ownerB, business: B.id });
  check(r.status === 200, 'removed', msg(r));
  r = await req('GET', `/monitoring/ticket-policy?businessId=${B.id}`, { s: S.ownerB, business: B.id });
  check(r.data?.effective === 'global', 'Birch now follows the platform rule', msg(r));

  check(!api.log.includes('auto ticket '), 'the pass logged no failure', api.log.split('\n').filter((l) => l.includes('auto ticket')).slice(0, 3).join(' | '));
}

async function cleanup() {
  if (api && api.exitCode === null) await new Promise((r) => { api.once('exit', r); api.kill('SIGTERM'); });
  hookServer.close();
  try {
    const ids = created.businesses;
    const eps = (await prisma.endpoint.findMany({ where: { customerId: { in: ids } }, select: { id: true } })).map((e) => e.id);
    await prisma.monitorAlert.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.psaTicket.deleteMany({ where: { endpointId: { in: eps } } });
    await prisma.psaConnector.deleteMany({ where: { OR: [{ customerId: { in: ids } }, { scopeKey: 'global' }] } });
    await prisma.monitorTicketPolicy.deleteMany({ where: { OR: [{ customerId: { in: ids } }, { scopeKey: 'global' }] } });
    await prisma.monitorSuppression.deleteMany({ where: { OR: [{ customerId: { in: ids } }, { endpointId: { in: eps } }] } });
    await prisma.monitorRule.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.endpointMonitorState.deleteMany({ where: { endpointId: { in: eps } } });
    await prisma.endpointInventory.deleteMany({ where: { endpointId: { in: eps } } });
    await prisma.endpoint.deleteMany({ where: { id: { in: eps } } });
    await prisma.containmentPause.deleteMany({ where: { id: { in: created.pauses } } });
    await prisma.membership.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.customer.deleteMany({ where: { id: { in: ids } } });
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
