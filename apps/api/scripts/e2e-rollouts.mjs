#!/usr/bin/env node
/**
 * End-to-end proof of controlled RustDesk updates (v0.20, F5), over HTTP
 * against a running API and a real Postgres, with endpoints simulated by
 * authenticated heartbeats.
 *
 * Covers: the supported-version pin reaches the installer; a rollout
 * resolves its targets (unsupported, unauthenticated and busy computers are
 * skipped with a reason); nothing dispatches before start or outside the
 * current batch; the pilot batch goes first; an active session defers; one
 * dispatch per job, never two in flight; the job's nonce makes the installer
 * install exactly the approved version; success needs the version from an
 * authenticated heartbeat; a short install retries with backoff and then
 * fails; the failure threshold pauses the rollout; a newer-than-approved
 * install fails without looping; verify timeouts; maintenance windows;
 * cancel.
 *
 * The batch engine's minute timer is driven directly (the compiled service's
 * tick()), so the suite does not wait for it. It needs the API's
 * HBBS_PRESENCE_HOST pointed somewhere unreachable (dev.env uses 127.0.0.2),
 * so registration is "unavailable" rather than a query against a real hbbs.
 *
 *   API_BASE=http://127.0.0.1:3101/api/v1 DATABASE_URL=… node scripts/e2e-rollouts.mjs
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { createHash, randomBytes } from 'crypto';

const API = process.env.API_BASE || 'http://127.0.0.1:3001/api/v1';
if (/:3001\b|:443\b|^https:/.test(API) && process.env.I_KNOW_THIS_IS_NOT_PRODUCTION !== '1') {
  console.error(`Refusing to run against ${API}: this suite writes fixtures. Use a scratch stack.`);
  process.exit(2);
}

const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'test-password-123456';
const FROM = '1.4.0', TARGET = '1.4.1';

let pass = 0, fail = 0;
const failures = [];
function check(cond, name, detail = '') {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; failures.push(`${name} — ${detail}`); console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${detail}`); }
}
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const pace = () => new Promise((r) => setTimeout(r, 60));
const j = (x) => JSON.stringify(x)?.slice(0, 300);
const sha = (s) => createHash('sha256').update(s).digest('hex');

async function req(method, p, { body, cookie } = {}) {
  await pace();
  const r = await fetch(`${API}${p}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed, text };
}
async function login(email) {
  await pace();
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }) });
  const m = (r.headers.get('set-cookie') || '').match(/access_token=([^;]+)/);
  if (!m) throw new Error(`login ${email} failed: ${r.status}`);
  return `access_token=${m[1]}`;
}

// The engine's timer, run in-process against the same database.
const require = createRequire(import.meta.url);
const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'admin', 'update-rollout.service.js');
const { UpdateRolloutService } = require(dist);
const engine = new UpdateRolloutService(prisma, { log: async () => {} });
const tick = () => engine.tick();

const created = { users: [], businesses: [], endpoints: [], rollouts: [], groups: [] };
const devices = new Map();
async function device(tenantId, businessId, name, { platform = 'windows', secret = true } = {}) {
  const rd = String(100000000 + Math.floor(Math.random() * 800000000));
  const s = randomBytes(24).toString('base64url');
  const ep = await prisma.endpoint.create({
    data: {
      tenantId, customerId: businessId, name: `${name}-${sfx}`, hostname: `${name}-${sfx}`, status: 'ACTIVE', platform,
      isOnline: true, isManaged: true,
      rustdeskNode: { create: { tenantId, rustdeskId: rd, version: FROM, ...(secret ? { agentSecretHash: sha(s) } : {}) } },
    },
  });
  created.endpoints.push(ep.id);
  devices.set(ep.id, { rd, secret: s });
  return ep;
}
async function beat(ep, extra = {}) {
  const d = devices.get(ep.id);
  const r = await req('POST', '/enrollment/heartbeat', { body: { rustdeskId: d.rd, agentSecret: d.secret, platform: 'windows', rustdeskVersion: FROM, ...extra } });
  return r.body?.data ?? {};
}
const job = (rolloutId, endpointId) => prisma.updateJob.findFirst({ where: { rolloutId, endpointId } });

async function cleanup() {
  await prisma.updateJobEvent.deleteMany({ where: { job: { rolloutId: { in: created.rollouts } } } });
  await prisma.updateJob.deleteMany({ where: { rolloutId: { in: created.rollouts } } });
  await prisma.updateRollout.deleteMany({ where: { id: { in: created.rollouts } } });
  await prisma.updatePilotMember.deleteMany({ where: { groupId: { in: created.groups } } });
  await prisma.updatePilotGroup.deleteMany({ where: { id: { in: created.groups } } });
  await prisma.rustdeskNode.deleteMany({ where: { endpointId: { in: created.endpoints } } });
  await prisma.activityLog.deleteMany({ where: { OR: [{ actorId: { in: created.users } }, { resourceId: { in: [...created.endpoints, ...created.rollouts] } }] } });
  await prisma.activityLog.updateMany({ where: { customerId: { in: created.businesses } }, data: { customerId: null } });
  await prisma.endpoint.deleteMany({ where: { id: { in: created.endpoints } } });
  await prisma.membership.deleteMany({ where: { userId: { in: created.users } } });
  await prisma.customer.deleteMany({ where: { id: { in: created.businesses } } });
  await prisma.user.deleteMany({ where: { id: { in: created.users } } });
}

let originalPin;
try {
  const tenant = await prisma.tenant.findFirst({ where: { isActive: true }, orderBy: { createdAt: 'asc' } });
  const T = tenant.id;
  const biz = await prisma.customer.create({ data: { tenantId: T, name: `Rollout ${sfx}`, isActive: true } });
  created.businesses.push(biz.id);
  const admin = await prisma.user.create({ data: { email: `ro-adam-${sfx}@test.invalid`, passwordHash: await argon2.hash(PW, { type: argon2.argon2id }), firstName: 'Adam', lastName: 'T', status: 'ACTIVE', isPlatformAdmin: true } });
  const owner = await prisma.user.create({ data: { email: `ro-olga-${sfx}@test.invalid`, passwordHash: await argon2.hash(PW, { type: argon2.argon2id }), firstName: 'Olga', lastName: 'T', status: 'ACTIVE' } });
  created.users.push(admin.id, owner.id);
  const ownerRole = await prisma.role.findFirst({ where: { tenantId: T, type: 'BUSINESS_OWNER' } });
  await prisma.membership.create({ data: { userId: owner.id, tenantId: T, customerId: biz.id, roleId: ownerRole.id, isActive: true } });

  const P1 = await device(T, biz.id, 'ro-pilot');
  const F1 = await device(T, biz.id, 'ro-f1');
  const F2 = await device(T, biz.id, 'ro-f2');
  const F3 = await device(T, biz.id, 'ro-f3');
  const L1 = await device(T, biz.id, 'ro-linux', { platform: 'linux' });
  const N1 = await device(T, biz.id, 'ro-nosecret', { secret: false });
  const Z1 = await device(T, biz.id, 'ro-zulu');
  const cAdmin = await login(admin.email);
  const cOwner = await login(owner.email);

  // ─────────────────────────────────────────────────────────────────────
  section('Access and version pin');
  let r = await req('GET', '/admin/rollouts', { cookie: cOwner });
  check(r.status === 403, 'a business owner cannot see rollouts', `${r.status}`);
  originalPin = (await prisma.platformSettings.findUnique({ where: { id: 'singleton' } }))?.rustdeskPinnedVersion ?? null;
  r = await req('PATCH', '/admin/rollouts/pin', { cookie: cAdmin, body: { version: '1.3.9' } });
  check(r.status === 200 && r.body.data.pinnedVersion === '1.3.9', 'pin set');
  r = await req('GET', '/public/install/windows.ps1');
  check(r.status === 200 && r.text.includes('1.3.9'), 'the installer installs the pinned version', r.text.slice(0, 120));
  r = await req('PATCH', '/admin/rollouts/pin', { cookie: cAdmin, body: { version: 'latest' } });
  check(r.status === 400, 'a pin must be an exact version', `${r.status}`);
  r = await req('PATCH', '/admin/rollouts/pin', { cookie: cAdmin, body: { version: originalPin } });

  section('Creating a rollout');
  r = await req('POST', '/admin/rollouts/pilot-groups', { cookie: cAdmin, body: { name: `pilot-${sfx}`, endpointIds: [P1.id] } });
  check(r.status === 201, 'pilot group saved', `${r.status} ${j(r.body)}`);
  const groupId = r.body.data.id; created.groups.push(groupId);
  r = await req('POST', '/admin/rollouts', { cookie: cAdmin, body: { name: `ro-${sfx}`, component: 'RUSTDESK', targetVersion: 'latest', endpointIds: [P1.id] } });
  check(r.status === 400, 'target must be an exact version', `${r.status}`);
  r = await req('POST', '/admin/rollouts', { cookie: cAdmin, body: {
    name: `ro-${sfx}`, component: 'RUSTDESK', targetVersion: TARGET, endpointIds: [P1.id, F1.id, F2.id, F3.id, L1.id, N1.id],
    pilotGroupId: groupId, batchSize: 2, failureThreshold: 1, maxAttempts: 2, backoffMinutes: 5, allowSignatureOnly: true,
  } });
  check(r.status === 201 && r.body.data.status === 'DRAFT', 'rollout created as a draft', `${r.status} ${j(r.body)}`);
  const RID = r.body.data.id; created.rollouts.push(RID);
  const jobs = Object.fromEntries(r.body.data.jobs.map((x) => [x.endpointId, x]));
  check(jobs[P1.id].batch === 0 && jobs[F1.id].batch === 1 && jobs[F2.id].batch === 1 && jobs[F3.id].batch === 2, 'pilot is batch 0, then batches of 2', j(Object.values(jobs).map((x) => x.batch)));
  check(jobs[L1.id].status === 'SKIPPED' && /Windows-only/.test(jobs[L1.id].failureReason), 'non-Windows computer skipped with a reason');
  check(jobs[N1.id].status === 'SKIPPED' && /device_not_authenticated/.test(jobs[N1.id].failureReason), 'computer without a device secret skipped');
  r = await req('POST', '/admin/rollouts', { cookie: cAdmin, body: { name: `dup-${sfx}`, component: 'RUSTDESK', targetVersion: TARGET, endpointIds: [P1.id], allowSignatureOnly: true } });
  if (r.status === 201) created.rollouts.push(r.body.data.id);
  check(r.status === 201 && r.body.data.jobs[0].status === 'SKIPPED' && /already_in_another_rollout/.test(r.body.data.jobs[0].failureReason), 'a computer already in a rollout is skipped by a second one', j(r.body?.data?.jobs?.[0]));

  // Skipped computers take no batch slot, and the plan does not depend on the
  // order the database happens to return rows in: 'ro-zulu' sorts after the
  // two skipped computers, and must still be in the first fleet batch.
  r = await req('POST', '/admin/rollouts', { cookie: cAdmin, body: { name: `skip-${sfx}`, component: 'RUSTDESK', targetVersion: TARGET, endpointIds: [N1.id, Z1.id, L1.id], batchSize: 1, allowSignatureOnly: true } });
  if (r.status === 201) created.rollouts.push(r.body.data.id);
  const zj = r.body?.data?.jobs?.find((x) => x.endpointId === Z1.id);
  check(r.status === 201 && zj?.status === 'REQUESTED' && zj.batch === 1, 'skipped computers take no batch slot', j(r.body?.data?.jobs?.map((x) => [x.status, x.batch])));
  if (r.status === 201) { await req('POST', `/admin/rollouts/${r.body.data.id}/cancel`, { cookie: cAdmin }); }

  let hb = await beat(P1);
  check(!hb.updateRustdesk, 'nothing dispatched before start', j(hb.updateRustdesk));

  // ─────────────────────────────────────────────────────────────────────
  section('Pilot batch');
  r = await req('POST', `/admin/rollouts/${RID}/start`, { cookie: cAdmin });
  check(r.status === 200 && r.body.data.status === 'RUNNING' && r.body.data.currentBatch === 0, 'started at the pilot batch', j({ s: r.body?.data?.status, b: r.body?.data?.currentBatch }));
  hb = await beat(F1);
  check(!hb.updateRustdesk, 'a fleet computer waits while the pilot runs');
  hb = await beat(P1, { rustdeskSessions: 1 });
  check(!hb.updateRustdesk && (await job(RID, P1.id)).deferReason === 'active_session_reported_by_endpoint', 'an active session defers the update', j(await job(RID, P1.id)));
  hb = await beat(P1);
  const nonce = hb.updateRustdesk?.nonce;
  check(hb.updateRustdesk?.targetVersion === TARGET && !!nonce, 'dispatched with the exact version and a nonce', j(hb.updateRustdesk));
  hb = await beat(P1);
  check(!hb.updateRustdesk, 'never dispatched twice while in flight');
  r = await req('GET', `/public/install/windows.ps1?updateNonce=${nonce}`);
  check(r.status === 200 && r.text.includes(TARGET), 'the job\'s installer installs exactly the approved version');
  check((await job(RID, P1.id)).status === 'INSTALLING', 'fetching the installer marks it INSTALLING');
  r = await req('GET', `/public/install/windows.ps1?updateNonce=${'x'.repeat(24)}`);
  check(r.status === 200 && !r.text.includes(TARGET), 'an unknown nonce changes nothing');
  await beat(P1, { rustdeskVersion: TARGET, updateNonce: nonce, password: 'reported' });
  let pj = await job(RID, P1.id);
  check(pj.status === 'SUCCEEDED' && pj.installedVersion === TARGET, 'success needs the approved version from an authenticated heartbeat', j(pj));
  const ev = await prisma.updateJobEvent.findFirst({ where: { jobId: pj.id, event: 'verified' } });
  check(ev?.detail?.registration === 'unavailable' && /not independently verified/.test(ev.detail.note ?? ''), 'unverifiable registration is recorded as such, not as verified', j(ev?.detail));
  check(pj.credentialSync === 'reported', 'credential sync recorded without the credential');

  // ─────────────────────────────────────────────────────────────────────
  section('Fleet batch: retry, then failure pauses the rollout');
  await tick();
  check((await prisma.updateRollout.findUnique({ where: { id: RID } })).currentBatch === 1, 'batch 1 released after the pilot succeeded');
  hb = await beat(F3);
  check(!hb.updateRustdesk, 'batch 2 still waits');
  hb = await beat(F1);
  const n1 = hb.updateRustdesk?.nonce;
  check(!!n1, 'F1 dispatched');
  await beat(F1, { rustdeskVersion: FROM, updateNonce: n1 });
  let f1 = await job(RID, F1.id);
  check(f1.status === 'REQUESTED' && f1.attempts === 1 && f1.nextAttemptAt > new Date() && /version_not_reached/.test(f1.failureReason), 'a short install schedules a retry with backoff', j(f1));
  hb = await beat(F1);
  check(!hb.updateRustdesk, 'no retry before the backoff expires');
  await prisma.updateJob.update({ where: { id: f1.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
  hb = await beat(F1);
  const n2 = hb.updateRustdesk?.nonce;
  check(!!n2 && n2 !== n1, 'retried with a fresh nonce');
  await beat(F1, { rustdeskVersion: FROM, updateNonce: n1 });
  check((await job(RID, F1.id)).status === 'DISPATCHED', 'an old nonce proves nothing about the new attempt');
  await beat(F1, { rustdeskVersion: FROM, updateNonce: n2 });
  f1 = await job(RID, F1.id);
  check(f1.status === 'FAILED' && f1.attempts === 2, 'attempts exhausted → FAILED', j(f1));
  let ro = await prisma.updateRollout.findUnique({ where: { id: RID } });
  check(ro.status === 'PAUSED' && /threshold/.test(ro.pausedReason ?? ''), 'reaching the failure threshold pauses the rollout', j(ro));
  hb = await beat(F2);
  check(!hb.updateRustdesk, 'nothing dispatches while paused');

  section('Newer than approved');
  r = await req('POST', `/admin/rollouts/${RID}/start`, { cookie: cAdmin });
  check(r.status === 200 && r.body.data.status === 'RUNNING', 'resumed');
  await prisma.updateRollout.update({ where: { id: RID }, data: { failureThreshold: 5 } });
  hb = await beat(F2);
  const n3 = hb.updateRustdesk?.nonce;
  await beat(F2, { rustdeskVersion: '1.4.2', updateNonce: n3 });
  const f2 = await job(RID, F2.id);
  check(f2.status === 'FAILED' && /installed_newer_than_approved/.test(f2.failureReason) && f2.attempts === 1, 'a newer install fails at once, without a retry loop', j(f2));

  section('Verify timeout');
  await tick();
  check((await prisma.updateRollout.findUnique({ where: { id: RID } })).currentBatch === 2, 'batch 2 released');
  hb = await beat(F3);
  check(!!hb.updateRustdesk, 'F3 dispatched');
  await prisma.updateJob.updateMany({ where: { rolloutId: RID, endpointId: F3.id }, data: { dispatchedAt: new Date(Date.now() - 2 * 3600_000) } });
  await prisma.rustdeskNode.update({ where: { endpointId: F3.id }, data: { lastSeenAt: new Date(Date.now() - 3 * 3600_000) } });
  await tick();
  const f3 = await job(RID, F3.id);
  check(f3.status === 'REQUESTED' && /no_heartbeat_after_dispatch/.test(f3.failureReason), 'a silent endpoint times out into a retry, with the reason', j(f3));

  section('Cancel');
  r = await req('POST', `/admin/rollouts/${RID}/cancel`, { cookie: cAdmin });
  check(r.status === 200 && r.body.data.status === 'CANCELED', 'canceled');
  check((await job(RID, F3.id)).status === 'CANCELED', 'pending jobs stop');
  hb = await beat(F3);
  check(!hb.updateRustdesk, 'nothing dispatches after cancel');

  section('Maintenance window');
  const now = new Date();
  const closedDay = (now.getUTCDay() + 3) % 7;
  r = await req('POST', '/admin/rollouts', { cookie: cAdmin, body: {
    name: `win-${sfx}`, component: 'RUSTDESK', targetVersion: TARGET, endpointIds: [F3.id], allowSignatureOnly: true,
    maintenanceWindow: { timeZone: 'UTC', windows: [{ days: [closedDay], start: '00:00', end: '23:59' }] },
  } });
  const WID = r.body?.data?.id; if (WID) created.rollouts.push(WID);
  await req('POST', `/admin/rollouts/${WID}/start`, { cookie: cAdmin });
  hb = await beat(F3);
  check(!hb.updateRustdesk && (await job(WID, F3.id)).deferReason === 'outside_maintenance_window', 'outside its window, an update waits', j(await job(WID, F3.id)));
  r = await req('POST', '/admin/rollouts', { cookie: cAdmin, body: { name: `bad-${sfx}`, component: 'RUSTDESK', targetVersion: TARGET, endpointIds: [F3.id], allowSignatureOnly: true, maintenanceWindow: { timeZone: 'Mars/Olympus', windows: [] } } });
  check(r.status === 400, 'an invalid window is refused', `${r.status}`);

  section('Unauthenticated heartbeat');
  const d = devices.get(F3.id);
  r = await req('POST', '/enrollment/heartbeat', { body: { rustdeskId: d.rd, agentSecret: randomBytes(24).toString('base64url'), platform: 'windows', rustdeskVersion: FROM } });
  check(!r.body?.data?.updateRustdesk, 'a heartbeat without the device secret is never handed an update', j(r.body));

  section('History');
  r = await req('GET', `/admin/rollouts/endpoints/${P1.id}/history`, { cookie: cAdmin });
  check(r.status === 200 && r.body.data.some((x) => x.status === 'SUCCEEDED' && x.events.some((e) => e.event === 'verified')), 'per-computer history shows the evidence trail');
} catch (e) {
  fail++; failures.push(String(e?.stack || e)); console.error(e);
} finally {
  if (originalPin !== undefined) await prisma.platformSettings.update({ where: { id: 'singleton' }, data: { rustdeskPinnedVersion: originalPin } }).catch(() => {});
  await cleanup().catch((e) => console.error('cleanup:', e));
  await prisma.$disconnect();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
