#!/usr/bin/env node
/**
 * End-to-end proof of the device list (0.31): GET /endpoints/list and
 * GET /endpoints/list/export.csv.
 *
 *   - filters (site, online/offline, alerts, restart pending, agent type,
 *     status), search, every sort key, and pagination behave as documented;
 *   - business isolation: a Business A owner, a Business A user and an
 *     A-only technician get nothing from Business B through ANY filter,
 *     search, sort, page or export parameter — and the same parameters
 *     DO find Business B's rows for the Platform Admin, so the absence is the
 *     scoping and not a filter that matches nothing (the negative control);
 *   - a Business User sees only assigned / COMPANY_WIDE computers; a
 *     technician restricted to named computers sees only those;
 *   - alerts need monitoring:alerts: without it rows carry `alerts: null` and
 *     filtering or sorting by alerts is refused;
 *   - stale resource samples and update scans are flagged as stale;
 *   - export needs computers:view, is audited, and neutralises CSV formulas.
 *
 * Self-starting: it runs its own API from dist/ on DEVLIST_API_PORT (3221)
 * against DATABASE_URL, which must name a scratch/test database. Fixtures are
 * namespaced and removed at the end.
 *
 * Run:  DATABASE_URL=…/rem0te_list_test node scripts/e2e-device-list.mjs
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, URLSearchParams } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const DB = process.env.DATABASE_URL ?? '';
const dbName = DB.split('/').pop()?.split('?')[0] ?? '';
if (!/scratch|test/.test(dbName)) { console.error(`Refusing to run against database "${dbName}": name must contain "scratch" or "test".`); process.exit(2); }
const PORT = Number(process.env.DEVLIST_API_PORT ?? 3221);
if ([3000, 3001, 443].includes(PORT)) { console.error(`Refusing port ${PORT}: that is a production port.`); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'device-list-e2e-password-1';
const TAG = `DL${sfx}`;

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
  HBBS_PRESENCE_HOST: '127.0.0.2', MONITOR_SWEEP: 'off', AUDIT_SEALER: 'off',
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

async function req(p, s, { business, raw = false } = {}) {
  // A fresh address per request: the suite makes hundreds, and the global
  // throttler (20/s, 300/min) is keyed by client address.
  const h = { 'x-forwarded-for': ip() };
  if (s) h.cookie = s.cookie;
  if (business) h['x-rem0te-business'] = business;
  const r = await fetch(`${API}${p}`, { headers: h });
  const text = await r.text();
  if (raw) return { status: r.status, text, headers: r.headers };
  let j; try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j, data: j?.data };
}
async function login(email) {
  const s = { ip: ip() };
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': s.ip }, body: JSON.stringify({ email, password: PW }) });
  const mm = (r.headers.get('set-cookie') ?? '').match(/access_token=([^;]+)/);
  if (r.status !== 200 || !mm) throw new Error(`login ${email}: ${r.status} ${await r.text()}`);
  s.cookie = `access_token=${mm[1]}`;
  return s;
}
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString();
const list = (s, params = {}, opts) => req(`/endpoints/list?${qs(params)}`, s, opts);
const exportCsv = (s, params = {}, opts) => req(`/endpoints/list/export.csv?${qs(params)}`, s, { ...opts, raw: true });
const msg = (r) => `HTTP ${r.status} ${JSON.stringify(r.body ?? r.text).slice(0, 300)}`;

const created = { businesses: [], users: [] };

async function all() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });
  const roleUser = await prisma.role.findFirst({ where: { type: 'BUSINESS_USER' } });

  section('Fixtures (synthetic): Business A (two sites, 70 computers) and Business B (shares every searchable word)');
  const A = await prisma.customer.create({ data: { tenantId: tenant.id, name: `${TAG} Acme` } });
  const B = await prisma.customer.create({ data: { tenantId: tenant.id, name: `${TAG} Birch` } });
  created.businesses.push(A.id, B.id);
  const siteA = await prisma.site.create({ data: { tenantId: tenant.id, customerId: A.id, name: `${TAG} HQ` } });
  const siteA2 = await prisma.site.create({ data: { tenantId: tenant.id, customerId: A.id, name: `${TAG} Depot` } });
  const siteB = await prisma.site.create({ data: { tenantId: tenant.id, customerId: B.id, name: `${TAG} HQ` } });

  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag, extra = {}) => { const u = await prisma.user.create({ data: { email: `dl-${tag}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'DL', lastName: tag, status: 'ACTIVE', ...extra } }); created.users.push(u.id); return u; };
  const admin = await mkUser('admin', { isPlatformAdmin: true });
  const ownerA = await mkUser('owner-a'), ownerB = await mkUser('owner-b');
  const userA = await mkUser('user-a'), noView = await mkUser('noview-a');
  const techA = await mkUser('tech-a'), techOne = await mkUser('tech-one');
  await prisma.membership.create({ data: { userId: ownerA.id, tenantId: tenant.id, customerId: A.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: ownerB.id, tenantId: tenant.id, customerId: B.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: userA.id, tenantId: tenant.id, customerId: A.id, roleId: roleUser.id, capabilities: ['computers:view'] } });
  await prisma.membership.create({ data: { userId: noView.id, tenantId: tenant.id, customerId: A.id, roleId: roleUser.id, capabilities: ['computers:connect'] } });

  const now = Date.now();
  const mkEp = async (biz, name, { site = null, online = true, ago = 60_000, channel = null, agentVersion = '0.30.1', mode = 'COMPANY_WIDE', status = 'ACTIVE', inv = null } = {}) => {
    const e = await prisma.endpoint.create({ data: {
      tenantId: tenant.id, customerId: biz.id, siteId: site?.id ?? null, name, hostname: name.toLowerCase(), platform: 'Windows',
      osVersion: 'Windows 11 Pro', status, isOnline: online, isManaged: true, accessMode: mode, lastSeenAt: new Date(now - ago),
      updateChannel: channel, agentVersion, deviceClass: 'WORKSTATION',
    } });
    await prisma.rustdeskNode.create({ data: { tenantId: tenant.id, endpointId: e.id, rustdeskId: String(100000000 + ((Math.random() * 899999999) | 0)) } });
    if (inv) await prisma.endpointInventory.create({ data: { endpointId: e.id, ...inv } });
    return e;
  };
  const fresh = (cpu, memFree, diskFree) => ({ cpuLoadPercent: cpu, memoryTotalMb: 16000, memoryFreeMb: memFree, systemDiskTotalMb: 500000, systemDiskFreeMb: diskFree, liveSampledAt: new Date(now - 60_000), loggedOnUser: `ACME\\${TAG}-shared-user` });
  let alertN = 0;
  const mkAlert = (biz, ep, severity, state = 'OPEN') => prisma.monitorAlert.create({ data: {
    tenantId: tenant.id, customerId: biz.id, endpointId: ep.id, ruleKey: `dl-${++alertN}`, kind: 'DISK_FREE', dedupKey: `dl:${sfx}:${alertN}`,
    severity, state, title: `${TAG} test alert`, detail: {},
  } });

  // Business A — named so the checks can tell them apart.
  const a1 = await mkEp(A, `${TAG}-SHARED-A1`, { site: siteA, channel: 'signed', inv: { ...fresh(91, 2000, 50000), patchPosture: { updates: [{}, {}, {}], reboot: { pending: true } }, patchScannedAt: new Date(now - 3600_000) } });
  const a2 = await mkEp(A, `${TAG}-SHARED-A2`, { site: siteA, inv: { ...fresh(10, 12000, 400000), pendingUpdates: [{ title: 'x', kb: 'KB1', severity: null }], pendingUpdateCount: 1, rebootRequired: false, updatesCheckedAt: new Date(now - 72 * 3600_000) } });
  const aOff = await mkEp(A, `${TAG}-SHARED-A3-OFF`, { site: siteA2, online: false, ago: 5 * 86400_000, agentVersion: null, inv: { ...fresh(50, 8000, 250000), liveSampledAt: new Date(now - 5 * 86400_000) } });
  const aArch = await mkEp(A, `${TAG}-SHARED-A4-ARCHIVED`, { status: 'ARCHIVED', online: false });
  const aAssigned = await mkEp(A, `${TAG}-SHARED-A5-ASSIGNED`, { mode: 'ASSIGNED_USERS' });
  const aHidden = await mkEp(A, `${TAG}-SHARED-A6-NOT-GRANTED`, { mode: 'ASSIGNED_USERS' });
  const aFormula = await mkEp(A, `=HYPERLINK("http://x.example.com","${TAG}")`, { online: false });
  await prisma.computerAccess.create({ data: { tenantId: tenant.id, endpointId: aAssigned.id, userId: userA.id } });
  const bulk = [];
  for (let i = 0; i < 63; i++) bulk.push(await mkEp(A, `${TAG}-bulk-${String(i).padStart(2, '0')}`, { site: i % 2 ? siteA2 : siteA, online: i % 3 !== 0, ago: (i + 1) * 60_000 }));
  await mkAlert(A, a1, 'CRITICAL');
  await mkAlert(A, a1, 'INFO', 'ACKNOWLEDGED');
  await mkAlert(A, a2, 'WARNING');
  await prisma.monitorAlert.create({ data: { tenantId: tenant.id, customerId: A.id, endpointId: aOff.id, ruleKey: 'offline', kind: 'OFFLINE', dedupKey: `dl:${sfx}:resolved`, severity: 'CRITICAL', state: 'RESOLVED', resolvedAt: new Date(), title: 'resolved', detail: {} } });

  // Business B — every property a filter or search could select on, and more of it.
  const b1 = await mkEp(B, `${TAG}-SHARED-B1`, { site: siteB, channel: 'signed', inv: { ...fresh(99, 100, 1000), patchPosture: { updates: [{}, {}, {}, {}, {}, {}, {}, {}, {}], reboot: { pending: true } }, patchScannedAt: new Date(now - 60_000) } });
  const b2 = await mkEp(B, `${TAG}-SHARED-B2-OFF`, { site: siteB, online: false, agentVersion: null });
  const b3 = await mkEp(B, `${TAG}-SHARED-B3`, { inv: { ...fresh(98, 100, 1000), rebootRequired: true, updatesCheckedAt: new Date(now - 60_000), pendingUpdateCount: 40 } });
  for (let i = 0; i < 5; i++) await mkAlert(B, b1, i ? 'WARNING' : 'CRITICAL');
  await prisma.monitorAlert.create({ data: { tenantId: tenant.id, customerId: B.id, endpointId: b3.id, ruleKey: 'x', kind: 'DISK_FREE', dedupKey: `dl:${sfx}:b3`, severity: 'CRITICAL', title: 'b', detail: {} } });
  const bIds = new Set([b1.id, b2.id, b3.id]);
  const bNames = [b1.name, b2.name, b3.name, B.name];

  // Technicians: one for all of A (view only), one for a1 alone (view + alerts).
  await prisma.technicianAssignment.create({ data: { tenantId: tenant.id, customerId: A.id, userId: techA.id, capabilities: ['computers:view'], endpointIds: [] } });
  await prisma.technicianAssignment.create({ data: { tenantId: tenant.id, customerId: A.id, userId: techOne.id, capabilities: ['computers:view', 'monitoring:alerts'], endpointIds: [a1.id] } });

  const aVisibleOwner = 6 + 63; // a1 a2 aOff aAssigned aHidden aFormula + bulk (the archived one is not current)
  check(true, `created A (${aVisibleOwner} current + 1 archived), B (3), 7 users, 2 technician assignments`);

  startApi();
  await waitUp();
  const S = {
    admin: await login(admin.email), ownerA: await login(ownerA.email), ownerB: await login(ownerB.email),
    userA: await login(userA.email), noView: await login(noView.email), techA: await login(techA.email), techOne: await login(techOne.email),
  };

  // ── Basic shape, default order, pagination ─────────────────────────────────
  section('Owner A: default view, online first, server-side pages');
  let r = await list(S.ownerA, { pageSize: 25 });
  check(r.status === 200 && r.data.total === aVisibleOwner, `total is A's ${aVisibleOwner} current computers`, msg(r));
  check(r.data.rows.length === 25 && r.data.pages === Math.ceil(aVisibleOwner / 25), 'pageSize 25 → 25 rows and the right page count', `rows ${r.data?.rows?.length} pages ${r.data?.pages}`);
  check(r.data.sort === 'online' && r.data.dir === 'asc', 'default sort is online first');
  {
    const all = [];
    for (let p = 1; p <= r.data.pages; p++) all.push(...(await list(S.ownerA, { pageSize: 25, page: p })).data.rows);
    const ids = all.map((x) => x.id);
    check(ids.length === aVisibleOwner && new Set(ids).size === aVisibleOwner, 'walking every page yields each computer once', `${ids.length} rows, ${new Set(ids).size} distinct`);
    const firstOffline = all.findIndex((x) => !x.isOnline);
    check(firstOffline > 0 && all.slice(firstOffline).every((x) => !x.isOnline), 'every online computer comes before every offline one');
    // 0.35: reachable splits in two — agent checking in first, then agent silent — each in name order.
    const reach = all.slice(0, firstOffline);
    const firstSilent = reach.findIndex((x) => x.connectivity === 'agent_silent');
    const onl = reach.slice(0, firstSilent < 0 ? reach.length : firstSilent).map((x) => x.name.toLowerCase());
    const sil = firstSilent < 0 ? [] : reach.slice(firstSilent).map((x) => x.name.toLowerCase());
    check(firstSilent > 0 && reach.slice(0, firstSilent).every((x) => x.connectivity === 'online') && reach.slice(firstSilent).every((x) => x.connectivity === 'agent_silent'),
      'checking-in computers come before agent-silent ones (0.35)', JSON.stringify(reach.map((x) => x.connectivity)).slice(0, 300));
    check(onl.every((n, i) => i === 0 || onl[i - 1] <= n) && sil.every((n, i) => i === 0 || sil[i - 1] <= n), 'each in name order');
    check(!ids.includes(aArch.id), 'archived computers are not in the default view');
  }
  r = await list(S.ownerA, { pageSize: 25, page: 99 });
  check(r.status === 200 && r.data.page === r.data.pages && r.data.rows.length > 0, 'a page past the end returns the last real page');
  r = await list(S.ownerA, { pageSize: 13 });
  check(r.data.pageSize === 50, 'an unsupported pageSize falls back to 50');
  for (const bad of [{ sort: 'password' }, { dir: 'sideways' }, { online: 'maybe' }, { agent: 'root' }, { restartPending: 'yes' }, { status: 'deleted' }, { alerts: 'all-of-them' }]) {
    r = await list(S.ownerA, bad);
    check(r.status === 400, `unknown value is a 400, not a wider view: ${JSON.stringify(bad)}`, msg(r));
  }

  section('Row content: business, site, agent, user, resources with age, patches, alerts');
  r = await list(S.ownerA, { search: `${TAG}-SHARED-A1` });
  const row1 = r.data.rows[0];
  check(r.data.total === 1 && row1.id === a1.id, 'search finds A1 by name');
  check(row1.business?.id === A.id && row1.site?.id === siteA.id, 'business and site are on the row');
  check(row1.agent.type === 'signed' && row1.agent.lastHeartbeatAt, 'agent: signed, with its last heartbeat');
  check(row1.loggedOnUser === `ACME\\${TAG}-shared-user`, 'logged-in user from the live sample');
  check(row1.resources && row1.resources.stale === false && row1.resources.cpuPercent === 91 && row1.resources.memoryUsedPercent === 88 && row1.resources.diskUsedPercent === 90, 'CPU / memory / disk from a fresh sample, not stale', JSON.stringify(row1.resources));
  check(row1.patches.source === 'signed_agent_scan' && row1.patches.pendingCount === 3 && row1.patches.rebootPending === true && row1.patches.stale === false, 'patches from the signed scan: 3 pending, restart pending, fresh', JSON.stringify(row1.patches));
  check(row1.alerts?.open === 2 && row1.alerts.worst === 'CRITICAL', 'two open alerts (open + acknowledged), worst CRITICAL; the resolved one is not counted', JSON.stringify(row1.alerts));
  check(!('rustdeskNode' in row1) && !('rustdeskId' in row1) && !JSON.stringify(row1).includes('permanentPassword'), 'no RustDesk ID or credential field on the row');
  r = await list(S.ownerA, { search: `${TAG}-SHARED-A2` });
  check(r.data.rows[0].patches.source === 'standard_agent_scan' && r.data.rows[0].patches.pendingCount === 1 && r.data.rows[0].patches.stale === true, 'a 72-hour-old standard scan is flagged stale', JSON.stringify(r.data.rows[0].patches));
  check(r.data.rows[0].agent.type === 'standard', 'agent: standard (version reported, not signed)');
  r = await list(S.ownerA, { search: `${TAG}-SHARED-A3-OFF` });
  check(r.data.rows[0].resources?.stale === true && r.data.rows[0].agent.type === 'none', 'a five-day-old sample is stale; no version reported → agent none', JSON.stringify(r.data.rows[0].resources));
  r = await list(S.ownerA, { search: `${TAG}-shared-user` });
  check(r.data.total === 3, 'search matches the logged-in user', `total ${r.data.total}`);

  section('Filters');
  const ids = (x) => x.data.rows.map((y) => y.id);
  r = await list(S.ownerA, { online: 'offline', pageSize: 200 });
  check(r.data.rows.every((x) => !x.isOnline) && r.data.total === 1 + 1 + 21, 'online=offline → only offline computers', `total ${r.data.total}`);
  r = await list(S.ownerA, { online: 'online', pageSize: 200 });
  // 0.35: online means the agent checked in within the window; the bulk computers reachable with a heartbeat older than 30 minutes are agent silent.
  const silentBulk = [...Array(63).keys()].filter((i) => i % 3 !== 0 && (i + 1) * 60_000 >= 30 * 60_000).length; // exactly 30 min at creation is past the window by the time it is read
  check(r.data.rows.every((x) => x.isOnline && x.connectivity === 'online') && r.data.total === aVisibleOwner - 23 - silentBulk, 'online=online → only computers whose agent is checking in', `total ${r.data.total}, want ${aVisibleOwner - 23 - silentBulk}`);
  r = await list(S.ownerA, { online: 'silent', pageSize: 200 });
  check(r.data.rows.every((x) => x.isOnline && x.connectivity === 'agent_silent') && r.data.total === silentBulk && !r.data.rows.some((x) => bIds.has(x.id)), 'online=silent → reachable with the agent silent, none of B\'s', `total ${r.data.total}, want ${silentBulk}`);
  r = await list(S.ownerA, { alerts: 'any' });
  check(r.data.total === 2 && ids(r).includes(a1.id) && ids(r).includes(a2.id), 'alerts=any → A1 and A2', JSON.stringify(ids(r)));
  r = await list(S.ownerA, { alerts: 'critical' });
  check(r.data?.total === 1 && ids(r)[0] === a1.id, 'alerts=critical → A1 only', msg(r));
  r = await list(S.ownerA, { restartPending: 'true' });
  check(r.data.total === 1 && ids(r)[0] === a1.id, 'restartPending=true → A1 only');
  r = await list(S.ownerA, { agent: 'signed' });
  check(r.data.total === 1 && ids(r)[0] === a1.id, 'agent=signed → A1 only');
  r = await list(S.ownerA, { agent: 'none' });
  check(r.data.total === 1 && ids(r)[0] === aOff.id, 'agent=none → the computer with no agent report');
  r = await list(S.ownerA, { siteId: siteA2.id, pageSize: 200 });
  check(r.data.rows.every((x) => x.site?.id === siteA2.id) && r.data.total === 1 + 31, 'siteId → only that site', `total ${r.data.total}`);
  r = await list(S.ownerA, { status: 'archived' });
  check(r.data.total === 1 && ids(r)[0] === aArch.id, 'status=archived → the archived computer');
  r = await list(S.ownerA, { siteId: siteA.id, online: 'online', alerts: 'any', agent: 'standard' });
  check(r.data.total === 1 && ids(r)[0] === a2.id, 'filters combine (AND)');
  check(r.data.facets.businesses.length === 1 && r.data.facets.businesses[0].id === A.id && r.data.facets.sites.map((s) => s.id).sort().join() === [siteA.id, siteA2.id].sort().join(), 'facets list only A and its two sites');

  section('Sorting (every key)');
  const SORTS = ['online', 'name', 'business', 'site', 'os', 'lastSeen', 'agent', 'user', 'cpu', 'memory', 'disk', 'patches', 'alerts', 'health'];
  for (const sort of SORTS) {
    const a = await list(S.ownerA, { sort, dir: 'asc', pageSize: 200 }), d = await list(S.ownerA, { sort, dir: 'desc', pageSize: 200 });
    check(a.status === 200 && d.status === 200 && a.data.total === aVisibleOwner && d.data.total === aVisibleOwner, `sort=${sort} asc/desc both return all ${aVisibleOwner}`, `${msg(a)} / ${msg(d)}`);
  }
  r = await list(S.ownerA, { sort: 'name', dir: 'asc', pageSize: 200 });
  {
    // The expected order comes from the database's own collation, not from
    // JavaScript's: CI's Postgres sorts with a locale collation that ignores
    // hyphens, so a byte comparison disagreed with a correct server there.
    const got = r.data.rows.map((x) => x.id);
    const want = (await prisma.$queryRawUnsafe(`SELECT id FROM "Endpoint" WHERE id = ANY($1::text[]) ORDER BY lower(name) ASC, id`, got)).map((x) => x.id);
    const gotNames = r.data.rows.map((x) => x.name.toLowerCase());
    const sameOrderByName = gotNames.every((v, i) => i === 0 || v === gotNames[i - 1] || want.indexOf(got[i - 1]) < want.indexOf(got[i]));
    check(sameOrderByName, 'sort=name asc is in name order (the database collation)', gotNames.slice(0, 8).join(', '));
  }
  r = await list(S.ownerA, { sort: 'cpu', dir: 'desc' });
  check(r.data.rows[0].id === a1.id && r.data.rows[1].id === aOff.id, 'sort=cpu desc → 91 % then 50 %, unsampled last');
  r = await list(S.ownerA, { sort: 'patches', dir: 'desc' });
  check(r.data.rows[0].id === a1.id && r.data.rows[1].id === a2.id, 'sort=patches desc → 3 pending, then 1');
  r = await list(S.ownerA, { sort: 'health', dir: 'desc' });
  check(r.data.rows[0].id === a1.id && r.data.rows[1].id === a2.id, 'sort=health desc → CRITICAL, then WARNING');
  r = await list(S.ownerA, { sort: 'lastSeen', dir: 'asc' });
  check(r.data.rows[0].id === aOff.id, 'sort=lastSeen asc → the five-days-silent computer first');

  // ── Isolation ─────────────────────────────────────────────────────────────
  section('Negative control: the Platform Admin, with the same parameters, DOES get Business B');
  const PROBES = [
    {}, { search: 'SHARED' }, { search: TAG }, { search: `${TAG}-SHARED-B1` }, { search: 'shared-user' }, { search: 'Birch' },
    { siteId: siteB.id }, { online: 'offline' }, { online: 'online' }, { alerts: 'any' }, { alerts: 'critical' },
    { restartPending: 'true' }, { agent: 'signed' }, { agent: 'none' }, { agent: 'standard' }, { status: 'all' },
    ...SORTS.flatMap((sort) => [{ sort, dir: 'desc' }, { sort, dir: 'asc' }]), { page: 2, pageSize: 25 }, { page: 3, pageSize: 25 },
  ];
  const ADMIN_FINDS_B = [{ search: 'SHARED' }, { search: `${TAG}-SHARED-B1` }, { search: 'Birch' }, { siteId: siteB.id }, { alerts: 'critical' }, { restartPending: 'true' }, { agent: 'signed' }, { agent: 'none' }];
  for (const p of ADMIN_FINDS_B) {
    r = await list(S.admin, { ...p, pageSize: 200 });
    check(r.status === 200 && r.data.rows.some((x) => bIds.has(x.id)), `admin ${JSON.stringify(p)} → includes Business B rows`, msg(r));
  }
  r = await list(S.admin, { businessId: B.id });
  check(r.status === 200 && r.data.total === 3 && r.data.rows.every((x) => bIds.has(x.id)), 'admin businessId=B → exactly B');
  const unscoped = await prisma.endpoint.count({ where: { name: { contains: `${TAG}-SHARED`, mode: 'insensitive' }, status: { not: 'ARCHIVED' } } });
  check(unscoped === 5 + 3, `the same search without scoping matches ${unscoped} rows in the database, B's three among them`);

  const leaks = (res) => {
    const rows = res.data?.rows ?? [];
    const f = res.data?.facets ?? { businesses: [], sites: [] };
    return rows.filter((x) => bIds.has(x.id) || x.business?.id === B.id).length
      + f.businesses.filter((b) => b.id === B.id).length + f.sites.filter((s) => s.id === siteB.id).length;
  };
  for (const who of ['ownerA', 'userA', 'techA']) {
    section(`Isolation: ${who} through every filter, search, sort and page`);
    let leaked = 0, refused = 0, errors = [];
    for (const p of PROBES) {
      const x = await list(S[who], { ...p, pageSize: p.pageSize ?? 200 });
      if (x.status === 403 && (p.alerts || p.sort === 'alerts' || p.sort === 'health') && who !== 'ownerA') { refused++; continue; }
      if (x.status !== 200) { errors.push(`${JSON.stringify(p)} → ${x.status}`); continue; }
      leaked += leaks(x);
    }
    check(leaked === 0 && errors.length === 0, `${PROBES.length} parameter sets: no Business B row, business or site in any response${refused ? ` (${refused} alert probes refused: no monitoring:alerts)` : ''}`, `leaked ${leaked}; ${errors.join('; ')}`);
    r = await list(S[who], { businessId: B.id });
    check(r.status === 403 && !JSON.stringify(r.body).includes(TAG + '-SHARED-B'), 'businessId=B is a 403 that names nothing of B', msg(r));
    r = await list(S[who], { businessId: B.id, siteId: siteB.id, search: 'SHARED' });
    check(r.status === 403, 'businessId=B combined with B site and search is still a 403', msg(r));
    r = await list(S[who], {}, { business: B.id });
    check(r.status === 403 || (r.status === 200 && leaks(r) === 0), 'asking to act in Business B by header widens nothing', msg(r));
    const csv = await exportCsv(S[who], { search: 'SHARED', siteId: who === 'techA' ? siteB.id : undefined });
    check(csv.status === 200 && !bNames.some((n) => csv.text.includes(n)), 'export of a search shared with B contains nothing of B', `HTTP ${csv.status}`);
    const csv2 = await exportCsv(S[who], { businessId: B.id });
    check(csv2.status === 403, 'export with businessId=B is a 403', `HTTP ${csv2.status}`);
  }
  {
    // Owner B, symmetrically, for good measure.
    const x = await list(S.ownerB, { search: 'SHARED', pageSize: 200 });
    check(x.status === 200 && x.data.total === 3 && x.data.rows.every((y) => bIds.has(y.id)), 'Owner B sees exactly its own three computers');
  }

  section('Who sees which of A');
  r = await list(S.userA, { search: `${TAG}-SHARED`, pageSize: 200 });
  check(ids(r).includes(aAssigned.id) && !ids(r).includes(aHidden.id), 'Business User: an assigned computer is listed, an ASSIGNED_USERS one not granted is not', JSON.stringify(r.data?.rows?.map((x) => x.name)));
  r = await list(S.userA, { search: `${TAG}-SHARED-A6` });
  check(r.status === 200 && r.data.total === 0, 'Business User: searching the ungranted computer by name finds nothing');
  // The older GET /endpoints (business page, pickers) applies the same rule
  // since 0.31: before, it scoped by business alone and listed the ungranted one.
  const old = await req(`/endpoints?search=${encodeURIComponent(`${TAG}-SHARED`)}&limit=200`, S.userA);
  const oldIds = (old.data?.endpoints ?? []).map((e) => e.id);
  check(old.status === 200 && oldIds.includes(aAssigned.id) && !oldIds.includes(aHidden.id), 'GET /endpoints: a Business User does not see an ASSIGNED_USERS computer granted only to others', JSON.stringify((old.data?.endpoints ?? []).map((e) => e.name)));
  const oldOwner = await req(`/endpoints?search=${encodeURIComponent(`${TAG}-SHARED`)}&limit=200`, S.ownerA);
  check((oldOwner.data?.endpoints ?? []).some((e) => e.id === aHidden.id), 'GET /endpoints: the owner still sees it (owners see the whole business)');
  // GET /endpoints/connected (online computers) had the same business-only scoping.
  const conn = await req('/endpoints/connected', S.userA);
  const connIds = (conn.data ?? []).map((e) => e.id);
  check(conn.status === 200 && connIds.includes(aAssigned.id) && !connIds.includes(aHidden.id), 'GET /endpoints/connected: a Business User sees the granted online computer, not the ungranted one', `status ${conn.status}`);
  r = await list(S.techOne, { pageSize: 200 });
  check(r.status === 200 && r.data.total === 1 && ids(r)[0] === a1.id, 'technician restricted to A1 sees only A1', `total ${r.data?.total}`);
  r = await list(S.techOne, { search: `${TAG}-SHARED-A2` });
  check(r.data.total === 0, 'restricted technician: searching another A computer finds nothing');
  r = await list(S.techA, { pageSize: 200 });
  check(r.status === 200 && r.data.total === aVisibleOwner, 'A-wide technician sees every current A computer');

  section('Alerts need monitoring:alerts');
  r = await list(S.userA, {});
  check(r.status === 200 && r.data.alertsVisible === false && r.data.rows.every((x) => x.alerts === null), 'without it: alertsVisible false and every row alerts: null');
  for (const p of [{ alerts: 'any' }, { alerts: 'critical' }, { sort: 'alerts' }, { sort: 'health' }]) {
    r = await list(S.userA, p);
    check(r.status === 403, `without it: ${JSON.stringify(p)} is refused`, msg(r));
  }
  {
    const csv = await exportCsv(S.userA, {});
    check(csv.status === 200 && !/Open alerts/.test(csv.text.split('\n')[0]), 'without it: the export has no alert columns');
  }
  r = await list(S.techOne, { alerts: 'critical' });
  check(r.status === 200 && r.data.total === 1 && r.data.rows[0].alerts?.worst === 'CRITICAL', 'technician with monitoring:alerts on A1 can filter by it');
  r = await list(S.techA, { sort: 'health' });
  check(r.status === 403, 'A-wide technician without monitoring:alerts cannot sort by health');
  await prisma.membership.updateMany({ where: { userId: userA.id }, data: { capabilities: ['computers:view', 'monitoring:alerts'] } });
  r = await list(S.userA, { alerts: 'any' });
  check(r.status === 200 && r.data.alertsVisible && ids(r).includes(a1.id), 'granting monitoring:alerts turns the alert filter on');

  section('CSV export');
  r = await list(S.noView, {});
  check(r.status === 403, 'without computers:view the list is a 403', msg(r));
  let csv = await exportCsv(S.noView, {});
  check(csv.status === 403, 'without computers:view the export is a 403', `HTTP ${csv.status}`);
  const before = await prisma.activityLog.count({ where: { action: 'ENDPOINT_LIST_EXPORTED', actorId: ownerA.id } });
  csv = await exportCsv(S.ownerA, { online: 'offline' });
  const lines = csv.text.replace(/^\uFEFF/, '').trim().split(/\r\n/);
  check(csv.status === 200 && /text\/csv/.test(csv.headers.get('content-type') ?? '') && /attachment; filename="devices-/.test(csv.headers.get('content-disposition') ?? ''), 'export is a CSV attachment');
  check(lines.length === 1 + 23 && lines[0].startsWith('"Name","Hostname","Business","Site"'), 'export has a header and one line per row of the filtered view (23 offline)', `lines ${lines.length}`);
  check(lines.some((l) => l.startsWith(`"'=HYPERLINK(`)) && !lines.some((l) => l.startsWith('"=')), 'a device-reported formula is neutralised with an apostrophe');
  const after = await prisma.activityLog.findMany({ where: { action: 'ENDPOINT_LIST_EXPORTED', actorId: ownerA.id }, orderBy: { createdAt: 'desc' } });
  check(after.length === before + 1 && after[0].customerId === A.id && after[0].metadata?.rows === 23 && after[0].metadata?.filters?.online === 'offline', 'export is audited: actor, business, row count and filters', JSON.stringify(after[0]?.metadata));
  csv = await exportCsv(S.techA, {});
  const techAudit = await prisma.activityLog.findFirst({ where: { action: 'ENDPOINT_LIST_EXPORTED', actorId: techA.id } });
  check(csv.status === 200 && techAudit?.customerId === A.id && techAudit.metadata?.viaTechnicianAssignment === true, 'a technician export is audited against business A, marked as via an assignment');
  csv = await exportCsv(S.admin, { search: 'SHARED' });
  check(csv.status === 200 && bNames.slice(0, 3).every((n) => csv.text.includes(n)), 'negative control: the admin export of the same search contains B');
}

async function cleanup() {
  await stopApi();
  try {
    const ids = created.businesses;
    await prisma.technicianAssignment.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.monitorAlert.deleteMany({ where: { customerId: { in: ids } } });
    const eps = await prisma.endpoint.findMany({ where: { customerId: { in: ids } }, select: { id: true } });
    await prisma.computerAccess.deleteMany({ where: { endpointId: { in: eps.map((e) => e.id) } } });
    await prisma.rustdeskNode.deleteMany({ where: { endpointId: { in: eps.map((e) => e.id) } } });
    await prisma.endpoint.deleteMany({ where: { id: { in: eps.map((e) => e.id) } } });
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
