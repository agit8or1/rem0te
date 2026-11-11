#!/usr/bin/env node
/**
 * End-to-end proof (0.30.1) for credential release, enrolment and audit
 * behaviour:
 *
 *   - Connect never returns a computer's permanent password; a launch that
 *     would release it (launcher grant or Connect script) needs a fresh
 *     step-up, and the release is audited as a reveal.
 *   - A reveal is refused when its audit entry cannot be written.
 *   - An audit entry's content cannot be changed, sealed or not.
 *   - Adopting a computer from the pending pool applies the claim token's
 *     business, group, access mode, assigned users, password and hostname.
 *   - Claim tokens: 24 h lifetime, single use, refused once expired.
 *   - Connection grants: 90 s lifetime, single use, refused once expired.
 *   - Step-up needs the authenticator when one is enrolled, and a session's
 *     mfaVerified reflects the sign-in that minted it.
 *
 * Self-contained: starts dist/main.js on a scratch port against a scratch
 * database and removes its fixtures (audit rows it wrote stay — they are
 * insert-only; on a scratch database that is expected).
 *
 *   cd apps/api && npx nest build
 *   DATABASE_URL=postgresql://…/reboot_remote_it_scratch node scripts/e2e-credentials.mjs
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { authenticator } from 'otplib';
import { spawn } from 'node:child_process';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const DB = process.env.DATABASE_URL ?? '';
const dbName = DB.split('/').pop()?.split('?')[0] ?? '';
if (!/scratch|test/.test(dbName)) {
  console.error(`Refusing to run against database "${dbName}": name must contain "scratch" or "test".`);
  process.exit(2);
}
const PORT = Number(process.env.CREDENTIALS_API_PORT ?? 3161);
const API = `http://127.0.0.1:${PORT}/api/v1`;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'credentials-e2e-password-123';

let pass = 0, fail = 0; const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;

const ENC = randomBytes(32);
const env = {
  ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATABASE_URL: DB,
  JWT_SECRET: randomBytes(32).toString('hex'), LAUNCHER_TOKEN_SECRET: randomBytes(32).toString('hex'),
  ENCRYPTION_KEY: ENC.toString('hex'), TRUSTED_PROXIES: 'loopback', MONITOR_SWEEP: 'off',
  VERSION_FILE: path.resolve(here, '..', '..', '..', 'version.json'),
};
delete env.INTEGRATION_PEERS_FILE; delete env.UPDATE_REPO_DIR;
let api;
function startApi() {
  api = spawn(process.execPath, [path.join(dist, 'main.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  api.log = ''; api.stdout.on('data', (d) => { api.log += d; }); api.stderr.on('data', (d) => { api.log += d; });
}
async function waitUp() {
  for (let i = 0; i < 120; i++) { try { const r = await fetch(`${API}/health`); if (r.status < 500) return; } catch { /* not yet */ } await sleep(300); }
  throw new Error(`API did not come up:\n${api.log.slice(-3000)}`);
}
async function req(method, p, { s, body, business } = {}) {
  const h = { 'content-type': 'application/json', 'x-forwarded-for': s?.ip ?? ip() };
  if (s) h.cookie = s.cookie + (s.stepUp ? `; step_up=${s.stepUp}` : '');
  if (business) h['x-rem0te-business'] = business;
  const r = await fetch(`${API}${p}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j, text, setCookie: r.headers.get('set-cookie') ?? '' };
}
async function login(email) {
  const s = { ip: ip() };
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': s.ip }, body: JSON.stringify({ email, password: PW }) });
  const m = (r.headers.get('set-cookie') ?? '').match(/access_token=([^;]+)/);
  if (r.status !== 200 || !m) throw new Error(`login ${email}: ${r.status}`);
  s.cookie = `access_token=${m[1]}`;
  return s;
}
async function stepUp(s, body = { password: PW }) {
  const r = await req('POST', '/auth/step-up', { s, body });
  const m = r.setCookie.match(/step_up=([^;]+)/);
  return { r, s: m ? { ...s, stepUp: m[1] } : null };
}
const jwtClaims = (s) => JSON.parse(Buffer.from(s.cookie.split('=')[1].split('.')[1], 'base64url').toString('utf8'));
const code = (r) => r.body?.code ?? r.body?.message?.code ?? r.body?.error?.code;
const msg = (r) => `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 240)}`;
const encrypt = (text) => {
  const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', ENC, iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return `${iv.toString('hex')}:${c.getAuthTag().toString('hex')}:${enc.toString('hex')}`;
};
// The Connect script carries the password base64-encoded; look for either form.
const FD_PW = 'frontdesk-permanent-pw';
const leaks = (text) => text.includes(FD_PW) || text.includes(Buffer.from(FD_PW).toString('base64'));
const rid = () => String(100000000 + ((Math.random() * 899999999) | 0));
const secret = () => randomBytes(32).toString('base64url');

const created = { businesses: [], users: [], groups: [], rustdeskIds: [] };
const TRIGGER = `e2e_cred_refuse_reveal_${sfx}`;

async function main() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  const roleUser = await prisma.role.findFirst({ where: { type: 'BUSINESS_USER' } });
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });

  section('Fixtures (synthetic)');
  const acme = await prisma.customer.create({ data: { tenantId: tenant.id, name: `CR Acme ${sfx}` } });
  created.businesses.push(acme.id);
  const group = await prisma.endpointGroup.create({ data: { tenantId: tenant.id, name: `CR Front office ${sfx}` } });
  created.groups.push(group.id);
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag, extra = {}) => { const u = await prisma.user.create({ data: { email: `cr-${tag}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'CR', lastName: tag, status: 'ACTIVE', ...extra } }); created.users.push(u.id); return u; };
  const admin = await mkUser('admin', { isPlatformAdmin: true });
  const owner = await mkUser('owner');
  const tina = await mkUser('tina');
  const pat = await mkUser('pat');
  await prisma.membership.create({ data: { userId: owner.id, tenantId: tenant.id, customerId: acme.id, roleId: roleOwner.id, capabilities: [] } });
  await prisma.membership.create({ data: { userId: tina.id, tenantId: tenant.id, customerId: acme.id, roleId: roleOwner.id, capabilities: [] } });
  await prisma.membership.create({ data: { userId: pat.id, tenantId: tenant.id, customerId: acme.id, roleId: roleUser.id, capabilities: ['computers:view', 'computers:connect'] } });
  const pc = await prisma.endpoint.create({ data: { tenantId: tenant.id, customerId: acme.id, name: 'FRONTDESK', hostname: 'FRONTDESK', status: 'ACTIVE', isOnline: true, isManaged: true, accessMode: 'ASSIGNED_USERS', lastSeenAt: new Date(), deviceClass: 'WORKSTATION' } });
  const pcRid = rid(); created.rustdeskIds.push(pcRid);
  await prisma.rustdeskNode.create({ data: { tenantId: tenant.id, endpointId: pc.id, rustdeskId: pcRid, permanentPassword: encrypt('frontdesk-permanent-pw'), agentSecretHash: createHash('sha256').update(randomBytes(16)).digest('hex') } });
  await prisma.computerAccess.create({ data: { tenantId: tenant.id, endpointId: pc.id, userId: pat.id, grantedBy: owner.id } });
  check(true, 'Acme with FRONTDESK (Pat assigned), a group, an owner, a second owner (Tina) and a platform admin');

  startApi(); await waitUp();
  const S = { admin: await login(admin.email), owner: await login(owner.email), pat: await login(pat.email), tina: await login(tina.email) };

  section('Connect never returns the permanent password');
  {
    const bare = await req('POST', `/endpoints/${pc.id}/connect`, { s: S.pat });
    check(bare.status === 403 && code(bare) === 'STEP_UP_REQUIRED', 'POST /connect for a launch that carries the password, without step-up → 403 STEP_UP_REQUIRED', msg(bare));
    const cmd0 = await req('GET', `/endpoints/${pc.id}/connect.cmd`, { s: S.pat });
    check(cmd0.status === 403 && code(cmd0) === 'STEP_UP_REQUIRED' && !leaks(cmd0.text), 'GET /connect.cmd without step-up → 403 STEP_UP_REQUIRED, and the password is nowhere in the response', msg(cmd0));
    const { s: patUp } = await stepUp(S.pat);
    const c = await req('POST', `/endpoints/${pc.id}/connect`, { s: patUp });
    check(c.status === 200 && !leaks(c.text) && !('password' in (c.body.data ?? {})) && c.body.data?.hasPassword === true,
      'with step-up: 200 — hasPassword, a grant, and the password neither as a field nor anywhere in the body', msg(c));
    const g = await prisma.connectionGrant.findFirst({ where: { userId: pat.id }, orderBy: { createdAt: 'desc' } });
    const life = g ? g.expiresAt.getTime() - g.createdAt.getTime() : -1;
    check(life > 85_000 && life <= 91_000, `the grant lives 90 seconds (${Math.round(life / 1000)} s)`);
    const red1 = await req('POST', '/endpoints/grants/redeem', { body: { token: c.body.data.grantToken } });
    check(red1.status === 200 && red1.body.data?.password === 'frontdesk-permanent-pw', 'the launcher redeems it once and receives the password', msg(red1));
    const red2 = await req('POST', '/endpoints/grants/redeem', { body: { token: c.body.data.grantToken } });
    check(red2.status === 404 && !leaks(red2.text), 'a replayed grant → 404, no password', msg(red2));

    const c2 = await req('POST', `/endpoints/${pc.id}/connect`, { s: patUp });
    await prisma.connectionGrant.updateMany({ where: { userId: pat.id, usedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const before = new Date();
    const red3 = await req('POST', '/endpoints/grants/redeem', { body: { token: c2.body.data.grantToken } });
    check(red3.status === 404 && /expired/i.test(JSON.stringify(red3.body)) && !leaks(red3.text), 'an expired grant → 404 "Grant expired", no password', msg(red3));
    const revAfterExpired = await prisma.activityLog.count({ where: { actorId: pat.id, action: 'ENDPOINT_PASSWORD_REVEALED', createdAt: { gte: before } } });
    check(revAfterExpired === 0, '…and no reveal is recorded for it');

    const cmd1 = await req('GET', `/endpoints/${pc.id}/connect.cmd`, { s: patUp });
    if (cmd1.status === 200) check(leaks(cmd1.text), '…and the script it returns carries the password (base64-encoded)');
    const viaScript = await prisma.activityLog.findFirst({ where: { actorId: pat.id, action: 'ENDPOINT_PASSWORD_REVEALED', resourceId: pc.id, createdAt: { gte: before } }, orderBy: { createdAt: 'desc' } });
    check(cmd1.status !== 403 && viaScript?.metadata?.via === 'connect_script', `with step-up the Connect script passes the gate (HTTP ${cmd1.status}${cmd1.status === 503 ? ': no relay host on this stack' : ''}) and is audited as a reveal (via connect_script)`, JSON.stringify(viaScript?.metadata));
  }

  section('A reveal is refused when its audit entry cannot be written');
  {
    // A scratch-only trigger that refuses exactly this action's audit insert.
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION ${TRIGGER}() RETURNS trigger AS $$ BEGIN IF NEW."action" = 'ENDPOINT_PASSWORD_REVEALED' THEN RAISE EXCEPTION 'e2e: audit unavailable'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER ${TRIGGER} BEFORE INSERT ON "ActivityLog" FOR EACH ROW EXECUTE FUNCTION ${TRIGGER}()`);
    try {
      const { s: ownerUp } = await stepUp(S.owner);
      const r = await req('GET', `/endpoints/${pc.id}/password`, { s: ownerUp });
      check(r.status === 503 && code(r) === 'AUDIT_UNAVAILABLE' && !leaks(r.text), 'GET /password → 503 AUDIT_UNAVAILABLE, no password', msg(r));
      const { s: patUp } = await stepUp(S.pat);
      const c = await req('POST', `/endpoints/${pc.id}/connect`, { s: patUp });
      const red = await req('POST', '/endpoints/grants/redeem', { body: { token: c.body.data?.grantToken ?? '0'.repeat(64) } });
      check(red.status === 503 && !leaks(red.text), 'redeeming a grant → 503, no password', msg(red));
      const cmd = await req('GET', `/endpoints/${pc.id}/connect.cmd`, { s: patUp });
      check(cmd.status === 503 && code(cmd) === 'AUDIT_UNAVAILABLE' && !leaks(cmd.text), 'the Connect script → 503 AUDIT_UNAVAILABLE, no password', msg(cmd));
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${TRIGGER} ON "ActivityLog"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${TRIGGER}()`);
    }
    const { s: ownerUp } = await stepUp(S.owner);
    const ok = await req('GET', `/endpoints/${pc.id}/password`, { s: ownerUp });
    check(ok.status === 200 && ok.body.data?.password === 'frontdesk-permanent-pw', 'with the audit log writable again, the same reveal succeeds', msg(ok));
  }

  section('Audit entries are insert-only');
  {
    const row = await prisma.activityLog.create({ data: { action: 'USER_UPDATED', tenantId: tenant.id, customerId: acme.id, resource: 'e2e', resourceId: sfx, metadata: { original: true } } });
    const edit = await prisma.activityLog.update({ where: { id: row.id }, data: { metadata: { original: false } } }).then(() => 'changed', (e) => e.message);
    check(/cannot be changed/.test(edit), 'an entry the sealer has not reached yet cannot be rewritten', edit);
    const act = await prisma.activityLog.update({ where: { id: row.id }, data: { action: 'LOGIN_SUCCESS' } }).then(() => 'changed', (e) => e.message);
    check(/cannot be changed/.test(act), '…nor its action', act);
    const nulled = await prisma.activityLog.update({ where: { id: row.id }, data: { customerId: null } }).then(() => 'ok', (e) => e.message);
    check(nulled === 'ok', 'setting its business to NULL (what deleting a business does) is still allowed', nulled);
    const repoint = await prisma.activityLog.update({ where: { id: row.id }, data: { customerId: acme.id } }).then(() => 'changed', (e) => e.message);
    check(/cannot be changed/.test(repoint), 'pointing it at a business is not', repoint);
    let sealed = null;
    // The refused inserts above used up sequence numbers; the sealer waits
    // its 30 s grace before declaring that gap, then seals past it.
    for (let i = 0; i < 150 && !sealed?.chainHash; i++) { await sleep(500); sealed = await prisma.activityLog.findUnique({ where: { id: row.id } }); }
    check(!!sealed?.chainHash, 'the sealer still seals it (setting the seal columns once is allowed)');
    const after = await prisma.activityLog.update({ where: { id: row.id }, data: { metadata: { original: false } } }).then(() => 'changed', (e) => e.message);
    check(/cannot be changed/.test(after), 'and once sealed it still cannot be rewritten', after);
  }

  section('Adopting a computer from the pending pool');
  {
    const poolRid = rid(); created.rustdeskIds.push(poolRid);
    const poolSecret = secret();
    const hb = await req('POST', '/enrollment/heartbeat', { body: { rustdeskId: poolRid, agentSecret: poolSecret, hostname: 'desktop-8f3k2', platform: 'Windows' } });
    const pooled = await prisma.rustdeskNode.findUnique({ where: { rustdeskId: poolRid }, include: { endpoint: true } });
    check(hb.status < 300 && pooled && pooled.tenantId === null && pooled.endpoint.customerId === null, 'an unknown computer heartbeats into the pending pool (no tenant, no business)', msg(hb));
    const t = await req('POST', '/enrollment/tokens', { s: (await stepUp(S.admin)).s, body: { businessId: acme.id, accessMode: 'ASSIGNED_USERS', assignedUserIds: [pat.id], endpointGroupId: group.id } });
    const token = t.body.data?.token;
    check(t.status < 300 && !!token, 'a claim token for Acme: assigned users (Pat), the front-office group', msg(t));
    const cl = await req('POST', '/enrollment/claim', { body: { token, rustdeskId: poolRid, agentSecret: poolSecret, hostname: 'RECEPTION-2', platform: 'Windows', password: 'reception-2-permanent-pw' } });
    check(cl.status < 300, 'the installer claims the pooled computer with that token', msg(cl));
    const ep = await prisma.endpoint.findUnique({ where: { id: pooled.endpointId }, include: { rustdeskNode: true, groupMemberships: true } });
    check(ep.customerId === acme.id && ep.tenantId === tenant.id, 'it is now in Acme (not just the tenant)', JSON.stringify({ customerId: ep.customerId, tenantId: ep.tenantId }));
    const gs = ep.groupMemberships.map((m) => m.endpointGroupId);
    check(gs.length === 1 && gs[0] === group.id && ep.accessMode === 'ASSIGNED_USERS' && ep.status === 'ACTIVE', 'with the token\'s group (a membership, 0.34) and access mode, and ACTIVE', JSON.stringify({ g: gs, m: ep.accessMode, s: ep.status }));
    check(ep.hostname === 'RECEPTION-2' && ep.name === 'RECEPTION-2' && ep.rustdeskNode?.tenantId === tenant.id, 'named and hostnamed from the claim; the node joined the tenant', JSON.stringify({ n: ep.name, h: ep.hostname }));
    const access = await prisma.computerAccess.findMany({ where: { endpointId: ep.id } });
    check(access.length === 1 && access[0].userId === pat.id, 'Pat is assigned to it, as the token said');
    const dupes = await prisma.rustdeskNode.count({ where: { rustdeskId: poolRid } });
    check(dupes === 1, 'adopted in place — one node, no duplicate');
    const { s: ownerUp } = await stepUp(S.owner);
    const pw = await req('GET', `/endpoints/${ep.id}/password`, { s: ownerUp });
    check(pw.status === 200 && pw.body.data?.password === 'reception-2-permanent-pw', 'its password is the one the claim reported', msg(pw));
    const audit = await prisma.activityLog.findFirst({ where: { action: 'ENDPOINT_CLAIMED', resourceId: ep.id }, orderBy: { createdAt: 'desc' } });
    check(audit?.metadata?.adoptedFromPool === true && audit?.metadata?.customerId === acme.id, 'ENDPOINT_CLAIMED records the adoption and the business', JSON.stringify(audit?.metadata));
  }

  section('Claim tokens: 24 hours, single use');
  {
    const t = await req('POST', '/enrollment/tokens', { s: (await stepUp(S.admin)).s, body: { businessId: acme.id } });
    const rec = await prisma.deviceClaimToken.findFirst({ where: { customerId: acme.id }, orderBy: { createdAt: 'desc' } });
    const hours = (rec.expiresAt.getTime() - rec.createdAt.getTime()) / 3_600_000;
    check(Math.abs(hours - 24) < 0.1, `a token lives 24 hours (${hours.toFixed(2)} h)`);
    const r1 = rid(); created.rustdeskIds.push(r1);
    const c1 = await req('POST', '/enrollment/claim', { body: { token: t.body.data.token, rustdeskId: r1, agentSecret: secret(), hostname: 'ONCE' } });
    check(c1.status < 300, 'first claim succeeds', msg(c1));
    const r2 = rid(); created.rustdeskIds.push(r2);
    const c2 = await req('POST', '/enrollment/claim', { body: { token: t.body.data.token, rustdeskId: r2, agentSecret: secret(), hostname: 'TWICE' } });
    check(c2.status === 400 && /already been used/.test(JSON.stringify(c2.body)), 'the same token again → 400 already used', msg(c2));
    check(!(await prisma.rustdeskNode.findUnique({ where: { rustdeskId: r2 } })), '…and enrolled nothing');

    const t2 = await req('POST', '/enrollment/tokens', { s: (await stepUp(S.admin)).s, body: { businessId: acme.id } });
    await prisma.deviceClaimToken.updateMany({ where: { customerId: acme.id, claimedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const r3 = rid(); created.rustdeskIds.push(r3);
    const c3 = await req('POST', '/enrollment/claim', { body: { token: t2.body.data.token, rustdeskId: r3, agentSecret: secret(), hostname: 'LATE' } });
    check(c3.status === 400 && /expired/.test(JSON.stringify(c3.body)), 'an expired token → 400 expired', msg(c3));
    const still = await prisma.deviceClaimToken.findFirst({ where: { customerId: acme.id }, orderBy: { createdAt: 'desc' } });
    check(still.claimedAt === null && !(await prisma.rustdeskNode.findUnique({ where: { rustdeskId: r3 } })), '…not consumed, nothing enrolled');
  }

  section('Step-up and MFA');
  {
    check(jwtClaims(S.tina).mfaVerified === false, 'a password sign-in with no authenticator: the session says mfaVerified false', JSON.stringify(jwtClaims(S.tina)));
    // Tina enrols an authenticator after this session began.
    const totp = authenticator.generateSecret();
    await prisma.userMfaMethod.create({ data: { userId: tina.id, type: 'TOTP', isActive: true, totpSecret: encrypt(totp) } });
    const st = await req('GET', '/auth/step-up', { s: S.tina });
    check(st.body.data?.totpRequired === true, 'GET /auth/step-up reports totpRequired', msg(st));
    const byPw = await stepUp(S.tina);
    check(byPw.r.status === 401 && code(byPw.r) === 'TOTP_REQUIRED' && !byPw.s, 'step-up with the password alone → 401 TOTP_REQUIRED', msg(byPw.r));
    const byCode = await stepUp(S.tina, { totpCode: authenticator.generate(totp) });
    check(byCode.r.status === 200 && !!byCode.s, 'step-up with the authenticator code → 200', msg(byCode.r));
    const rev = await req('GET', `/endpoints/${pc.id}/password`, { s: byCode.s });
    check(rev.status === 403 && code(rev) === 'MFA_REQUIRED' && !leaks(rev.text), 'a session from before the authenticator cannot reveal: 403 MFA_REQUIRED', msg(rev));

    // A new sign-in passes the authenticator and says so. A code is single
    // use, so wait for the next 30-second step.
    await sleep((30 - (Math.floor(Date.now() / 1000) % 30)) * 1000 + 1500);
    const ip1 = ip();
    const l = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip1 }, body: JSON.stringify({ email: tina.email, password: PW }) });
    const partial = (l.headers.get('set-cookie') ?? '').match(/partial_token=([^;]+)/)?.[1];
    const lj = await l.json();
    check(lj.data?.requiresMfa === true && !!partial, 'signing in again asks for the authenticator', JSON.stringify(lj).slice(0, 200));
    const v = await fetch(`${API}/auth/mfa/verify`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip1, cookie: `partial_token=${partial}` }, body: JSON.stringify({ code: authenticator.generate(totp) }) });
    const at = (v.headers.get('set-cookie') ?? '').match(/access_token=([^;]+)/)?.[1];
    check(v.status === 200 && !!at && jwtClaims({ cookie: `access_token=${at}` }).mfaVerified === true, 'the session it mints says mfaVerified true', `HTTP ${v.status}`);
  }
}

