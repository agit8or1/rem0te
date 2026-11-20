#!/usr/bin/env node
/**
 * End-to-end proof of Managed Secure Access grants and the long-poll channel
 * (0.71, check-security-invariants §81), through the real routes:
 *
 *   - with MSA_GRANTS anything but exactly 'on' (here 'true'), every grant
 *     route answers 404 MSA_NOT_ENABLED before a session, a device secret or
 *     a row is read, and no key or grant is created;
 *   - with it on: only a Platform Admin with a fresh confirmation (msa.grant)
 *     issues a test grant; a pooled computer, a standard (legacy) agent, a
 *     Linux computer, a `remote` containment pause and a malformed request
 *     are refused; the grant key is generated once, audited by key id only;
 *   - the device poll refuses a wrong secret, a standard agent and a pooled
 *     computer; it hands the computer's own grant over as an envelope that
 *     verifies under the published public key; an ack marks it delivered,
 *     and a repeated or foreign ack changes nothing;
 *   - a held poll wakes when a grant is issued, a second poll from the same
 *     computer ends the first (which hands nothing over), the hold runs out,
 *     and the process-wide cap answers retryAfterMs;
 *   - an undelivered grant past its window is expired, a newer grant
 *     cancels an older undelivered one, a `remote` pause withholds grants;
 *   - no audit row, list answer or stored column carries the password;
 *   - the database refuses a window over five minutes, an unknown state and
 *     a second active key.
 *
 *   cd apps/api && npx nest build
 *   DATABASE_URL=postgresql://…/<name containing scratch or test> node scripts/e2e-msa-grants.mjs
 *
 * Self-starting: its API runs from dist/ on MSA_GRANTS_API_PORT (3951).
 * INTEGRATION, not Windows: no agent in 0.71 polls; the poll is posted the
 * way step 4's agent will post it.
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { confirmEverythingAsks } from './lib/confirm-asks.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const G = createRequire(import.meta.url)(path.join(dist, 'msa', 'grant.js'));
const DB = process.env.DATABASE_URL ?? '';
const dbName = DB.split('/').pop()?.split('?')[0] ?? '';
if (!/scratch|test/.test(dbName)) { console.error(`Refusing to run against database "${dbName}": name must contain "scratch" or "test".`); process.exit(2); }
const PORT = Number(process.env.MSA_GRANTS_API_PORT ?? 3951);
if ([3000, 3001, 3201, 3202, 4000, 4001, 443].includes(PORT)) { console.error(`Refusing port ${PORT}`); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'msa-grants-e2e-password-123';
const VERSION_FILE = path.resolve(here, '..', '..', '..', 'version.json');
const HOLD_MS = 4000;

let pass = 0, fail = 0;
const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const J = (x) => JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

const baseEnv = {
  ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATABASE_URL: DB,
  JWT_SECRET: randomBytes(32).toString('hex'), LAUNCHER_TOKEN_SECRET: randomBytes(32).toString('hex'),
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? randomBytes(32).toString('hex'), TRUSTED_PROXIES: 'loopback', HBBS_PRESENCE_HOST: '127.0.0.2',
  VERSION_FILE, MONITOR_SWEEP: 'off', AUDIT_SEALER: 'off', CLIENT_UPDATE_SWEEP: 'off', SNAPSHOT_SWEEP: 'off', PATCH_POLICY_SWEEP: 'off', METRIC_SWEEP: 'off',
  AUTO_MIGRATION_SWEEP: 'off', TRAY_SWEEP: 'off', RETENTION_SWEEP: 'off', CHAT_RETENTION_SWEEP: 'off', STALE_SWEEP: 'off', AGENT_AUTO_UPDATE: 'off',
  MSA_POLL_HOLD_MS: String(HOLD_MS), MSA_POLL_MAX: '3',
  // Never production's GeoIP file (§54): this suite needs no locations.
  GEOIP_DB_PATH: path.join(here, 'no-such-geoip.mmdb'),
};
delete baseEnv.PUBLIC_API_URL;
delete baseEnv.MSA_GRANTS;
let api;
async function startApi(extra) {
  api = spawn(process.execPath, [path.join(dist, 'main.js')], { env: { ...baseEnv, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  api.log = ''; api.stdout.on('data', (d) => { api.log += d; }); api.stderr.on('data', (d) => { api.log += d; });
  for (let i = 0; i < 150; i++) { try { const r = await fetch(`${API}/health`); if (r.status < 500) return; } catch { /* not yet */ } await sleep(300); }
  throw new Error(`api did not come up:\n${api.log.slice(-3000)}`);
}
async function stopApi() { if (!api || api.exitCode !== null || api.signalCode !== null) return; await new Promise((r) => { api.once('exit', r); api.kill('SIGTERM'); }); }

