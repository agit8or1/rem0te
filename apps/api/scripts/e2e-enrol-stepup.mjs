#!/usr/bin/env node
/**
 * End-to-end proof of enrolment step-up (0.33).
 *
 * The gap it closes (docs/rmm-gap-analysis.md, known since 0.23): a stolen or
 * unattended session could mint enrolment tokens and put a machine of the
 * thief's choosing into a business. Now:
 *
 *   - POST /enrollment/tokens needs a fresh re-authentication for EVERY role
 *     (Platform Admin, Business Owner, a Business User with computers:add),
 *     including a re-enrol token for an existing computer. A stale session
 *     gets 403 STEP_UP_REQUIRED (action enrollment.create) and no row is
 *     written; a fresh one succeeds and the audit entry records how;
 *   - it is unconditional: emptying PlatformSettings.stepUpActions does not
 *     turn it off;
 *   - the proof is the existing step-up cookie, so it is bound to the user and
 *     to the sign-in: another user's step-up, a step-up from an earlier
 *     sign-in, a forged one and an expired one are all refused;
 *   - scope comes first: naming another business, or a business that does
 *     not exist, is refused as before (403/404), never answered with a
 *     prompt to re-authenticate;
 *   - API keys cannot step up and keep the ability: POST /pub/v1/enrollment/
 *     tokens with an enrollment:write key still mints, bound to the key's
 *     business only. Instead, creating a key that carries enrollment:write
 *     needs the same fresh re-authentication; keys without it are unchanged;
 *     a session cookie cannot use the public route at all;
 *   - registering a computer by RustDesk ID (POST /endpoints, Platform Admin
 *     only) mints no credential — no token, no device secret, no password —
 *     and stays without step-up; this suite proves the "mints nothing" half.
 *
 * Self-starting: it runs its own API from dist/ on ENROLSTEPUP_API_PORT (3332)
 * against DATABASE_URL, which must name a scratch/test database. Fixtures are
 * namespaced and removed at the end.
 *
 * Run:  DATABASE_URL=…/rem0te_enrol_stepup_test node scripts/e2e-enrol-stepup.mjs
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const DB = process.env.DATABASE_URL ?? '';
const dbName = DB.split('/').pop()?.split('?')[0] ?? '';
if (!/scratch|test/.test(dbName)) { console.error(`Refusing to run against database "${dbName}": name must contain "scratch" or "test".`); process.exit(2); }
const PORT = Number(process.env.ENROLSTEPUP_API_PORT ?? 3332);
if ([3000, 3001, 443, 4000, 4001].includes(PORT)) { console.error(`Refusing port ${PORT}: production or the shared docs stack.`); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
const VERSION_FILE = path.resolve(here, '..', '..', '..', 'version.json');
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'enrol-stepup-e2e-password-1';
const TAG = `ES${sfx}`;
const JWT_SECRET = randomBytes(32).toString('hex');

let pass = 0, fail = 0;
const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;

const apiEnv = {
  ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATABASE_URL: DB,
  JWT_SECRET, LAUNCHER_TOKEN_SECRET: randomBytes(32).toString('hex'),
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? randomBytes(32).toString('hex'), TRUSTED_PROXIES: 'loopback',
  HBBS_PRESENCE_HOST: '127.0.0.2', MONITOR_SWEEP: 'off', CLIENT_UPDATE_SWEEP: 'off', AUDIT_SEALER: 'off', VERSION_FILE,
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

// Paced well under the 20 req/s burst throttler, and a fresh client address
// per request (the throttler is keyed by it).
async function req(method, p, { cookie, stepUp, bearer, body } = {}) {
  await sleep(60);
  const h = { 'x-forwarded-for': ip() };
  if (cookie) h.cookie = cookie + (stepUp ? `; step_up=${stepUp}` : '');
  if (bearer) h.authorization = `Bearer ${bearer}`;
  if (body !== undefined) h['content-type'] = 'application/json';
  const r = await fetch(`${API}${p}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j, data: j?.data, text, setCookie: r.headers.get('set-cookie') ?? '' };
}
async function login(email) {
  const r = await req('POST', '/auth/login', { body: { email, password: PW } });
  const mm = r.setCookie.match(/access_token=([^;]+)/);
  if (r.status !== 200 || !mm) throw new Error(`login ${email}: ${r.status} ${r.text}`);
  return { cookie: `access_token=${mm[1]}` };
}
async function stepUp(s) {
  const r = await req('POST', '/auth/step-up', { cookie: s.cookie, body: { password: PW } });
  const mm = r.setCookie.match(/step_up=([^;]+)/);
  if (r.status !== 200 || !mm) throw new Error(`step-up: ${r.status} ${r.text}`);
  return mm[1];
}
const msg = (r) => `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`;
const isStepUp = (r, action = 'enrollment.create') => r.status === 403 && r.body?.code === 'STEP_UP_REQUIRED' && r.body?.action === action;
const rid = () => String(100000000 + ((Math.random() * 899999999) | 0));
/** A step-up cookie signed exactly as StepUpService signs one. */
function forgeStepUp(payload, secret = JWT_SECRET) {
  const key = createHmac('sha256', secret).update('rem0te-step-up-v1').digest();
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`;
}
const jwtPayload = (cookie) => JSON.parse(Buffer.from(cookie.split('=')[1].split('.')[1], 'base64url').toString('utf8'));

const created = { businesses: [], users: [], rustdeskIds: [] };
let savedStepUpActions = null;

async function all() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });
  const roleUser = await prisma.role.findFirst({ where: { type: 'BUSINESS_USER' } });

  section('Fixtures (synthetic): businesses A and B, a Platform Admin, two owners, a Business User who may add computers');
  const A = await prisma.customer.create({ data: { tenantId: tenant.id, name: `${TAG} Acme` } });
  const B = await prisma.customer.create({ data: { tenantId: tenant.id, name: `${TAG} Birch` } });
  created.businesses.push(A.id, B.id);
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag, extra = {}) => { const u = await prisma.user.create({ data: { email: `es-${tag}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'ES', lastName: tag, status: 'ACTIVE', ...extra } }); created.users.push(u.id); return u; };
  const admin = await mkUser('admin', { isPlatformAdmin: true });
  const ownerA = await mkUser('owner-a'), ownerB = await mkUser('owner-b'), adderA = await mkUser('adder-a');
  await prisma.membership.create({ data: { userId: ownerA.id, tenantId: tenant.id, customerId: A.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: ownerB.id, tenantId: tenant.id, customerId: B.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: adderA.id, tenantId: tenant.id, customerId: A.id, roleId: roleUser.id, capabilities: ['computers:view', 'computers:add'] } });
  const epA = await prisma.endpoint.create({ data: { tenantId: tenant.id, customerId: A.id, name: `${TAG}-existing`, enrollment: { create: { status: 'PENDING' } } } });
  check(true, 'created A, B, 4 users, one existing computer in A');

  const busy = await fetch(`${API}/health`).then(() => true, () => false);
  if (busy) throw new Error(`port ${PORT} is already in use; set ENROLSTEPUP_API_PORT to a free scratch port`);
  startApi();
  await waitUp();
  const S = { admin: await login(admin.email), ownerA: await login(ownerA.email), ownerB: await login(ownerB.email), adderA: await login(adderA.email) };
  const tokenRows = () => prisma.deviceClaimToken.count({ where: { customerId: { in: [A.id, B.id] } } });

  // ── Every role: stale refused, fresh succeeds ─────────────────────────────
  section('Every role: a stale session is refused, a fresh one mints');
  const roles = [['Platform Admin', 'admin', A.id], ['Business Owner A', 'ownerA', A.id], ['Business User A (computers:add)', 'adderA', A.id], ['Business Owner B', 'ownerB', B.id]];
  for (const [label, k, biz] of roles) {
    const before = await tokenRows();
    const r = await req('POST', '/enrollment/tokens', { cookie: S[k].cookie, body: { businessId: biz, accessMode: 'COMPANY_WIDE' } });
    check(isStepUp(r), `${label}, stale session: 403 STEP_UP_REQUIRED (enrollment.create)`, msg(r));
    check(await tokenRows() === before, `${label}: the refused attempt wrote no token row`);
  }
  for (const [label, k, biz] of roles) {
    S[k].stepUp = await stepUp(S[k]);
    const r = await req('POST', '/enrollment/tokens', { cookie: S[k].cookie, stepUp: S[k].stepUp, body: { businessId: biz, accessMode: 'COMPANY_WIDE', description: `${TAG} ${k}` } });
    check((r.status === 201 || r.status === 200) && /^[0-9a-f]{64}$/.test(r.data?.token ?? '') && r.data?.customerId === biz, `${label}, after step-up: the token is minted, in its own business`, msg(r));
    if (k === 'ownerA') {
      const a = await prisma.activityLog.findFirst({ where: { action: 'CLAIM_TOKEN_CREATED', resourceId: r.data?.id } });
      check(a?.metadata?.mintedVia === 'session' && a?.metadata?.stepUpMethod === 'password' && a?.actorId === ownerA.id, 'the audit entry records the mint as a session with a password step-up', JSON.stringify(a?.metadata));
    }
  }

  section('A re-enrol token for an existing computer needs it too');
  let r = await req('POST', '/enrollment/tokens', { cookie: S.ownerA.cookie, body: { businessId: A.id, endpointId: epA.id } });
  check(isStepUp(r), 'owner A, stale, re-enrol token: 403 STEP_UP_REQUIRED', msg(r));
  r = await req('POST', '/enrollment/tokens', { cookie: S.ownerA.cookie, stepUp: S.ownerA.stepUp, body: { businessId: A.id, endpointId: epA.id } });
  check(r.status === 201 && r.data?.endpointId === epA.id, 'owner A, fresh, re-enrol token: minted for that computer', msg(r));

  // ── Scope before freshness ────────────────────────────────────────────────
  section('Scope is decided first: no prompt to re-authenticate for what would be refused anyway');
  r = await req('POST', '/enrollment/tokens', { cookie: S.ownerA.cookie, body: { businessId: B.id } });
  check(r.status === 403 && r.body?.code !== 'STEP_UP_REQUIRED', 'owner A naming B, stale: 403 on scope, not STEP_UP_REQUIRED', msg(r));
  r = await req('POST', '/enrollment/tokens', { cookie: S.ownerA.cookie, stepUp: S.ownerA.stepUp, body: { businessId: B.id } });
  check(r.status === 403, 'owner A naming B, fresh: still 403 — a step-up widens nothing', msg(r));
  r = await req('POST', '/enrollment/tokens', { cookie: S.admin.cookie, body: { businessId: 'c' + randomBytes(12).toString('hex') } });
  check(r.status === 404, 'Platform Admin, stale, unknown business: 404 Business not found', msg(r));
  r = await req('POST', '/enrollment/tokens', { cookie: S.ownerB.cookie, body: { businessId: B.id, endpointId: epA.id } });
  check(r.status === 404 || (r.status === 403 && r.body?.code !== 'STEP_UP_REQUIRED'), 'owner B re-enrolling A\'s computer, stale: refused on scope (A\'s computer looks missing)', msg(r));
  check(await prisma.deviceClaimToken.count({ where: { customerId: B.id } }) === 1, 'business B holds only the one token its own owner minted');

  // ── The proof is bound ────────────────────────────────────────────────────
  section('The step-up is bound to the user and to the sign-in, and cannot be forged');
  r = await req('POST', '/enrollment/tokens', { cookie: S.ownerA.cookie, stepUp: S.adderA.stepUp, body: { businessId: A.id } });
  check(isStepUp(r), 'owner A presenting the Business User\'s step-up cookie: refused', msg(r));
  await sleep(1100); // a new sign-in has a new `iat`
  const ownerA2 = await login(ownerA.email);
  r = await req('POST', '/enrollment/tokens', { cookie: ownerA2.cookie, stepUp: S.ownerA.stepUp, body: { businessId: A.id } });
  check(isStepUp(r), 'owner A\'s new sign-in presenting the step-up earned in the previous sign-in: refused', msg(r));
  const p2 = jwtPayload(ownerA2.cookie);
  r = await req('POST', '/enrollment/tokens', { cookie: ownerA2.cookie, stepUp: forgeStepUp({ sub: p2.sub, sid: p2.iat, exp: Date.now() + 60_000, m: 'password' }, randomBytes(32).toString('hex')), body: { businessId: A.id } });
  check(isStepUp(r), 'a step-up signed with the wrong key: refused', msg(r));
  r = await req('POST', '/enrollment/tokens', { cookie: ownerA2.cookie, stepUp: forgeStepUp({ sub: p2.sub, sid: p2.iat, exp: Date.now() - 1000, m: 'password' }), body: { businessId: A.id } });
  check(isStepUp(r), 'a correctly signed but expired step-up: refused', msg(r));
  r = await req('POST', '/enrollment/tokens', { cookie: ownerA2.cookie, stepUp: 'garbage', body: { businessId: A.id } });
  check(isStepUp(r), 'a malformed step-up cookie: refused', msg(r));

  // ── Unconditional ─────────────────────────────────────────────────────────
  section('It cannot be configured away');
  const ps = await prisma.platformSettings.findUnique({ where: { id: 'singleton' }, select: { stepUpActions: true } });
  savedStepUpActions = ps ? ps.stepUpActions : undefined;
  await prisma.platformSettings.upsert({ where: { id: 'singleton' }, update: { stepUpActions: [] }, create: { id: 'singleton', stepUpActions: [] } });
  r = await req('POST', '/enrollment/tokens', { cookie: ownerA2.cookie, body: { businessId: A.id } });
  check(isStepUp(r), 'with every configurable step-up action switched off, a stale mint is still refused', msg(r));
  await restoreStepUpActions();

  // ── API keys ──────────────────────────────────────────────────────────────
  section('API keys: cannot step up, keep the ability; minting such a key needs a fresh sign-in');
  const keyRows = () => prisma.apiKey.count({ where: { customerId: A.id } });
  let k0 = await keyRows();
  r = await req('POST', '/apikeys', { cookie: S.ownerA.cookie, body: { name: `${TAG}-enrol`, scopes: ['computers:read', 'enrollment:write'] } });
  check(isStepUp(r, 'apikey.enrollment'), 'owner A, stale, key with enrollment:write: 403 STEP_UP_REQUIRED (apikey.enrollment)', msg(r));
  check(await keyRows() === k0, 'no key row was written');
  r = await req('POST', '/apikeys', { cookie: S.ownerA.cookie, body: { name: `${TAG}-read`, scopes: ['computers:read'] } });
  check(r.status === 201 && !r.data?.scopes?.includes('enrollment:write'), 'owner A, stale, key without enrollment:write: created as before', msg(r));
  r = await req('POST', '/apikeys', { cookie: S.ownerA.cookie, body: { name: `${TAG}-sneak`, scopes: ['computers:read', 'enrollment:write', 'not-a-scope'] } });
  check(isStepUp(r, 'apikey.enrollment'), 'enrollment:write hidden among other scopes: still refused', msg(r));
  r = await req('POST', '/apikeys', { cookie: S.ownerA.cookie, stepUp: S.ownerA.stepUp, body: { name: `${TAG}-enrol`, scopes: ['computers:read', 'enrollment:write'] } });
  const rawKey = r.data?.key ?? r.data?.rawKey ?? r.data?.token;
  check(r.status === 201 && typeof rawKey === 'string' && rawKey.startsWith('rk_'), 'owner A, fresh, key with enrollment:write: created', msg(r));
  const keyId = r.data?.id;

  r = await req('POST', '/pub/v1/enrollment/tokens', { bearer: rawKey, body: { accessMode: 'COMPANY_WIDE', description: `${TAG} via key` } });
  check(r.status === 201 && /^[0-9a-f]{64}$/.test(r.data?.token ?? ''), 'the key mints a token with no step-up (an API key cannot do one)', msg(r));
  const viaKey = r.data?.id ? await prisma.deviceClaimToken.findUnique({ where: { id: r.data.id } }) : null;
  check(viaKey?.customerId === A.id, 'the key\'s token is bound to the key\'s business, A');
  const ak = r.data?.id ? await prisma.activityLog.findFirst({ where: { action: 'CLAIM_TOKEN_CREATED', resourceId: r.data.id } }) : null;
  check(ak?.metadata?.mintedVia === 'api-key' && ak?.metadata?.apiKeyId === keyId, 'the audit entry records the mint as the API key, by id', JSON.stringify(ak?.metadata));
  r = await req('POST', '/pub/v1/enrollment/tokens', { bearer: rawKey, body: { businessId: B.id } });
  check(r.status === 403 || r.status === 404, 'the key naming business B: refused', msg(r));
  r = await req('POST', '/pub/v1/enrollment/tokens', { cookie: S.ownerA.cookie, stepUp: S.ownerA.stepUp, body: {} });
  check(r.status === 401, 'a session cookie (even a fresh one) cannot use the public route', msg(r));
  check(await prisma.deviceClaimToken.count({ where: { customerId: B.id } }) === 1, 'business B still holds only its own owner\'s token');

  // ── Register by RustDesk ID: mints nothing ────────────────────────────────
  section('Register by RustDesk ID mints no credential, and is not gated');
  const rd = rid(); created.rustdeskIds.push(rd);
  const t0 = await tokenRows();
  r = await req('POST', '/endpoints', { cookie: S.admin.cookie, body: { name: `${TAG}-by-id`, customerId: A.id, rustdeskId: rd, platform: 'windows' } });
  check(r.status === 201 && r.data?.id, 'Platform Admin, stale session, register by RustDesk ID: created', msg(r));
  const node = await prisma.rustdeskNode.findUnique({ where: { rustdeskId: rd } });
  check(!!node && node.agentSecretHash === null && node.permanentPassword === null && node.candidateSecretHash === null, 'the node has no device secret, no candidate secret and no stored password', JSON.stringify(node && { s: node.agentSecretHash, p: node.permanentPassword }));
  check(await tokenRows() === t0 && !/"token"|"password"|agentSecret/.test(r.text), 'no enrolment token was minted and the response carries no credential');
  r = await req('POST', '/endpoints', { cookie: S.ownerA.cookie, stepUp: S.ownerA.stepUp, body: { name: `${TAG}-by-id-owner`, customerId: A.id, rustdeskId: rid() } });
  check(r.status === 403, 'a Business Owner, even fresh, cannot register by RustDesk ID (unchanged: Platform Admin only)', msg(r));

  // ── Isolation of what was minted ──────────────────────────────────────────
  section('Business isolation of the minted tokens');
  r = await req('GET', `/enrollment/tokens?businessId=${A.id}`, { cookie: S.ownerB.cookie });
  check(r.status === 200 ? !(r.data ?? []).some((t) => t.customerId === A.id) : r.status === 403, 'owner B cannot list A\'s tokens', msg(r));
  r = await req('GET', '/enrollment/tokens', { cookie: S.ownerA.cookie });
  check(r.status === 200 && (r.data ?? []).length >= 4 && (r.data ?? []).every((t) => t.customerId === A.id), 'owner A lists only A\'s tokens', `${(r.data ?? []).length} rows`);
}

async function restoreStepUpActions() {
  if (savedStepUpActions === null) return;
  if (savedStepUpActions === undefined) await prisma.platformSettings.update({ where: { id: 'singleton' }, data: { stepUpActions: { set: ['credential.reveal', 'permissions.change', 'technicians.manage', 'sso.configure', 'passkey.manage', 'platform.configure'] } } }).catch(() => {});
  else await prisma.platformSettings.update({ where: { id: 'singleton' }, data: { stepUpActions: { set: savedStepUpActions } } });
  savedStepUpActions = null;
}

async function cleanup() {
  await stopApi();
  try {
    await restoreStepUpActions();
    const ids = created.businesses;
    const eps = await prisma.endpoint.findMany({ where: { customerId: { in: ids } }, select: { id: true } });
    const epIds = eps.map((e) => e.id);
    await prisma.deviceClaimToken.deleteMany({ where: { OR: [{ customerId: { in: ids } }, { endpointId: { in: epIds } }] } });
    await prisma.apiKey.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.rustdeskNode.deleteMany({ where: { OR: [{ endpointId: { in: epIds } }, { rustdeskId: { in: created.rustdeskIds } }] } });
    await prisma.endpoint.deleteMany({ where: { id: { in: epIds } } });
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
