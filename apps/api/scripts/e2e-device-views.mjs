#!/usr/bin/env node
/**
 * End-to-end proof of device groups, saved device views and bulk actions
 * (0.33): /device-views, /device-groups, POST /endpoints/bulk and
 * POST /endpoints/bulk/export.csv.
 *
 *   - views round-trip (create, list, get, update, delete) and store only
 *     the device list's own filter parameters — unknown keys and bad values
 *     are refused by the list's parser;
 *   - a personal view is its author's alone; a shared view belongs to one
 *     business, is made only by someone who may manage it, cannot name
 *     another business's business/site/group, and opening it runs the list
 *     as the VIEWER: a Business User and a restricted technician get their
 *     own visibility, and a filter they may not use (alerts) is still refused;
 *   - groups: only an owner, a whole-business computers:edit technician or the
 *     MSP edits them; a group cannot hold another business's computer (not
 *     through bulk, endpoint creation or an enrolment token); another
 *     business's group is a 404; the group filter never widens the list;
 *   - bulk: per-computer results with reasons — not found (another business,
 *     ungranted, made up), no permission, containment, archived, Linux, no
 *     device secret, already current — the 200 cap, no other action, the
 *     fleet limit stopped short of (nobody is paused), and the audit entries
 *     (one per business, plus the single actions' own);
 *   - the selection export goes through the audited device-list export.
 *
 * Self-starting: its own API from dist/ on DEVICE_VIEWS_API_PORT (3291)
 * against DATABASE_URL, which must name a scratch/test database.
 *
 * Run:  DATABASE_URL=…/rem0te_device_views_test node scripts/e2e-device-views.mjs
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, URLSearchParams } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const DB = process.env.DATABASE_URL ?? '';
const dbName = DB.split('/').pop()?.split('?')[0] ?? '';
if (!/scratch|test/.test(dbName)) { console.error(`Refusing to run against database "${dbName}": name must contain "scratch" or "test".`); process.exit(2); }
const PORT = Number(process.env.DEVICE_VIEWS_API_PORT ?? 3291);
if ([3000, 3001, 443].includes(PORT)) { console.error(`Refusing port ${PORT}: that is a production port.`); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'device-views-e2e-password-1';
const TAG = `DV${sfx}`;
const TARGET = '1.4.1';

let pass = 0, fail = 0;
const failures = [];
const J = (x) => JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? String(v) : v));
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;
const sha = (s) => createHash('sha256').update(s).digest('hex');

const apiEnv = {
  ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATABASE_URL: DB,
  JWT_SECRET: randomBytes(32).toString('hex'), LAUNCHER_TOKEN_SECRET: randomBytes(32).toString('hex'),
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? randomBytes(32).toString('hex'), TRUSTED_PROXIES: 'loopback',
  HBBS_PRESENCE_HOST: '127.0.0.2', MONITOR_SWEEP: 'off', AUDIT_SEALER: 'off', CLIENT_UPDATE_SWEEP: 'off',
  VERSION_FILE: path.resolve(here, '..', '..', '..', 'version.json'),
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

// Paced under the 20 req/s burst throttler; a fresh address per request
// keeps the per-minute route limits (bulk: 10/min) per request, not per suite.
let last = 0;
async function req(method, p, s, { body, business, raw = false } = {}) {
  const wait = last + 60 - Date.now(); if (wait > 0) await sleep(wait); last = Date.now();
  const h = { 'content-type': 'application/json', 'x-forwarded-for': ip() };
  if (s) h.cookie = s.cookie;
  if (business ?? s?.business) h['x-rem0te-business'] = business ?? s.business;
  const r = await fetch(`${API}${p}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  if (raw) return { status: r.status, text, headers: r.headers };
  let j; try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j, data: j?.data };
}
async function login(email, business) {
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip() }, body: JSON.stringify({ email, password: PW }) });
  const mm = (r.headers.get('set-cookie') ?? '').match(/access_token=([^;]+)/);
  if (r.status !== 200 || !mm) throw new Error(`login ${email}: ${r.status} ${await r.text()}`);
  return { cookie: `access_token=${mm[1]}`, business };
}
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== false && v !== '').map(([k, v]) => [k, String(v)])).toString();
const list = (s, params = {}) => req('GET', `/endpoints/list?${qs({ pageSize: 200, ...params })}`, s);
const bulk = (s, body) => req('POST', '/endpoints/bulk', s, { body });
const msg = (r) => `HTTP ${r.status} ${JSON.stringify(r.body ?? r.text).slice(0, 400)}`;
const ids = (r) => (r.data?.rows ?? []).map((x) => x.id);
const byId = (r) => new Map((r.data?.results ?? []).map((x) => [x.endpointId, x]));
const code = (r) => r.body?.message?.code ?? r.body?.code;

const created = { businesses: [], users: [] };
let originalPin;

async function all() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });
  const roleUser = await prisma.role.findFirst({ where: { type: 'BUSINESS_USER' } });
  originalPin = (await prisma.platformSettings.findUnique({ where: { id: 'singleton' } }))?.rustdeskPinnedVersion ?? null;
  await prisma.platformSettings.upsert({ where: { id: 'singleton' }, update: { rustdeskPinnedVersion: TARGET }, create: { id: 'singleton', rustdeskPinnedVersion: TARGET } });

  section('Fixtures (synthetic): Business A (48 computers) and Business B (2)');
  const A = await prisma.customer.create({ data: { tenantId: tenant.id, name: `${TAG} Acme` } });
  const B = await prisma.customer.create({ data: { tenantId: tenant.id, name: `${TAG} Birch` } });
  created.businesses.push(A.id, B.id);
  const siteA = await prisma.site.create({ data: { tenantId: tenant.id, customerId: A.id, name: `${TAG} HQ` } });
  const siteB = await prisma.site.create({ data: { tenantId: tenant.id, customerId: B.id, name: `${TAG} HQ` } });

  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag, extra = {}) => { const u = await prisma.user.create({ data: { email: `dv-${tag}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'DV', lastName: tag, status: 'ACTIVE', ...extra } }); created.users.push(u.id); return u; };
  const admin = await mkUser('admin', { isPlatformAdmin: true });
  const ownerA = await mkUser('owner-a'), ownerB = await mkUser('owner-b'), userA = await mkUser('user-a');
  const techWhole = await mkUser('tech-whole'), techNamed = await mkUser('tech-named'), techView = await mkUser('tech-view');
  await prisma.membership.create({ data: { userId: ownerA.id, tenantId: tenant.id, customerId: A.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: ownerB.id, tenantId: tenant.id, customerId: B.id, roleId: roleOwner.id } });
  // A Business User who even holds computers:edit: groups and shared views are still not theirs to change.
  await prisma.membership.create({ data: { userId: userA.id, tenantId: tenant.id, customerId: A.id, roleId: roleUser.id, capabilities: ['computers:view', 'computers:edit'] } });

  const now = Date.now();
  const mkEp = async (biz, name, { site = null, online = true, mode = 'COMPANY_WIDE', status = 'ACTIVE', platform = 'Windows', version = '1.2.0', secret = true, node = true } = {}) => {
    const e = await prisma.endpoint.create({ data: {
      tenantId: tenant.id, customerId: biz.id, siteId: site?.id ?? null, name, hostname: name.toLowerCase(), platform,
      osVersion: platform === 'Windows' ? 'Windows 11 Pro' : 'Ubuntu 24.04', status, isOnline: online, isManaged: true, accessMode: mode,
      lastSeenAt: new Date(now - 60_000), agentVersion: '0.32.0', deviceClass: 'WORKSTATION',
    } });
    if (node) await prisma.rustdeskNode.create({ data: { tenantId: tenant.id, endpointId: e.id, rustdeskId: String(100000000 + ((Math.random() * 899999999) | 0)), version, platform: platform.toLowerCase(), agentSecretHash: secret ? sha(randomBytes(16).toString('hex')) : null } });
    return e;
  };
  const a1 = await mkEp(A, `${TAG}-A1`, { site: siteA });
  const a2 = await mkEp(A, `${TAG}-A2`, { site: siteA, online: false });
  const a3 = await mkEp(A, `${TAG}-A3-CURRENT`, { version: TARGET });
  const a4 = await mkEp(A, `${TAG}-A4-NOSECRET`, { secret: false });
  const a5 = await mkEp(A, `${TAG}-A5-ASSIGNED`, { mode: 'ASSIGNED_USERS' });
  const a6 = await mkEp(A, `${TAG}-A6-NOT-GRANTED`, { mode: 'ASSIGNED_USERS' });
  const a7 = await mkEp(A, `${TAG}-A7-LINUX`, { platform: 'Linux' });
  const a8 = await mkEp(A, `${TAG}-A8-ARCHIVED`, { status: 'ARCHIVED', online: false });
  await prisma.computerAccess.create({ data: { tenantId: tenant.id, endpointId: a5.id, userId: userA.id } });
  const fleet = [];
  for (let i = 0; i < 40; i++) fleet.push(await mkEp(A, `${TAG}-fleet-${String(i).padStart(2, '0')}`));
  const b1 = await mkEp(B, `${TAG}-B1`, { site: siteB });
  const b2 = await mkEp(B, `${TAG}-B2`, { site: siteB });

  await prisma.technicianAssignment.create({ data: { tenantId: tenant.id, customerId: A.id, userId: techWhole.id, capabilities: ['computers:view', 'computers:edit'], endpointIds: [] } });
  await prisma.technicianAssignment.create({ data: { tenantId: tenant.id, customerId: A.id, userId: techNamed.id, capabilities: ['computers:view', 'computers:edit'], endpointIds: [a1.id] } });
  await prisma.technicianAssignment.create({ data: { tenantId: tenant.id, customerId: A.id, userId: techView.id, capabilities: ['computers:view'], endpointIds: [] } });
  check(true, 'created A (47 current + 1 archived), B (2), 7 users, 3 technician assignments');

  startApi();
  await waitUp();
  const S = {
    admin: await login(admin.email), ownerA: await login(ownerA.email), ownerB: await login(ownerB.email), userA: await login(userA.email),
    techWhole: await login(techWhole.email, A.id), techNamed: await login(techNamed.email, A.id), techView: await login(techView.email, A.id),
  };
  const auditCount = (where) => prisma.activityLog.count({ where });

  // ── Saved views: round trip ────────────────────────────────────────────────
  section('Saved views: a personal view round-trips and stores only list filters');
  let r = await req('POST', '/device-views', S.ownerA, { body: { name: `${TAG} offline HQ`, filters: { online: 'offline', siteId: siteA.id, search: '  A2 ', restartPending: false }, columns: ['business', 'lastSeen', 'patches'], sort: 'name', dir: 'desc', density: 'compact' } });
  check(r.status === 201 || r.status === 200, 'create a personal view', msg(r));
  const pv = r.data;
  const sorted = (o) => JSON.stringify(Object.fromEntries(Object.entries(o ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))));
  check(sorted(pv?.filters) === sorted({ search: 'A2', siteId: siteA.id, online: 'offline' }) && pv.shared === false && pv.mine && pv.sort === 'name' && pv.dir === 'desc' && pv.density === 'compact' && pv.columns.join() === 'business,lastSeen,patches',
    'stored exactly as the list parses it: trimmed, false/empty dropped, nothing else', JSON.stringify(pv));
  r = await req('GET', '/device-views', S.ownerA);
  check(r.status === 200 && r.data.views.some((v) => v.id === pv.id && v.name === `${TAG} offline HQ`), 'it is listed for its author', msg(r));
  r = await req('GET', `/device-views/${pv.id}`, S.ownerA);
  check(r.status === 200 && r.data.filters.online === 'offline', 'GET :id returns it');
  {
    const v = r.data;
    const opened = await list(S.ownerA, { ...v.filters, sort: v.sort, dir: v.dir });
    check(opened.status === 200 && opened.data.total === 1 && ids(opened)[0] === a2.id, 'opening it is the list with its parameters (A2: offline, at HQ, matching "A2")', msg(opened));
  }
  r = await req('PATCH', `/device-views/${pv.id}`, S.ownerA, { body: { name: `${TAG} renamed`, filters: { agent: 'standard' }, density: 'comfortable' } });
  check(r.status === 200 && r.data.name === `${TAG} renamed` && JSON.stringify(r.data.filters) === '{"agent":"standard"}' && r.data.density === 'comfortable' && r.data.sort === 'name', 'PATCH replaces filters and keeps what it did not name', msg(r));
  for (const [bad, why] of [
    [{ name: 'x', filters: { page: '2' } }, 'page is not a filter'],
    [{ name: 'x', filters: { customerId: A.id } }, 'an unknown key'],
    [{ name: 'x', filters: { online: 'sometimes' } }, 'a value the list refuses'],
    [{ name: 'x', filters: { restartPending: 'maybe' } }, 'restartPending not true/false'],
    [{ name: 'x', filters: { siteId: 'not an id!' } }, 'an id that is not an id'],
    [{ name: 'x', sort: 'secret' }, 'an unknown sort'],
    [{ name: 'x', results: [] }, 'a body field that is not part of a view'],
    [{ name: '' }, 'an empty name'],
  ]) {
    r = await req('POST', '/device-views', S.ownerA, { body: bad });
    check(r.status === 400, `refused: ${why}`, msg(r));
  }
  r = await req('POST', '/device-views', S.ownerA, { body: { name: 'x', businessId: A.id } });
  check(r.status === 400, 'a personal view takes no businessId');
  r = await req('GET', `/device-views/${pv.id}`, S.userA);
  check(r.status === 404, 'someone else’s personal view is a 404, even in the same business', msg(r));
  r = await req('GET', '/device-views', S.userA);
  check(r.status === 200 && !r.data.views.some((v) => v.id === pv.id), 'and is not listed for them');
  r = await req('PATCH', `/device-views/${pv.id}`, S.ownerB, { body: { name: 'stolen' } });
  check(r.status === 404, 'another business cannot change it (404)');
  r = await req('DELETE', `/device-views/${pv.id}`, S.ownerA);
  check(r.status === 200, 'DELETE removes it', msg(r));
  r = await req('GET', `/device-views/${pv.id}`, S.ownerA);
  check(r.status === 404, 'and it is gone');
  check(await auditCount({ action: 'DEVICE_VIEW_SHARED_CHANGED', actorId: ownerA.id }) === 0, 'personal views are not audited (nothing is shared)');

  // ── Shared views ──────────────────────────────────────────────────────────
  section('Shared views: who may share, and opening one never widens what the viewer sees');
  r = await req('POST', '/device-views', S.userA, { body: { name: 'x', shared: true } });
  check(r.status === 403 && code(r) === 'NOT_ALLOWED', 'a Business User (even with computers:edit) cannot share a view', msg(r));
  r = await req('POST', '/device-views', S.techNamed, { body: { name: 'x', shared: true } });
  check(r.status === 403, 'a technician limited to named computers cannot share a view', msg(r));
  r = await req('POST', '/device-views', S.techWhole, { body: { name: `${TAG} tech shared`, shared: true } });
  check(r.status === 200 || r.status === 201, 'a whole-business computers:edit technician can', msg(r));
  const techShared = r.data;
  r = await req('POST', '/device-views', S.ownerA, { body: { name: 'x', shared: true, filters: { businessId: B.id } } });
  check(r.status === 400 && code(r) === 'VIEW_SCOPE', 'a shared view cannot filter on another business', msg(r));
  r = await req('POST', '/device-views', S.ownerA, { body: { name: 'x', shared: true, filters: { siteId: siteB.id } } });
  check(r.status === 400 && code(r) === 'VIEW_SCOPE', 'nor on another business’s site', msg(r));
  r = await req('POST', '/device-views', S.ownerA, { body: { name: 'x', shared: true, businessId: B.id } });
  check(r.status === 403, 'an owner cannot share into another business', msg(r));
  r = await req('POST', '/device-views', S.ownerA, { body: { name: `${TAG} everything`, shared: true, filters: {}, sort: 'name', dir: 'asc' } });
  check(r.status === 200 || r.status === 201, 'the owner shares an unfiltered view', msg(r));
  const shared = r.data;
  const sharedAudit = await prisma.activityLog.findFirst({ where: { action: 'DEVICE_VIEW_SHARED_CHANGED', resourceId: shared?.id } });
  check(sharedAudit?.customerId === A.id && sharedAudit.actorId === ownerA.id && sharedAudit.metadata?.op === 'created', 'sharing is audited against business A', J(sharedAudit));

  r = await req('GET', '/device-views', S.userA);
  const seenByUser = r.data?.views?.find((v) => v.id === shared?.id);
  check(!!seenByUser && seenByUser.may.edit === false && seenByUser.shared, 'the Business User lists the shared view, read-only', msg(r));
  {
    const asOwner = await list(S.ownerA, { ...shared.filters, sort: shared.sort, dir: shared.dir });
    const asUser = await list(S.userA, { ...seenByUser.filters, sort: seenByUser.sort, dir: seenByUser.dir });
    const userOwn = await list(S.userA, {});
    check(asOwner.data.total === 47, 'opened by the owner: all 47 current A computers', `total ${asOwner.data?.total}`);
    check(asUser.status === 200 && asUser.data.total === userOwn.data.total && asUser.data.total < asOwner.data.total && !ids(asUser).includes(a6.id) && ids(asUser).includes(a5.id),
      'opened by the Business User: exactly their own visibility (granted A5, never ungranted A6)', `user ${asUser.data?.total}, own ${userOwn.data?.total}`);
    const asTech = await list(S.techNamed, { ...shared.filters });
    check(asTech.status === 200 && asTech.data.total === 1 && ids(asTech)[0] === a1.id, 'opened by a technician limited to A1: only A1', msg(asTech));
  }
  r = await req('POST', '/device-views', S.ownerA, { body: { name: `${TAG} critical`, shared: true, filters: { alerts: 'critical' } } });
  const alertView = r.data;
  {
    const asUser = await list(S.userA, alertView.filters);
    check(asUser.status === 403, 'a shared alerts filter does not grant monitoring:alerts: the Business User’s list refuses it', msg(asUser));
  }
  r = await req('PATCH', `/device-views/${shared.id}`, S.userA, { body: { name: 'mine now' } });
  check(r.status === 403, 'the Business User cannot change a shared view', msg(r));
  r = await req('DELETE', `/device-views/${shared.id}`, S.userA);
  check(r.status === 403, 'nor delete it');
  r = await req('GET', '/device-views', S.ownerB);
  check(r.status === 200 && !r.data.views.some((v) => [shared.id, techShared.id, alertView.id].includes(v.id)), 'Business B does not list A’s shared views');
  for (const [m, body] of [['GET'], ['PATCH', { name: 'x' }], ['DELETE']]) {
    r = await req(m, `/device-views/${shared.id}`, S.ownerB, { body });
    check(r.status === 404, `Business B: ${m} on A’s shared view is a 404`, msg(r));
  }
  r = await req('GET', '/device-views', S.admin);
  check(r.data?.views?.some((v) => v.id === shared.id && v.business?.id === A.id), 'the Platform Admin lists it, with its business');
  r = await req('PATCH', `/device-views/${shared.id}`, S.ownerA, { body: { filters: { online: 'online' } } });
  const upd = await prisma.activityLog.findFirst({ where: { action: 'DEVICE_VIEW_SHARED_CHANGED', resourceId: shared.id, metadata: { path: ['op'], equals: 'updated' } } });
  check(r.status === 200 && upd?.metadata?.before?.filters && upd.metadata.after.filters.online === 'online', 'changing a shared view is audited with before and after', JSON.stringify(upd?.metadata));
  r = await req('PATCH', `/device-views/${shared.id}`, S.ownerA, { body: { shared: false } });
  check(r.status === 400, 'a shared view cannot be turned personal by PATCH (who it is for is fixed)', msg(r));

  // ── Groups ────────────────────────────────────────────────────────────────
  section('Device groups: who may edit, per-business names, and isolation');
  r = await req('POST', '/device-groups', S.userA, { body: { name: 'x' } });
  check(r.status === 403 && code(r) === 'NOT_ALLOWED', 'a Business User with computers:edit cannot create a group', msg(r));
  r = await req('POST', '/device-groups', S.techNamed, { body: { name: 'x' } });
  check(r.status === 403, 'a technician limited to named computers cannot', msg(r));
  r = await req('POST', '/device-groups', S.techView, { body: { name: 'x' } });
  check(r.status === 403, 'a technician without computers:edit cannot', msg(r));
  r = await req('POST', '/device-groups', S.ownerA, { body: { name: `${TAG} Front desk`, description: 'reception PCs' } });
  check(r.status === 200 || r.status === 201, 'the owner creates one', msg(r));
  const gA = r.data;
  check((await prisma.activityLog.findFirst({ where: { action: 'DEVICE_GROUP_CREATED', resourceId: gA.id } }))?.customerId === A.id, 'creation is audited against A');
  r = await req('POST', '/device-groups', S.ownerA, { body: { name: `${TAG} Front desk` } });
  check(r.status === 409, 'a duplicate name in the same business is refused', msg(r));
  r = await req('POST', '/device-groups', S.ownerB, { body: { name: `${TAG} Front desk` } });
  check(r.status === 200 || r.status === 201, 'the same name in another business is fine', msg(r));
  const gB = r.data;
  r = await req('POST', '/device-groups', S.techWhole, { body: { name: `${TAG} Servers` } });
  check(r.status === 200 || r.status === 201, 'a whole-business computers:edit technician creates one', msg(r));
  const gA2 = r.data;
  r = await req('POST', '/device-groups', S.admin, { body: { name: `${TAG} needs a business` } });
  check(r.status === 403 || r.status === 400, 'the Platform Admin must name the business', msg(r));
  r = await req('GET', '/device-groups', S.ownerB);
  check(r.status === 200 && r.data.groups.every((g) => g.business?.id === B.id) && !r.data.groups.some((g) => g.id === gA.id), 'Business B lists only its own groups');
  for (const [m, body] of [['PATCH', { name: 'x' }], ['DELETE']]) {
    r = await req(m, `/device-groups/${gA.id}`, S.ownerB, { body });
    check(r.status === 404, `Business B: ${m} on A’s group is a 404`, msg(r));
  }
  r = await req('GET', `/device-groups?businessId=${B.id}`, S.ownerA);
  check(r.status === 403, 'Business A cannot ask for B’s groups', msg(r));

  section('Group membership via bulk: same business only, reasons per computer');
  const fake = `ffff${randomBytes(8).toString('hex')}`;
  r = await bulk(S.ownerA, { action: 'group.add', groupId: gA.id, endpointIds: [a1.id, a2.id, b1.id, fake] });
  let m = byId(r);
  check(r.status === 200 && r.data.succeeded === 2 && r.data.refused === 2, 'owner adds A1, A2; B1 and a made-up id are refused', msg(r));
  check(m.get(b1.id)?.code === 'NOT_FOUND' && m.get(b1.id)?.name === undefined && m.get(fake)?.code === 'NOT_FOUND', 'another business’s computer is NOT_FOUND, with no name — the same as a made-up id', JSON.stringify(m.get(b1.id)));
  r = await bulk(S.admin, { action: 'group.add', groupId: gA.id, endpointIds: [b1.id, b2.id] });
  m = byId(r);
  check(r.status === 200 && m.get(b1.id)?.code === 'OTHER_BUSINESS' && m.get(b2.id)?.code === 'OTHER_BUSINESS', 'even the Platform Admin cannot put a B computer in an A group (OTHER_BUSINESS)', msg(r));
  check((await prisma.endpoint.count({ where: { id: { in: [b1.id, b2.id] }, endpointGroupId: { not: null } } })) === 0, 'and B’s computers are in no group');
  r = await bulk(S.ownerB, { action: 'group.add', groupId: gA.id, endpointIds: [b1.id] });
  check(r.status === 404, 'Business B naming A’s group: 404 for the whole request', msg(r));
  r = await bulk(S.userA, { action: 'group.add', groupId: gA.id, endpointIds: [a5.id] });
  check(r.status === 200 && byId(r).get(a5.id)?.code === 'NOT_ALLOWED', 'a Business User’s membership change is refused per computer (NOT_ALLOWED)', msg(r));
  r = await bulk(S.techNamed, { action: 'group.add', groupId: gA.id, endpointIds: [a1.id] });
  check(r.status === 200 && byId(r).get(a1.id)?.code === 'NOT_ALLOWED', 'so is a named-computer technician’s');
  r = await bulk(S.ownerA, { action: 'group.add', groupId: gA.id, endpointIds: [a1.id] });
  check(r.status === 200 && byId(r).get(a1.id)?.ok && byId(r).get(a1.id)?.unchanged, 'adding again is safe: ok, unchanged');
  r = await bulk(S.techWhole, { action: 'group.add', groupId: gA2.id, endpointIds: [a1.id, a3.id] });
  m = byId(r);
  check(m.get(a1.id)?.code === 'IN_OTHER_GROUP' && /Front desk/.test(m.get(a1.id)?.reason ?? '') && m.get(a3.id)?.ok, 'a computer is in one group at a time: IN_OTHER_GROUP names the other; A3 goes in', msg(r));
  r = await list(S.ownerA, { groupId: gA.id });
  check(r.status === 200 && r.data.total === 2 && ids(r).sort().join() === [a1.id, a2.id].sort().join() && r.data.rows[0].group?.id === gA.id, 'the group filter lists exactly its members, each row naming the group', msg(r));
  check(r.data.facets.groups?.some((g) => g.id === gA.id && g.count === 2), 'and the facets offer it with its count');
  r = await list(S.ownerB, { groupId: gA.id });
  check(r.status === 200 && r.data.total === 0, 'Business B filtering on A’s group finds nothing (the filter never widens)');
  r = await list(S.techNamed, { groupId: gA.id });
  check(r.status === 200 && r.data.total === 1 && ids(r)[0] === a1.id, 'a technician limited to A1 sees only A1 of that group');
  r = await req('GET', '/device-groups', S.techNamed);
  check(r.data?.groups?.find((g) => g.id === gA.id)?.members === 1, 'and the group list counts only the members they can see', JSON.stringify(r.data?.groups));
  r = await bulk(S.ownerA, { action: 'group.remove', groupId: gA.id, endpointIds: [a2.id, a5.id] });
  m = byId(r);
  check(m.get(a2.id)?.ok && !m.get(a2.id)?.unchanged && m.get(a5.id)?.ok && m.get(a5.id)?.unchanged, 'remove: A2 leaves; A5 was never in it (ok, unchanged)', msg(r));
  const memberAudit = await prisma.activityLog.findMany({ where: { action: 'DEVICE_GROUP_MEMBERS_CHANGED', resourceId: gA.id }, orderBy: { createdAt: 'asc' } });
  check(memberAudit.length === 2 && memberAudit[0].customerId === A.id && memberAudit[0].metadata.op === 'add' && memberAudit[0].metadata.endpointIds.length === 2 && memberAudit[1].metadata.op === 'remove' && memberAudit[1].metadata.endpointIds[0] === a2.id,
    'membership changes are audited: who, which group, which computers — and only real changes', JSON.stringify(memberAudit.map((x) => x.metadata)));

  r = await req('POST', '/endpoints', S.ownerA, { body: { name: `${TAG}-sneaky`, endpointGroupId: gB.id } });
  check(r.status === 400, 'creating a computer in another business’s group is refused (it was stored unchecked before 0.33)', msg(r));
  r = await req('POST', '/enrollment/tokens', S.ownerA, { body: { businessId: A.id, endpointGroupId: gB.id } });
  check(r.status === 400, 'so is an enrolment token naming another business’s group', msg(r));
  r = await req('POST', '/enrollment/tokens', S.ownerA, { body: { businessId: A.id, endpointGroupId: gA.id } });
  check(r.status === 200 || r.status === 201, 'and a token naming its own business’s group is accepted', msg(r));
  r = await req('POST', '/device-views', S.ownerA, { body: { name: 'x', shared: true, filters: { groupId: gB.id } } });
  check(r.status === 400 && code(r) === 'VIEW_SCOPE', 'a shared view cannot filter on another business’s group');

  r = await req('PATCH', `/device-groups/${gA.id}`, S.ownerA, { body: { name: `${TAG} Reception` } });
  check(r.status === 200 && r.data.name === `${TAG} Reception`, 'rename', msg(r));
  r = await req('PATCH', `/device-groups/${gA.id}`, S.userA, { body: { name: 'x' } });
  check(r.status === 403, 'a Business User cannot rename');
  r = await req('DELETE', `/device-groups/${gA2.id}`, S.techWhole);
  check(r.status === 200 && r.data.membersReleased === 1 && !(await prisma.endpoint.findUnique({ where: { id: a3.id } })).endpointGroupId, 'delete releases its members', msg(r));
  const delAudit = await prisma.activityLog.findFirst({ where: { action: 'DEVICE_GROUP_DELETED', resourceId: gA2.id } });
  check(delAudit?.customerId === A.id && delAudit.metadata.membersReleased === 1 && delAudit.metadata.viaTechnicianAssignment === true, 'deletion is audited, marked as via an assignment');
  check(!!(await prisma.activityLog.findFirst({ where: { action: 'DEVICE_GROUP_UPDATED', resourceId: gA.id } })), 'rename is audited');

  // ── Bulk refresh ──────────────────────────────────────────────────────────
  section('Bulk refresh: the single route’s checks, per computer');
  const cmdsBefore = await prisma.endpointCommand.count({ where: { endpointId: a1.id } });
  r = await bulk(S.ownerA, { action: 'inventory.refresh', endpointIds: [a1.id, a8.id, a6.id, b1.id] });
  m = byId(r);
  check(r.status === 200 && m.get(a1.id)?.ok && m.get(a6.id)?.ok && m.get(a8.id)?.code === 'ARCHIVED' && m.get(b1.id)?.code === 'NOT_FOUND', 'owner: A1, A6 queued; archived A8 refused; B1 not found', msg(r));
  check(await prisma.endpointCommand.count({ where: { endpointId: a1.id } }) === cmdsBefore + 2 && await prisma.endpointCommand.count({ where: { endpointId: b1.id } }) === 0, 'A1 got INVENTORY_REFRESH + UPDATE_SCAN; B1 got nothing');
  check(await auditCount({ action: 'ENDPOINT_INVENTORY_REFRESH_REQUESTED', resourceId: a1.id, actorId: ownerA.id }) === 1, 'the single action’s own audit entry is written per computer');
  r = await bulk(S.userA, { action: 'inventory.refresh', endpointIds: [a5.id, a6.id] });
  m = byId(r);
  check(m.get(a5.id)?.ok && m.get(a6.id)?.code === 'NOT_FOUND', 'Business User: granted A5 queued; ungranted A6 NOT_FOUND', msg(r));
  r = await bulk(S.techNamed, { action: 'inventory.refresh', endpointIds: [a1.id, a2.id] });
  m = byId(r);
  check(m.get(a1.id)?.ok && m.get(a2.id)?.code === 'NOT_FOUND', 'technician limited to A1: A1 queued, A2 NOT_FOUND', msg(r));

  section('Bulk refresh stops short of the fleet-abuse limit instead of tripping it');
  {
    const seenBefore = new Set((await prisma.privilegedActivity.findMany({ where: { identity: `user:${ownerA.id}` }, select: { endpointId: true } })).map((x) => x.endpointId));
    r = await bulk(S.ownerA, { action: 'inventory.refresh', endpointIds: [...fleet.map((e) => e.id), a2.id, a3.id] });
    const rs = r.data?.results ?? [];
    const okN = rs.filter((x) => x.ok).length, limited = rs.filter((x) => x.code === 'FLEET_LIMIT');
    const after = new Set((await prisma.privilegedActivity.findMany({ where: { identity: `user:${ownerA.id}` }, select: { endpointId: true } })).map((x) => x.endpointId));
    check(r.status === 200 && okN === 40 - seenBefore.size && limited.length === 42 - okN, `the member limit is 40 distinct computers: ${seenBefore.size} already used, ${okN} queued, ${limited.length} refused FLEET_LIMIT`, msg(r));
    check(after.size === 40 && /limit on distinct computers/.test(limited[0]?.reason ?? ''), 'exactly 40 distinct computers admitted, and the refusal says why', `${after.size}`);
    check(await prisma.identityPause.count({ where: { identity: `user:${ownerA.id}`, clearedAt: null } }) === 0, 'nobody is paused: the guard was never asked past its limit');
  }

  // ── Bulk client update ────────────────────────────────────────────────────
  section('Bulk client update: Platform Admin only, the one-click rules, containment');
  r = await bulk(S.ownerA, { action: 'client.update', endpointIds: [a1.id] });
  check(r.status === 200 && byId(r).get(a1.id)?.code === 'NOT_ALLOWED', 'an owner is refused per computer (the one-click update is a Platform Admin action)', msg(r));
  const pause = await prisma.containmentPause.create({ data: { scope: 'BUSINESS', customerId: B.id, kinds: ['updates'], reason: `${TAG}: suspected compromise`, setById: admin.id, setBy: 'msp' } });
  r = await bulk(S.admin, { action: 'client.update', endpointIds: [a1.id, a3.id, a4.id, a7.id, a8.id, b1.id, fake] });
  m = byId(r);
  check(r.status === 200 && m.get(a1.id)?.ok && !m.get(a1.id)?.unchanged, 'A1 (1.2.0) is queued', msg(r));
  check(m.get(a3.id)?.ok && m.get(a3.id)?.unchanged, 'A3 already on the target: ok, nothing queued');
  check(m.get(a4.id)?.code === 'NO_DEVICE_SECRET' && m.get(a7.id)?.code === 'NOT_WINDOWS' && m.get(a8.id)?.code === 'ARCHIVED', 'no device secret, Linux and archived are refused with the reason', JSON.stringify([m.get(a4.id), m.get(a7.id), m.get(a8.id)]));
  check(m.get(b1.id)?.code === 'CONTAINED' && /suspected compromise/.test(m.get(b1.id)?.reason ?? '') && m.get(fake)?.code === 'NOT_FOUND', 'B1, under an "updates" pause, is refused CONTAINED with the pause’s reason');
  const n1 = await prisma.rustdeskNode.findUnique({ where: { endpointId: a1.id } });
  const nOthers = await prisma.rustdeskNode.count({ where: { endpointId: { in: [a3.id, a4.id, a7.id, a8.id, b1.id] }, updateRequestedAt: { not: null } } });
  check(n1.updateRequestSource === 'MANUAL' && n1.updateTargetVersion === TARGET && n1.updateRequestedById === admin.id && nOthers === 0, 'the database agrees: only A1 is queued, MANUAL, at the pinned target');
  check(await auditCount({ action: 'ENDPOINT_UPDATED', resourceId: a1.id, actorId: admin.id }) === 1, 'the one-click path’s own audit entry is written');
  r = await bulk(S.admin, { action: 'client.update', endpointIds: [a1.id] });
  check(byId(r).get(a1.id)?.ok && byId(r).get(a1.id)?.unchanged, 'asking again is safe: already queued');
  await prisma.containmentPause.update({ where: { id: pause.id }, data: { clearedAt: new Date(), clearedById: admin.id, clearReason: 'test over' } });

  // ── Cap and closed set of actions ─────────────────────────────────────────
  section('The cap, and nothing but the four actions');
  const many = Array.from({ length: 201 }, (_, i) => `cap${String(i).padStart(5, '0')}${sfx}`);
  r = await bulk(S.ownerA, { action: 'inventory.refresh', endpointIds: many });
  check(r.status === 400 && code(r) === 'BULK_TOO_LARGE', '201 computers is refused with BULK_TOO_LARGE, before anything runs', msg(r));
  r = await bulk(S.ownerA, { action: 'group.add', groupId: gA.id, endpointIds: many.slice(0, 200) });
  check(r.status === 200 && r.data.requested === 200 && r.data.refused === 200, '200 is accepted (all made up: 200 NOT_FOUND)', msg(r));
  r = await req('POST', '/endpoints/bulk/export.csv', S.ownerA, { body: { endpointIds: many }, raw: true });
  check(r.status === 400, 'the selection export has the same cap', `HTTP ${r.status}`);
  for (const action of ['connect', 'archive', 'delete', 'restore', 'action.request', 'rotate-credential']) {
    r = await bulk(S.admin, { action, endpointIds: [a1.id] });
    check(r.status === 400, `no bulk "${action}"`, msg(r));
  }
  r = await bulk(S.ownerA, { action: 'inventory.refresh', endpointIds: [] });
  check(r.status === 400, 'an empty selection is refused');
  r = await bulk(S.ownerA, { action: 'inventory.refresh', groupId: gA.id, endpointIds: [a1.id] });
  check(r.status === 400, 'groupId on a non-group action is refused');

  // ── Export selection ──────────────────────────────────────────────────────
  section('Exporting the selection goes through the audited device-list export');
  const exBefore = await auditCount({ action: 'ENDPOINT_LIST_EXPORTED', actorId: ownerA.id });
  r = await req('POST', '/endpoints/bulk/export.csv', S.ownerA, { body: { endpointIds: [a1.id, a8.id, b1.id] }, raw: true });
  const lines = (r.text ?? '').replace(/^\uFEFF/, '').trim().split(/\r\n/);
  check(r.status === 200 && lines.length === 3 && r.headers.get('x-rows') === '2' && r.headers.get('x-not-exported') === '1', 'A1 and archived A8 are exported; B1 is not (X-Not-Exported: 1)', `HTTP ${r.status} lines ${lines.length} rows ${r.headers.get('x-rows')}`);
  check(!r.text.includes(b1.name) && lines[0].includes('"Group"') && lines.some((l) => l.includes(`${TAG} Reception`)), 'no trace of B1; the Group column carries A1’s group');
  const exAudit = await prisma.activityLog.findFirst({ where: { action: 'ENDPOINT_LIST_EXPORTED', actorId: ownerA.id }, orderBy: { createdAt: 'desc' } });
  check(await auditCount({ action: 'ENDPOINT_LIST_EXPORTED', actorId: ownerA.id }) === exBefore + 1 && exAudit.customerId === A.id && exAudit.metadata.rows === 2 && exAudit.metadata.selection?.requested === 3,
    'audited as ENDPOINT_LIST_EXPORTED with the selection', JSON.stringify(exAudit?.metadata));
  r = await req('POST', '/endpoints/bulk/export.csv', S.userA, { body: { endpointIds: [a5.id, a6.id] }, raw: true });
  check(r.status === 200 && r.headers.get('x-rows') === '1' && !r.text.includes(a6.name), 'a Business User exports only what they can see');

  // ── Bulk audit ────────────────────────────────────────────────────────────
  section('Every bulk request is audited, once per business it touched');
  const bulkA = await prisma.activityLog.findMany({ where: { action: 'DEVICE_BULK_ACTION', actorId: ownerA.id } });
  check(bulkA.length >= 6 && bulkA.every((x) => x.customerId === A.id), `owner A's bulk requests are audited against A (${bulkA.length})`);
  const refreshAudit = bulkA.find((x) => x.metadata.action === 'inventory.refresh' && x.metadata.requested === 4);
  check(refreshAudit && refreshAudit.metadata.notFound === 1 && refreshAudit.metadata.refused.ARCHIVED === 1 && refreshAudit.metadata.succeeded.length === 2, 'with what was asked, what succeeded and why the rest was refused', JSON.stringify(refreshAudit?.metadata));
  const adminUpd = await prisma.activityLog.findMany({ where: { action: 'DEVICE_BULK_ACTION', actorId: admin.id, metadata: { path: ['action'], equals: 'client.update' } } });
  check(adminUpd.some((x) => x.customerId === A.id) && adminUpd.some((x) => x.customerId === B.id && x.metadata.refused.CONTAINED === 1), 'the admin’s mixed request has an entry for A and one for B (with its CONTAINED refusal)');
  check(await auditCount({ action: 'DEVICE_BULK_ACTION', customerId: B.id, actorId: ownerA.id }) === 0, 'nothing owner A did is recorded against B');
}

async function cleanup() {
  await stopApi();
  try {
    const ids = created.businesses;
    const eps = (await prisma.endpoint.findMany({ where: { customerId: { in: ids } }, select: { id: true } })).map((e) => e.id);
    const idents = created.users.map((u) => `user:${u}`);
    await prisma.privilegedActivity.deleteMany({ where: { identity: { in: idents } } });
    await prisma.identityPause.deleteMany({ where: { identity: { in: idents } } });
    await prisma.containmentPause.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.deviceClaimToken.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.technicianAssignment.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.savedView.deleteMany({ where: { OR: [{ customerId: { in: ids } }, { userId: { in: created.users } }] } });
    await prisma.endpointCommand.deleteMany({ where: { endpointId: { in: eps } } });
    await prisma.computerAccess.deleteMany({ where: { endpointId: { in: eps } } });
    await prisma.rustdeskNode.deleteMany({ where: { endpointId: { in: eps } } });
    await prisma.endpoint.deleteMany({ where: { OR: [{ id: { in: eps } }, { name: `${TAG}-sneaky` }] } });
    await prisma.endpointGroup.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.site.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.membership.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.customer.deleteMany({ where: { id: { in: ids } } });
    if (created.users.length) await prisma.user.deleteMany({ where: { id: { in: created.users } } });
    if (originalPin !== undefined) await prisma.platformSettings.update({ where: { id: 'singleton' }, data: { rustdeskPinnedVersion: originalPin } }).catch(() => {});
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
