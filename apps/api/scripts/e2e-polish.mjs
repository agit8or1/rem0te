#!/usr/bin/env node
/**
 * End-to-end proof of the 0.35 follow-ups that touch the API.
 *
 *   1. GET /endpoints/:id lists every group the computer is in — its static
 *      groups AND the rule groups of its business it matches — evaluated as
 *      the caller sees them:
 *        - exactly the device list's own Groups column for that computer,
 *          for every viewer (Platform Admin, Business Owner, Business User);
 *        - a rule group whose rule reads alerts is left out for a viewer
 *          without monitoring:alerts (as the list's facet leaves it out);
 *        - computed on every read: a computer that goes offline leaves an
 *          "online" rule group at once, and an archived computer still shows
 *          the rule groups it matches;
 *        - business A/B isolation: B's groups (one with the same name and an
 *          identical rule) never appear on A's computers, and B's owner gets
 *          404 for A's computer.
 *   2. The dashboard's restart reason names the computer's own operating
 *      system: "Linux is waiting for a restart" for a Linux server (it said
 *      "Windows is"), "Windows is" for Windows, "the computer is" for an
 *      unreported platform — and another business's computers are never in
 *      the queue.
 *   3. Scheduled-report ownership, which the web app's "Schedule this
 *      report" link mirrors (useMayOwnSchedules): may.create for a Platform
 *      Admin and a Business Owner; 403 for a Business User.
 *   4. Reachable is not reporting: a computer with isOnline (RustDesk can see
 *      it) whose agent has been silent past the heartbeat window is
 *      `agent_silent`, never `online` — on the device list (row, server-side
 *      `online=silent` filter, sort, CSV), the device page, GET /endpoints,
 *      My computers, search, the dashboard overview and GET /dashboard — and
 *      an "online" rule group leaves it out. Business B's silent computer
 *      appears in none of A's answers.
 *
 * Self-starting: its own API from dist/ on POLISH_API_PORT (3551) against
 * DATABASE_URL, which must name a scratch/test database.
 *
 * Run:  DATABASE_URL=…/rem0te_polish_test node scripts/e2e-polish.mjs
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
const PORT = Number(process.env.POLISH_API_PORT ?? 3551);
if ([3000, 3001, 443, 4000, 4001].includes(PORT)) { console.error(`Refusing port ${PORT}: production or the docs stack.`); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'polish-e2e-password-1';
const TAG = `PL${sfx}`;

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
  PATCH_POLICY_SWEEP: 'off', METRIC_SWEEP: 'off', RETENTION_SWEEP: 'off', REPORT_SCHEDULE_SWEEP: 'off',
  SCRIPT_OUTPUT_SWEEP: 'off', CHAT_RETENTION_SWEEP: 'off',
  // The agent-silent fixtures are reachable (isOnline) with old heartbeats; with no hbbs here the stale sweep would take them offline after a minute.
  STALE_SWEEP: 'off',
  // Never the deploy target's GeoIP file: the map is not exercised here.
  GEOIP_DB_PATH: path.join(here, '.no-geoip.mmdb'),
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

// Paced under the 20 req/s burst throttler.
let last = 0;
async function req(method, p, s, { body, headers = {} } = {}) {
  const wait = last + 60 - Date.now(); if (wait > 0) await sleep(wait); last = Date.now();
  const h = { 'content-type': 'application/json', 'x-forwarded-for': ip(), ...headers };
  if (s) h.cookie = s.cookie;
  const r = await fetch(`${API}${p}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j, data: j?.data };
}
async function login(email) {
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip() }, body: JSON.stringify({ email, password: PW }) });
  const mm = (r.headers.get('set-cookie') ?? '').match(/access_token=([^;]+)/);
  if (r.status !== 200 || !mm) throw new Error(`login ${email}: ${r.status} ${await r.text()}`);
  return { cookie: `access_token=${mm[1]}` };
}
const msg = (r) => `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 400)}`;
/** A group list as "name/kind", in the order the server sent it. */
const names = (gs) => (gs ?? []).map((g) => `${g.name.replace(`${TAG} `, '')}/${g.kind}`);

const created = { businesses: [], users: [] };

