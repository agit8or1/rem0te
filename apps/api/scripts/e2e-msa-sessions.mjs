#!/usr/bin/env node
/**
 * End-to-end proof of Managed Secure Access build step 5 (0.73,
 * docs/managed-secure-access.md §3.2–§3.5, §3.11): Connect through a session
 * grant, revocation, session evidence and cutover runs, behind MSA_GRANTS.
 *
 *   - with the switch off every new route is 404 MSA_NOT_ENABLED and Legacy
 *     Connect is what it was;
 *   - Connect on a verified managed computer: the launch policy decides
 *     (a member gets control; an L2 technician gets view-only with consent,
 *     which Legacy refuses as unenforceable; control without a temporary
 *     grant is still refused), the grant is signed within the 0.73 ceiling,
 *     the agent reports received and applied, the one-time password goes to
 *     the technician's Connect script once, and never to anyone else;
 *   - refusals: Legacy computer, agent too old, agent not polling, another
 *     person's session, the apply timeout (revoked, fails closed);
 *   - revocation by session, technician, computer, business, a bulk list and
 *     the `remote` pause, each a signed revocation the agent's verifier
 *     accepts, ending only what it names; who may revoke;
 *   - the timeline never shows Launched as Connected;
 *   - cutover runs: a device group canary first, a batch per advance, each
 *     computer through its own blockers (one skipped), confirmation from the
 *     verification grant's readback, rollback of what the run moved; a
 *     business run halted; one open run per business;
 *   - no audit row, revocation or answer carries a password, and the
 *     database refuses the states the services never write.
 *
 *   cd apps/api && npx nest build
 *   DATABASE_URL=postgresql://…/<name containing scratch or test> node scripts/e2e-msa-sessions.mjs
 *
 * Self-starting: its API runs from dist/ on MSA_SESSIONS_API_PORT (3971),
 * with a stand-in signed update repository in a temp directory. INTEGRATION,
 * not Windows: the agent's side is posted the way the signed agent's poller
 * (internal/msa/enforce) posts it; its RustDesk side is the Go tests and the
 * Windows lab (TestLabRustdeskEnforce).
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
const req_ = createRequire(import.meta.url);
const G = req_(path.join(dist, 'msa', 'grant.js'));
const R = req_(path.join(dist, 'msa', 'revocation.js'));
const M = req_(path.join(dist, 'msa', 'managed.js'));
const DB = process.env.DATABASE_URL ?? '';
const dbName = DB.split('/').pop()?.split('?')[0] ?? '';
if (!/scratch|test/.test(dbName)) { console.error(`Refusing to run against database "${dbName}": name must contain "scratch" or "test".`); process.exit(2); }
const PORT = Number(process.env.MSA_SESSIONS_API_PORT ?? 3971);
if ([3000, 3001, 3201, 3202, 4000, 4001, 443].includes(PORT)) { console.error(`Refusing port ${PORT}`); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'msa-sessions-e2e-password-123';
const VERSION_FILE = path.resolve(here, '..', '..', '..', 'version.json');
const REPO = mkdtempSync(path.join(tmpdir(), 'rem0te-msa-sessions-repo-'));

let pass = 0, fail = 0;
const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const J = (x) => JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

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

async function req(method, p, { s, body, business } = {}) {
  await sleep(20);
  const h = { 'content-type': 'application/json', 'x-forwarded-for': ip() };
  if (s) h.cookie = s.cookie;
  if (business) h['x-rem0te-business'] = business;
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
  rustdeskId: ep.rid, agentSecret: ep.secret, hostname: ep.hostname, platform: 'Windows', agentVersion: ep.agentVersion, rustdeskVersion: '1.4.7',
  updateChannel: 'signed', trustRootVersion: 1, targetsVersion: 7, agentSha256: 'c'.repeat(64), agentActions: ['windows.spooler.start@1'], ...live, ...extra } });
const poll = (ep, extra = {}) => req('POST', '/msa/agent/poll', { body: { rustdeskId: ep.rid, agentSecret: ep.secret, wait: false, ...extra } });
const report = (ep, body) => req('POST', '/msa/agent/report', { body: { rustdeskId: ep.rid, agentSecret: ep.secret, ...body } });
const grantRow = (id) => prisma.msaGrant.findUnique({ where: { id } });
const managedRow = (ep) => prisma.msaManagedComputer.findUnique({ where: { endpointId: ep.id } });

const created = { businesses: [], users: [], pauses: [], endpoints: [], groups: [], tenantSettings: null, platformPin: undefined };

async function all() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });
  await confirmEverythingAsks(prisma);
  // The Connect script needs a relay host, and a pinned client version so
  // nothing asks GitHub. Both are put back afterwards.
  const ts = await prisma.tenantSettings.findFirst({ orderBy: { createdAt: 'asc' } });
  if (ts) {
    created.tenantSettings = { id: ts.id, rustdeskRelayHost: ts.rustdeskRelayHost, rustdeskPublicKey: ts.rustdeskPublicKey };
    await prisma.tenantSettings.update({ where: { id: ts.id }, data: { rustdeskRelayHost: 'relay.scratch.example.com', rustdeskPublicKey: '' } });
  }
  const ps = await prisma.platformSettings.findUnique({ where: { id: 'singleton' }, select: { rustdeskPinnedVersion: true } });
  if (ps) { created.platformPin = ps.rustdeskPinnedVersion; await prisma.platformSettings.update({ where: { id: 'singleton' }, data: { rustdeskPinnedVersion: '1.4.7' } }); }

  section('Fixtures (synthetic): businesses A and B, a Platform Admin, owners, an L2 technician; managed, legacy and run computers');
  const bizA = await prisma.customer.create({ data: { tenantId: tenant.id, name: `MSA-S A ${sfx}` } });
  const bizB = await prisma.customer.create({ data: { tenantId: tenant.id, name: `MSA-S B ${sfx}` } });
  created.businesses.push(bizA.id, bizB.id);
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag, biz, role, admin = false) => {
    const u = await prisma.user.create({ data: { email: `msas-${tag}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'Msas', lastName: tag, status: 'ACTIVE', isPlatformAdmin: admin } });
    created.users.push(u.id);
    if (biz) await prisma.membership.create({ data: { userId: u.id, tenantId: tenant.id, customerId: biz.id, roleId: role.id, capabilities: [] } });
    return u;
  };
  const admin = await mkUser('admin', null, null, true);
  const owner = await mkUser('owner', bizA, roleOwner);
  const ownerB = await mkUser('ownerb', bizB, roleOwner);
  const dana = await mkUser('dana-l2', null, null);
  const l2 = await prisma.technicianPreset.findUnique({ where: { key: 'l2-technician' } });
  await prisma.technicianAssignment.create({ data: { tenantId: tenant.id, customerId: bizA.id, userId: dana.id, presetId: l2.id, capabilities: [] } });
  const mkEp = async (hostname, biz, { agentVersion = '0.73.0' } = {}) => {
    const e = await prisma.endpoint.create({ data: {
      tenantId: tenant.id, customerId: biz.id, name: hostname, hostname, platform: 'Windows', status: 'ACTIVE',
      isOnline: true, isManaged: true, accessMode: 'COMPANY_WIDE', lastSeenAt: new Date(), agentVersion, updateChannel: 'signed',
      signedSeenAt: new Date(), deviceClass: 'WORKSTATION' } });
    const rid = String(100000000 + ((Math.random() * 899999999) | 0));
    const secret = randomBytes(24).toString('hex');
    await prisma.rustdeskNode.create({ data: { tenantId: tenant.id, endpointId: e.id, rustdeskId: rid, version: '1.4.7', agentSecretHash: sha(secret) } });
    created.endpoints.push(e.id);
    return { id: e.id, rid, secret, hostname, agentVersion };
  };
  const M1 = await mkEp(`MSAS-M1-${sfx}`, bizA);
  const M2 = await mkEp(`MSAS-M2-${sfx}`, bizA);
  const M3 = await mkEp(`MSAS-M3-OLD-${sfx}`, bizA, { agentVersion: '0.72.0' });
  const L1 = await mkEp(`MSAS-L1-${sfx}`, bizA);
  const C = [];
  for (let i = 1; i <= 5; i++) C.push(await mkEp(`MSAS-C${i}-${sfx}`, bizA));
  C.sort((a, b) => (a.id < b.id ? -1 : 1));
  const B = [];
  for (let i = 1; i <= 3; i++) B.push(await mkEp(`MSAS-B${i}-${sfx}`, bizB));
  B.sort((a, b) => (a.id < b.id ? -1 : 1));
  const grp = await prisma.endpointGroup.create({ data: { tenantId: tenant.id, customerId: bizA.id, name: `MSAS group ${sfx}` } });
  created.groups.push(grp.id);
  for (const c of C) await prisma.endpointGroupMember.create({ data: { endpointGroupId: grp.id, endpointId: c.id, addedById: admin.id } });
  // Readiness Compatible for every computer except C5-by-order (the last), which is never preflighted.
  const skipC = C[C.length - 1];
  const preflightAll = async () => { for (const ep of [M1, M2, M3, L1, ...C.filter((c) => c !== skipC), ...B]) await signedBeat(ep, { rustdeskPreflight: preflight() }); };
  const verified = async (ep) => prisma.msaManagedComputer.create({ data: {
    endpointId: ep.id, state: 'verified', requestedById: admin.id, verifiedAt: new Date(), verifiedById: admin.id, readbackOkAt: new Date(), legacySecuredAt: new Date() } });
  for (const ep of [M1, M2, M3]) await verified(ep);

  // ── Off ───────────────────────────────────────────────────────────────────
  section('MSA_GRANTS unset: every new route is 404 MSA_NOT_ENABLED; Legacy Connect is what it was');
  await startApi({});
  await preflightAll();
  {
    const SAd = await stepUp(await login(admin.email));
    const SO = await login(owner.email);
    const gid = 'a'.repeat(32);
    for (const [m, p, b] of [
      ['POST', `/msa/sessions/connect/${M1.id}`, { mode: 'control' }], ['GET', `/msa/sessions/grants/${gid}`], ['GET', `/msa/sessions/grants/${gid}/connect.cmd`],
      ['GET', `/msa/sessions/endpoint/${M1.id}`], ['GET', '/msa/sessions/active'], ['POST', `/msa/sessions/grants/${gid}/revoke`],
      ['POST', '/msa/sessions/revoke', { scope: 'computer', endpointId: M1.id }],
      ['GET', '/msa/cutover-runs'], ['POST', '/msa/cutover-runs', { scope: 'business', businessId: bizA.id }], ['GET', '/msa/cutover-runs/cmabcdefghijklmnopqrstuvw'],
      ['POST', '/msa/cutover-runs/cmabcdefghijklmnopqrstuvw/advance'], ['POST', '/msa/cutover-runs/cmabcdefghijklmnopqrstuvw/confirm'],
      ['POST', '/msa/cutover-runs/cmabcdefghijklmnopqrstuvw/halt'], ['POST', '/msa/cutover-runs/cmabcdefghijklmnopqrstuvw/rollback'],
    ]) {
      const r = await req(m, p, { s: SAd, body: b });
      check(notEnabled(r), `${m} ${p.replace(M1.id, ':id')} as a confirmed Platform Admin: 404 MSA_NOT_ENABLED`, msg(r));
    }
    let r = await poll(M1);
    check(notEnabled(r), 'the agent\'s poll: 404', msg(r));
    r = await req('POST', `/endpoints/${L1.id}/connect`, { s: SO });
    check(ok(r) && /^rem0te:\/\/connect\/[0-9a-f]{64}$/.test(r.data?.launchUri ?? ''), 'Legacy Connect on a Legacy computer: the launcher grant, as before', msg(r));
    r = await req('POST', `/endpoints/${M1.id}/connect`, { s: SO });
    check(r.status === 403 && code(r) === 'MSA_MANAGED', 'a verified managed computer with the switch off: still refused (nothing weaker)', msg(r));
    check(await prisma.msaGrant.count({ where: { endpointId: { in: created.endpoints } } }) === 0, 'no grant was written');
  }
  await stopApi();

  // ── On ────────────────────────────────────────────────────────────────────
  await startApi({ MSA_GRANTS: 'on' });
  const SAdmin = await login(admin.email);
  const SAd = await stepUp(SAdmin);
  const SO = await login(owner.email);
  const SOB = await login(ownerB.email);
  const SD = await login(dana.email);
  await prisma.msaGrantKey.updateMany({ where: { retiredAt: null }, data: { retiredAt: new Date() } });
  let r = await req('POST', '/msa/grants/keys', { s: SAd });
  const key = r.data;
  check(ok(r) && G.KEY_ID_RE.test(key?.keyId ?? ''), 'the grant key exists', msg(r));
  writeRepo([{ keyId: key.keyId, publicKey: key.publicKey }]);
  const keys = new Map([[key.keyId, Buffer.from(key.publicKey, 'base64')]]);
  const verifyGrant = (env, ep) => G.verifyEnvelope(env, { keys, endpointId: ep.id, rustdeskId: ep.rid, now: Date.now(), seen: new Set(), remotePaused: false, ceiling: M.MANAGED_CEILING });
  const verifyRev = (env, ep) => R.verifyRevocation(env, { keys, endpointId: ep.id, rustdeskId: ep.rid, now: Date.now(), seen: new Set() });
  /** The agent's side of one grant: poll, verify, ack, received, applied. */
  const agentApplies = async (ep, grantId) => {
    const p = await poll(ep);
    const env = (p.data?.grants ?? []).find((e) => verifyGrant(e, ep).grant?.grantId === grantId);
    const v = env ? verifyGrant(env, ep) : { ok: false };
    await poll(ep, { ack: [grantId] });
    const a = await report(ep, { event: 'received', grantId });
    const b = await report(ep, { event: 'applied', grantId });
    return { v, received: a.data?.recorded, applied: b.data?.recorded };
  };

  section('Refusals before anything is issued');
  r = await req('POST', `/msa/sessions/connect/${L1.id}`, { s: SO, body: {} });
  check(r.status === 409 && code(r) === 'MSA_NOT_MANAGED', 'a Legacy computer: 409 MSA_NOT_MANAGED (use the ordinary Connect)', msg(r));
  r = await req('POST', `/msa/sessions/connect/${M1.id}`, { s: SO, body: {} });
  check(r.status === 409 && code(r) === 'MSA_AGENT_NOT_POLLING', 'a verified computer whose agent has not polled: 409 MSA_AGENT_NOT_POLLING', msg(r));
  await poll(M1); await poll(M2); await poll(M3);
  r = await req('POST', `/msa/sessions/connect/${M3.id}`, { s: SO, body: {} });
  check(r.status === 409 && code(r) === 'MSA_AGENT_TOO_OLD', 'an 0.72 agent: 409 MSA_AGENT_TOO_OLD (it cannot be told to end a session)', msg(r));
  r = await req('POST', `/msa/sessions/connect/${M1.id}`, { s: SO, body: { mode: 'elevated' } });
  check(r.status === 400 && code(r) === 'MSA_MODE_INVALID', 'elevated: 400 (never through a grant)', msg(r));
  r = await req('POST', `/msa/sessions/connect/${M1.id}`, { s: SOB, body: {} });
  check(r.status === 404 || r.status === 403, `another business's owner: refused (HTTP ${r.status})`, msg(r));
  r = await req('POST', `/endpoints/${M1.id}/connect`, { s: SO });
  check(r.status === 403 && code(r) === 'MSA_MANAGED' && /roll it back to Legacy/.test(r.body?.message ?? '') && /Connect on the device's own page/.test(r.body?.message ?? ''),
    'Legacy Connect on a verified computer: refused, pointing to the managed Connect', msg(r));
  check(await prisma.msaGrant.count({ where: { endpointId: { in: created.endpoints } } }) === 0, 'every refusal issued nothing');

  section('Connect through a grant: a Business Owner, control');
  r = await req('POST', `/msa/sessions/connect/${M1.id}`, { s: SO, body: { mode: 'control' } });
  const c1 = r.data;
  check(ok(r) && G.GRANT_ID_RE.test(c1?.grantId ?? '') && c1.mode === 'control' && c1.consent === 'not_required' && c1.applyTimeoutMs === 60000
    && c1.permissions.audio === true && c1.permissions.tunnel === false && c1.permissions.restart === false && c1.permissions.clipboard === false && c1.permissions.files === false,
    'issued: control, audio, no tunnel or restart; clipboard and files off (the access controls say off by default); consent not applied to a member', msg(r));
  let g = await grantRow(c1.grantId);
  check(g.source === 'connect' && g.launchMode === 'control' && g.technicianId === owner.id && g.state === 'issued', 'the row: source connect, the launch mode, the technician, issued', J({ s: g.source, m: g.launchMode, st: g.state }));
  const reqAudit = await prisma.activityLog.findFirst({ where: { action: 'MSA_SESSION_REQUESTED', resourceId: M1.id }, orderBy: { createdAt: 'desc' } });
  const issAudit = await prisma.activityLog.findFirst({ where: { action: 'MSA_GRANT_ISSUED', resourceId: M1.id }, orderBy: { createdAt: 'desc' } });
  check(!!reqAudit && reqAudit.actorId === owner.id && reqAudit.metadata.path === 'member' && !!issAudit && issAudit.metadata.source === 'connect' && issAudit.metadata.grantId === c1.grantId,
    'audited: MSA_SESSION_REQUESTED (the policy path) and MSA_GRANT_ISSUED (source connect)', J({ reqAudit: reqAudit?.metadata, iss: issAudit?.metadata }));
  r = await req('GET', `/msa/sessions/grants/${c1.grantId}`, { s: SO });
  check(ok(r) && r.data.mine === true && r.data.ready === false && r.data.timeline.live === true && r.data.timeline.current === 'authorized'
    && r.data.timeline.cannotSee.length === 3, 'progress: authorized, not ready, live; the timeline says what the agent cannot see', msg(r));
  r = await req('GET', `/msa/sessions/grants/${c1.grantId}/connect.cmd`, { s: SO });
  check(r.status === 409 && code(r) === 'MSA_GRANT_NOT_APPLIED', 'the Connect script before the agent applied it: 409', msg(r));
  r = await req('POST', `/msa/sessions/connect/${M1.id}`, { s: SAd, body: {} });
  check(r.status === 409 && code(r) === 'MSA_SESSION_ACTIVE', 'a Platform Admin while the owner\'s session is live: 409 MSA_SESSION_ACTIVE', msg(r));

  let a = await agentApplies(M1, c1.grantId);
  const otp1 = a.v.grant?.password;
  check(a.v.ok && a.v.grant.mode === 'control' && a.v.grant.permissions.audio === true && a.received === true && a.applied === true,
    'the agent verifies it under the 0.73 ceiling, reports received, then applied', J({ v: a.v.ok ? 'ok' : a.v.reason, a }));
  g = await grantRow(c1.grantId);
  check(g.state === 'applied' && g.receivedAt && g.appliedAt && !g.launchedAt, 'the row: received and applied, not launched', J({ st: g.state }));
  r = await req('GET', `/msa/sessions/grants/${c1.grantId}`, { s: SO });
  check(ok(r) && r.data.ready === true && r.data.timeline.steps.map((x) => x.step).join() === 'requested,authorized,received,applied' && /ready to launch/.test(r.data.timeline.status),
    'progress: ready; Requested → Authorized → Received → Applied', msg(r));
  r = await req('GET', `/msa/sessions/grants/${c1.grantId}`, { s: SAdmin });
  check(ok(r) && r.data.ready === false && r.data.mine === false && r.data.canRevoke === true, 'a Platform Admin sees it, not ready for them, and may revoke it', msg(r));
  r = await req('GET', `/msa/sessions/grants/${c1.grantId}/connect.cmd`, { s: SAd });
  check(r.status === 404, 'the Connect script for someone else\'s session: 404', msg(r));
  r = await req('GET', `/msa/sessions/grants/${c1.grantId}/connect.cmd`, { s: SO });
  const pwB64 = otp1 ? Buffer.from(otp1, 'utf8').toString('base64') : '§';
  check(ok(r) && typeof r.body === 'string' && r.body.includes(pwB64) && r.body.includes(M1.rid), 'the Connect script: the session\'s one-time password and the RustDesk ID', `HTTP ${r.status}`);
  r = await req('GET', `/msa/sessions/grants/${c1.grantId}/connect.cmd`, { s: SO });
  check(r.status === 409 && code(r) === 'MSA_PASSWORD_ALREADY_RELEASED', 'a second time: 409 MSA_PASSWORD_ALREADY_RELEASED (once)', msg(r));
  const rel = await prisma.activityLog.findFirst({ where: { action: 'MSA_PASSWORD_RELEASED', resourceId: M1.id } });
  check(!!rel && rel.actorId === owner.id && J(Object.keys(rel.metadata).sort()) === J(['endpointId', 'grantId', 'via']), 'MSA_PASSWORD_RELEASED audited with ids only', J(rel?.metadata));
  r = await req('GET', `/msa/sessions/grants/${c1.grantId}`, { s: SO });
  check(ok(r) && r.data.timeline.current === 'launched' && /no connection seen yet/.test(r.data.timeline.status) && !r.data.timeline.steps.some((x) => x.step === 'connected'),
    'Launched is not Connected: no connection step until the agent sees one', msg(r));
  await report(M1, { event: 'connected', grantId: c1.grantId });
  r = await req('GET', `/msa/sessions/grants/${c1.grantId}`, { s: SO });
  check(ok(r) && r.data.timeline.current === 'connected' && /as the agent saw it/.test(r.data.timeline.status), 'connected: as the agent saw it', msg(r));
  r = await req('GET', `/msa/sessions/endpoint/${M1.id}`, { s: SO });
  check(ok(r) && r.data.sessions[0].grantId === c1.grantId && r.data.canRevokeAny === true && !J(r.data).includes(otp1), 'the device page\'s list: the session, no password; the owner may disconnect any', msg(r));
  r = await req('GET', '/msa/sessions/active', { s: SAdmin });
  check(ok(r) && r.data.sessions.some((s) => s.grantId === c1.grantId && s.endpoint.id === M1.id && s.endpoint.businessName === bizA.name), 'Managed sessions: the live session with its computer and business', msg(r));

  section('Revocation: the owner ends their own session');
  r = await req('POST', `/msa/sessions/grants/${c1.grantId}/revoke`, { s: SD, business: bizA.id });
  check(r.status === 403 && code(r) === 'MSA_REVOKE_NOT_ALLOWED', 'an L2 technician on someone else\'s session: 403', msg(r));
  r = await req('POST', `/msa/sessions/grants/${c1.grantId}/revoke`, { s: SO });
  g = await grantRow(c1.grantId);
  check(ok(r) && r.data.revoked === 1 && g.state === 'revoked' && g.revokeReason === 'session' && g.revokedById === owner.id, 'revoked: state, reason, who', msg(r));
  r = await poll(M1);
  const rev1 = r.data?.revocations?.[0];
  const rv1 = rev1 ? verifyRev(rev1, M1) : { ok: false, reason: 'none' };
  check(ok(r) && r.data.grants.length === 0 && rv1.ok && J(rv1.revocation.grantIds) === J([c1.grantId]) && rv1.revocation.all === false
    && R.revocationEnds(rv1.revocation, { grantId: c1.grantId, notBefore: G.isoSeconds(g.notBefore.getTime()) }),
    'the poll hands over a signed revocation the agent verifies, naming exactly that session', J({ rv1, n: r.data?.revocations?.length }));
  check(!G.verifyEnvelope({ keyId: rev1.keyId, grant: rev1.revocation, sig: rev1.sig }, { keys, endpointId: M1.id, rustdeskId: M1.rid, now: Date.now(), seen: new Set(), remotePaused: false, ceiling: M.MANAGED_CEILING }).ok,
    'its signature is not a grant\'s (its own prefix)');
  await poll(M1, { ack: [rv1.revocation.revocationId] });
  check((await prisma.msaRevocation.findUnique({ where: { id: rv1.revocation.revocationId } })).state === 'delivered', 'acked: delivered');
  r = await poll(M1);
  check(ok(r) && r.data.revocations.length === 0, 'not handed over again', msg(r));
  r = await report(M1, { event: 'ended', grantId: c1.grantId, outcome: 'revoked' });
  g = await grantRow(c1.grantId);
  check(ok(r) && r.data.recorded === true && g.state === 'revoked' && g.endedAt && g.outcome === 'revoked', 'the agent ended it: still revoked, now with endedAt', msg(r));
  r = await req('GET', `/msa/sessions/grants/${c1.grantId}`, { s: SO });
  check(ok(r) && r.data.timeline.current === 'revoked' && r.data.timeline.live === false && /ended on the computer/.test(r.data.timeline.status) && r.data.canRevoke === false,
    'the timeline: Revoked, ended on the computer, no longer live', msg(r));
  const ra = await prisma.activityLog.findFirst({ where: { action: 'MSA_SESSION_REVOKED', resourceId: M1.id } });
  check(!!ra && ra.actorId === owner.id && ra.metadata.reason === 'session' && J(ra.metadata.grantIds) === J([c1.grantId]), 'MSA_SESSION_REVOKED audited: who, why, which', J(ra?.metadata));

  section('An L2 technician: view-only with consent, enforceable only on a managed computer');
  r = await req('POST', `/endpoints/${L1.id}/connect?mode=view_only`, { s: SD, business: bizA.id });
  check(r.status === 403 && code(r) === 'ENDPOINT_CANNOT_ENFORCE_VIEW_ONLY', 'Legacy: view-only is still refused as unenforceable', msg(r));
  r = await req('POST', `/msa/sessions/connect/${M2.id}`, { s: SD, business: bizA.id, body: { mode: 'control' } });
  check(r.status === 403 && code(r) === 'TEMPORARY_GRANT_REQUIRED', 'managed, control without a temporary grant: still refused (TEMPORARY_GRANT_REQUIRED)', msg(r));
  r = await req('POST', `/msa/sessions/connect/${M2.id}`, { s: SD, business: bizA.id, body: { mode: 'view_only' } });
  const d1 = r.data;
  check(ok(r) && d1.mode === 'view' && d1.consent === 'required' && d1.maxMinutes <= 60 && Object.values(d1.permissions).every((x) => x === false),
    'managed, view-only: a view grant, consent required, the preset\'s session limit, nothing beyond', msg(r));
  a = await agentApplies(M2, d1.grantId);
  check(a.v.ok && a.v.grant.mode === 'view' && a.v.grant.consent === 'required' && a.applied === true, 'the agent verifies and applies it', J({ v: a.v.ok ? 'ok' : a.v.reason }));
  r = await req('POST', '/msa/sessions/revoke', { s: SD, business: bizA.id, body: { scope: 'computer', endpointId: M2.id } });
  check(r.status === 403 && code(r) === 'MSA_REVOKE_NOT_ALLOWED', 'the technician cannot end every session on a computer', msg(r));
  r = await req('POST', '/msa/sessions/revoke', { s: SO, body: { scope: 'technician', technicianId: dana.id } });
  check(ok(r) && r.data.revoked === 1 && r.data.computers === 1 && (await grantRow(d1.grantId)).revokeReason === 'technician', 'the owner ends the technician\'s sessions in the business', msg(r));
  r = await poll(M2);
  check(ok(r) && r.data.revocations.length === 1 && verifyRev(r.data.revocations[0], M2).ok, 'M2\'s agent is handed a verifiable revocation', msg(r));
  await poll(M2, { ack: r.data.revocations.map((x) => verifyRev(x, M2).revocation?.revocationId).filter(Boolean) });

  section('Revocation by computer, business and a bulk list; the remote pause; the timeout');
  r = await req('POST', `/msa/sessions/connect/${M1.id}`, { s: SO, body: {} });
  const c2 = r.data;
  await agentApplies(M1, c2.grantId);
  r = await req('POST', '/msa/sessions/revoke', { s: SO, body: { scope: 'computer', endpointId: M1.id } });
  g = await grantRow(c2.grantId);
  check(ok(r) && r.data.revoked === 1 && g.revokeReason === 'computer', 'every session on a computer (the owner)', msg(r));
  r = await poll(M1);
  let rv = verifyRev(r.data.revocations[0], M1);
  check(rv.ok && rv.revocation.all === true && rv.revocation.grantIds.includes(c2.grantId), 'a computer revocation is `all`, and names the session', J(rv));
  await poll(M1, { ack: [rv.revocation.revocationId] });

  r = await req('POST', `/msa/sessions/connect/${M1.id}`, { s: SO, body: {} });
  const c3 = r.data;
  r = await req('POST', `/msa/sessions/connect/${M2.id}`, { s: SO, body: {} });
  const c4 = r.data;
  await agentApplies(M1, c3.grantId); await agentApplies(M2, c4.grantId);
  r = await req('POST', '/msa/sessions/revoke', { s: SOB, body: { scope: 'business', businessId: bizA.id } });
  check(r.status === 403 && code(r) === 'MSA_REVOKE_NOT_ALLOWED', 'another business\'s owner cannot end business A\'s sessions', msg(r));
  r = await req('POST', '/msa/sessions/revoke', { s: SAdmin, body: { scope: 'business', businessId: bizA.id } });
  check(ok(r) && r.data.revoked === 2 && r.data.computers === 2 && (await grantRow(c3.grantId)).revokeReason === 'business' && (await grantRow(c4.grantId)).state === 'revoked',
    'a Platform Admin ends every session in business A: two computers, each its own revocation', msg(r));
  for (const ep of [M1, M2]) { const p = await poll(ep); await poll(ep, { ack: p.data.revocations.map((x) => verifyRev(x, ep).revocation?.revocationId).filter(Boolean) }); }

  r = await req('POST', `/msa/sessions/connect/${M1.id}`, { s: SO, body: {} });
  const c5 = r.data;
  r = await req('POST', `/msa/sessions/connect/${M2.id}`, { s: SO, body: {} });
  const c6 = r.data;
  r = await req('POST', '/msa/sessions/revoke', { s: SO, body: { scope: 'sessions', grantIds: [c5.grantId, c6.grantId, 'f'.repeat(32)] } });
  check(ok(r) && r.data.revoked === 2 && r.data.computers === 2, 'a bulk list (Managed sessions → Disconnect): two sessions on two computers, an unknown id ignored', msg(r));
  r = await req('POST', '/msa/sessions/revoke', { s: SO, body: { scope: 'sessions', grantIds: [] } });
  check(r.status === 400, 'an empty list: 400', msg(r));
  for (const ep of [M1, M2]) { const p = await poll(ep); await poll(ep, { ack: p.data.revocations.map((x) => verifyRev(x, ep).revocation?.revocationId).filter(Boolean) }); }

  r = await req('POST', `/msa/sessions/connect/${M1.id}`, { s: SO, body: {} });
  const c7 = r.data;
  await agentApplies(M1, c7.grantId);
  const pause = await prisma.containmentPause.create({ data: { scope: 'BUSINESS', customerId: bizA.id, kinds: ['remote'], reason: 'e2e msa sessions', setById: admin.id, setBy: 'msp' } });
  created.pauses.push(pause.id);
  r = await poll(M1);
  rv = r.data?.revocations?.[0] ? verifyRev(r.data.revocations[0], M1) : { ok: false };
  g = await grantRow(c7.grantId);
  check(ok(r) && r.data.paused === true && rv.ok && rv.revocation.all === true && rv.revocation.grantIds.includes(c7.grantId) && g.revokeReason === 'pause' && g.revokedById === null,
    'a `remote` pause: the next poll is paused AND carries a signed revocation of the open session (by the system)', J({ paused: r.data?.paused, rv, reason: g.revokeReason }));
  r = await req('POST', `/msa/sessions/connect/${M1.id}`, { s: SO, body: {} });
  check(r.status === 403 && code(r) === 'CONTAINED', 'Connect under the pause: 403 CONTAINED', msg(r));
  await poll(M1, { ack: [rv.revocation.revocationId] });
  await prisma.containmentPause.update({ where: { id: pause.id }, data: { clearedAt: new Date(), clearedById: admin.id, clearReason: 'e2e' } });

  r = await req('POST', `/msa/sessions/connect/${M1.id}`, { s: SO, body: {} });
  const c8 = r.data;
  await prisma.msaGrant.update({ where: { id: c8.grantId }, data: { createdAt: new Date(Date.now() - 61_000) } });
  r = await req('GET', `/msa/sessions/grants/${c8.grantId}`, { s: SO });
  check(ok(r) && r.data.state === 'revoked' && r.data.refused?.code === 'MSA_APPLY_TIMEOUT' && r.data.timeline.live === false && r.data.ready === false,
    'not applied within 60 s: revoked (timeout), refused with a reason, never ready (fails closed)', msg(r));
  r = await report(M1, { event: 'applied', grantId: c8.grantId });
  check(ok(r) && r.data.recorded === false && (await grantRow(c8.grantId)).state === 'revoked', 'a late `applied` changes nothing: still revoked', msg(r));
  r = await req('GET', `/msa/sessions/grants/${c8.grantId}/connect.cmd`, { s: SO });
  check(r.status === 409 && code(r) === 'MSA_GRANT_NOT_APPLIED', 'and its Connect script is refused', msg(r));
  { const p = await poll(M1); await poll(M1, { ack: p.data.revocations.map((x) => verifyRev(x, M1).revocation?.revocationId).filter(Boolean) }); }

  await prisma.msaManagedComputer.update({ where: { endpointId: M1.id }, data: { lastPollAt: new Date(Date.now() - 120_000) } });
  r = await req('POST', `/msa/sessions/connect/${M1.id}`, { s: SO, body: {} });
  check(r.status === 409 && code(r) === 'MSA_AGENT_NOT_POLLING', 'an agent that stopped polling (offline): refused, nothing issued', msg(r));
  await poll(M1);

  section('Cutover runs: a device group, canary first');
  const run1Body = { scope: 'group', businessId: bizA.id, groupId: grp.id, canaryEndpointId: C[0].id, batchSize: 2 };
  r = await req('POST', '/msa/cutover-runs', { s: SO, body: run1Body });
  check(r.status === 403, 'a Business Owner: 403', msg(r));
  r = await req('POST', '/msa/cutover-runs', { s: SAdmin, body: run1Body });
  check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED' && r.body?.action === 'msa.cutover', 'a Platform Admin without a fresh confirmation: STEP_UP_REQUIRED naming msa.cutover', msg(r));
  r = await req('POST', '/msa/cutover-runs', { s: SAd, body: { ...run1Body, batchSize: 26 } });
  check(r.status === 400 && code(r) === 'MSA_RUN_INVALID', 'a batch of 26: 400', msg(r));
  r = await req('POST', '/msa/cutover-runs', { s: SAd, body: run1Body });
  const run1 = r.data;
  check(ok(r) && run1.state === 'canary' && run1.canaryEndpointId === C[0].id && run1.counts.total === 5 && run1.counts.cut_over === 1 && run1.counts.queued === 4 && run1.next.allowed === false,
    'started: the canary cut over, four queued, the next batch not allowed yet', msg(r));
  const runRow = await managedRow(C[0]);
  check(runRow?.state === 'pending' && runRow.runId === run1.id, 'the canary: Managed (pending), moved by the run');
  check(!!(await prisma.activityLog.findFirst({ where: { action: 'MSA_CUTOVER_RUN_STARTED', resourceId: bizA.id } })), 'MSA_CUTOVER_RUN_STARTED audited');
  r = await req('POST', '/msa/cutover-runs', { s: SAd, body: run1Body });
  check(r.status === 409 && code(r) === 'MSA_RUN_OPEN', 'a second run for the business while one is open: 409', msg(r));
  r = await req('POST', `/msa/cutover-runs/${run1.id}/advance`, { s: SAd });
  check(r.status === 409 && code(r) === 'MSA_CANARY_NOT_VERIFIED', 'advance before the canary is verified: 409 MSA_CANARY_NOT_VERIFIED', msg(r));
  check(await prisma.msaManagedComputer.count({ where: { endpointId: { in: C.slice(1).map((c) => c.id) } } }) === 0, 'nothing else moved');

  // The canary's ordinary test session and confirmation.
  await poll(C[0]);
  r = await req('POST', `/msa/grants/test/${C[0].id}`, { s: SAd, body: {} });
  const t1 = r.data;
  a = await agentApplies(C[0], t1.grantId);
  check(a.applied === true, 'the canary\'s agent applied the test grant');
  await report(C[0], { event: 'connected', grantId: t1.grantId });
  await report(C[0], { event: 'ended', grantId: t1.grantId, outcome: 'disconnected' });
  r = await req('POST', `/msa/managed/${C[0].id}/confirm`, { s: SAd });
  check(ok(r) && (await managedRow(C[0])).state === 'verified', 'the canary: a test session that read back and connected, then confirmed: verified', msg(r));

  r = await req('POST', `/msa/cutover-runs/${run1.id}/advance`, { s: SAdmin });
  check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED', 'advance without a fresh confirmation: refused', msg(r));
  r = await req('POST', `/msa/cutover-runs/${run1.id}/advance`, { s: SAd });
  const b1 = (r.data?.members ?? []).filter((m) => m.batch === 1);
  check(ok(r) && r.data.state === 'rolling' && r.data.canaryVerifiedAt && b1.length === 2 && b1.every((m) => m.state === 'cut_over'), 'batch 1: two computers cut over', msg(r));
  for (const m of b1) {
    const row = await prisma.msaManagedComputer.findUnique({ where: { endpointId: m.endpointId } });
    const vg = await prisma.msaGrant.findFirst({ where: { endpointId: m.endpointId, source: 'verify' } });
    check(row?.state === 'pending' && row.runId === run1.id && vg?.mode === 'view' && vg.consent === 'required' && vg.maxMinutes === 5,
      `${m.name}: Managed (pending) through the run, with a five-minute view-only verification grant`);
    check(!!(await prisma.activityLog.findFirst({ where: { action: 'MSA_CUTOVER', resourceId: m.endpointId, metadata: { path: ['runId'], equals: run1.id } } })), `${m.name}: its own MSA_CUTOVER, naming the run`);
  }
  r = await req('POST', `/msa/cutover-runs/${run1.id}/advance`, { s: SAd });
  check(r.status === 409 && code(r) === 'MSA_BATCH_IN_PROGRESS', 'the next batch waits while the last has not read back', msg(r));
  r = await req('POST', `/msa/cutover-runs/${run1.id}/confirm`, { s: SAd });
  check(ok(r) && r.data.confirmed === 0, 'confirm before any readback: nothing confirmed', msg(r));
  for (const m of b1) {
    const ep = C.find((c) => c.id === m.endpointId);
    const vg = await prisma.msaGrant.findFirst({ where: { endpointId: ep.id, source: 'verify' } });
    await poll(ep);
    a = await agentApplies(ep, vg.id);
    check(a.applied === true, `${m.name}: its agent applied and read back the verification grant`);
  }
  r = await req('POST', `/msa/cutover-runs/${run1.id}/confirm`, { s: SAd });
  check(ok(r) && r.data.confirmed === 2 && r.data.counts.verified === 3, 'confirm: both verified from their own readback (the canary proved the connection)', msg(r));
  check((await prisma.activityLog.count({ where: { action: 'MSA_VERIFIED', resourceId: { in: b1.map((m) => m.endpointId) }, metadata: { path: ['runId'], equals: run1.id } } })) === 2, 'each computer\'s MSA_VERIFIED names the run');
  r = await req('POST', `/msa/cutover-runs/${run1.id}/advance`, { s: SAd });
  const skipped = (r.data?.members ?? []).find((m) => m.endpointId === skipC.id);
  check(ok(r) && r.data.state === 'complete' && skipped?.state === 'skipped' && skipped.skipReason === 'MSA_NOT_COMPATIBLE' && r.data.counts.cut_over === 1,
    'batch 2: one cut over, one skipped with its own blocker (MSA_NOT_COMPATIBLE); the run is complete', msg(r));
  check(!(await managedRow(skipC)), 'the skipped computer was not moved');
  r = await req('POST', `/msa/cutover-runs/${run1.id}/halt`, { s: SAdmin });
  check(r.status === 409 && code(r) === 'MSA_RUN_CLOSED', 'halting a complete run: 409', msg(r));
  r = await req('POST', `/msa/cutover-runs/${run1.id}/rollback`, { s: SAdmin });
  const moved = await prisma.msaManagedComputer.findMany({ where: { endpointId: { in: C.map((c) => c.id) } }, select: { state: true } });
  check(ok(r) && r.data.state === 'rolled_back' && r.data.rolledBack === 4 && moved.length === 4 && moved.every((x) => x.state === 'rollback_pending'),
    'rollback (no fresh confirmation): every computer the run moved starts rolling back', msg(r));
  check(!!(await prisma.activityLog.findFirst({ where: { action: 'MSA_CUTOVER_RUN_ROLLED_BACK', resourceId: bizA.id } })), 'MSA_CUTOVER_RUN_ROLLED_BACK audited');

  section('A business run, halted; one open run per business');
  r = await req('POST', '/msa/cutover-runs', { s: SAd, body: { scope: 'business', businessId: bizB.id, batchSize: 1 } });
  const run2 = r.data;
  check(ok(r) && run2.scope === 'business' && run2.counts.total === 3 && run2.canaryEndpointId === B[0].id && run2.state === 'canary', 'a business run: the first eligible computer is the canary', msg(r));
  r = await req('POST', `/msa/cutover-runs/${run2.id}/halt`, { s: SAdmin });
  check(ok(r) && r.data.state === 'halted', 'halt (no fresh confirmation): halted', msg(r));
  r = await req('POST', `/msa/cutover-runs/${run2.id}/advance`, { s: SAd });
  check(r.status === 409 && code(r) === 'MSA_RUN_CLOSED', 'a halted run does not advance', msg(r));
  r = await req('POST', `/msa/cutover-runs/${run2.id}/rollback`, { s: SAdmin });
  check(ok(r) && r.data.rolledBack === 1 && (await managedRow(B[0])).state === 'rollback_pending', 'its rollback rolls back the canary it moved', msg(r));
  r = await req('GET', '/msa/cutover-runs', { s: SAdmin });
  check(ok(r) && r.data.runs.some((x) => x.id === run1.id) && r.data.runs.some((x) => x.id === run2.id) && r.data.runs.every((x) => !x.members), 'the list: both runs, without members', msg(r));
  r = await req('GET', '/msa/cutover-runs', { s: SO });
  check(r.status === 403, 'the list is a Platform Admin\'s', msg(r));

  section('No password where it should not be; the database refuses what the services never write');
  const otps = [];
  for (const row of await prisma.msaGrant.findMany({ where: { endpointId: { in: created.endpoints } }, select: { passwordEnc: true } })) otps.push(row.passwordEnc);
  const audits = J(await prisma.activityLog.findMany({ where: { OR: [{ resourceId: { in: created.endpoints } }, { resourceId: { in: created.businesses } }] } }));
  check(!!otp1 && !audits.includes(otp1) && !audits.includes(pwB64), 'no audit row carries the one-time password');
  const revs = J(await prisma.msaRevocation.findMany({ where: { endpointId: { in: created.endpoints } } }));
  check(!revs.includes(otp1) && !/password/i.test(revs), 'no revocation carries a password');
  const tryUpd = async (fn) => { try { await fn(); return false; } catch { return true; } };
  check(await tryUpd(() => prisma.msaGrant.update({ where: { id: c1.grantId }, data: { revokedAt: null } })), 'revoked without revokedAt: refused (CHECK)');
  check(await tryUpd(() => prisma.msaGrant.update({ where: { id: c1.grantId }, data: { revokeReason: 'because' } })), 'a free-text revoke reason: refused (CHECK)');
  check(await tryUpd(() => prisma.msaGrant.update({ where: { id: c1.grantId }, data: { source: 'portal' } })), 'an unknown source: refused (CHECK)');
  check(await tryUpd(() => prisma.msaCutoverRun.update({ where: { id: run1.id }, data: { batchSize: 26 } })), 'a batch of 26: refused (CHECK)');
  check(await tryUpd(() => prisma.msaCutoverMember.create({ data: { runId: run1.id, endpointId: B[1].id } })), 'another business\'s computer in a run: refused (trigger)');
  check(await tryUpd(() => prisma.msaRevocation.create({ data: { id: 'x', endpointId: M1.id, keyId: key.keyId, reason: 'session', all: true, issuedAt: new Date(), notAfter: new Date(Date.now() + 3600_000), envelope: '{}' } })), 'a revocation id that is not 32 hex: refused (CHECK)');
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
  await prisma.msaCutoverRun.deleteMany({ where: { businessId: { in: created.businesses } } }).catch(() => {});
  await prisma.msaManagedComputer.deleteMany({ where: { endpointId: { in: ids } } }).catch(() => {});
  await prisma.msaRevocation.deleteMany({ where: { endpointId: { in: ids } } }).catch(() => {});
  await prisma.msaGrant.deleteMany({ where: { endpointId: { in: ids } } }).catch(() => {});
  await prisma.containmentPause.deleteMany({ where: { id: { in: created.pauses } } }).catch(() => {});
  await prisma.endpointGroupMember.deleteMany({ where: { endpointGroupId: { in: created.groups } } }).catch(() => {});
  await prisma.endpointGroup.deleteMany({ where: { id: { in: created.groups } } }).catch(() => {});
  await prisma.endpoint.updateMany({ where: { id: { in: ids } }, data: { status: 'ARCHIVED', isOnline: false, lastSeenAt: new Date(Date.now() - 24 * 3600_000) } }).catch(() => {});
  if (created.tenantSettings) {
    const { id, ...rest } = created.tenantSettings;
    await prisma.tenantSettings.update({ where: { id }, data: rest }).catch(() => {});
  }
  if (created.platformPin !== undefined) await prisma.platformSettings.update({ where: { id: 'singleton' }, data: { rustdeskPinnedVersion: created.platformPin } }).catch(() => {});
  rmSync(REPO, { recursive: true, force: true });
  await prisma.$disconnect();
}
console.log(`\nmsa sessions: ${pass} passed, ${fail} failed`);
if (fail) { for (const f of failures) console.error(`  ✗ ${f}`); process.exit(1); }
