#!/usr/bin/env node
/**
 * End-to-end proof of Managed Secure Access build step 4 (0.72,
 * check-security-invariants §82) through the real routes: cutover, the
 * managed test session, confirmation, enforcement reports and rollback.
 *
 *   - with MSA_GRANTS anything but exactly 'on', every new route is 404
 *     MSA_NOT_ENABLED and the heartbeat never says msaPoll, even for a
 *     computer that has a managed row;
 *   - cutover is a Platform Admin's, with a fresh confirmation (msa.cutover),
 *     for ONE computer, and refused for: a Business Owner, a computer that is
 *     not Compatible, an agent older than 0.72, a pooled computer, a `remote`
 *     pause, a grant key not yet in the signed release metadata, a computer
 *     already managed;
 *   - the heartbeat says msaPoll only to a managed computer's authenticated
 *     signed agent; a staged legacy rotation waits while a grant is in flight
 *     and while the computer is verified or rolling back;
 *   - a test grant to a managed computer is refused above the view-only
 *     ceiling; the agent's reports (device secret first) move the grant and
 *     the computer; the one-time password is shown once, to a Platform Admin
 *     with a fresh confirmation (msa.reveal), only after it was applied;
 *     confirm needs a session that connected; verified refuses legacy
 *     Connect and Reveal; drift is an enforcement failure;
 *   - rollback is a Platform Admin's and never asks; the computer returns to
 *     Legacy when the agent reports restored (or by force, only once rolling
 *     back), and a rotation is then handed over;
 *   - no audit row carries a password, and the database refuses a pooled
 *     computer and the states the service never writes.
 *
 *   cd apps/api && npx nest build
 *   DATABASE_URL=postgresql://…/<name containing scratch or test> node scripts/e2e-msa-managed.mjs
 *
 * Self-starting: its API runs from dist/ on MSA_MANAGED_API_PORT (3961), with
 * a stand-in signed update repository (unsigned metadata, as the portal reads
 * it: the agents verify, the portal only reads) in a temp directory.
 * INTEGRATION, not Windows: the agent's side is posted the way the signed
 * agent's poller (internal/msa/enforce) posts it; its RustDesk side is
 * proven by the Go tests and the Windows lab (TestLabRustdeskEnforce).
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { confirmEverythingAsks } from './lib/confirm-asks.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const G = createRequire(import.meta.url)(path.join(dist, 'msa', 'grant.js'));
const DB = process.env.DATABASE_URL ?? '';
const dbName = DB.split('/').pop()?.split('?')[0] ?? '';
if (!/scratch|test/.test(dbName)) { console.error(`Refusing to run against database "${dbName}": name must contain "scratch" or "test".`); process.exit(2); }
const PORT = Number(process.env.MSA_MANAGED_API_PORT ?? 3961);
if ([3000, 3001, 3201, 3202, 4000, 4001, 443].includes(PORT)) { console.error(`Refusing port ${PORT}`); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'msa-managed-e2e-password-123';
const VERSION_FILE = path.resolve(here, '..', '..', '..', 'version.json');
const REPO = mkdtempSync(path.join(tmpdir(), 'rem0te-msa-managed-repo-'));

let pass = 0, fail = 0;
const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const J = (x) => JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

// ── A stand-in published repository: what UpdateTrustService reads ──────────
function writeRepo(grantKeys) {
  rmSync(REPO, { recursive: true, force: true });
  mkdirSync(path.join(REPO, 'metadata'), { recursive: true });
  const targets = {};
  if (grantKeys) {
    const body = Buffer.from(JSON.stringify({ schema: 'rem0te-msa-grant-keys/1', keys: grantKeys }));
    mkdirSync(path.join(REPO, 'targets', 'msa'), { recursive: true });
    writeFileSync(path.join(REPO, 'targets', 'msa', `${sha(body)}.grant-keys.json`), body);
    targets['msa/grant-keys.json'] = { length: body.length, hashes: { sha256: sha(body) } };
  }
  const m = (f, signed) => writeFileSync(path.join(REPO, 'metadata', f), JSON.stringify({ signed, signatures: [] }));
  m('root.json', { _type: 'root', version: 1 });
  m('1.root.json', { _type: 'root', version: 1 });
  m('timestamp.json', { _type: 'timestamp', version: 1, meta: { 'snapshot.json': { version: 1 } } });
  m('1.snapshot.json', { _type: 'snapshot', version: 1, meta: { 'targets.json': { version: 1 } } });
  m('1.targets.json', { _type: 'targets', version: 1, targets });
}
writeRepo(null);

const baseEnv = {
  ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATABASE_URL: DB,
  JWT_SECRET: randomBytes(32).toString('hex'), LAUNCHER_TOKEN_SECRET: randomBytes(32).toString('hex'),
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? randomBytes(32).toString('hex'), TRUSTED_PROXIES: 'loopback', HBBS_PRESENCE_HOST: '127.0.0.2',
  VERSION_FILE, MONITOR_SWEEP: 'off', AUDIT_SEALER: 'off', CLIENT_UPDATE_SWEEP: 'off', SNAPSHOT_SWEEP: 'off', PATCH_POLICY_SWEEP: 'off', METRIC_SWEEP: 'off',
  AUTO_MIGRATION_SWEEP: 'off', TRAY_SWEEP: 'off', RETENTION_SWEEP: 'off', CHAT_RETENTION_SWEEP: 'off', STALE_SWEEP: 'off', AGENT_AUTO_UPDATE: 'off',
  MSA_POLL_HOLD_MS: '1500', UPDATE_REPO_DIR: REPO,
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
  await sleep(20);
  const h = { 'content-type': 'application/json', 'x-forwarded-for': ip() };
  if (s) h.cookie = s.cookie;
  const r = await fetch(`${API}${p}`, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j, data: j?.data, text };
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
const msg = (r) => `HTTP ${r.status} ${(typeof r.body === 'string' ? r.body : J(r.body)).slice(0, 500)}`;
const code = (r) => r.body?.code ?? r.body?.message?.code ?? r.body?.error?.code;
const ok = (r) => r.status === 200 || r.status === 201;
const notEnabled = (r) => r.status === 404 && code(r) === 'MSA_NOT_ENABLED';

const KEYS = ['access-mode', 'enable-keyboard', 'enable-clipboard', 'enable-file-transfer', 'enable-audio', 'enable-tunnel', 'enable-remote-restart',
  'approve-mode', 'verification-method', 'allow-auto-disconnect', 'auto-disconnect-timeout'];
const at = (msAgo) => new Date(Date.now() - msAgo).toISOString().replace(/\.\d{3}Z$/, 'Z');
const preflight = () => ({
  schema: 'rem0te-rustdesk-preflight/1', checkedAt: at(30_000), installed: true, expectedPath: true, version: '1.4.7+65', build: 'flutter',
  service: 'running', cli: 'ok', keys: Object.fromEntries(KEYS.map((k) => [k, 'ok'])), durationMs: 1400,
});
const live = { loggedOnUser: 'PC\\user', uptimeSeconds: 7200, cpuLoadPercent: 4, memoryTotalMb: 16000, memoryFreeMb: 9000, rustdeskSessions: 0 };
const signedBeat = (ep, extra = {}) => req('POST', '/enrollment/heartbeat', { body: {
  rustdeskId: ep.rid, agentSecret: ep.secret, hostname: ep.hostname, platform: 'Windows', agentVersion: ep.agentVersion ?? '0.72.0', rustdeskVersion: '1.4.7',
  updateChannel: 'signed', trustRootVersion: 1, targetsVersion: 7, agentSha256: 'c'.repeat(64), agentActions: ['windows.spooler.start@1'], ...live, ...extra } });
const standardBeat = (ep, extra = {}) => req('POST', '/enrollment/heartbeat', { body: {
  rustdeskId: ep.rid, agentSecret: ep.secret, hostname: ep.hostname, platform: 'Windows', agentVersion: '0.68.3', rustdeskVersion: '1.4.7',
  updateChannel: 'legacy', ...live, ...extra } });
const poll = (ep, extra = {}) => req('POST', '/msa/agent/poll', { body: { rustdeskId: ep.rid, agentSecret: ep.secret, wait: false, ...extra } });
const report = (ep, body) => req('POST', '/msa/agent/report', { body: { rustdeskId: ep.rid, agentSecret: ep.secret, ...body } });
const managedRow = (ep) => prisma.msaManagedComputer.findUnique({ where: { endpointId: ep.id } });

const created = { businesses: [], users: [], pauses: [], endpoints: [] };

async function all() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });
  await confirmEverythingAsks(prisma);

  section('Fixtures (synthetic): business A, a Platform Admin, its owner; signed (0.72 and 0.71), standard and pooled computers');
  const bizA = await prisma.customer.create({ data: { tenantId: tenant.id, name: `MSA-M A ${sfx}` } });
  created.businesses.push(bizA.id);
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag, biz, role, admin = false) => {
    const u = await prisma.user.create({ data: { email: `msam-${tag}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'Msam', lastName: tag, status: 'ACTIVE', isPlatformAdmin: admin } });
    created.users.push(u.id);
    if (biz) await prisma.membership.create({ data: { userId: u.id, tenantId: tenant.id, customerId: biz.id, roleId: role.id, capabilities: [] } });
    return u;
  };
  const admin = await mkUser('admin', null, null, true);
  const owner = await mkUser('owner', bizA, roleOwner);
  const mkEp = async (hostname, { channel = 'signed', pooled = false, agentVersion = '0.72.0' } = {}) => {
    const e = await prisma.endpoint.create({ data: {
      tenantId: pooled ? null : tenant.id, customerId: pooled ? null : bizA.id, name: hostname, hostname, platform: 'Windows', status: pooled ? 'PENDING_ENROLLMENT' : 'ACTIVE',
      isOnline: true, isManaged: true, accessMode: 'COMPANY_WIDE', lastSeenAt: new Date(), agentVersion, updateChannel: channel,
      signedSeenAt: channel === 'signed' ? new Date() : null, deviceClass: 'WORKSTATION' } });
    const rid = String(100000000 + ((Math.random() * 899999999) | 0));
    const secret = randomBytes(24).toString('hex');
    await prisma.rustdeskNode.create({ data: { tenantId: pooled ? null : tenant.id, endpointId: e.id, rustdeskId: rid, version: '1.4.7', agentSecretHash: sha(secret) } });
    created.endpoints.push(e.id);
    return { id: e.id, rid, secret, hostname, agentVersion };
  };
  const A1 = await mkEp(`MSAM-A1-${sfx}`);
  const A2 = await mkEp(`MSAM-A2-OLD-${sfx}`, { agentVersion: '0.71.0' });
  const A3 = await mkEp(`MSAM-A3-STD-${sfx}`, { channel: 'legacy', agentVersion: '0.68.3' });
  const A4 = await mkEp(`MSAM-A4-${sfx}`);
  const P1 = await mkEp(`MSAM-POOL-${sfx}`, { pooled: true });

  // ── Off ───────────────────────────────────────────────────────────────────
  section('MSA_GRANTS unset: every new route is 404 MSA_NOT_ENABLED; the heartbeat never says msaPoll, even for a managed row');
  await startApi({});
  {
    const SAd = await stepUp(await login(admin.email));
    for (const [m, p, b] of [
      ['GET', `/msa/managed/${A1.id}`], ['POST', `/msa/managed/${A1.id}/cutover`], ['POST', `/msa/managed/${A1.id}/confirm`],
      ['POST', `/msa/managed/${A1.id}/rollback`, {}], ['POST', `/msa/managed/grants/${'a'.repeat(32)}/reveal`], ['POST', '/msa/grants/keys'],
    ]) {
      const r = await req(m, p, { s: SAd, body: b });
      check(notEnabled(r), `${m} ${p.replace(A1.id, ':id')} as a confirmed Platform Admin: 404 MSA_NOT_ENABLED`, msg(r));
    }
    let r = await report(A1, { event: 'secured' });
    check(notEnabled(r), 'POST /msa/agent/report with the right secret: 404', msg(r));
    r = await req('POST', '/msa/agent/report', { body: { junk: 1 } });
    check(notEnabled(r), 'and with a malformed body: 404, not 400', msg(r));
    await prisma.msaManagedComputer.create({ data: { endpointId: A4.id, state: 'pending', requestedById: admin.id } });
    r = await signedBeat(A4, { rustdeskPreflight: preflight() });
    check(ok(r) && r.data.authenticated === true && r.data.msaPoll === undefined, 'a managed computer\'s signed heartbeat with the switch off: no msaPoll', msg(r));
    await prisma.msaManagedComputer.delete({ where: { endpointId: A4.id } });
    check(await prisma.msaManagedComputer.count({ where: { endpointId: { in: created.endpoints } } }) === 0, 'no managed row was written by any route');
  }
  await stopApi();

  // ── On ────────────────────────────────────────────────────────────────────
  await startApi({ MSA_GRANTS: 'on' });
  const SAdmin = await login(admin.email);
  const SAd = await stepUp(SAdmin);
  const SO = await login(owner.email);
  await prisma.msaGrantKey.updateMany({ where: { retiredAt: null }, data: { retiredAt: new Date() } });

  section('Cutover: who, and the gates');
  let r = await req('POST', `/msa/managed/${A1.id}/cutover`, { s: SO });
  check(r.status === 403, 'a Business Owner: 403', msg(r));
  r = await req('POST', `/msa/managed/${A1.id}/cutover`, { s: SAdmin });
  check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED' && r.body?.action === 'msa.cutover', 'a Platform Admin without a fresh confirmation: STEP_UP_REQUIRED naming msa.cutover', msg(r));
  r = await req('POST', `/msa/managed/${A1.id}/cutover`, { s: SAd });
  check(r.status === 409 && code(r) === 'MSA_NOT_COMPATIBLE', 'no preflight yet: 409 MSA_NOT_COMPATIBLE', msg(r));
  r = await req('GET', `/msa/managed/${A1.id}`, { s: SAdmin });
  check(ok(r) && r.data.state === 'legacy' && r.data.cutover.allowed === false && r.data.cutover.blockers.some((b) => b.code === 'MSA_GRANT_KEY_NOT_PUBLISHED'),
    'the view says Legacy, and why cutover is not allowed (including the unpublished key)', msg(r));
  for (const ep of [A1, A2]) {
    r = await signedBeat(ep, { rustdeskPreflight: preflight() });
    check(ok(r) && r.data.rustdeskPreflightAck && r.data.msaPoll === undefined, `${ep === A1 ? 'A1' : 'A2'}: a signed heartbeat with a preflight; not managed, so no msaPoll`, msg(r));
  }
  r = await req('GET', `/msa/readiness/${A1.id}`, { s: SO });
  check(ok(r) && r.data.readiness.state === 'compatible', 'A1 is Compatible now', msg(r));
  r = await req('POST', `/msa/managed/${A1.id}/cutover`, { s: SAd });
  check(r.status === 409 && code(r) === 'MSA_GRANT_KEY_NOT_PUBLISHED', 'Compatible, but no grant key in the signed metadata: 409 MSA_GRANT_KEY_NOT_PUBLISHED', msg(r));

  r = await req('POST', '/msa/grants/keys', { s: SAdmin });
  check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED', 'making the grant key without a fresh confirmation: refused', msg(r));
  r = await req('POST', '/msa/grants/keys', { s: SAd });
  const key = r.data;
  check(ok(r) && G.KEY_ID_RE.test(key?.keyId ?? '') && key.published === false && key.commands.length === 2
    && key.commands[0] === `sudo rem0te-signed-grant-key add --key-id ${key.keyId} --public-key ${key.publicKey}` && key.commands[1] === 'sudo rem0te-signed-publish --republish',
    'POST /msa/grants/keys: the key exists, not published, with the owner\'s two commands', msg(r));
  writeRepo([{ keyId: key.keyId, publicKey: key.publicKey }]);
  r = await req('GET', '/msa/grants/keys', { s: SAdmin });
  check(ok(r) && r.data.find((k) => k.keyId === key.keyId)?.published === true && r.data.find((k) => k.keyId === key.keyId)?.commands.length === 0,
    'once msa/grant-keys.json is published with it: published, no commands', msg(r));

  r = await req('POST', `/msa/managed/${A2.id}/cutover`, { s: SAd });
  check(r.status === 409 && code(r) === 'MSA_AGENT_TOO_OLD', 'A2 (agent 0.71.0, Compatible): 409 MSA_AGENT_TOO_OLD', msg(r));
  r = await req('POST', `/msa/managed/${A3.id}/cutover`, { s: SAd });
  check(r.status === 409 && code(r) === 'MSA_SIGNED_AGENT_REQUIRED', 'A3 (standard agent): 409 MSA_SIGNED_AGENT_REQUIRED', msg(r));
  r = await req('POST', `/msa/managed/${P1.id}/cutover`, { s: SAd });
  check(r.status === 403 || r.status === 404, `a pooled computer: refused (HTTP ${r.status})`, msg(r));
  const pause = await prisma.containmentPause.create({ data: { scope: 'BUSINESS', customerId: bizA.id, kinds: ['remote'], reason: 'e2e msa managed', setById: admin.id, setBy: 'msp' } });
  created.pauses.push(pause.id);
  r = await req('POST', `/msa/managed/${A1.id}/cutover`, { s: SAd });
  check(r.status === 403 && code(r) === 'CONTAINED', 'a `remote` pause on the business: 403 CONTAINED', msg(r));
  await prisma.containmentPause.update({ where: { id: pause.id }, data: { clearedAt: new Date(), clearedById: admin.id, clearReason: 'e2e' } });
  check(await prisma.msaManagedComputer.count({ where: { endpointId: { in: created.endpoints } } }) === 0, 'every refusal wrote nothing');

  r = await req('POST', `/msa/managed/${A1.id}/cutover`, { s: SAd });
  check(ok(r) && r.data.state === 'pending', 'A1: moved to Managed (pending)', msg(r));
  const cut = await prisma.activityLog.findFirst({ where: { action: 'MSA_CUTOVER', resourceId: A1.id }, orderBy: { createdAt: 'desc' } });
  check(!!cut && cut.actorId === admin.id && cut.customerId === bizA.id && cut.metadata.endpointId === A1.id && cut.metadata.before === 'legacy' && cut.metadata.after === 'pending' && Object.keys(cut.metadata).length === 3, 'MSA_CUTOVER audited: who, before and after', J(cut?.metadata));
  r = await req('POST', `/msa/managed/${A1.id}/cutover`, { s: SAd });
  check(r.status === 409 && code(r) === 'MSA_ALREADY_MANAGED', 'a second cutover: 409 MSA_ALREADY_MANAGED', msg(r));
  r = await req('GET', `/msa/readiness/${A1.id}`, { s: SO });
  check(ok(r) && r.data.readiness.state === 'managed' && r.data.readiness.label === 'Managed (pending)' && r.data.readiness.verified === false && /only in the Windows lab/.test(r.data.note),
    'readiness: Managed (pending), not verified, the lab-only note', msg(r));

  section('The heartbeat: msaPoll only for the managed computer');
  r = await signedBeat(A1);
  check(ok(r) && r.data.msaPoll === true, 'A1\'s signed heartbeat: msaPoll true', msg(r));
  r = await signedBeat(A4);
  check(ok(r) && r.data.msaPoll === undefined, 'A4 (signed, not managed): no msaPoll', msg(r));
  r = await standardBeat(A3);
  check(ok(r) && r.data.msaPoll === undefined, 'A3 (standard): no msaPoll', msg(r));
  r = await req('POST', '/enrollment/heartbeat', { body: { rustdeskId: A1.rid, agentSecret: 'f'.repeat(48), hostname: A1.hostname, platform: 'Windows', updateChannel: 'signed', agentVersion: '0.72.0', ...live } });
  check(r.data?.msaPoll === undefined, `A1 with a wrong secret (HTTP ${r.status}): no msaPoll`, msg(r));

  section('The managed test session');
  r = await req('POST', `/msa/grants/test/${A1.id}`, { s: SAd, body: { mode: 'control' } });
  check(r.status === 409 && code(r) === 'MSA_ABOVE_CEILING', 'a control grant to a managed computer: 409 MSA_ABOVE_CEILING', msg(r));
  r = await req('POST', `/msa/grants/test/${A1.id}`, { s: SAd, body: { permissions: { files: true } } });
  check(r.status === 409 && code(r) === 'MSA_ABOVE_CEILING', 'view with files: 409 MSA_ABOVE_CEILING', msg(r));
  r = await req('POST', `/msa/grants/test/${A1.id}`, { s: SAd, body: { mode: 'view', consent: 'required', maxMinutes: 30, idleMinutes: 10 } });
  const g1 = r.data;
  check(ok(r) && g1.state === 'issued', 'a view-only test grant: issued', msg(r));
  r = await req('POST', `/endpoints/${A1.id}/rotate-credential`, { s: SAdmin });
  check(ok(r), 'a legacy rotation can still be staged while pending', msg(r));
  r = await signedBeat(A1);
  check(ok(r) && !r.data.rotate, 'but the heartbeat holds it while a grant is in flight', msg(r));

  r = await poll(A1);
  const env = r.data?.grants?.[0];
  check(ok(r) && r.data.grants.length === 1 && r.data.endpointId === A1.id && J(r.data.managed) === J({ state: 'pending', rollback: false }), 'the poll: the grant, the endpoint id, managed pending', msg(r));
  const keys = new Map([[key.keyId, Buffer.from(key.publicKey, 'base64')]]);
  const v = G.verifyEnvelope(env, { keys, endpointId: A1.id, rustdeskId: A1.rid, now: Date.now(), seen: new Set(), remotePaused: false,
    ceiling: { mode: 'view', permissions: { clipboard: false, files: false, audio: false, tunnel: false, restart: false } } });
  check(v.ok && v.grant.grantId === g1.grantId, 'it verifies under the published key and the view-only ceiling', J(v));
  const otp = v.grant?.password;
  await poll(A1, { ack: [g1.grantId] });

  r = await req('POST', `/msa/managed/grants/${g1.grantId}/reveal`, { s: SAd });
  check(r.status === 409 && code(r) === 'MSA_GRANT_NOT_APPLIED', 'reveal before the agent applied it: 409 MSA_GRANT_NOT_APPLIED', msg(r));
  r = await req('POST', `/msa/managed/${A1.id}/confirm`, { s: SAd });
  check(r.status === 409 && code(r) === 'MSA_NO_TEST_SESSION', 'confirm before a test session: 409 MSA_NO_TEST_SESSION', msg(r));

  r = await req('POST', '/msa/agent/report', { body: { rustdeskId: A1.rid, agentSecret: 'f'.repeat(48), event: 'applied', grantId: g1.grantId } });
  check(r.status === 401, 'a report with a wrong secret: 401', msg(r));
  r = await report(A1, { event: 'applied', grantId: g1.grantId, password: otp });
  check(r.status === 400 && code(r) === 'MSA_REPORT_INVALID', 'a report carrying a password field: 400, nothing recorded', msg(r));
  r = await report(A3, { event: 'secured' });
  check(r.status === 403 && code(r) === 'MSA_SIGNED_AGENT_REQUIRED', 'a standard agent\'s report: 403', msg(r));
  r = await report(A4, { event: 'applied', grantId: g1.grantId });
  check(ok(r) && r.data.recorded === false && (await prisma.msaGrant.findUnique({ where: { id: g1.grantId } })).state === 'delivered', 'another computer reporting A1\'s grant: recorded nothing', msg(r));
  r = await report(A1, { event: 'applied', grantId: g1.grantId });
  let g = await prisma.msaGrant.findUnique({ where: { id: g1.grantId } });
  let row = await managedRow(A1);
  check(ok(r) && r.data.recorded === true && g.state === 'applied' && g.appliedAt && row.readbackOkAt, 'applied: the grant is applied, the computer\'s readback recorded', msg(r));
  r = await report(A1, { event: 'applied', grantId: g1.grantId });
  check(ok(r) && r.data.recorded === false, 'a repeated report changes nothing', msg(r));

  r = await req('POST', `/msa/managed/grants/${g1.grantId}/reveal`, { s: SO });
  check(r.status === 403, 'reveal as a Business Owner: 403', msg(r));
  r = await req('POST', `/msa/managed/grants/${g1.grantId}/reveal`, { s: SAdmin });
  check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED' && r.body?.action === 'msa.reveal', 'reveal without a fresh confirmation: STEP_UP_REQUIRED naming msa.reveal', msg(r));
  r = await req('POST', `/msa/managed/grants/${g1.grantId}/reveal`, { s: SAd });
  check(ok(r) && r.data.oneTimePassword === otp && r.data.shownOnce === true, 'reveal: the grant\'s one-time password, once', msg(r));
  r = await req('POST', `/msa/managed/grants/${g1.grantId}/reveal`, { s: SAd });
  check(r.status === 409 && code(r) === 'MSA_PASSWORD_ALREADY_REVEALED', 'a second reveal: 409 MSA_PASSWORD_ALREADY_REVEALED', msg(r));
  const rv = await prisma.activityLog.findFirst({ where: { action: 'MSA_PASSWORD_REVEALED', resourceId: A1.id } });
  check(!!rv && rv.metadata.grantId === g1.grantId && rv.metadata.endpointId === A1.id && Object.keys(rv.metadata).length === 2, 'MSA_PASSWORD_REVEALED audited with ids only', J(rv?.metadata));

  r = await report(A1, { event: 'connected', grantId: g1.grantId });
  check(ok(r) && r.data.recorded === true, 'connected: a RustDesk connection manager appeared', msg(r));
  r = await req('GET', `/msa/managed/${A1.id}`, { s: SAdmin });
  check(ok(r) && r.data.canConfirm === true && r.data.grants[0].connectedAt && !J(r.data).includes(otp), 'the view: can confirm, the grant connected, no password', msg(r));
  r = await report(A1, { event: 'ended', grantId: g1.grantId, outcome: 'disconnected' });
  g = await prisma.msaGrant.findUnique({ where: { id: g1.grantId } });
  check(ok(r) && g.state === 'ended' && g.outcome === 'disconnected' && g.endedAt, 'ended: disconnected', msg(r));
  const staged = await prisma.activityLog.findFirst({ where: { action: 'ENDPOINT_CREDENTIAL_ROTATION_STAGED', resourceId: A1.id, metadata: { path: ['source'], equals: 'msa_session_ended' } } });
  check(!!staged, 'a pending computer\'s ended session stages a legacy rotation (Legacy keeps working)');
  r = await signedBeat(A1);
  check(ok(r) && r.data.rotate?.password && r.data.msaPoll === true, 'and the heartbeat hands it over now that no grant is in flight', msg(r));
  const legacyPw = r.data?.rotate?.password;
  r = await req('POST', `/endpoints/${A1.id}/connect`, { s: SAd });
  check(r.status !== 403 || code(r) !== 'MSA_MANAGED', `pending: legacy Connect is not refused for Managed Secure Access (HTTP ${r.status})`, msg(r));

  section('Confirm: managed and verified');
  r = await req('POST', `/msa/managed/${A1.id}/confirm`, { s: SO });
  check(r.status === 403, 'a Business Owner: 403', msg(r));
  r = await req('POST', `/msa/managed/${A1.id}/confirm`, { s: SAdmin });
  check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED' && r.body?.action === 'msa.cutover', 'without a fresh confirmation: STEP_UP_REQUIRED naming msa.cutover', msg(r));
  r = await req('POST', `/msa/managed/${A1.id}/confirm`, { s: SAd });
  row = await managedRow(A1);
  check(ok(r) && row.state === 'verified' && row.verifiedById === admin.id, 'confirmed: verified', msg(r));
  check(!!(await prisma.activityLog.findFirst({ where: { action: 'MSA_VERIFIED', resourceId: A1.id } })), 'MSA_VERIFIED audited');
  r = await poll(A1);
  check(ok(r) && J(r.data.managed) === J({ state: 'verified', rollback: false }), 'the poll tells the agent: verified', msg(r));
  r = await report(A1, { event: 'secured' });
  row = await managedRow(A1);
  check(ok(r) && r.data.recorded === true && row.legacySecuredAt, 'secured: the legacy password replaced by one nobody is told', msg(r));
  r = await req('GET', `/msa/readiness/${A1.id}`, { s: SO });
  check(ok(r) && r.data.readiness.state === 'managed_verified' && r.data.readiness.verified === true, 'readiness: Managed and verified, verified true', msg(r));
  r = await req('GET', `/endpoints/${A1.id}/password`, { s: SAd });
  check(r.status === 409 && code(r) === 'MSA_MANAGED', 'verified: Reveal password is refused (409 MSA_MANAGED)', msg(r));
  r = await req('POST', `/endpoints/${A1.id}/connect`, { s: SAd });
  check(r.status === 403 && code(r) === 'MSA_MANAGED', 'verified: legacy Connect is refused (MSA_MANAGED)', msg(r));
  r = await req('POST', `/endpoints/${A1.id}/rotate-credential`, { s: SAdmin });
  check(r.status === 409 && code(r) === 'MSA_MANAGED', 'verified: rotating the legacy password is refused', msg(r));
  r = await signedBeat(A1);
  check(ok(r) && !r.data.rotate && r.data.msaPoll === true, 'the heartbeat hands over no rotation to a verified computer', msg(r));

  section('Enforcement failure');
  r = await report(A1, { event: 'checked' });
  check(ok(r) && r.data.recorded === true, 'checked: the hourly readback agreed', msg(r));
  r = await report(A1, { event: 'drift', keys: ['access-mode'] });
  row = await managedRow(A1);
  check(ok(r) && row.state === 'enforcement_failure' && row.failReason === 'drift' && J(row.failedKeys) === J(['access-mode']), 'drift: enforcement failure, with the key', msg(r));
  r = await req('GET', `/msa/readiness/${A1.id}`, { s: SO });
  check(ok(r) && r.data.readiness.state === 'enforcement_failure' && /drift \(access-mode\)/.test(r.data.readiness.reasons[0]), 'readiness: Enforcement failure, naming the key', msg(r));
  r = await req('POST', `/endpoints/${A1.id}/connect`, { s: SAd });
  check(r.status === 403 && code(r) === 'MSA_MANAGED', 'an enforcement failure on a verified computer still refuses legacy Connect (nothing weaker)', msg(r));
  r = await req('POST', `/msa/grants/test/${A1.id}`, { s: SAd, body: {} });
  const g2 = r.data;
  await poll(A1, { ack: [g2?.grantId] });
  r = await report(A1, { event: 'failed', grantId: g2?.grantId, outcome: 'readback_mismatch', keys: ['approve-mode'] });
  g = await prisma.msaGrant.findUnique({ where: { id: g2.grantId } });
  row = await managedRow(A1);
  check(ok(r) && g.state === 'failed' && g.outcome === 'readback_mismatch' && J(g.failedKeys) === J(['approve-mode']) && row.failReason === 'readback_mismatch',
    'a test grant whose readback disagreed: failed, keys recorded, still an enforcement failure', msg(r));
  r = await req('POST', `/msa/grants/test/${A1.id}`, { s: SAd, body: {} });
  const g3 = r.data;
  await poll(A1, { ack: [g3?.grantId] });
  r = await report(A1, { event: 'applied', grantId: g3?.grantId });
  row = await managedRow(A1);
  check(ok(r) && row.state === 'verified' && row.failReason === null, 'a later grant that applies and reads back: verified again', msg(r));
  await report(A1, { event: 'ended', grantId: g3?.grantId, outcome: 'no_connection' });

  section('Rollback');
  r = await req('POST', `/msa/managed/${A1.id}/rollback`, { s: SO, body: {} });
  check(r.status === 403, 'a Business Owner: 403', msg(r));
  r = await req('POST', `/msa/grants/test/${A1.id}`, { s: SAd, body: {} });
  const g4 = r.data;
  r = await req('POST', `/msa/managed/${A1.id}/rollback`, { s: SAdmin, body: {} });
  row = await managedRow(A1);
  check(ok(r) && row.state === 'rollback_pending' && row.rollbackRequestedById === admin.id, 'a Platform Admin with NO fresh confirmation: rolling back', msg(r));
  check((await prisma.msaGrant.findUnique({ where: { id: g4.grantId } })).state === 'cancelled', 'an undelivered grant is cancelled');
  check(!!(await prisma.activityLog.findFirst({ where: { action: 'MSA_ROLLBACK_REQUESTED', resourceId: A1.id } })), 'MSA_ROLLBACK_REQUESTED audited');
  r = await poll(A1);
  check(ok(r) && r.data.grants.length === 0 && J(r.data.managed) === J({ state: 'rollback_pending', rollback: true }), 'the poll: no grants, rollback true', msg(r));
  r = await req('POST', `/msa/grants/test/${A1.id}`, { s: SAd, body: {} });
  check(r.status === 409 && code(r) === 'MSA_ROLLBACK_PENDING', 'a test grant while rolling back: 409 MSA_ROLLBACK_PENDING', msg(r));
  r = await signedBeat(A1);
  check(ok(r) && !r.data.rotate, 'the staged rotation waits until the agent has restored RustDesk', msg(r));
  r = await req('POST', `/msa/managed/${A1.id}/rollback`, { s: SAdmin, body: {} });
  check(r.status === 409 && code(r) === 'MSA_ROLLBACK_PENDING', 'rollback again without force: 409', msg(r));
  r = await report(A1, { event: 'restore_failed', keys: ['access-mode'] });
  row = await managedRow(A1);
  check(ok(r) && row.state === 'rollback_pending' && row.failReason === 'restore_failed', 'restore_failed: still rolling back, recorded', msg(r));
  r = await report(A1, { event: 'restored' });
  check(ok(r) && r.data.recorded === true && !(await managedRow(A1)), 'restored: back to Legacy (no row)', msg(r));
  check(!!(await prisma.activityLog.findFirst({ where: { action: 'MSA_ROLLED_BACK', resourceId: A1.id, metadata: { path: ['forced'], equals: false } } })), 'MSA_ROLLED_BACK audited');
  r = await signedBeat(A1);
  check(ok(r) && r.data.rotate?.password && r.data.rotate.password !== legacyPw && r.data.msaPoll === undefined, 'the heartbeat: a fresh legacy password, and no msaPoll', msg(r));
  r = await poll(A1);
  check(ok(r) && r.data.managed === null, 'the poll: managed null (the poller exits)', msg(r));
  r = await req('GET', `/msa/readiness/${A1.id}`, { s: SO });
  check(ok(r) && r.data.readiness.state === 'compatible', 'readiness: Compatible again', msg(r));

  section('Forced rollback, only once rolling back');
  r = await req('POST', `/msa/managed/${A1.id}/cutover`, { s: SAd });
  check(ok(r) && r.data.state === 'pending', 'cut over again', msg(r));
  r = await req('POST', `/msa/managed/${A1.id}/rollback`, { s: SAdmin, body: { force: true } });
  check(ok(r) && (await managedRow(A1))?.state === 'rollback_pending', 'force on a pending computer only starts a rollback', msg(r));
  r = await req('POST', `/msa/managed/${A1.id}/rollback`, { s: SAdmin, body: { force: true } });
  check(ok(r) && !(await managedRow(A1)), 'force while rolling back: Legacy without the agent', msg(r));
  check(!!(await prisma.activityLog.findFirst({ where: { action: 'MSA_ROLLED_BACK', resourceId: A1.id, metadata: { path: ['forced'], equals: true } } })), 'audited as forced');

  section('No password anywhere it should not be');
  const rows = await prisma.activityLog.findMany({ where: { resourceId: { in: created.endpoints } } });
  const text = J(rows);
  check(!text.includes(otp) && (!legacyPw || !text.includes(legacyPw)), `${rows.length} audit rows: neither the one-time nor the legacy password`);
  const allGrants = J(await prisma.msaGrant.findMany({ where: { endpointId: { in: created.endpoints } } }));
  check(!allGrants.includes(otp), 'the grant rows hold the password only sealed');

  section('The database holds the rules too');
  const tryIns = async (data) => { try { await prisma.msaManagedComputer.create({ data: { requestedById: admin.id, ...data } }); await prisma.msaManagedComputer.delete({ where: { endpointId: data.endpointId } }); return false; } catch { return true; } };
  check(await tryIns({ endpointId: P1.id, state: 'pending' }), 'a pooled computer is refused (trigger)');
  check(await tryIns({ endpointId: A4.id, state: 'managed' }), 'an unknown state is refused (CHECK)');
  check(await tryIns({ endpointId: A4.id, state: 'verified' }), 'verified without verifiedAt is refused (CHECK)');
  check(await tryIns({ endpointId: A4.id, state: 'rollback_pending' }), 'rolling back without who asked is refused (CHECK)');
  check(await tryIns({ endpointId: A4.id, state: 'enforcement_failure', failedAt: new Date(), failReason: 'Free text!' }), 'a free-text failure reason is refused (CHECK)');
  check(await tryIns({ endpointId: A4.id, state: 'pending', failedKeys: ['custom-rendezvous-server'] }), 'an unknown key is refused (CHECK)');

  section('Switch off with a verified row: nothing new happens, and nothing weaker either');
  await prisma.msaManagedComputer.create({ data: { endpointId: A4.id, state: 'verified', requestedById: admin.id, verifiedAt: new Date(), verifiedById: admin.id } });
  await stopApi();
  await startApi({});
  {
    const S = await stepUp(await login(admin.email));
    r = await signedBeat(A4);
    check(ok(r) && r.data.msaPoll === undefined, 'no msaPoll with the switch off', msg(r));
    r = await poll(A4);
    check(notEnabled(r), 'the poll: 404 (the agent ends any session and exits)', msg(r));
    r = await req('GET', `/endpoints/${A4.id}/password`, { s: S });
    check(r.status === 409 && code(r) === 'MSA_MANAGED', 'Reveal still refused: its password is one nobody is told (turn the switch on and roll back)', msg(r));
  }
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
  await prisma.msaManagedComputer.deleteMany({ where: { endpointId: { in: ids } } }).catch(() => {});
  await prisma.msaGrant.deleteMany({ where: { endpointId: { in: ids } } }).catch(() => {});
  await prisma.containmentPause.deleteMany({ where: { id: { in: created.pauses } } }).catch(() => {});
  await prisma.endpoint.updateMany({ where: { id: { in: ids } }, data: { status: 'ARCHIVED', isOnline: false, lastSeenAt: new Date(Date.now() - 24 * 3600_000) } }).catch(() => {});
  rmSync(REPO, { recursive: true, force: true });
  await prisma.$disconnect();
}
console.log(`\nmsa managed: ${pass} passed, ${fail} failed`);
if (fail) { for (const f of failures) console.error(`  ✗ ${f}`); process.exit(1); }
