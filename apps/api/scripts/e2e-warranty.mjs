#!/usr/bin/env node
/**
 * End-to-end proof of hardware warranty and support links (0.56), against the
 * real built API and a loopback vendor stub only — no real Dell or Lenovo API
 * is ever called, and every serial here is synthetic.
 *
 *   - the device page's warranty view: support links per vendor, the
 *     virtual-machine note, the serial in a link only for Dell;
 *   - a manual entry: computers:edit on that computer, a 404 for another
 *     business's, validation, a conditional write, WARRANTY_SET with before
 *     and after;
 *   - Settings → Warranty: Platform Admin only, fresh authentication, the
 *     credential never in a response, an audit row or the API's output;
 *   - "Check now" through the stub for Dell (token + entitlements) and Lenovo
 *     (ClientID header): only the serial reaches the stub; a manual entry is
 *     never overwritten; an integration pause refuses before anything leaves;
 *   - the sweep (second API run, WARRANTY_SWEEP on, 2 s): bounded by the
 *     hourly limit, skips a paused business, asks each computer once;
 *   - the device list's warranty filter, sort and CSV; the report and its CSV
 *     scoped to the caller's computers; the dashboard tile's counts;
 *   - WARRANTY_EXPIRING (business monitor, MONITOR_SWEEP on, 2 s): raised for
 *     a computer inside the window, one alert, closed and raised again when
 *     the date moves, resolved when it moves out.
 *
 *   cd apps/api && npx nest build
 *   DATABASE_URL=postgresql://…/<name containing scratch or test> node scripts/e2e-warranty.mjs
 *
 * Ports 3821 (API), 3822 (vendor stub), 3823 (spare). Never 3001.
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
const PORT = Number(process.env.WARRANTY_API_PORT ?? 3821);
const STUB_PORT = PORT + 1;
for (const p of [PORT, STUB_PORT]) if (p < 3821 || p > 3823) { console.error(`Refusing port ${p}: this suite uses 3821–3823.`); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex').toUpperCase();
const PW = 'warranty-e2e-password-123';
const DELL_ID = `dell-client-${randomBytes(6).toString('hex')}`;
const DELL_SECRET = `dell-secret-${randomBytes(12).toString('hex')}`;
const LENOVO_SECRET = `lenovo-token-${randomBytes(12).toString('hex')}`;
const TOKEN = `tok-${randomBytes(8).toString('hex')}`;

let pass = 0, fail = 0;
const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;
const DAY = 86_400_000;
const isoDay = (d) => d.toISOString().slice(0, 10);

// ── The vendor stub ───────────────────────────────────────────────────────────
const hits = [];
const stub = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; });
  req.on('end', () => {
    hits.push({ method: req.method, url: req.url, headers: req.headers, body: b });
    res.setHeader('content-type', 'application/json');
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/dell/auth/oauth/v2/token') {
      if (!b.includes(`client_secret=${DELL_SECRET}`)) { res.statusCode = 401; return res.end('{"error":"invalid_client"}'); }
      return res.end(JSON.stringify({ access_token: TOKEN, token_type: 'Bearer', expires_in: 3600 }));
    }
    if (u.pathname === '/dell/PROD/sbil/eapi/v5/asset-entitlements') {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.statusCode = 401; return res.end('{}'); }
      const tag = u.searchParams.get('servicetags');
      return res.end(JSON.stringify([{ serviceTag: tag, invalid: false, entitlements: [
        { startDate: '2024-02-01T00:00:00Z', endDate: new Date(Date.now() + 200 * DAY).toISOString(), serviceLevelDescription: 'ProSupport Plus' },
      ] }]));
    }
    if (u.pathname === '/lenovo/v2.5/warranty') {
      if (req.headers.clientid !== LENOVO_SECRET) { res.statusCode = 401; return res.end('{}'); }
      return res.end(JSON.stringify({ Serial: u.searchParams.get('Serial'), Warranty: [
        { Name: 'Premier Support', Start: '2023-05-01T00:00:00Z', End: new Date(Date.now() + 45 * DAY).toISOString() },
      ] }));
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
      WARRANTY_TEST_BASE_URL: `http://127.0.0.1:${STUB_PORT}`,
      // Never production's GeoIP file (§54): a path that does not exist.
      GEOIP_DB_PATH: path.join(here, 'no-geoip.mmdb'),
      INTEGRATION_PEERS_FILE: '', REPORT_SCHEDULE_SWEEP: 'off', AUDIT_SEALER: 'off', ENDPOINT_STALE_SWEEP: 'off', STALE_SWEEP: 'off',
      CLIENT_UPDATE_SWEEP: 'off', PATCH_POLICY_SWEEP: 'off', METRIC_SWEEP: 'off', RETENTION_SWEEP: 'off', CHAT_RETENTION_SWEEP: 'off', TRAY_SWEEP: 'off',
      SCRIPT_OUTPUT_SWEEP: 'off', AUTO_MIGRATION_SWEEP: 'off', WINGET_INDEX_SWEEP: 'off', SNAPSHOT_SWEEP: 'off', AGENT_AUTO_UPDATE: 'off',
      MONITOR_SWEEP: 'off', WARRANTY_SWEEP: 'off',
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
let allLogs = '';
async function req(method, p, { s, body, business } = {}) {
  await sleep(40);
  const h = { 'content-type': 'application/json', 'x-forwarded-for': ip() };
  if (s) h.cookie = s.cookie + (s.stepUp ? `; step_up=${s.stepUp}` : '');
  if (business) h['x-rem0te-business'] = business;
  const r = await fetch(`${API}${p}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
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
const msg = (r) => `HTTP ${r.status} ${typeof r.body === 'string' ? r.body.slice(0, 300) : JSON.stringify(r.body).slice(0, 400)}`;
const created = { businesses: [], users: [], pauses: [] };
async function waitFor(fn, ms = 20_000) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(500); } return null; }

async function all() {
  await new Promise((r, j) => { stub.once('error', j); stub.listen(STUB_PORT, '127.0.0.1', r); });
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  if (await prisma.warrantyVendor.count()) throw new Error('This database already has warranty vendor settings; use a fresh scratch database.');
  if (await prisma.monitorRule.count({ where: { scopeKey: 'global' } })) throw new Error('This database has global monitors, which the monitoring sweep here would act on; use a fresh scratch database.');
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });
  const roleUser = await prisma.role.findFirst({ where: { type: 'BUSINESS_USER' } });

  section('Fixtures (synthetic): Acme (A) and Birch (B)');
  const A = await prisma.customer.create({ data: { tenantId: tenant.id, name: `Acme Warranty ${sfx}` } });
  const B = await prisma.customer.create({ data: { tenantId: tenant.id, name: `Birch Warranty ${sfx}` } });
  created.businesses.push(A.id, B.id);
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag, extra = {}) => { const u = await prisma.user.create({ data: { email: `wr-${tag}-${sfx.toLowerCase()}@test.invalid`, passwordHash: hash, firstName: 'WR', lastName: tag, status: 'ACTIVE', ...extra } }); created.users.push(u.id); return u; };
  const admin = await mkUser('admin', { isPlatformAdmin: true });
  const ownerA = await mkUser('owner-a'), ownerB = await mkUser('owner-b'), viewer = await mkUser('viewer-a');
  await prisma.membership.create({ data: { userId: ownerA.id, tenantId: tenant.id, customerId: A.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: ownerB.id, tenantId: tenant.id, customerId: B.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: viewer.id, tenantId: tenant.id, customerId: A.id, roleId: roleUser.id, capabilities: ['computers:view'] } });
  const mk = async (biz, name, manufacturer, model, serial) => {
    const e = await prisma.endpoint.create({ data: { tenantId: tenant.id, customerId: biz.id, name: `${name}-${sfx}`, hostname: `${name.toLowerCase()}-${sfx.toLowerCase()}.example.test`, serialNumber: serial, platform: 'Windows', status: 'ACTIVE', isOnline: true, isManaged: true, lastSeenAt: new Date(), accessMode: 'COMPANY_WIDE' } });
    await prisma.endpointInventory.create({ data: { endpointId: e.id, manufacturer, model, serialNumber: serial } });
    return e;
  };
  const TAG1 = `A${sfx}`, TAG2 = `C${sfx}`, TAG3 = `E${sfx}`, TAG4 = `F${sfx}`, TAGB = `B${sfx}`, LSN = `PF${sfx}`;
  const dell1 = await mk(A, 'DELL1', 'Dell Inc.', 'Latitude 7440', TAG1);
  const len1 = await mk(A, 'LEN1', 'LENOVO', '20XW0026US', LSN);
  const hp1 = await mk(A, 'HP1', 'HP', 'HP EliteBook 840 G9', `5CG${sfx}X`);
  const vm1 = await mk(A, 'VM1', 'VMware, Inc.', 'VMware Virtual Platform', `VMware-56 4d ${sfx}`);
  const old1 = await mk(A, 'OLD1', 'ASUSTeK COMPUTER INC.', 'ExpertBook', `N${sfx}0001`);
  const dellB = await mk(B, 'BIRCH1', 'Dell Inc.', 'OptiPlex 7010', TAGB);
  await prisma.endpoint.update({ where: { id: old1.id }, data: { warrantySource: 'manual', warrantyEndsAt: new Date(Date.now() - 10 * DAY) } });
  await prisma.endpoint.update({ where: { id: dellB.id }, data: { warrantySource: 'manual', warrantyEndsAt: new Date(Date.now() + 10 * DAY) } });

  api = startApi({});
  await waitUp();
  const S = { admin: await login(admin.email), ownerA: await login(ownerA.email), ownerB: await login(ownerB.email), viewer: await login(viewer.email) };
  const up = { admin: await stepUp(S.admin), ownerA: await stepUp(S.ownerA) };

  section('Support links on the device page');
  let r = await req('GET', `/endpoints/${dell1.id}/warranty`, { s: S.viewer });
  check(r.status === 200 && r.data.support.links[0].url === `https://www.dell.com/support/home/en-us/product-support/servicetag/${TAG1}/overview` && r.data.warranty.state === 'unknown' && r.data.lookup.implemented && !r.data.lookup.enabled,
    'Dell: the service tag is in the support link; no date yet; lookup implemented but off', msg(r));
  r = await req('GET', `/endpoints/${hp1.id}/warranty`, { s: S.viewer });
  check(r.status === 200 && r.data.support.vendorLabel === 'HP' && r.data.support.links.every((l) => !l.url.includes(sfx)) && r.data.lookup.implemented === true && r.data.lookup.enabled === false && r.data.gap?.reason === 'not_configured', 'HP: fixed pages, the serial not in any URL; from 0.61 a lookup exists but is off, and the card says so', msg(r));
  r = await req('GET', `/endpoints/${vm1.id}/warranty`, { s: S.viewer });
  check(r.status === 200 && r.data.support.maker.kind === 'virtual' && r.data.support.links.length === 0 && /no hardware warranty/.test(r.data.support.note), 'VMware: "virtual machine — no hardware warranty", no links', msg(r));
  r = await req('GET', `/endpoints/${dellB.id}/warranty`, { s: S.ownerA });
  check(r.status === 404 || r.status === 403, 'another business\'s computer is refused', msg(r));

  section('Entering a warranty by hand');
  const ends20 = isoDay(new Date(Date.now() + 20 * DAY));
  r = await req('PUT', `/endpoints/${hp1.id}/warranty`, { s: S.viewer, body: { endsAt: ends20 } });
  check(r.status === 403, 'View computers alone cannot change it', msg(r));
  r = await req('PUT', `/endpoints/${dellB.id}/warranty`, { s: S.ownerA, body: { endsAt: ends20 } });
  check(r.status === 404 || r.status === 403, 'another business\'s computer cannot be changed', msg(r));
  r = await req('PUT', `/endpoints/${hp1.id}/warranty`, { s: S.ownerA, body: { endsAt: '2026-02-30' } });
  check(r.status === 400, 'an impossible date is refused', msg(r));
  r = await req('PUT', `/endpoints/${hp1.id}/warranty`, { s: S.ownerA, body: { endsAt: ends20, coverage: '<img src=x onerror=alert(1)>' } });
  check(r.status === 400, 'coverage outside the charset is refused', msg(r));
  r = await req('PUT', `/endpoints/${hp1.id}/warranty`, { s: S.ownerA, body: { endsAt: ends20, startsAt: '2030-01-01' } });
  check(r.status === 400, 'a start after the end is refused', msg(r));
  r = await req('PUT', `/endpoints/${hp1.id}/warranty`, { s: S.ownerA, body: { endsAt: ends20, extra: 1 } });
  check(r.status === 400, 'unknown fields are refused', msg(r));
  r = await req('PUT', `/endpoints/${hp1.id}/warranty`, { s: S.ownerA, body: { endsAt: ends20, startsAt: '2023-01-01', coverage: 'Care Pack, next business day' } });
  check(r.status === 200 && r.data.warranty.source === 'manual' && r.data.warranty.state === 'expiring_30' && r.data.warranty.coverage === 'Care Pack, next business day', 'saved: by hand, ending within 30 days', msg(r));
  let audit = await prisma.activityLog.findFirst({ where: { action: 'WARRANTY_SET', resourceId: hp1.id }, orderBy: { createdAt: 'desc' } });
  check(!!audit && audit.metadata?.before?.source === null && audit.metadata?.after?.endsAt === ends20 && audit.metadata?.after?.source === 'manual' && audit.actorId === ownerA.id, 'WARRANTY_SET records before and after', JSON.stringify(audit?.metadata));

  section('Settings → Warranty: Platform Admin, fresh authentication, the credential never shown');
  r = await req('GET', '/warranty/settings', { s: S.ownerA });
  check(r.status === 403, 'a Business Owner cannot read the settings', msg(r));
  r = await req('GET', '/warranty/settings', { s: S.admin });
  check(r.status === 200 && r.data.vendors.length === 4 && r.data.vendors.every((v) => !v.enabled && !v.secretSet) && r.data.manualOnly.length === 4, 'off by default: Dell, Lenovo, HP and Apple can be switched on (0.61), four vendors are manual only', msg(r));
  r = await req('PUT', '/warranty/settings/lenovo', { s: S.admin, body: { enabled: true, secret: LENOVO_SECRET } });
  check(r.status === 401 || r.status === 403, 'saving without a fresh sign-in is refused', msg(r));
  r = await req('PUT', '/warranty/settings/lenovo', { s: up.ownerA, body: { enabled: true, secret: LENOVO_SECRET } });
  check(r.status === 403, 'a Business Owner, even freshly signed in, cannot save', msg(r));
  r = await req('PUT', '/warranty/settings/hpe', { s: up.admin, body: { enabled: true, secret: 'abcdefgh1234' } });
  check(r.status === 400 && code(r) === 'UNKNOWN_VENDOR', 'HPE has no lookup to switch on', msg(r));
  r = await req('PUT', '/warranty/settings/dell', { s: up.admin, body: { enabled: true, secret: DELL_SECRET } });
  check(r.status === 400 && code(r) === 'CLIENT_ID_REQUIRED', 'Dell needs its client id', msg(r));
  r = await req('PUT', '/warranty/settings/lenovo', { s: up.admin, body: { enabled: true, secret: LENOVO_SECRET } });
  check(r.status === 200 && r.data.enabled && r.data.secretSet && r.data.secretLast4 === LENOVO_SECRET.slice(-4) && !r.text.includes(LENOVO_SECRET), 'Lenovo on: the response says a key is set and its last four, never the key', msg(r));
  r = await req('PUT', '/warranty/settings/dell', { s: up.admin, body: { enabled: true, clientId: DELL_ID, secret: DELL_SECRET } });
  check(r.status === 200 && r.data.enabled && r.data.clientId === DELL_ID && !r.text.includes(DELL_SECRET), 'Dell on', msg(r));
  r = await req('GET', '/warranty/settings', { s: S.admin });
  check(!r.text.includes(DELL_SECRET) && !r.text.includes(LENOVO_SECRET) && r.data.vendors.filter((v) => v.vendor === 'dell' || v.vendor === 'lenovo').every((v) => v.enabled && v.secretSet), 'reading the settings never returns a key', msg(r));
  const row = await prisma.warrantyVendor.findUnique({ where: { vendor: 'dell' } });
  check(!!row?.secretEnc && !row.secretEnc.includes(DELL_SECRET) && row.secretLast4 === DELL_SECRET.slice(-4), 'the database holds the key sealed, with only its last four in the clear');
  check(hits.length === 0, 'saving the settings sent nothing to a vendor');

  section('Check now, through the stub');
  r = await req('POST', `/endpoints/${len1.id}/warranty/lookup`, { s: S.viewer });
  check(r.status === 403, 'View computers alone cannot ask the vendor', msg(r));
  r = await req('POST', `/endpoints/${hp1.id}/warranty/lookup`, { s: S.ownerA });
  check(r.status === 409 && code(r) === 'WARRANTY_MANUAL', 'a manual entry is not looked up', msg(r));
  r = await req('POST', `/endpoints/${old1.id}/warranty/lookup`, { s: S.ownerA });
  check(r.status === 409 && code(r) === 'WARRANTY_MANUAL', 'a manual ASUS entry is not looked up either', msg(r));
  r = await req('POST', `/endpoints/${vm1.id}/warranty/lookup`, { s: S.ownerA });
  check(r.status === 409 && code(r) === 'WARRANTY_LOOKUP_UNSUPPORTED', 'a virtual machine has no lookup', msg(r));
  const pause = await prisma.containmentPause.create({ data: { scope: 'BUSINESS', customerId: A.id, kinds: ['integration'], reason: 'e2e warranty stop', setById: admin.id, setBy: 'msp' } });
  created.pauses.push(pause.id);
  r = await req('POST', `/endpoints/${len1.id}/warranty/lookup`, { s: S.ownerA });
  check(r.status === 403 && code(r) === 'CONTAINED' && hits.length === 0, 'an integration pause refuses the lookup before anything leaves', msg(r));
  await prisma.containmentPause.update({ where: { id: pause.id }, data: { clearedAt: new Date() } });
  r = await req('POST', `/endpoints/${len1.id}/warranty/lookup`, { s: S.ownerA });
  check(r.status === 200 && r.data.result === 'OK' && r.data.warranty.source === 'lenovo' && r.data.warranty.state === 'expiring_60' && r.data.warranty.coverage === 'Premier Support', 'Lenovo: looked up, ends within 60 days', msg(r));
  const lh = hits.filter((h) => h.url.startsWith('/lenovo/'));
  check(lh.length === 1 && lh[0].url === `/lenovo/v2.5/warranty?Serial=${LSN}` && lh[0].method === 'GET' && lh[0].body === '', 'the stub saw only the serial, in the query, with no body', JSON.stringify(lh.map((h) => h.url)));
  r = await req('POST', `/endpoints/${dell1.id}/warranty/lookup`, { s: S.ownerA });
  check(r.status === 200 && r.data.result === 'OK' && r.data.warranty.source === 'dell' && r.data.warranty.state === 'active' && r.data.warranty.coverage === 'ProSupport Plus', 'Dell: token, then entitlements; running', msg(r));
  const dh = hits.filter((h) => h.url.startsWith('/dell/'));
  check(dh.length === 2 && dh[1].url === `/dell/PROD/sbil/eapi/v5/asset-entitlements?servicetags=${TAG1}` && dh[1].body === '', 'the Dell request carries the service tag only', JSON.stringify(dh.map((h) => h.url)));
  const leaked = hits.filter((h) => [h.url, h.body, JSON.stringify(h.headers)].join(' ').match(new RegExp(`DELL1-${sfx}|LEN1-${sfx}|example\\.test|Acme|Latitude|20XW`)));
  check(leaked.length === 0, 'no name, hostname, business or model ever reached the vendor', JSON.stringify(leaked.map((h) => h.url)));
  const req1 = await prisma.activityLog.findFirst({ where: { action: 'WARRANTY_LOOKUP_REQUESTED', resourceId: dell1.id } });
  check(!!req1 && JSON.stringify(req1.metadata) === '{"vendor":"dell"}', 'Check now is audited, naming only the vendor', JSON.stringify(req1?.metadata));

  section('The device list, the report and the dashboard');
  r = await req('GET', '/endpoints/list?warranty=d30', { s: S.ownerA });
  let names = (r.data?.rows ?? []).map((x) => x.name);
  check(r.status === 200 && names.length === 1 && names[0] === `HP1-${sfx}` && r.data.rows[0].warranty.state === 'expiring_30', 'warranty=d30: the HP that ends in 20 days', msg(r));
  r = await req('GET', '/endpoints/list?warranty=expired', { s: S.ownerA });
  names = (r.data?.rows ?? []).map((x) => x.name);
  check(names.length === 1 && names[0] === `OLD1-${sfx}`, 'warranty=expired', JSON.stringify(names));
  r = await req('GET', '/endpoints/list?warranty=unknown', { s: S.ownerA });
  names = (r.data?.rows ?? []).map((x) => x.name);
  check(names.length === 1 && names[0] === `VM1-${sfx}`, 'warranty=unknown: the VM', JSON.stringify(names));
  r = await req('GET', '/endpoints/list?warranty=d30%27%20OR%201%3D1', { s: S.ownerA });
  check(r.status === 400, 'an unknown warranty filter is a 400', msg(r));
  r = await req('GET', '/endpoints/list?sort=warranty&dir=asc', { s: S.ownerA });
  names = (r.data?.rows ?? []).map((x) => x.name);
  check(JSON.stringify(names) === JSON.stringify([`OLD1-${sfx}`, `HP1-${sfx}`, `LEN1-${sfx}`, `DELL1-${sfx}`, `VM1-${sfx}`]), 'sorted by end date, unknown last', JSON.stringify(names));
  r = await req('GET', '/endpoints/list/export.csv?warranty=expired', { s: S.ownerA });
  check(r.status === 200 && /Warranty/.test(r.text.split('\r\n')[0]) && r.text.includes('Expired') && !r.text.includes(`BIRCH1-${sfx}`), 'the CSV carries the warranty columns', r.text.slice(0, 300));
  r = await req('GET', `/reports/warranty?businessId=${A.id}`, { s: S.ownerA });
  check(r.status === 200 && r.data.totals.total === 5 && r.data.totals.expired === 1 && r.data.totals.within30 === 1 && r.data.totals.within60 === 2 && r.data.totals.unknown === 1 && r.data.totals.unknownVirtual === 1,
    'the report: 5 computers, 1 expired, 1 within 30, 2 within 60, 1 unknown (the VM)', msg(r));
  r = await req('GET', '/reports/warranty', { s: S.ownerA });
  check(r.status === 200 && r.data.totals.total === 5 && !r.text.includes(`BIRCH1-${sfx}`), 'Acme\'s owner never sees Birch\'s computer', msg(r));
  r = await req('GET', '/reports/warranty', { s: S.ownerB });
  check(r.status === 200 && r.data.totals.total === 1 && r.data.totals.within30 === 1, 'Birch\'s owner sees only Birch', msg(r));
  r = await req('GET', '/reports/warranty/export.csv', { s: S.ownerB });
  check(r.status === 200 && r.text.includes(`"${TAGB}"`) && !r.text.includes(TAG1) && !r.text.includes(LSN), 'the report CSV is scoped too', r.text.slice(0, 300));
  r = await req('GET', '/dashboard/overview', { s: S.ownerA });
  check(r.status === 200 && r.data.warranty && r.data.warranty.expired === 1 && r.data.warranty.within30 === 1 && r.data.warranty.unknown === 1, 'the dashboard tile counts Acme\'s', msg(r));

  section('A vendor answer never overwrites a manual entry');
  r = await req('PUT', `/endpoints/${len1.id}/warranty`, { s: S.ownerA, body: { endsAt: '2031-01-01' } });
  check(r.status === 200 && r.data.warranty.source === 'manual', 'Lenovo computer entered by hand');
  const before = hits.length;
  r = await req('POST', `/endpoints/${len1.id}/warranty/lookup`, { s: S.ownerA });
  check(r.status === 409 && hits.length === before, 'and Check now refuses it', msg(r));
  r = await req('PUT', `/endpoints/${len1.id}/warranty`, { s: S.ownerA, body: { startsAt: null, endsAt: null, coverage: null } });
  check(r.status === 200 && r.data.warranty.source === null && r.data.warranty.state === 'unknown', 'cleared by hand', msg(r));

  // ── Second run: the sweeps ──────────────────────────────────────────────────
  allLogs += api.log;
  await stopApi();
  // The earlier lookups move out of the last hour (still inside 30 days, so not asked again).
  await prisma.endpoint.updateMany({ where: { id: { in: [dell1.id, len1.id] } }, data: { warrantyLookupAt: new Date(Date.now() - 2 * 3_600_000) } });
  const dell2 = await mk(A, 'DELL2', 'Dell Inc.', 'Latitude 5440', TAG2);
  const dell3 = await mk(A, 'DELL3', 'Dell Inc.', 'Latitude 5440', TAG3);
  const dell4 = await mk(A, 'DELL4', 'Dell Inc.', 'Latitude 5440', TAG4);
  await prisma.endpoint.update({ where: { id: dellB.id }, data: { warrantySource: null, warrantyEndsAt: null } });
  const pauseB = await prisma.containmentPause.create({ data: { scope: 'BUSINESS', customerId: B.id, kinds: ['integration'], reason: 'e2e warranty stop B', setById: admin.id, setBy: 'msp' } });
  created.pauses.push(pauseB.id);
  hits.length = 0;
  api = startApi({ WARRANTY_SWEEP: 'on', WARRANTY_SWEEP_SECONDS: '2', WARRANTY_LOOKUPS_PER_HOUR: '2', MONITOR_SWEEP: 'on', MONITOR_SWEEP_SECONDS: '2' });
  await waitUp();
  const S2 = { ownerA: await login(ownerA.email) };

  section('The sweep: bounded per hour, skips a paused business, asks each computer once');
  await waitFor(async () => (await prisma.endpoint.count({ where: { id: { in: [dell2.id, dell3.id, dell4.id] }, warrantySource: 'dell' } })) >= 2);
  await sleep(6000); // three more ticks
  const swept = await prisma.endpoint.findMany({ where: { id: { in: [dell2.id, dell3.id, dell4.id, dellB.id, dell1.id, len1.id, hp1.id] } }, select: { name: true, warrantySource: true } });
  const asked = hits.filter((h) => h.url.includes('asset-entitlements')).map((h) => new URL(h.url, 'http://x').searchParams.get('servicetags'));
  check(asked.length === 2 && new Set(asked).size === 2 && asked.every((t) => [TAG2, TAG3, TAG4].includes(t)), 'WARRANTY_LOOKUPS_PER_HOUR=2: exactly two new Dell computers asked about, once each', JSON.stringify(asked));
  check(!hits.some((h) => h.url.includes(TAGB)), 'the paused business\'s computer was not asked about');
  check(!hits.some((h) => h.url.includes(TAG1) || h.url.includes(LSN)), 'computers checked in the last 30 days were not asked again');
  check(swept.filter((x) => x.warrantySource === 'dell').length === 3 && swept.find((x) => x.name === `HP1-${sfx}`)?.warrantySource === 'manual', 'the answers were stored; the manual HP entry untouched', JSON.stringify(swept));

  section('WARRANTY_EXPIRING: one alert, moved with the date, resolved when out of the window');
  r = await req('POST', '/monitoring/rules', { s: S2.ownerA, business: A.id, body: { scope: 'business', businessId: A.id, key: 'warranty', kind: 'WARRANTY_EXPIRING', name: 'Warranty ending', params: {} } });
  check(r.status === 201 || r.status === 200, 'a business monitor, daysBefore defaulting to 30', msg(r));
  const open = (id) => prisma.monitorAlert.findMany({ where: { endpointId: id, kind: 'WARRANTY_EXPIRING', state: { not: 'RESOLVED' } } });
  let al = await waitFor(async () => { const x = await open(hp1.id); return x.length ? x : null; });
  check(al?.length === 1 && al[0].title === `HP1-${sfx}: hardware warranty ends ${ends20}`, 'raised for the HP ending in 20 days, naming the date', JSON.stringify(al?.map((a) => a.title)));
  const oldA = await waitFor(async () => { const x = await open(old1.id); return x.length ? x : null; });
  check(oldA?.length === 1 && /ended/.test(oldA[0].title), 'raised for the expired ASUS as ended');
  await sleep(4500);
  check((await prisma.monitorAlert.count({ where: { endpointId: hp1.id, kind: 'WARRANTY_EXPIRING' } })) === 1, 'still one alert after more ticks');
  check((await open(vm1.id)).length === 0 && (await open(dell1.id)).length === 0 && (await open(len1.id)).length === 0, 'no alert for unknown or running warranties');
  check((await prisma.monitorAlert.count({ where: { endpointId: dellB.id } })) === 0, 'Birch has no monitor, so no alert');
  const ends25 = isoDay(new Date(Date.now() + 25 * DAY));
  r = await req('PUT', `/endpoints/${hp1.id}/warranty`, { s: S2.ownerA, body: { endsAt: ends25 } });
  check(r.status === 200, 'the date moved to 25 days out', msg(r));
  al = await waitFor(async () => { const x = await open(hp1.id); return x.length && x[0].title.endsWith(ends25) ? x : null; });
  const first = await prisma.monitorAlert.findFirst({ where: { endpointId: hp1.id, kind: 'WARRANTY_EXPIRING', state: 'RESOLVED' } });
  check(al?.length === 1 && !!first && /end date changed/.test(first.resolveNote ?? ''), 'the old alert closed ("end date changed") and one alert names the new date', JSON.stringify({ open: al?.map((a) => a.title), resolved: first?.resolveNote }));
  r = await req('PUT', `/endpoints/${hp1.id}/warranty`, { s: S2.ownerA, body: { endsAt: isoDay(new Date(Date.now() + 120 * DAY)) } });
  const gone = await waitFor(async () => ((await open(hp1.id)).length === 0 ? true : null));
  check(r.status === 200 && gone === true, 'moved to 120 days: resolved', msg(r));

  section('Nothing secret was kept or printed');
  const rows = await prisma.activityLog.findMany({ where: { action: { in: ['WARRANTY_SET', 'WARRANTY_SETTINGS_CHANGED', 'WARRANTY_LOOKUP_REQUESTED'] }, actorId: { in: created.users } } });
  const blob = JSON.stringify(rows.map((x) => x.metadata));
  check(rows.length >= 8 && ![DELL_SECRET, LENOVO_SECRET, TOKEN].some((k) => blob.includes(k)), `no key or token in ${rows.length} audit rows`);
  const set = rows.filter((x) => x.action === 'WARRANTY_SETTINGS_CHANGED');
  check(set.length === 2 && set.every((x) => x.metadata.key === 'set' && x.metadata.after.enabled === true), 'WARRANTY_SETTINGS_CHANGED says only that a key was set', JSON.stringify(set.map((x) => x.metadata)));
  allLogs += api.log;
  check(![DELL_SECRET, LENOVO_SECRET, TOKEN].some((k) => allLogs.includes(k)), 'no key or token in the API\'s output');
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
    await prisma.warrantyVendor.deleteMany({});
    await prisma.endpointInventory.deleteMany({ where: { endpointId: { in: eps } } });
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
    const logs = allLogs + (api?.log ?? '');
    await cleanup();
    console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
    if (failures.length) { for (const f of failures) console.log(`  - ${f}`); console.log(`\n── API output (last 4000 characters)\n${logs.slice(-4000)}`); process.exit(1); }
    process.exit(0);
  });
