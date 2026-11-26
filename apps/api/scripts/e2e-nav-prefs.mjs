#!/usr/bin/env node
/**
 * End-to-end proof of the 0.87 navigation state (§96): GET /me/navigation,
 * PUT /me/navigation/preferences, POST/DELETE /me/navigation/favorites,
 * POST /me/navigation/recent — and the two search groups 0.87 added to
 * GET /search (scripts, policies).
 *
 *   - preferences: the defaults, every field, the closed lists (an unknown
 *     mode, density or group, an extra field, too many groups: 400), pinned
 *     groups stored canonical, and a context customer the caller cannot see
 *     is a 404 (another business's owner), as is a made-up id;
 *   - favourites: one's own computer, customer, script and page are kept
 *     and named; another business's computer, customer or script is a 404
 *     (indistinguishable from a missing one) and nothing is stored; a page
 *     must be a console path (an external URL, `//host`, `..`, a query: 400);
 *     at most 50 (409 FAVORITES_FULL); someone else's favourite cannot be
 *     removed; adding twice keeps one row;
 *   - losing access hides: a computer moved out of a Business User's view
 *     drops out of their favourites and recent items on the next read, with
 *     the row kept, and comes back with the access;
 *   - recent items: newest first, at most 15, another business's record 404;
 *   - every row is the caller's own: two people's lists never mix;
 *   - nothing stored is a name: the rows hold only kind and ref;
 *   - not audited;
 *   - search: a script and a patch policy / automation schedule of Business B
 *     never reach Business A's owner, a Business A user or an A-only
 *     technician, by a shared word or by B's exact name, while the Platform
 *     Admin finds them (the negative control); a Business User without a
 *     library right gets `scripts: null`; without computers:view, `policies: null`.
 *
 * Self-starting: its own API from dist/ on NAV_API_PORT (4101) against
 * DATABASE_URL, which must name a scratch/test database. Fixtures are
 * namespaced and removed at the end.
 *
 * Run:  DATABASE_URL=…/rem0te_nav_scratch_test node scripts/e2e-nav-prefs.mjs
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const DB = process.env.DATABASE_URL ?? '';
const dbName = DB.split('/').pop()?.split('?')[0] ?? '';
if (!/scratch|test/.test(dbName)) { console.error(`Refusing to run against database "${dbName}": name must contain "scratch" or "test".`); process.exit(2); }
const PORT = Number(process.env.NAV_API_PORT ?? 4101);
if ([3000, 3001, 3201, 3202, 443, 4000, 4001].includes(PORT)) { console.error(`Refusing port ${PORT}: that is a production port.`); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'nav-e2e-password-1';
const TAG = `NV${sfx}`;

let pass = 0, fail = 0;
const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;
const hex32 = () => randomBytes(16).toString('hex');

const apiEnv = {
  ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATABASE_URL: DB,
  JWT_SECRET: randomBytes(32).toString('hex'), LAUNCHER_TOKEN_SECRET: randomBytes(32).toString('hex'),
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? randomBytes(32).toString('hex'), TRUSTED_PROXIES: 'loopback',
  HBBS_PRESENCE_HOST: '127.0.0.2', MONITOR_SWEEP: 'off', AUDIT_SEALER: 'off', CLIENT_UPDATE_SWEEP: 'off', PATCH_POLICY_SWEEP: 'off',
  AUTOMATION_SWEEP: 'off', RESTART_WINDOW_SWEEP: 'off', STALE_SWEEP: 'off', SNAPSHOT_SWEEP: 'off', AGENT_AUTO_UPDATE: 'off',
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

const seen = [];
async function call(s, method, p, body) {
  const h = { 'x-forwarded-for': ip() };
  if (s) h.cookie = s.cookie;
  if (body !== undefined) h['content-type'] = 'application/json';
  const r = await fetch(`${API}${p}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  seen.push(text);
  let j; try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j, data: j?.data, headers: r.headers };
}
const nav = (s) => call(s, 'GET', '/me/navigation');
const prefs = (s, b) => call(s, 'PUT', '/me/navigation/preferences', b);
const fav = (s, kind, ref) => call(s, 'POST', '/me/navigation/favorites', { kind, ref });
const unfav = (s, id) => call(s, 'DELETE', `/me/navigation/favorites/${encodeURIComponent(id)}`);
const visit = (s, kind, ref) => call(s, 'POST', '/me/navigation/recent', { kind, ref });
const search = (s, q) => call(s, 'GET', `/search?q=${encodeURIComponent(q)}`);
async function login(email) {
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip() }, body: JSON.stringify({ email, password: PW }) });
  const mm = (r.headers.get('set-cookie') ?? '').match(/access_token=([^;]+)/);
  if (r.status !== 200 || !mm) throw new Error(`login ${email}: ${r.status} ${await r.text()}`);
  return { cookie: `access_token=${mm[1]}` };
}
const msg = (r) => `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 400)}`;
const refs = (list) => (list ?? []).map((x) => `${x.kind}:${x.ref}`);

const created = { businesses: [], users: [] };

async function all() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });
  const roleUser = await prisma.role.findFirst({ where: { type: 'BUSINESS_USER' } });

  section('Fixtures (synthetic): Business A and Business B, sharing every name');
  const A = await prisma.customer.create({ data: { tenantId: tenant.id, name: `${TAG} Acme` } });
  const B = await prisma.customer.create({ data: { tenantId: tenant.id, name: `${TAG} Birch` } });
  created.businesses.push(A.id, B.id);
  const siteA = await prisma.site.create({ data: { tenantId: tenant.id, customerId: A.id, name: `${TAG} HQ` } });
  const siteB = await prisma.site.create({ data: { tenantId: tenant.id, customerId: B.id, name: `${TAG} HQ` } });
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag, extra = {}) => { const u = await prisma.user.create({ data: { email: `nv-${tag}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'NV', lastName: tag, status: 'ACTIVE', ...extra } }); created.users.push(u.id); return u; };
  const member = (u, biz, role, capabilities) => prisma.membership.create({ data: { userId: u.id, tenantId: tenant.id, customerId: biz.id, roleId: role.id, ...(capabilities ? { capabilities } : {}) } });
  const admin = await mkUser('admin', { isPlatformAdmin: true });
  const ownerA = await mkUser('owner-a'), ownerB = await mkUser('owner-b');
  const userA = await mkUser('user-a'), noView = await mkUser('noview-a'), techA = await mkUser('tech-a');
  await member(ownerA, A, roleOwner); await member(ownerB, B, roleOwner);
  await member(userA, A, roleUser, ['computers:view']);
  await member(noView, A, roleUser, ['computers:connect']);
  await prisma.technicianAssignment.create({ data: { tenantId: tenant.id, customerId: A.id, userId: techA.id, capabilities: ['computers:view', 'scripts:author'], endpointIds: [] } });

  const mkEp = (biz, name, mode = 'COMPANY_WIDE') => prisma.endpoint.create({ data: {
    tenantId: tenant.id, customerId: biz.id, name, hostname: `${name.toLowerCase()}.corp.example.com`, platform: 'Windows',
    status: 'ACTIVE', isOnline: true, isManaged: true, accessMode: mode, lastSeenAt: new Date(),
  } });
  const a1 = await mkEp(A, `${TAG}-SHARED-A1`);
  const b1 = await mkEp(B, `${TAG}-SHARED-B1`);
  const extra = [];
  for (let i = 0; i < 52; i++) extra.push(await mkEp(A, `${TAG}-bulk-${String(i).padStart(2, '0')}`));

  const mkScript = (biz, name) => prisma.script.create({ data: { scope: 'BUSINESS', tenantId: tenant.id, customerId: biz.id, name, createdById: admin.id } });
  const sA = await mkScript(A, `${TAG} cleanup temp`);
  const sB = await mkScript(B, `${TAG} cleanup temp`);
  const sBOnly = await mkScript(B, `${TAG}-BIRCH-ONLY-SCRIPT`);

  // Policies, written directly: search reads only name, business and the computers each one names.
  const doc = (biz, ep) => ({ businessId: biz.id, businessName: biz.name, rings: [[{ endpointId: ep.id, hostname: ep.name }]], expiry: 'never' });
  const mkPatch = (biz, ep, name) => prisma.patchPolicy.create({ data: {
    id: hex32(), tenantId: tenant.id, customerId: biz.id, name, document: doc(biz, ep), digest: hex32() + hex32(), approvalUrl: 'https://approver.example.com/x', createdById: admin.id,
  } });
  const mkSchedule = (biz, ep, name) => prisma.automationPolicy.create({ data: {
    id: hex32(), tenantId: tenant.id, customerId: biz.id, name, taskKind: 'script', document: { ...doc(biz, ep), targets: { kind: 'computers', computers: [{ endpointId: ep.id }] } },
    digest: hex32() + hex32(), approvalUrl: 'https://approver.example.com/x', createdById: admin.id,
  } });
  let policyFixtures = true;
  let pA, pB, pBOnly, aB;
  try {
    pA = await mkPatch(A, a1, `${TAG} monthly updates`);
    pB = await mkPatch(B, b1, `${TAG} monthly updates`);
    pBOnly = await mkPatch(B, b1, `${TAG}-BIRCH-ONLY-POLICY`);
    aB = await mkSchedule(B, b1, `${TAG}-BIRCH-ONLY-SCHEDULE`);
  } catch (e) {
    policyFixtures = false;
    check(false, 'policy fixtures could be written', String(e.message).slice(0, 300));
  }

  startApi();
  await waitUp();
  const S = {};
  for (const [k, u] of Object.entries({ admin, ownerA, ownerB, userA, noView, techA })) S[k] = await login(u.email);
  // The technician works in Business A (the business switcher's cookie).
  S.techA.cookie += `; rem0te_business=${A.id}`;
  const auditBefore = await prisma.activityLog.count({ where: { actorId: { in: created.users } } });

  // ── Preferences ───────────────────────────────────────────────────────────
  section('Preferences: defaults, every field, closed lists');
  let r = await call(null, 'GET', '/me/navigation');
  check(r.status === 401, 'unauthenticated is a 401', msg(r));
  r = await nav(S.ownerA);
  check(r.status === 200 && /no-store/.test(r.headers.get('cache-control') ?? ''), 'GET /me/navigation is 200, no-store', msg(r));
  check(JSON.stringify(r.data?.preferences) === JSON.stringify({ mode: 'standard', sidebarCollapsed: false, pinnedGroups: [], density: 'comfortable', workspace: 'all', contextBusiness: null }), 'defaults: Standard, expanded, nothing pinned, comfortable, every page, no customer', JSON.stringify(r.data?.preferences));
  check(r.data?.caps?.favorites === 50 && r.data?.caps?.recent === 15, 'caps are 50 favourites and 15 recent', JSON.stringify(r.data?.caps));
  r = await prefs(S.ownerA, { mode: 'advanced', sidebarCollapsed: true, pinnedGroups: ['security', 'devices', 'security'], density: 'compact' });
  check(r.status === 200 && r.data.preferences.mode === 'advanced' && r.data.preferences.sidebarCollapsed === true && r.data.preferences.density === 'compact', 'every field is saved', msg(r));
  check(JSON.stringify(r.data?.preferences?.pinnedGroups) === JSON.stringify(['devices', 'security']), 'pinned groups are stored distinct, in menu order', JSON.stringify(r.data?.preferences?.pinnedGroups));
  r = await prefs(S.ownerA, { sidebarCollapsed: false });
  check(r.status === 200 && r.data.preferences.mode === 'advanced' && r.data.preferences.sidebarCollapsed === false, 'a partial update keeps the other fields', msg(r));
  for (const [label, body] of [
    ['an unknown mode', { mode: 'expert' }], ['an unknown density', { density: 'tiny' }], ['an unknown group', { pinnedGroups: ['settings'] }],
    ['an extra field', { mode: 'standard', theme: 'dark' }], ['ten groups', { pinnedGroups: Array(10).fill('devices') }],
    ['a non-boolean collapsed', { sidebarCollapsed: 'yes' }], ['an unknown workspace', { workspace: 'l4' }], ['a workspace in capitals', { workspace: 'L1' }], ['a malformed customer id', { contextBusinessId: 'x' }], ['an array body', [1]],
  ]) {
    r = await prefs(S.ownerA, body);
    check(r.status === 400, `${label} is a 400`, msg(r));
  }

  section('Preferences: a technician workspace (0.90) is presentation only');
  for (const w of ['l1', 'l2', 'l3', 'all']) {
    r = await prefs(S.ownerA, { workspace: w });
    check(r.status === 200 && r.data.preferences.workspace === w && r.data.preferences.mode === 'advanced', `workspace ${w} is saved and keeps the other fields`, msg(r));
  }
  r = await prefs(S.userA, { workspace: 'l3' });
  check(r.status === 200 && r.data.preferences.workspace === 'l3', 'a Business User may choose the L3 workspace (it is only a menu)', msg(r));
  const before = await call(S.userA, 'GET', '/admin/update-trust');
  check(before.status === 403, 'and still may not open a Platform Admin route (GET /admin/update-trust)', msg(before));
  r = await nav(S.ownerA);
  check(r.data?.preferences?.workspace === 'all', 'one person\'s workspace is not another\'s', JSON.stringify(r.data?.preferences));
  r = await prefs(S.userA, { workspace: 'all' });

  section('Preferences: the context customer is checked against GET /businesses\' rule');
  r = await prefs(S.ownerA, { contextBusinessId: B.id });
  check(r.status === 404, 'Business A\'s owner naming Business B is a 404', msg(r));
  r = await prefs(S.ownerA, { contextBusinessId: 'c0000000000000000000000000' });
  check(r.status === 404, 'a made-up customer id is a 404 too', msg(r));
  r = await prefs(S.ownerA, { contextBusinessId: A.id });
  check(r.status === 200 && r.data.preferences.contextBusiness?.id === A.id && r.data.preferences.contextBusiness?.name === A.name, 'naming their own business is kept and named', msg(r));
  r = await prefs(S.admin, { contextBusinessId: B.id });
  check(r.status === 200 && r.data.preferences.contextBusiness?.id === B.id, 'a Platform Admin may keep any customer in view', msg(r));
  r = await prefs(S.admin, { contextBusinessId: null });
  check(r.status === 200 && r.data.preferences.contextBusiness === null, 'null clears it', msg(r));

  // ── Favourites ────────────────────────────────────────────────────────────
  section('Favourites: one\'s own records and pages');
  r = await fav(S.ownerA, 'device', a1.id);
  check(r.status === 201 || r.status === 200, 'Business A\'s owner adds their computer', msg(r));
  const f1 = r.data?.favorites?.find((f) => f.ref === a1.id);
  check(f1 && f1.title === a1.name && f1.href === `/endpoints/${a1.id}` && f1.detail === A.name, 'it is named, from the record, with its page', JSON.stringify(f1));
  r = await fav(S.ownerA, 'device', a1.id);
  check((r.status === 201 || r.status === 200) && r.data.favorites.filter((f) => f.ref === a1.id).length === 1, 'adding it twice keeps one', msg(r));
  r = await fav(S.ownerA, 'business', A.id);
  check((r.status === 201 || r.status === 200) && r.data.favorites.some((f) => f.kind === 'business' && f.ref === A.id && f.title === A.name), 'their own business', msg(r));
  r = await fav(S.ownerA, 'script', sA.id);
  check((r.status === 201 || r.status === 200) && r.data.favorites.some((f) => f.kind === 'script' && f.ref === sA.id && f.href === `/automation/scripts/${sA.id}`), 'their own script', msg(r));
  r = await fav(S.ownerA, 'site', siteA.id);
  check((r.status === 201 || r.status === 200) && r.data.favorites.some((f) => f.kind === 'site' && f.ref === siteA.id), 'their own site', msg(r));
  r = await fav(S.ownerA, 'page', '/settings/security/containment');
  check((r.status === 201 || r.status === 200) && r.data.favorites.some((f) => f.kind === 'page' && f.href === '/settings/security/containment' && f.title === null), 'a console page, returned as its path (the web names it)', msg(r));

  section('Favourites: another business\'s record is a 404 and nothing is stored');
  for (const [kind, ref, label] of [['device', b1.id, 'B\'s computer'], ['business', B.id, 'Business B'], ['script', sB.id, 'B\'s script'], ['site', siteB.id, 'B\'s site'], ['device', 'c0000000000000000000000000', 'a made-up computer']]) {
    r = await fav(S.ownerA, kind, ref);
    check(r.status === 404, `${label}: 404`, msg(r));
  }
  r = await fav(S.userA, 'business', B.id);
  check(r.status === 404, 'a Business A user naming Business B: 404', msg(r));
  r = await fav(S.techA, 'device', b1.id);
  check(r.status === 404, 'an A-only technician naming B\'s computer: 404', msg(r));
  const leaked = await prisma.userNavItem.count({ where: { userId: { in: [ownerA.id, userA.id, techA.id] }, ref: { in: [b1.id, B.id, sB.id, siteB.id] } } });
  check(leaked === 0, 'no row names a Business B record', String(leaked));

  section('Favourites: a page is a console path, never a URL');
  for (const ref of ['https://evil.example.com', '//evil.example.com', '/endpoints/../admin', '/endpoints?x=1', '/Endpoints', 'endpoints', '/a#b', 'javascript:alert(1)', `/${'a'.repeat(130)}`]) {
    r = await fav(S.ownerA, 'page', ref);
    check(r.status === 400, `page "${ref.slice(0, 40)}" is a 400`, msg(r));
  }
  for (const [kind, ref] of [['device', '../x'], ['device', 'a b c d e f g h'], ['user', a1.id], ['device', '']]) {
    r = await fav(S.ownerA, kind, ref);
    check(r.status === 400, `${kind} "${ref}" is a 400`, msg(r));
  }

  section('Favourites: at most 50');
  for (let i = 0; i < 50 - 5; i++) {
    r = await fav(S.ownerA, 'device', extra[i].id);
    if (r.status !== 201 && r.status !== 200) break;
  }
  r = await nav(S.ownerA);
  check(r.data?.favorites?.length === 50, '50 favourites are kept', String(r.data?.favorites?.length));
  r = await fav(S.ownerA, 'device', extra[51].id);
  check(r.status === 409 && r.body.code === 'FAVORITES_FULL', 'the 51st is a 409 FAVORITES_FULL', msg(r));
  check(await prisma.userNavItem.count({ where: { userId: ownerA.id, list: 'favorite' } }) === 50, 'and is not stored');

  section('Favourites: only one\'s own rows');
  r = await nav(S.ownerA);
  const mine = r.data.favorites.find((f) => f.ref === a1.id);
  r = await unfav(S.ownerB, mine.id);
  check(r.status === 200 && !r.data.favorites.length, 'Business B\'s owner deleting A\'s favourite gets their own (empty) list', msg(r));
  check(await prisma.userNavItem.count({ where: { id: mine.id } }) === 1, '…and A\'s row is untouched');
  r = await nav(S.ownerB);
  check(r.status === 200 && r.data.favorites.length === 0 && r.data.recent.length === 0, 'Business B\'s owner sees none of A\'s rows', msg(r));
  r = await unfav(S.ownerA, mine.id);
  check(r.status === 200 && !r.data.favorites.some((f) => f.ref === a1.id), 'A\'s owner removes their own', msg(r));
  r = await unfav(S.ownerA, '../../x');
  check(r.status === 404, 'a malformed id is a 404', msg(r));

  // ── Losing access hides ───────────────────────────────────────────────────
  section('Losing access hides a favourite and a recent item; the row is kept');
  r = await fav(S.userA, 'device', a1.id);
  check(r.status === 201 || r.status === 200, 'a Business A user adds a company-wide computer', msg(r));
  r = await visit(S.userA, 'device', a1.id);
  check(r.status === 201 || r.status === 200, '…and it is recorded as recent', msg(r));
  await prisma.endpoint.update({ where: { id: a1.id }, data: { accessMode: 'ASSIGNED_USERS' } });
  r = await nav(S.userA);
  check(r.status === 200 && !refs(r.data.favorites).includes(`device:${a1.id}`) && !refs(r.data.recent).includes(`device:${a1.id}`), 'after it is restricted to assigned people, it is in neither list', msg(r));
  check(!JSON.stringify(r.body).includes(a1.name), 'and its name is nowhere in the answer');
  check(await prisma.userNavItem.count({ where: { userId: userA.id, ref: a1.id } }) === 2, 'both rows are kept');
  await prisma.computerAccess.create({ data: { tenantId: tenant.id, endpointId: a1.id, userId: userA.id } });
  r = await nav(S.userA);
  check(refs(r.data.favorites).includes(`device:${a1.id}`), 'given access again, it is back', msg(r));
  await prisma.computerAccess.deleteMany({ where: { endpointId: a1.id } });
  await prisma.endpoint.update({ where: { id: a1.id }, data: { accessMode: 'COMPANY_WIDE' } });
  r = await fav(S.noView, 'device', a1.id);
  check(r.status === 404, 'a Business A user without computers:view cannot add a computer', msg(r));
  r = await fav(S.noView, 'page', '/endpoints');
  check(r.status === 201 || r.status === 200, '…but can bookmark a page (the page checks for itself)', msg(r));

  // ── Recent ────────────────────────────────────────────────────────────────
  section('Recent items: newest first, at most 15');
  for (let i = 0; i < 18; i++) await visit(S.ownerA, 'device', extra[i].id);
  r = await nav(S.ownerA);
  check(r.data.recent.length === 15, '15 kept of 18', String(r.data.recent.length));
  check(r.data.recent[0]?.ref === extra[17].id, 'the newest first', r.data.recent[0]?.ref);
  check(await prisma.userNavItem.count({ where: { userId: ownerA.id, list: 'recent' } }) === 15, 'older ones are deleted, not just hidden');
  await visit(S.ownerA, 'device', extra[5].id);
  r = await nav(S.ownerA);
  check(r.data.recent[0]?.ref === extra[5].id && r.data.recent.filter((x) => x.ref === extra[5].id).length === 1, 'visiting again moves it to the top, once', r.data.recent[0]?.ref);
  r = await visit(S.ownerA, 'device', b1.id);
  check(r.status === 404, 'another business\'s computer is a 404', msg(r));
  r = await visit(S.ownerA, 'page', 'https://evil.example.com');
  check(r.status === 400, 'an external URL is a 400', msg(r));

  section('At the same moment: one person\'s writes are serialised (the browser suite saw a 500 from two tabs)');
  let rs = await Promise.all(extra.slice(0, 20).flatMap((e) => [visit(S.ownerA, 'device', e.id), visit(S.ownerA, 'device', e.id)]));
  check(rs.every((x) => x.status === 201 || x.status === 200), '40 visits at once, each item twice: every one is recorded, no 500 or 409', rs.map((x) => x.status).join(','));
  check(await prisma.userNavItem.count({ where: { userId: ownerA.id, list: 'recent' } }) === 15, '…and 15 are kept');
  for (let i = 0; i < 47; i++) await fav(S.ownerB, 'page', `/race/p${i}`);
  rs = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => fav(S.ownerB, 'page', `/race/q${i}`)));
  const fullCount = rs.filter((x) => x.status === 409 && x.body.code === 'FAVORITES_FULL').length;
  check(rs.filter((x) => x.status === 201 || x.status === 200).length === 3 && fullCount === 3, 'six favourites at once with room for three: three kept, three FAVORITES_FULL', rs.map((x) => x.status).join(','));
  check(await prisma.userNavItem.count({ where: { userId: ownerB.id, list: 'favorite' } }) === 50, '…and exactly 50 stored');
  await prisma.userNavItem.deleteMany({ where: { userId: ownerB.id } });

  // ── What is stored ────────────────────────────────────────────────────────
  section('What is stored: kind and reference, never a name; not audited');
  const cols = await prisma.$queryRawUnsafe(`SELECT column_name FROM information_schema.columns WHERE table_name = 'UserNavItem' ORDER BY ordinal_position`);
  check(JSON.stringify(cols.map((c) => c.column_name)) === JSON.stringify(['id', 'userId', 'list', 'kind', 'ref', 'createdAt', 'usedAt']), 'UserNavItem has no name, title or URL column', JSON.stringify(cols));
  const rows = await prisma.userNavItem.findMany({ where: { userId: { in: created.users } } });
  check(rows.every((x) => !x.ref.includes(TAG)), 'no stored reference carries a record\'s name');
  const audits = await prisma.activityLog.count({ where: { actorId: { in: created.users } } }) - auditBefore;
  check(audits === 0, 'nothing navigational is audited (no audit row since sign-in)', String(audits));
  let refused = null;
  try { await prisma.$executeRawUnsafe(`INSERT INTO "UserNavItem" (id, "userId", list, kind, ref) VALUES ('${hex32()}', '${ownerA.id}', 'favorite', 'page', 'https://evil.example.com')`); } catch (e) { refused = String(e.message); }
  check(refused && /UserNavItem_ref_check/.test(refused), '0104\'s CHECK refuses an external URL written directly', refused?.slice(0, 200));
  refused = null;
  try { await prisma.$executeRawUnsafe(`INSERT INTO "UserNavPreference" ("userId", mode, "updatedAt") VALUES ('${admin.id}x', 'expert', now())`); } catch (e) { refused = String(e.message); }
  check(refused && /mode_check|foreign key/i.test(refused), '0104 refuses an unknown mode', refused?.slice(0, 200));
  refused = null;
  try { await prisma.$executeRawUnsafe(`UPDATE "UserNavPreference" SET "pinnedGroups" = ARRAY['settings'] WHERE "userId" = '${ownerA.id}'`); } catch (e) { refused = String(e.message); }
  check(refused && /pinnedGroups_check/.test(refused), '0104 refuses a group that is not in the menu', refused?.slice(0, 200));

  // ── Search: scripts and policies ──────────────────────────────────────────
  section('Search: scripts, isolated by business');
  r = await search(S.ownerA, `${TAG} cleanup`);
  check(r.status === 200 && Array.isArray(r.data?.groups?.scripts?.items), 'Business A\'s owner gets a scripts group', msg(r));
  const ids = (g) => (g?.items ?? []).map((x) => x.id);
  check(ids(r.data.groups.scripts).includes(sA.id) && !ids(r.data.groups.scripts).includes(sB.id), 'A\'s script is found; B\'s, with the same name, is not', JSON.stringify(r.data.groups.scripts));
  r = await search(S.ownerA, `${TAG}-BIRCH-ONLY-SCRIPT`);
  check(r.status === 200 && ids(r.data.groups.scripts).length === 0, 'B\'s exact script name finds nothing for A\'s owner', msg(r));
  r = await search(S.techA, `${TAG}-BIRCH-ONLY-SCRIPT`);
  check(r.status === 200 && ids(r.data.groups.scripts ?? { items: [] }).length === 0, '…nor for an A-only technician', msg(r));
  r = await search(S.userA, `${TAG} cleanup`);
  check(r.status === 200 && r.data.groups.scripts === null, 'a Business User with no library right gets scripts: null', JSON.stringify(r.data?.groups?.scripts));
  r = await search(S.admin, `${TAG}-BIRCH-ONLY-SCRIPT`);
  check(r.status === 200 && ids(r.data.groups.scripts).includes(sBOnly.id), 'the Platform Admin finds it (the negative control)', msg(r));

  if (policyFixtures) {
    section('Search: patch policies and automation schedules, each through its page\'s rule');
    r = await search(S.ownerA, `${TAG} monthly`);
    check(r.status === 200 && ids(r.data.groups.policies).includes(pA.id) && !ids(r.data.groups.policies).includes(pB.id), 'A\'s policy is found; B\'s, with the same name, is not', JSON.stringify(r.data?.groups?.policies));
    const it = r.data.groups.policies?.items.find((x) => x.id === pA.id);
    check(it && it.kind === 'patch' && it.business?.id === A.id, 'a policy result says its kind and business', JSON.stringify(it));
    for (const [who, s] of [['A\'s owner', S.ownerA], ['a Business A user', S.userA], ['an A-only technician', S.techA]]) {
      for (const q of [`${TAG}-BIRCH-ONLY-POLICY`, `${TAG}-BIRCH-ONLY-SCHEDULE`]) {
        r = await search(s, q);
        check(r.status === 200 && ids(r.data.groups.policies).length === 0, `${who}: "${q.slice(TAG.length)}" finds nothing`, msg(r));
      }
    }
    r = await search(S.noView, `${TAG} monthly`);
    check(r.status === 200 && r.data.groups.policies === null, 'without computers:view, policies: null', JSON.stringify(r.data?.groups?.policies));
    r = await search(S.admin, `${TAG}-BIRCH-ONLY`);
    check(r.status === 200 && ids(r.data.groups.policies).includes(pBOnly.id) && ids(r.data.groups.policies).includes(aB.id), 'the Platform Admin finds B\'s policy and schedule (the negative control)', msg(r));
    // A policy naming a computer the caller cannot see is not shown, even in their own business.
    const hidden = await mkEp(A, `${TAG}-RESTRICTED`, 'ASSIGNED_USERS');
    const pHidden = await mkPatch(A, hidden, `${TAG} restricted policy`);
    r = await search(S.userA, `${TAG} restricted policy`);
    check(r.status === 200 && !ids(r.data.groups.policies).includes(pHidden.id), 'a Business User does not find a policy naming a computer they cannot see', msg(r));
    r = await search(S.ownerA, `${TAG} restricted policy`);
    check(r.status === 200 && ids(r.data.groups.policies).includes(pHidden.id), '…while the owner, who can, does', msg(r));
  }

  section('No secrets');
  const all = seen.join('\n');
  check(!/passwordHash|permanentPassword|\$argon2/.test(all), 'no hash or secret in any answer');
}

let exitCode = 0;
try { await all(); } catch (e) { exitCode = 1; console.error(e); if (api) console.error(api.log.slice(-2000)); }
finally {
  await stopApi();
  try {
    await prisma.userNavItem.deleteMany({ where: { userId: { in: created.users } } });
    await prisma.userNavPreference.deleteMany({ where: { userId: { in: created.users } } });
    await prisma.patchPolicy.deleteMany({ where: { customerId: { in: created.businesses } } });
    await prisma.automationPolicy.deleteMany({ where: { customerId: { in: created.businesses } } });
    await prisma.technicianAssignment.deleteMany({ where: { userId: { in: created.users } } });
    await prisma.membership.deleteMany({ where: { userId: { in: created.users } } });
    await prisma.customer.deleteMany({ where: { id: { in: created.businesses } } });
    await prisma.user.deleteMany({ where: { id: { in: created.users } } });
  } catch (e) { console.error('cleanup:', String(e.message).slice(0, 300)); }
  await prisma.$disconnect();
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFailed:'); for (const f of failures) console.log(`  ✗ ${f}`); }
process.exit(fail || exitCode ? 1 : 0);
