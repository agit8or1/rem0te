#!/usr/bin/env node
/**
 * End-to-end proof of Add device (0.32): the guided flow's server half.
 *
 *   POST /enrollment/tokens            — business and site bound at mint time
 *   GET  /enrollment/tokens/:id/status — has the device arrived, and its first health
 *   POST /enrollment/claim, /heartbeat, /command-result — the real device path
 *
 *   - token creation keeps its permission checks: computers:add is required; a
 *     Business Owner cannot mint for another business by naming it (businessId
 *     or the legacy customerId), nor bind another business's site, and a
 *     foreign site is refused with the same message as a non-existent one;
 *   - the site travels with the token: the claimed device lands in it; a site
 *     deactivated before the claim is dropped (the device still enrols); a
 *     deleted site leaves the token valid with no site;
 *   - status walks waiting → enrolled, and first health fills in only from
 *     what the device really sent: online at claim, agent type after the
 *     first heartbeat, inventory after the first inventory command-result;
 *   - scoping: another business's owner gets a 404 for the token and cannot
 *     see the enrolled device anywhere; a Business User who mints an
 *     ASSIGNED_USERS token for someone else is told the device enrolled but
 *     is not shown it (endpointVisibilityWhere), while a COMPANY_WIDE one is
 *     shown; the Platform Admin sees all of it (the negative control);
 *   - nothing secret leaves the status route: no raw token, no token hash,
 *     no device secret;
 *   - expired and revoked tokens report as such;
 *   - minting needs a fresh re-authentication (0.33): a stale session gets
 *     STEP_UP_REQUIRED and writes nothing, and a scope refusal comes first.
 *
 * Self-starting: it runs its own API from dist/ on ADDDEVICE_API_PORT (3201)
 * against DATABASE_URL, which must name a scratch/test database. Fixtures are
 * namespaced and removed at the end.
 *
 * Run:  DATABASE_URL=…/rem0te_adddevice_test node scripts/e2e-add-device.mjs
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const DB = process.env.DATABASE_URL ?? '';
const dbName = DB.split('/').pop()?.split('?')[0] ?? '';
if (!/scratch|test/.test(dbName)) { console.error(`Refusing to run against database "${dbName}": name must contain "scratch" or "test".`); process.exit(2); }
const PORT = Number(process.env.ADDDEVICE_API_PORT ?? 3201);
if ([3000, 3001, 443, 4000, 4001].includes(PORT)) { console.error(`Refusing port ${PORT}: production or the shared docs stack.`); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
const VERSION_FILE = path.resolve(here, '..', '..', '..', 'version.json');
const AGENT_VERSION = JSON.parse(readFileSync(VERSION_FILE, 'utf8')).version;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'add-device-e2e-password-1';
const TAG = `AD${sfx}`;

let pass = 0, fail = 0;
const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;

const apiEnv = {
  ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATABASE_URL: DB,
  JWT_SECRET: randomBytes(32).toString('hex'), LAUNCHER_TOKEN_SECRET: randomBytes(32).toString('hex'),
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? randomBytes(32).toString('hex'), TRUSTED_PROXIES: 'loopback',
  HBBS_PRESENCE_HOST: '127.0.0.2', MONITOR_SWEEP: 'off', AUDIT_SEALER: 'off', VERSION_FILE,
};
let api;
function startApi() {
  api = spawn(process.execPath, [path.join(dist, 'main.js')], { env: apiEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  api.log = ''; api.stdout.on('data', (d) => { api.log += d; }); api.stderr.on('data', (d) => { api.log += d; });
}
async function stopApi() { if (!api || api.exitCode !== null) return; await new Promise((r) => { api.once('exit', r); api.kill('SIGTERM'); }); }
async function waitUp() {
  for (let i = 0; i < 150; i++) { try { const r = await fetch(`${API}/health`); if (r.status < 500) return; } catch { /* not yet */ } await sleep(300); }
  throw new Error(`api did not come up:\n${api.log.slice(-3000)}`);
}

