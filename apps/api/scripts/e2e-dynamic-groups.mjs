#!/usr/bin/env node
/**
 * End-to-end proof of rule-based (dynamic) device groups (0.34):
 * POST/PATCH/DELETE /device-groups with kind "rule", the device list's group
 * filter, facet, Groups column and CSV, and POST /endpoints/bulk with
 * targetGroupId.
 *
 *   - a rule is the device list's own filters: each rule group lists exactly
 *     what GET /endpoints/list shows with the same filters set (platform,
 *     online, site, tag, patches, alerts, RustDesk range — numerically —
 *     last-seen age), AND-ed with the group's business;
 *   - membership is computed, never stored: a computer that goes offline
 *     leaves an "online" group on the next read, and comes back when it
 *     returns; editing the rule moves the membership at once; an unreadable
 *     stored rule matches nothing;
 *   - business A/B isolation: another business's rule group lists nothing,
 *     is a 404 to edit or act on, its rule cannot name another business's
 *     site, and the facet never offers it;
 *   - a restricted Business User sees only their own computers in a rule
 *     group (list, facet, group list, bulk resolution), and a rule on alerts
 *     is refused for a viewer without monitoring:alerts;
 *   - a rule group cannot be "added to" — not by bulk, an enrolment token, or
 *     a direct database insert (0053 trigger) — and its kind never changes;
 *   - bulk on a rule group resolves the membership at request time as the
 *     caller sees it, then runs the per-computer checks; more than 200 is
 *     refused, never cut; the audit names the group and the resolved count;
 *   - edits are audited with the rule before and after;
 *   - a rule is never SQL: a tag full of SQL is matched as a bound value
 *     (it finds the one computer carrying it and drops nothing), and the
 *     built list service has no unsafe raw query;
 *   - the cost of evaluating rule groups on a list read, measured.
 *
 * Self-starting: its own API from dist/ on DYNAMIC_GROUPS_API_PORT (3481)
 * against DATABASE_URL, which must name a scratch/test database.
 *
 * Run:  DATABASE_URL=…/rem0te_dynamic_groups_test node scripts/e2e-dynamic-groups.mjs
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { fileURLToPath, URLSearchParams } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const DB = process.env.DATABASE_URL ?? '';
const dbName = DB.split('/').pop()?.split('?')[0] ?? '';
if (!/scratch|test/.test(dbName)) { console.error(`Refusing to run against database "${dbName}": name must contain "scratch" or "test".`); process.exit(2); }
const PORT = Number(process.env.DYNAMIC_GROUPS_API_PORT ?? 3481);
if ([3000, 3001, 443].includes(PORT)) { console.error(`Refusing port ${PORT}: that is a production port.`); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'dynamic-groups-e2e-password-1';
const TAG = `DG${sfx}`;

let pass = 0, fail = 0;
const failures = [];
const J = (x) => JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? String(v) : v));
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;

const apiEnv = {
  ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATABASE_URL: DB,
  JWT_SECRET: randomBytes(32).toString('hex'), LAUNCHER_TOKEN_SECRET: randomBytes(32).toString('hex'),
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? randomBytes(32).toString('hex'), TRUSTED_PROXIES: 'loopback',
  HBBS_PRESENCE_HOST: '127.0.0.2', MONITOR_SWEEP: 'off', AUDIT_SEALER: 'off', CLIENT_UPDATE_SWEEP: 'off',
  PATCH_POLICY_SWEEP: 'off', METRIC_SWEEP: 'off',
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
// keeps the per-minute route limits per request, not per suite.
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
async function stepUp(s) {
  const r = await fetch(`${API}/auth/step-up`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip(), cookie: s.cookie }, body: JSON.stringify({ password: PW }) });
  const mm = (r.headers.get('set-cookie') ?? '').match(/step_up=([^;]+)/);
  if (r.status !== 200 || !mm) throw new Error(`step-up: ${r.status} ${await r.text()}`);
  s.cookie += `; step_up=${mm[1]}`;
}
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== false && v !== '').map(([k, v]) => [k, String(v)])).toString();
const list = (s, params = {}) => req('GET', `/endpoints/list?${qs({ pageSize: 200, ...params })}`, s);
const bulk = (s, body) => req('POST', '/endpoints/bulk', s, { body });
const msg = (r) => `HTTP ${r.status} ${JSON.stringify(r.body ?? r.text).slice(0, 400)}`;
const ids = (r) => (r.data?.rows ?? []).map((x) => x.id).sort();
const code = (r) => r.body?.message?.code ?? r.body?.code;
const same = (a, b) => J([...a].sort()) === J([...b].sort());

const created = { businesses: [], users: [] };

async function all() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });
  const roleUser = await prisma.role.findFirst({ where: { type: 'BUSINESS_USER' } });

  section('Fixtures (synthetic): Business A (9 computers), B (3), C (260, for the cap and the timing)');
  const A = await prisma.customer.create({ data: { tenantId: tenant.id, name: `${TAG} Acme` } });
  const B = await prisma.customer.create({ data: { tenantId: tenant.id, name: `${TAG} Birch` } });
  const C = await prisma.customer.create({ data: { tenantId: tenant.id, name: `${TAG} Cedar` } });
  created.businesses.push(A.id, B.id, C.id);
  const siteA = await prisma.site.create({ data: { tenantId: tenant.id, customerId: A.id, name: `${TAG} HQ` } });
  const siteB = await prisma.site.create({ data: { tenantId: tenant.id, customerId: B.id, name: `${TAG} HQ` } });

  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag, extra = {}) => { const u = await prisma.user.create({ data: { email: `dg-${tag}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'DG', lastName: tag, status: 'ACTIVE', ...extra } }); created.users.push(u.id); return u; };
  const admin = await mkUser('admin', { isPlatformAdmin: true });
  const ownerA = await mkUser('owner-a'), ownerB = await mkUser('owner-b'), userA = await mkUser('user-a');
  await prisma.membership.create({ data: { userId: ownerA.id, tenantId: tenant.id, customerId: A.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: ownerB.id, tenantId: tenant.id, customerId: B.id, roleId: roleOwner.id } });
  // A Business User: sees COMPANY_WIDE computers and the ASSIGNED_USERS ones granted to them; no monitoring:alerts.
  await prisma.membership.create({ data: { userId: userA.id, tenantId: tenant.id, customerId: A.id, roleId: roleUser.id, capabilities: ['computers:view'] } });

  const now = Date.now();
  const DAY = 86_400_000;
  const mkEp = async (biz, name, { site = null, online = true, ago = 60_000, platform = 'Windows', os = 'Windows 11 Pro', mode = 'COMPANY_WIDE', status = 'ACTIVE', rd = '1.2.0', inv = null, tags = [] } = {}) => {
    const e = await prisma.endpoint.create({ data: {
      tenantId: tenant.id, customerId: biz.id, siteId: site?.id ?? null, name, hostname: name.toLowerCase(), platform, osVersion: os,
      status, isOnline: online, isManaged: true, accessMode: mode, lastSeenAt: new Date(now - ago), agentVersion: '0.33.0', deviceClass: 'WORKSTATION',
    } });
    await prisma.rustdeskNode.create({ data: { tenantId: tenant.id, endpointId: e.id, rustdeskId: String(100000000 + ((Math.random() * 899999999) | 0)), version: rd } });
    if (inv) await prisma.endpointInventory.create({ data: { endpointId: e.id, ...inv } });
    for (const t of tags) await prisma.endpointTag.create({ data: { endpointId: e.id, tag: t } });
    return e;
  };
  const scanned = (n) => ({ pendingUpdateCount: n, pendingUpdates: Array.from({ length: n }, (_, i) => ({ title: `u${i}`, kb: `KB${i}`, severity: null })), updatesCheckedAt: new Date(now - 3600_000), rebootRequired: false });
  const SQLTAG = `x'); DELETE FROM "Endpoint"; --`;
  const a1 = await mkEp(A, `${TAG}-A1-KIOSK`, { site: siteA, rd: '1.2.0', inv: scanned(3), tags: ['kiosk'] });
  const a2 = await mkEp(A, `${TAG}-A2-AWAY`, { online: false, ago: 10 * DAY, rd: '1.4.1', inv: scanned(0) });
  const a3 = await mkEp(A, `${TAG}-A3-LINUX`, { platform: 'linux', os: 'Ubuntu 24.04', rd: '1.3.9' });
  const a4 = await mkEp(A, `${TAG}-A4-MAC-ASSIGNED`, { platform: 'macos', os: 'macOS 15', mode: 'ASSIGNED_USERS', rd: '1.10.0' });
  const a5 = await mkEp(A, `${TAG}-A5-NOT-GRANTED`, { mode: 'ASSIGNED_USERS', rd: '1.4.0', tags: [SQLTAG] });
  const a6 = await mkEp(A, `${TAG}-A6-ARCHIVED`, { status: 'ARCHIVED' });
  const a7 = await mkEp(A, `${TAG}-A7-CRITICAL`, { site: siteA, rd: '1.2.3' });
  const a8 = await mkEp(A, `${TAG}-A8-NIGHTLY`, { rd: '1.4.2-nightly' });
  const a9 = await mkEp(A, `${TAG}-A9-NEVER`, { online: false, ago: 400 * DAY, rd: '1.1' });
  await prisma.computerAccess.create({ data: { tenantId: tenant.id, endpointId: a4.id, userId: userA.id } });
  await prisma.monitorAlert.create({ data: { tenantId: tenant.id, customerId: A.id, endpointId: a7.id, ruleKey: `dg-${sfx}`, kind: 'DISK_FREE', dedupKey: `dg:${sfx}:a7`, severity: 'CRITICAL', title: `${TAG} alert`, detail: {} } });
  const b1 = await mkEp(B, `${TAG}-B1`, { site: siteB, tags: ['kiosk'] });
  const b2 = await mkEp(B, `${TAG}-B2-OFF`, { online: false, ago: 30 * DAY });
  const b3 = await mkEp(B, `${TAG}-B3-LINUX`, { platform: 'linux', os: 'Ubuntu 24.04' });
  const bIds = [b1.id, b2.id, b3.id];
  // C: 260 cheap computers, 210 of them tagged "big" — the 200 cap and the timing.
  await prisma.endpoint.createMany({ data: Array.from({ length: 260 }, (_, i) => ({
    tenantId: tenant.id, customerId: C.id, name: `${TAG}-C-${String(i).padStart(3, '0')}`, platform: i % 4 ? 'Windows' : 'linux', osVersion: 'x',
    status: 'ACTIVE', isOnline: i % 3 !== 0, isManaged: true, accessMode: 'COMPANY_WIDE', lastSeenAt: new Date(now - i * 3600_000), deviceClass: 'WORKSTATION',
  })) });
  const cEps = await prisma.endpoint.findMany({ where: { customerId: C.id }, select: { id: true }, orderBy: { name: 'asc' } });
  await prisma.endpointTag.createMany({ data: cEps.slice(0, 210).map((e) => ({ endpointId: e.id, tag: 'big' })) });
  check(true, 'created A (8 current + 1 archived), B (3), C (260), 4 users');

  const aCurrent = [a1, a2, a3, a4, a5, a7, a8, a9].map((e) => e.id);
  const aOnline = [a1, a3, a4, a5, a7, a8].map((e) => e.id);
  const userAsees = (xs) => xs.filter((id) => id !== a5.id);

  startApi();
  await waitUp();
  const S = { admin: await login(admin.email), ownerA: await login(ownerA.email), ownerB: await login(ownerB.email), userA: await login(userA.email) };
  const lastAudit = (action, resourceId) => prisma.activityLog.findFirst({ where: { action, resourceId }, orderBy: { createdAt: 'desc' } });
  const mkRule = (s, name, rule, extra = {}) => req('POST', '/device-groups', s, { body: { name: `${TAG} ${name}`, kind: 'rule', rule, ...extra } });

  // ── Create ────────────────────────────────────────────────────────────────
  section('Creating a rule group: same permission as a static group, audited with the rule');
  let r = await mkRule(S.ownerA, 'Online', { online: 'online' });
  check(r.status === 201 && r.data?.kind === 'rule' && J(r.data.rule) === J({ online: 'online' }), 'the Business Owner creates “Online”', msg(r));
  const gOnline = r.data;
  let au = await lastAudit('DEVICE_GROUP_CREATED', gOnline.id);
  check(au?.metadata?.kind === 'rule' && J(au.metadata.rule) === J({ online: 'online' }), 'DEVICE_GROUP_CREATED carries kind and rule', J(au?.metadata));
  check(await prisma.endpointGroupMember.count({ where: { endpointGroupId: gOnline.id } }) === 0, 'no member rows are stored');
  r = await mkRule(S.userA, 'Nope', { online: 'online' });
  check(r.status === 403, 'a Business User may not create one (manageRefusal)', msg(r));
  for (const [rule, why] of [
    [{ search: 'printer' }, 'search (free text)'], [{ businessId: B.id }, 'businessId'], [{ groupId: gOnline.id }, 'another group'], [{ online: 'online', where: '1=1' }, 'an unknown key'],
    [{ os: `'; DROP TABLE "Endpoint"; --` }, 'an OS term with SQL'], [{ rustdeskMin: `1.4' OR '1'='1` }, 'a version with SQL'], [{ notSeenDays: '1; select' }, 'days with SQL'], [{}, 'an empty rule'],
    [{ siteId: siteB.id }, 'another business’s site'],
  ]) {
    r = await mkRule(S.ownerA, `bad ${why}`, rule);
    check(r.status === 400 && code(r) === 'INVALID_RULE', `refused: ${why}`, msg(r));
  }
  r = await req('POST', '/device-groups', S.ownerA, { body: { name: `${TAG} static with rule`, rule: { online: 'online' } } });
  check(r.status === 400, 'a static group with a rule is refused', msg(r));
  r = await req('POST', '/device-groups', S.ownerA, { body: { name: `${TAG} rule without`, kind: 'rule' } });
  check(r.status === 400 && code(r) === 'INVALID_RULE', 'a rule group without a rule is refused', msg(r));

  // ── Membership ────────────────────────────────────────────────────────────
  section('Membership is the rule AND the business AND the reader’s visibility');
  r = await list(S.ownerA, { groupId: gOnline.id });
  check(r.status === 200 && same(ids(r), aOnline), 'the owner’s list: every online current computer of A, none of B or C', `${msg(r).slice(0, 120)} ${J(ids(r).length)}`);
  const facet = r.data?.facets.groups.find((g) => g.id === gOnline.id);
  check(facet?.kind === 'rule' && facet.count === aOnline.length, 'the facet offers it as a rule group with its live count', J(facet));
  const rowA1 = r.data?.rows.find((x) => x.id === a1.id);
  check(rowA1?.groups.some((g) => g.id === gOnline.id && g.kind === 'rule'), 'the Groups column lists it on the row', J(rowA1?.groups));
  r = await list(S.ownerA, { businessId: A.id });
  check(r.data?.rows.find((x) => x.id === a2.id)?.groups.every((g) => g.id !== gOnline.id), 'an offline computer’s row does not list it');
  r = await list(S.admin, { groupId: gOnline.id });
  check(same(ids(r), aOnline), 'the Platform Admin sees the same members (all of A’s)');
  r = await list(S.admin, { groupId: gOnline.id, businessId: B.id });
  check(r.status === 200 && ids(r).length === 0, 'with another business’s filter it lists nothing — the business is part of the rule');
  r = await list(S.ownerA, { groupId: gOnline.id, status: 'all' });
  check(same(ids(r), [...aOnline, a6.id]), 'the list’s own Archived filter still governs (the archived online one with “Include archived”)');

  section('A restricted Business User sees only their own computers in a rule group');
  r = await list(S.userA, { groupId: gOnline.id });
  check(r.status === 200 && same(ids(r), userAsees(aOnline)), 'the list omits the ASSIGNED_USERS computer not granted to them', J(ids(r).length));
  check(r.data?.facets.groups.find((g) => g.id === gOnline.id)?.count === userAsees(aOnline).length, 'the facet counts over what they can see');
  r = await req('GET', '/device-groups', S.userA);
  check(r.data?.groups.find((g) => g.id === gOnline.id)?.members === userAsees(aOnline).length, 'GET /device-groups counts over what they can see');
  r = await req('GET', '/device-groups', S.ownerA);
  check(r.data?.groups.find((g) => g.id === gOnline.id)?.members === aOnline.length && r.data.groups.find((g) => g.id === gOnline.id)?.kind === 'rule', 'the owner’s count is every member');

  section('Membership follows changes, with no sweep');
  await prisma.endpoint.update({ where: { id: a1.id }, data: { isOnline: false } });
  r = await list(S.ownerA, { groupId: gOnline.id });
  check(!ids(r).includes(a1.id) && ids(r).length === aOnline.length - 1, 'a computer that goes offline has left “Online” on the next read');
  r = await req('GET', '/device-groups', S.ownerA);
  check(r.data?.groups.find((g) => g.id === gOnline.id)?.members === aOnline.length - 1, 'and the group list count dropped');
  await prisma.endpoint.update({ where: { id: a1.id }, data: { isOnline: true } });
  r = await list(S.ownerA, { groupId: gOnline.id });
  check(ids(r).includes(a1.id), 'back online: back in the group');
  await prisma.endpoint.update({ where: { id: a3.id }, data: { customerId: B.id, siteId: null } });
  r = await list(S.ownerA, { groupId: gOnline.id });
  const rB = await list(S.ownerB, { groupId: gOnline.id });
  check(!ids(r).includes(a3.id) && !ids(rB).includes(a3.id), 'a computer moved to B leaves A’s rule group, and B does not see it through A’s group');
  await prisma.endpoint.update({ where: { id: a3.id }, data: { customerId: A.id } });

  section('Each filter means what it means on the list');
  const cases = [
    ['platform linux', { platform: 'linux' }, [a3.id]],
    ['platform macos', { platform: 'macos' }, [a4.id]],
    ['platform windows + online', { platform: 'windows', online: 'online' }, [a1.id, a5.id, a7.id, a8.id]],
    ['site', { siteId: siteA.id }, [a1.id, a7.id]],
    ['tag', { tag: 'kiosk' }, [a1.id]],
    ['patches pending', { patches: 'pending' }, [a1.id]],
    ['patches current', { patches: 'current' }, [a2.id]],
    ['patches unknown', { patches: 'unknown' }, [a3.id, a4.id, a5.id, a7.id, a8.id, a9.id]],
    ['RustDesk ≥ 1.4 (1.10 > 1.9, numerically; a nightly never matches)', { rustdeskMin: '1.4' }, [a2.id, a4.id, a5.id]],
    ['RustDesk ≤ 1.3.9', { rustdeskMax: '1.3.9' }, [a1.id, a3.id, a7.id, a9.id]],
    ['RustDesk 1.2 – 1.2.99', { rustdeskMin: '1.2', rustdeskMax: '1.2.99' }, [a1.id, a7.id]],
    ['not seen for 7 days', { notSeenDays: '7' }, [a2.id, a9.id]],
    ['seen within 1 day', { seenWithinDays: '1' }, aOnline],
    ['critical alerts', { alerts: 'critical' }, [a7.id]],
  ];
  const groupIds = {};
  for (const [name, rule, want] of cases) {
    r = await mkRule(S.ownerA, name.slice(0, 40), rule);
    if (r.status !== 201) { check(false, `create “${name}”`, msg(r)); continue; }
    groupIds[name] = r.data.id;
    const viaGroup = await list(S.ownerA, { groupId: r.data.id });
    const viaList = await list(S.ownerA, { businessId: A.id, ...rule });
    check(same(ids(viaGroup), want) && same(ids(viaList), want), `${name}: the group and the list with the same filters agree`, `group ${J(ids(viaGroup))} list ${J(ids(viaList))} want ${J([...want].sort())}`);
  }

  section('A rule on alerts needs monitoring:alerts');
  const gCrit = groupIds['critical alerts'];
  r = await list(S.userA, { groupId: gCrit });
  check(r.status === 403, 'filtering by it is refused for a viewer without alerts (membership would disclose alert state)', msg(r));
  r = await list(S.userA, {});
  check(r.status === 200 && !r.data.facets.groups.some((g) => g.id === gCrit) && !r.data.rows.some((x) => x.groups.some((g) => g.id === gCrit)), 'it is not in their facet or on any row');
  r = await req('GET', '/device-groups', S.userA);
  check(r.data?.groups.find((g) => g.id === gCrit)?.members === null, 'GET /device-groups gives members: null (not evaluated) for them');
  r = await bulk(S.userA, { action: 'inventory.refresh', targetGroupId: gCrit });
  check(r.status === 403, 'and bulk on it is refused', msg(r));

  // ── A/B ───────────────────────────────────────────────────────────────────
  section('Business A/B isolation');
  r = await mkRule(S.ownerB, 'Online', { online: 'online' });
  check(r.status === 201, 'B’s owner makes B’s own “Online” (names are per business)', msg(r));
  const gOnlineB = r.data;
  r = await list(S.ownerB, { groupId: gOnlineB.id });
  check(same(ids(r), [b1.id, b3.id]), 'B’s rule group lists only B’s online computers');
  r = await list(S.ownerB, { groupId: gOnline.id });
  check(r.status === 200 && ids(r).length === 0, 'A’s rule group, named by B, lists nothing — the same as a made-up id');
  check(!r.data?.facets.groups.some((g) => g.id === gOnline.id), 'B’s facet never offers A’s group');
  r = await list(S.ownerA, {});
  check(!r.data?.facets.groups.some((g) => g.id === gOnlineB.id) && !r.data.rows.some((x) => x.groups.some((g) => g.id === gOnlineB.id)), 'and A’s never offers B’s');
  r = await req('PATCH', `/device-groups/${gOnline.id}`, S.ownerB, { body: { rule: { online: 'offline' } } });
  check(r.status === 404, 'B cannot edit A’s rule group (404)', msg(r));
  r = await req('DELETE', `/device-groups/${gOnline.id}`, S.ownerB);
  check(r.status === 404, 'nor delete it (404)', msg(r));
  r = await bulk(S.ownerB, { action: 'inventory.refresh', targetGroupId: gOnline.id });
  check(r.status === 404, 'nor act on it in bulk (404)', msg(r));
  r = await req('GET', '/device-groups', S.ownerB);
  check(!r.data?.groups.some((g) => g.id === gOnline.id), 'nor see it listed');

  // ── Hand membership ───────────────────────────────────────────────────────
  section('A rule group cannot be added to');
  r = await bulk(S.ownerA, { action: 'group.add', groupId: gOnline.id, endpointIds: [a2.id] });
  check(r.status === 400 && code(r) === 'RULE_GROUP', 'bulk group.add is refused (RULE_GROUP)', msg(r));
  r = await bulk(S.ownerA, { action: 'group.remove', groupId: gOnline.id, endpointIds: [a1.id] });
  check(r.status === 400 && code(r) === 'RULE_GROUP', 'bulk group.remove is refused too', msg(r));
  await stepUp(S.admin);
  r = await req('POST', '/enrollment/tokens', S.admin, { body: { businessId: A.id, accessMode: 'COMPANY_WIDE', endpointGroupId: gOnline.id } });
  check(r.status === 400 && code(r) === 'RULE_GROUP', 'an enrolment token cannot name a rule group', msg(r));
  let dbErr = null;
  try { await prisma.endpointGroupMember.create({ data: { endpointGroupId: gOnline.id, endpointId: a2.id } }); } catch (e) { dbErr = e; }
  check(dbErr && /rule group/.test(String(dbErr.message)), 'a direct database insert is refused by the 0053 trigger', String(dbErr?.message).slice(0, 200));
  const gStatic = (await req('POST', '/device-groups', S.ownerA, { body: { name: `${TAG} Static` } })).data;
  dbErr = null;
  try { await prisma.endpointGroup.update({ where: { id: gStatic.id }, data: { kind: 'RULE', rule: { online: 'online' } } }); } catch (e) { dbErr = e; }
  check(dbErr && /kind is fixed/.test(String(dbErr.message)), 'a group’s kind cannot change, even in the database', String(dbErr?.message).slice(0, 200));
  dbErr = null;
  try { await prisma.endpointGroup.update({ where: { id: gOnline.id }, data: { rule: null } }); } catch (e) { dbErr = e; }
  check(dbErr && /rule_matches_kind/.test(String(dbErr.message)), 'a rule group without a rule is refused by the CHECK', String(dbErr?.message).slice(0, 200));
  r = await req('PATCH', `/device-groups/${gStatic.id}`, S.ownerA, { body: { rule: { online: 'online' } } });
  check(r.status === 400 && code(r) === 'NOT_A_RULE_GROUP', 'PATCH cannot give a static group a rule', msg(r));
  r = await req('PATCH', `/device-groups/${gOnline.id}`, S.ownerA, { body: { kind: 'static' } });
  check(r.status === 400, 'PATCH cannot change kind (unknown field)', msg(r));

  // ── Edit ──────────────────────────────────────────────────────────────────
  section('Editing the rule: membership moves at once, audited before and after');
  r = await req('PATCH', `/device-groups/${gOnline.id}`, S.userA, { body: { rule: { online: 'offline' } } });
  check(r.status === 403, 'a Business User may not edit it', msg(r));
  r = await req('PATCH', `/device-groups/${gOnline.id}`, S.ownerA, { body: { rule: { online: 'offline' }, name: `${TAG} Offline` } });
  check(r.status === 200 && J(r.data?.rule) === J({ online: 'offline' }), 'the owner changes the rule and the name (no step-up asked)', msg(r));
  au = await lastAudit('DEVICE_GROUP_UPDATED', gOnline.id);
  check(J(au?.metadata?.before?.rule) === J({ online: 'online' }) && J(au?.metadata?.after?.rule) === J({ online: 'offline' }) && au.metadata.kind === 'rule', 'DEVICE_GROUP_UPDATED carries the rule before and after', J(au?.metadata));
  r = await list(S.ownerA, { groupId: gOnline.id });
  check(same(ids(r), [a2.id, a9.id]), 'the group now lists A’s offline computers');
  r = await req('PATCH', `/device-groups/${gOnline.id}`, S.ownerA, { body: { rule: { search: 'x' } } });
  check(r.status === 400 && code(r) === 'INVALID_RULE', 'an edit is validated like a create');
  await req('PATCH', `/device-groups/${gOnline.id}`, S.ownerA, { body: { rule: { online: 'online' }, name: `${TAG} Online` } });

  section('A stored rule that no longer parses matches nothing');
  const gBroken = (await mkRule(S.ownerA, 'Broken', { online: 'online' })).data;
  await prisma.endpointGroup.update({ where: { id: gBroken.id }, data: { rule: { online: 'sometimes' } } });
  r = await list(S.ownerA, { groupId: gBroken.id });
  check(r.status === 200 && ids(r).length === 0, 'the list shows nothing for it — never the whole business');
  r = await req('GET', '/device-groups', S.ownerA);
  const gb = r.data?.groups.find((g) => g.id === gBroken.id);
  check(gb?.members === 0 && gb.ruleReadable === false, 'the group list says the rule is unreadable', J(gb));

  // ── Bulk ──────────────────────────────────────────────────────────────────
  section('Bulk on a rule group: membership resolved at request time, then the per-computer checks');
  r = await bulk(S.ownerA, { action: 'inventory.refresh', targetGroupId: gOnline.id });
  check(r.status === 200 && r.data?.target?.kind === 'rule' && r.data.target.resolved === aOnline.length && same(r.data.results.map((x) => x.endpointId), aOnline),
    'the owner’s refresh resolves to the six online computers of A', msg(r));
  check(r.data?.results.every((x) => x.ok || x.code), 'each has its own result');
  const bulkAudit = await prisma.activityLog.findFirst({ where: { action: 'DEVICE_BULK_ACTION', actorId: ownerA.id }, orderBy: { createdAt: 'desc' } });
  check(bulkAudit?.metadata?.targetGroup?.id === gOnline.id && bulkAudit.metadata.targetGroup.kind === 'rule' && bulkAudit.metadata.targetGroup.resolved === aOnline.length, 'DEVICE_BULK_ACTION names the group and the resolved count', J(bulkAudit?.metadata));
  await prisma.endpoint.update({ where: { id: a8.id }, data: { isOnline: false } });
  r = await bulk(S.ownerA, { action: 'inventory.refresh', targetGroupId: gOnline.id });
  check(r.status === 200 && r.data.target.resolved === aOnline.length - 1 && !r.data.results.some((x) => x.endpointId === a8.id), 'resolved again at the next request: the computer that went offline is not acted on');
  await prisma.endpoint.update({ where: { id: a8.id }, data: { isOnline: true } });
  r = await bulk(S.userA, { action: 'inventory.refresh', targetGroupId: gOnline.id });
  check(r.status === 200 && same(r.data.results.map((x) => x.endpointId), userAsees(aOnline)), 'a Business User’s bulk resolves only the members they can see', msg(r));
  r = await bulk(S.ownerA, { action: 'client.update', targetGroupId: gOnline.id });
  check(r.status === 200 && r.data.results.every((x) => !x.ok && x.code === 'NOT_ALLOWED'), 'client update on it keeps the single action’s rule (Platform Admin only)', msg(r));
  r = await bulk(S.ownerA, { action: 'group.add', groupId: gStatic.id, targetGroupId: groupIds['platform linux'] });
  check(r.status === 200 && r.data.succeeded === 1, 'a rule group’s members can be copied into a static group', msg(r));
  check(same((await prisma.endpointGroupMember.findMany({ where: { endpointGroupId: gStatic.id } })).map((m) => m.endpointId), [a3.id]), 'the static group now holds them as rows');
  r = await bulk(S.ownerA, { action: 'inventory.refresh', targetGroupId: gStatic.id });
  check(r.status === 200 && r.data.target.kind === 'static' && r.data.target.resolved === 1, 'bulk on a static group resolves its member rows the same way');
  r = await bulk(S.ownerA, { action: 'inventory.refresh', targetGroupId: gOnline.id, endpointIds: [a1.id] });
  check(r.status === 400, 'a selection and a target together are refused', msg(r));

  section('More than 200 is refused, never cut');
  r = await mkRule(S.admin, 'Big', { tag: 'big' }, { businessId: C.id });
  const gBig = r.data;
  check(r.status === 201, 'the Platform Admin makes a rule group in C', msg(r));
  r = await bulk(S.admin, { action: 'inventory.refresh', targetGroupId: gBig.id });
  check(r.status === 400 && code(r) === 'BULK_TOO_LARGE' && /210/.test(String(r.body?.message?.message ?? r.body?.message)), 'a rule matching 210 computers is refused with the number', msg(r));
  check(await prisma.endpointCommand.count({ where: { endpoint: { customerId: C.id } } }) === 0 && await prisma.privilegedActivity.count({ where: { identity: `user:${admin.id}` } }) === 0, 'and nothing was sent to any of them');

  // ── SQL ───────────────────────────────────────────────────────────────────
  section('A rule is never SQL');
  const before = await prisma.endpoint.count();
  r = await mkRule(S.ownerA, 'SQL tag', { tag: SQLTAG });
  check(r.status === 201 && r.data.rule.tag === SQLTAG, 'a tag that reads as SQL is stored as a plain value', msg(r));
  r = await list(S.ownerA, { groupId: r.data.id });
  check(r.status === 200 && same(ids(r), [a5.id]), 'it matches exactly the one computer carrying that tag — a bound parameter, compared as text', msg(r));
  check(await prisma.endpoint.count() === before, 'and nothing was deleted');
  const built = readFileSync(path.join(dist, 'endpoints', 'endpoint-list.service.js'), 'utf8');
  check(!/\$queryRawUnsafe|\$executeRawUnsafe/.test(built), 'the built list service has no $queryRawUnsafe / $executeRawUnsafe');
  check((built.match(/Prisma\.raw\(/g) ?? []).length === 1, 'and exactly one Prisma.raw (the whitelisted ORDER BY), so no rule value can reach raw SQL text');

  // ── CSV ───────────────────────────────────────────────────────────────────
  section('CSV: the group filter and the Groups column');
  r = await req('GET', `/endpoints/list/export.csv?${qs({ groupId: gOnline.id })}`, S.ownerA, { raw: true });
  const lines = r.text.replace(/^\uFEFF/, '').trim().split('\r\n');
  check(r.status === 200 && lines.length === 1 + aOnline.length, 'the export of a rule group has its members', `${r.status} ${lines.length}`);
  const a1line = lines.find((l) => l.includes(`${TAG}-A1-KIOSK`)) ?? '';
  check(a1line.includes(`${TAG} Online`) && a1line.includes(`${TAG} tag`) && !a1line.includes(`${TAG} Offline`), 'the Groups cell lists the rule groups the computer is in now', a1line.slice(0, 300));
  const exAudit = await prisma.activityLog.findFirst({ where: { action: 'ENDPOINT_LIST_EXPORTED', actorId: ownerA.id }, orderBy: { createdAt: 'desc' } });
  check(exAudit?.metadata?.filters?.groupId === gOnline.id && J(exAudit.metadata.filters.groupRule) !== undefined && exAudit.metadata.filters.groupRule?.online === 'online', 'the export audit records the rule it was evaluated with', J(exAudit?.metadata?.filters));
  r = await req('GET', `/endpoints/list/export.csv?${qs({ groupId: gOnline.id })}`, S.userA, { raw: true });
  check(r.status === 200 && !r.text.includes(`${TAG}-A5-NOT-GRANTED`), 'a Business User’s export of it omits what they cannot see');

  // ── Delete ────────────────────────────────────────────────────────────────
  section('Deleting a rule group');
  r = await req('DELETE', `/device-groups/${gBroken.id}`, S.ownerA);
  check(r.status === 200 && r.data.membersReleased === 0, 'deleted; no member rows to release', msg(r));
  au = await lastAudit('DEVICE_GROUP_DELETED', gBroken.id);
  check(au?.metadata?.kind === 'rule' && au.metadata.rule?.online === 'sometimes', 'DEVICE_GROUP_DELETED carries the rule it had', J(au?.metadata));

  // ── Cost ──────────────────────────────────────────────────────────────────
  section('Cost of computing membership on read (measured, not assumed)');
  const time = async (s, params) => {
    const ts = [];
    for (let i = 0; i < 7; i++) { const t = performance.now(); const x = await list(s, params); if (x.status !== 200) throw new Error(msg(x)); ts.push(performance.now() - t); }
    ts.sort((a, b) => a - b);
    return ts[3];
  };
  await prisma.endpointGroup.deleteMany({ where: { customerId: C.id } });
  const base = await time(S.admin, { businessId: C.id });
  const mix = [{ online: 'online' }, { platform: 'linux' }, { tag: 'big' }, { notSeenDays: '3' }, { patches: 'unknown' }, { rustdeskMin: '1.0' }, { online: 'offline', platform: 'windows' }, { seenWithinDays: '2' }];
  for (let i = 0; i < 20; i++) await mkRule(S.admin, `C${i}`, mix[i % mix.length], { businessId: C.id });
  const withRules = await time(S.admin, { businessId: C.id });
  const cGroup = (await prisma.endpointGroup.findFirst({ where: { customerId: C.id, kind: 'RULE', name: `${TAG} C0` } })).id;
  const filtered = await time(S.admin, { groupId: cGroup });
  console.log(`      list of C (260 computers), median of 7: ${base.toFixed(0)} ms with no rule groups, ${withRules.toFixed(0)} ms with 20 (facet + column), ${filtered.toFixed(0)} ms filtered by one`);
  check(withRules < 2000, `20 rule groups over 260 computers stay interactive (${withRules.toFixed(0)} ms < 2000 ms)`);
}

async function cleanup() {
  await stopApi();
  try {
    const bz = created.businesses;
    const eps = (await prisma.endpoint.findMany({ where: { customerId: { in: bz } }, select: { id: true } })).map((e) => e.id);
    const idents = created.users.map((u) => `user:${u}`);
    await prisma.privilegedActivity.deleteMany({ where: { identity: { in: idents } } });
    await prisma.identityPause.deleteMany({ where: { identity: { in: idents } } });
    await prisma.deviceClaimToken.deleteMany({ where: { customerId: { in: bz } } });
    await prisma.monitorAlert.deleteMany({ where: { customerId: { in: bz } } });
    await prisma.endpointCommand.deleteMany({ where: { endpointId: { in: eps } } });
    await prisma.computerAccess.deleteMany({ where: { endpointId: { in: eps } } });
    await prisma.endpointTag.deleteMany({ where: { endpointId: { in: eps } } });
    await prisma.endpointInventory.deleteMany({ where: { endpointId: { in: eps } } });
    await prisma.rustdeskNode.deleteMany({ where: { endpointId: { in: eps } } });
    await prisma.endpointGroup.deleteMany({ where: { customerId: { in: bz } } });
    await prisma.endpoint.deleteMany({ where: { id: { in: eps } } });
    await prisma.site.deleteMany({ where: { customerId: { in: bz } } });
    await prisma.membership.deleteMany({ where: { customerId: { in: bz } } });
    await prisma.customer.deleteMany({ where: { id: { in: bz } } });
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
