#!/usr/bin/env node
/**
 * End-to-end proof of the technician dashboard (0.31), GET /dashboard/overview:
 *
 *   - two businesses with devices, alerts (including a site outage, a
 *     maintenance-window alert and a grouped offline alert), approved-action
 *     plans and targets, sessions, update scans and audit activity;
 *   - a Business User of A (granted three of A's devices), a technician
 *     assigned only to A, A's Business Owner, B's Business Owner and a
 *     Platform Admin;
 *   - every count is checked against the seeded data, per person;
 *   - nothing of B — its id, name, device ids or names, alert, session, plan
 *     or activity ids — appears anywhere in the A-side responses (and the
 *     reverse), checked on the raw JSON, not on the fields we expect;
 *   - a business the caller may not address is a 403, not an empty 200;
 *   - stale and offline evidence: an offline device, an "agent silent"
 *     device, a stale update scan and a stale session are each handled
 *     honestly (counted as what they are, never as live).
 *
 *   cd apps/api && npx nest build
 *   DATABASE_URL=postgresql://…/rem0te_dash_test node scripts/e2e-dashboard.mjs
 *
 * FIXTURE-TESTED: rows are written directly; the API under test is the real
 * built one, started by this script.
 *
 * DASH_E2E_KEEP=1 leaves the fixtures in place (and prints the sign-ins) for
 * looking at the page by hand; remove them by deleting the two businesses.
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
const PORT = Number(process.env.DASH_API_PORT ?? 3201);
if ([3000, 3001, 4000, 4001, 443].includes(PORT)) { console.error(`Refusing port ${PORT}.`); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'dashboard-e2e-password-123';

let pass = 0, fail = 0;
const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const eq = (got, want, n) => check(JSON.stringify(got) === JSON.stringify(want), n, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;
const hex32 = () => randomBytes(16).toString('hex');
const ago = (ms) => new Date(Date.now() - ms);
const H = 3_600_000;

const apiEnv = {
  ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATABASE_URL: DB,
  JWT_SECRET: randomBytes(32).toString('hex'), LAUNCHER_TOKEN_SECRET: randomBytes(32).toString('hex'),
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? randomBytes(32).toString('hex'), TRUSTED_PROXIES: 'loopback', HBBS_PRESENCE_HOST: '127.0.0.2',
  VERSION_FILE: path.resolve(here, '..', '..', '..', 'version.json'),
  // The sweep would resolve and regroup the fixture alerts; the staleness
  // sweep would flip the "agent silent" device offline. Neither may run.
  MONITOR_SWEEP: 'off', AUDIT_SEALER: 'off', ENDPOINT_STALE_SWEEP: 'off',
};
let api;
function startApi() {
  api = spawn(process.execPath, [path.join(dist, 'main.js')], { env: apiEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  api.log = ''; api.stdout.on('data', (d) => { api.log += d; }); api.stderr.on('data', (d) => { api.log += d; });
}
async function stopApi() { if (!api || api.exitCode !== null) return; await new Promise((r) => { api.once('exit', r); api.kill('SIGTERM'); }); }
async function waitUp() {
  for (let i = 0; i < 120; i++) { try { const r = await fetch(`${API}/health`); if (r.status < 500) return; } catch { /* not yet */ } await sleep(300); }
  throw new Error(`api did not come up:\n${api.log.slice(-3000)}`);
}
async function req(method, p, { s, business } = {}) {
  const h = { 'content-type': 'application/json', 'x-forwarded-for': s?.ip ?? ip() };
  if (s) h.cookie = s.cookie;
  if (business) h['x-rem0te-business'] = business;
  const r = await fetch(`${API}${p}`, { method, headers: h });
  const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j, data: j?.data, text };
}
async function login(email) {
  const s = { ip: ip() };
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': s.ip }, body: JSON.stringify({ email, password: PW }) });
  const mm = (r.headers.get('set-cookie') ?? '').match(/access_token=([^;]+)/);
  if (r.status !== 200 || !mm) throw new Error(`login ${email}: ${r.status} ${await r.text()}`);
  s.cookie = `access_token=${mm[1]}`;
  return s;
}
const msg = (r) => `HTTP ${r.status} ${typeof r.body === 'string' ? r.body.slice(0, 300) : JSON.stringify(r.body).slice(0, 300)}`;

