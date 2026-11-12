#!/usr/bin/env node
/**
 * End-to-end proof of device-group policy scopes (0.35): monitors and
 * client-update policies set for a device group, static or rule-based.
 *
 *   - precedence: computer > group > site > business, read back from the
 *     device page's effective view, from the heartbeat (what the agent is
 *     asked) and from the client-update sweep (what it queues);
 *   - a computer in two groups with a policy for the same thing follows the
 *     lower priority number, visibly ("ahead of … on priority"), and
 *     changing the priority changes the answer — in the monitor sweep and
 *     the client-update sweep, not only on a page;
 *   - a computer that stops matching a rule group loses that group's policy
 *     on the next evaluation: the device page, the heartbeat, and the monitor
 *     sweep closing the group monitor's alert;
 *   - a priority clash is refused (409), a group policy without a priority
 *     is refused, a group picking computers by alerts cannot carry a policy,
 *     a group carrying a policy cannot be deleted, and turning a group
 *     client-update policy on or removing it needs fresh authentication;
 *   - business isolation: another business's group is a 404 for monitors
 *     and client updates; Birch's computer with the same tag never follows
 *     Acme's rule group; another business's computer's effective policy is a
 *     404; and the Platform Admin does see it (the negative control);
 *   - who is notified is still global or business only, and still needs
 *     fresh authentication (§17).
 *
 * Self-starting: it runs its own API from dist/ on GROUP_POLICY_API_PORT
 * (3541) with the monitor sweep and the client-update sweep every 2 seconds,
 * against DATABASE_URL, which must name a scratch/test database. Both sweeps
 * act on everything in the database, so it refuses one that already has
 * global monitors, a global notification policy or an enabled client-update
 * policy. Fixtures are namespaced and removed at the end (audit rows are
 * sealed and stay, see CLAUDE.md).
 *
 * Run:  DATABASE_URL=…/rem0te_group_policy_test node scripts/e2e-group-policies.mjs
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const DB = process.env.DATABASE_URL ?? '';
const dbName = DB.split('/').pop()?.split('?')[0] ?? '';
if (!/scratch|test/.test(dbName)) { console.error(`Refusing to run against database "${dbName}": name must contain "scratch" or "test".`); process.exit(2); }
const PORT = Number(process.env.GROUP_POLICY_API_PORT ?? 3541);
if ([3000, 3001, 443, 4000, 4001].includes(PORT)) { console.error(`Refusing port ${PORT}: that is a production port.`); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'group-policy-e2e-password-1';
const TAG = `GP${sfx}`;
const KIOSK = `kiosk-${sfx}`;
const TARGET = '1.4.5', OLD = '1.4.0';
const SWEEP_SECONDS = 2;

let pass = 0, fail = 0;
const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const until = async (fn, ms = 20_000, step = 400) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(step); } return v; };
const J = JSON.stringify;

const apiEnv = {
  ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATABASE_URL: DB,
  JWT_SECRET: randomBytes(32).toString('hex'), LAUNCHER_TOKEN_SECRET: randomBytes(32).toString('hex'),
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? randomBytes(32).toString('hex'), TRUSTED_PROXIES: 'loopback',
  HBBS_PRESENCE_HOST: '127.0.0.2', AUDIT_SEALER: 'off',
  MONITOR_SWEEP: 'on', MONITOR_SWEEP_SECONDS: String(SWEEP_SECONDS), MONITOR_OFFLINE_HOLD_SECONDS: '2',
  CLIENT_UPDATE_SWEEP: 'on', CLIENT_UPDATE_SWEEP_SECONDS: String(SWEEP_SECONDS), CLIENT_UPDATE_SWEEP_BATCH: '20',
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

let last = 0;
async function req(method, p, { s, body, business } = {}) {
  // Paced well under the 20/s burst throttler, and a fresh address each time.
  const wait = last + 60 - Date.now(); if (wait > 0) await sleep(wait); last = Date.now();
  const h = { 'x-forwarded-for': ip() };
  if (body !== undefined) h['content-type'] = 'application/json';
  if (s) h.cookie = s.cookie + (s.stepUp ? `; step_up=${s.stepUp}` : '');
  if (business) h['x-rem0te-business'] = business;
  const r = await fetch(`${API}${p}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j, data: j?.data, setCookie: r.headers.get('set-cookie') ?? '' };
}
async function login(email) {
  const r = await req('POST', '/auth/login', { body: { email, password: PW } });
  const mm = r.setCookie.match(/access_token=([^;]+)/);
  if (r.status !== 200 || !mm) throw new Error(`login ${email}: ${r.status} ${J(r.body)}`);
  return { cookie: `access_token=${mm[1]}` };
}
async function stepUp(s) {
  const r = await req('POST', '/auth/step-up', { s, body: { password: PW } });
  const mm = r.setCookie.match(/step_up=([^;]+)/);
  if (r.status !== 200 || !mm) throw new Error(`step-up: ${r.status} ${J(r.body)}`);
  return { ...s, stepUp: mm[1] };
}
const code = (r) => r.body?.code ?? r.body?.message?.code ?? r.body?.error?.code;
const msg = (r) => `HTTP ${r.status} ${J(r.body).slice(0, 400)}`;

const hhmm = (d) => `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
const ALL = [0, 1, 2, 3, 4, 5, 6];
const openWindow = () => [{ days: ALL, start: hhmm(new Date(Date.now() - 3600_000)), end: hhmm(new Date(Date.now() + 2 * 3600_000)) }];
const closedWindow = () => [{ days: ALL, start: hhmm(new Date(Date.now() + 3 * 3600_000)), end: hhmm(new Date(Date.now() + 5 * 3600_000)) }];
const cu = (businessId, windows, extra = {}) => ({ businessId, enabled: true, timeZone: 'UTC', windows, skipActiveSession: false, skipLoggedOnUser: false, ...extra });
const svc = (service) => ({ kind: 'SERVICE_STOPPED', name: `svc ${service}`, params: { service } });

const created = { businesses: [], users: [] };
let originalPin;

async function all() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });
  const roleUser = await prisma.role.findFirst({ where: { type: 'BUSINESS_USER' } });
  const preexisting = await prisma.monitorRule.count({ where: { scopeKey: 'global' } }) + await prisma.monitorNotifyPolicy.count({ where: { scopeKey: 'global' } });
  if (preexisting) throw new Error('refusing: this database has global monitors or a global notification policy, and the monitor sweep acts on everything');
  const stray = await prisma.clientUpdatePolicy.count({ where: { enabled: true } });
  if (stray) throw new Error(`refusing: this database already has ${stray} enabled client-update policies, and the sweep acts on every one`);
  originalPin = (await prisma.platformSettings.findUnique({ where: { id: 'singleton' } }))?.rustdeskPinnedVersion ?? null;
  await prisma.platformSettings.upsert({ where: { id: 'singleton' }, update: { rustdeskPinnedVersion: TARGET }, create: { id: 'singleton', rustdeskPinnedVersion: TARGET } });

  section('Fixtures (synthetic): Acme (site HQ, groups Tills, Kiosks, Alerting) and Birch (group Kiosks, same rule)');
  const A = await prisma.customer.create({ data: { tenantId: tenant.id, name: `${TAG} Acme` } });
  const B = await prisma.customer.create({ data: { tenantId: tenant.id, name: `${TAG} Birch` } });
  created.businesses.push(A.id, B.id);
  const hq = await prisma.site.create({ data: { tenantId: tenant.id, customerId: A.id, name: `${TAG} HQ` } });
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (t, extra = {}) => { const u = await prisma.user.create({ data: { email: `gp-${t}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'GP', lastName: t, status: 'ACTIVE', ...extra } }); created.users.push(u.id); return u; };
  const admin = await mkUser('admin', { isPlatformAdmin: true });
  const ownerA = await mkUser('owner-a'), ownerB = await mkUser('owner-b'), userA = await mkUser('user-a');
  await prisma.membership.create({ data: { userId: ownerA.id, tenantId: tenant.id, customerId: A.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: ownerB.id, tenantId: tenant.id, customerId: B.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: userA.id, tenantId: tenant.id, customerId: A.id, roleId: roleUser.id, capabilities: ['computers:view'] } });

  const eps = {};
  const mkEp = async (key, biz, { site = null, platform = 'Windows', online = true, tags = [], seenAgoMs = 0 } = {}) => {
    const e = await prisma.endpoint.create({ data: {
      tenantId: tenant.id, customerId: biz.id, siteId: site?.id ?? null, name: `${TAG}-${key}`, hostname: `${TAG}-${key}`.toLowerCase(),
      platform, status: 'ACTIVE', isOnline: online, isManaged: true, accessMode: 'ASSIGNED_USERS', lastSeenAt: new Date(Date.now() - seenAgoMs),
    } });
    const rid = String(100000000 + ((Math.random() * 899999999) | 0));
    const secret = randomBytes(16).toString('hex');
    await prisma.rustdeskNode.create({ data: { tenantId: tenant.id, endpointId: e.id, rustdeskId: rid, version: OLD, platform, agentSecretHash: sha(secret) } });
    for (const t of tags) await prisma.endpointTag.create({ data: { endpointId: e.id, tag: t } });
    eps[key] = { ...e, rid, secret };
    return eps[key];
  };
  await mkEp('a1', A, { site: hq, tags: [KIOSK] });
  await mkEp('a2', A, { tags: [KIOSK] });
  await mkEp('a3', A, { site: hq, tags: [KIOSK] });
  await mkEp('a4', A, { platform: 'macOS' });
  await mkEp('aOff', A, { online: false, seenAgoMs: 2 * 3600_000, tags: [KIOSK] });
  await mkEp('b1', B, { tags: [KIOSK] });
  await prisma.computerAccess.create({ data: { tenantId: tenant.id, endpointId: eps.a4.id, userId: userA.id } });
  const mkGroup = (biz, name, rule) => prisma.endpointGroup.create({ data: { tenantId: tenant.id, customerId: biz.id, name: `${TAG} ${name}`, ...(rule ? { kind: 'RULE', rule } : {}) } });
  const tills = await mkGroup(A, 'Tills');
  const kiosks = await mkGroup(A, 'Kiosks', { tag: KIOSK });
  const alerting = await mkGroup(A, 'Alerting', { alerts: 'any' });
  const bKiosks = await mkGroup(B, 'Kiosks', { tag: KIOSK });
  await prisma.endpointGroupMember.createMany({ data: [{ endpointGroupId: tills.id, endpointId: eps.a2.id }, { endpointGroupId: tills.id, endpointId: eps.aOff.id }] });
  check(true, 'created 2 businesses, 1 site, 6 computers (5 tagged kiosk, one of them Birch’s), 4 groups, 4 people');

  startApi();
  await waitUp();
  const S = { admin: await login(admin.email), ownerA: await login(ownerA.email), ownerB: await login(ownerB.email), userA: await login(userA.email) };
  const heartbeat = (k) => req('POST', '/enrollment/heartbeat', { body: { rustdeskId: eps[k].rid, agentSecret: eps[k].secret, hostname: eps[k].hostname, platform: eps[k].platform, rustdeskVersion: OLD, rustdeskSessions: 0, loggedOnUser: '' } });
  const effective = async (k, s = S.ownerA) => { const r = await req('GET', `/monitoring/endpoints/${eps[k].id}`, { s }); return { r, rules: Object.fromEntries((r.data?.rules ?? []).map((x) => [x.key, x])), names: r.data?.scopeNames ?? {} }; };
  const rule = (body, s = S.ownerA) => req('POST', '/monitoring/rules', { s, body: { businessId: A.id, ...body } });
  const gk = (g) => `g:${g.id}`;

  // ── Monitors ───────────────────────────────────────────────────────────────
  section('Monitors: setting a group monitor');
  let r = await rule({ scope: 'group', groupId: kiosks.id, key: 'svc', ...svc('KioskSvc') });
  check(r.status === 400 && code(r) === 'PRIORITY_REQUIRED', 'a group monitor without a priority is refused', msg(r));
  r = await rule({ scope: 'business', key: 'svc', priority: 3, ...svc('Spooler') });
  check(r.status === 400, 'a business monitor with a priority is refused (only groups have one)', msg(r));
  r = await rule({ scope: 'business', key: 'svc', ...svc('Spooler') });
  check(r.status === 201 && r.data?.scope === 'business', 'business monitor "svc" → Spooler', msg(r));
  r = await rule({ scope: 'site', siteId: hq.id, key: 'svc', ...svc('SiteSvc') });
  check(r.status === 201, 'site HQ monitor "svc" → SiteSvc', msg(r));
  r = await rule({ scope: 'group', groupId: kiosks.id, key: 'svc', priority: 5, ...svc('KioskSvc') });
  check(r.status === 201 && r.data?.scope === 'group' && r.data?.scopeKey === gk(kiosks) && r.data?.priority === 5 && r.data?.group?.name === kiosks.name, 'rule group Kiosks monitor "svc" → KioskSvc, priority 5', msg(r));
  r = await rule({ scope: 'group', groupId: tills.id, key: 'svc', priority: 5, ...svc('TillSvc') });
  check(r.status === 409 && code(r) === 'PRIORITY_TAKEN', 'the same key at the same priority in another group is refused (409) — ties are refused when saved', msg(r));
  r = await rule({ scope: 'group', groupId: tills.id, key: 'svc', priority: 2, ...svc('TillSvc') });
  check(r.status === 201, 'static group Tills monitor "svc" → TillSvc, priority 2', msg(r));
  const tillsSvc = r.data;
  r = await rule({ scope: 'endpoint', endpointId: eps.a1.id, key: 'svc', ...svc('MineSvc') });
  check(r.status === 201, 'computer a1 monitor "svc" → MineSvc', msg(r));
  r = await rule({ scope: 'group', groupId: alerting.id, key: 'svc', priority: 7, ...svc('X') });
  check(r.status === 400 && code(r) === 'GROUP_READS_ALERTS', 'a group that picks computers by their alerts cannot carry a monitor', msg(r));
  r = await rule({ scope: 'group', groupId: bKiosks.id, key: 'svc', priority: 8, ...svc('X') });
  check(r.status === 404, 'Acme’s owner naming Birch’s group: 404', msg(r));
  r = await rule({ scope: 'group', groupId: kiosks.id, businessId: B.id, key: 'svc', priority: 8, ...svc('X') }, S.ownerB);
  check(r.status === 404, 'Birch’s owner naming Acme’s group (as Birch): 404', msg(r));
  r = await rule({ scope: 'group', groupId: 'cmnotagroup0000001', key: 'svc', priority: 8, ...svc('X') });
  check(r.status === 404, 'a made-up group id: the same 404', msg(r));

  section('Monitors: precedence — computer > group > site > business, groups by priority');
  let e = await effective('a1');
  check(e.rules.svc?.inheritedFrom === `e:${eps.a1.id}` && e.rules.svc.params.service === 'MineSvc', 'a1 (computer monitor, Kiosks, HQ): its own monitor wins', J(e.rules.svc));
  e = await effective('a2');
  check(e.rules.svc?.inheritedFrom === gk(tills) && e.rules.svc.params.service === 'TillSvc' && e.rules.svc.priority === 2, 'a2 (Tills p2 and Kiosks p5): Tills wins on priority', J(e.rules.svc));
  check(J(e.rules.svc?.outranked?.map((o) => [o.scopeKey, o.reason])) === J([[gk(kiosks), 'priority'], [`b:${A.id}`, 'more_specific']]), 'and the page is told what it beat and why: Kiosks on priority, the business as broader', J(e.rules.svc?.outranked));
  check(e.names[gk(tills)] === `group ${tills.name}` && e.names[gk(kiosks)] === `group ${kiosks.name}`, 'scope names name the groups', J(e.names));
  e = await effective('a3');
  check(e.rules.svc?.inheritedFrom === gk(kiosks) && e.rules.svc.params.service === 'KioskSvc' && e.rules.svc.outranked.some((o) => o.scopeKey === `s:${hq.id}`), 'a3 (Kiosks, HQ): the group beats the site', J(e.rules.svc));
  e = await effective('a4');
  check(e.rules.svc?.inheritedFrom === `b:${A.id}` && e.rules.svc.params.service === 'Spooler', 'a4 (no group, no site): the business monitor', J(e.rules.svc));

  section('Monitors: the heartbeat asks what the precedence says');
  r = await heartbeat('a2');
  check(r.status < 300 && J(r.data?.monitor?.services) === '["TillSvc"]', 'a2 is asked about TillSvc only', msg(r));
  r = await heartbeat('a3');
  check(r.status < 300 && J(r.data?.monitor?.services) === '["KioskSvc"]', 'a3 is asked about KioskSvc only', msg(r));

  section('Monitors: leaving a rule group drops its monitor on the next evaluation');
  await prisma.endpointTag.deleteMany({ where: { endpointId: eps.a3.id, tag: KIOSK } });
  e = await effective('a3');
  check(e.rules.svc?.inheritedFrom === `s:${hq.id}` && e.rules.svc.params.service === 'SiteSvc', 'a3 untagged: the device page now shows the site monitor', J(e.rules.svc));
  r = await heartbeat('a3');
  check(J(r.data?.monitor?.services) === '["SiteSvc"]', 'and its next heartbeat asks about SiteSvc', msg(r));
  await prisma.endpointTag.create({ data: { endpointId: eps.a3.id, tag: KIOSK } });

  section('Monitors: changing the priority changes the answer');
  r = await req('PATCH', `/monitoring/rules/${tillsSvc.id}`, { s: S.ownerA, body: { priority: 5 } });
  check(r.status === 409 && code(r) === 'PRIORITY_TAKEN', 'moving Tills to 5 (Kiosks has it) is refused', msg(r));
  r = await req('PATCH', `/monitoring/rules/${tillsSvc.id}`, { s: S.ownerA, body: { priority: 9 } });
  check(r.status === 200 && r.data?.priority === 9, 'Tills moved to priority 9', msg(r));
  e = await effective('a2');
  check(e.rules.svc?.inheritedFrom === gk(kiosks) && e.rules.svc.outranked.some((o) => o.scopeKey === gk(tills) && o.reason === 'priority'), 'a2 now follows Kiosks (5 before 9)', J(e.rules.svc));
  r = await req('PATCH', `/monitoring/rules/${tillsSvc.id}`, { s: S.ownerA, body: { priority: 2 } });

  section('Monitors: the sweep resolves groups — multi-group conflict and leaving a group');
  r = await rule({ scope: 'group', groupId: kiosks.id, key: 'down', kind: 'OFFLINE', name: 'Kiosk down', priority: 3, params: { minutes: 5 } });
  check(r.status === 201, 'Kiosks: offline monitor "down", priority 3', msg(r));
  r = await rule({ scope: 'group', groupId: tills.id, key: 'down', kind: 'OFFLINE', name: 'Till down (off)', priority: 1, enabled: false, params: { minutes: 5 } });
  check(r.status === 201, 'Tills: "down" switched off, priority 1', msg(r));
  const tillsDown = r.data;
  const openDown = () => prisma.monitorAlert.findFirst({ where: { endpointId: eps.aOff.id, ruleKey: 'down', state: { not: 'RESOLVED' } } });
  await sleep(3 * SWEEP_SECONDS * 1000 + 500);
  check(!(await openDown()), 'aOff (offline 2 h, in both): three sweeps, no alert — Tills (priority 1, off) wins');
  r = await req('PATCH', `/monitoring/rules/${tillsDown.id}`, { s: S.ownerA, body: { priority: 8 } });
  const raised = await until(openDown);
  check(r.status === 200 && !!raised && raised.customerId === A.id, 'Tills moved to priority 8: the sweep raises "down" for aOff from Kiosks', J(raised));
  await prisma.endpointTag.deleteMany({ where: { endpointId: eps.aOff.id, tag: KIOSK } });
  const closed = await until(async () => { const a = await prisma.monitorAlert.findUnique({ where: { id: raised.id } }); return a?.state === 'RESOLVED' ? a : null; });
  check(!!closed && /no longer applies/.test(closed.resolveNote ?? ''), 'aOff untagged: the next sweep closes it — the monitor no longer applies', J(closed?.resolveNote));
  check(!(await prisma.monitorAlert.count({ where: { endpointId: eps.b1.id } })), 'Birch’s b1 (same tag) never got Acme’s Kiosks alert or monitor');

  section('Monitors: isolation and listing');
  e = await effective('b1', S.ownerB);
  check(e.r.status === 200 && !Object.keys(e.rules).length && !e.r.data.scopes.some((k) => k.startsWith('g:')), 'b1, as Birch’s owner: no rules and no group scopes (Acme’s rule group never matches Birch’s computers)', msg(e.r));
  r = await req('GET', `/monitoring/endpoints/${eps.b1.id}`, { s: S.ownerA });
  check(r.status === 404, 'Acme’s owner reading b1: 404', msg(r));
  r = await req('GET', '/monitoring/rules', { s: S.ownerB });
  check(r.status === 200 && !r.data.rules.some((x) => x.businessId === A.id), 'Birch’s rule list holds none of Acme’s group monitors', msg(r));
  r = await req('GET', '/monitoring/rules', { s: S.ownerA });
  check(r.data?.rules?.filter((x) => x.scope === 'group').length === 4 && r.data.rules.some((x) => x.group?.name === tills.name && x.priority === 2), 'Acme’s rule list shows its four group monitors with group names and priorities', msg(r));
  r = await req('DELETE', `/device-groups/${tills.id}`, { s: S.ownerA });
  check(r.status === 409 && code(r) === 'GROUP_HAS_POLICIES', 'a group carrying monitors cannot be deleted', msg(r));
  r = await req('PATCH', `/device-groups/${kiosks.id}`, { s: S.ownerA, body: { rule: { tag: KIOSK, alerts: 'any' } } });
  check(r.status === 409 && code(r) === 'GROUP_HAS_POLICIES', 'a group carrying monitors cannot be changed to pick computers by alerts', msg(r));

  section('Who is notified stays global or business, and needs fresh authentication (§17)');
  r = await req('PUT', '/monitoring/notify-policy', { s: S.ownerA, body: { scope: 'business', businessId: A.id, levels: [] } });
  check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED', 'changing who is notified without fresh authentication: STEP_UP_REQUIRED', msg(r));
  const ownerAUp = await stepUp(S.ownerA);
  r = await req('PUT', '/monitoring/notify-policy', { s: ownerAUp, body: { scope: 'group', groupId: kiosks.id, levels: [] } });
  check(r.status === 400, 'a notification policy for a group is refused (no such scope)', msg(r));

  // ── Client updates ─────────────────────────────────────────────────────────
  section('Client updates: setting group policies');
  r = await req('PUT', '/client-updates/policy', { s: S.ownerA, body: cu(A.id, closedWindow(), { enabled: false }) });
  check(r.status === 200, 'Acme business policy: off', msg(r));
  r = await req('PUT', '/client-updates/policy', { s: S.ownerA, body: cu(A.id, closedWindow(), { enabled: false, siteId: hq.id }) });
  check(r.status === 200, 'HQ override: off', msg(r));
  r = await req('PUT', '/client-updates/policy', { s: S.ownerA, body: cu(A.id, openWindow(), { groupId: kiosks.id, priority: 5 }) });
  check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED', 'turning a group policy on needs fresh authentication', msg(r));
  r = await req('PUT', '/client-updates/policy', { s: ownerAUp, body: cu(A.id, openWindow(), { groupId: kiosks.id }) });
  check(r.status === 400 && code(r) === 'PRIORITY_REQUIRED', 'a group policy without a priority is refused', msg(r));
  r = await req('PUT', '/client-updates/policy', { s: ownerAUp, body: cu(A.id, openWindow(), { groupId: kiosks.id, priority: 5, siteId: hq.id }) });
  check(r.status === 400, 'a policy for a site AND a group is refused', msg(r));
  r = await req('PUT', '/client-updates/policy', { s: ownerAUp, body: cu(A.id, openWindow(), { groupId: bKiosks.id, priority: 5 }) });
  check(r.status === 404, 'Birch’s group under Acme: 404', msg(r));
  r = await req('PUT', '/client-updates/policy', { s: ownerAUp, body: cu(A.id, openWindow(), { groupId: alerting.id, priority: 6 }) });
  check(r.status === 400 && code(r) === 'GROUP_READS_ALERTS', 'a group picking computers by alerts cannot carry one', msg(r));
  r = await req('PUT', '/client-updates/policy', { s: ownerAUp, body: cu(A.id, openWindow(), { groupId: kiosks.id, priority: 5 }) });
  check(r.status === 200 && r.data?.policy?.groupId === kiosks.id && r.data.policy.priority === 5, 'Kiosks: on, window open, priority 5 (with fresh authentication)', msg(r));
  r = await req('PUT', '/client-updates/policy', { s: S.ownerA, body: cu(A.id, closedWindow(), { enabled: false, groupId: tills.id, priority: 5 }) });
  check(r.status === 409 && code(r) === 'PRIORITY_TAKEN', 'Tills at priority 5 (Kiosks has it): refused', msg(r));
  r = await req('PUT', '/client-updates/policy', { s: S.ownerA, body: cu(A.id, closedWindow(), { enabled: false, groupId: tills.id, priority: 2 }) });
  check(r.status === 200, 'Tills: off, priority 2 — turning off needs no fresh authentication', msg(r));
  r = await req('PUT', '/client-updates/policy', { s: ownerAUp, body: cu(B.id, openWindow(), { groupId: bKiosks.id, priority: 1 }) });
  check(r.status === 403, 'Acme’s owner cannot set Birch’s policies at all', msg(r));

  section('Client updates: the sweep queues by precedence');
  const queued = (k) => prisma.rustdeskNode.findUnique({ where: { endpointId: eps[k].id } }).then((n) => n?.updateRequestSource === 'POLICY' ? n : null);
  check(!!(await until(() => queued('a1'))), 'a1 (Kiosks on, HQ off): queued by the group policy');
  check(!!(await until(() => queued('a3'))), 'a3 (Kiosks on, HQ off): queued');
  await sleep(2 * SWEEP_SECONDS * 1000 + 500);
  check(!(await queued('a2')), 'a2 (Tills p2 off, Kiosks p5 on): NOT queued — Tills wins on priority');
  check(!(await queued('b1')), 'b1 (Birch, same tag, no policy): not queued');
  check(!(await queued('a4')), 'a4 (macOS, business off): not queued');
  const autoQ = await prisma.activityLog.findFirst({ where: { action: 'CLIENT_UPDATE_AUTO_QUEUED', resourceId: eps.a1.id } });
  check(autoQ?.metadata?.scope === 'group' && autoQ.metadata.groupId === kiosks.id && autoQ.metadata.priority === 5, 'the automatic queuing is audited with the group and priority', J(autoQ?.metadata));

  section('Client updates: the pages say which policy won and why');
  r = await req('GET', `/client-updates/computers?businessId=${A.id}`, { s: S.ownerA });
  const row = (k) => r.data?.computers?.find((c) => c.id === eps[k].id);
  check(row('a2')?.policy?.scope === 'group' && row('a2').policy.group?.id === tills.id && row('a2').policy.group.priority === 2
    && /ahead of the policy of group .*Kiosks \(priority 5\) on priority/.test(row('a2').policy.why) && row('a2').policy.alsoIn?.[0]?.id === kiosks.id,
  'a2: Tills (priority 2), ahead of Kiosks (priority 5) on priority', J(row('a2')?.policy));
  check(row('a3')?.policy?.group?.id === kiosks.id && /more specific than the override for site/.test(row('a3').policy.why), 'a3: Kiosks, more specific than the HQ override', J(row('a3')?.policy));
  check(row('a4')?.policy?.scope === 'business', 'a4: the business policy', J(row('a4')?.policy));
  check(!r.data.computers.some((c) => c.id === eps.b1.id), 'Acme’s list holds none of Birch’s computers');
  r = await req('GET', `/client-updates/computers/${eps.a2.id}/policy`, { s: S.ownerA });
  check(r.status === 200 && r.data.policy?.group?.id === tills.id && J(r.data.considered.map((c) => [c.scope, c.priority, c.outcome])) === J([['group', 2, 'won'], ['group', 5, 'priority'], ['business', null, 'more_specific']]),
    'the device page’s view of a2: every policy considered, in order, with why it lost', msg(r));
  r = await req('GET', `/client-updates/policy?businessId=${A.id}`, { s: S.ownerA });
  const gv = (g) => r.data?.groups?.find((x) => x.id === g.id);
  check(gv(kiosks)?.policy?.priority === 5 && gv(kiosks).members === 3 && gv(tills)?.members === 2 && gv(alerting)?.policy === null && r.data.groups[0].id === tills.id,
    'the policy page lists the groups in precedence order, with members counted now (Kiosks 3, Tills 2)', J(r.data?.groups));
  r = await req('GET', `/client-updates/policy?businessId=${A.id}`, { s: S.userA });
  check(r.status === 200 && r.data.groups.find((x) => x.id === kiosks.id)?.members === 0, 'a Business User who sees only a4 is told 0 members, never the raw total', msg(r));
  r = await req('GET', `/client-updates/computers/${eps.b1.id}/policy`, { s: S.ownerA });
  check(r.status === 404, 'Acme’s owner asking b1’s effective policy: 404', msg(r));
  r = await req('GET', `/client-updates/computers/${eps.b1.id}/policy`, { s: S.admin });
  check(r.status === 200 && r.data.policy === null, 'the Platform Admin can (negative control): no policy applies to b1', msg(r));
  r = await req('GET', `/client-updates/computers/${eps.a4.id}/policy`, { s: S.userA });
  check(r.status === 200 && r.data.policy?.scope === 'business', 'a Business User reads the effective policy of a computer granted to them', msg(r));
  r = await req('GET', `/client-updates/computers/${eps.a2.id}/policy`, { s: S.userA });
  check(r.status === 404, '…and not of one that is not (404)', msg(r));

  section('Client updates: priority and membership change the answer');
  r = await req('PUT', '/client-updates/policy', { s: S.ownerA, body: cu(A.id, closedWindow(), { enabled: false, groupId: tills.id, priority: 9 }) });
  check(r.status === 200, 'Tills moved to priority 9', msg(r));
  check(!!(await until(() => queued('a2'))), 'a2 now follows Kiosks (5 before 9) and the next sweeps queue it');
  await prisma.endpointTag.deleteMany({ where: { endpointId: eps.a3.id, tag: KIOSK } });
  r = await req('GET', `/client-updates/computers/${eps.a3.id}/policy`, { s: S.ownerA });
  check(r.data?.policy?.scope === 'site' && r.data.policy.enabled === false, 'a3 untagged: its effective policy is now the HQ override (off)', msg(r));
  r = await heartbeat('a3');
  const n3 = await prisma.rustdeskNode.findUnique({ where: { endpointId: eps.a3.id } });
  check(r.status < 300 && !r.data?.updateRustdesk && n3.updateHoldReason === 'policy_off', 'and its next heartbeat withholds the request it was queued under the group: policy_off', msg(r));

  section('Client updates: removing a group policy needs fresh authentication; a group carrying one cannot be deleted');
  r = await req('DELETE', `/device-groups/${kiosks.id}`, { s: S.ownerA });
  check(r.status === 409 && code(r) === 'GROUP_HAS_POLICIES', 'deleting Kiosks while it carries policies: 409', msg(r));
  r = await req('DELETE', `/client-updates/policy/groups/${kiosks.id}?businessId=${A.id}`, { s: S.ownerA });
  check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED', 'removing the Kiosks policy without fresh authentication: refused', msg(r));
  r = await req('DELETE', `/client-updates/policy/groups/${bKiosks.id}?businessId=${A.id}`, { s: ownerAUp });
  check(r.status === 404, 'removing Birch’s group policy under Acme: 404', msg(r));
  r = await req('DELETE', `/client-updates/policy/groups/${kiosks.id}?businessId=${A.id}`, { s: ownerAUp });
  check(r.status === 200 && r.data?.clearedQueued === 3, 'removed with fresh authentication; a1, a2 and a3 fall back to off policies, so their 3 requests are withdrawn', msg(r));
  const changes = await prisma.activityLog.findMany({ where: { action: 'CLIENT_UPDATE_POLICY_CHANGED', customerId: A.id } });
  check(changes.some((c) => c.metadata?.scope === 'group' && c.metadata?.groupId === kiosks.id && c.metadata?.after?.priority === 5)
    && changes.some((c) => c.metadata?.removedGroupPolicy === true && c.metadata?.clearedQueued === 3), 'group policy changes and the removal are audited with group and priority', J(changes.map((c) => c.metadata)));
}

async function cleanup() {
  await stopApi();
  try {
    if (originalPin !== undefined) await prisma.platformSettings.update({ where: { id: 'singleton' }, data: { rustdeskPinnedVersion: originalPin } }).catch(() => {});
    const ids = created.businesses;
    await prisma.clientUpdatePolicy.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.monitorRule.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.monitorAlert.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.monitorNotifyPolicy.deleteMany({ where: { customerId: { in: ids } } });
    const eps = (await prisma.endpoint.findMany({ where: { customerId: { in: ids } }, select: { id: true } })).map((e) => e.id);
    await prisma.endpointMonitorState.deleteMany({ where: { endpointId: { in: eps } } });
    await prisma.endpointGroupMember.deleteMany({ where: { endpointId: { in: eps } } });
    await prisma.endpointGroup.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.computerAccess.deleteMany({ where: { endpointId: { in: eps } } });
    await prisma.endpointTag.deleteMany({ where: { endpointId: { in: eps } } });
    await prisma.endpointInventory.deleteMany({ where: { endpointId: { in: eps } } });
    await prisma.rustdeskNode.deleteMany({ where: { endpointId: { in: eps } } });
    await prisma.endpoint.deleteMany({ where: { id: { in: eps } } });
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