let crashed = null;
try { await main(); } catch (e) { crashed = e; console.error(e); }
finally {
  try {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${TRIGGER} ON "ActivityLog"`).catch(() => {});
    const eps = await prisma.endpoint.findMany({ where: { OR: [{ customerId: { in: created.businesses } }, { rustdeskNode: { rustdeskId: { in: created.rustdeskIds } } }] }, select: { id: true } });
    const ids = eps.map((e) => e.id);
    await prisma.computerAccess.deleteMany({ where: { endpointId: { in: ids } } });
    await prisma.connectionGrant.deleteMany({ where: { endpointId: { in: ids } } }).catch(() => {});
    await prisma.supportSession.deleteMany({ where: { endpointId: { in: ids } } }).catch(() => {});
    await prisma.deviceClaimToken.deleteMany({ where: { customerId: { in: created.businesses } } }).catch(() => {});
    await prisma.rustdeskNode.deleteMany({ where: { endpointId: { in: ids } } });
    await prisma.endpoint.deleteMany({ where: { id: { in: ids } } }).catch((e) => console.error('cleanup endpoints:', e.message));
    await prisma.endpointGroup.deleteMany({ where: { id: { in: created.groups } } }).catch(() => {});
    await prisma.userMfaMethod.deleteMany({ where: { userId: { in: created.users } } });
    await prisma.membership.deleteMany({ where: { userId: { in: created.users } } });
    await prisma.activityLog.updateMany({ where: { actorId: { in: created.users } }, data: { actorId: null } }).catch(() => {});
    await prisma.activityLog.updateMany({ where: { customerId: { in: created.businesses } }, data: { customerId: null } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: created.users } } }).catch((e) => console.error('cleanup users:', e.message));
    await prisma.customer.deleteMany({ where: { id: { in: created.businesses } } }).catch((e) => console.error('cleanup businesses:', e.message));
  } catch (e) { console.error('cleanup:', e.message); }
  if (api) api.kill('SIGTERM');
  await prisma.$disconnect();
}
console.log(`\n${fail ? '\x1b[31m✗' : '\x1b[32m✓'} ${pass} passed, ${fail} failed\x1b[0m`);
if (failures.length) for (const f of failures) console.log('  - ' + f);
process.exit(fail || crashed ? 1 : 0);
