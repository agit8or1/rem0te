#!/usr/bin/env node
/**
 * End-to-end proof of 0.36 agent health:
 *
 *   1. The "Agent silent" monitor (AGENT_SILENT):
 *      - off until created: with no monitor nothing is raised; since
 *        0.36.1 "Add recommended" adds it (proved on a business with no
 *        computers, so the click raises nothing mid-run);
 *      - bounds (30 minutes – 7 days) are enforced at the API;
 *      - it raises for a computer RustDesk still reaches (isOnline) whose
 *        agent has been silent past the threshold, and not for a fresh,
 *        an offline, or a never-reported computer;
 *      - global / business / site / group / computer precedence (0.35),
 *        including a computer leaving a group changing the answer;
 *      - one open alert per problem, notified through the policy, held by a
 *        maintenance window and released when the window ends;
 *      - the alert says remote control should still work and suggests
 *        Update agent or re-running the installer;
 *      - it stays open while the computer is unreachable, and resolves when
 *        the agent checks in again;
 *      - the device page's monitoring view (what the Agent card and header
 *        read) carries it, and another business sees none of it.
 *   2. A queued automatic client update re-resolved every sweep: a computer
 *      leaving the device group whose policy queued it has the request
 *      withdrawn (business policy off) or re-planned under the policy that
 *      governs it now (business policy on), each audited with the reason; a
 *      pre-0.36 request is adopted; a manual request is never touched.
 *
 * Self-starting: it runs its own API from dist/ on AGENT_HEALTH_API_PORT
 * (3601), with a webhook receiver on AGENT_HEALTH_HOOK_PORT (3602), the
 * monitor and client-update sweeps every 2 seconds and the stale sweep off
 * (no hbbs here keeps its fixtures reachable), against DATABASE_URL, which
 * must name a scratch/test database. The sweeps act on everything in the
 * database, so it refuses one that already has global monitors, a global
 * notification policy or an enabled client-update policy.
 *
 * Run:  DATABASE_URL=…/rem0te_agenthealth_test node scripts/e2e-agent-health.mjs
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const DB = process.env.DATABASE_URL ?? '';
const dbName = DB.split('/').pop()?.split('?')[0] ?? '';
if (!/scratch|test/.test(dbName)) { console.error(`Refusing to run against database "${dbName}": name must contain "scratch" or "test".`); process.exit(2); }
const PORT = Number(process.env.AGENT_HEALTH_API_PORT ?? 3601);
const HOOK_PORT = Number(process.env.AGENT_HEALTH_HOOK_PORT ?? 3602);
for (const p of [PORT, HOOK_PORT]) if ([3000, 3001, 443, 4000, 4001].includes(p)) { console.error(`Refusing port ${p}: production or the shared docs stack.`); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'agent-health-e2e-password-1';
const TAG = `AH${sfx}`;
const TARGET = '1.4.5', OLD = '1.4.0';
const SWEEP_SECONDS = 2;
const MIN = 60_000;

let pass = 0, fail = 0;
const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const until = async (fn, ms = 20_000, step = 400) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(step); } return v; };
const J = JSON.stringify;
/** Let at least `n` sweeps pass. */
const ticks = (n = 2) => sleep(n * SWEEP_SECONDS * 1000 + 800);

// ── Webhook receiver ────────────────────────────────────────────────────────
const hooks = [];
let hookServer;
const listen = () => new Promise((resolve) => {
  hookServer = createServer((rq, rs) => {
    let b = ''; rq.on('data', (d) => { b += d; }); rq.on('end', () => { try { hooks.push({ path: rq.url, body: JSON.parse(b), at: Date.now() }); } catch { hooks.push({ path: rq.url, raw: b }); } rs.writeHead(200, { 'content-type': 'application/json' }); rs.end('{}'); });
  }).listen(HOOK_PORT, '127.0.0.1', () => resolve());
});
const hookFor = (alertId, type) => hooks.filter((h) => h.body?.alert?.id === alertId && (!type || h.body?.type === type));

