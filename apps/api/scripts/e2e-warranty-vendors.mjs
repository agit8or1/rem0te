#!/usr/bin/env node
/**
 * End-to-end proof of 0.61's warranty vendors, against the real built API
 * and a loopback stand-in only. NO real HP or Apple API is ever called: the
 * stand-in follows the vendors' published examples (HP's token, job, status
 * and results; Apple's client-assertion token and AppleCare coverage), and
 * every serial here is synthetic.
 *
 *   - why there is no date, per computer, on the device page, in the report
 *     (and its CSV) and on the dashboard tile: no inventory, a virtual
 *     machine, a vendor with no lookup (HPE, Surface), a missing serial, a
 *     lookup not switched on, waiting, no record, failed;
 *   - Settings → Warranty for HP (API key + secret) and Apple (client id, key
 *     id, PEM private key): Platform Admin, fresh authentication, every
 *     credential write-only, the shape checked per vendor;
 *   - Check now through the stand-in: only the serial reaches it; a vendor
 *     with no record, a rate limit; an integration pause refuses first;
 *   - the sweep (second API run, 2 s): HP computers looked up, bounded per
 *     hour, a manual entry and a paused business left alone;
 *   - no credential, token or key in a response, an audit row or the API's
 *     output.
 *
 *   cd apps/api && npx nest build
 *   DATABASE_URL=postgresql://…/<name containing scratch or test> node scripts/e2e-warranty-vendors.mjs
 *
 * Ports 3881 (API), 3882 (stand-in), 3883 (spare). Never a production port.
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes, verify } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, URL, URLSearchParams } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const DB = process.env.DATABASE_URL ?? '';
const dbName = DB.split('/').pop()?.split('?')[0] ?? '';
if (!/scratch|test/.test(dbName)) { console.error(`Refusing to run against database "${dbName}": name must contain "scratch" or "test".`); process.exit(2); }
const PORT = Number(process.env.WARRANTY_VENDORS_API_PORT ?? 3881);
const STUB_PORT = PORT + 1;
for (const p of [PORT, STUB_PORT]) if (p < 3881 || p > 3883) { console.error(`Refusing port ${p}: this suite uses 3881–3883.`); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex').toUpperCase();
const PW = 'warranty-vendors-e2e-password-123';
const HP_KEY = `hpkey${randomBytes(6).toString('hex')}`;
const HP_SECRET = `hpsecret${randomBytes(12).toString('hex')}`;
const APPLE_CLIENT = `BUSINESSAPI.${randomBytes(8).toString('hex')}`;
const APPLE_KID = `kid-${randomBytes(6).toString('hex')}`;
const { privateKey: APPLE_PRIV, publicKey: APPLE_PUB } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const APPLE_PEM = APPLE_PRIV.export({ type: 'pkcs8', format: 'pem' }).toString();
const APPLE_BODY = APPLE_PEM.replace(/-----[A-Z ]+-----|\s/g, '');
const tokensIssued = [];

let pass = 0, fail = 0;
const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;
const DAY = 86_400_000;

// ── The stand-in ──────────────────────────────────────────────────────────────
const hits = [];
const jobs = new Map();
const hpRefuse = new Set(); // serials the stand-in answers with no offers
const hpLimit = new Set(); // serials the stand-in answers 429 for
const stub = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; });
  req.on('end', () => {
    hits.push({ method: req.method, url: req.url, headers: req.headers, body: b });
    res.setHeader('content-type', 'application/json');
    const u = new URL(req.url, 'http://x');
    const send = (code, obj) => { res.statusCode = code; res.end(JSON.stringify(obj)); };
    if (u.pathname === '/hp/oauth/v1/token') {
      if (req.headers.authorization !== `Basic ${Buffer.from(`${HP_KEY}:${HP_SECRET}`).toString('base64')}`) return send(401, { error: 'invalid_client' });
      const t = `hptok${randomBytes(8).toString('hex')}`; tokensIssued.push(t);
      return send(200, { access_token: t, expires_in: '3599', scope: 'warranty' });
    }
    const hpOk = () => tokensIssued.includes((req.headers.authorization ?? '').replace(/^Bearer /, ''));
    if (u.pathname === '/hp/productwarranty/v2/jobs' && req.method === 'POST') {
      if (!hpOk()) return send(401, {});
      const items = JSON.parse(b);
      if (hpLimit.has(items[0]?.sn)) return send(429, {});
      const id = `7f1d2c3b-${String(jobs.size + 1).padStart(4, '0')}-4000-8000-000000000000`;
      jobs.set(id, { items, polls: 0 });
      return send(200, { jobId: id, estimatedTime: 1 });
    }
    const jm = u.pathname.match(/^\/hp\/productwarranty\/v2\/jobs\/([0-9a-f-]+)(\/results)?$/);
    if (jm) {
      if (!hpOk()) return send(401, {});
      const job = jobs.get(jm[1]); if (!job) return send(404, {});
      if (!jm[2]) { job.polls++; return send(200, { jobId: jm[1], status: job.polls >= 2 ? 'COMPLETED' : 'IN_PROGRESS' }); }
      const sn = job.items[0].sn;
      if (hpRefuse.has(sn)) return send(200, [{ product: { serialNumber: sn }, offers: [] }]);
      return send(200, [{ product: { serialNumber: sn, productDescription: 'HP Z440 Workstation' }, offers: [
        { offerDescription: 'Wty: HP HW Maintenance Onsite Support', serviceObligationLineItemStartDate: '2016-03-01', serviceObligationLineItemEndDate: new Date(Date.now() + 40 * DAY).toISOString().slice(0, 10) },
      ] }]);
    }
    if (u.pathname === '/apple-auth/auth/oauth2/token') {
      const f = new URLSearchParams(b); const a = (f.get('client_assertion') ?? '').split('.');
      const ok = a.length === 3 && f.get('client_id') === APPLE_CLIENT && f.get('scope') === 'business.api'
        && verify('sha256', Buffer.from(`${a[0]}.${a[1]}`), { key: APPLE_PUB, dsaEncoding: 'ieee-p1363' }, Buffer.from(a[2], 'base64url'))
        && JSON.parse(Buffer.from(a[0], 'base64url')).kid === APPLE_KID;
      if (!ok) return send(400, { error: 'invalid_client' });
      const t = `appletok${randomBytes(8).toString('hex')}`; tokensIssued.push(t);
      return send(200, { access_token: t, token_type: 'Bearer', expires_in: 3600 });
    }
    const am = u.pathname.match(/^\/apple\/v1\/orgDevices\/([A-Za-z0-9-]+)\/appleCareCoverage$/);
    if (am) {
      if (!tokensIssued.includes((req.headers.authorization ?? '').replace(/^Bearer /, ''))) return send(401, {});
      return send(200, { data: [{ type: 'appleCareCoverage', id: am[1], attributes: { startDateTime: '2025-01-10T00:00:00Z', endDateTime: new Date(Date.now() + 200 * DAY).toISOString(), description: 'AppleCare+ for Business', isCanceled: false } }] });
    }
    send(404, {});
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
      GEOIP_DB_PATH: path.join(here, 'no-geoip.mmdb'),
      INTEGRATION_PEERS_FILE: '', REPORT_SCHEDULE_SWEEP: 'off', AUDIT_SEALER: 'off', ENDPOINT_STALE_SWEEP: 'off', STALE_SWEEP: 'off',
      CLIENT_UPDATE_SWEEP: 'off', PATCH_POLICY_SWEEP: 'off', METRIC_SWEEP: 'off', RETENTION_SWEEP: 'off', CHAT_RETENTION_SWEEP: 'off', TRAY_SWEEP: 'off',
      SCRIPT_OUTPUT_SWEEP: 'off', AUTO_MIGRATION_SWEEP: 'off', WINGET_INDEX_SWEEP: 'off', SNAPSHOT_SWEEP: 'off', AGENT_AUTO_UPDATE: 'off',
      MONITOR_SWEEP: 'off', WARRANTY_SWEEP: 'off', AUTOMATION_SWEEP: 'off', SSO_SESSION_SWEEP: 'off',
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
async function req(method, p, { s, body } = {}) {
  await sleep(40);
  const h = { 'content-type': 'application/json', 'x-forwarded-for': ip() };
  if (s) h.cookie = s.cookie + (s.stepUp ? `; step_up=${s.stepUp}` : '');
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
const msg = (r) => `HTTP ${r.status} ${typeof r.body === 'string' ? r.body.slice(0, 300) : JSON.stringify(r.body).slice(0, 500)}`;
const created = { businesses: [], users: [], pauses: [] };
async function waitFor(fn, ms = 20_000) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(500); } return null; }

async function all() {
  await new Promise((r, j) => { stub.once('error', j); stub.listen(STUB_PORT, '127.0.0.1', r); });
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  if (await prisma.warrantyVendor.count()) throw new Error('This database already has warranty vendor settings; use a fresh scratch database.');
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });

  section('Fixtures (synthetic): Acme (A) and Birch (B)');
  const A = await prisma.customer.create({ data: { tenantId: tenant.id, name: `Acme Vendors ${sfx}` } });
  const B = await prisma.customer.create({ data: { tenantId: tenant.id, name: `Birch Vendors ${sfx}` } });
  created.businesses.push(A.id, B.id);
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag, extra = {}) => { const u = await prisma.user.create({ data: { email: `wv-${tag}-${sfx.toLowerCase()}@test.invalid`, passwordHash: hash, firstName: 'WV', lastName: tag, status: 'ACTIVE', ...extra } }); created.users.push(u.id); return u; };
  const admin = await mkUser('admin', { isPlatformAdmin: true });
  const ownerA = await mkUser('owner-a');
  await prisma.membership.create({ data: { userId: ownerA.id, tenantId: tenant.id, customerId: A.id, roleId: roleOwner.id } });
  const mk = async (biz, name, manufacturer, model, serial, inv = true) => {
    const e = await prisma.endpoint.create({ data: { tenantId: tenant.id, customerId: biz.id, name: `${name}-${sfx}`, hostname: `${name.toLowerCase()}-${sfx.toLowerCase()}.example.test`, serialNumber: serial, platform: 'Windows', status: 'ACTIVE', isOnline: true, isManaged: true, lastSeenAt: new Date(), accessMode: 'COMPANY_WIDE' } });
    if (inv) await prisma.endpointInventory.create({ data: { endpointId: e.id, manufacturer, model, serialNumber: serial } });
    return e;
  };
  const SN1 = `CZC${sfx}01`, SN2 = `CZC${sfx}02`, SN3 = `CZC${sfx}03`, SN4 = `CZC${sfx}04`, SNB = `CZC${sfx}0B`, MAC = `C02${sfx}MAC`;
  const z440 = await mk(A, 'Z440', 'Hewlett-Packard', 'HP Z440 Workstation', SN1);
  const z840 = await mk(A, 'Z840', 'Hewlett-Packard', 'HP Z840 Workstation', SN2);
  const hpNone = await mk(A, 'HPNONE', 'HP', 'HP EliteDesk 800 G6', SN3);
  const hpLim = await mk(A, 'HPLIM', 'HP', 'HP EliteDesk 800 G6', SN4);
  const hpNoSerial = await mk(A, 'HPNOSN', 'HP', 'HP ProDesk 400', 'To be filled by O.E.M.');
  const proliant = await mk(A, 'PROLIANT', 'HPE', 'ProLiant DL380 Gen10', `MXQ${sfx}1`);
  const surface = await mk(A, 'SURFACE', 'Microsoft Corporation', 'Surface Laptop 5', `0F${sfx}77`);
  const vm = await mk(A, 'VM', 'Microsoft Corporation', 'Virtual Machine', `VM${sfx}99`);
  const bare = await mk(A, 'BARE', null, null, null, false);
  const mac = await mk(A, 'MAC', 'Apple Inc.', 'Mac14,2', MAC);
  const hpB = await mk(B, 'BIRCHHP', 'HP', 'HP Z2 G9', SNB);
  hpRefuse.add(SN3); hpLimit.add(SN4);

  api = startApi({});
  await waitUp();
  const S = { admin: await login(admin.email), ownerA: await login(ownerA.email) };
  const up = { admin: await stepUp(S.admin) };

  section('Why there is no date — before any lookup is switched on');
  const gapOf = async (e) => (await req('GET', `/endpoints/${e.id}/warranty`, { s: S.ownerA })).data?.gap;
  let g = await gapOf(z440);
  check(g?.reason === 'not_configured' && g.settings && /HP warranty lookup is not switched on/.test(g.text), 'an HP Z440 with a serial: the HP lookup is not switched on (fix in Settings → Warranty)', JSON.stringify(g));
  g = await gapOf(proliant);
  check(g?.reason === 'no_lookup' && /HPE publishes no warranty API/.test(g.text), 'a ProLiant: HPE has no lookup, dates by hand', JSON.stringify(g));
  g = await gapOf(surface);
  check(g?.reason === 'no_lookup' && /Surface/.test(g.text), 'a Surface: Microsoft has no lookup', JSON.stringify(g));
  g = await gapOf(hpNoSerial);
  check(g?.reason === 'no_serial', 'an HP reporting a placeholder serial: serial missing', JSON.stringify(g));
  g = await gapOf(vm);
  check(g?.reason === 'virtual', 'a Hyper-V machine: virtual', JSON.stringify(g));
  g = await gapOf(bare);
  check(g?.reason === 'no_inventory', 'no inventory yet', JSON.stringify(g));
  let r = await req('GET', `/reports/warranty?businessId=${A.id}`, { s: S.ownerA });
  const by = r.data?.totals?.unknownBy ?? {};
  check(r.status === 200 && r.data.totals.unknown === 10 && by.not_configured === 5 && by.no_lookup === 2 && by.no_serial === 1 && by.virtual === 1 && by.no_inventory === 1,
    'the report counts the reasons: 5 not switched on (four HP, one Mac), 2 no lookup, 1 serial missing, 1 VM, 1 no inventory', msg(r));
  check(r.data.missing.length === 9 && r.data.missing[0].gap.settings && !r.data.missing.some((x) => x.gap.reason === 'virtual'), 'the "why" list: every unknown but the VM, the fixable first', JSON.stringify(r.data.missing.map((x) => x.gap.reason)));
  r = await req('GET', `/reports/warranty/export.csv?businessId=${A.id}`, { s: S.ownerA });
  check(r.status === 200 && r.text.split('\r\n')[0].endsWith('"Why no date"') && r.text.includes('Lookup not switched on: The HP warranty lookup is not switched on') && r.text.includes('Vendor has no lookup: HPE publishes'),
    'the CSV has a "Why no date" column', r.text.split('\r\n').slice(0, 2).join(' | '));
  r = await req('GET', '/dashboard/overview', { s: S.ownerA });
  check(r.status === 200 && r.data.warranty?.unknown === 10 && r.data.warranty.unknownFixable === 5, 'the dashboard tile knows 5 could be looked up if a lookup were on', JSON.stringify(r.data?.warranty));

  section('Settings → Warranty: HP and Apple');
  r = await req('GET', '/warranty/settings', { s: S.admin });
  check(r.status === 200 && r.data.vendors.map((v) => v.vendor).join() === 'dell,lenovo,hp,apple' && r.data.manualOnly.map((m) => m.vendor).join() === 'hpe,microsoft,asus,acer' && r.data.manualOnly.every((m) => m.reason.length > 40),
    'four lookups; HPE, Microsoft, ASUS and Acer manual, each with its reason', msg(r));
  r = await req('PUT', '/warranty/settings/hp', { s: S.admin, body: { enabled: true, clientId: HP_KEY, secret: HP_SECRET } });
  check(r.status === 401 || r.status === 403, 'HP: saving without a fresh sign-in is refused', msg(r));
  r = await req('PUT', '/warranty/settings/hp', { s: up.admin, body: { enabled: true, secret: HP_SECRET } });
  check(r.status === 400 && code(r) === 'CLIENT_ID_REQUIRED', 'HP needs its API key', msg(r));
  r = await req('PUT', '/warranty/settings/hp', { s: up.admin, body: { enabled: true, clientId: HP_KEY, secret: 'has spaces in it' } });
  check(r.status === 400 && code(r) === 'INVALID_KEY', 'an HP secret with spaces is refused', msg(r));
  r = await req('PUT', '/warranty/settings/hp', { s: up.admin, body: { enabled: true, clientId: HP_KEY, keyId: 'abcd-1234', secret: HP_SECRET } });
  check(r.status === 400, 'only Apple takes a key id', msg(r));
  r = await req('PUT', '/warranty/settings/lenovo', { s: up.admin, body: { enabled: false, clientId: 'some-client' } });
  check(r.status === 400, 'Lenovo still takes no client id', msg(r));
  r = await req('PUT', '/warranty/settings/hpe', { s: up.admin, body: { enabled: true, secret: 'abcdefgh1234' } });
  check(r.status === 400 && code(r) === 'UNKNOWN_VENDOR', 'HPE has no lookup to switch on', msg(r));
  r = await req('PUT', '/warranty/settings/hp', { s: up.admin, body: { enabled: true, clientId: HP_KEY, secret: HP_SECRET } });
  check(r.status === 200 && r.data.enabled && r.data.clientId === HP_KEY && r.data.secretLast4 === HP_SECRET.slice(-4) && !r.text.includes(HP_SECRET), 'HP on: the API key shown back, the secret never', msg(r));
  r = await req('PUT', '/warranty/settings/apple', { s: up.admin, body: { enabled: true, clientId: APPLE_CLIENT, keyId: APPLE_KID, secret: 'not a private key at all' } });
  check(r.status === 400 && code(r) === 'INVALID_KEY', 'Apple: something that is not a P-256 private key is refused', msg(r));
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  r = await req('PUT', '/warranty/settings/apple', { s: up.admin, body: { enabled: true, clientId: APPLE_CLIENT, keyId: APPLE_KID, secret: rsa } });
  check(r.status === 400 && code(r) === 'INVALID_KEY', 'Apple: an RSA key is refused', msg(r));
  r = await req('PUT', '/warranty/settings/apple', { s: up.admin, body: { enabled: true, clientId: APPLE_CLIENT, secret: APPLE_PEM } });
  check(r.status === 400 && code(r) === 'KEY_ID_REQUIRED', 'Apple needs its key id', msg(r));
  r = await req('PUT', '/warranty/settings/apple', { s: up.admin, body: { enabled: true, clientId: APPLE_CLIENT, keyId: APPLE_KID, secret: APPLE_PEM } });
  check(r.status === 200 && r.data.enabled && r.data.keyId === APPLE_KID && !r.text.includes(APPLE_BODY.slice(10, 60)) && r.data.secretLast4 === APPLE_BODY.slice(-4), 'Apple on: client id and key id shown back, the private key never', msg(r));
  const rows = await prisma.warrantyVendor.findMany();
  check(rows.length === 2 && rows.every((x) => x.secretEnc && !x.secretEnc.includes(HP_SECRET) && !x.secretEnc.includes(APPLE_BODY.slice(10, 60))), 'both credentials are sealed in the database');
  r = await req('PUT', '/warranty/settings/apple', { s: up.admin, body: { enabled: false, keyId: 'other-key-id' } });
  check(r.status === 200 && r.data.keyChange === 'cleared_client_changed' && !r.data.secretSet, 'a different Apple key id drops the saved private key', msg(r));
  r = await req('PUT', '/warranty/settings/apple', { s: up.admin, body: { enabled: true, keyId: APPLE_KID, secret: APPLE_PEM } });
  check(r.status === 200 && r.data.enabled && r.data.secretSet, 'and it is entered again', msg(r));
  check(hits.length === 0, 'saving settings sent nothing to any vendor');

  section('Check now, through the stand-in');
  g = await gapOf(z440);
  check(g?.reason === 'waiting', 'once HP is on, the Z440 is waiting for its lookup', JSON.stringify(g));
  const pause = await prisma.containmentPause.create({ data: { scope: 'BUSINESS', customerId: A.id, kinds: ['integration'], reason: 'e2e warranty vendors stop', setById: admin.id, setBy: 'msp' } });
  created.pauses.push(pause.id);
  r = await req('POST', `/endpoints/${z440.id}/warranty/lookup`, { s: S.ownerA });
  check(r.status === 403 && code(r) === 'CONTAINED' && hits.length === 0, 'an integration pause refuses before anything leaves', msg(r));
  await prisma.containmentPause.update({ where: { id: pause.id }, data: { clearedAt: new Date() } });
  r = await req('POST', `/endpoints/${z440.id}/warranty/lookup`, { s: S.ownerA });
  check(r.status === 200 && r.data.result === 'OK' && r.data.warranty.source === 'hp' && r.data.warranty.sourceLabel === 'HP Warranty API' && r.data.warranty.state === 'expiring_60' && r.data.gap === null,
    'HP Z440: token, job, poll, results — ends within 60 days, no gap', msg(r));
  const jobPosts = hits.filter((h) => h.method === 'POST' && h.url === '/hp/productwarranty/v2/jobs');
  check(jobPosts.length === 1 && jobPosts[0].body === JSON.stringify([{ sn: SN1 }]), 'the job carried the serial and nothing else', JSON.stringify(jobPosts.map((h) => h.body)));
  r = await req('POST', `/endpoints/${hpNone.id}/warranty/lookup`, { s: S.ownerA });
  check(r.status === 200 && r.data.result === 'NOT_FOUND' && r.data.gap?.reason === 'not_found', 'HP with no record: the card says the vendor had no record', msg(r));
  r = await req('POST', `/endpoints/${hpLim.id}/warranty/lookup`, { s: S.ownerA });
  check(r.status === 200 && r.data.result === 'VENDOR_RATE_LIMITED' && r.data.gap?.reason === 'failed' && /slow down/.test(r.data.gap.text), 'HP rate-limited: the card says the lookup failed and why', msg(r));
  const lim = await prisma.endpoint.findUnique({ where: { id: hpLim.id } });
  check(lim.warrantyLookupAt < new Date(Date.now() - 28 * DAY), 'a rate limit is asked again within a day, not in thirty', lim.warrantyLookupAt?.toISOString());
  r = await req('POST', `/endpoints/${proliant.id}/warranty/lookup`, { s: S.ownerA });
  check(r.status === 409 && code(r) === 'WARRANTY_LOOKUP_UNSUPPORTED' && /HPE publishes no warranty API/.test(JSON.stringify(r.body)), 'a ProLiant: no lookup, and the refusal says why', msg(r));
  r = await req('POST', `/endpoints/${mac.id}/warranty/lookup`, { s: S.ownerA });
  check(r.status === 200 && r.data.result === 'OK' && r.data.warranty.source === 'apple' && r.data.warranty.coverage === 'AppleCare+ for Business', 'Apple: assertion, token, coverage', msg(r));
  const cov = hits.filter((h) => h.url.startsWith('/apple/'));
  check(cov.length === 1 && cov[0].url === `/apple/v1/orgDevices/${MAC}/appleCareCoverage` && cov[0].body === '', 'the Apple request carries the serial only', JSON.stringify(cov.map((h) => h.url)));
  const leaked = hits.filter((h) => [h.url, h.body, JSON.stringify(h.headers)].join(' ').match(new RegExp(`Z440-${sfx}|MAC-${sfx}|example\\.test|Acme|Workstation|Mac14`)));
  check(leaked.length === 0, 'no name, hostname, business or model reached the stand-in', JSON.stringify(leaked.map((h) => h.url)));
  const reqRow = await prisma.activityLog.findFirst({ where: { action: 'WARRANTY_LOOKUP_REQUESTED', resourceId: z440.id } });
  check(JSON.stringify(reqRow?.metadata) === '{"vendor":"hp"}', 'Check now is audited, naming only the vendor', JSON.stringify(reqRow?.metadata));

  // ── Second run: the sweep ───────────────────────────────────────────────────
  allLogs += api.log;
  await stopApi();
  await prisma.endpoint.updateMany({ where: { id: { in: [z440.id, hpNone.id, hpLim.id, mac.id] } }, data: { warrantyLookupAt: new Date(Date.now() - 2 * 3_600_000) } });
  await prisma.endpoint.update({ where: { id: hpNoSerial.id }, data: { warrantySource: 'manual', warrantyEndsAt: new Date(Date.now() + 500 * DAY) } });
  const pauseB = await prisma.containmentPause.create({ data: { scope: 'BUSINESS', customerId: B.id, kinds: ['integration'], reason: 'e2e warranty vendors stop B', setById: admin.id, setBy: 'msp' } });
  created.pauses.push(pauseB.id);
  hits.length = 0;
  // The hourly budget counts every computer looked up in the last hour, in the
  // whole database. Under run-e2e.sh earlier suites (e2e-warranty) have used
  // some of it, so allow exactly one more lookup than is already counted.
  const usedBefore = await prisma.endpoint.count({ where: { warrantyLookupAt: { gte: new Date(Date.now() - 3_600_000) } } });
  api = startApi({ WARRANTY_SWEEP: 'on', WARRANTY_SWEEP_SECONDS: '2', WARRANTY_LOOKUPS_PER_HOUR: String(usedBefore + 1) });
  await waitUp();

  section('The sweep: HP looked up, bounded, a paused business left alone');
  await waitFor(async () => (await prisma.endpoint.findUnique({ where: { id: z840.id } })).warrantySource === 'hp');
  await sleep(5000);
  const asked = hits.filter((h) => h.method === 'POST' && h.url === '/hp/productwarranty/v2/jobs').map((h) => JSON.parse(h.body)[0].sn);
  const sweepState = async () => JSON.stringify({
    usedBefore,
    usedNow: await prisma.endpoint.count({ where: { warrantyLookupAt: { gte: new Date(Date.now() - 3_600_000) } } }),
    vendors: (await prisma.warrantyVendor.findMany()).map((v) => ({ vendor: v.vendor, enabled: v.enabled, secret: !!v.secretEnc, last: v.lastResult })),
    pauses: (await prisma.containmentPause.findMany({ where: { clearedAt: null } })).map((x) => ({ scope: x.scope, kinds: x.kinds, biz: x.customerId === B.id ? 'B' : x.customerId })),
    z840: await prisma.endpoint.findUnique({ where: { id: z840.id }, select: { status: true, warrantyLookupAt: true, warrantySource: true, warrantyLookupResult: true, inventory: { select: { manufacturer: true, model: true, serialNumber: true } } } }),
    endpoints: await prisma.endpoint.count(),
    sweepLog: api.log.split('\n').filter((l) => /warranty/i.test(l) && !/RouterExplorer|Mapped/.test(l)).slice(-10),
  });
  check(asked.length === 1 && asked[0] === SN2, 'the hourly budget allows one more: only the Z840 (never asked) was asked, once', asked.length === 1 && asked[0] === SN2 ? JSON.stringify(asked) : `${JSON.stringify(asked)} ${await sweepState()}`);
  check(!hits.some((h) => h.body.includes(SNB)), 'the paused business\'s HP was not asked about');
  const z = await prisma.endpoint.findUnique({ where: { id: z840.id } });
  check(z.warrantySource === 'hp' && z.warrantyLookupResult === 'OK', 'the answer was stored', JSON.stringify({ s: z.warrantySource, r: z.warrantyLookupResult }));
  const man = await prisma.endpoint.findUnique({ where: { id: hpNoSerial.id } });
  check(man.warrantySource === 'manual', 'a manual entry is untouched');
  const S2 = await login(ownerA.email);
  r = await req('GET', `/reports/warranty?businessId=${A.id}`, { s: S2 });
  check(r.status === 200 && r.data.totals.unknownBy.not_configured === 0 && r.data.totals.unknownBy.not_found === 1 && r.data.totals.unknownBy.failed === 1, 'the report now: nothing left "not switched on"; one no record, one failed', JSON.stringify(r.data?.totals?.unknownBy));

  section('Nothing secret was kept or printed');
  const audits = await prisma.activityLog.findMany({ where: { action: { in: ['WARRANTY_SETTINGS_CHANGED', 'WARRANTY_LOOKUP_REQUESTED'] }, actorId: { in: created.users } } });
  const blob = JSON.stringify(audits.map((x) => x.metadata));
  check(audits.length >= 6 && ![HP_SECRET, APPLE_BODY.slice(10, 60), ...tokensIssued].some((k) => blob.includes(k)), `no key, private key or token in ${audits.length} audit rows`);
  allLogs += api.log;
  check(![HP_SECRET, APPLE_BODY.slice(10, 60), ...tokensIssued].some((k) => allLogs.includes(k)), 'no key, private key or token in the API\'s output');
}

async function cleanup() {
  await stopApi();
  stub.close();
  try {
    const ids = created.businesses;
    const eps = (await prisma.endpoint.findMany({ where: { customerId: { in: ids } }, select: { id: true } })).map((e) => e.id);
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