async function all() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });
  const roleUser = await prisma.role.findFirst({ where: { type: 'BUSINESS_USER' } });

  section('Fixtures (synthetic): businesses A, B and R; static and rule groups in A and B');
  const A = await prisma.customer.create({ data: { tenantId: tenant.id, name: `${TAG} Acme` } });
  const B = await prisma.customer.create({ data: { tenantId: tenant.id, name: `${TAG} Birch` } });
  const R = await prisma.customer.create({ data: { tenantId: tenant.id, name: `${TAG} Restart` } });
  created.businesses.push(A.id, B.id, R.id);
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag, extra = {}) => { const u = await prisma.user.create({ data: { email: `pl-${tag}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'PL', lastName: tag, status: 'ACTIVE', ...extra } }); created.users.push(u.id); return u; };
  const admin = await mkUser('admin', { isPlatformAdmin: true });
  const ownerA = await mkUser('owner-a'), ownerB = await mkUser('owner-b'), ownerR = await mkUser('owner-r'), userA = await mkUser('user-a');
  await prisma.membership.create({ data: { userId: ownerA.id, tenantId: tenant.id, customerId: A.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: ownerB.id, tenantId: tenant.id, customerId: B.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: ownerR.id, tenantId: tenant.id, customerId: R.id, roleId: roleOwner.id } });
  // A Business User: computers:view only — no monitoring:alerts.
  await prisma.membership.create({ data: { userId: userA.id, tenantId: tenant.id, customerId: A.id, roleId: roleUser.id, capabilities: ['computers:view'] } });

  const now = Date.now();
  const mkEp = (biz, name, extra = {}) => prisma.endpoint.create({ data: {
    tenantId: tenant.id, customerId: biz.id, name, hostname: name.toLowerCase(), platform: 'Windows', osVersion: 'Windows 11 Pro',
    status: 'ACTIVE', isOnline: true, isManaged: true, accessMode: 'COMPANY_WIDE', lastSeenAt: new Date(now - 60_000), agentVersion: '0.34.0', deviceClass: 'WORKSTATION',
    ...extra,
  } });
  const a1 = await mkEp(A, `${TAG}-A1-DESK`);
  const a2 = await mkEp(A, `${TAG}-A2-LINUX`, { platform: 'linux', osVersion: 'Ubuntu 24.04', isOnline: false, lastSeenAt: new Date(now - 3 * 86400_000) });
  const a3 = await mkEp(A, `${TAG}-A3-ALERTING`);
  const a4 = await mkEp(A, `${TAG}-A4-ARCHIVED-LINUX`, { platform: 'linux', osVersion: 'Debian 12', status: 'ARCHIVED', isOnline: false });
  const b1 = await mkEp(B, `${TAG}-B1`);
  // 0.35 item 7: reachable through RustDesk (isOnline) with the agent silent twelve days; and reachable with no agent report at all.
  const silentAt = new Date(now - 12 * 86400_000 - 3600_000);
  const a5 = await mkEp(A, `${TAG}-A5-SILENT`, { lastSeenAt: silentAt });
  const a6 = await mkEp(A, `${TAG}-A6-NEVER`, { lastSeenAt: null });
  const b2 = await mkEp(B, `${TAG}-B2-SILENT`, { lastSeenAt: silentAt });
  await prisma.monitorAlert.create({ data: { tenantId: tenant.id, customerId: A.id, endpointId: a3.id, ruleKey: `pl-${sfx}`, kind: 'DISK_FREE', dedupKey: `pl:${sfx}:a3`, severity: 'CRITICAL', title: `${TAG} disk`, detail: {} } });

  const group = (biz, name, rule = null, members = []) => prisma.endpointGroup.create({ data: {
    tenantId: tenant.id, customerId: biz.id, name: `${TAG} ${name}`, ...(rule ? { kind: 'RULE', rule } : {}),
    ...(members.length ? { members: { create: members.map((e) => ({ endpointId: e.id })) } } : {}),
  } });
  const gFront = await group(A, 'Front desk', null, [a1]);
  const gOnline = await group(A, 'Online', { online: 'online' });
  const gLinux = await group(A, 'Linux', { platform: 'linux' });
  const gAlert = await group(A, 'Alerting', { alerts: 'any' });
  // B: the same name and rule as A's, and a static group holding B's own computer.
  const gBOnline = await group(B, 'Online', { online: 'online' });
  const gBStatic = await group(B, 'Front desk', null, [b1]);
  const bIds = new Set([gBOnline.id, gBStatic.id]);

  // R: one computer per platform, each with a fresh basic scan that says a restart is pending.
  const scan = { updatesCheckedAt: new Date(now - 3600_000), pendingUpdates: [], pendingUpdateCount: 0, rebootRequired: true };
  const rWin = await mkEp(R, `${TAG}-R-WIN`);
  const rLin = await mkEp(R, `${TAG}-R-LINUX`, { platform: 'linux', osVersion: 'Ubuntu 24.04' });
  const rNone = await mkEp(R, `${TAG}-R-UNKNOWN`, { platform: null, osVersion: null });
  for (const e of [rWin, rLin, rNone]) await prisma.endpointInventory.create({ data: { endpointId: e.id, ...scan } });
  check(true, `created A (6 computers, 1 archived, 2 agent-silent), B (2, 1 agent-silent), R (3); ${TAG}`);

  startApi();
  await waitUp();
  const S = { admin: await login(admin.email), ownerA: await login(ownerA.email), ownerB: await login(ownerB.email), ownerR: await login(ownerR.email), userA: await login(userA.email) };

  // ── 1. Groups on the device page ──────────────────────────────────────────
  section('GET /endpoints/:id: static and rule groups, as the caller sees them');
  const groupsOf = async (s, e) => { const r = await req('GET', `/endpoints/${e.id}`, s); return { r, g: r.data?.groups }; };
  let { r, g } = await groupsOf(S.ownerA, a1);
  check(r.status === 200 && J(names(g)) === J(['Front desk/static', 'Online/rule']), 'the Business Owner sees A1 in its static group and the "online" rule group, by name', `${msg(r)} ${J(names(g))}`);
  check(g?.every((x) => typeof x.id === 'string' && !bIds.has(x.id)), "none of them is Business B's — not its same-named rule group, not its static group", J(g));
  ({ g } = await groupsOf(S.ownerA, a2));
  check(J(names(g)) === J(['Linux/rule']), 'an offline Linux computer is in the Linux rule group only', J(names(g)));
  ({ g } = await groupsOf(S.ownerA, a3));
  check(J(names(g)) === J(['Alerting/rule', 'Online/rule']), 'a computer with an open alert is in the alert-rule group for the owner', J(names(g)));
  ({ r, g } = await groupsOf(S.userA, a3));
  check(r.status === 200 && J(names(g)) === J(['Online/rule']), 'a Business User without monitoring:alerts is not shown the alert-rule group (its rule reads alerts)', `${msg(r)} ${J(names(g))}`);
  ({ g } = await groupsOf(S.ownerA, a4));
  check(J(names(g)) === J(['Linux/rule']), 'an archived Linux computer still shows the rule group it matches', J(names(g)));
  ({ g } = await groupsOf(S.admin, a1));
  check(J(names(g)) === J(['Front desk/static', 'Online/rule']), 'the Platform Admin sees the same groups for A1', J(names(g)));

  section('The device page agrees with the device list, for every viewer');
  for (const [who, s, statusQ] of [['Platform Admin', S.admin, 'all'], ['Business Owner', S.ownerA, 'all'], ['Business User', S.userA, 'all']]) {
    const lr = await req('GET', `/endpoints/list?search=${TAG}-A&status=${statusQ}&pageSize=200${who === 'Platform Admin' ? `&businessId=${A.id}` : ''}`, s);
    const rows = lr.data?.rows ?? [];
    const diffs = [];
    for (const row of rows) {
      const d = await req('GET', `/endpoints/${row.id}`, s);
      const want = J((row.groups ?? []).map((x) => ({ id: x.id, kind: x.kind })));
      const got = J((d.data?.groups ?? []).map((x) => ({ id: x.id, kind: x.kind })));
      if (want !== got) diffs.push(`${row.name}: list ${want} page ${got}`);
    }
    check(lr.status === 200 && rows.length >= 3 && diffs.length === 0, `${who}: each of A's ${rows.length} computers shows the same groups on its page as in the list's Groups column`, `${msg(lr).slice(0, 200)} ${diffs.join('; ')}`);
  }

  section('Computed on every read');
  await prisma.endpoint.update({ where: { id: a1.id }, data: { isOnline: false } });
  ({ g } = await groupsOf(S.ownerA, a1));
  check(J(names(g)) === J(['Front desk/static']), 'A1 going offline leaves the "online" rule group at once; its static group stays', J(names(g)));
  await prisma.endpoint.update({ where: { id: a1.id }, data: { isOnline: true } });
  ({ g } = await groupsOf(S.ownerA, a1));
  check(J(names(g)) === J(['Front desk/static', 'Online/rule']), 'and back online, it is in it again', J(names(g)));
  await prisma.endpointGroup.update({ where: { id: gLinux.id }, data: { rule: { platform: 'windows' } } });
  ({ g } = await groupsOf(S.ownerA, a2));
  check(J(names(g)) === J([]), 'editing a rule moves the membership: the Linux computer leaves a group that now selects Windows', J(names(g)));
  await prisma.endpointGroup.update({ where: { id: gLinux.id }, data: { rule: { platform: 'linux' } } });

  section('Business isolation');
  r = await req('GET', `/endpoints/${a1.id}`, S.ownerB);
  check(r.status === 404, "B's owner gets 404 for A's computer — groups and all", msg(r));
  ({ r, g } = await groupsOf(S.ownerB, b1));
  check(r.status === 200 && J(names(g)) === J(['Front desk/static', 'Online/rule']) && g.every((x) => bIds.has(x.id)), "B's own computer shows only B's groups", J(g));
  check(![gFront.id, gOnline.id, gLinux.id, gAlert.id].some((id) => (g ?? []).some((x) => x.id === id)), "and none of A's");

  // ── 2. Restart wording on the dashboard ───────────────────────────────────
  section('Dashboard: the restart reason names the computer\'s own operating system');
  r = await req('GET', '/dashboard/overview', S.ownerR);
  const items = r.data?.queue?.items ?? [];
  const reason = (e) => items.find((i) => i.key === `restart:${e.id}`)?.reason ?? '';
  check(r.status === 200 && r.data?.restart?.devices === 3, 'three restart-pending computers in R', `${msg(r).slice(0, 300)}`);
  check(/Linux is waiting for a restart/.test(reason(rLin)) && !/Windows/.test(reason(rLin)), `Linux: "${reason(rLin)}"`);
  check(/Windows is waiting for a restart/.test(reason(rWin)), `Windows: "${reason(rWin)}"`);
  check(/the computer is waiting for a restart/.test(reason(rNone)) && !/Windows|Linux/.test(reason(rNone)), `no platform reported: "${reason(rNone)}"`);
  r = await req('GET', '/dashboard/overview', S.ownerA);
  check(r.status === 200 && !(r.data?.queue?.items ?? []).some((i) => [rWin.id, rLin.id, rNone.id].some((id) => i.key === `restart:${id}`)) && (r.data?.restart?.devices ?? 0) === 0,
    "A's owner sees none of R's restart items", J(r.data?.restart));

  // ── 3. Who may own a schedule (the link's rule) ───────────────────────────
  section('Scheduled reports: who may own one (what "Schedule this report" mirrors)');
  r = await req('GET', '/reports/schedules', S.admin);
  check(r.status === 200 && r.data?.may?.create === true, 'Platform Admin: may create', msg(r).slice(0, 200));
  r = await req('GET', `/reports/schedules?businessId=${A.id}`, S.admin);
  check(r.status === 200 && r.data?.may?.create === true, "Platform Admin, for A: may create", msg(r).slice(0, 200));
  r = await req('GET', '/reports/schedules', S.ownerA);
  check(r.status === 200 && r.data?.may?.create === true, 'Business Owner: may create for their business', msg(r).slice(0, 200));
  r = await req('GET', `/reports/schedules?businessId=${B.id}`, S.ownerA);
  check(r.status === 404, "Business Owner of A, for B: 404, as if B did not exist", msg(r).slice(0, 200));
  r = await req('GET', '/reports/schedules', S.userA);
  check(r.status === 403, 'Business User: refused (the link is not shown to them)', msg(r).slice(0, 200));

  // ── 4. Reachable is not reporting ─────────────────────────────────────────
  section('Connectivity: online, agent silent (reachable through RustDesk), offline');
  const ids = (rows) => J((rows ?? []).map((x) => x.id).sort());
  const want = (...es) => J(es.map((e) => e.id).sort());
  const list = (s, qs) => req('GET', `/endpoints/list?search=${TAG}-&status=all&pageSize=200&${qs}`, s);
  r = await list(S.ownerA, '');
  const byId = new Map((r.data?.rows ?? []).map((x) => [x.id, x]));
  check(byId.get(a1.id)?.connectivity === 'online' && byId.get(a5.id)?.connectivity === 'agent_silent' && byId.get(a6.id)?.connectivity === 'agent_silent' && byId.get(a2.id)?.connectivity === 'offline',
    'list rows: A1 online, A5 (12 days silent) and A6 (never reported) agent_silent, A2 offline', J([...byId.values()].map((x) => `${x.name}:${x.connectivity}`)));
  check(byId.get(a5.id)?.isOnline === true && r.data?.thresholds?.heartbeatStaleMs === 30 * 60_000, 'isOnline stays true for A5 (the sweep is unchanged), and the list says which window it used', J(r.data?.thresholds));
  r = await list(S.ownerA, 'online=silent');
  check(r.status === 200 && ids(r.data?.rows) === want(a5, a6), 'online=silent, server-side: exactly A5 and A6 — not B2', `${msg(r).slice(0, 200)} ${ids(r.data?.rows)}`);
  r = await list(S.ownerA, 'online=online');
  check(r.status === 200 && ids(r.data?.rows) === want(a1, a3), 'online=online: only the computers whose agent is checking in (A1, A3)', ids(r.data?.rows));
  r = await list(S.ownerA, 'online=offline');
  check(r.status === 200 && ids(r.data?.rows) === want(a2, a4), 'online=offline: A2 and the archived A4', ids(r.data?.rows));
  r = await list(S.ownerB, 'online=silent');
  check(r.status === 200 && ids(r.data?.rows) === want(b2), "B's owner, online=silent: B2 only", ids(r.data?.rows));
  r = await list(S.admin, `online=silent&businessId=${A.id}`);
  check(r.status === 200 && ids(r.data?.rows) === want(a5, a6), 'the Platform Admin narrowed to A: the same two', ids(r.data?.rows));
  r = await list(S.userA, 'online=silent');
  check(r.status === 200 && ids(r.data?.rows) === want(a5, a6), 'a Business User (company-wide computers): the same two, from the same filter', ids(r.data?.rows));
  r = await req('GET', `/endpoints/list?search=${TAG}-A&status=current&pageSize=200&sort=online`, S.ownerA);
  const order = (r.data?.rows ?? []).map((x) => x.connectivity);
  const rank = { online: 0, agent_silent: 1, offline: 2 };
  check(r.status === 200 && order.length === 5 && order.every((c, i) => i === 0 || rank[order[i - 1]] <= rank[c]), 'sorted by Online: checking in, then agent silent, then offline', J(order));

  // The CSV says which kind of online it is.
  const csvR = await fetch(`${API}/endpoints/list/export.csv?search=${TAG}-A5&status=all`, { headers: { cookie: S.ownerA.cookie, 'x-forwarded-for': ip() } });
  const csv = await csvR.text();
  // Quoted cells, one of which holds a comma: parsed, not split.
  const parseCsv = (t) => { const out = [[]]; let cell = '', q = false; for (let i = 0; i < t.length; i++) { const ch = t[i];
    if (q) { if (ch === '"' && t[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; }
    else if (ch === '"') q = true; else if (ch === ',') { out.at(-1).push(cell); cell = ''; } else if (ch === '\n') { out.at(-1).push(cell.replace(/\r$/, '')); cell = ''; out.push([]); } else cell += ch; }
    out.at(-1).push(cell); return out.filter((x) => x.length > 1); };
  const [cols = [], cells = []] = parseCsv(csv.replace(/^\uFEFF/, ''));
  check(csvR.status === 200 && cols.indexOf('Connectivity') === cols.indexOf('Online') + 1 && cells[cols.indexOf('Online')] === 'yes' && cells[cols.indexOf('Connectivity')] === 'reachable (RustDesk), agent silent',
    'CSV: "Online" yes, and a Connectivity column after it reading "reachable (RustDesk), agent silent"', `${csvR.status} ${J(cols).slice(0, 300)} | ${J(cells).slice(0, 300)}`);

  section('The same three states everywhere else');
  r = await req('GET', `/endpoints/${a5.id}`, S.ownerA);
  const r1 = await req('GET', `/endpoints/${a1.id}`, S.ownerA), r2 = await req('GET', `/endpoints/${a2.id}`, S.ownerA);
  check(r.data?.connectivity === 'agent_silent' && r1.data?.connectivity === 'online' && r2.data?.connectivity === 'offline', 'device page: agent_silent / online / offline', `${r.data?.connectivity} ${r1.data?.connectivity} ${r2.data?.connectivity}`);
  r = await req('GET', `/endpoints/${b2.id}`, S.ownerA);
  check(r.status === 404, "A's owner asking for B's silent computer: 404", msg(r));
  r = await req('GET', `/endpoints?search=${TAG}-A&limit=50`, S.ownerA);
  let m = new Map((r.data?.endpoints ?? []).map((x) => [x.id, x.connectivity]));
  check(r.status === 200 && m.get(a5.id) === 'agent_silent' && m.get(a1.id) === 'online' && !m.has(b2.id), 'GET /endpoints carries it too', J([...m]));
  r = await req('GET', '/endpoints/mine', S.userA);
  m = new Map((r.data ?? []).map((x) => [x.id, x.connectivity]));
  check(r.status === 200 && m.get(a5.id) === 'agent_silent' && m.get(a1.id) === 'online' && !m.has(b2.id), 'My computers: the same, and only A\'s', J([...m]));
  r = await req('GET', `/search?q=${encodeURIComponent(`${TAG}-A5`)}`, S.ownerA);
  const hit = JSON.stringify(r.data ?? {});
  check(r.status === 200 && hit.includes(a5.id) && hit.includes('"connectivity":"agent_silent"') && !hit.includes('"connectivity":"online"'), 'search: the computer comes back agent_silent', msg(r).slice(0, 300));
  r = await req('GET', `/search?q=${encodeURIComponent(`${TAG}-B2`)}`, S.ownerA);
  check(r.status === 200 && !JSON.stringify(r.data ?? {}).includes(b2.id), "search: A's owner never finds B's silent computer", msg(r).slice(0, 300));

  r = await req('GET', '/dashboard/overview', S.ownerA);
  const d = r.data?.devices;
  // A's ACTIVE computers: A1, A3 online; A5, A6 agent silent; A2 offline (A4 is archived).
  check(r.status === 200 && d?.total === 5 && d?.online === 2 && d?.agentSilent === 2 && d?.reachable === 4 && d?.offline === 1,
    'dashboard overview: 2 online, 2 agent silent counted apart (4 reachable), 1 offline — B2 not counted', J(d));
  r = await req('GET', '/dashboard', S.ownerA);
  const e = r.data?.endpoints;
  check(r.status === 200 && e?.total === 5 && e?.online === 2 && e?.agentSilent === 2 && e?.reachable === 4 && e?.offline === 1, 'GET /dashboard: the same split', J(e));
  r = await req('GET', '/dashboard/overview', S.ownerB);
  check(r.status === 200 && r.data?.devices?.agentSilent === 1 && r.data?.devices?.online === 1, "B's owner: B1 online, B2 agent silent", J(r.data?.devices));

  section('Rule groups follow the same meaning');
  ({ g } = await groupsOf(S.ownerA, a5));
  check(J(names(g)) === J([]), 'a twelve-day-silent computer is not in the "online" rule group', J(names(g)));
  const gSilent = await group(A, 'Silent', { online: 'silent' });
  ({ g } = await groupsOf(S.ownerA, a6));
  check(J(names(g)) === J(['Silent/rule']), 'a rule group on online=silent holds the agent-silent computer', J(names(g)));
  r = await list(S.ownerA, `groupId=${gSilent.id}`);
  check(r.status === 200 && ids(r.data?.rows) === want(a5, a6), 'and the list filtered by it is A5 and A6', ids(r.data?.rows));
}

async function cleanup() {
  await stopApi();
  try {
    const bz = created.businesses;
    const eps = (await prisma.endpoint.findMany({ where: { customerId: { in: bz } }, select: { id: true } })).map((e) => e.id);
    const idents = created.users.map((u) => `user:${u}`);
    await prisma.privilegedActivity.deleteMany({ where: { identity: { in: idents } } });
    await prisma.identityPause.deleteMany({ where: { identity: { in: idents } } });
    await prisma.monitorAlert.deleteMany({ where: { customerId: { in: bz } } });
    await prisma.endpointInventory.deleteMany({ where: { endpointId: { in: eps } } });
    await prisma.endpointGroupMember.deleteMany({ where: { endpointId: { in: eps } } });
    await prisma.endpointGroup.deleteMany({ where: { customerId: { in: bz } } });
    await prisma.endpoint.deleteMany({ where: { id: { in: eps } } });
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