const apiEnv = {
  ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATABASE_URL: DB,
  JWT_SECRET: randomBytes(32).toString('hex'), LAUNCHER_TOKEN_SECRET: randomBytes(32).toString('hex'),
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? randomBytes(32).toString('hex'), TRUSTED_PROXIES: 'loopback',
  HBBS_PRESENCE_HOST: '127.0.0.2', AUDIT_SEALER: 'off', STALE_SWEEP: 'off', SNAPSHOT_SWEEP: 'off',
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

const created = { businesses: [], users: [], globalPolicy: false };
let originalPin;

async function all() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });
  const preexisting = await prisma.monitorRule.count({ where: { scopeKey: 'global' } }) + await prisma.monitorNotifyPolicy.count({ where: { scopeKey: 'global' } });
  if (preexisting) throw new Error('refusing: this database has global monitors or a global notification policy, and the monitor sweep acts on everything');
  const stray = await prisma.clientUpdatePolicy.count({ where: { enabled: true } });
  if (stray) throw new Error(`refusing: this database already has ${stray} enabled client-update policies, and the sweep acts on every one`);
  originalPin = (await prisma.platformSettings.findUnique({ where: { id: 'singleton' } }))?.rustdeskPinnedVersion ?? null;
  await prisma.platformSettings.upsert({ where: { id: 'singleton' }, update: { rustdeskPinnedVersion: TARGET }, create: { id: 'singleton', rustdeskPinnedVersion: TARGET } });

  section('Fixtures (synthetic): Acme (site HQ, groups Kiosks and Pilot) and Birch (group Pilot), the same hostnames in both');
  const A = await prisma.customer.create({ data: { tenantId: tenant.id, name: `${TAG} Acme` } });
  const B = await prisma.customer.create({ data: { tenantId: tenant.id, name: `${TAG} Birch` } });
  const C = await prisma.customer.create({ data: { tenantId: tenant.id, name: `${TAG} Cedar (no computers)` } });
  created.businesses.push(A.id, B.id, C.id);
  const hq = await prisma.site.create({ data: { tenantId: tenant.id, customerId: A.id, name: `${TAG} HQ` } });
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (t, extra = {}) => { const u = await prisma.user.create({ data: { email: `ah-${t}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'AH', lastName: t, status: 'ACTIVE', ...extra } }); created.users.push(u.id); return u; };
  const admin = await mkUser('admin', { isPlatformAdmin: true });
  const owen = await mkUser('owen-acme'), bea = await mkUser('bea-birch');
  await prisma.membership.create({ data: { userId: owen.id, tenantId: tenant.id, customerId: A.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: bea.id, tenantId: tenant.id, customerId: B.id, roleId: roleOwner.id } });

  const eps = {};
  const mkEp = async (key, biz, { site = null, online = true, seenAgoMs = 0, never = false, version = '1.4.5' } = {}) => {
    const name = key.replace(/^[ab]:/, '');
    const e = await prisma.endpoint.create({ data: {
      tenantId: tenant.id, customerId: biz.id, siteId: site?.id ?? null, name: `${TAG}-${name}`, hostname: `${TAG}-${name}`.toLowerCase(),
      platform: 'Windows', status: 'ACTIVE', isOnline: online, isManaged: true, accessMode: 'COMPANY_WIDE', agentVersion: '0.35.0',
      lastSeenAt: never ? null : new Date(Date.now() - seenAgoMs),
    } });
    const rid = String(100000000 + ((Math.random() * 899999999) | 0));
    const secret = randomBytes(16).toString('hex');
    await prisma.rustdeskNode.create({ data: { tenantId: tenant.id, endpointId: e.id, rustdeskId: rid, version, platform: 'Windows', agentSecretHash: sha(secret) } });
    eps[key] = { ...e, rid, secret };
    return eps[key];
  };
  // Agent health. Current RustDesk, so the client-update sweep leaves them alone.
  await mkEp('a:SILENT', A, { seenAgoMs: 90 * MIN });           // DESKTOP-4SADDCN: reachable, agent silent 90 min
  await mkEp('a:FRESH', A, { seenAgoMs: 2 * MIN });
  await mkEp('a:DARK', A, { online: false, seenAgoMs: 90 * MIN }); // offline: the Offline monitor's case
  await mkEp('a:NEVER', A, { never: true });                      // RustDesk only, agent never checked in
  await mkEp('a:KIOSK', A, { seenAgoMs: 120 * MIN });            // in group Kiosks (threshold 240)
  await mkEp('a:HQPC', A, { site: hq, seenAgoMs: 90 * MIN });     // site HQ switches the monitor off
  await mkEp('a:COMP', A, { seenAgoMs: 45 * MIN });              // its own monitor: 30 minutes
  await mkEp('a:FLAP', A, { seenAgoMs: 90 * MIN });              // reachability drops while its alert is open
  await mkEp('b:SILENT', B, { seenAgoMs: 90 * MIN });            // same hostname as Acme's, Birch has no monitor
  // Client updates: outdated, online, Windows, bound.
  await mkEp('a:CU1', A, { version: OLD });
  await mkEp('a:CU2', A, { version: OLD });
  await mkEp('a:CU3', A, { version: OLD });
  await mkEp('a:CU4', A, { version: OLD });
  await mkEp('b:CU1', B, { version: OLD });
  const mkGroup = (biz, name) => prisma.endpointGroup.create({ data: { tenantId: tenant.id, customerId: biz.id, name: `${TAG} ${name}` } });
  const kiosks = await mkGroup(A, 'Kiosks');
  const pilotA = await mkGroup(A, 'Pilot');
  const pilotB = await mkGroup(B, 'Pilot');
  await prisma.endpointGroupMember.createMany({ data: [
    { endpointGroupId: kiosks.id, endpointId: eps['a:KIOSK'].id },
    { endpointGroupId: pilotA.id, endpointId: eps['a:CU1'].id }, { endpointGroupId: pilotA.id, endpointId: eps['a:CU2'].id }, { endpointGroupId: pilotA.id, endpointId: eps['a:CU4'].id },
    { endpointGroupId: pilotB.id, endpointId: eps['b:CU1'].id },
  ] });
  check(true, `created 3 businesses (Cedar has no computers), 1 site, ${Object.keys(eps).length} computers, 3 device groups, 3 people`);

  await listen();
  startApi();
  await waitUp();
  const S = { admin: await login(admin.email), owen: await login(owen.email), bea: await login(bea.email) };
  const ep = (k) => eps[k];
  const openAlert = (k, key = 'agent-silent') => prisma.monitorAlert.findFirst({ where: { endpointId: ep(k).id, ruleKey: key, state: { not: 'RESOLVED' } } });
  const silentAlerts = (k) => prisma.monitorAlert.findMany({ where: { endpointId: ep(k).id, kind: 'AGENT_SILENT' } });
  const rule = (s, body) => req('POST', '/monitoring/rules', { s, body: { kind: 'AGENT_SILENT', name: 'Agent silent', ...body } });

  // Who is notified: a global policy to the loopback receiver (the MSP, with fresh authentication — §17).
  const adminUp = await stepUp(S.admin);
  let r = await req('PUT', '/monitoring/notify-policy', { s: adminUp, body: { scope: 'global', levels: [{ afterMinutes: 0, minSeverity: 'INFO', destinations: [{ label: 'on-call', url: `http://127.0.0.1:${HOOK_PORT}/hook` }] }], ticketing: { enabled: false, minSeverity: 'CRITICAL' } } });
  check(r.status === 200, 'the MSP sets a global notification policy to a test webhook (fresh authentication)', msg(r));
  created.globalPolicy = r.status === 200;

  // ── 1. Off until created ───────────────────────────────────────────────────
  section('Off until created: nothing is raised until someone creates the monitor');
  await ticks(2);
  check((await prisma.monitorAlert.count({ where: { kind: 'AGENT_SILENT', customerId: { in: [A.id, B.id] } } })) === 0, 'no monitor anywhere: two sweeps raise no agent-silent alert, though SILENT has been silent 90 minutes');
  r = await req('GET', `/monitoring/rules?businessId=${A.id}`, { s: S.owen });
  check(r.status === 200 && r.data.recommended.some((x) => x.kind === 'AGENT_SILENT' && x.key === 'agent-silent' && x.severity === 'WARNING' && x.params.minutes === 60) && r.data.optional === undefined,
    'the rules page lists it among the recommended (key agent-silent, WARNING, 60 minutes); there is no separate optional list', J({ rec: r.data?.recommended?.map((x) => x.kind), opt: r.data?.optional }));
  check(r.status === 200 && !r.data.rules.some((x) => x.kind === 'AGENT_SILENT'), 'being recommended created nothing: Acme has no agent-silent rule', J(r.data?.rules?.map((x) => x.key)));
  // The click itself, on Cedar, which has no computers: nothing it adds can raise mid-run.
  r = await req('POST', '/monitoring/rules/recommended', { s: S.admin, body: { scope: 'business', businessId: C.id } });
  const addedSilent = r.data?.added?.filter((x) => x.kind === 'AGENT_SILENT') ?? [];
  check(r.status === 201 && r.data.added.length === 7 && addedSilent.length === 1 && addedSilent[0].key === 'agent-silent' && addedSilent[0].params.minutes === 60 && addedSilent[0].severity === 'WARNING',
    '“Add recommended” adds the seven starters, the agent-silent monitor among them (60 minutes, WARNING)', msg(r));
  check((await prisma.activityLog.count({ where: { customerId: C.id, action: 'MONITOR_RULE_CHANGED' } })) === 7, 'each one is an ordinary audited rule (seven MONITOR_RULE_CHANGED rows)');
  r = await req('POST', '/monitoring/rules/recommended', { s: S.admin, body: { scope: 'business', businessId: C.id } });
  check(r.status === 201 && r.data.added.length === 0, 'a second click adds nothing: the set is all there', msg(r));
  await prisma.monitorRule.deleteMany({ where: { customerId: C.id } });

  section('Bounds');
  r = await rule(S.owen, { scope: 'business', businessId: A.id, key: 'agent-silent', params: { minutes: 29 } });
  check(r.status === 400 && code(r) === 'INVALID_PARAMS', '29 minutes is refused (under the console’s 30-minute agent-silent window)', msg(r));
  r = await rule(S.owen, { scope: 'business', businessId: A.id, key: 'agent-silent', params: { minutes: 10081 } });
  check(r.status === 400 && code(r) === 'INVALID_PARAMS', 'more than 7 days is refused', msg(r));
  r = await rule(S.bea, { scope: 'business', businessId: A.id, key: 'agent-silent', params: { minutes: 60 } });
  check(r.status === 403 || r.status === 404, 'Birch’s owner cannot set a monitor for Acme', msg(r));

  // ── Raise ──────────────────────────────────────────────────────────────────
  section('Raise: Acme turns it on at 60 minutes');
  r = await rule(S.owen, { scope: 'business', businessId: A.id, key: 'agent-silent', params: {} });
  check(r.status === 201 && r.data.kind === 'AGENT_SILENT' && r.data.params.minutes === 60, 'business monitor created; minutes defaults to 60', msg(r));
  const a1 = await until(() => openAlert('a:SILENT'));
  check(!!a1 && a1.kind === 'AGENT_SILENT' && a1.severity === 'WARNING', 'SILENT (reachable, agent silent 90 min) is raised', J(a1));
  check(/agent silent for 1 h — remote control should still work/.test(a1?.title ?? ''), 'the title says how long and that remote control should still work', a1?.title);
  check(/Update agent/.test(a1?.detail?.whatToDo ?? '') && /re-run the installer/.test(a1?.detail?.whatToDo ?? '') && a1?.detail?.thresholdMinutes === 60 && a1?.detail?.silentMinutes >= 90,
    'the detail suggests Update agent or re-running the installer, with the threshold and minutes silent', J(a1?.detail));
  await ticks(2);
  check(!(await openAlert('a:FRESH')), 'FRESH (checked in 2 minutes ago): nothing');
  check(!(await openAlert('a:DARK')), 'DARK (not reachable): nothing — that is the Offline monitor’s case');
  check(!(await openAlert('a:NEVER')), 'NEVER (agent never checked in): nothing');
  check(!!(await openAlert('a:HQPC')), 'HQPC (site HQ) is raised by the business monitor, before the site override');
  check(!!(await openAlert('a:KIOSK')), 'KIOSK (silent 120 min) is raised by the business monitor, before the group monitor');
  check((await silentAlerts('b:SILENT')).length === 0, 'Birch’s SILENT, same hostname, no monitor in Birch: nothing (opt-in per business)');
  const dupes = await silentAlerts('a:SILENT');
  check(dupes.length === 1 && dupes[0].occurrences === 1, 'after more sweeps: still one alert for SILENT, one occurrence (one open alert per problem)', J(dupes.map((x) => [x.state, x.occurrences])));
  const told = await until(() => hookFor(a1.id, 'alert.notify').length > 0);
  const h = hookFor(a1.id, 'alert.notify')[0]?.body;
  check(!!told && h?.alert?.kind === 'AGENT_SILENT' && h.alert.monitor === 'agent-silent' && /remote control should still work/.test(h.alert.title), 'the policy notifies it: the webhook gets alert.notify, kind AGENT_SILENT', J(h));

  section('Precedence: site, group and computer scopes');
  r = await rule(S.owen, { scope: 'site', businessId: A.id, siteId: hq.id, key: 'agent-silent', enabled: false, params: {} });
  check(r.status === 201, 'site HQ: the same key, switched off', msg(r));
  r = await rule(S.owen, { scope: 'group', businessId: A.id, groupId: kiosks.id, priority: 1, key: 'agent-silent', params: { minutes: 240 } });
  check(r.status === 201 && r.data.scope === 'group', 'group Kiosks: 240 minutes, priority 1', msg(r));
  const hqClosed = await until(async () => (await silentAlerts('a:HQPC')).every((x) => x.state === 'RESOLVED'));
  check(hqClosed, 'HQPC’s alert closes: the site switched the monitor off there');
  const kClosed = await until(async () => (await silentAlerts('a:KIOSK')).every((x) => x.state === 'RESOLVED'));
  check(kClosed, 'KIOSK’s alert closes: silent 120 min is inside its group’s 240');
  r = await req('GET', `/monitoring/endpoints/${ep('a:KIOSK').id}`, { s: S.owen });
  const kr = r.data?.rules?.find((x) => x.key === 'agent-silent');
  check(kr?.inheritedFrom === `g:${kiosks.id}` && kr.params.minutes === 240, 'the device page says KIOSK follows group Kiosks at 240 minutes', J(kr));
  r = await req('POST', '/endpoints/bulk', { s: S.owen, body: { action: 'group.remove', groupId: kiosks.id, endpointIds: [ep('a:KIOSK').id] } });
  check(r.status === 200 && r.data.succeeded === 1, 'KIOSK leaves group Kiosks', msg(r));
  const kAgain = await until(() => openAlert('a:KIOSK'));
  check(!!kAgain, '…and the next sweep raises it again under the business monitor (membership is read every tick)');
  // A maintenance window on COMP before its own monitor exists.
  r = await req('POST', '/monitoring/suppressions', { s: S.owen, body: { scope: 'endpoint', businessId: A.id, endpointId: ep('a:COMP').id, ruleKeys: ['agent-silent'], reason: 'Reimaging this week', endsAt: new Date(Date.now() + 3600_000).toISOString() } });
  check(r.status === 201 || r.status === 200, 'a maintenance window for COMP, agent-silent only', msg(r));
  const win = r.data;
  check(!(await openAlert('a:COMP')), 'COMP (silent 45 min) is under the business’s 60: nothing yet');
  r = await rule(S.owen, { scope: 'endpoint', businessId: A.id, endpointId: ep('a:COMP').id, key: 'agent-silent', params: { minutes: 30 } });
  check(r.status === 201 && r.data.scope === 'endpoint', 'COMP’s own monitor: 30 minutes', msg(r));
  const comp = await until(() => openAlert('a:COMP'));
  check(!!comp, 'COMP is raised under its own 30-minute threshold');
  const held = await until(async () => (await prisma.monitorAlert.findUnique({ where: { id: comp.id } }))?.suppressed);
  check(!!held, 'and held by the maintenance window: raised and shown, flagged suppressed');
  await ticks(2);
  check(hookFor(comp.id).length === 0, 'nobody is told while the window is open');
  r = await req('POST', `/monitoring/suppressions/${win?.id}/revoke`, { s: S.owen });
  check(r.status === 201 || r.status === 200, 'the window is ended early', msg(r));
  const released = await until(() => hookFor(comp.id, 'alert.notify').length > 0);
  check(!!released, 'and the alert is notified at once');

  section('Visibility: the device page carries it; Birch sees none of it');
  r = await req('GET', `/monitoring/endpoints/${ep('a:SILENT').id}`, { s: S.owen });
  const view = r.data?.alerts?.find((x) => x.kind === 'AGENT_SILENT' && x.state !== 'RESOLVED');
  check(r.status === 200 && view?.id === a1.id && view.monitor === 'agent-silent', 'GET /monitoring/endpoints/:id (what the Agent card and header link from) lists the open AGENT_SILENT alert', msg(r));
  r = await req('GET', `/monitoring/alerts/${a1.id}`, { s: S.owen });
  check(r.status === 200 && r.data.id === a1.id && r.data.events.some((e) => e.type === 'raised'), 'the alert page (/alerts?alert=<id>) opens it with its history', msg(r));
  r = await req('GET', `/monitoring/alerts/${a1.id}`, { s: S.bea });
  check(r.status === 404, 'Birch’s owner: Acme’s alert is a 404', msg(r));
  r = await req('GET', `/monitoring/endpoints/${ep('a:SILENT').id}`, { s: S.bea });
  check(r.status === 404, 'and Acme’s computer is a 404', msg(r));
  r = await req('GET', '/monitoring/alerts?kind=AGENT_SILENT', { s: S.bea });
  check(r.status === 200 && r.data.alerts.length === 0, 'Birch’s alert list has no agent-silent alerts', msg(r));
  r = await req('GET', '/monitoring/alerts?kind=AGENT_SILENT', { s: S.owen });
  const ownIds = new Set((r.data?.alerts ?? []).map((x) => x.computer?.id));
  check(r.status === 200 && ownIds.has(ep('a:SILENT').id) && !ownIds.has(ep('b:SILENT').id), 'Acme’s list has SILENT’s alert and not Birch’s computer', msg(r));

  section('Hold and resolve');
  const flap = await until(() => openAlert('a:FLAP'));
  await prisma.endpoint.update({ where: { id: ep('a:FLAP').id }, data: { isOnline: false } });
  await ticks(2);
  const f2 = await prisma.monitorAlert.findUnique({ where: { id: flap.id } });
  check(f2.state === 'OPEN', 'FLAP becomes unreachable while its alert is open: it stays open (a hbbs restart does not resolve and re-raise it)', f2.state);
  await prisma.endpoint.update({ where: { id: ep('a:FLAP').id }, data: { isOnline: true } });
  await ticks(1);
  check((await silentAlerts('a:FLAP')).length === 1, 'reachable again: still the same single alert');
  r = await req('POST', '/enrollment/heartbeat', { body: { rustdeskId: ep('a:SILENT').rid, agentSecret: ep('a:SILENT').secret, hostname: ep('a:SILENT').hostname, platform: 'Windows', agentVersion: '0.35.0' } });
  check(r.status === 200, 'SILENT’s agent checks in', msg(r));
  const resolved = await until(async () => { const x = await prisma.monitorAlert.findUnique({ where: { id: a1.id } }); return x?.state === 'RESOLVED' ? x : null; });
  check(!!resolved && resolved.resolvedById === null && /Cleared/.test(resolved.resolveNote ?? ''), 'its alert resolves on the next sweep, by the monitor (Cleared)', J(resolved));
  const rh = await until(() => hookFor(a1.id, 'alert.resolved').length > 0);
  check(!!rh, 'and whoever was told is told it resolved');
  await ticks(1);
  check(!(await openAlert('a:SILENT')), 'and it is not raised again');

  // ── 2. Client updates ──────────────────────────────────────────────────────
  section('Client updates: a queued request follows the computer out of its group');
  const owenUp = await stepUp(S.owen), beaUp = await stepUp(S.bea);
  r = await req('PUT', '/client-updates/policy', { s: S.owen, body: cu(A.id, closedWindow(), { enabled: false }) });
  check(r.status === 200, 'Acme: business policy off', msg(r));
  r = await req('PUT', '/client-updates/policy', { s: beaUp, body: cu(B.id, openWindow()) });
  check(r.status === 200, 'Birch: business policy on, window open now', msg(r));
  const bizB = r.data?.policy?.id;
  // A pre-0.36 POLICY request on CU4 (no policy recorded), and a MANUAL one on CU3.
  await prisma.rustdeskNode.update({ where: { endpointId: ep('a:CU4').id }, data: { updateRequestedAt: new Date(), updateTargetVersion: TARGET, updateRequestSource: 'POLICY', updatePolicyId: null } });
  await prisma.rustdeskNode.update({ where: { endpointId: ep('a:CU3').id }, data: { updateRequestedAt: new Date(), updateTargetVersion: TARGET, updateRequestSource: 'MANUAL', updateRequestedById: owen.id } });
  r = await req('PUT', '/client-updates/policy', { s: owenUp, body: cu(A.id, openWindow(), { groupId: pilotA.id, priority: 1 }) });
  check(r.status === 200, 'Acme: group Pilot policy on (CU1, CU2, CU4), window open', msg(r));
  const pA = r.data?.policy?.id;
  r = await req('PUT', '/client-updates/policy', { s: beaUp, body: cu(B.id, openWindow(), { groupId: pilotB.id, priority: 1 }) });
  check(r.status === 200, 'Birch: group Pilot policy on (CU1)', msg(r));
  const pB = r.data?.policy?.id;
  const node = (k) => prisma.rustdeskNode.findUnique({ where: { endpointId: ep(k).id } });
  const queuedAll = await until(async () => {
    const n = await Promise.all(['a:CU1', 'a:CU2', 'b:CU1'].map(node));
    return n.every((x) => x.updateRequestSource === 'POLICY' && x.updateRequestedAt) ? n : null;
  });
  check(!!queuedAll && queuedAll[0].updatePolicyId === pA && queuedAll[1].updatePolicyId === pA && queuedAll[2].updatePolicyId === pB,
    'the sweep queues Acme CU1, CU2 under Acme’s Pilot policy and Birch CU1 under Birch’s, recording the policy', J(queuedAll?.map((x) => [x.updateRequestSource, x.updatePolicyId])));
  const cu4 = await until(async () => { const x = await node('a:CU4'); return x.updatePolicyId === pA ? x : null; });
  check(!!cu4 && cu4.updateRequestSource === 'POLICY' && !!cu4.updateRequestedAt, 'CU4’s pre-0.36 request is adopted by the Pilot policy that governs it, still queued', J(cu4));
  check((await prisma.activityLog.count({ where: { resourceId: ep('a:CU4').id, action: { in: ['CLIENT_UPDATE_AUTO_WITHDRAWN', 'CLIENT_UPDATE_AUTO_REPLANNED'] } } })) === 0, 'adopting is not audited as a change (nothing about the request changed)');

  r = await req('POST', '/endpoints/bulk', { s: S.owen, body: { action: 'group.remove', groupId: pilotA.id, endpointIds: [ep('a:CU1').id] } });
  check(r.status === 200 && r.data.succeeded === 1, 'Acme CU1 leaves group Pilot (Acme’s business policy is off)', msg(r));
  const w = await until(async () => { const x = await node('a:CU1'); return x.updateRequestedAt === null ? x : null; });
  check(!!w && w.updateRequestSource === null && w.updatePolicyId === null, 'within a sweep its queued update is withdrawn — not held as policy_off until the next policy save', J(w));
  const wa = await until(() => prisma.activityLog.findFirst({ where: { action: 'CLIENT_UPDATE_AUTO_WITHDRAWN', resourceId: ep('a:CU1').id } }));
  check(!!wa && wa.customerId === A.id && wa.metadata?.reason === 'no_longer_applies' && wa.metadata?.fromPolicyId === pA && wa.metadata?.toPolicyId === null && /no longer applies/.test(wa.metadata?.text ?? ''),
    'audited CLIENT_UPDATE_AUTO_WITHDRAWN, reason no_longer_applies, from the Pilot policy', J(wa?.metadata));
  r = await req('POST', '/enrollment/heartbeat', { body: { rustdeskId: ep('a:CU1').rid, agentSecret: ep('a:CU1').secret, hostname: ep('a:CU1').hostname, platform: 'Windows', rustdeskVersion: OLD, rustdeskSessions: 0, loggedOnUser: '' } });
  check(r.status === 200 && !r.data?.updateRustdesk, 'CU1’s next heartbeat is handed no update', msg(r));
  const cu2 = await node('a:CU2');
  check(cu2.updateRequestedAt && cu2.updatePolicyId === pA, 'CU2, still in the group: still queued under Pilot (kept)');
  const cu3 = await node('a:CU3');
  check(cu3.updateRequestSource === 'MANUAL' && !!cu3.updateRequestedAt, 'CU3’s manual request, governed by no enabled policy, is never touched');
  await ticks(2);
  const cu1Later = await node('a:CU1');
  check(cu1Later.updateRequestedAt === null && (await prisma.activityLog.count({ where: { action: 'CLIENT_UPDATE_AUTO_WITHDRAWN', resourceId: ep('a:CU1').id } })) === 1, 'later sweeps do not queue it again (no enabled policy governs it) and do not audit it twice');

  section('Client updates: re-planned when another policy governs it now');
  r = await req('POST', '/endpoints/bulk', { s: S.bea, body: { action: 'group.remove', groupId: pilotB.id, endpointIds: [ep('b:CU1').id] } });
  check(r.status === 200 && r.data.succeeded === 1, 'Birch CU1 leaves Birch’s group Pilot (Birch’s business policy is on)', msg(r));
  const rp = await until(async () => { const x = await node('b:CU1'); return x.updatePolicyId === bizB ? x : null; });
  check(!!rp && !!rp.updateRequestedAt && rp.updateRequestSource === 'POLICY' && rp.updateHoldReason === null, 'its request stays queued, now under Birch’s business policy', J(rp));
  const ra = await until(() => prisma.activityLog.findFirst({ where: { action: 'CLIENT_UPDATE_AUTO_REPLANNED', resourceId: ep('b:CU1').id } }));
  check(!!ra && ra.customerId === B.id && ra.metadata?.reason === 'no_longer_applies' && ra.metadata?.fromPolicyId === pB && ra.metadata?.toPolicyId === bizB && ra.metadata?.toScope === 'business',
    'audited CLIENT_UPDATE_AUTO_REPLANNED: from Birch’s Pilot policy to its business policy', J(ra?.metadata));
  r = await req('POST', '/enrollment/heartbeat', { body: { rustdeskId: ep('b:CU1').rid, agentSecret: ep('b:CU1').secret, hostname: ep('b:CU1').hostname, platform: 'Windows', rustdeskVersion: OLD, rustdeskSessions: 0, loggedOnUser: '' } });
  check(r.status === 200 && r.data?.updateRustdesk?.targetVersion === TARGET, 'its heartbeat is handed the update inside the business policy’s window', msg(r));

  section('Client updates: business isolation');
  check((await prisma.activityLog.count({ where: { action: { in: ['CLIENT_UPDATE_AUTO_WITHDRAWN', 'CLIENT_UPDATE_AUTO_REPLANNED'] }, customerId: B.id, resourceId: { in: ['a:CU1', 'a:CU2', 'a:CU3', 'a:CU4'].map((k) => ep(k).id) } } })) === 0,
    'no Birch-attributed entry names an Acme computer');
  r = await req('GET', `/client-updates/computers?businessId=${A.id}`, { s: S.bea });
  check(r.status === 403 || r.status === 404 || (r.status === 200 && !(r.data?.computers ?? []).some((c) => c.id === ep('a:CU1').id)), 'Birch’s owner cannot read Acme’s client-update computers', msg(r));
  r = await req('GET', `/client-updates/computers?businessId=${B.id}`, { s: S.bea });
  const bc = (r.data?.computers ?? []).find((c) => c.id === ep('b:CU1').id);
  check(r.status === 200 && bc?.state?.startsWith('queued_auto') && bc.policy?.scope === 'business' && !(r.data.computers ?? []).some((c) => c.id === ep('a:CU1').id),
    'Birch’s view: CU1 queued automatically under its business policy, and no Acme computer', J(bc));
  r = await req('GET', `/client-updates/computers?businessId=${A.id}`, { s: S.owen });
  const ac = (r.data?.computers ?? []).find((c) => c.id === ep('a:CU1').id);
  check(r.status === 200 && ac && !ac.state.startsWith('queued') && ac.policy?.scope === 'business' && ac.policy.enabled === false, 'Acme’s view: CU1 is no longer queued and follows the business policy (off)', J(ac));
}

async function cleanup() {
  await stopApi();
  hookServer?.close();
  try {
    if (originalPin !== undefined) await prisma.platformSettings.update({ where: { id: 'singleton' }, data: { rustdeskPinnedVersion: originalPin } }).catch(() => {});
    if (created.globalPolicy) await prisma.monitorNotifyPolicy.deleteMany({ where: { scopeKey: 'global' } });
    const ids = created.businesses;
    await prisma.clientUpdatePolicy.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.monitorSuppression.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.monitorRule.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.monitorAlert.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.monitorNotifyPolicy.deleteMany({ where: { customerId: { in: ids } } });
    const eps = (await prisma.endpoint.findMany({ where: { customerId: { in: ids } }, select: { id: true } })).map((e) => e.id);
    await prisma.endpointMonitorState.deleteMany({ where: { endpointId: { in: eps } } });
    await prisma.endpointGroupMember.deleteMany({ where: { endpointId: { in: eps } } });
    await prisma.endpointGroup.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.endpointInventory.deleteMany({ where: { endpointId: { in: eps } } });
    await prisma.endpointCommand.deleteMany({ where: { endpointId: { in: eps } } });
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