async function req(method, p, { s, body } = {}) {
  await sleep(30);
  const h = { 'content-type': 'application/json', 'x-forwarded-for': ip() };
  if (s) h.cookie = s.cookie;
  const t0 = Date.now();
  const r = await fetch(`${API}${p}`, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j, data: j?.data, ms: Date.now() - t0, text };
}
async function login(email) {
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip() }, body: JSON.stringify({ email, password: PW }) });
  const m = (r.headers.get('set-cookie') ?? '').match(/access_token=([^;]+)/);
  if (r.status !== 200 || !m) throw new Error(`login ${email}: ${r.status} ${await r.text()}`);
  return { cookie: `access_token=${m[1]}` };
}
async function stepUp(s) {
  const r = await fetch(`${API}/auth/step-up`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip(), cookie: s.cookie }, body: JSON.stringify({ password: PW }) });
  const m = (r.headers.get('set-cookie') ?? '').match(/step_up=([^;]+)/);
  if (r.status !== 200 || !m) throw new Error(`step-up: ${r.status} ${await r.text()}`);
  return { cookie: `${s.cookie}; step_up=${m[1]}` };
}
const msg = (r) => `HTTP ${r.status} ${(typeof r.body === 'string' ? r.body : J(r.body)).slice(0, 400)}`;
const code = (r) => r.body?.code ?? r.body?.message?.code ?? r.body?.error?.code;
const ok = (r) => r.status === 200 || r.status === 201;
const notEnabled = (r) => r.status === 404 && code(r) === 'MSA_NOT_ENABLED';
const poll = (ep, extra = {}) => req('POST', '/msa/agent/poll', { body: { rustdeskId: ep.rid, agentSecret: ep.secret, ...extra } });

const created = { businesses: [], users: [], pauses: [], endpoints: [] };

