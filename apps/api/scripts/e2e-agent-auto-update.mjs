#!/usr/bin/env node
/**
 * End-to-end proof of automatic agent self-update (0.36), through the real
 * heartbeat route (/enrollment/heartbeat), the Agent card, the device list
 * and the settings routes:
 *
 *   - an outdated standard agent (0.30.1, 0.18.25) is handed reinstallAgent
 *     with this server's version; a 0.13–0.14 agent (no version, a device
 *     secret) is handed updateRustdesk instead; an up-to-date one, a Linux
 *     agent and a computer without a device secret are handed nothing;
 *   - one attempt hands the flag out for 20 minutes and is ONE history row,
 *     system-initiated (no requester) and never an audit entry; then
 *     verifying, then the back-off (2 h, 8 h), then failing after the cap,
 *     shown on the card with its attempts and never dispatched again; a new
 *     version resets it, and Update agent resets it;
 *   - reaching the version closes the attempt as `updated`;
 *   - the global pace (attempts started per hour) holds a computer back,
 *     and lets it go when raised;
 *   - a business that opts out (policy agentMode OFF) is never asked; a site
 *     inheriting it is not either, and one that opts back in is; a WINDOW
 *     policy hands it out only inside its window;
 *   - an "updates" containment pause, a staged rollout owning the computer,
 *     an open session, a queued RustDesk update and the platform switch all
 *     hold it, and the card says which;
 *   - policy and settings changes need fresh authentication (except opting
 *     out) and are audited; Platform Admin only for the settings;
 *   - the device list's agent=outdated filter, and business A/B isolation:
 *     B's owner sees none of A's computers, cards or history, B's computers
 *     follow B's policy and not A's opt-out, and neither owner can change the
 *     other's policy;
 *   - AGENT_AUTO_UPDATE=off on a second API hands nothing out.
 *
 *   cd apps/api && npx nest build
 *   DATABASE_URL=postgresql://…/<name containing scratch or test> node scripts/e2e-agent-auto-update.mjs
 *
 * Self-starting: its APIs run from dist/ on AUTOUPDATE_API_PORT (3641) and the
 * port after it. INTEGRATION, not Windows: heartbeats are posted the way
 * heartbeat.ps1 posts them. Nothing here ran on Windows.
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
const BASE_PORT = Number(process.env.AUTOUPDATE_API_PORT ?? 3641);
for (const p of [BASE_PORT, BASE_PORT + 1]) if ([3000, 3001, 4000, 4001, 443].includes(p)) { console.error(`Refusing port ${p}`); process.exit(2); }
let API = `http://127.0.0.1:${BASE_PORT}/api/v1`;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'agentauto-e2e-password-123';
const MIN = 60_000, H = 60 * MIN;
const VERSION_FILE = path.resolve(here, '..', '..', '..', 'version.json');
const SERVED = JSON.parse(readFileSync(VERSION_FILE, 'utf8')).version;

let pass = 0, fail = 0;
const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;
const sha = (b) => createHash('sha256').update(b).digest('hex');

const baseEnv = {
  ...process.env, NODE_ENV: 'test', DATABASE_URL: DB,
  JWT_SECRET: randomBytes(32).toString('hex'), LAUNCHER_TOKEN_SECRET: randomBytes(32).toString('hex'),
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? randomBytes(32).toString('hex'), TRUSTED_PROXIES: 'loopback', HBBS_PRESENCE_HOST: '127.0.0.2',
  VERSION_FILE, MONITOR_SWEEP: 'off', AUDIT_SEALER: 'off', CLIENT_UPDATE_SWEEP: 'off', SNAPSHOT_SWEEP: 'off',
  // run-e2e.sh exports AGENT_AUTO_UPDATE=off for every other suite; this one turns it on for its own API.
  AGENT_AUTO_UPDATE: 'on',
};
let api;
async function startApi(port, extra = {}) {
  API = `http://127.0.0.1:${port}/api/v1`;
  api = spawn(process.execPath, [path.join(dist, 'main.js')], { env: { ...baseEnv, PORT: String(port), ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  api.log = ''; api.stdout.on('data', (d) => { api.log += d; }); api.stderr.on('data', (d) => { api.log += d; });
  for (let i = 0; i < 120; i++) { try { const r = await fetch(`${API}/health`); if (r.status < 500) return; } catch { /* not yet */ } await sleep(300); }
  throw new Error(`api did not come up:\n${api.log.slice(-3000)}`);
}
async function stopApi() { if (!api || api.exitCode !== null || api.signalCode !== null) return; await new Promise((r) => { api.once('exit', r); api.kill('SIGTERM'); }); }

