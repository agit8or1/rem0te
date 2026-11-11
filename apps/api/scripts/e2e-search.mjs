#!/usr/bin/env node
/**
 * End-to-end proof of global search (0.33): GET /search?q=.
 *
 *   - computers match on name, hostname, RustDesk ID, serial, signed-in user,
 *     IP address, adapter IPv4 and alias, say which field matched, rank an
 *     exact match first, and are capped at 8 with `more`;
 *   - businesses, sites, users and open alerts match and are capped likewise;
 *   - business isolation: Business A's owner, a Business A user and an
 *     A-only technician get nothing from Business B — not by a shared word,
 *     nor by B's exact hostname, RustDesk ID, serial, address, site name,
 *     user email or alert title — while the Platform Admin, with the same
 *     queries, DOES find B (the negative control);
 *   - a Business User sees only assigned / COMPANY_WIDE computers, and a
 *     technician restricted to one computer sees only that one;
 *   - each group is gated by its list page's capability and is null without it;
 *   - no secret, hash or token appears; searches are not audited and the
 *     query text is not in the API's output;
 *   - q is validated (2–100 characters, once) and the route is throttled.
 *
 * Self-starting: it runs its own API from dist/ on SEARCH_API_PORT (3281)
 * against DATABASE_URL, which must name a scratch/test database. Fixtures are
 * namespaced and removed at the end.
 *
 * Run:  DATABASE_URL=…/rem0te_search_test node scripts/e2e-search.mjs
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
const PORT = Number(process.env.SEARCH_API_PORT ?? 3281);
if ([3000, 3001, 443].includes(PORT)) { console.error(`Refusing port ${PORT}: that is a production port.`); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'search-e2e-password-1';
const TAG = `GS${sfx}`;
const CAP = 8;
const RATE = 120;

let pass = 0, fail = 0;
const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;
const oct = () => 1 + ((Math.random() * 250) | 0);

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

const seen = []; // every response body, for the no-secrets sweep
async function search(s, q, { from = ip(), rawQs } = {}) {
  // A fresh address per request unless one is given: the search budget and
  // the global throttler (20/s, 300/min) are keyed by client address.
  const h = { 'x-forwarded-for': from };
  if (s) h.cookie = s.cookie;
  const r = await fetch(`${API}/search?${rawQs ?? `q=${encodeURIComponent(q)}`}`, { headers: h });
  const text = await r.text();
  seen.push(text);
  let j; try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j, data: j?.data, g: j?.data?.groups, headers: r.headers, text };
}
async function login(email) {
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip() }, body: JSON.stringify({ email, password: PW }) });
  const mm = (r.headers.get('set-cookie') ?? '').match(/access_token=([^;]+)/);
  if (r.status !== 200 || !mm) throw new Error(`login ${email}: ${r.status} ${await r.text()}`);
  return { cookie: `access_token=${mm[1]}` };
}
const msg = (r) => `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 400)}`;
const ids = (grp) => (grp?.items ?? []).map((x) => x.id);

const created = { businesses: [], users: [] };

async function all() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });
  const roleUser = await prisma.role.findFirst({ where: { type: 'BUSINESS_USER' } });

  section('Fixtures (synthetic): Business A and Business B share every searchable word');
  const A = await prisma.customer.create({ data: { tenantId: tenant.id, name: `${TAG} Acme`, code: `${TAG}-ACM`, city: 'Springfield' } });
  const B = await prisma.customer.create({ data: { tenantId: tenant.id, name: `${TAG} Birch`, code: `${TAG}-BIR`, city: 'Springfield' } });
  created.businesses.push(A.id, B.id);
  // Ten more businesses so the admin's business group overflows the cap.
  for (let i = 0; i < 10; i++) created.businesses.push((await prisma.customer.create({ data: { tenantId: tenant.id, name: `${TAG} Bulk Co ${String(i).padStart(2, '0')}` } })).id);
  const siteA = await prisma.site.create({ data: { tenantId: tenant.id, customerId: A.id, name: `${TAG} HQ` } });
  const siteA2 = await prisma.site.create({ data: { tenantId: tenant.id, customerId: A.id, name: `${TAG} Depot`, city: 'Shelbyville' } });
  const siteB = await prisma.site.create({ data: { tenantId: tenant.id, customerId: B.id, name: `${TAG} HQ` } });
  const siteBOnly = await prisma.site.create({ data: { tenantId: tenant.id, customerId: B.id, name: `${TAG}-BIRCH-ONLY-SITE` } });
  await prisma.site.create({ data: { tenantId: tenant.id, customerId: A.id, name: `${TAG} Closed`, isActive: false } });

  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag, extra = {}) => { const u = await prisma.user.create({ data: { email: `gs-${tag}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'GS', lastName: tag, status: 'ACTIVE', ...extra } }); created.users.push(u.id); return u; };
  const member = (u, biz, role, capabilities) => prisma.membership.create({ data: { userId: u.id, tenantId: tenant.id, customerId: biz.id, roleId: role.id, ...(capabilities ? { capabilities } : {}) } });
  const admin = await mkUser('admin', { isPlatformAdmin: true });
  const ownerA = await mkUser('owner-a'), ownerB = await mkUser('owner-b');
  const userA = await mkUser('user-a'), noView = await mkUser('noview-a'), usersOnly = await mkUser('usersonly-a'), alertsA = await mkUser('alerts-a');
  const techOne = await mkUser('tech-one'), techWide = await mkUser('tech-wide');
  const alice = await mkUser('alice', { firstName: 'Alice', lastName: `Zephyr${sfx}` });
  const bob = await mkUser('bob-b', { firstName: 'Bob', lastName: `Quill${sfx}` });
  await member(ownerA, A, roleOwner); await member(ownerB, B, roleOwner);
  await member(userA, A, roleUser, ['computers:view']);
  await member(noView, A, roleUser, ['computers:connect']);
  await member(usersOnly, A, roleUser, ['users:view']);
  await member(alertsA, A, roleUser, ['computers:view', 'monitoring:alerts']);
  await member(alice, A, roleUser, ['computers:view']);
  await member(bob, B, roleUser, ['computers:view']);
  for (let i = 0; i < 10; i++) await member(await mkUser(`crowd${String(i).padStart(2, '0')}`), A, roleUser, ['computers:view']);

  const net = { a: `172.${oct()}.${oct()}`, b: `172.${oct()}.${oct()}` };
  const pub = { a: `198.18.${oct()}.${oct()}`, b: `198.19.${oct()}.${oct()}` };
  const mkEp = async (biz, name, { site = null, online = true, mode = 'COMPANY_WIDE', status = 'ACTIVE', rd, serial, user, ipAddress, nic, alias } = {}) => {
    const e = await prisma.endpoint.create({ data: {
      tenantId: tenant.id, customerId: biz.id, siteId: site?.id ?? null, name, hostname: `${name.toLowerCase()}.corp.example.com`, platform: 'Windows',
      osVersion: 'Windows 11 Pro', status, isOnline: online, isManaged: true, accessMode: mode, lastSeenAt: new Date(), ipAddress: ipAddress ?? null,
    } });
    await prisma.rustdeskNode.create({ data: { tenantId: tenant.id, endpointId: e.id, rustdeskId: rd ?? String(100000000 + ((Math.random() * 899999999) | 0)), permanentPassword: `enc:${TAG}-NOT-A-REAL-SECRET` } });
    if (serial || user || nic) await prisma.endpointInventory.create({ data: { endpointId: e.id, serialNumber: serial ?? null, loggedOnUser: user ?? null, networks: nic ? [{ name: 'Ethernet', mac: '00:00:5e:00:53:01', ipv4: nic, gateway: null, dhcp: true }] : undefined } });
    if (alias) await prisma.endpointAlias.create({ data: { endpointId: e.id, alias } });
    return e;
  };
  const rdA = String(700000000 + ((Math.random() * 99999999) | 0)), rdB = String(800000000 + ((Math.random() * 99999999) | 0));
  const a1 = await mkEp(A, `${TAG}-SHARED-A1`, { site: siteA, rd: rdA, serial: `SN-${TAG}-A1`, user: `ACME\\${TAG}-jdoe`, ipAddress: `${pub.a}`, nic: `${net.a}.11`, alias: `${TAG}-reception-pc` });
  const aExact = await mkEp(A, `${TAG}-EXACT`, { site: siteA2 });
  const aExactLonger = await mkEp(A, `${TAG}-EXACT-LONGER`, {});
  const aPre = await mkEp(A, `X-${TAG}-EXACT`, {}); // contains, not prefix
  const aAssigned = await mkEp(A, `${TAG}-SHARED-A2-ASSIGNED`, { mode: 'ASSIGNED_USERS' });
  const aHidden = await mkEp(A, `${TAG}-SHARED-A3-NOT-GRANTED`, { mode: 'ASSIGNED_USERS' });
  const aArch = await mkEp(A, `${TAG}-SHARED-A4-ARCHIVED`, { status: 'ARCHIVED', online: false });
  await prisma.computerAccess.create({ data: { tenantId: tenant.id, endpointId: aAssigned.id, userId: userA.id } });
  await prisma.computerAccess.create({ data: { tenantId: tenant.id, endpointId: aAssigned.id, userId: alertsA.id } });
  for (let i = 0; i < 12; i++) await mkEp(A, `${TAG}-bulk-${String(i).padStart(2, '0')}`, { online: i % 2 === 0 });

  const b1 = await mkEp(B, `${TAG}-SHARED-B1`, { site: siteB, rd: rdB, serial: `SN-${TAG}-B1`, user: `BIRCH\\${TAG}-jdoe`, ipAddress: `${pub.b}`, nic: `${net.b}.11`, alias: `${TAG}-birch-reception` });
  const b2 = await mkEp(B, `${TAG}-EXACT-B`, {});
  const bIds = new Set([b1.id, b2.id]);

  let n = 0;
  const mkAlert = (biz, ep, title, state = 'OPEN', severity = 'WARNING') => prisma.monitorAlert.create({ data: {
    tenantId: tenant.id, customerId: biz.id, endpointId: ep?.id ?? null, ruleKey: `gs-${++n}`, kind: 'DISK_FREE', dedupKey: `gs:${sfx}:${n}`,
    severity, state, title, detail: {}, ...(state === 'RESOLVED' ? { resolvedAt: new Date() } : {}),
  } });
  const alA1 = await mkAlert(A, a1, `${TAG} disk nearly full on A1`, 'OPEN', 'CRITICAL');
  const alA2 = await mkAlert(A, aAssigned, `${TAG} disk nearly full on A2`, 'ACKNOWLEDGED');
  const alHidden = await mkAlert(A, aHidden, `${TAG} disk nearly full on A3`);
  const alResolved = await mkAlert(A, a1, `${TAG} disk nearly full resolved`, 'RESOLVED');
  const alB = await mkAlert(B, b1, `${TAG} disk nearly full on B1 birchonly`);

  await prisma.technicianAssignment.create({ data: { tenantId: tenant.id, customerId: A.id, userId: techOne.id, capabilities: ['computers:view'], endpointIds: [a1.id] } });
  await prisma.technicianAssignment.create({ data: { tenantId: tenant.id, customerId: A.id, userId: techWide.id, capabilities: ['computers:view', 'users:view', 'monitoring:alerts'], endpointIds: [] } });

  startApi();
  await waitUp();
  const S = {};
  for (const [k, u] of Object.entries({ admin, ownerA, ownerB, userA, noView, usersOnly, alertsA, techOne, techWide })) S[k] = await login(u.email);

  // ── Validation ────────────────────────────────────────────────────────────
  section('q is validated');
  let r = await search(S.ownerA, '', { rawQs: '' });
  check(r.status === 400, 'missing q is a 400', msg(r));
  r = await search(S.ownerA, 'a');
  check(r.status === 400 && r.body.code === 'QUERY_TOO_SHORT', 'one character is a 400 QUERY_TOO_SHORT', msg(r));
  r = await search(S.ownerA, '​​ ​');
  check(r.status === 400 && r.body.code === 'QUERY_TOO_SHORT', 'invisible characters do not count toward the minimum', msg(r));
  r = await search(S.ownerA, 'x'.repeat(101));
  check(r.status === 400 && r.body.code === 'QUERY_TOO_LONG', '101 characters is a 400 QUERY_TOO_LONG', msg(r));
  r = await search(S.ownerA, 'x'.repeat(100));
  check(r.status === 200, '100 characters is accepted', msg(r));
  r = await search(S.ownerA, '', { rawQs: 'q=ab&q=cd' });
  check(r.status === 400, 'q given twice is a 400', msg(r));
  r = await search(null, TAG);
  check(r.status === 401, 'unauthenticated is a 401', msg(r));
  r = await search(S.ownerA, TAG);
  check(r.status === 200 && /no-store/.test(r.headers.get('cache-control') ?? ''), 'a result is Cache-Control: no-store', r.headers.get('cache-control'));

  // ── Computers: every field ────────────────────────────────────────────────
  section('Computers: matching on each field, with the field that matched');
  const FIELDS = [
    ['name', `${TAG}-SHARED-A1`, null],
    ['hostname', `${TAG.toLowerCase()}-shared-a1.corp`, 'hostname'],
    ['RustDesk ID', rdA, 'rustdeskId'],
    ['serial', `SN-${TAG}-A1`, 'serialNumber'],
    ['signed-in user', `ACME\\${TAG}-jdoe`, 'loggedOnUser'],
    ['IP address', pub.a, 'ipAddress'],
    ['adapter IPv4', `${net.a}.11`, 'privateIp'],
    ['alias', `${TAG}-reception`, 'alias'],
  ];
  for (const [label, q, field] of FIELDS) {
    r = await search(S.ownerA, q);
    const hit = r.g?.computers?.items.find((x) => x.id === a1.id);
    check(r.status === 200 && !!hit && (field === null ? hit.match === null : hit.match?.field === field), `${label}: finds A1${field ? ` and reports match.field = ${field}` : ''}`, msg(r));
  }
  r = await search(S.ownerA, rdA);
  check(r.g.computers.items[0]?.match?.value === rdA, 'the RustDesk ID is returned only as the value that matched', JSON.stringify(r.g.computers.items[0]));
  r = await search(S.ownerA, `${TAG}-SHARED-A1`);
  {
    const it = r.g.computers.items.find((x) => x.id === a1.id);
    check(it && it.business?.id === A.id && it.site?.id === siteA.id && it.isOnline === true && it.hostname, 'a computer result carries business, site, online and hostname', JSON.stringify(it));
    check(it && !('rustdeskId' in it) && !('ipAddress' in it) && !('serialNumber' in it), 'fields that did not match are not returned', JSON.stringify(it));
  }
  r = await search(S.ownerA, 'jdoe');
  check(r.g.computers.items.some((x) => x.id === a1.id && x.match?.field === 'loggedOnUser' && x.match.value === `ACME\\${TAG}-jdoe`), 'a partial signed-in user name matches anywhere in the value');
  r = await search(S.ownerA, `${TAG}-SHARED-A4`);
  check(r.status === 200 && !ids(r.g.computers).includes(aArch.id), 'an archived computer is not found (as in the device list)', msg(r));
  r = await search(S.ownerA, `%_`);
  check(r.status === 200 && r.g.computers.items.length === 0, 'LIKE wildcards in q are literal: "%_" matches no computer', msg(r));
  check(['businesses', 'sites', 'users', 'alerts'].every((k) => r.g[k].items.length === 0), '…and no business, site, user or alert', JSON.stringify(Object.fromEntries(Object.entries(r.g).map(([k, v]) => [k, v.items.length]))));
  r = await search(S.ownerA, `${TAG}_EXACT`);
  check(r.status === 200 && r.g.computers.items.length === 0, '"_" does not match "-"', msg(r));

  section('The list routes treat LIKE wildcards as literal too (0.33)');
  {
    // Before 0.33 only global search escaped: GET /endpoints?search=%,
    // the device list and GET /businesses spliced the text into ILIKE as is,
    // so "%" or "_" matched every row in scope. All four share likeEscape now.
    const get = async (p) => {
      const res = await fetch(`${API}${p}`, { headers: { cookie: S.ownerA.cookie, 'x-forwarded-for': ip() } });
      // Not added to `seen`: that sweep is for search responses, and these list
      // routes return their own fields (hasPassword and the like) by design.
      const t = await res.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: res.status, data: j?.data };
    };
    const enc = encodeURIComponent;
    const oldIds = async (q) => { const x = await get(`/endpoints?search=${enc(q)}&limit=200`); return x.status === 200 ? (x.data?.endpoints ?? []).map((e) => e.id) : null; };
    const listIds = async (q) => { const x = await get(`/endpoints/list?search=${enc(q)}&pageSize=200`); return x.status === 200 ? (x.data?.rows ?? []).map((e) => e.id) : null; };
    const bizIds = async (q) => { const x = await get(`/businesses?search=${enc(q)}`); return x.status === 200 ? (x.data ?? []).map((b) => b.id) : null; };
    // Controls: the literal text does find the fixtures, so an empty answer below is the escaping.
    check((await oldIds(`${TAG}-EXACT`))?.includes(aExact.id), 'control: GET /endpoints finds a computer by a literal name');
    check((await listIds(`${TAG}-EXACT`))?.includes(aExact.id), 'control: the device list finds it too');
    check((await bizIds(`${TAG} Acme`))?.includes(A.id), 'control: GET /businesses finds a business by a literal name');
    for (const q of ['%', '_', `${TAG}_EXACT`, `${TAG}%EXACT`]) {
      const o = await oldIds(q), l = await listIds(q);
      check(Array.isArray(o) && o.length === 0, `GET /endpoints?search=${q} matches nothing (wildcards are literal)`, JSON.stringify(o));
      check(Array.isArray(l) && l.length === 0, `device list search=${q} matches nothing`, JSON.stringify(l));
    }
    for (const q of ['%', '_', `${TAG}_Acme`]) {
      const b = await bizIds(q);
      check(Array.isArray(b) && b.length === 0, `GET /businesses?search=${q} matches nothing`, JSON.stringify(b));
    }
    // A backslash is a literal character, not an escape for the next one.
    check((await listIds(`ACME\\${TAG}-jdoe`))?.includes(a1.id), 'device list: a DOMAIN\\user search with a backslash still finds the signed-in user');
  }

  section('Computers: ranking and the cap');
  r = await search(S.ownerA, `${TAG}-EXACT`);
  {
    const order = ids(r.g.computers);
    check(order[0] === aExact.id, 'an exact name match is first', JSON.stringify(r.g.computers.items.map((x) => x.name)));
    check(order.indexOf(aExactLonger.id) > 0 && order.indexOf(aPre.id) > order.indexOf(aExactLonger.id), 'then a prefix match, then a match inside the name');
  }
  r = await search(S.ownerA, `${TAG}-bulk`);
  check(r.g.computers.items.length === CAP && r.g.computers.more === true, `twelve matches: ${CAP} returned and more = true`, `${r.g.computers.items.length} ${r.g.computers.more}`);
  check(r.data.cap === CAP, 'the response states the cap');
  {
    const on = r.g.computers.items.map((x) => x.isOnline);
    check(on.every((v, i) => i === 0 || on[i - 1] >= v), 'within one rank, online computers come first', JSON.stringify(on));
  }
  r = await search(S.ownerA, `${TAG}-bulk-0`);
  check(r.g.computers.items.length === CAP && r.g.computers.more === true, 'ten matches: still capped', `${r.g.computers.items.length}`);
  r = await search(S.ownerA, `${TAG}-bulk-1`);
  check(r.g.computers.items.length === 2 && r.g.computers.more === false, 'two matches: both, more = false', `${r.g.computers.items.length} ${r.g.computers.more}`);

  // ── Other groups ──────────────────────────────────────────────────────────
  section('Businesses, sites, users, alerts');
  r = await search(S.admin, `${TAG} Acme`);
  check(r.g.businesses.items[0]?.id === A.id, 'business by name (exact first)', JSON.stringify(r.g.businesses));
  r = await search(S.admin, `${TAG}-BIR`);
  check(ids(r.g.businesses).includes(B.id), 'business by code');
  r = await search(S.admin, TAG);
  check(r.g.businesses.items.length === CAP && r.g.businesses.more === true, `twelve businesses: ${CAP} and more`, `${r.g.businesses.items.length}`);
  r = await search(S.ownerA, `${TAG} HQ`);
  check(ids(r.g.sites).includes(siteA.id) && r.g.sites.items.find((s) => s.id === siteA.id)?.business?.id === A.id, 'site by name, with its business', JSON.stringify(r.g.sites));
  r = await search(S.ownerA, 'Shelbyville');
  check(ids(r.g.sites).includes(siteA2.id), 'site by city');
  r = await search(S.ownerA, `${TAG} Closed`);
  check(r.g.sites.items.length === 0, 'an inactive site is not found (as in the sites list)');
  r = await search(S.ownerA, `alice zephyr${sfx}`);
  check(ids(r.g.users).includes(alice.id) && r.g.users.items.length === 1, 'user by first and last name, in any case', JSON.stringify(r.g.users));
  r = await search(S.ownerA, `gs-alice-${sfx}@test`);
  {
    const u = r.g.users.items.find((x) => x.id === alice.id);
    check(u && u.email === alice.email && u.accessLevel === 'Business User' && u.business?.id === A.id, 'user by email, with level and business', JSON.stringify(u));
  }
  r = await search(S.ownerA, `-${sfx}@test.invalid`);
  check(r.g.users.items.length === CAP && r.g.users.more === true, `A's many users: ${CAP} and more`, `${r.g.users.items.length}`);
  r = await search(S.ownerA, `${TAG} disk nearly`);
  check(ids(r.g.alerts).includes(alA1.id) && ids(r.g.alerts).includes(alA2.id) && ids(r.g.alerts).includes(alHidden.id), 'open and acknowledged alerts by title', JSON.stringify(ids(r.g.alerts)));
  check(!ids(r.g.alerts).includes(alResolved.id), 'a resolved alert is not found');
  check(r.g.alerts.items.find((a) => a.id === alA1.id)?.computer?.id === a1.id, 'an alert result names its computer');

  // ── Isolation ─────────────────────────────────────────────────────────────
  section("Negative control: the Platform Admin finds Business B's objects by exact value");
  const B_PROBES = [
    ['a shared word', TAG],
    ['B computer name', `${TAG}-SHARED-B1`],
    ['B exact hostname', `${TAG.toLowerCase()}-shared-b1.corp.example.com`],
    ['B exact RustDesk ID', rdB],
    ['B serial', `SN-${TAG}-B1`],
    ['B signed-in user', `BIRCH\\${TAG}-jdoe`],
    ['B IP address', pub.b],
    ['B adapter IPv4', `${net.b}.11`],
    ['B alias', `${TAG}-birch-reception`],
    ['B exact-name computer', `${TAG}-EXACT-B`],
  ];
  for (const [label, q] of B_PROBES) {
    r = await search(S.admin, q);
    check(r.g.computers.items.some((x) => bIds.has(x.id)), `admin: ${label} finds B's computer`, msg(r));
  }
  r = await search(S.admin, `${TAG}-BIRCH-ONLY-SITE`);
  check(ids(r.g.sites).includes(siteBOnly.id), "admin: B's site by name");
  r = await search(S.admin, `quill${sfx}`);
  check(ids(r.g.users).includes(bob.id), "admin: B's user by name");
  r = await search(S.admin, 'birchonly');
  check(ids(r.g.alerts).includes(alB.id), "admin: B's alert by title");
  r = await search(S.admin, `${TAG} Birch`);
  check(ids(r.g.businesses).includes(B.id), 'admin: B by name');

  const EXTRA = [`${TAG}-BIRCH-ONLY-SITE`, `${TAG} HQ`, `quill${sfx}`, `gs-bob-b-${sfx}`, `gs-owner-b-${sfx}`, 'birchonly', `${TAG} Birch`, `${TAG}-BIR`, 'Springfield'];
  const leakOf = (res) => {
    const g = res.g ?? {};
    return [
      ...(g.computers?.items ?? []).filter((x) => bIds.has(x.id) || x.business?.id === B.id).map((x) => `computer ${x.name}`),
      ...(g.businesses?.items ?? []).filter((x) => x.id === B.id).map(() => 'business B'),
      ...(g.sites?.items ?? []).filter((x) => x.id === siteB.id || x.id === siteBOnly.id || x.business?.id === B.id).map((x) => `site ${x.name}`),
      ...(g.users?.items ?? []).filter((x) => x.id === bob.id || x.id === ownerB.id || x.business?.id === B.id).map((x) => `user ${x.email}`),
      ...(g.alerts?.items ?? []).filter((x) => x.id === alB.id || x.business?.id === B.id).map((x) => `alert ${x.title}`),
    ];
  };
  for (const who of ['ownerA', 'userA', 'techOne', 'techWide', 'alertsA', 'usersOnly']) {
    section(`Isolation: ${who} — every B probe`);
    const leaks = [], errors = [];
    for (const q of [...B_PROBES.map((p) => p[1]), ...EXTRA]) {
      const x = await search(S[who], q);
      if (x.status !== 200) { errors.push(`${q} → ${x.status}`); continue; }
      leaks.push(...leakOf(x).map((l) => `${q}: ${l}`));
    }
    check(errors.length === 0, `${who}: every probe answered 200`, errors.join('; '));
    check(leaks.length === 0, `${who}: nothing of Business B, by any word or exact value (${B_PROBES.length + EXTRA.length} probes)`, leaks.join('; '));
  }
  r = await search(S.ownerB, `${TAG}-SHARED`);
  check(r.g.computers.items.length === 1 && r.g.computers.items[0].id === b1.id, "symmetrically, B's owner sees only B1 for the shared word", JSON.stringify(ids(r.g.computers)));
  r = await search(S.ownerB, rdA);
  check(r.g.computers.items.length === 0, "B's owner cannot find A1 by its exact RustDesk ID");

  // ── Who sees which of A ───────────────────────────────────────────────────
  section('A Business User sees only assigned and company-wide computers');
  r = await search(S.userA, `${TAG}-SHARED`);
  {
    const got = ids(r.g.computers);
    check(got.includes(a1.id) && got.includes(aAssigned.id), 'user A: the company-wide A1 and the assigned A2', JSON.stringify(r.g.computers.items.map((x) => x.name)));
    check(!got.includes(aHidden.id), 'user A: not the ASSIGNED_USERS computer granted to someone else');
  }
  r = await search(S.userA, `${TAG.toLowerCase()}-shared-a3-not-granted.corp.example.com`);
  check(r.status === 200 && r.g.computers.items.length === 0, "user A: not even by that computer's exact hostname", msg(r));
  r = await search(S.alertsA, `${TAG} disk nearly`);
  {
    const got = ids(r.g.alerts);
    check(got.includes(alA1.id) && got.includes(alA2.id) && !got.includes(alHidden.id), "a Business User with monitoring:alerts sees the alerts of the computers they can see, not the ungranted one's", JSON.stringify(got));
  }

  section('The older GET /admin/search');
  {
    const old = async (who, q) => { const x = await fetch(`${API}/admin/search?q=${encodeURIComponent(q)}`, { headers: { cookie: S[who].cookie, 'x-forwarded-for': ip() } }); const t = await x.text(); let j; try { j = JSON.parse(t); } catch { j = null; } return { status: x.status, ids: (j?.data?.computers ?? []).map((c) => c.id) }; };
    const u = await old('userA', `${TAG}-SHARED`);
    const t = await old('techOne', TAG);
    check(u.status === 404 && t.status === 404, 'GET /admin/search is gone (it scoped computers by business alone)', `userA ${u.status} sees ungranted: ${u.ids.includes(aHidden.id)}; techOne ${t.status} sees ${t.ids.length} computers`);
  }

  section('A technician restricted to one computer');
  r = await search(S.techOne, TAG);
  check(r.g.computers.items.length === 1 && r.g.computers.items[0].id === a1.id, 'tech-one: only A1, for a word every computer shares', JSON.stringify(r.g.computers.items.map((x) => x.name)));
  check(ids(r.g.businesses).length === 1 && ids(r.g.businesses)[0] === A.id, 'tech-one: of the businesses, only A', JSON.stringify(r.g.businesses));
  r = await search(S.techOne, `${TAG}-EXACT`);
  check(r.g.computers.items.length === 0, 'tech-one: not the other A computers by exact name');
  r = await search(S.techWide, `${TAG}-SHARED`);
  check(ids(r.g.computers).includes(aHidden.id) && !ids(r.g.computers).some((id) => bIds.has(id)), 'tech-wide: every A computer, nothing of B');

  // ── Capability gating ─────────────────────────────────────────────────────
  section('Each group is gated by its own list page’s capability');
  const shape = (x) => Object.fromEntries(Object.entries(x.g ?? {}).map(([k, v]) => [k, v === null ? 'null' : 'list']));
  r = await search(S.noView, TAG);
  check(r.status === 200 && r.g.computers === null && r.g.sites === null && r.g.users === null && r.g.alerts === null && r.g.businesses !== null,
    'computers:connect only: computers, sites, users and alerts are null; businesses (no gate) is a list', JSON.stringify(shape(r)));
  check(ids(r.g.businesses).length === 1 && ids(r.g.businesses)[0] === A.id, 'computers:connect only: their own business, as GET /businesses gives them');
  r = await search(S.userA, TAG);
  check(r.g.computers !== null && r.g.sites !== null && r.g.users === null && r.g.alerts === null, 'computers:view: computers and sites; no users, no alerts', JSON.stringify(shape(r)));
  r = await search(S.usersOnly, TAG);
  check(r.g.computers === null && r.g.sites === null && r.g.users !== null && r.g.alerts === null, 'users:view only: users; no computers, sites or alerts', JSON.stringify(shape(r)));
  r = await search(S.alertsA, TAG);
  check(r.g.alerts !== null && r.g.users === null, 'monitoring:alerts: alerts present', JSON.stringify(shape(r)));
  r = await search(S.techOne, TAG);
  check(r.g.users === null && r.g.alerts === null, 'technician with computers:view only: no users, no alerts', JSON.stringify(shape(r)));
  r = await search(S.techWide, `gs-alice-${sfx}`);
  check(ids(r.g.users).includes(alice.id), 'technician with users:view on A: finds A users');
  r = await search(S.ownerA, TAG);
  check(Object.values(r.g).every((v) => v !== null), 'Business Owner: every group', JSON.stringify(shape(r)));
  for (const [who, gated] of [['noView', ['computers', 'sites', 'users', 'alerts']], ['usersOnly', ['computers', 'sites', 'alerts']], ['userA', ['users', 'alerts']]]) {
    const route = { computers: '/endpoints/list', sites: '/sites', users: '/users', alerts: '/monitoring/alerts' };
    const st = [];
    for (const g of gated) { const x = await fetch(`${API}${route[g]}`, { headers: { cookie: S[who].cookie, 'x-forwarded-for': ip() } }); st.push(`${g}:${x.status}`); }
    check(st.every((s) => s.endsWith(':403')), `${who}: the list routes of the null groups are 403 too (search is never wider)`, st.join(' '));
  }

  // ── Secrets, audit, logging ───────────────────────────────────────────────
  section('No secrets; not audited; the query is not logged');
  const before = await prisma.activityLog.count({ where: { actorId: { in: [ownerA.id, admin.id] }, createdAt: { gt: new Date(Date.now() - 3600_000) } } });
  const NEEDLE = `${TAG}needle${randomBytes(4).toString('hex')}`;
  for (let i = 0; i < 5; i++) await search(S.ownerA, `${NEEDLE}${i}`);
  await search(S.admin, NEEDLE);
  await sleep(300);
  const after = await prisma.activityLog.count({ where: { actorId: { in: [ownerA.id, admin.id] }, createdAt: { gt: new Date(Date.now() - 3600_000) } } });
  check(after === before, 'six searches wrote no audit row', `${before} → ${after}`);
  const [{ n: anyAudit }] = await prisma.$queryRaw`SELECT count(*)::int AS n FROM "ActivityLog" WHERE action::text LIKE '%SEARCH%' OR metadata::text LIKE ${'%' + NEEDLE + '%'}`;
  check(anyAudit === 0, 'no audit row names a search or carries the query');
  check(!api.log.includes(NEEDLE) && !api.log.includes(TAG), "the query text is not in the API's output", api.log.split('\n').filter((l) => l.includes(TAG)).slice(0, 3).join(' | '));
  const blob = seen.join('\n');
  check(!blob.includes('NOT-A-REAL-SECRET') && !blob.includes(hash) && !/"(passwordHash|permanentPassword|hasPassword|agentSecretHash|token|secret|mfaMethods|capabilities)"\s*:/i.test(blob),
    `no password, hash, token, secret or credential flag in ${seen.length} responses`);

  // ── Throttling ────────────────────────────────────────────────────────────
  section(`Throttling: ${RATE} per minute per client address`);
  {
    const from = ip();
    let ok = 0, limited = 0, other = 0;
    // Paced at ~14/s, under the 20/s burst throttler, so only the search budget can refuse.
    for (let i = 0; i < RATE; i++) { const x = await search(S.ownerA, `${TAG}-bulk`, { from }); if (x.status === 200) ok++; else if (x.status === 429) limited++; else other++; await sleep(70); }
    check(ok === RATE && limited === 0 && other === 0, `the first ${RATE} from one address are answered`, `ok ${ok} limited ${limited} other ${other}`);
    const x = await search(S.ownerA, `${TAG}-bulk`, { from });
    check(x.status === 429, `request ${RATE + 1} from that address is a 429`, msg(x));
    const y = await search(S.ownerA, `${TAG}-bulk`);
    check(y.status === 200, 'another address is still answered');
  }
}

async function cleanup() {
  await stopApi();
  try {
    const ids = created.businesses;
    await prisma.technicianAssignment.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.monitorAlert.deleteMany({ where: { customerId: { in: ids } } });
    const eps = await prisma.endpoint.findMany({ where: { customerId: { in: ids } }, select: { id: true } });
    const epIds = eps.map((e) => e.id);
    await prisma.computerAccess.deleteMany({ where: { endpointId: { in: epIds } } });
    await prisma.endpointAlias.deleteMany({ where: { endpointId: { in: epIds } } });
    await prisma.endpointInventory.deleteMany({ where: { endpointId: { in: epIds } } });
    await prisma.rustdeskNode.deleteMany({ where: { endpointId: { in: epIds } } });
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
