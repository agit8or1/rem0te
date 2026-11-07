#!/usr/bin/env node
/**
 * End-to-end proof of access review and offboarding (v0.20, F6), over HTTP
 * against a running API and a real Postgres.
 *
 * Covers: the per-computer access review lists who can connect and why, and
 * only to someone who can see that business's people; offboarding from one
 * business leaves the person's other business untouched; the account is
 * suspended only when that is the person's only access (or by a Platform
 * Admin); credentials obtained are reported from real records (refused
 * reveals excluded); shared passwords are flagged; rotation stays PENDING
 * until the computer acknowledges it, and an offline computer is called out;
 * a platform-level offboarding of a technician ends their signed-in sessions.
 *
 * It writes rows, so point it at a scratch stack — never production:
 *
 *   API_BASE=http://127.0.0.1:3101/api/v1 DATABASE_URL=… ENCRYPTION_KEY=… node scripts/e2e-offboarding.mjs
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

const API = process.env.API_BASE || 'http://127.0.0.1:3001/api/v1';
if (/:3001\b|:443\b|^https:/.test(API) && process.env.I_KNOW_THIS_IS_NOT_PRODUCTION !== '1') {
  console.error(`Refusing to run against ${API}: this suite writes fixtures. Use a scratch stack.`);
  process.exit(2);
}
const KEY = Buffer.from(process.env.ENCRYPTION_KEY || '', 'hex');
if (KEY.length !== 32) { console.error('ENCRYPTION_KEY (the API\'s) is needed to seed and read credentials'); process.exit(2); }

const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'test-password-123456';

let pass = 0, fail = 0;
const failures = [];
function check(cond, name, detail = '') {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; failures.push(`${name} — ${detail}`); console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${detail}`); }
}
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const pace = () => new Promise((r) => setTimeout(r, 60));
const j = (x) => JSON.stringify(x)?.slice(0, 400);

async function req(method, p, { body, cookie, headers = {} } = {}) {
  await pace();
  const r = await fetch(`${API}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed, setCookie: r.headers.get('set-cookie') || '' };
}
async function login(email) {
  await pace();
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }) });
  const m = (r.headers.get('set-cookie') || '').match(/access_token=([^;]+)/);
  if (!m) throw new Error(`login ${email} failed: ${r.status} ${await r.text()}`);
  return `access_token=${m[1]}`;
}
async function stepUp(cookie) {
  const r = await req('POST', '/auth/step-up', { cookie, body: { password: PW } });
  const m = r.setCookie.match(/step_up=([^;]+)/);
  if (r.status !== 200 || !m) throw new Error(`step-up failed: ${r.status} ${j(r.body)}`);
  return `${cookie}; step_up=${m[1]}`;
}
function enc(text) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', KEY, iv);
  const e = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return `${iv.toString('hex')}:${c.getAuthTag().toString('hex')}:${e.toString('hex')}`;
}
function dec(data) {
  const [iv, tag, e] = data.split(':').map((h) => Buffer.from(h, 'hex'));
  const d = createDecipheriv('aes-256-gcm', KEY, iv);
  d.setAuthTag(tag);
  return d.update(e).toString('utf8') + d.final('utf8');
}
const sha = (s) => createHash('sha256').update(s).digest('hex');

const created = { users: [], businesses: [], endpoints: [] };
async function makeUser(email, extra = {}) {
  const u = await prisma.user.create({
    data: { email, passwordHash: await argon2.hash(PW, { type: argon2.argon2id }), firstName: email.split('-')[1], lastName: 'Test', status: 'ACTIVE', ...extra },
  });
  created.users.push(u.id);
  return u;
}
async function member(user, tenantId, businessId, roleType, capabilities = []) {
  const role = await prisma.role.findFirst({ where: { tenantId, type: roleType } });
  return prisma.membership.create({ data: { userId: user.id, tenantId, customerId: businessId, roleId: role.id, capabilities, isActive: true } });
}
const secrets = new Map();
async function computer(tenantId, businessId, name, { online = true, password = randomBytes(8).toString('hex') } = {}) {
  const rd = String(100000000 + Math.floor(Math.random() * 800000000));
  const secret = randomBytes(24).toString('hex');
  const ep = await prisma.endpoint.create({
    data: {
      tenantId, customerId: businessId, name: `${name}-${sfx}`, hostname: `${name}-${sfx}`, status: 'ACTIVE',
      isOnline: online, isManaged: true, accessMode: 'ASSIGNED_USERS',
      rustdeskNode: { create: { tenantId, rustdeskId: rd, agentSecretHash: sha(secret), permanentPassword: enc(password) } },
    },
  });
  created.endpoints.push(ep.id);
  secrets.set(ep.id, { rd, secret });
  return ep;
}

async function cleanup() {
  await prisma.offboardingCase.deleteMany({ where: { subjectUserId: { in: created.users } } });
  await prisma.technicianGroupMember.deleteMany({ where: { userId: { in: created.users } } });
  await prisma.technicianAssignment.deleteMany({ where: { OR: [{ customerId: { in: created.businesses } }, { userId: { in: created.users } }] } });
  await prisma.computerAccess.deleteMany({ where: { endpointId: { in: created.endpoints } } });
  await prisma.connectionGrant.deleteMany({ where: { userId: { in: created.users } } });
  await prisma.launcherToken.deleteMany({ where: { userId: { in: created.users } } });
  await prisma.rustdeskNode.deleteMany({ where: { endpointId: { in: created.endpoints } } });
  await prisma.activityLog.deleteMany({ where: { OR: [{ actorId: { in: created.users } }, { resourceId: { in: [...created.endpoints, ...created.users] } }] } });
  await prisma.activityLog.updateMany({ where: { customerId: { in: created.businesses } }, data: { customerId: null } });
  await prisma.endpoint.deleteMany({ where: { id: { in: created.endpoints } } });
  await prisma.membership.deleteMany({ where: { userId: { in: created.users } } });
  await prisma.customer.deleteMany({ where: { id: { in: created.businesses } } });
  await prisma.user.deleteMany({ where: { id: { in: created.users } } });
}

try {
  const tenant = await prisma.tenant.findFirst({ where: { isActive: true }, orderBy: { createdAt: 'asc' } });
  const T = tenant.id;
  const bizA = await prisma.customer.create({ data: { tenantId: T, name: `Offb A ${sfx}`, isActive: true } });
  const bizB = await prisma.customer.create({ data: { tenantId: T, name: `Offb B ${sfx}`, isActive: true } });
  created.businesses.push(bizA.id, bizB.id);

  const admin = await makeUser(`ob-adam-${sfx}@test.invalid`, { isPlatformAdmin: true });
  const ownerA = await makeUser(`ob-olga-${sfx}@test.invalid`);
  const ownerB = await makeUser(`ob-otto-${sfx}@test.invalid`);
  const uma = await makeUser(`ob-uma-${sfx}@test.invalid`);      // member of A, technician in B
  const solo = await makeUser(`ob-sam-${sfx}@test.invalid`);     // member of A only
  const plain = await makeUser(`ob-pia-${sfx}@test.invalid`);    // A member without users:view
  const tech = await makeUser(`ob-ted-${sfx}@test.invalid`);     // MSP technician, no memberships
  await member(ownerA, T, bizA.id, 'BUSINESS_OWNER');
  await member(ownerB, T, bizB.id, 'BUSINESS_OWNER');
  await member(uma, T, bizA.id, 'BUSINESS_USER', ['computers:view', 'computers:connect']);
  await prisma.technicianAssignment.create({ data: { tenantId: T, customerId: bizB.id, userId: uma.id, capabilities: ['computers:view', 'computers:connect'], reason: 'e2e' } });
  await member(solo, T, bizA.id, 'BUSINESS_USER', ['computers:view', 'computers:connect']);
  await member(plain, T, bizA.id, 'BUSINESS_USER', ['computers:view', 'computers:connect']);
  await prisma.technicianAssignment.create({ data: { tenantId: T, customerId: bizA.id, userId: tech.id, capabilities: ['computers:view', 'computers:connect'], reason: 'e2e' } });
  await prisma.technicianAssignment.create({ data: { tenantId: T, customerId: bizB.id, userId: tech.id, capabilities: ['computers:view', 'computers:connect'], reason: 'e2e' } });

  const shared = 'shared-' + randomBytes(6).toString('hex');
  const ep1 = await computer(T, bizA.id, 'ob-pc1', { password: shared });          // revealed by uma, online
  const ep2 = await computer(T, bizA.id, 'ob-pc2', { online: false });             // connected via grant, offline
  const ep3 = await computer(T, bizA.id, 'ob-pc3');                                // reveal REFUSED
  const ep4 = await computer(T, bizA.id, 'ob-pc4', { password: shared });          // same password as ep1, never touched
  const epB = await computer(T, bizB.id, 'ob-pcb');                                // uma revealed it in B
  for (const ep of [ep1, ep2, ep3]) await prisma.computerAccess.create({ data: { tenantId: T, userId: uma.id, endpointId: ep.id } });
  const temp = new Date(Date.now() + 3 * 864e5);
  await prisma.computerAccess.create({ data: { tenantId: T, userId: solo.id, endpointId: ep1.id, expiresAt: temp } });

  const ago = (m) => new Date(Date.now() - m * 60_000);
  await prisma.activityLog.create({ data: { tenantId: T, customerId: bizA.id, actorId: uma.id, action: 'ENDPOINT_PASSWORD_REVEALED', resource: 'endpoint', resourceId: ep1.id, createdAt: ago(30) } });
  await prisma.activityLog.create({ data: { tenantId: T, customerId: bizA.id, actorId: uma.id, action: 'ENDPOINT_PASSWORD_REVEALED', resource: 'endpoint', resourceId: ep3.id, metadata: { denied: 'no access' }, createdAt: ago(20) } });
  await prisma.activityLog.create({ data: { tenantId: T, customerId: bizB.id, actorId: uma.id, action: 'ENDPOINT_PASSWORD_REVEALED', resource: 'endpoint', resourceId: epB.id, createdAt: ago(10) } });
  await prisma.connectionGrant.create({ data: { tokenHash: sha(randomBytes(16).toString('hex')), tenantId: T, userId: uma.id, endpointId: ep2.id, expiresAt: ago(-1), usedAt: ago(15) } });
  const liveGrant = await prisma.connectionGrant.create({ data: { tokenHash: sha(randomBytes(16).toString('hex')), tenantId: T, userId: uma.id, endpointId: ep1.id, expiresAt: ago(-2) } });
  const liveTokA = await prisma.launcherToken.create({ data: { tenantId: T, userId: uma.id, token: randomBytes(24).toString('hex'), expiresAt: ago(-2), targetEndpointId: ep1.id } });
  const liveTokB = await prisma.launcherToken.create({ data: { tenantId: T, userId: uma.id, token: randomBytes(24).toString('hex'), expiresAt: ago(-2), targetEndpointId: epB.id } });

  const cOwnerA = await login(ownerA.email);
  const cOwnerB = await login(ownerB.email);
  const cPlain = await login(plain.email);
  const cAdmin = await login(admin.email);

  // ─────────────────────────────────────────────────────────────────────────
  section('Access review');
  let r = await req('GET', `/endpoints/${ep1.id}/access-review`, { cookie: cOwnerA });
  check(r.status === 200, 'owner of A can review a computer in A', `${r.status} ${j(r.body)}`);
  const entries = r.body?.data?.entries ?? [];
  const by = (uid, via) => entries.find((e) => e.userId === uid && (!via || e.via === via));
  check(!!by(ownerA.id, 'BUSINESS_OWNER')?.activeNow, 'lists the Business Owner');
  check(!!by(uma.id, 'COMPUTER_GRANT')?.activeNow, 'lists a direct grant as active');
  const s = by(solo.id, 'COMPUTER_GRANT');
  check(s?.temporary === true && s?.expiresAt === temp.toISOString(), 'a temporary grant shows its expiry', j(s));
  check(!!by(tech.id, 'TECHNICIAN_DIRECT')?.activeNow, 'lists an assigned MSP technician');
  check(!by(plain.id), 'a member with no grant on an assigned-users computer is not listed');
  check(!by(ownerB.id), 'the owner of another business is not listed');
  check(/does not change a RustDesk password/.test(r.body?.data?.note ?? ''), 'states that removal does not change a seen password');
  r = await req('GET', `/endpoints/${ep1.id}/access-review`, { cookie: cOwnerB });
  check(r.status === 404 || r.status === 403, 'owner of B cannot review a computer in A', `${r.status}`);
  r = await req('GET', `/endpoints/${ep1.id}/access-review`, { cookie: cPlain });
  check(r.status === 403, 'a member without users:view cannot review', `${r.status}`);

  // ─────────────────────────────────────────────────────────────────────────
  section('Offboarding preview');
  r = await req('GET', `/offboarding/preview?userId=${uma.id}&businessId=${bizA.id}`, { cookie: cOwnerA });
  check(r.status === 200, 'owner of A can preview offboarding Uma from A', `${r.status} ${j(r.body)}`);
  const pv = r.body?.data ?? {};
  const got = new Set((pv.credentialsObtained ?? []).map((c) => c.endpointId));
  check(got.has(ep1.id) && got.has(ep2.id), 'reports the revealed and the connected computers', j([...got]));
  check(!got.has(ep3.id), 'a refused reveal is not reported as obtained');
  check(!got.has(epB.id), 'a credential from business B is not in business A\'s list');
  check(pv.canSuspendAccount === false && /other businesses/.test(pv.suspendBlockedReason ?? ''), 'owner cannot suspend an account that also belongs to B', j(pv.suspendBlockedReason));
  const grp = (pv.sharedPasswords ?? []).find((g) => g.computers.some((c) => c.endpointId === ep1.id));
  check(!!grp && grp.computers.some((c) => c.endpointId === ep4.id), 'flags another computer that shares the revealed password', j(pv.sharedPasswords));
  check(pv.willRevoke?.computerGrants === 3 && pv.willRevoke?.unredeemedConnectionGrants === 1, 'counts the grants that will be revoked', j(pv.willRevoke));
  check((pv.limits ?? []).some((l) => /does not change any RustDesk password/.test(l)) && (pv.limits ?? []).some((l) => /session that is already open/.test(l)), 'limits are stated plainly');
  r = await req('GET', `/offboarding/preview?userId=${uma.id}&businessId=${bizA.id}`, { cookie: cOwnerB });
  check(r.status === 403 || r.status === 404, 'owner of B cannot preview offboarding from A', `${r.status}`);
  r = await req('GET', `/offboarding/preview?userId=${ownerB.id}&businessId=${bizA.id}`, { cookie: cOwnerA });
  check(r.status === 404, 'owner of A cannot offboard someone with no access to A', `${r.status}`);
  r = await req('GET', `/offboarding/preview?userId=${uma.id}&businessId=${bizA.id}`, { cookie: cPlain });
  check(r.status === 403, 'a business user cannot offboard', `${r.status}`);
  r = await req('GET', `/offboarding/preview?userId=${tech.id}`, { cookie: cOwnerA });
  check(r.status === 403, 'a business owner cannot run a platform-wide offboarding', `${r.status}`);

  // ─────────────────────────────────────────────────────────────────────────
  section('Offboarding from one business');
  const body = { userId: uma.id, businessId: bizA.id, rotateEndpointIds: [ep1.id, ep2.id], notes: 'left the company' };
  r = await req('POST', '/offboarding', { cookie: cOwnerA, body });
  check(r.status === 403 && r.body?.code === 'STEP_UP_REQUIRED', 'requires step-up', `${r.status} ${j(r.body)}`);
  check(await prisma.membership.count({ where: { userId: uma.id, customerId: bizA.id, isActive: true } }) === 1, 'nothing changed without step-up');
  const cOwnerAUp = await stepUp(cOwnerA);
  r = await req('POST', '/offboarding', { cookie: cOwnerAUp, body: { ...body, suspendAccount: true } });
  check(r.status === 403, 'refuses to suspend an account with other access', `${r.status} ${j(r.body)}`);
  check(await prisma.membership.count({ where: { userId: uma.id, customerId: bizA.id, isActive: true } }) === 1, 'a refused suspension changes nothing');
  r = await req('POST', '/offboarding', { cookie: cOwnerAUp, body: { ...body, rotateEndpointIds: [ep3.id] } });
  check(r.status === 400, 'refuses to rotate a computer the person never had', `${r.status}`);
  r = await req('POST', '/offboarding', { cookie: cOwnerAUp, body: { ...body, rotateEndpointIds: [epB.id] } });
  check(r.status === 400, 'refuses to rotate a computer in another business', `${r.status}`);

  r = await req('POST', '/offboarding', { cookie: cOwnerAUp, body });
  check(r.status === 200, 'offboards Uma from A', `${r.status} ${j(r.body)}`);
  const kase = r.body?.data ?? {};
  const step = (k) => (kase.steps ?? []).find((x) => x.key === k);
  check(step('membership')?.state === 'done', 'membership step done');
  check(step('account')?.state === 'skipped', 'account left active');
  check(step('rotation')?.state === 'pending', 'rotation is PENDING, not done', j(step('rotation')));
  check(!kase.completedAt, 'the case is not complete while rotations are pending');
  const rot = (id) => (kase.rotations ?? []).find((x) => x.endpointId === id);
  check(rot(ep1.id)?.state === 'pending' && rot(ep1.id)?.online === true, 'online computer pending its check-in', j(rot(ep1.id)));
  check(rot(ep2.id)?.state === 'pending' && /offline/.test(rot(ep2.id)?.note ?? ''), 'offline computer is called out', j(rot(ep2.id)));

  const memA = await prisma.membership.findFirst({ where: { userId: uma.id, customerId: bizA.id } });
  check(memA.isActive === false, 'A membership disabled');
  check(await prisma.technicianAssignment.count({ where: { userId: uma.id, customerId: bizB.id, revokedAt: null } }) === 1, 'technician assignment into B untouched');
  check((await prisma.user.findUnique({ where: { id: uma.id } })).status === 'ACTIVE', 'account still active');
  check(await prisma.computerAccess.count({ where: { userId: uma.id, endpoint: { customerId: bizA.id } } }) === 0, 'grants in A removed');
  check((await prisma.launcherToken.findUnique({ where: { id: liveTokA.id } })).revokedAt !== null, 'unredeemed launcher token for A revoked');
  check((await prisma.launcherToken.findUnique({ where: { id: liveTokB.id } })).revokedAt === null, 'launcher token for B left alone');
  check((await prisma.connectionGrant.findUnique({ where: { id: liveGrant.id } })).expiresAt <= new Date(), 'unredeemed connection grant expired');
  const n1 = await prisma.rustdeskNode.findUnique({ where: { endpointId: ep1.id } });
  check(!!n1.pendingPassword && dec(n1.permanentPassword) === shared, 'old password still in force until acknowledged');
  check(!!(await prisma.activityLog.findFirst({ where: { action: 'OFFBOARDING_STARTED', resourceId: uma.id } })), 'audited OFFBOARDING_STARTED');

  r = await req('GET', '/offboarding/pending-rotations', { cookie: cOwnerA });
  check(r.status === 200 && r.body.data.some((x) => x.endpointId === ep1.id) && r.body.data.some((x) => x.endpointId === ep2.id), 'pending rotations listed', `${r.status} ${j(r.body)}`);

  section('Rotation acknowledged by the computer');
  const { rd, secret } = secrets.get(ep1.id);
  r = await req('POST', '/enrollment/confirm-rotation', { body: { rustdeskId: rd, sha256: sha(dec(n1.pendingPassword)), agentSecret: secret } });
  check(r.status === 200 && r.body?.data?.confirmed === true, 'computer confirms', `${r.status} ${j(r.body)}`);
  r = await req('GET', `/offboarding/${kase.id}`, { cookie: cOwnerA });
  const after = r.body?.data ?? {};
  const a1 = after.rotations?.find((x) => x.endpointId === ep1.id);
  const a2 = after.rotations?.find((x) => x.endpointId === ep2.id);
  check(a1?.state === 'confirmed' && !!a1?.confirmedAt, 'ep1 now confirmed', j(a1));
  check(a2?.state === 'pending', 'ep2 (offline) still pending', j(a2));
  check(after.steps?.find((x) => x.key === 'rotation')?.state === 'pending' && !after.completedAt, 'case still open while one rotation is pending');
  check(dec((await prisma.rustdeskNode.findUnique({ where: { endpointId: ep1.id } })).permanentPassword) !== shared, 'ep1 password actually changed');

  r = await req('GET', `/offboarding/${kase.id}`, { cookie: cOwnerB });
  check(r.status === 404, 'owner of B cannot read A\'s offboarding case', `${r.status}`);
  r = await req('GET', '/offboarding', { cookie: cOwnerB });
  check(r.status === 200 && !r.body.data.some((x) => x.id === kase.id), 'owner of B does not see A\'s case in the list');
  r = await req('GET', '/offboarding', { cookie: cOwnerA });
  check(r.status === 200 && r.body.data.some((x) => x.id === kase.id && x.rotation.confirmed === 1 && x.rotation.offlinePending === 1), 'owner of A sees the case with live rotation counts', j(r.body?.data));

  // ─────────────────────────────────────────────────────────────────────────
  section('Only access → owner may suspend');
  r = await req('GET', `/offboarding/preview?userId=${solo.id}&businessId=${bizA.id}`, { cookie: cOwnerA });
  check(r.body?.data?.canSuspendAccount === true, 'account with only this business may be suspended by its owner', j(r.body?.data?.suspendBlockedReason));
  const cSolo = await login(solo.email);
  r = await req('POST', '/offboarding', { cookie: cOwnerAUp, body: { userId: solo.id, businessId: bizA.id, suspendAccount: true } });
  check(r.status === 200 && r.body.data.steps.find((x) => x.key === 'account').state === 'done', 'suspends', `${r.status} ${j(r.body)}`);
  r = await req('GET', '/auth/me', { cookie: cSolo });
  check(r.status === 401, 'the suspended person\'s existing session no longer works', `${r.status}`);

  // ─────────────────────────────────────────────────────────────────────────
  section('Platform-level offboarding of a technician');
  const cTech = await login(tech.email);
  r = await req('GET', `/offboarding/preview?userId=${tech.id}`, { cookie: cAdmin });
  check(r.status === 200 && r.body.data.scope === 'platform' && r.body.data.willRevoke.technicianAssignments === 2, 'admin preview counts both assignments', `${r.status} ${j(r.body?.data?.willRevoke)}`);
  const cAdminUp = await stepUp(cAdmin);
  r = await req('POST', '/offboarding', { cookie: cAdminUp, body: { userId: tech.id, suspendAccount: true } });
  check(r.status === 200, 'admin offboards the technician everywhere', `${r.status} ${j(r.body)}`);
  check(await prisma.technicianAssignment.count({ where: { userId: tech.id, revokedAt: null } }) === 0, 'every assignment revoked');
  r = await req('GET', '/auth/me', { cookie: cTech });
  check(r.status === 401, 'technician signed out everywhere', `${r.status}`);
  r = await req('GET', `/endpoints/${ep1.id}/access-review`, { cookie: cOwnerA });
  const techRows = (r.body?.data?.entries ?? []).filter((e) => e.userId === tech.id);
  check(techRows.every((e) => !e.activeNow), 'technician no longer active in the access review', j(techRows));

  r = await req('POST', '/offboarding', { cookie: cOwnerAUp, body: { userId: ownerA.id, businessId: bizA.id } });
  check(r.status === 403, 'nobody can offboard themselves', `${r.status}`);
} catch (e) {
  fail++; failures.push(String(e?.stack || e)); console.error(e);
} finally {
  await cleanup().catch((e) => console.error('cleanup:', e));
  await prisma.$disconnect();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