// Paced under the 20 req/s burst throttler.
const pace = () => new Promise((res) => setTimeout(res, 60));
async function req(method, p, { s, body } = {}) {
  await pace();
  const h = { 'content-type': 'application/json', 'x-forwarded-for': s?.ip ?? ip() };
  if (s) h.cookie = s.cookie + (s.stepUp ? `; step_up=${s.stepUp}` : '');
  const r = await fetch(`${API}${p}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = text; }
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
async function stepUp(s) {
  await pace();
  const r = await fetch(`${API}/auth/step-up`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': s.ip, cookie: s.cookie }, body: JSON.stringify({ password: PW }) });
  const mm = (r.headers.get('set-cookie') ?? '').match(/step_up=([^;]+)/);
  if (r.status !== 200 || !mm) throw new Error(`step-up: ${r.status} ${await r.text()}`);
  return { ...s, stepUp: mm[1] };
}
const code = (r) => r.body?.code ?? r.body?.message?.code ?? r.body?.error?.code;
const msg = (r) => `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 400)}`;

// The agent, as heartbeat.ps1 speaks.
const heartbeat = (ep, extra = {}) => req('POST', '/enrollment/heartbeat', {
  body: {
    rustdeskId: ep.rid, ...(ep.secret ? { agentSecret: ep.secret } : {}), hostname: ep.hostname, platform: ep.platform,
    ...(ep.agentVersion ? { agentVersion: ep.agentVersion } : {}), rustdeskVersion: '1.4.6', loggedOnUser: '', ...extra,
  },
});
const flags = (r) => ({ reinstall: r.data?.reinstallAgent ?? null, rustdesk: r.data?.updateRustdesk ?? null });
const attempts = (ep) => prisma.agentAutoUpdateAttempt.findMany({ where: { endpointId: ep.id }, orderBy: { dispatchedAt: 'asc' } });
const node = (ep) => prisma.rustdeskNode.findUnique({ where: { endpointId: ep.id } });
/** Move this computer's last attempt `ms` into the past (as if it were dispatched then). */
async function ageAttempt(ep, ms, attemptsMade) {
  const at = new Date(Date.now() - ms);
  await prisma.rustdeskNode.update({ where: { endpointId: ep.id }, data: { agentAutoLastAt: at, ...(attemptsMade !== undefined ? { agentAutoAttempts: attemptsMade } : {}) } });
  await prisma.agentAutoUpdateAttempt.updateMany({ where: { endpointId: ep.id }, data: { dispatchedAt: at } });
}
const hhmm = (d) => `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const openWindow = () => [{ days: ALL_DAYS, start: hhmm(new Date(Date.now() - H)), end: hhmm(new Date(Date.now() + 2 * H)) }];
const closedWindow = () => [{ days: ALL_DAYS, start: hhmm(new Date(Date.now() + 6 * H)), end: hhmm(new Date(Date.now() + 7 * H)) }];

const created = { businesses: [], users: [], rollouts: [] };
let settingsBefore = null;