const created = { businesses: [], users: [] };

async function all() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });
  const roleUser = await prisma.role.findFirst({ where: { type: 'BUSINESS_USER' } });

  section('Fixtures (synthetic): Alder (A) and Birch (B)');
  const A = await prisma.customer.create({ data: { tenantId: tenant.id, name: `DB Alder ${sfx}` } });
  const B = await prisma.customer.create({ data: { tenantId: tenant.id, name: `DB Birch ${sfx}` } });
  created.businesses.push(A.id, B.id);
  const hq = await prisma.site.create({ data: { tenantId: tenant.id, customerId: A.id, name: `HQ-${sfx}` } });
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag, extra = {}) => { const u = await prisma.user.create({ data: { email: `db-${tag}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'DB', lastName: tag, status: 'ACTIVE', ...extra } }); created.users.push(u.id); return u; };
  const admin = await mkUser('admin', { isPlatformAdmin: true });
  const ownerA = await mkUser('owner-a'), ownerB = await mkUser('owner-b'), userA = await mkUser('user-a'), tech = await mkUser('tech-a');
  const CAPS = ['computers:view', 'monitoring:alerts', 'support:sessions_view', 'support:history_view', 'audit:view'];
  await prisma.membership.create({ data: { userId: ownerA.id, tenantId: tenant.id, customerId: A.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: ownerB.id, tenantId: tenant.id, customerId: B.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: userA.id, tenantId: tenant.id, customerId: A.id, roleId: roleUser.id, capabilities: CAPS } });
  // Assigned to A only, every computer in it; nothing in B.
  await prisma.technicianAssignment.create({ data: { tenantId: tenant.id, customerId: A.id, userId: tech.id, capabilities: CAPS, endpointIds: [] } });

  const mkEp = (biz, name, extra = {}) => prisma.endpoint.create({ data: { tenantId: tenant.id, customerId: biz.id, name: `${name}-${sfx}`, hostname: `${name}-${sfx}`, status: 'ACTIVE', isOnline: true, isManaged: true, lastSeenAt: new Date(), ...extra } });
  const a1 = await mkEp(A, 'A-PC1');
  const a2 = await mkEp(A, 'A-PC2', { isOnline: false, lastSeenAt: ago(2 * H) });
  const a3 = await mkEp(A, 'A-PC3', { lastSeenAt: ago(2 * H) }); // reachable, agent silent
  const a4 = await mkEp(A, 'A-PC4');
  const a5 = await mkEp(A, 'A-PC5');
  const a6 = await mkEp(A, 'A-PC6', { siteId: hq.id });
  await mkEp(A, 'A-OLD', { status: 'ARCHIVED' });
  await mkEp(A, 'A-NEW', { status: 'PENDING_ENROLLMENT', isOnline: false, lastSeenAt: null });
  const b1 = await mkEp(B, 'B-PC1');
  const b2 = await mkEp(B, 'B-PC2', { isOnline: false, lastSeenAt: ago(5 * H) });
  const b3 = await mkEp(B, 'B-PC3');
  for (const e of [a1, a2, a4]) await prisma.computerAccess.create({ data: { tenantId: tenant.id, endpointId: e.id, userId: userA.id } });

  // Update scans (the standard agent's inventory scan).
  const scan = (e, hoursOld, pending, reboot) => prisma.endpointInventory.create({ data: { endpointId: e.id, updatesCheckedAt: ago(hoursOld * H), pendingUpdates: pending, pendingUpdateCount: pending.length, rebootRequired: reboot } });
  await scan(a4, 1, [{ title: 'Cumulative Update', kb: 'KB5000001', severity: 'Critical' }, { title: '.NET update', kb: 'KB5000002', severity: 'Important' }], true);
  await scan(a5, 2, [], false);
  await scan(a6, 72, [], true); // stale: three days old, says restart pending
  await scan(b3, 1, [], false);
  await scan(b1, 1, [{ title: 'B update', kb: 'KB5999999', severity: 'Critical' }], true);

  // Alerts.
  const al = (biz, e, kind, severity, title, extra = {}) => prisma.monitorAlert.create({ data: { tenantId: tenant.id, customerId: biz.id, endpointId: e?.id ?? null, ruleKey: kind.toLowerCase(), kind, dedupKey: `db:${sfx}:${hex32()}`, severity, title: `${title} ${sfx}`, detail: {}, firstSeenAt: ago(3 * H), ...extra } });
  const alA2 = await al(A, a2, 'DISK_FREE', 'CRITICAL', 'A-PC2 disk full');
  const alA1 = await al(A, a1, 'CPU_HIGH', 'WARNING', 'A-PC1 CPU high', { firstSeenAt: ago(1 * H) });
  const alA4ack = await al(A, a4, 'MEMORY_HIGH', 'WARNING', 'A-PC4 memory', { state: 'ACKNOWLEDGED', acknowledgedAt: ago(0.5 * H), acknowledgedById: ownerA.id });
  const alA4reboot = await al(A, a4, 'REBOOT_PENDING', 'INFO', 'A-PC4 restart pending');
  const alA5sup = await al(A, a5, 'DISK_FREE', 'CRITICAL', 'A-PC5 disk (maintenance)', { suppressed: true });
  const outage = await al(A, null, 'SITE_OUTAGE', 'CRITICAL', 'HQ is dark', { siteId: hq.id, ruleKey: 'site-outage', firstSeenAt: ago(0.25 * H) });
  const child = await al(A, a6, 'OFFLINE', 'WARNING', 'A-PC6 offline', { siteId: hq.id, parentId: outage.id, firstSeenAt: ago(0.3 * H) });
  await al(A, a1, 'CPU_HIGH', 'CRITICAL', 'A-PC1 resolved long ago', { state: 'RESOLVED', resolvedAt: ago(H) });
  const alB2 = await al(B, b2, 'DISK_FREE', 'CRITICAL', 'B-PC2 disk full');
  const alB1 = await al(B, b1, 'CPU_HIGH', 'WARNING', 'B-PC1 CPU high');

  // Approved-action plans.
  const job = async (biz, targets, status, tstatus, extra = {}) => {
    const id = hex32();
    await prisma.actionJob.create({ data: {
      id, tenantId: tenant.id, customerId: biz.id, endpointId: targets[0].id, actionId: 'windows.service.start', actionVersion: 1, params: {}, reason: `fixture ${sfx}`,
      origin: 'technician', via: 'portal', requestedById: ownerA.id, status, risk: 'low', approvalsRequired: 1, customerSignoff: false,
      notBefore: ago(2 * H), notAfter: new Date(Date.now() + 6 * H), plan: {}, digest: hex32(), approvalUrl: 'https://approve.example.com/x', createdAt: ago(2 * H), ...extra,
      targets: { create: targets.map((t) => ({ endpointId: t.id, status: tstatus, ...(tstatus === 'FAILED' ? { statusReason: 'service did not start', resultAt: ago(H) } : {}) })) },
    } });
    return id;
  };
  const jA1 = await job(A, [a1], 'AWAITING_APPROVAL', 'PENDING');
  const jAring = await job(A, [a1, a5], 'AWAITING_APPROVAL', 'PENDING'); // a Business User sees a1 but not a5
  const jAunk = await job(A, [a4], 'DISPATCHED', 'UNKNOWN', { dispatchedAt: ago(H) });
  const jAfail = await job(A, [a2], 'FAILED', 'FAILED');
  const jAexpired = await job(A, [a1], 'AWAITING_APPROVAL', 'PENDING', { notAfter: ago(H) });
  const jB1 = await job(B, [b1], 'AWAITING_APPROVAL', 'PENDING');
  const jBfail = await job(B, [b2], 'FAILED', 'FAILED');

  // Sessions.
  const ses = (biz, e, who, status, extra = {}) => prisma.supportSession.create({ data: { tenantId: tenant.id, customerId: biz.id, endpointId: e.id, technicianId: who.id, status, lastSignalAt: new Date(), ...extra } });
  const sTech = await ses(A, a1, tech, 'SESSION_STARTED', { connectionConfirmedAt: ago(0.2 * H) });
  const sOwnerA5 = await ses(A, a5, ownerA, 'SESSION_STARTED');
  const sStale = await ses(A, a1, ownerA, 'SESSION_STARTED', { lastSignalAt: ago(48 * H) });
  await prisma.$executeRaw`UPDATE "SupportSession" SET "updatedAt" = now() - interval '2 days', "createdAt" = now() - interval '2 days' WHERE id = ${sStale.id}`;
  await ses(A, a2, tech, 'SESSION_COMPLETED', { createdAt: ago(5 * H) });
  const sB = await ses(B, b1, ownerB, 'SESSION_STARTED');
  await ses(B, b3, admin, 'SESSION_COMPLETED');

  // Activity.
  const act = (customerId, action, resource, resourceId) => prisma.activityLog.create({ data: { tenantId: tenant.id, customerId, actorId: ownerA.id, action, resource, resourceId } });
  const actA = await act(A.id, 'MONITOR_ALERT_ACKNOWLEDGED', 'monitor_alert', alA4ack.id);
  const actA2 = await act(A.id, 'SESSION_LAUNCHED', 'support_session', sTech.id);
  await act(A.id, 'LOGIN_SUCCESS', 'user', ownerA.id); // not relevant: filtered out
  const actB = await act(B.id, 'SESSION_LAUNCHED', 'support_session', sB.id);
  const actPlatform = await act(null, 'UPDATE_ROLLOUT_PAUSED', 'update_rollout', `rollout-${sfx}`);

  startApi();
  await waitUp();
  const S = { admin: await login(admin.email), ownerA: await login(ownerA.email), ownerB: await login(ownerB.email), userA: await login(userA.email), tech: await login(tech.email) };
  const get = (s, opts = {}) => req('GET', `/dashboard/overview${opts.q ?? ''}`, { s, business: opts.business });

  const bMarkers = [B.id, B.name, b1.id, b2.id, b3.id, b1.name, b2.name, b3.name, alB2.id, alB1.id, sB.id, jB1, jBfail, actB.id, 'KB5999999'];
  const aMarkers = [A.id, A.name, a1.id, a2.id, a4.id, a1.name, alA2.id, alA1.id, sTech.id, jA1, actA.id];
  const leaks = (text, markers) => markers.filter((m) => text.includes(m));
  const queueKinds = (d) => d.queue.items.map((i) => (i.kind === 'alert' ? `alert:${i.severity}` : i.kind));

  section('Business Owner of A');
  let r = await get(S.ownerA);
  check(r.status === 200, 'overview loads', msg(r));
  let d = r.data;
  eq(leaks(r.text, bMarkers), [], 'nothing of Birch anywhere in the response');
  eq(d.devices && { total: d.devices.total, online: d.devices.online, offline: d.devices.offline, agentSilent: d.devices.agentSilent }, { total: 6, online: 5, offline: 1, agentSilent: 1 }, 'devices: 6 active (archived and pending excluded), 5 online, 1 offline, 1 agent silent');
  eq(d.devices.offlineList.map((x) => x.id), [a2.id], 'the offline list is A-PC2, with its last-seen time');
  check(d.devices.offlineList[0]?.lastSeenAt && Date.now() - Date.parse(d.devices.offlineList[0].lastSeenAt) > 1.9 * H, 'offline device shows its real last-seen age, not now', JSON.stringify(d.devices.offlineList[0]));
  eq(d.alerts && { open: d.alerts.open, acknowledged: d.alerts.acknowledged, critical: d.alerts.critical, warning: d.alerts.warning, info: d.alerts.info, suppressed: d.alerts.suppressed, criticalOpen: d.alerts.criticalOpen },
    { open: 6, acknowledged: 1, critical: 2, warning: 3, info: 1, suppressed: 1, criticalOpen: 2 }, 'alert counts: resolved excluded, maintenance counted apart from critical');
  eq(d.alerts.outages.map((o) => [o.id, o.devices]), [[outage.id, 1]], 'the site outage, with the devices grouped under it');
  eq(d.patch && { total: d.patch.total, fresh: d.patch.fresh, upToDate: d.patch.upToDate, needsUpdates: d.patch.needsUpdates, stale: d.patch.stale, noScan: d.patch.noScan, compliancePercent: d.patch.compliancePercent, coveragePercent: d.patch.coveragePercent },
    { total: 6, fresh: 2, upToDate: 1, needsUpdates: 1, stale: 1, noScan: 3, compliancePercent: 50, coveragePercent: 33 }, 'patch compliance only from fresh scans; stale and missing are counted, not assumed');
  check(typeof d.patch.definition === 'string' && d.patch.definition.includes('36 hours'), 'compliance carries its definition', d.patch.definition);
  eq(d.restart.list.map((x) => [x.device.id, x.stale]).sort(), [[a4.id, false], [a6.id, true]].sort(), 'restart pending: A-PC4 (fresh) and A-PC6 (stale evidence, flagged stale)');
  eq(queueKinds(d), ['site_outage', 'alert:critical', 'action_uncertain', 'action_failed', 'alert:warning', 'approval_waiting', 'approval_waiting', 'alert:info'], 'work-on-next: outage, critical, uncertain, failed, warning, approvals, info — in that order');
  check(d.queue.items.every((i) => typeof i.reason === 'string' && i.reason.length > 20 && i.href), 'every queue item says why it is there and links somewhere', JSON.stringify(d.queue.items.map((i) => i.reason)));
  check(!d.queue.items.some((i) => i.key === `alert:${alA5sup.id}` || i.key === `alert:${child.id}` || i.key === `alert:${alA4ack.id}`), 'not queued: the maintenance-window alert, the alert grouped under the outage, the acknowledged one');
  check(!d.queue.items.some((i) => i.key === `job:${jAexpired}`), 'an expired approval request is not shown as waiting');
  check(!d.queue.items.some((i) => i.kind === 'restart_pending'), 'restart from a scan is not queued when an alert already covers it, nor from stale evidence');
  eq({ awaiting: d.actions.awaitingApproval, failed: d.actions.failed, uncertain: d.actions.uncertain, inFlight: d.actions.inFlight.map((j) => j.id) }, { awaiting: 2, failed: 1, uncertain: 1, inFlight: [jAunk] }, 'actions: 2 awaiting, 1 failed, 1 uncertain, 1 in flight');
  eq(d.sessions.live.map((s) => s.id).sort(), [sTech.id, sOwnerA5.id].sort(), 'live sessions: two, and the two-day-old one is not shown as live');
  eq(d.acknowledged.map((a) => [a.id, a.by]), [[alA4ack.id, `DB owner-a`]], 'being worked on: the acknowledged alert and who has it');
  eq(d.customers.map((c) => [c.business.id, c.outages, c.critical, c.warning, c.offline, c.failedActions]), [[A.id, 1, 2, 3, 1, 2]], 'customers affected: A only, with its counts');
  check(d.attention[0]?.device.id === a2.id && d.attention.some((x) => x.device.id === a3.id && x.reasons.some((y) => /Agent silent/.test(y))), 'devices needing attention: A-PC2 first; A-PC3 listed as agent silent', JSON.stringify(d.attention.map((x) => [x.device.name, x.reasons])));
  eq(d.activity.map((x) => x.id).sort(), [actA.id, actA2.id].sort(), 'activity: A\'s relevant events only (no login noise, no platform rows)');

  section('Business User of A (granted A-PC1, A-PC2, A-PC4)');
  r = await get(S.userA);
  check(r.status === 200, 'overview loads', msg(r));
  d = r.data;
  eq(leaks(r.text, bMarkers), [], 'nothing of Birch anywhere in the response');
  eq(leaks(r.text, [a3.id, a5.id, a6.id, alA5sup.id, outage.id, jAring, sOwnerA5.id]), [], 'nor A\'s devices they were not granted, their alerts, a plan naming one, or a session on one');
  eq({ total: d.devices.total, offline: d.devices.offline, agentSilent: d.devices.agentSilent }, { total: 3, offline: 1, agentSilent: 0 }, 'devices: their three');
  eq({ open: d.alerts.open, acknowledged: d.alerts.acknowledged, critical: d.alerts.critical, suppressed: d.alerts.suppressed, outages: d.alerts.outages.length }, { open: 3, acknowledged: 1, critical: 1, suppressed: 0, outages: 0 }, 'alerts: only for their devices; no site outage (it needs the whole business)');
  eq({ fresh: d.patch.fresh, upToDate: d.patch.upToDate, noScan: d.patch.noScan, compliancePercent: d.patch.compliancePercent }, { fresh: 1, upToDate: 0, noScan: 2, compliancePercent: 0 }, 'patch compliance over their devices');
  eq(queueKinds(d), ['alert:critical', 'action_uncertain', 'action_failed', 'alert:warning', 'approval_waiting', 'alert:info'], 'their queue');
  eq(d.sessions.live.map((s) => s.id), [sTech.id], 'live sessions: only the one on a device they can see');
  eq(d.activity.map((x) => x.id).sort(), [actA.id, actA2.id].sort(), 'activity: A\'s (audit:view is business-wide)');
  r = await get(S.userA, { q: `?businessId=${B.id}` });
  check(r.status === 403, 'asking for Birch is refused (403), not answered empty', msg(r));

  section('Technician assigned only to A');
  r = await get(S.tech, { business: A.id });
  check(r.status === 200, 'overview loads in A', msg(r));
  d = r.data;
  eq(leaks(r.text, bMarkers), [], 'nothing of Birch anywhere in the response');
  eq({ total: d.devices.total, open: d.alerts.open, outages: d.alerts.outages.length, fresh: d.patch.fresh, awaiting: d.actions.awaitingApproval }, { total: 6, open: 6, outages: 1, fresh: 2, awaiting: 2 }, 'whole-business assignment: A\'s full counts');
  eq(d.sessions.live.map((s) => s.id).sort(), [sTech.id, sOwnerA5.id].sort(), 'live sessions in A');
  eq(d.recentDevices.map((x) => x.id), [a1.id, a2.id], 'recently accessed: their own sessions\' devices, newest first');
  check(d.customers.every((c) => c.business.id === A.id), 'customers affected: A only');
  r = await get(S.tech, { business: A.id, q: `?businessId=${B.id}` });
  check(r.status === 403, 'asking for Birch is refused (403)', msg(r));
  r = await get(S.tech, { business: B.id });
  check(r.status === 401 || r.status === 403 || (r.status === 200 && !leaks(r.text, bMarkers).length), 'naming Birch as the active business does not reach it', msg(r));

  section('Business Owner of B');
  r = await get(S.ownerB);
  d = r.data;
  eq(leaks(r.text, aMarkers), [], 'nothing of Alder anywhere in the response');
  eq({ total: d.devices.total, offline: d.devices.offline, open: d.alerts.open, critical: d.alerts.critical, awaiting: d.actions.awaitingApproval, failed: d.actions.failed, live: d.sessions.live.length }, { total: 3, offline: 1, open: 2, critical: 1, awaiting: 1, failed: 1, live: 1 }, 'B\'s counts');
  eq(d.restart.list.map((x) => x.device.id), [b1.id], 'restart pending from B-PC1\'s scan');
  check(d.queue.items.some((i) => i.kind === 'restart_pending' && i.device?.id === b1.id), 'a fresh restart-pending scan with no alert is queued', JSON.stringify(queueKinds(d)));

  section('Platform Admin');
  r = await get(S.admin);
  check(r.status === 200 && r.data.scope === 'platform', 'platform-wide view', msg(r));
  d = r.data;
  check(leaks(r.text, [A.id, B.id, a2.id, b2.id, alA2.id, alB2.id]).length === 6, 'sees both businesses\' devices and alerts');
  check(d.customers.some((c) => c.business.id === A.id) && d.customers.some((c) => c.business.id === B.id), 'customers affected lists both');
  check(d.activity.some((x) => x.id === actPlatform.id) && d.activity.some((x) => x.id === actB.id) && d.activity.some((x) => x.id === actA.id), 'activity includes both businesses and platform-level rows');
  r = await get(S.admin, { q: `?businessId=${A.id}` });
  eq({ total: r.data.devices.total, open: r.data.alerts.open, fresh: r.data.patch.fresh, awaiting: r.data.actions.awaitingApproval }, { total: 6, open: 6, fresh: 2, awaiting: 2 }, 'narrowed to A: A\'s counts exactly');
  eq(leaks(r.text, bMarkers), [], 'narrowed to A: nothing of Birch');
  r = await get(S.admin, { q: `?businessId=${B.id}` });
  eq({ total: r.data.devices.total, open: r.data.alerts.open }, { total: 3, open: 2 }, 'narrowed to B: B\'s counts exactly');

  section('No capability, no section');
  await prisma.membership.updateMany({ where: { userId: userA.id }, data: { capabilities: [] } });
  const bare = await login(userA.email);
  r = await get(bare);
  check(r.status === 200, 'still loads', msg(r));
  d = r.data;
  eq([d.devices, d.alerts, d.patch, d.actions, d.sessions, d.activity, d.recentDevices], [null, null, null, null, null, null, null], 'every section is null (not zero) without its permission');
  eq(d.queue.items, [], 'and the queue is empty');
}

async function cleanup() {
  await stopApi();
  if (process.env.DASH_E2E_KEEP === '1') {
    console.log(`\nKEPT fixtures: businesses ${created.businesses.join(', ')}; sign in as db-owner-a-${sfx}@test.invalid (and user-a, tech-a, owner-b, admin) with the suite password`);
    await prisma.membership.updateMany({ where: { user: { email: `db-user-a-${sfx}@test.invalid` } }, data: { capabilities: ['computers:view', 'monitoring:alerts', 'support:sessions_view', 'support:history_view', 'audit:view'] } });
    await prisma.$disconnect();
    return;
  }
  try {
    const ids = created.businesses;
    const eps = (await prisma.endpoint.findMany({ where: { customerId: { in: ids } }, select: { id: true } })).map((e) => e.id);
    await prisma.actionJob.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.monitorAlert.updateMany({ where: { customerId: { in: ids } }, data: { parentId: null } });
    await prisma.monitorAlert.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.supportSession.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.technicianAssignment.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.computerAccess.deleteMany({ where: { endpointId: { in: eps } } });
    await prisma.endpointInventory.deleteMany({ where: { endpointId: { in: eps } } });
    await prisma.endpoint.deleteMany({ where: { id: { in: eps } } });
    await prisma.site.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.membership.deleteMany({ where: { customerId: { in: ids } } });
    // Audit rows stay (they are append-only); deleting the business nulls their reference.
    await prisma.customer.deleteMany({ where: { id: { in: ids } } });
    await prisma.activityLog.updateMany({ where: { actorId: { in: created.users } }, data: { actorId: null } }).catch(() => undefined);
    if (created.users.length) await prisma.user.deleteMany({ where: { id: { in: created.users } } });
  } catch (e) { console.error('cleanup:', e.message); }
  await prisma.$disconnect();
}

all().catch((e) => { fail++; failures.push(`crashed: ${e.stack ?? e}`); console.error(e); if (api) console.error(api.log.slice(-3000)); })
  .finally(async () => {
    await cleanup();
    console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
    if (failures.length) { for (const f of failures) console.log(`  - ${f}`); if (api?.log) console.log(`\n── API output (last 4000 characters)\n${api.log.slice(-4000)}`); process.exit(1); }
    process.exit(0);
  });