async function req(method, p, s, body) {
  // A fresh address per request: the global throttler is keyed by client address.
  const h = { 'x-forwarded-for': ip() };
  if (s) h.cookie = s.cookie;
  if (body !== undefined) h['content-type'] = 'application/json';
  const r = await fetch(`${API}${p}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j, data: j?.data, text };
}
async function login(email) {
  const s = { ip: ip() };
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': s.ip }, body: JSON.stringify({ email, password: PW }) });
  const mm = (r.headers.get('set-cookie') ?? '').match(/access_token=([^;]+)/);
  if (r.status !== 200 || !mm) throw new Error(`login ${email}: ${r.status} ${await r.text()}`);
  s.cookie = `access_token=${mm[1]}`;
  return s;
}
/**
 * Minting a token needs a fresh re-authentication (0.33). The session keeps
 * its plain cookie in `bare` (a stale session, for the refusal checks) and
 * carries the step-up from here on, as the console's retried request does.
 */
async function stepUp(s) {
  const r = await fetch(`${API}/auth/step-up`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip(), cookie: s.cookie }, body: JSON.stringify({ password: PW }) });
  const mm = (r.headers.get('set-cookie') ?? '').match(/step_up=([^;]+)/);
  if (r.status !== 200 || !mm) throw new Error(`step-up: ${r.status} ${await r.text()}`);
  s.bare = s.bare ?? s.cookie;
  s.cookie = `${s.bare}; step_up=${mm[1]}`;
  return s;
}
const mint = (s, body) => req('POST', '/enrollment/tokens', s, body);
const status = (s, id) => req('GET', `/enrollment/tokens/${id}/status`, s);
const msg = (r) => `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`;
const rid = () => String(100000000 + ((Math.random() * 899999999) | 0));
const secret = () => randomBytes(24).toString('base64url');
const claim = (token, rustdeskId, agentSecret, hostname) =>
  req('POST', '/enrollment/claim', null, { token, rustdeskId, hostname, platform: 'Windows', osVersion: '10.0.22631', agentSecret, agentVersion: AGENT_VERSION });

const created = { businesses: [], users: [], rustdeskIds: [] };

async function all() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });
  const roleUser = await prisma.role.findFirst({ where: { type: 'BUSINESS_USER' } });

  section('Fixtures (synthetic): Business A (four sites, one inactive) and Business B (one site)');
  const A = await prisma.customer.create({ data: { tenantId: tenant.id, name: `${TAG} Acme` } });
  const B = await prisma.customer.create({ data: { tenantId: tenant.id, name: `${TAG} Birch` } });
  created.businesses.push(A.id, B.id);
  const siteA = await prisma.site.create({ data: { tenantId: tenant.id, customerId: A.id, name: `${TAG} HQ` } });
  const siteAOld = await prisma.site.create({ data: { tenantId: tenant.id, customerId: A.id, name: `${TAG} Closed`, isActive: false } });
  const siteA3 = await prisma.site.create({ data: { tenantId: tenant.id, customerId: A.id, name: `${TAG} Depot` } });
  const siteA4 = await prisma.site.create({ data: { tenantId: tenant.id, customerId: A.id, name: `${TAG} Annex` } });
  const siteB = await prisma.site.create({ data: { tenantId: tenant.id, customerId: B.id, name: `${TAG} Birch HQ` } });

  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag, extra = {}) => { const u = await prisma.user.create({ data: { email: `ad-${tag}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'AD', lastName: tag, status: 'ACTIVE', ...extra } }); created.users.push(u.id); return u; };
  const admin = await mkUser('admin', { isPlatformAdmin: true });
  const ownerA = await mkUser('owner-a'), ownerB = await mkUser('owner-b');
  const userA = await mkUser('user-a'), colleagueA = await mkUser('colleague-a'), viewOnlyA = await mkUser('viewonly-a'), addOnlyA = await mkUser('addonly-a');
  await prisma.membership.create({ data: { userId: ownerA.id, tenantId: tenant.id, customerId: A.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: ownerB.id, tenantId: tenant.id, customerId: B.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: userA.id, tenantId: tenant.id, customerId: A.id, roleId: roleUser.id, capabilities: ['computers:view', 'computers:add'] } });
  await prisma.membership.create({ data: { userId: colleagueA.id, tenantId: tenant.id, customerId: A.id, roleId: roleUser.id, capabilities: ['computers:view'] } });
  await prisma.membership.create({ data: { userId: viewOnlyA.id, tenantId: tenant.id, customerId: A.id, roleId: roleUser.id, capabilities: ['computers:view'] } });
  await prisma.membership.create({ data: { userId: addOnlyA.id, tenantId: tenant.id, customerId: A.id, roleId: roleUser.id, capabilities: ['computers:add'] } });
  check(true, 'created A (4 sites), B (1 site), 8 users');

  // 3201 is also the approval signer's documented public port
  // (docs/approved-actions.md). If anything already answers there, this suite
  // would be talking to it rather than to the API it starts: refuse.
  const busy = await fetch(`${API}/health`).then(() => true, () => false);
  if (busy) throw new Error(`port ${PORT} is already in use; set ADDDEVICE_API_PORT to a free scratch port`);
  startApi();
  await waitUp();
  const S = {
    admin: await login(admin.email), ownerA: await login(ownerA.email), ownerB: await login(ownerB.email),
    userA: await login(userA.email), viewOnlyA: await login(viewOnlyA.email), addOnlyA: await login(addOnlyA.email),
  };

  // ── Step-up (0.33): a stale session mints nothing ─────────────────────────
  section('Minting needs a fresh re-authentication (0.33)');
  let r = await mint(S.ownerA, { businessId: A.id, siteId: siteA.id, accessMode: 'COMPANY_WIDE', description: 'Add device: stale' });
  check(r.status === 403 && r.body?.code === 'STEP_UP_REQUIRED' && r.body?.action === 'enrollment.create', 'owner A without a step-up: 403 STEP_UP_REQUIRED (enrollment.create)', msg(r));
  r = await mint(S.ownerA, { businessId: B.id, accessMode: 'COMPANY_WIDE' });
  check(r.status === 403 && r.body?.code !== 'STEP_UP_REQUIRED', 'owner A naming business B without a step-up: refused on scope, not asked to re-authenticate', msg(r));
  const staleRows = await prisma.deviceClaimToken.count({ where: { customerId: { in: [A.id, B.id] } } });
  check(staleRows === 0, 'no token row was written by the refused attempts', `rows: ${staleRows}`);
  for (const k of ['admin', 'ownerA', 'ownerB', 'userA', 'viewOnlyA', 'addOnlyA']) await stepUp(S[k]);
  check(true, 'every session steps up (password); the rest of this suite mints as the console does after the dialog');

  // ── Minting: the existing permission checks, plus the site ────────────────
  section('Minting a token: business and site are fixed, and only where the caller may manage');
  r = await mint(S.ownerA, { businessId: A.id, siteId: siteA.id, accessMode: 'COMPANY_WIDE', description: 'Add device: Windows' });
  const t1 = r.data;
  check(r.status === 201 || r.status === 200, 'owner A mints a token for A with site HQ', msg(r));
  check(/^[0-9a-f]{64}$/.test(t1?.token ?? '') && t1.siteId === siteA.id && t1.siteName === siteA.name && t1.customerId === A.id, 'the creation response carries the raw token once, and the site binding', JSON.stringify({ siteId: t1?.siteId, siteName: t1?.siteName }));
  const row1 = await prisma.deviceClaimToken.findUnique({ where: { id: t1.id } });
  check(row1.token === createHash('sha256').update(t1.token).digest('hex') && row1.token !== t1.token, 'only the hash is stored');
  const audit1 = await prisma.activityLog.findFirst({ where: { action: 'CLAIM_TOKEN_CREATED', resourceId: t1.id } });
  check(audit1?.customerId === A.id && audit1?.metadata?.siteId === siteA.id && audit1?.actorId === ownerA.id, 'minting is audited with the business, site and actor', JSON.stringify(audit1?.metadata));

  r = await mint(S.ownerA, { businessId: B.id, accessMode: 'COMPANY_WIDE' });
  check(r.status === 403, 'owner A naming business B is refused (403)', msg(r));
  r = await mint(S.ownerA, { customerId: B.id, accessMode: 'COMPANY_WIDE' });
  check(r.status === 403, 'owner A naming business B through the legacy customerId is refused (403)', msg(r));
  r = await mint(S.ownerA, { businessId: B.id, siteId: siteB.id, accessMode: 'COMPANY_WIDE' });
  check(r.status === 403, 'owner A naming B and B\'s site is refused (403)', msg(r));
  const foreignSite = await mint(S.ownerA, { businessId: A.id, siteId: siteB.id, accessMode: 'COMPANY_WIDE' });
  const missingSite = await mint(S.ownerA, { businessId: A.id, siteId: 'c' + randomBytes(12).toString('hex'), accessMode: 'COMPANY_WIDE' });
  check(foreignSite.status === 400 && /Unknown site for this business/.test(foreignSite.body?.message), 'owner A binding B\'s site to an A token is refused (400)', msg(foreignSite));
  check(missingSite.status === 400 && missingSite.body?.message === foreignSite.body?.message, 'a foreign site and a non-existent site get the same answer (no probing)', `${foreignSite.body?.message} / ${missingSite.body?.message}`);
  r = await mint(S.ownerA, { siteId: siteB.id, accessMode: 'COMPANY_WIDE' });
  check(r.status === 400, 'owner A with no business named and B\'s site: the token is A\'s, and B\'s site is refused', msg(r));
  r = await mint(S.ownerA, { businessId: A.id, siteId: siteAOld.id, accessMode: 'COMPANY_WIDE' });
  check(r.status === 400, 'an inactive site is refused', msg(r));
  r = await mint(S.ownerA, { businessId: A.id, accessMode: 'ASSIGNED_USERS', assignedUserIds: [ownerB.id] });
  check(r.status === 400, 'assigning a user of another business is refused (unchanged rule)', msg(r));
  r = await mint(S.viewOnlyA, { businessId: A.id, accessMode: 'COMPANY_WIDE' });
  check(r.status === 403, 'without computers:add, minting is refused (403)', msg(r));
  r = await mint(S.admin, { accessMode: 'COMPANY_WIDE' });
  check(r.status === 403, 'a Platform Admin must name a business', msg(r));
  const leaked = await prisma.deviceClaimToken.count({ where: { customerId: B.id } });
  check(leaked === 0, 'after every refused attempt, business B has no tokens at all', `B tokens: ${leaked}`);

  // ── Status: waiting, scoped, nothing secret ───────────────────────────────
  section('Status while waiting: scoped to the business, and nothing secret in it');
  r = await status(S.ownerA, t1.id);
  check(r.status === 200 && r.data.state === 'waiting' && r.data.device === null && r.data.token.siteId === siteA.id && r.data.token.businessId === A.id, 'owner A: waiting, bound to A / HQ', msg(r));
  check(!r.text.includes(t1.token) && !r.text.includes(row1.token) && !/"token":"/.test(r.text), 'the status body carries neither the token nor its hash');
  r = await status(S.ownerB, t1.id);
  check(r.status === 404, 'owner B asking for A\'s token gets 404', msg(r));
  r = await status(S.addOnlyA, t1.id);
  check(r.status === 403, 'without computers:view the status route is refused', msg(r));
  r = await status(S.ownerA, 'c' + randomBytes(12).toString('hex'));
  check(r.status === 404, 'an unknown token id is 404', msg(r));
  r = await status(S.admin, t1.id);
  check(r.status === 200 && r.data.state === 'waiting', 'negative control: the Platform Admin can read A\'s token');

  // ── The real device path ──────────────────────────────────────────────────
  section('The device arrives: claim → heartbeat → inventory, and status follows each step');
  const dev1 = { rid: rid(), secret: secret(), host: `${TAG}-WS01` };
  created.rustdeskIds.push(dev1.rid);
  r = await claim(t1.token, dev1.rid, dev1.secret, dev1.host);
  check(r.status === 200 && r.data?.endpoint?.id, 'the installer claims the token', msg(r));
  const ep1 = r.data?.endpoint?.id;
  r = await status(S.ownerA, t1.id);
  const d = r.data?.device;
  check(r.status === 200 && r.data.state === 'enrolled' && r.data.deviceVisible === true && d?.id === ep1, 'status: enrolled, and the device is the one that claimed', msg(r));
  check(d?.customer?.id === A.id && d?.site?.id === siteA.id && d?.customerId === A.id, 'the device landed in A, site HQ — the token\'s binding', JSON.stringify({ customer: d?.customer, site: d?.site }));
  check(d?.isOnline === true && d?.agentBound === true, 'first health: online at claim, device secret bound');
  check(d?.agentType === 'none' && d?.inventoryCollectedAt === null, 'before any heartbeat: no agent type and no inventory are claimed', JSON.stringify({ agentType: d?.agentType, inv: d?.inventoryCollectedAt }));
  check(!r.text.includes(dev1.secret) && !/agentSecretHash/.test(r.text), 'the status body carries no device secret or its hash');

  r = await req('POST', '/enrollment/heartbeat', null, { rustdeskId: dev1.rid, agentSecret: dev1.secret, hostname: dev1.host, platform: 'Windows', agentVersion: AGENT_VERSION });
  check(r.status === 200 && r.data?.authenticated !== false, 'the agent\'s first heartbeat is accepted', msg(r));
  const inv = (r.data?.commands ?? []).find((c) => c.type === 'INVENTORY_REFRESH');
  let s1 = await status(S.ownerA, t1.id);
  check(s1.data?.device?.agentType === 'standard' && s1.data?.device?.agentVersion === AGENT_VERSION, 'after the heartbeat: standard agent, with its version', JSON.stringify(s1.data?.device && { t: s1.data.device.agentType, v: s1.data.device.agentVersion }));
  check(s1.data?.device?.inventoryCollectedAt === null, 'inventory is still not claimed before the agent sends it');
  check(!!inv, 'the heartbeat hands the agent an inventory command', JSON.stringify(r.data?.commands));
  if (inv) {
    r = await req('POST', '/enrollment/command-result', null, { rustdeskId: dev1.rid, agentSecret: dev1.secret, commandId: inv.id, ok: true, inventory: { osCaption: 'Microsoft Windows 11 Pro', manufacturer: 'Scratch', model: 'E2E', cpuCores: 4 } });
    check(r.status === 200, 'the agent reports its inventory', msg(r));
    s1 = await status(S.ownerA, t1.id);
    check(!!s1.data?.device?.inventoryCollectedAt && s1.data.device.osCaption === 'Microsoft Windows 11 Pro', 'status: inventory received, with what the agent reported', JSON.stringify(s1.data?.device && { at: s1.data.device.inventoryCollectedAt, os: s1.data.device.osCaption }));
  }
  r = await claim(t1.token, rid(), secret(), `${TAG}-AGAIN`);
  check(r.status === 400, 'the token cannot be claimed a second time', msg(r));

  // ── Scoping of the enrolled device ────────────────────────────────────────
  section('Another business cannot see the token or the device it enrolled');
  r = await status(S.ownerB, t1.id);
  check(r.status === 404, 'owner B: A\'s enrolled token is still 404', msg(r));
  r = await req('GET', `/endpoints/list?search=${encodeURIComponent(TAG)}`, S.ownerB);
  check(r.status === 200 && !(r.data?.rows ?? []).some((x) => x.id === ep1), 'owner B: the device is not in B\'s device list', msg(r));
  r = await req('GET', `/endpoints/${ep1}`, S.ownerB);
  check(r.status === 404 || r.status === 403, 'owner B: the device page is refused', msg(r));
  r = await req('GET', `/enrollment/tokens`, S.ownerB);
  check(r.status === 200 && !(r.data ?? []).some((x) => x.id === t1.id), 'owner B: the token is not in B\'s token list');
  r = await req('GET', `/endpoints/list?search=${encodeURIComponent(TAG)}`, S.ownerA);
  check(r.status === 200 && (r.data?.rows ?? []).some((x) => x.id === ep1 && x.site?.id === siteA.id), 'owner A: the device is in A\'s list, at site HQ', JSON.stringify((r.data?.rows ?? []).map((x) => x.site)));
  r = await status(S.admin, t1.id);
  check(r.status === 200 && r.data.device?.id === ep1, 'negative control: the Platform Admin sees the enrolled device');

  section('A Business User sees only what endpoint visibility allows them');
  r = await mint(S.userA, { businessId: A.id, accessMode: 'ASSIGNED_USERS', assignedUserIds: [colleagueA.id] });
  const tHidden = r.data;
  check(r.status === 201 || r.status === 200, 'user A (computers:add) mints an ASSIGNED_USERS token for a colleague', msg(r));
  r = await mint(S.userA, { businessId: B.id, accessMode: 'COMPANY_WIDE' });
  check(r.status === 403, 'user A naming business B is refused', msg(r));
  const dev2 = { rid: rid(), secret: secret() }; created.rustdeskIds.push(dev2.rid);
  r = await claim(tHidden.token, dev2.rid, dev2.secret, `${TAG}-COLLEAGUE`);
  check(r.status === 200, 'the colleague\'s device enrols', msg(r));
  const ep2 = r.data?.endpoint?.id;
  r = await status(S.userA, tHidden.id);
  check(r.status === 200 && r.data.state === 'enrolled' && r.data.deviceVisible === false && r.data.device === null, 'user A: told it enrolled, but not shown a device they may not see', msg(r));
  check(!r.text.includes(ep2), 'user A: not even its id');
  r = await status(S.ownerA, tHidden.id);
  check(r.status === 200 && r.data.device?.id === ep2, 'owner A sees that device (owners are unrestricted in their business)');
  r = await mint(S.userA, { businessId: A.id, siteId: siteA3.id, accessMode: 'COMPANY_WIDE' });
  const tWide = r.data;
  const dev3 = { rid: rid(), secret: secret() }; created.rustdeskIds.push(dev3.rid);
  await claim(tWide.token, dev3.rid, dev3.secret, `${TAG}-SHARED`);
  r = await status(S.userA, tWide.id);
  check(r.status === 200 && r.data.deviceVisible === true && r.data.device?.site?.id === siteA3.id, 'user A: a COMPANY_WIDE device is shown, at the site they chose', msg(r));

  // ── Sites that change under a live token ──────────────────────────────────
  section('A site that changes between mint and claim');
  r = await mint(S.ownerA, { businessId: A.id, siteId: siteA4.id, accessMode: 'COMPANY_WIDE' });
  const tClosed = r.data;
  await prisma.site.update({ where: { id: siteA4.id }, data: { isActive: false } });
  const dev4 = { rid: rid(), secret: secret() }; created.rustdeskIds.push(dev4.rid);
  r = await claim(tClosed.token, dev4.rid, dev4.secret, `${TAG}-CLOSED`);
  const ep4 = r.data?.endpoint?.id;
  const ep4row = ep4 ? await prisma.endpoint.findUnique({ where: { id: ep4 } }) : null;
  check(r.status === 200 && ep4row?.customerId === A.id && ep4row?.siteId === null, 'a site deactivated before the claim is dropped; the device still enrols into A', JSON.stringify({ status: r.status, site: ep4row?.siteId }));
  const siteGone = await prisma.site.create({ data: { tenantId: tenant.id, customerId: A.id, name: `${TAG} Temporary` } });
  r = await mint(S.ownerA, { businessId: A.id, siteId: siteGone.id, accessMode: 'COMPANY_WIDE' });
  const tGone = r.data;
  await prisma.site.delete({ where: { id: siteGone.id } });
  const tGoneRow = await prisma.deviceClaimToken.findUnique({ where: { id: tGone.id } });
  check(tGoneRow && tGoneRow.siteId === null, 'deleting a site keeps the token, without the site (SET NULL)');

  // ── Expired and revoked ───────────────────────────────────────────────────
  section('Expired and revoked links');
  r = await mint(S.ownerA, { businessId: A.id, accessMode: 'COMPANY_WIDE' });
  const tExp = r.data;
  await prisma.deviceClaimToken.update({ where: { id: tExp.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });
  r = await status(S.ownerA, tExp.id);
  check(r.status === 200 && r.data.state === 'expired' && r.data.device === null, 'an unused, expired token reports expired', msg(r));
  r = await claim(tExp.token, rid(), secret(), `${TAG}-LATE`);
  check(r.status === 400, 'and cannot be claimed', msg(r));
  r = await mint(S.ownerA, { businessId: A.id, accessMode: 'COMPANY_WIDE' });
  const tRev = r.data;
  r = await req('DELETE', `/enrollment/tokens/${tRev.id}`, S.ownerB);
  check(r.status === 404, 'owner B cannot revoke A\'s token', msg(r));
  r = await req('DELETE', `/enrollment/tokens/${tRev.id}`, S.ownerA);
  check(r.status === 200, 'owner A revokes a waiting token', msg(r));
  r = await status(S.ownerA, tRev.id);
  check(r.status === 404, 'a revoked token is gone (404), which the page reports as revoked', msg(r));

  section('A Platform Admin adding a device to B');
  r = await mint(S.admin, { businessId: B.id, siteId: siteB.id, accessMode: 'COMPANY_WIDE' });
  const tB = r.data;
  check((r.status === 201 || r.status === 200) && tB.siteId === siteB.id, 'admin mints for B with B\'s site', msg(r));
  const dev5 = { rid: rid(), secret: secret() }; created.rustdeskIds.push(dev5.rid);
  r = await claim(tB.token, dev5.rid, dev5.secret, `${TAG}-BIRCH`);
  const ep5 = r.data?.endpoint?.id;
  r = await status(S.ownerB, tB.id);
  check(r.status === 200 && r.data.device?.id === ep5 && r.data.device.site?.id === siteB.id, 'owner B sees the device the admin added to B', msg(r));
  r = await status(S.ownerA, tB.id);
  check(r.status === 404, 'owner A cannot see B\'s token or device', msg(r));
}

async function cleanup() {
  await stopApi();
  try {
    const ids = created.businesses;
    const eps = await prisma.endpoint.findMany({ where: { customerId: { in: ids } }, select: { id: true } });
    const epIds = eps.map((e) => e.id);
    await prisma.deviceClaimToken.deleteMany({ where: { OR: [{ customerId: { in: ids } }, { endpointId: { in: epIds } }] } });
    await prisma.endpointCommand.deleteMany({ where: { endpointId: { in: epIds } } });
    await prisma.endpointInventory.deleteMany({ where: { endpointId: { in: epIds } } });
    await prisma.computerAccess.deleteMany({ where: { endpointId: { in: epIds } } });
    await prisma.rustdeskNode.deleteMany({ where: { OR: [{ endpointId: { in: epIds } }, { rustdeskId: { in: created.rustdeskIds } }] } });
    await prisma.monitorAlert.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.endpoint.deleteMany({ where: { id: { in: epIds } } });
    await prisma.site.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.membership.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.customer.deleteMany({ where: { id: { in: ids } } });
    if (created.users.length) await prisma.user.deleteMany({ where: { id: { in: created.users } } });
  } catch (e) { console.error('cleanup:', e.message); }
  await prisma.$disconnect();
}

all()
  .catch((e) => { fail++; failures.push(`fatal: ${e.stack ?? e.message}`); console.error(e); })
  .finally(async () => {
    await cleanup();
    console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
    if (failures.length) { for (const f of failures) console.log(`  - ${f}`); if (api?.log) console.log(`\n── API output (last 4000 characters)\n${api.log.slice(-4000)}`); process.exit(1); }
    process.exit(0);
  });