async function all() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });
  settingsBefore = await prisma.platformSettings.findUnique({ where: { id: 'singleton' } });
  // Start from the defaults whatever an earlier run left.
  await prisma.platformSettings.upsert({ where: { id: 'singleton' }, update: { agentAutoUpdateEnabled: true, agentAutoUpdatePerHour: 120, agentAutoUpdateMaxAttempts: 3 }, create: { id: 'singleton' } });

  section(`Fixtures (synthetic): this server serves ${SERVED}. Acme — outdated, current, pre-0.15, Linux, no-secret and spare computers in two sites; Birch — outdated computers; a Platform Admin and two owners`);
  const acme = await prisma.customer.create({ data: { tenantId: tenant.id, name: `AAU Acme ${sfx}` } });
  const birch = await prisma.customer.create({ data: { tenantId: tenant.id, name: `AAU Birch ${sfx}` } });
  created.businesses.push(acme.id, birch.id);
  const north = await prisma.site.create({ data: { tenantId: tenant.id, customerId: acme.id, name: `North ${sfx}` } });
  const south = await prisma.site.create({ data: { tenantId: tenant.id, customerId: acme.id, name: `South ${sfx}` } });
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag, extra = {}) => { const u = await prisma.user.create({ data: { email: `aau-${tag}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'AAU', lastName: tag, status: 'ACTIVE', ...extra } }); created.users.push(u.id); return u; };
  const admin = await mkUser('admin', { isPlatformAdmin: true }), owen = await mkUser('owen-owner-acme'), bea = await mkUser('bea-owner-birch');
  await prisma.membership.create({ data: { userId: owen.id, tenantId: tenant.id, customerId: acme.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: bea.id, tenantId: tenant.id, customerId: birch.id, roleId: roleOwner.id } });
  const mkEp = async (biz, hostname, { platform = 'Windows', agentVersion = '0.30.1', secret = true, siteId = null } = {}) => {
    const e = await prisma.endpoint.create({ data: { tenantId: tenant.id, customerId: biz.id, siteId, name: hostname, hostname, platform, status: 'ACTIVE', isOnline: true, isManaged: true, accessMode: 'COMPANY_WIDE', lastSeenAt: new Date(), agentVersion, deviceClass: 'WORKSTATION' } });
    const rid = String(100000000 + ((Math.random() * 899999999) | 0));
    const s = secret ? randomBytes(24).toString('hex') : null;
    await prisma.rustdeskNode.create({ data: { tenantId: tenant.id, endpointId: e.id, rustdeskId: rid, version: '1.4.6', agentSecretHash: s ? sha(s) : null } });
    return { id: e.id, rid, secret: s, hostname, platform, agentVersion };
  };
  const a030 = await mkEp(acme, 'A-030', { siteId: north.id });
  const a018 = await mkEp(acme, 'A-018', { agentVersion: '0.18.25', siteId: north.id });
  const aCur = await mkEp(acme, 'A-CURRENT', { agentVersion: SERVED });
  const aPre = await mkEp(acme, 'A-PRE015', { agentVersion: null });
  const aLin = await mkEp(acme, 'a-linux', { platform: 'Linux', agentVersion: '0.32.0' });
  const aNoSecret = await mkEp(acme, 'A-NOSECRET', { secret: false, agentVersion: '0.12.0' });
  const aSouth = await mkEp(acme, 'A-SOUTH', { siteId: south.id });
  const aSpare = [];
  for (let i = 0; i < 4; i++) aSpare.push(await mkEp(acme, `A-SPARE-${i}`));
  const b1 = await mkEp(birch, 'B-030');
  const b2 = await mkEp(birch, 'B-WIN');
  const acmeIds = [a030, a018, aCur, aPre, aLin, aNoSecret, aSouth, ...aSpare].map((e) => e.id);

  await startApi(BASE_PORT);
  let S = { admin: await login(admin.email), owen: await login(owen.email), bea: await login(bea.email) };
  const card = async (s, ep) => req('GET', `/endpoints/${ep.id}/agent`, { s });
  const auto = async (ep, s = S.owen) => (await card(s, ep)).data?.autoUpdate;
  const auditsFor = (ids) => prisma.activityLog.count({ where: { resourceId: { in: ids }, action: { notIn: ['ENDPOINT_HEARTBEAT_REJECTED'] } } });

  section('Settings: Platform Admin only, fresh authentication to change, validated, audited');
  let r = await req('GET', '/admin/agent-auto-update', { s: S.admin });
  check(r.status === 200 && r.data.enabled === true && r.data.perHour === 120 && r.data.maxAttempts === 3 && r.data.processOn === true && r.data.served.version === SERVED,
    `defaults: on, 120 an hour, 3 attempts, this process on, serving ${SERVED}`, msg(r));
  r = await req('GET', '/admin/agent-auto-update', { s: S.owen });
  check(r.status === 403, 'a Business Owner cannot read it (403)', msg(r));
  r = await req('PUT', '/admin/agent-auto-update', { s: S.owen, body: { enabled: false } });
  check(r.status === 403, 'or change it (403)', msg(r));
  const settingsAudits0 = await prisma.activityLog.count({ where: { action: 'AGENT_AUTO_UPDATE_SETTINGS_CHANGED' } });
  r = await req('PUT', '/admin/agent-auto-update', { s: S.admin, body: { perHour: 60 } });
  check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED', 'a change without fresh authentication: STEP_UP_REQUIRED', msg(r));
  S.adminUp = await stepUp(S.admin);
  r = await req('PUT', '/admin/agent-auto-update', { s: S.adminUp, body: { perHour: 0 } });
  check(r.status === 400 && code(r) === 'INVALID_AGENT_AUTO_UPDATE', 'perHour 0 is refused (400)', msg(r));
  r = await req('PUT', '/admin/agent-auto-update', { s: S.adminUp, body: { perHour: 120, everySeconds: 1 } });
  check(r.status === 400, 'an unknown field is refused', msg(r));
  check((await prisma.activityLog.count({ where: { action: 'AGENT_AUTO_UPDATE_SETTINGS_CHANGED' } })) === settingsAudits0, 'no refusal was audited as a change');

  section('An outdated standard agent is asked to update: one attempt, one history row, no audit entry');
  const auditsBefore = await auditsFor(acmeIds);
  r = await heartbeat(a030);
  check((r.status === 200 || r.status === 201) && r.data.authenticated === true, 'A-030 (0.30.1) heartbeats', msg(r));
  check(flags(r).reinstall?.targetVersion === SERVED && flags(r).rustdesk === null, `it is handed reinstallAgent { targetVersion: ${SERVED} } and no RustDesk flag`, JSON.stringify(flags(r)));
  let rows = await attempts(a030);
  check(rows.length === 1 && rows[0].attempt === 1 && rows[0].channel === 'standard' && rows[0].fromVersion === '0.30.1' && rows[0].targetVersion === SERVED && rows[0].outcome === null && rows[0].customerId === acme.id,
    'one history row: attempt 1, standard, 0.30.1 → served, open, in Acme', JSON.stringify(rows));
  let n = await node(a030);
  check(n.agentAutoTarget === SERVED && n.agentAutoAttempts === 1 && !!n.agentAutoLastAt, 'the node records the target and attempt 1');
  check(n.reinstallRequestedAt === null && n.reinstallRequestedBy === null, 'it is not an operator Reinstall request (nothing on the reinstall columns)');
  r = await heartbeat(a030);
  check(flags(r).reinstall?.targetVersion === SERVED, 'the next heartbeat inside the 20-minute attempt hands it out again (the agent\'s own 30-minute floor makes that one run)', JSON.stringify(flags(r)));
  check((await attempts(a030)).length === 1 && (await node(a030)).agentAutoAttempts === 1, 'still one attempt and one row');
  r = await heartbeat(a018);
  check(flags(r).reinstall?.targetVersion === SERVED, 'A-018 (0.18.25, production\'s oldest) is handed reinstallAgent too', JSON.stringify(flags(r)));
  r = await heartbeat(aPre);
  check(flags(r).rustdesk?.targetVersion === SERVED && flags(r).reinstall === null, 'A-PRE015 (no version, a device secret: 0.13–0.14) is handed updateRustdesk, the flag its heartbeat acts on', JSON.stringify(flags(r)));
  check((await attempts(aPre))[0]?.channel === 'standard_pre015', 'its history row says standard_pre015');
  check((await prisma.rustdeskNode.findUnique({ where: { endpointId: aPre.id } })).updateRequestedAt === null, 'and it stages no RustDesk update (updateRequestedAt untouched)');
  check((await auditsFor(acmeIds)) === auditsBefore, 'none of these heartbeats wrote an audit entry');

  section('Nothing for an up-to-date agent, a Linux agent, or a computer without a device secret');
  r = await heartbeat(aCur);
  check(flags(r).reinstall === null && flags(r).rustdesk === null && (await attempts(aCur)).length === 0, `A-CURRENT (${SERVED}): nothing handed out, no row`, JSON.stringify(flags(r)));
  r = await heartbeat(aLin);
  check(flags(r).reinstall === null && (await attempts(aLin)).length === 0, 'a-linux: nothing (the Linux agent is read-only)', JSON.stringify(flags(r)));
  r = await heartbeat(aNoSecret);
  check(r.data?.authenticated === false && flags(r).reinstall === null && (await attempts(aNoSecret)).length === 0, 'A-NOSECRET: unauthenticated, nothing', msg(r));

  section('The Agent card says what will happen, and gives the manual command where it must');
  let c = await auto(a030);
  check(c?.state === 'updating' && c.reason === 'attempt_open' && c.attempts.made === 1 && c.attempts.max === 3 && c.channel === 'standard' && c.target === SERVED, 'A-030: updating, attempt 1 of 3', JSON.stringify(c));
  check(c.history.length === 1 && c.history[0].automatic === true && c.history[0].attempt === 1, 'with its history row, marked automatic');
  c = await auto(aCur);
  check(c?.state === 'up_to_date', 'A-CURRENT: up to date', JSON.stringify(c));
  c = await auto(aLin);
  check(c?.state === 'manual' && c.reason === 'read_only_agent' && /curl -fsSL .*\/api\/v1\/public\/install\/linux\.sh \| sudo bash/.test(c.manual?.command ?? ''), 'a-linux: manual update required, with the curl | sudo bash command', JSON.stringify(c));
  c = await auto(aNoSecret);
  check(c?.state === 'manual' && c.reason === 'no_device_secret' && /windows\.ps1\?token=<token from Add device>' \| iex/.test(c.manual?.command ?? ''), 'A-NOSECRET: manual, with the installer command that needs an enrolment token', JSON.stringify(c));
  c = await auto(aSpare[0]);
  check(c?.state === 'queued' && c.reason === 'next_heartbeat', 'A-SPARE-0 (not yet checked in since): queued for its next check-in', JSON.stringify(c));

  section('Reaching the version closes the attempt');
  r = await heartbeat({ ...a030, agentVersion: SERVED });
  check(flags(r).reinstall === null, `A-030 reports ${SERVED}: nothing handed out`, JSON.stringify(flags(r)));
  rows = await attempts(a030); n = await node(a030);
  check(rows.length === 1 && rows[0].outcome === 'updated' && !!rows[0].resolvedAt, 'its attempt is closed as updated', JSON.stringify(rows));
  check(n.agentAutoTarget === null && n.agentAutoAttempts === 0 && n.agentAutoLastAt === null, 'and the node\'s state is cleared');
  check((await auto({ ...a030 }))?.state === 'up_to_date', 'the card says up to date');

  section('The attempt window, verification, back-off, the cap and failing');
  // A-018 had attempt 1 a moment ago.
  await ageAttempt(a018, 25 * MIN);
  r = await heartbeat(a018);
  check(flags(r).reinstall === null, 'at 25 min (past the 20-minute attempt): the flag stops', JSON.stringify(flags(r)));
  check((await auto(a018))?.reason === 'verifying', 'the card: verifying (waiting for it to report the new version)');
  await ageAttempt(a018, 90 * MIN);
  r = await heartbeat(a018);
  check(flags(r).reinstall === null && (await attempts(a018)).length === 1, 'at 90 min: still nothing — attempt 2 waits for the 2-hour back-off', JSON.stringify(flags(r)));
  c = await auto(a018);
  check(c?.state === 'queued' && c.reason === 'backoff' && !!c.nextAt, 'the card: queued, backing off, with when', JSON.stringify(c));
  await ageAttempt(a018, 2 * H + MIN);
  r = await heartbeat(a018);
  rows = await attempts(a018);
  check(flags(r).reinstall?.targetVersion === SERVED && rows.length === 2 && rows[1].attempt === 2 && rows[0].outcome === 'superseded', 'after 2 h: attempt 2 goes out, attempt 1 is superseded', JSON.stringify(rows.map((x) => [x.attempt, x.outcome])));
  await ageAttempt(a018, 9 * H, 2);
  r = await heartbeat(a018);
  check(flags(r).reinstall?.targetVersion === SERVED && (await node(a018)).agentAutoAttempts === 3, 'after 8 h more: attempt 3 (the last)', JSON.stringify(flags(r)));
  await ageAttempt(a018, 3 * H, 3);
  r = await heartbeat(a018);
  check(flags(r).reinstall === null && (await attempts(a018)).length === 3, 'after the third: nothing handed out, no fourth row', JSON.stringify(flags(r)));
  await ageAttempt(a018, 400 * H, 3);
  r = await heartbeat(a018);
  check(flags(r).reinstall === null && (await attempts(a018)).length === 3, 'not after 400 hours either: no download loop', JSON.stringify(flags(r)));
  c = await auto(a018);
  check(c?.state === 'failing' && c.reason === 'attempts_exhausted' && c.attempts.made === 3, 'the card: failing, 3 attempts', JSON.stringify(c));
  r = await req('GET', '/admin/agent-auto-update', { s: S.admin });
  check(r.data?.failing?.count >= 1 && r.data.failing.computers.some((x) => x.id === a018.id && x.attempts === 3 && x.business.id === acme.id), 'the settings page lists it as failing (state exposed for a monitor)', msg(r));
  // A new release (a different target) resets the attempts.
  await prisma.rustdeskNode.update({ where: { endpointId: a018.id }, data: { agentAutoTarget: '0.0.1' } });
  c = await auto(a018);
  check(c?.state === 'queued' && c.attempts.made === 0, 'a different target on record (an earlier release) counts as zero attempts at this one', JSON.stringify(c));
  await prisma.rustdeskNode.update({ where: { endpointId: a018.id }, data: { agentAutoTarget: SERVED } });
  // Update agent is the retry: automatic attempts start again afterwards.
  r = await req('POST', `/endpoints/${a018.id}/agent/update`, { s: S.owen });
  check(r.status === 200 && (await node(a018)).agentAutoAttempts === 0, 'Update agent (the owner, by hand) resets the attempts to zero', msg(r));
  c = await auto(a018);
  check(c?.state === 'queued' && c.reason === 'pending_request', 'while that request is queued the automatic path waits for it', JSON.stringify(c));
  r = await heartbeat(a018);
  check(flags(r).reinstall?.targetVersion === SERVED && (await attempts(a018)).length === 3, 'the heartbeat hands out the person\'s request, not a new automatic attempt', JSON.stringify(flags(r)));
  await prisma.rustdeskNode.update({ where: { endpointId: a018.id }, data: { reinstallRequestedAt: null, reinstallRequestedBy: null, reinstallDispatchedAt: null } });

  section('The global pace');
  const used = await prisma.agentAutoUpdateAttempt.count({ where: { dispatchedAt: { gt: new Date(Date.now() - H) } } });
  r = await req('PUT', '/admin/agent-auto-update', { s: S.adminUp, body: { perHour: Math.max(1, used) } });
  check(r.status === 200 && r.data.perHour === Math.max(1, used), `perHour set to the ${used} attempts already started this hour`, msg(r));
  check((await prisma.activityLog.findFirst({ where: { action: 'AGENT_AUTO_UPDATE_SETTINGS_CHANGED' }, orderBy: { createdAt: "desc" } }))?.metadata?.after?.perHour === Math.max(1, used), 'the change is audited with before and after');
  r = await heartbeat(aSpare[0]);
  check(flags(r).reinstall === null && (await attempts(aSpare[0])).length === 0, 'A-SPARE-0 is held back: the pace is used up', JSON.stringify(flags(r)));
  check((await auto(aSpare[0]))?.reason === 'pacing', 'the card: waiting its turn (pacing)');
  r = await req('PUT', '/admin/agent-auto-update', { s: S.adminUp, body: { perHour: used + 1 } });
  check(r.status === 200, 'perHour raised by one', msg(r));
  r = await heartbeat(aSpare[0]);
  check(flags(r).reinstall?.targetVersion === SERVED && (await attempts(aSpare[0])).length === 1, 'one more slot: A-SPARE-0 goes', JSON.stringify(flags(r)));
  r = await heartbeat(aSpare[1]);
  check(flags(r).reinstall === null && (await attempts(aSpare[1])).length === 0, 'and A-SPARE-1, after it, does not', JSON.stringify(flags(r)));
  r = await req('PUT', '/admin/agent-auto-update', { s: S.adminUp, body: { perHour: 120 } });
  check(r.status === 200, 'pace back to 120');

  section('Holds: containment, a rollout, a session, a queued RustDesk update, the platform switch');
  const pause = await prisma.containmentPause.create({ data: { scope: 'BUSINESS', customerId: acme.id, kinds: ['updates'], reason: `AAU ${sfx}: suspected compromise`, setById: admin.id, setBy: 'msp' } });
  r = await heartbeat(aSpare[1]);
  check(flags(r).reinstall === null && (await attempts(aSpare[1])).length === 0, 'an "updates" pause on Acme: nothing handed out, nothing recorded', JSON.stringify(flags(r)));
  check((await auto(aSpare[1]))?.reason === 'paused', 'the card: paused');
  r = await heartbeat(aSpare[0]);
  check(flags(r).reinstall === null, 'and A-SPARE-0, mid-attempt, is not handed the flag again under the pause', JSON.stringify(flags(r)));
  await prisma.containmentPause.update({ where: { id: pause.id }, data: { clearedAt: new Date(), clearedById: admin.id, clearReason: 'test' } });

  const rollout = await prisma.updateRollout.create({ data: { name: `AAU ${sfx}`, component: 'AGENT', targetVersion: SERVED, status: 'PAUSED', createdById: admin.id } });
  created.rollouts.push(rollout.id);
  await prisma.updateJob.create({ data: { rolloutId: rollout.id, endpointId: aSpare[1].id, customerId: acme.id, status: 'REQUESTED' } });
  r = await heartbeat(aSpare[1]);
  check((await attempts(aSpare[1])).length === 0, 'a staged rollout owns A-SPARE-1: no automatic attempt', JSON.stringify(flags(r)));
  check((await auto(aSpare[1]))?.reason === 'rollout', 'the card: a staged rollout owns it');
  await prisma.updateJob.deleteMany({ where: { rolloutId: rollout.id } });

  r = await heartbeat(aSpare[1], { rustdeskSessions: 1 });
  check(flags(r).reinstall === null && (await attempts(aSpare[1])).length === 0, 'a remote session open (reported by the agent): held — the install restarts RustDesk', JSON.stringify(flags(r)));

  await prisma.rustdeskNode.update({ where: { endpointId: aSpare[1].id }, data: { updateRequestedAt: new Date(), updateTargetVersion: '9.9.9', updateRequestSource: 'POLICY' } });
  r = await heartbeat(aSpare[1], { rustdeskSessions: 0 });
  check((await attempts(aSpare[1])).length === 0, 'a RustDesk client update queued for it: no automatic agent attempt (that install updates the agent too)', JSON.stringify(flags(r)));
  check((await auto(aSpare[1]))?.reason === 'pending_request', 'the card says so');
  await prisma.rustdeskNode.update({ where: { endpointId: aSpare[1].id }, data: { updateRequestedAt: null, updateTargetVersion: null, updateRequestSource: null, updateHoldReason: null, updateHoldAt: null } });

  r = await req('PUT', '/admin/agent-auto-update', { s: S.adminUp, body: { enabled: false } });
  check(r.status === 200 && r.data.enabled === false, 'the platform switch off (fresh authentication, audited)', msg(r));
  r = await heartbeat(aSpare[1]);
  check(flags(r).reinstall === null && (await attempts(aSpare[1])).length === 0, 'switched off: nothing', JSON.stringify(flags(r)));
  check((await auto(aSpare[1]))?.state === 'opted_out' && (await auto(aSpare[1])).reason === 'platform_off', 'the card: opted out (platform)');
  r = await req('PUT', '/admin/agent-auto-update', { s: S.adminUp, body: { enabled: true } });
  check(r.status === 200 && r.data.enabled === true, 'the platform switch back on', msg(r));
  r = await heartbeat(aSpare[1]);
  check(flags(r).reinstall?.targetVersion === SERVED, 'back on: A-SPARE-1 goes', JSON.stringify(flags(r)));

  section('Policy: opting a business out, a site back in, a maintenance window');
  const pol = (s, body) => req('PUT', '/client-updates/policy', { s, body: { businessId: acme.id, enabled: false, timeZone: 'UTC', windows: openWindow(), skipActiveSession: true, skipLoggedOnUser: false, ...body } });
  const polAudits0 = await prisma.activityLog.count({ where: { action: 'CLIENT_UPDATE_POLICY_CHANGED', customerId: acme.id } });
  r = await pol(S.owen, { agentMode: 'OFF' });
  check(r.status === 200 && r.data.policy.agentMode === 'OFF', 'Acme\'s owner opts the business out (OFF) — no fresh authentication needed to stop', msg(r));
  const pa = await prisma.activityLog.findFirst({ where: { action: 'CLIENT_UPDATE_POLICY_CHANGED', customerId: acme.id }, orderBy: { createdAt: 'desc' } });
  check((await prisma.activityLog.count({ where: { action: 'CLIENT_UPDATE_POLICY_CHANGED', customerId: acme.id } })) === polAudits0 + 1 && pa.metadata.after.agentMode === "OFF" && pa.metadata.before === null, 'audited, with agentMode in after', JSON.stringify(pa?.metadata));
  r = await heartbeat(aSpare[2]);
  check(flags(r).reinstall === null && (await attempts(aSpare[2])).length === 0, 'A-SPARE-2 in the opted-out business: nothing', JSON.stringify(flags(r)));
  c = await auto(aSpare[2]);
  check(c?.state === 'opted_out' && c.reason === 'policy_off' && c.policy?.scope === 'business', 'the card: opted out by the business policy', JSON.stringify(c));
  r = await heartbeat(aSpare[0]);
  check(flags(r).reinstall === null, 'and A-SPARE-0, mid-attempt, stops being handed the flag', JSON.stringify(flags(r)));
  // Birch has no policy: its computers are still asked.
  r = await heartbeat(b1);
  check(flags(r).reinstall?.targetVersion === SERVED && (await attempts(b1)).length === 1, 'Birch\'s B-030 is still asked: Acme\'s opt-out is Acme\'s', JSON.stringify(flags(r)));
  // A site override that leaves the mode unset inherits the opt-out; one that opts back in needs fresh auth.
  r = await req('PUT', '/client-updates/policy', { s: S.owen, body: { businessId: acme.id, siteId: south.id, enabled: false, timeZone: 'UTC', windows: openWindow(), skipActiveSession: true, skipLoggedOnUser: false } });
  check(r.status === 200 && r.data.policy.agentMode === null, 'a South override with no agent mode', msg(r));
  r = await heartbeat(aSouth);
  check(flags(r).reinstall === null, 'A-SOUTH inherits the business opt-out', JSON.stringify(flags(r)));
  r = await req('PUT', '/client-updates/policy', { s: S.owen, body: { businessId: acme.id, siteId: south.id, enabled: false, timeZone: 'UTC', windows: closedWindow(), skipActiveSession: true, skipLoggedOnUser: false, agentMode: 'WINDOW' } });
  check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED', 'opting South back in (WINDOW) without fresh authentication: STEP_UP_REQUIRED', msg(r));
  S.owenUp = await stepUp(S.owen);
  r = await req('PUT', '/client-updates/policy', { s: S.owenUp, body: { businessId: acme.id, siteId: south.id, enabled: false, timeZone: 'UTC', windows: closedWindow(), skipActiveSession: true, skipLoggedOnUser: false, agentMode: 'WINDOW' } });
  check(r.status === 200 && r.data.policy.agentMode === 'WINDOW', 'with it: South updates agents only inside its window (closed now)', msg(r));
  r = await heartbeat(aSouth);
  check(flags(r).reinstall === null && (await attempts(aSouth)).length === 0, 'outside the window: nothing', JSON.stringify(flags(r)));
  c = await auto(aSouth);
  check(c?.state === 'queued' && c.reason === 'outside_window' && c.policy?.scope === 'site' && !!c.window?.opensAt && c.window.open === false, 'the card: queued, waiting for the window, with when it opens', JSON.stringify(c));
  r = await req('PUT', '/client-updates/policy', { s: S.owenUp, body: { businessId: acme.id, siteId: south.id, enabled: false, timeZone: 'UTC', windows: openWindow(), skipActiveSession: true, skipLoggedOnUser: true, agentMode: 'WINDOW' } });
  check(r.status === 200, 'South\'s window moved to now, skipping computers with someone logged on', msg(r));
  r = await heartbeat(aSouth, { loggedOnUser: 'CORP\\alice' });
  check(flags(r).reinstall === null, 'inside the window but someone is logged on: held', JSON.stringify(flags(r)));
  r = await heartbeat(aSouth, { loggedOnUser: '' });
  check(flags(r).reinstall?.targetVersion === SERVED && (await attempts(aSouth)).length === 1, 'nobody logged on: A-SOUTH goes, inside the window', JSON.stringify(flags(r)));
  r = await req('PUT', '/client-updates/policy', { s: S.owen, body: { businessId: acme.id, enabled: false, timeZone: 'UTC', windows: openWindow(), skipActiveSession: true, skipLoggedOnUser: false, agentMode: 'ANY_TIME' } });
  check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED', 'opting the business back in needs fresh authentication too', msg(r));

  section('The device list\'s agent=outdated filter, and business A/B isolation');
  r = await req('GET', '/endpoints/list?agent=outdated&pageSize=100', { s: S.owen });
  const outA = new Set((r.data?.rows ?? []).map((x) => x.id));
  const expectA = [a018, aSouth, ...aSpare].map((e) => e.id);
  check(r.status === 200 && expectA.every((id) => outA.has(id)) && !outA.has(aCur.id) && !outA.has(aPre.id) && !outA.has(aLin.id), 'Acme\'s owner: the outdated Windows agents, not the current one, the version-less one or Linux', `${msg(r)} rows=${[...outA].length}`);
  check(!outA.has(a030.id), 'A-030 (now reporting the served version) is no longer outdated');
  check(![b1.id, b2.id].some((id) => outA.has(id)), 'none of Birch\'s computers');
  check(r.data.total === outA.size, `the total agrees (${r.data?.total})`);
  r = await req('GET', '/endpoints/list?agent=outdated&pageSize=100', { s: S.bea });
  const outB = new Set((r.data?.rows ?? []).map((x) => x.id));
  check(r.status === 200 && outB.has(b1.id) && outB.has(b2.id) && outB.size === 2, 'Birch\'s owner: exactly Birch\'s two', msg(r));
  r = await req('GET', '/endpoints/list?agent=nonsense', { s: S.owen });
  check(r.status === 400, 'an unknown agent filter value is a 400, not a wider list', msg(r));
  r = await card(S.bea, a030);
  check(r.status === 404, 'Birch\'s owner cannot read an Acme computer\'s Agent card or its history (404)', msg(r));
  r = await req('PUT', '/client-updates/policy', { s: S.bea, body: { businessId: acme.id, enabled: false, timeZone: 'UTC', windows: openWindow(), skipActiveSession: true, skipLoggedOnUser: false, agentMode: 'OFF' } });
  check(r.status === 403 || r.status === 404, 'nor change Acme\'s policy', msg(r));
  r = await req('PUT', '/client-updates/policy', { s: S.owen, body: { businessId: birch.id, enabled: false, timeZone: 'UTC', windows: openWindow(), skipActiveSession: true, skipLoggedOnUser: false, agentMode: 'OFF' } });
  check(r.status === 403 || r.status === 404, 'and Acme\'s owner cannot opt Birch out', msg(r));
  r = await heartbeat(b2);
  check(flags(r).reinstall?.targetVersion === SERVED, 'Birch\'s B-WIN is still asked after all of Acme\'s changes', JSON.stringify(flags(r)));
  check((await prisma.agentAutoUpdateAttempt.findMany({ where: { endpointId: { in: [b1.id, b2.id] } } })).every((x) => x.customerId === birch.id), 'Birch\'s history rows are Birch\'s');

  section('AGENT_AUTO_UPDATE=off on another API');
  await stopApi();
  await startApi(BASE_PORT + 1, { AGENT_AUTO_UPDATE: 'off' });
  S = { admin: await login(admin.email), owen: await login(owen.email), bea: await login(bea.email) };
  await prisma.agentAutoUpdateAttempt.deleteMany({ where: { endpointId: b2.id } });
  await prisma.rustdeskNode.update({ where: { endpointId: b2.id }, data: { agentAutoTarget: null, agentAutoAttempts: 0, agentAutoLastAt: null } });
  r = await heartbeat(b2);
  check((r.status === 200 || r.status === 201) && flags(r).reinstall === null && (await attempts(b2)).length === 0, 'B-WIN (outdated, Birch has no opt-out): nothing with the process switch off', JSON.stringify(flags(r)));
  c = await auto(b2, S.bea);
  check(c?.state === 'opted_out' && c.reason === 'process_off', 'the card says AGENT_AUTO_UPDATE=off', JSON.stringify(c));
  await stopApi();
}

async function cleanup() {
  try {
    const ids = created.businesses;
    await prisma.updateJob.deleteMany({ where: { rolloutId: { in: created.rollouts } } });
    await prisma.updateRollout.deleteMany({ where: { id: { in: created.rollouts } } });
    await prisma.containmentPause.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.clientUpdatePolicy.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.agentAutoUpdateAttempt.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.endpoint.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.site.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.membership.deleteMany({ where: { userId: { in: created.users } } });
    // Audit rows are sealed (CLAUDE.md): they stay; the users and businesses they name are detached by the trigger.
    await prisma.user.deleteMany({ where: { id: { in: created.users } } }).catch(() => {});
    await prisma.customer.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    if (settingsBefore) {
      await prisma.platformSettings.update({ where: { id: 'singleton' }, data: { agentAutoUpdateEnabled: settingsBefore.agentAutoUpdateEnabled, agentAutoUpdatePerHour: settingsBefore.agentAutoUpdatePerHour, agentAutoUpdateMaxAttempts: settingsBefore.agentAutoUpdateMaxAttempts } }).catch(() => {});
    }
  } catch (e) { console.log(`cleanup: ${e.message}`); }
}

try {
  await all();
} catch (e) {
  fail++; failures.push(`crashed: ${e.stack ?? e}`);
  console.log(`\x1b[31mcrashed:\x1b[0m ${e.stack ?? e}`);
  if (api?.log) console.log(api.log.slice(-3000));
} finally {
  await stopApi();
  await cleanup();
  await prisma.$disconnect();
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1); }
