#!/usr/bin/env node
/**
 * End-to-end proof of scheduled RustDesk client updates (0.32):
 * /client-updates/*, the client-update sweep and the heartbeat's hold.
 *
 *   - the sweep queues outdated online Windows computers INSIDE the window
 *     and nothing outside it, at most CLIENT_UPDATE_SWEEP_BATCH per sweep,
 *     never a computer that is offline, not Windows, without a device secret,
 *     that has never reported a version, already current, or in a session;
 *   - a site override replaces the business policy for its site;
 *   - the heartbeat withholds a POLICY request outside the window, during an
 *     open session, and (when asked) while someone is logged on or the agent
 *     does not say; a MANUAL request still goes at once, and every view says
 *     which kind each one is and who queued it;
 *   - an "updates" containment pause stops the sweep queuing and the
 *     heartbeat handing out;
 *   - who may set a policy: the business's owner, a technician with
 *     computers:edit over the whole business, the MSP — not a Business User,
 *     not a technician limited to named computers or without edit, never
 *     another business's owner; turning it on needs fresh authentication and
 *     turning it off does not;
 *   - policy changes and automatic queuing are audited.
 *
 * Self-starting: it runs its own API from dist/ on AUTOUPD_API_PORT (3211),
 * with the sweep every 2 seconds, against DATABASE_URL, which must name a
 * scratch/test database. Fixtures are namespaced and removed at the end
 * (audit rows are not deleted: they are sealed, see CLAUDE.md).
 *
 * Run:  DATABASE_URL=…/rem0te_autoupd_test node scripts/e2e-auto-updates.mjs
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
const PORT = Number(process.env.AUTOUPD_API_PORT ?? 3211);
if ([3000, 3001, 443, 4000, 4001].includes(PORT)) { console.error(`Refusing port ${PORT}: that is a production port.`); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'auto-updates-e2e-password-1';
const TAG = `AU${sfx}`;
const TARGET = '1.4.5', OLD = '1.4.0';
const BATCH = 2;
const SWEEP_SECONDS = 2;

let pass = 0, fail = 0;
const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const until = async (fn, ms = 20_000, step = 300) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(step); } return v; };

const apiEnv = {
  ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATABASE_URL: DB,
  JWT_SECRET: randomBytes(32).toString('hex'), LAUNCHER_TOKEN_SECRET: randomBytes(32).toString('hex'),
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? randomBytes(32).toString('hex'), TRUSTED_PROXIES: 'loopback',
  HBBS_PRESENCE_HOST: '127.0.0.2', MONITOR_SWEEP: 'off', AUDIT_SEALER: 'off',
  CLIENT_UPDATE_SWEEP: 'on', CLIENT_UPDATE_SWEEP_SECONDS: String(SWEEP_SECONDS), CLIENT_UPDATE_SWEEP_BATCH: String(BATCH),
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

async function req(method, p, { s, body, business } = {}) {
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
  if (r.status !== 200 || !mm) throw new Error(`login ${email}: ${r.status} ${JSON.stringify(r.body)}`);
  return { cookie: `access_token=${mm[1]}` };
}
async function stepUp(s) {
  const r = await req('POST', '/auth/step-up', { s, body: { password: PW } });
  const mm = r.setCookie.match(/step_up=([^;]+)/);
  if (r.status !== 200 || !mm) throw new Error(`step-up: ${r.status} ${JSON.stringify(r.body)}`);
  return { ...s, stepUp: mm[1] };
}
const code = (r) => r.body?.code ?? r.body?.message?.code ?? r.body?.error?.code;
const msg = (r) => `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`;

/** A window open now (it began an hour ago) or closed now (it begins in three hours), every day, in UTC. */
const hhmm = (d) => `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
const ALL = [0, 1, 2, 3, 4, 5, 6];
const openWindow = () => [{ days: ALL, start: hhmm(new Date(Date.now() - 3600_000)), end: hhmm(new Date(Date.now() + 2 * 3600_000)) }];
const closedWindow = () => [{ days: ALL, start: hhmm(new Date(Date.now() + 3 * 3600_000)), end: hhmm(new Date(Date.now() + 5 * 3600_000)) }];
const policy = (businessId, windows, extra = {}) => ({ businessId, enabled: true, timeZone: 'UTC', windows, skipActiveSession: true, skipLoggedOnUser: false, ...extra });

const created = { businesses: [], users: [] };
let originalPin;

async function all() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });
  const roleUser = await prisma.role.findFirst({ where: { type: 'BUSINESS_USER' } });
  // The sweep acts on every enabled policy in the database; a leftover from
  // another run would make this suite's counts meaningless.
  const stray = await prisma.clientUpdatePolicy.count({ where: { enabled: true } });
  if (stray) throw new Error(`refusing: this database already has ${stray} enabled client-update policies`);
  originalPin = (await prisma.platformSettings.findUnique({ where: { id: 'singleton' } }))?.rustdeskPinnedVersion ?? null;
  await prisma.platformSettings.upsert({ where: { id: 'singleton' }, update: { rustdeskPinnedVersion: TARGET }, create: { id: 'singleton', rustdeskPinnedVersion: TARGET } });

  section('Fixtures (synthetic): Acme (HQ, Depot) and Birch (Main); target pinned to 1.4.5');
  const A = await prisma.customer.create({ data: { tenantId: tenant.id, name: `${TAG} Acme` } });
  const B = await prisma.customer.create({ data: { tenantId: tenant.id, name: `${TAG} Birch` } });
  created.businesses.push(A.id, B.id);
  const hq = await prisma.site.create({ data: { tenantId: tenant.id, customerId: A.id, name: `${TAG} HQ` } });
  const depot = await prisma.site.create({ data: { tenantId: tenant.id, customerId: A.id, name: `${TAG} Depot` } });
  const bMain = await prisma.site.create({ data: { tenantId: tenant.id, customerId: B.id, name: `${TAG} Main` } });

  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag, extra = {}) => { const u = await prisma.user.create({ data: { email: `au-${tag}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'AU', lastName: tag, status: 'ACTIVE', ...extra } }); created.users.push(u.id); return u; };
  const admin = await mkUser('admin', { isPlatformAdmin: true });
  const ownerA = await mkUser('owner-a'), ownerB = await mkUser('owner-b');
  const userA = await mkUser('user-a');
  const techWhole = await mkUser('tech-whole'), techNamed = await mkUser('tech-named'), techView = await mkUser('tech-view');
  await prisma.membership.create({ data: { userId: ownerA.id, tenantId: tenant.id, customerId: A.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: ownerB.id, tenantId: tenant.id, customerId: B.id, roleId: roleOwner.id } });
  // A Business User holding every computer permission there is.
  await prisma.membership.create({ data: { userId: userA.id, tenantId: tenant.id, customerId: A.id, roleId: roleUser.id, capabilities: ['computers:view', 'computers:edit', 'computers:connect'] } });

  const eps = {};
  const mkEp = async (key, biz, { site = null, platform = 'Windows', online = true, secret = true, version = OLD } = {}) => {
    const e = await prisma.endpoint.create({ data: {
      tenantId: tenant.id, customerId: biz.id, siteId: site?.id ?? null, name: `${TAG}-${key}`, hostname: `${TAG}-${key}`.toLowerCase(),
      platform, status: 'ACTIVE', isOnline: online, isManaged: true, accessMode: 'COMPANY_WIDE', lastSeenAt: new Date(online ? Date.now() : Date.now() - 86400_000),
    } });
    const rid = String(100000000 + ((Math.random() * 899999999) | 0));
    const sec = randomBytes(16).toString('hex');
    await prisma.rustdeskNode.create({ data: { tenantId: tenant.id, endpointId: e.id, rustdeskId: rid, version, platform, agentSecretHash: secret ? sha(sec) : null } });
    eps[key] = { ...e, rid, secret: sec };
    return eps[key];
  };
  await mkEp('a1', A, { site: hq }); await mkEp('a2', A, { site: hq }); await mkEp('a3', A, { site: depot });
  await mkEp('a4', A); await mkEp('aSession', A, { site: hq });
  await mkEp('aMac', A, { platform: 'macOS' }); await mkEp('aNoSecret', A, { secret: false });
  await mkEp('aNoVersion', A, { version: null }); await mkEp('aOffline', A, { online: false }); await mkEp('aCurrent', A, { version: TARGET });
  await mkEp('b1', B, { site: bMain }); await mkEp('b2', B);
  await prisma.supportSession.create({ data: { tenantId: tenant.id, customerId: A.id, endpointId: eps.aSession.id, technicianId: admin.id, status: 'SESSION_STARTED', lastSignalAt: new Date() } });
  await prisma.technicianAssignment.create({ data: { tenantId: tenant.id, customerId: A.id, userId: techWhole.id, capabilities: ['computers:view', 'computers:edit'], endpointIds: [] } });
  await prisma.technicianAssignment.create({ data: { tenantId: tenant.id, customerId: A.id, userId: techNamed.id, capabilities: ['computers:view', 'computers:edit'], endpointIds: [eps.a1.id] } });
  await prisma.technicianAssignment.create({ data: { tenantId: tenant.id, customerId: A.id, userId: techView.id, capabilities: ['computers:view'], endpointIds: [] } });
  check(true, 'created 2 businesses, 3 sites, 12 computers, 7 people, 3 technician assignments');

  startApi();
  await waitUp();
  const S = {
    admin: await login(admin.email), ownerA: await login(ownerA.email), ownerB: await login(ownerB.email), userA: await login(userA.email),
    techWhole: await login(techWhole.email), techNamed: await login(techNamed.email), techView: await login(techView.email),
  };
  const node = (k) => prisma.rustdeskNode.findUnique({ where: { endpointId: eps[k].id } });
  const heartbeat = (k, extra = {}) => req('POST', '/enrollment/heartbeat', { body: { rustdeskId: eps[k].rid, agentSecret: eps[k].secret, hostname: eps[k].hostname, platform: 'Windows', rustdeskVersion: OLD, rustdeskSessions: 0, loggedOnUser: '', ...extra } });
  const queuedIn = async (biz) => prisma.rustdeskNode.findMany({ where: { endpoint: { customerId: biz.id }, updateRequestedAt: { not: null } }, include: { endpoint: { select: { name: true } } } });
  const sweeps = (n) => sleep(n * SWEEP_SECONDS * 1000 + 500);

  // ── Nothing without a policy ───────────────────────────────────────────────
  section('Without a policy nothing is queued');
  await sweeps(3);
  check((await queuedIn(A)).length === 0 && (await queuedIn(B)).length === 0, 'three sweeps, no policy anywhere: nothing queued');

  // ── Who may set it ─────────────────────────────────────────────────────────
  section('Who may set a policy');
  const ownerAUp = await stepUp(S.ownerA);
  let r = await req('PUT', '/client-updates/policy', { s: S.userA, body: { ...policy(A.id, closedWindow()), enabled: false } });
  check(r.status === 403 && code(r) === 'NOT_ALLOWED', 'a Business User — even with computers:edit — cannot set the policy', msg(r));
  r = await req('PUT', '/client-updates/policy', { s: S.techNamed, business: A.id, body: { ...policy(A.id, closedWindow()), enabled: false } });
  check(r.status === 403 && code(r) === 'NOT_ALLOWED', 'a technician whose computers:edit covers only named computers cannot', msg(r));
  r = await req('PUT', '/client-updates/policy', { s: S.techView, business: A.id, body: { ...policy(A.id, closedWindow()), enabled: false } });
  check(r.status === 403 && code(r) === 'NOT_ALLOWED', 'a technician with view only cannot', msg(r));
  const ownerBUp = await stepUp(S.ownerB);
  r = await req('PUT', '/client-updates/policy', { s: ownerBUp, body: policy(A.id, openWindow()) });
  check(r.status === 403, "Birch's owner cannot set Acme's policy, even with fresh authentication", msg(r));
  r = await req('PUT', '/client-updates/policy', { s: ownerAUp, body: { ...policy(A.id, openWindow()), siteId: bMain.id } });
  check(r.status === 404, "Acme's owner cannot put an override on Birch's site (404, not a hint that it exists)", msg(r));
  r = await req('GET', `/client-updates/policy?businessId=${A.id}`, { s: S.ownerB });
  check(r.status === 403, "Birch's owner cannot read Acme's policy", msg(r));
  r = await req('GET', `/client-updates/computers?businessId=${A.id}`, { s: S.ownerB });
  check(r.status === 403, "Birch's owner cannot list Acme's computers", msg(r));
  r = await req('PUT', '/client-updates/policy', { s: ownerAUp, body: { ...policy(A.id, closedWindow()), timeZone: 'Mars/Olympus' } });
  check(r.status === 400 && code(r) === 'INVALID_WINDOW', 'an unknown time zone is refused', msg(r));
  r = await req('PUT', '/client-updates/policy', { s: ownerAUp, body: policy(A.id, [{ days: [1], start: '02:00', end: '02:10' }]) });
  check(r.status === 400 && /shorter than 30/.test(JSON.stringify(r.body)), 'a ten-minute window is refused', msg(r));
  r = await req('PUT', '/client-updates/policy', { s: S.ownerA, body: policy(A.id, closedWindow()) });
  check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED' && r.body?.action === 'updates.schedule', 'turning a policy on needs fresh authentication', msg(r));
  r = await req('PUT', '/client-updates/policy', { s: S.ownerA, body: { ...policy(A.id, closedWindow()), enabled: false } });
  check(r.status === 200 && r.data?.policy?.enabled === false, 'saving it off does not', msg(r));
  const techUp = await stepUp(S.techWhole);
  r = await req('PUT', '/client-updates/policy', { s: techUp, business: A.id, body: { ...policy(A.id, closedWindow()), siteId: depot.id, enabled: false } });
  check(r.status === 200 && r.data?.policy?.siteId === depot.id, 'a technician with computers:edit over the whole business can (here: a Depot override, off)', msg(r));
  r = await req('GET', `/client-updates/policy?businessId=${A.id}`, { s: S.userA });
  check(r.status === 200 && r.data?.may?.edit === false && /Business Owner/.test(r.data?.may?.reason ?? ''), 'the Business User can read it, and is told why they cannot change it', msg(r));

  // ── Outside the window ─────────────────────────────────────────────────────
  section('Enabled, outside the window: nothing queued');
  r = await req('PUT', '/client-updates/policy', { s: ownerAUp, body: policy(A.id, closedWindow()) });
  check(r.status === 200 && r.data?.policy?.enabled === true && r.data.policy.window.open === false && !!r.data.policy.window.opensAt, 'Acme on, window closed now, with its next opening', msg(r));
  await sweeps(3);
  check((await queuedIn(A)).length === 0, 'three sweeps outside the window: nothing queued in Acme');
  r = await req('GET', `/client-updates/computers?businessId=${A.id}`, { s: S.ownerA });
  const row = (k) => r.data?.computers?.find((c) => c.id === eps[k].id);
  check(r.status === 200 && row('a1')?.state === 'eligible' && /when the window opens/.test(row('a1')?.text ?? ''), 'a1: outdated, will be queued when the window opens', JSON.stringify(row('a1')));
  check(row('aMac')?.state === 'blocked' && row('aMac').blocker.code === 'not_windows' && row('aMac').blocker.permanent, 'aMac: will never auto-update — not Windows', JSON.stringify(row('aMac')));
  check(row('aNoSecret')?.blocker?.code === 'no_device_secret' && row('aNoSecret').blocker.permanent, 'aNoSecret: never — no device secret', JSON.stringify(row('aNoSecret')));
  check(row('aNoVersion')?.blocker?.code === 'version_unknown', 'aNoVersion: never — has not reported a version', JSON.stringify(row('aNoVersion')));
  check(row('aOffline')?.blocker?.code === 'offline' && !row('aOffline').blocker.permanent, 'aOffline: not while offline (temporary)', JSON.stringify(row('aOffline')));
  check(row('aCurrent')?.state === 'current', 'aCurrent: already on the target');
  check(row('a3')?.state === 'manual_only' && row('a3').policy?.scope === 'site', 'a3 (Depot): its site override is off, so only manual updates', JSON.stringify(row('a3')));
  check(!r.data.computers.some((c) => [eps.b1.id, eps.b2.id].includes(c.id)), "Acme's list holds none of Birch's computers");

  // ── Containment, then Birch inside its window ──────────────────────────────
  section('An "updates" containment pause stops the sweep');
  const pause = await prisma.containmentPause.create({ data: { scope: 'BUSINESS', customerId: B.id, kinds: ['updates'], reason: `${TAG}: suspected compromise`, setById: admin.id, setBy: 'msp' } });
  r = await req('PUT', '/client-updates/policy', { s: ownerBUp, body: policy(B.id, openWindow()) });
  check(r.status === 200 && r.data?.policy?.window?.open === true, 'Birch on, window open now', msg(r));
  r = await req('GET', '/client-updates/policy', { s: S.ownerB });
  check(r.data?.containment?.paused === true, 'the page is told updates are paused for Birch', JSON.stringify(r.data?.containment));
  await sweeps(3);
  check((await queuedIn(B)).length === 0, 'three sweeps inside the window, but paused: nothing queued in Birch');
  await prisma.containmentPause.update({ where: { id: pause.id }, data: { clearedAt: new Date(), clearedById: admin.id, clearReason: 'test' } });
  const bq = await until(async () => { const q = await queuedIn(B); return q.length === 2 ? q : null; });
  check(bq?.length === 2 && bq.every((n) => n.updateRequestSource === 'POLICY' && n.updateTargetVersion === TARGET && n.updateRequestedById === null), 'pause lifted: Birch\'s two computers are queued, marked POLICY, for 1.4.5, by nobody', JSON.stringify(bq?.map((n) => [n.endpoint.name, n.updateRequestSource])));
  check((await queuedIn(A)).length === 0, "Birch's open window queued nothing in Acme");
  await prisma.containmentPause.create({ data: { scope: 'BUSINESS', customerId: B.id, kinds: ['updates'], reason: `${TAG}: again`, setById: admin.id, setBy: 'msp' } });
  r = await heartbeat('b1');
  check(r.status === 200 && !r.data?.updateRustdesk, 'paused again: the heartbeat withholds the queued update', msg(r));
  await prisma.containmentPause.updateMany({ where: { customerId: B.id, clearedAt: null }, data: { clearedAt: new Date(), clearedById: admin.id, clearReason: 'test' } });
  r = await heartbeat('b1');
  check(r.data?.updateRustdesk?.targetVersion === TARGET, 'lifted: the next heartbeat hands it out', msg(r));

  // ── Acme inside the window ─────────────────────────────────────────────────
  section('Acme inside the window: queued in batches, only what is eligible');
  const t0 = new Date();
  r = await req('PUT', '/client-updates/policy', { s: ownerAUp, body: policy(A.id, openWindow()) });
  check(r.status === 200 && r.data?.policy?.window?.open === true, 'Acme window open now', msg(r));
  const aq = await until(async () => { const q = await queuedIn(A); return q.length >= 3 ? q : null; });
  await sweeps(2);
  const qa = await queuedIn(A);
  const names = qa.map((n) => n.endpoint.name).sort();
  check(names.join() === [eps.a1.name, eps.a2.name, eps.a4.name].sort().join(), 'queued: a1, a2 (HQ, business policy) and a4 (no site) — and nothing else', JSON.stringify(names));
  check(!!aq && qa.every((n) => n.updateRequestSource === 'POLICY' && n.updateRequestedAt >= t0), 'every one is a POLICY request');
  const perSweep = new Map(); for (const n of qa) perSweep.set(n.updateRequestedAt.getTime(), (perSweep.get(n.updateRequestedAt.getTime()) ?? 0) + 1);
  check([...perSweep.values()].every((c) => c <= BATCH) && perSweep.size >= 2, `no sweep queued more than CLIENT_UPDATE_SWEEP_BATCH (${BATCH}); it took ${perSweep.size} sweeps`, JSON.stringify([...perSweep.values()]));
  check(!qa.some((n) => n.endpointId === eps.aSession.id), 'aSession (a confirmed session is open) is skipped');
  check(!qa.some((n) => n.endpointId === eps.a3.id), 'a3 (Depot override, off) is not queued');
  const audits = await prisma.activityLog.findMany({ where: { action: 'CLIENT_UPDATE_AUTO_QUEUED', customerId: A.id } });
  const a1Audit = audits.find((x) => x.resourceId === eps.a1.id);
  check(audits.length === 3 && a1Audit && a1Audit.actorId === null && a1Audit.metadata?.rustdeskFrom === OLD && a1Audit.metadata?.rustdeskTo === TARGET && a1Audit.metadata?.scope === 'business' && !!a1Audit.metadata?.policyId, 'each automatic queuing is audited once, in Acme, by no person, with from/to and the policy', JSON.stringify(a1Audit?.metadata));
  check((await prisma.activityLog.count({ where: { action: 'CLIENT_UPDATE_AUTO_QUEUED', customerId: B.id } })) === 2, "Birch's two are audited in Birch");

  // ── The heartbeat ──────────────────────────────────────────────────────────
  section('The heartbeat: inside the window, outside it, and during a session');
  r = await heartbeat('a1');
  check(r.data?.updateRustdesk?.targetVersion === TARGET, 'inside the window: a1 is handed the update', msg(r));
  r = await req('PUT', '/client-updates/policy', { s: ownerAUp, body: policy(A.id, closedWindow()) });
  check(r.status === 200 && r.data?.clearedQueued === 0, 'window moved to later; still on, so nothing queued is withdrawn', msg(r));
  r = await heartbeat('a1');
  check(r.status === 200 && !r.data?.updateRustdesk, 'outside the window: the same queued update is withheld', msg(r));
  check((await node('a1')).updateHoldReason === 'outside_window', 'and the reason is recorded: outside_window');
  r = await req('GET', `/client-updates/computers?businessId=${A.id}`, { s: S.ownerA });
  { const c = r.data?.computers?.find((x) => x.id === eps.a1.id); check(c?.state === 'queued_auto_waiting' && c.queued?.source === 'policy' && c.queued.hold?.reason === 'outside_window' && /^Auto/.test(c.text), 'the page says: auto, waiting for the window', JSON.stringify(c)); }
  r = await req('PUT', '/client-updates/policy', { s: ownerAUp, body: policy(A.id, openWindow()) });
  r = await heartbeat('a2', { rustdeskSessions: 1 });
  check(r.status === 200 && !r.data?.updateRustdesk && (await node('a2')).updateHoldReason === 'session_open', 'window open, but the endpoint reports a session: withheld (session_open)', msg(r));
  r = await heartbeat('a2', { rustdeskSessions: 0 });
  check(r.data?.updateRustdesk?.targetVersion === TARGET && (await node('a2')).updateHoldReason === null, 'session over: handed out, and the hold reason clears', msg(r));
  r = await req('PUT', '/client-updates/policy', { s: ownerAUp, body: policy(A.id, openWindow(), { skipActiveSession: false }) });
  r = await heartbeat('a2', { rustdeskSessions: 1 });
  check(r.data?.updateRustdesk?.targetVersion === TARGET, 'with "skip open sessions" turned off, a session no longer holds it', msg(r));

  section('Skip when someone is logged on (optional)');
  r = await req('PUT', '/client-updates/policy', { s: ownerAUp, body: policy(A.id, openWindow(), { skipLoggedOnUser: true }) });
  r = await heartbeat('a4', { loggedOnUser: 'ACME\\pat' });
  check(!r.data?.updateRustdesk && (await node('a4')).updateHoldReason === 'user_logged_on', 'a reported user holds it', msg(r));
  r = await heartbeat('a4', { loggedOnUser: undefined });
  check(!r.data?.updateRustdesk && (await node('a4')).updateHoldReason === 'user_unknown', 'an agent that does not report a user holds it too (unknown is not nobody)', msg(r));
  r = await heartbeat('a4', { loggedOnUser: '' });
  check(r.data?.updateRustdesk?.targetVersion === TARGET, "the agent's \"nobody\" ('') lets it go", msg(r));

  // ── Manual still goes at once ──────────────────────────────────────────────
  section('A request made by hand still goes immediately, and says who made it');
  r = await req('PUT', '/client-updates/policy', { s: ownerAUp, body: policy(A.id, closedWindow()) });
  r = await req('POST', '/admin/update/rustdesk', { s: S.admin, body: { endpointIds: [eps.a3.id] } });
  check(r.status === 200 && r.data?.requested === 1, 'the admin clicks Update on a3', msg(r));
  r = await heartbeat('a3');
  check(r.data?.updateRustdesk?.targetVersion === TARGET, 'outside the window, a MANUAL request is handed out on the next heartbeat', msg(r));
  r = await req('GET', `/client-updates/computers?businessId=${A.id}`, { s: S.ownerA });
  { const c = r.data?.computers?.find((x) => x.id === eps.a3.id); check(c?.state === 'queued_manual' && c.queued?.source === 'manual' && c.queued.by?.id === admin.id && c.text.includes('AU admin'), 'the page says: queued by AU admin', JSON.stringify(c)); }
  r = await req('GET', '/admin/update/rustdesk', { s: S.admin });
  { const by = (k) => r.data?.endpoints?.find((e) => e.endpointId === eps[k].id);
    check(by('a3')?.updateSource === 'manual' && by('a3')?.updateRequestedBy?.id === admin.id && by('a1')?.updateSource === 'policy' && by('a1')?.updateRequestedBy === null, 'the Updates page tells manual (with who) from policy', JSON.stringify([by('a3'), by('a1')].map((x) => x && { s: x.updateSource, by: x.updateRequestedBy }))); }
  r = await req('POST', '/admin/update/rustdesk', { s: S.admin, body: { endpointIds: [eps.a1.id] } });
  r = await heartbeat('a1');
  check(r.data?.updateRustdesk?.targetVersion === TARGET && (await node('a1')).updateRequestSource === 'MANUAL', 'clicking Update on a waiting automatic request makes it manual: it goes now', msg(r));
  r = await heartbeat('a3', { rustdeskVersion: TARGET });
  { const n = await node('a3'); check(!n.updateRequestedAt && !n.updateRequestSource && !n.updateRequestedById, 'a3 reports 1.4.5: the request clears, source and requester with it', JSON.stringify(n)); }
  r = await req('PUT', '/client-updates/policy', { s: ownerAUp, body: policy(A.id, openWindow()) });

  // ── Off, and site overrides ────────────────────────────────────────────────
  section('Turning it off withdraws what it queued; manual requests stay');
  // a2 and a4 for certain; aSession too if a sweep ran while "skip open
  // sessions" was off, which is correct behaviour — so count, do not assume.
  const waiting = (await queuedIn(A)).filter((n) => n.updateRequestSource === 'POLICY').map((n) => n.endpointId);
  check(waiting.includes(eps.a2.id) && waiting.includes(eps.a4.id) && !waiting.includes(eps.a1.id), 'before: a2 and a4 are POLICY requests, a1 is manual', JSON.stringify(waiting));
  r = await req('PUT', '/client-updates/policy', { s: S.ownerA, body: { ...policy(A.id, openWindow()), enabled: false } });
  check(r.status === 200 && r.data?.clearedQueued === waiting.length, `off, without fresh authentication; the ${waiting.length} POLICY requests still waiting are withdrawn`, msg(r));
  const left = await queuedIn(A);
  check(left.length === 1 && left[0].endpointId === eps.a1.id && left[0].updateRequestSource === 'MANUAL', 'only the manual request (a1) is left', JSON.stringify(left.map((n) => [n.endpoint.name, n.updateRequestSource])));
  await sweeps(2);
  check((await queuedIn(A)).length === 1, 'and the sweep queues nothing more while it is off');

  section('Site overrides: one replaces the business policy; removing it needs fresh authentication');
  r = await req('PUT', '/client-updates/policy', { s: ownerAUp, body: { ...policy(A.id, openWindow()), siteId: depot.id } });
  check(r.status === 200, 'Depot override on, window open, while the business policy is off', msg(r));
  await prisma.rustdeskNode.update({ where: { endpointId: eps.a3.id }, data: { version: OLD } });
  const a3q = await until(async () => { const n = await node('a3'); return n.updateRequestSource === 'POLICY' ? n : null; });
  check(!!a3q, 'a3 (Depot) is queued by its site policy');
  await sweeps(1);
  check(!(await queuedIn(A)).some((n) => n.updateRequestSource === 'POLICY' && n.endpointId !== eps.a3.id), 'nothing outside Depot is queued by it');
  r = await req('DELETE', `/client-updates/policy/sites/${depot.id}?businessId=${A.id}`, { s: S.ownerA });
  check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED', 'removing an override needs fresh authentication', msg(r));
  r = await req('DELETE', `/client-updates/policy/sites/${depot.id}?businessId=${A.id}`, { s: ownerBUp });
  check(r.status === 403, "Birch's owner cannot remove Acme's override", msg(r));
  r = await req('DELETE', `/client-updates/policy/sites/${depot.id}?businessId=${A.id}`, { s: ownerAUp });
  check(r.status === 200 && r.data?.clearedQueued === 1, 'removed: Depot falls back to the business policy (off), so its POLICY request is withdrawn', msg(r));

  // ── Audit ──────────────────────────────────────────────────────────────────
  section('Policy changes are audited');
  const changes = await prisma.activityLog.findMany({ where: { action: 'CLIENT_UPDATE_POLICY_CHANGED', customerId: A.id }, orderBy: { createdAt: 'asc' } });
  const firstOn = changes.find((c) => c.actorId === ownerA.id && c.metadata?.after?.enabled === true && c.metadata?.before?.enabled === false);
  check(!!firstOn && firstOn.metadata.scope === 'business' && firstOn.metadata.window?.includes('(UTC)'), 'turning it on is recorded with before, after and the window, by the owner', JSON.stringify(firstOn?.metadata));
  check(changes.some((c) => c.actorId === techWhole.id && c.metadata?.viaTechnicianAssignment === true && c.metadata?.siteId === depot.id), "the technician's change is recorded as made through an assignment");
  check(changes.some((c) => c.metadata?.removedOverride === true && c.metadata?.clearedQueued === 1), 'removing the override is recorded, with what it withdrew');
  check(changes.some((c) => c.metadata?.after?.enabled === false && c.metadata?.before?.enabled === true && c.metadata?.clearedQueued >= 2), 'turning it off is recorded, with what it withdrew');
  check(!(await prisma.activityLog.count({ where: { action: 'CLIENT_UPDATE_POLICY_CHANGED', customerId: A.id, actorId: { in: [userA.id, techNamed.id, techView.id, ownerB.id] } } })), 'refused attempts changed nothing and recorded no change');
  check((await prisma.activityLog.count({ where: { action: 'CLIENT_UPDATE_POLICY_CHANGED', customerId: B.id, actorId: ownerB.id } })) === 1, "Birch's change is in Birch's log");
}

async function cleanup() {
  await stopApi();
  try {
    if (originalPin !== undefined) await prisma.platformSettings.update({ where: { id: 'singleton' }, data: { rustdeskPinnedVersion: originalPin } }).catch(() => {});
    const ids = created.businesses;
    await prisma.technicianAssignment.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.clientUpdatePolicy.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.containmentPause.deleteMany({ where: { customerId: { in: ids } } });
    const eps = await prisma.endpoint.findMany({ where: { customerId: { in: ids } }, select: { id: true } });
    const epIds = eps.map((e) => e.id);
    await prisma.supportSession.deleteMany({ where: { endpointId: { in: epIds } } });
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