async function all() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });
  const roleUser = await prisma.role.findFirst({ where: { type: 'BUSINESS_USER' } });
  await confirmEverythingAsks(prisma);

  section('Fixtures (synthetic): businesses A and B, a Platform Admin, their owners, a Business User without View computers, signed, standard, Linux and pooled computers');
  const bizA = await prisma.customer.create({ data: { tenantId: tenant.id, name: `MSA-G A ${sfx}` } });
  const bizB = await prisma.customer.create({ data: { tenantId: tenant.id, name: `MSA-G B ${sfx}` } });
  created.businesses.push(bizA.id, bizB.id);
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag, biz, role, { capabilities = [], admin = false } = {}) => {
    const u = await prisma.user.create({ data: { email: `msag-${tag}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'Msag', lastName: tag, status: 'ACTIVE', isPlatformAdmin: admin } });
    created.users.push(u.id);
    if (biz) await prisma.membership.create({ data: { userId: u.id, tenantId: tenant.id, customerId: biz.id, roleId: role.id, capabilities } });
    return u;
  };
  const admin = await mkUser('admin', null, null, { admin: true });
  const ownerA = await mkUser('owner-a', bizA, roleOwner);
  const ownerB = await mkUser('owner-b', bizB, roleOwner);
  const noView = await mkUser('noview-a', bizA, roleUser);
  const mkEp = async (hostname, biz, { channel = 'signed', pooled = false, platform = 'Windows' } = {}) => {
    const e = await prisma.endpoint.create({ data: {
      tenantId: pooled ? null : tenant.id, customerId: pooled ? null : biz.id, name: hostname, hostname, platform, status: pooled ? 'PENDING_ENROLLMENT' : 'ACTIVE',
      isOnline: true, isManaged: true, accessMode: 'COMPANY_WIDE', lastSeenAt: new Date(), agentVersion: '0.71.0', updateChannel: channel,
      signedSeenAt: channel === 'signed' ? new Date() : null, deviceClass: 'WORKSTATION' } });
    const rid = String(100000000 + ((Math.random() * 899999999) | 0));
    const secret = randomBytes(24).toString('hex');
    await prisma.rustdeskNode.create({ data: { tenantId: pooled ? null : tenant.id, endpointId: e.id, rustdeskId: rid, version: '1.4.7', agentSecretHash: sha(secret) } });
    created.endpoints.push(e.id);
    return { id: e.id, rid, secret, hostname };
  };
  const A1 = await mkEp(`MSAG-A1-${sfx}`, bizA);
  const A2 = await mkEp(`MSAG-A2-STD-${sfx}`, bizA, { channel: 'legacy' });
  const L1 = await mkEp(`MSAG-L1-LNX-${sfx}`, bizA, { platform: 'linux' });
  const H = [await mkEp(`MSAG-H1-${sfx}`, bizA), await mkEp(`MSAG-H2-${sfx}`, bizA), await mkEp(`MSAG-H3-${sfx}`, bizA)];
  const B1 = await mkEp(`MSAG-B1-${sfx}`, bizB);
  const P1 = await mkEp(`MSAG-POOL-${sfx}`, null, { pooled: true });
  const counts = async () => ({ keys: await prisma.msaGrantKey.count(), grants: await prisma.msaGrant.count() });
  const rejectedAudits = () => prisma.activityLog.count({ where: { action: 'ENDPOINT_HEARTBEAT_REJECTED', metadata: { path: ['reason'], equals: 'msa_poll_unauthenticated' } } });

  // ── Off ───────────────────────────────────────────────────────────────────
  section('MSA_GRANTS=true (not exactly "on"): every route is 404 MSA_NOT_ENABLED before anything is read');
  const before = await counts();
  const rejBefore = await rejectedAudits();
  await startApi({ MSA_GRANTS: 'true' });
  {
    const SAd = await stepUp(await login(admin.email));
    const SA = await login(ownerA.email);
    let r = await req('POST', `/msa/grants/test/${A1.id}`, { s: SAd, body: {} });
    check(notEnabled(r), 'POST /msa/grants/test/:id as a confirmed Platform Admin: 404 MSA_NOT_ENABLED', msg(r));
    r = await req('POST', `/msa/grants/test/${A1.id}`, { body: {} });
    check(notEnabled(r), 'the same with no session at all: 404, not 401 (the gate runs before the session guard)', msg(r));
    r = await req('GET', '/msa/grants/keys', { s: SAd });
    check(notEnabled(r), 'GET /msa/grants/keys: 404', msg(r));
    r = await req('GET', `/msa/grants/endpoint/${A1.id}`, { s: SA });
    check(notEnabled(r), 'GET /msa/grants/endpoint/:id as the owner: 404', msg(r));
    r = await poll(A1, { wait: false });
    check(notEnabled(r), 'POST /msa/agent/poll with the right secret: 404', msg(r));
    r = await req('POST', '/msa/agent/poll', { body: { rustdeskId: A1.rid, agentSecret: 'f'.repeat(48) } });
    check(notEnabled(r), 'and with a wrong secret: 404, not 401', msg(r));
    r = await req('POST', '/msa/agent/poll', { body: { junk: true } });
    check(notEnabled(r), 'and with a malformed body: 404, not 400 (nothing is validated)', msg(r));
    const after = await counts();
    check(J(after) === J(before), 'no key and no grant was created', J({ before, after }));
    check(await rejectedAudits() === rejBefore, 'no device-secret check ran (no ENDPOINT_HEARTBEAT_REJECTED row)');
    r = await req('GET', `/msa/readiness/${A1.id}`, { s: SA });
    check(ok(r), 'the 0.69 readiness routes are unaffected', msg(r));
  }
  await stopApi();

  // ── On ────────────────────────────────────────────────────────────────────
  await startApi({ MSA_GRANTS: 'on' });
  const SAdmin = await login(admin.email);
  const SAd = await stepUp(SAdmin);
  const SA = await login(ownerA.email);
  const SB = await login(ownerB.email);
  const SN = await login(noView.email);
  // A key left active by an earlier run on this database may be sealed under
  // another ENCRYPTION_KEY (the server refuses it: MSA_GRANT_KEY_UNAVAILABLE).
  // Test setup only: retire it, so this run proves the generation path.
  await prisma.msaGrantKey.updateMany({ where: { retiredAt: null }, data: { retiredAt: new Date() } });
  const keyBefore = await prisma.msaGrantKey.findFirst({ where: { retiredAt: null } });

  section('MSA_GRANTS=on: who may issue a test grant');
  let r = await req('POST', `/msa/grants/test/${A1.id}`, { s: await stepUp(SA), body: {} });
  check(r.status === 403, 'a Business Owner (confirmed): 403', msg(r));
  r = await req('POST', `/msa/grants/test/${A1.id}`, { body: {} });
  check(r.status === 401, 'no session: 401', msg(r));
  r = await req('POST', `/msa/grants/test/${A1.id}`, { s: SAdmin, body: {} });
  check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED' && r.body?.action === 'msa.grant', 'a Platform Admin without a fresh confirmation: STEP_UP_REQUIRED (msa.grant)', msg(r));
  check(J(await counts()) === J(before), 'nothing was created by a refusal');

  section('What is refused');
  r = await req('POST', `/msa/grants/test/${P1.id}`, { s: SAd, body: {} });
  check(r.status === 403 && code(r) === 'ENDPOINT_UNASSIGNED', 'a pooled computer: 403 ENDPOINT_UNASSIGNED', msg(r));
  r = await req('POST', `/msa/grants/test/${A2.id}`, { s: SAd, body: {} });
  check(r.status === 409 && code(r) === 'MSA_SIGNED_AGENT_REQUIRED', 'a standard (legacy) agent: 409 MSA_SIGNED_AGENT_REQUIRED', msg(r));
  r = await req('POST', `/msa/grants/test/${L1.id}`, { s: SAd, body: {} });
  check(r.status === 409 && code(r) === 'MSA_SIGNED_AGENT_REQUIRED', 'a Linux computer: 409 MSA_SIGNED_AGENT_REQUIRED', msg(r));
  r = await req('POST', '/msa/grants/test/cnotacomputer0000000000', { s: SAd, body: {} });
  check(r.status === 404, 'an unknown computer: 404', msg(r));
  r = await req('POST', `/msa/grants/test/${A1.id}`, { s: SAd, body: { mode: 'admin' } });
  check(r.status === 400 && code(r) === 'MSA_GRANT_INVALID', 'mode "admin": 400 MSA_GRANT_INVALID', msg(r));
  r = await req('POST', `/msa/grants/test/${A1.id}`, { s: SAd, body: { password: 'chosen-by-me' } });
  check(r.status === 400 && code(r) === 'MSA_GRANT_INVALID', 'a password in the request (or any unknown field): 400', msg(r));
  r = await req('POST', `/msa/grants/test/${A1.id}`, { s: SAd, body: { maxMinutes: 481 } });
  check(r.status === 400, 'maxMinutes 481: 400', msg(r));
  r = await req('POST', `/msa/grants/test/${A1.id}`, { s: SAd, body: { maxMinutes: 10, idleMinutes: 20 } });
  check(r.status === 400, 'an idle limit over the session limit: 400', msg(r));
  const pB = await prisma.containmentPause.create({ data: { scope: 'BUSINESS', customerId: bizB.id, kinds: ['remote'], reason: 'e2e msa grants', setById: admin.id, setBy: 'msp' } });
  created.pauses.push(pB.id);
  r = await req('POST', `/msa/grants/test/${B1.id}`, { s: SAd, body: {} });
  check(r.status === 403 && code(r) === 'CONTAINED', 'a business under a `remote` pause: 403 CONTAINED', msg(r));
  await prisma.containmentPause.update({ where: { id: pB.id }, data: { clearedAt: new Date(), clearedById: admin.id, clearReason: 'e2e' } });
  check(J(await counts()) === J(before), 'still nothing created');

  section('Issuing: the key is generated once and audited by key id only');
  r = await req('POST', `/msa/grants/test/${A1.id}`, { s: SAd, body: {} });
  check(ok(r) && G.GRANT_ID_RE.test(r.data?.grantId ?? '') && r.data.mode === 'view' && r.data.consent === 'required' && r.data.state === 'issued'
    && Object.values(r.data.permissions).every((v) => v === false) && !('password' in r.data) && !('envelope' in r.data),
    'issued: view, consent required, no permissions (the defaults); no password or envelope in the answer', msg(r));
  const g1 = r.data;
  const keyRow = await prisma.msaGrantKey.findFirst({ where: { retiredAt: null } });
  check(!!keyRow && keyRow.keyId === g1.keyId && (!keyBefore || keyBefore.keyId === keyRow.keyId), 'one active key, the one that signed it', J({ before: keyBefore?.keyId, now: keyRow?.keyId }));
  check(!/BEGIN|PRIVATE/.test(keyRow?.privateKeyEnc ?? '') && /^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/.test(keyRow?.privateKeyEnc ?? ''), 'the private key is stored sealed (iv:tag:ciphertext)');
  if (!keyBefore) {
    const ka = await prisma.activityLog.findMany({ where: { action: 'MSA_GRANT_KEY_CREATED', resourceId: keyRow.keyId } });
    check(ka.length === 1 && J(ka[0].metadata) === J({ keyId: keyRow.keyId }) && ka[0].actorId === admin.id, 'MSA_GRANT_KEY_CREATED: once, the key id and nothing else', J(ka.map((a) => a.metadata)));
  }
  r = await req('POST', `/msa/grants/test/${B1.id}`, { s: SAd, body: { mode: 'control', permissions: { clipboard: true }, consent: 'not_required', maxMinutes: 30, idleMinutes: 5 } });
  check(ok(r) && r.data.keyId === keyRow.keyId && r.data.mode === 'control' && r.data.permissions.clipboard === true && r.data.maxMinutes === 30, 'a second grant (B1, control) uses the same key', msg(r));
  const gB = r.data;
  check(await prisma.msaGrantKey.count({ where: { retiredAt: null } }) === 1, 'still one active key');
  const ia = await prisma.activityLog.findFirst({ where: { action: 'MSA_GRANT_ISSUED', resourceId: A1.id }, orderBy: { createdAt: 'desc' } });
  check(!!ia && ia.actorId === admin.id && ia.customerId === bizA.id && J(Object.keys(ia.metadata).sort()) === J(['consent', 'endpointId', 'grantId', 'keyId', 'mode', 'source'])
    && ia.metadata.grantId === g1.grantId && ia.metadata.keyId === g1.keyId, 'MSA_GRANT_ISSUED: filed under the business, ids, mode, consent and key id only', J(ia?.metadata));

  r = await req('GET', '/msa/grants/keys', { s: SAdmin });
  const pub = (r.data ?? []).find((k) => k.active);
  check(ok(r) && pub && pub.keyId === keyRow.keyId && G.keyIdOf(Buffer.from(pub.publicKey, 'base64')) === pub.keyId && !J(r.data).includes(keyRow.privateKeyEnc)
    && J(Object.keys(pub).sort()) === J(['active', 'algorithm', 'createdAt', 'keyId', 'publicKey', 'retiredAt']), 'GET /msa/grants/keys: the public key, its id its SHA-256 prefix, nothing private', msg(r));
  r = await req('GET', '/msa/grants/keys', { s: SA });
  check(r.status === 403, 'and a Business Owner may not read it', msg(r));
  const keys = new Map([[pub.keyId, Buffer.from(pub.publicKey, 'base64')]]);
  const view = { mode: 'view', permissions: { clipboard: false, files: false, audio: false, tunnel: false, restart: false } };
  const ctxFor = (ep, over = {}) => ({ keys, endpointId: ep.id, rustdeskId: ep.rid, now: Date.now(), seen: new Set(), ceiling: view, remotePaused: false, ...over });

  section('The device poll: who may poll');
  r = await req('POST', '/msa/agent/poll', { body: { rustdeskId: A1.rid, agentSecret: 'f'.repeat(48), wait: false } });
  check(r.status === 401 && !J(r.body).includes('envelope'), 'a wrong secret: 401', msg(r));
  r = await req('POST', '/msa/agent/poll', { body: { rustdeskId: A1.rid, wait: false } });
  check(r.status === 400 || r.status === 401, `no secret: ${r.status}`, msg(r));
  r = await poll(A2, { wait: false });
  check(r.status === 403 && code(r) === 'MSA_SIGNED_AGENT_REQUIRED', 'a standard agent with its right secret: 403 MSA_SIGNED_AGENT_REQUIRED', msg(r));
  r = await poll(L1, { wait: false });
  check(r.status === 403 && code(r) === 'MSA_SIGNED_AGENT_REQUIRED', 'a Linux computer: 403', msg(r));
  r = await poll(P1, { wait: false });
  check(r.status === 403 && code(r) === 'ENDPOINT_UNASSIGNED', 'a pooled computer: 403 ENDPOINT_UNASSIGNED', msg(r));

  section('Delivery: the envelope verifies under the published key; ack marks it delivered');
  r = await poll(A1, { wait: false });
  check(ok(r) && r.data.grants.length === 1 && r.data.acked === 0 && r.data.holdMs === 0, 'A1: one grant, at once', msg(r));
  const env1 = r.data?.grants?.[0];
  let v = G.verifyEnvelope(env1, ctxFor(A1));
  check(v.ok && v.grant.grantId === g1.grantId && v.grant.endpointId === A1.id && v.grant.rustdeskId === A1.rid && v.grant.businessId === bizA.id
    && v.grant.technicianId === admin.id && G.PASSWORD_RE.test(v.grant.password) && Date.parse(v.grant.notAfter) - Date.parse(v.grant.notBefore) === 300_000,
    'it verifies: A1\'s own ids, the admin as technician, a 24-character one-time password, a five-minute window', J(v));
  const password = v.ok ? v.grant.password : 'unreachable';
  check(G.verifyEnvelope(env1, ctxFor(B1)).reason === 'wrong_endpoint', 'and is refused by another computer (wrong_endpoint)');
  check(G.verifyEnvelope(env1, ctxFor(A1, { seen: new Set([g1.grantId]) })).reason === 'replayed', 'and refused once used (replayed)');
  r = await poll(A1, { wait: false });
  check(ok(r) && r.data.grants.length === 1 && r.data.grants[0].sig === env1.sig, 'not acknowledged yet: handed over again, unchanged', msg(r));
  r = await poll(A1, { wait: false, ack: [g1.grantId, gB.grantId, 'z'.repeat(32)] });
  const row1 = await prisma.msaGrant.findUnique({ where: { id: g1.grantId } });
  const rowB = await prisma.msaGrant.findUnique({ where: { id: gB.grantId } });
  check(ok(r) && r.data.acked === 1 && r.data.grants.length === 0 && row1.state === 'delivered' && !!row1.deliveredAt && rowB.state === 'issued',
    'ack (with B1\'s grant id and a junk id mixed in): only A1\'s own is delivered', J({ acked: r.data?.acked, a: row1.state, b: rowB.state }));
  const deliveredAt = row1.deliveredAt.getTime();
  r = await poll(A1, { wait: false, ack: [g1.grantId] });
  const row1b = await prisma.msaGrant.findUnique({ where: { id: g1.grantId } });
  check(ok(r) && r.data.acked === 0 && row1b.state === 'delivered' && row1b.deliveredAt.getTime() === deliveredAt, 'the same ack again: acked 0, nothing changes', msg(r));
  r = await poll(B1, { wait: false });
  check(ok(r) && r.data.grants.length === 1 && G.verifyEnvelope(r.data.grants[0], ctxFor(B1, { ceiling: { mode: 'control', permissions: { ...view.permissions, clipboard: true } } })).ok
    && G.verifyEnvelope(r.data.grants[0], ctxFor(B1)).reason === 'mode_not_allowed', 'B1 gets its control grant; under a view ceiling the agent would refuse it (mode_not_allowed)', msg(r));
  await poll(B1, { wait: false, ack: [gB.grantId] });

  section('The password is nowhere but the envelope');
  const audits = await prisma.activityLog.findMany({ where: { action: { in: ['MSA_GRANT_ISSUED', 'MSA_GRANT_KEY_CREATED'] } } });
  check(audits.length >= 2 && audits.every((a) => !J(a).includes(password) && !J(a).includes(env1.sig) && !J(a).includes(env1.grant)), 'no MSA audit row holds the password, the signature or the grant', String(audits.length));
  check(!J(row1).includes(password) && !J(row1).includes(env1.sig), 'the stored row holds the password and envelope only sealed');
  r = await req('GET', `/msa/grants/endpoint/${A1.id}`, { s: SA });
  check(ok(r) && r.data.length >= 1 && r.data[0].grantId === g1.grantId && r.data[0].state === 'delivered' && !r.text.includes(password)
    && !/password|envelope/i.test(J(Object.keys(r.data[0]))), 'GET /msa/grants/endpoint/A1 (owner A): the grant, delivered, with no password or envelope', msg(r));
  r = await req('GET', `/msa/grants/endpoint/${A1.id}`, { s: SB });
  check(r.status === 404, 'owner B: A1\'s grants are a 404', msg(r));
  r = await req('GET', `/msa/grants/endpoint/${A1.id}`, { s: SN });
  check(r.status === 403, 'a Business User without View computers: 403', msg(r));

  section('The long-poll: wake, supersede, run out, the cap');
  let p = poll(A1);
  await sleep(600);
  r = await req('POST', `/msa/grants/test/${A1.id}`, { s: SAd, body: {} });
  const g2 = r.data;
  let pr = await p;
  check(ok(pr) && pr.data.grants.length === 1 && G.verifyEnvelope(pr.data.grants[0], ctxFor(A1)).grant?.grantId === g2?.grantId && pr.data.holdMs >= 400 && pr.data.holdMs < HOLD_MS - 500,
    `a held poll wakes as soon as a grant is issued (held ${pr.data?.holdMs} ms)`, msg(pr));
  await poll(A1, { wait: false, ack: [g2.grantId] });
  const first = poll(A1);
  await sleep(500);
  const second = poll(A1);
  const fr = await first;
  check(ok(fr) && fr.data.superseded === true && fr.data.grants.length === 0 && fr.ms < HOLD_MS - 1000, `a second poll ends the first, which hands nothing over (${fr.ms} ms)`, msg(fr));
  r = await req('POST', `/msa/grants/test/${A1.id}`, { s: SAd, body: {} });
  const g3 = r.data;
  const sr = await second;
  check(ok(sr) && sr.data.grants.length === 1 && G.verifyEnvelope(sr.data.grants[0], ctxFor(A1)).grant?.grantId === g3?.grantId && !sr.data.superseded, 'the second poll gets the grant', msg(sr));
  await poll(A1, { wait: false, ack: [g3.grantId] });
  pr = await poll(A1);
  check(ok(pr) && pr.data.grants.length === 0 && pr.data.holdMs >= HOLD_MS - 300, `with nothing to hand over, the hold runs out (${pr.data?.holdMs} ms)`, msg(pr));
  const held = H.map((h) => poll(h));
  await sleep(700);
  r = await poll(A1);
  check(ok(r) && r.data.retryAfterMs === 5000 && r.data.holdMs === 0 && r.ms < 1500, 'three polls held (MSA_POLL_MAX=3): a fourth computer is told to retry, at once', msg(r));
  await Promise.all(held);

  section('Expiry, cancellation and the pause');
  r = await req('POST', `/msa/grants/test/${A1.id}`, { s: SAd, body: {} });
  const g4 = r.data;
  r = await req('POST', `/msa/grants/test/${A1.id}`, { s: SAd, body: {} });
  const g5 = r.data;
  check((await prisma.msaGrant.findUnique({ where: { id: g4.grantId } })).state === 'cancelled', 'a newer grant cancels the older undelivered one');
  r = await poll(A1, { wait: false, ack: [g4.grantId] });
  check(ok(r) && r.data.acked === 0 && r.data.grants.length === 1 && G.verifyEnvelope(r.data.grants[0], ctxFor(A1)).grant?.grantId === g5.grantId, 'a cancelled grant cannot be acked, and only the newer one is handed over', msg(r));
  // Test-only: move g5's window into the past (the CHECK still holds: five minutes).
  await prisma.msaGrant.update({ where: { id: g5.grantId }, data: { notBefore: new Date(Date.now() - 11 * 60_000), notAfter: new Date(Date.now() - 6 * 60_000) } });
  r = await poll(A1, { wait: false, ack: [g5.grantId] });
  check(ok(r) && r.data.acked === 0 && r.data.grants.length === 0 && (await prisma.msaGrant.findUnique({ where: { id: g5.grantId } })).state === 'expired',
    'past its window: not acked, not handed over, marked expired', msg(r));
  r = await req('POST', `/msa/grants/test/${A1.id}`, { s: SAd, body: {} });
  const g6 = r.data;
  const pA = await prisma.containmentPause.create({ data: { scope: 'BUSINESS', customerId: bizA.id, kinds: ['remote'], reason: 'e2e msa grants', setById: admin.id, setBy: 'msp' } });
  created.pauses.push(pA.id);
  r = await poll(A1);
  check(ok(r) && r.data.paused === true && r.data.grants.length === 0 && r.data.holdMs === 0, 'a `remote` pause set after issuing: the grant is withheld, at once', msg(r));
  await prisma.containmentPause.update({ where: { id: pA.id }, data: { clearedAt: new Date(), clearedById: admin.id, clearReason: 'e2e' } });
  r = await poll(A1, { wait: false });
  check(ok(r) && r.data.grants.length === 1 && G.verifyEnvelope(r.data.grants[0], ctxFor(A1)).grant?.grantId === g6.grantId, 'lifted: handed over', msg(r));
  r = await req('GET', `/msa/grants/endpoint/${A1.id}`, { s: SAdmin });
  const states = Object.fromEntries((r.data ?? []).map((x) => [x.grantId, x.state]));
  check(ok(r) && states[g1.grantId] === 'delivered' && states[g4.grantId] === 'cancelled' && states[g5.grantId] === 'expired' && states[g6.grantId] === 'issued',
    'the list shows delivered, cancelled, expired and issued', J(states));

  section('The database holds the rules too');
  const tryInsert = async (over) => {
    try {
      await prisma.msaGrant.create({ data: {
        id: randomBytes(16).toString('hex'), endpointId: A1.id, businessId: bizA.id, technicianId: admin.id, keyId: keyRow.keyId, mode: 'view',
        permissions: view.permissions, consent: 'required', notBefore: new Date(), notAfter: new Date(Date.now() + 60_000), maxMinutes: 60, idleMinutes: 15,
        envelopeEnc: `${'a'.repeat(24)}:${'b'.repeat(32)}:cc`, passwordEnc: `${'a'.repeat(24)}:${'b'.repeat(32)}:cc`, ...over } });
      return false;
    } catch { return true; }
  };
  check(await tryInsert({ notAfter: new Date(Date.now() + 6 * 60_000) }), 'a six-minute window is refused (CHECK)');
  check(await tryInsert({ state: 'applied' }), 'state "applied" (step 4) is refused (CHECK)');
  check(await tryInsert({ state: 'delivered' }), 'delivered without deliveredAt is refused (CHECK)');
  check(await tryInsert({ envelopeEnc: '{"keyId":"x"}' }), 'an unsealed envelope is refused (CHECK)');
  check(await tryInsert({ permissions: { ...view.permissions, keyboard: true } }), 'an unknown permission is refused (CHECK)');
  let refused = false;
  try { await prisma.msaGrantKey.create({ data: { keyId: 'f'.repeat(16), publicKey: `${'A'.repeat(43)}=`, privateKeyEnc: `${'a'.repeat(24)}:${'b'.repeat(32)}:cc` } }); } catch { refused = true; }
  check(refused, 'a second active key is refused (partial unique index)');
}

try {
  await all();
} catch (err) {
  fail++; failures.push(String(err?.stack ?? err));
  console.error(err);
  if (api?.log) console.error(api.log.slice(-2000));
} finally {
  await stopApi();
  const ids = created.endpoints;
  await prisma.msaGrant.deleteMany({ where: { endpointId: { in: ids } } }).catch(() => {});
  await prisma.containmentPause.deleteMany({ where: { id: { in: created.pauses } } }).catch(() => {});
  // Suites that sweep every computer must not find these online.
  await prisma.endpoint.updateMany({ where: { id: { in: ids } }, data: { status: 'ARCHIVED', isOnline: false, lastSeenAt: new Date(Date.now() - 24 * 3600_000) } }).catch(() => {});
  await prisma.$disconnect();
}
console.log(`\nmsa grants: ${pass} passed, ${fail} failed`);
if (fail) { for (const f of failures) console.error(`  ✗ ${f}`); process.exit(1); }
