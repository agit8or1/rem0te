#!/usr/bin/env node
/**
 * End-to-end proof of containment and evidence (v0.28):
 *   - a business suspending itself, and the MSP unable to lift it;
 *   - an MSP suspension and a global write pause, lifted by a second person
 *     with fresh authentication;
 *   - every write path refusing while paused: action requests, dispatch of an
 *     already-approved plan, remote connections, Quick Connect, agent update
 *     flags, and ClientSt0r integration jobs;
 *   - the approval signer keeping its own copy, which the portal cannot lift;
 *   - the agent refusing under a signed pause (rem0te-action-sim, the agent's
 *     real internal/action code);
 *   - the audit chain: sealing, the database trigger, a deletion detected,
 *     the off-host export, signed checkpoints and the verify CLI;
 *   - /healthz with and without its token.
 *
 * Self-contained, like e2e-approved-action.mjs:
 *
 *   cd apps/api && npx nest build
 *   RELEASE_BIN=/tmp/rem0te-release ACTION_SIM=/tmp/rem0te-action-sim \
 *   DATABASE_URL=postgresql://…/reboot_remote_it_scratch node scripts/e2e-containment.mjs
 *
 * It DELETES one audit row it wrote, to prove the deletion is detected —
 * after a run, the scratch database's chain reports that deletion for good.
 * That is the point; never run it anywhere else.
 *
 * FIXTURE-TESTED: no Windows, no real RustDesk, no real authenticator.
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { syntheticPasskey } from './lib/synthetic-passkey.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const C = require(path.join(dist, 'integration/crypto.js'));
const { JobRequest } = require(path.join(dist, 'integration/contract.js'));

const DB = process.env.DATABASE_URL ?? '';
const dbName = DB.split('/').pop()?.split('?')[0] ?? '';
if (!/scratch|test/.test(dbName)) { console.error(`Refusing to run against database "${dbName}": name must contain "scratch" or "test".`); process.exit(2); }
const BIN = process.env.RELEASE_BIN, SIM = process.env.ACTION_SIM;
if (!BIN || !SIM) { console.error('RELEASE_BIN (rem0te-release) and ACTION_SIM (rem0te-action-sim) are required'); process.exit(2); }
const PORT = Number(process.env.CONTAIN_API_PORT ?? 3181);
const SIGNER_PUBLIC = Number(process.env.CONTAIN_SIGNER_PUBLIC_PORT ?? 3283);
const SIGNER_INTERNAL = Number(process.env.CONTAIN_SIGNER_INTERNAL_PORT ?? 3284);
if ([PORT, SIGNER_PUBLIC, SIGNER_INTERNAL].some((p) => [3000, 3001, 443, 3201, 3202].includes(p))) { console.error('refusing a production port'); process.exit(2); }
const ROOT = `http://127.0.0.1:${PORT}`;
const API = `${ROOT}/api/v1`;
const ORIGIN = `http://127.0.0.1:${SIGNER_PUBLIC}`;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'contain-e2e-password-123';
const HEALTH_TOKEN = randomBytes(24).toString('hex');

let pass = 0, fail = 0; const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;
const sha = (b) => createHash('sha256').update(b).digest('hex');

// ── The release machine ─────────────────────────────────────────────────────
const work = mkdtempSync(path.join(tmpdir(), 'rem0te-contain-'));
const keys = path.join(work, 'keys'); mkdirSync(keys);
const repo = path.join(work, 'repo');
const files = path.join(work, 'files'); mkdirSync(files);
const signerDir = path.join(work, 'signer'); mkdirSync(signerDir, { mode: 0o700 });
const rel = (...a) => execFileSync(BIN, a, { encoding: 'utf8' });
const relTry = (...a) => spawnSync(BIN, a, { encoding: 'utf8' });
const signerCli = (args) => spawnSync(process.execPath, [path.join(dist, 'approval-signer', 'main.js'), ...args], { encoding: 'utf8', env: { ...process.env, APPROVAL_SIGNER_DIR: signerDir } });
const auditCli = (args) => spawnSync(process.execPath, [path.join(dist, 'cli', 'rem0te-audit.js'), ...args], { encoding: 'utf8', env: { ...process.env, DATABASE_URL: DB } });
for (const k of ['r1', 'targets', 'snapshot', 'timestamp']) rel('keygen', '-out', path.join(keys, `${k}.pem`));
const TK = ['-targets-key', path.join(keys, 'targets.pem'), '-snapshot-key', path.join(keys, 'snapshot.pem'), '-timestamp-key', path.join(keys, 'timestamp.pem')];
rel('init', '-repo', repo, '-root-key', path.join(keys, 'r1.pem'), '-root-threshold', '1', ...TK);
const agentBin = Buffer.concat([Buffer.from('MZ stand-in signed agent 0.28 '), randomBytes(64), Buffer.from('REM0TE_INST_URL:'), Buffer.alloc(240)]);
writeFileSync(path.join(files, 'agent.exe'), agentBin);
const AGENT_SHA = sha(agentBin);
const kg = signerCli(['keygen']);
if (kg.status !== 0) throw new Error(`signer keygen: ${kg.stderr}`);
const keysFile = path.join(files, 'approval-keys.json');
writeFileSync(keysFile, kg.stdout);
rel('release', '-repo', repo, ...TK, '-add', `windows/rem0te-agent.exe=${path.join(files, 'agent.exe')}`, '-add', `approval/keys.json=${keysFile}`);

// Audit evidence: an export file and a checkpoint key, as an operator would set them.
const exportFile = path.join(work, 'audit-export.ndjson');
const cpKey = path.join(work, 'audit-checkpoint.pem');
const cpPub = path.join(work, 'audit-checkpoint.pub');

// ── Processes ───────────────────────────────────────────────────────────────
const kids = {};
function start(name, script, env) {
  const p = spawn(process.execPath, [script, ...(name === 'signer' ? ['serve'] : [])], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  p.log = ''; p.stdout.on('data', (d) => { p.log += d; }); p.stderr.on('data', (d) => { p.log += d; });
  kids[name] = p; return p;
}
async function stop(name) { const p = kids[name]; if (!p || p.exitCode !== null) return; await new Promise((r) => { p.once('exit', r); p.kill('SIGTERM'); }); }
const signerEnv = { ...process.env, APPROVAL_SIGNER_DIR: signerDir, APPROVAL_ORIGIN: ORIGIN, APPROVAL_RP_ID: '127.0.0.1', APPROVAL_PUBLIC_PORT: String(SIGNER_PUBLIC), APPROVAL_INTERNAL_PORT: String(SIGNER_INTERNAL) };
delete signerEnv.DATABASE_URL;

const pair = () => generateKeyPairSync('ed25519');
const pem = (k) => k.export({ type: 'spki', format: 'pem' }).toString();
const self = pair(), peerReq = pair(), peerDel = pair();
writeFileSync(path.join(work, 'self.pem'), self.privateKey.export({ type: 'pkcs8', format: 'pem' }));
const AUD = 'rem0te:contain-lab', PEER = `clientst0r-contain-${sfx}`;
const peersFile = path.join(work, 'peers.json');
writeFileSync(peersFile, JSON.stringify({
  self: { keyId: 'rem0te-contain-1', privateKeyFile: path.join(work, 'self.pem') },
  peers: [{ id: PEER, audience: AUD, peerAudience: 'clientst0r:contain-lab', requestKeys: [{ kid: 'req-1', publicKeyPem: pem(peerReq.publicKey) }], delegationKeys: [{ kid: 'del-1', publicKeyPem: pem(peerDel.publicKey) }], inferenceUrl: 'http://127.0.0.1:9/api/integration/v1/inference', eventsUrl: 'http://127.0.0.1:9/api/integration/v1/events', modelProfiles: ['triage-fast'] }],
}));
const apiEnv = {
  ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATABASE_URL: DB, UPDATE_REPO_DIR: repo,
  APPROVAL_SIGNER_INTERNAL_URL: `http://127.0.0.1:${SIGNER_INTERNAL}`, INTEGRATION_PEERS_FILE: peersFile,
  JWT_SECRET: randomBytes(32).toString('hex'), LAUNCHER_TOKEN_SECRET: randomBytes(32).toString('hex'),
  ENCRYPTION_KEY: randomBytes(32).toString('hex'), TRUSTED_PROXIES: 'loopback',
  VERSION_FILE: path.resolve(here, '..', '..', '..', 'version.json'),
  AUDIT_EXPORT_FILE: exportFile, AUDIT_CHECKPOINT_KEY_FILE: cpKey, AUDIT_CHECKPOINT_INTERVAL_SECONDS: '5', HEALTH_TOKEN,
};
delete apiEnv.AUDIT_SEALER;
async function waitUp(url, name) {
  for (let i = 0; i < 120; i++) { try { const r = await fetch(url); if (r.status < 500) return; } catch { /* not yet */ } await sleep(300); }
  throw new Error(`${name} did not come up:\n${kids[name]?.log.slice(-3000)}`);
}

// ── HTTP ────────────────────────────────────────────────────────────────────
async function req(method, p, { s, body, business, headers = {} } = {}) {
  const h = { 'content-type': 'application/json', 'x-forwarded-for': s?.ip ?? ip(), ...headers };
  if (s) h.cookie = s.cookie + (s.stepUp ? `; step_up=${s.stepUp}` : '');
  if (business) h['x-rem0te-business'] = business;
  const r = await fetch(`${API}${p}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j, setCookie: r.headers.get('set-cookie') ?? '' };
}
async function login(email) {
  const s = { ip: ip() };
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': s.ip }, body: JSON.stringify({ email, password: PW }) });
  const m = (r.headers.get('set-cookie') ?? '').match(/access_token=([^;]+)/);
  if (r.status !== 200 || !m) throw new Error(`login ${email}: ${r.status} ${await r.text()}`);
  s.cookie = `access_token=${m[1]}`;
  return s;
}
async function stepUp(s) {
  const r = await req('POST', '/auth/step-up', { s, body: { password: PW } });
  const m = r.setCookie.match(/step_up=([^;]+)/);
  if (r.status !== 200 || !m) throw new Error(`step-up: ${r.status} ${JSON.stringify(r.body)}`);
  return { ...s, stepUp: m[1] };
}
const code = (r) => r.body?.code ?? r.body?.message?.code ?? r.body?.error?.code;
const msg = (r) => `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 400)}`;
const sj = async (url, init = {}) => { const r = await fetch(url, init); let b = null; try { b = await r.json(); } catch { /* html */ } return { status: r.status, body: b }; };
const signerPost = (jid, p, body) => sj(`${ORIGIN}/approve/${jid}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify(body) });
async function approve(jobId, who) {
  const c = await signerPost(jobId, '/challenge', { decision: 'approve', role: 'approver' });
  if (c.status !== 200) return c;
  return signerPost(jobId, '/decide', { challengeId: c.body.challengeId, assertion: who.assert(c.body.options, { origin: ORIGIN }) });
}

const heartbeat = (ep, extra = {}) => req('POST', '/enrollment/heartbeat', {
  body: { rustdeskId: ep.rid, agentSecret: ep.secret, hostname: ep.hostname, platform: 'Windows', updateChannel: 'signed', agentActions: ['windows.service.start@1'], agentSha256: AGENT_SHA, ...extra },
});
function resultsOf(ep) {
  const d = path.join(ep.state, 'actions', 'results');
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => /^[0-9a-f]{32}\.json$/.test(f)).map((f) => JSON.parse(readFileSync(path.join(d, f), 'utf8')));
}
function runAgent(ep, jobId, envelope, { pause } = {}) {
  const envFile = path.join(work, `env-${jobId}-${randomBytes(3).toString('hex')}.json`);
  writeFileSync(envFile, JSON.stringify(envelope));
  const args = ['-state', ep.state, '-keys', keysFile, '-job', jobId, '-envelope', envFile, '-rustdesk-id', ep.rid, '-secret', ep.secret, '-product-type', '1', '-self-sha', AGENT_SHA];
  if (pause) args.push('-pause', pause);
  return JSON.parse(execFileSync(SIM, args, { encoding: 'utf8' }).trim());
}
const simService = (ep, v) => writeFileSync(path.join(ep.state, 'sim-service'), v);
const simServiceNow = (ep) => readFileSync(path.join(ep.state, 'sim-service'), 'utf8');

// ClientSt0r client.
function token({ sub, org, scope = 'ticket_analysis:submit', req_sha256 }) {
  const now = Math.floor(Date.now() / 1000);
  return C.signJws(peerDel.privateKey, 'del-1', { iss: PEER, aud: AUD, sub, org, scope, iat: now, exp: now + 120, jti: randomBytes(16).toString('hex'), ...(req_sha256 ? { req_sha256 } : {}) });
}
async function call(method, p, { body, delegation } = {}) {
  const text = body ? JSON.stringify(body) : '';
  const t = String(Math.floor(Date.now() / 1000)), n = randomBytes(18).toString('base64url');
  const sig = C.signEd25519(peerReq.privateKey, C.requestSigningString({ audience: AUD, method, pathWithQuery: p, timestamp: t, nonce: n, bodySha256: C.sha256Hex(Buffer.from(text)) }));
  const headers = { 'content-type': 'application/json', 'rem0te-key-id': `${PEER}/req-1`, 'rem0te-timestamp': t, 'rem0te-nonce': n, 'rem0te-signature': sig, ...(delegation ? { 'rem0te-delegation': delegation } : {}) };
  const r = await fetch(`${ROOT}${p}`, { method, headers, body: text || undefined });
  const out = await r.text(); let j; try { j = JSON.parse(out); } catch { j = out; }
  return { status: r.status, body: j };
}
const hashOf = (b) => { const r = JobRequest.safeParse(b); return C.sha256Hex(C.canonicalJson(r.success ? r.data : b)); };
const jobBody = (org, tech) => ({
  contract: 'ticket-rmm-v1', idempotency_key: `idem-${randomBytes(6).toString('hex')}`, correlation_id: `corr-${randomBytes(4).toString('hex')}`,
  organization_id: org, technician_id: tech,
  ticket: { id: `T-${sfx}-1`, revision: 1, subject: 'Printer not working', body: 'Nothing prints.', comments: [] },
  endpoint: null, model_profiles: ['triage-fast'], evidence: { include_endpoint_inventory: false },
  expires_at: new Date(Date.now() + 3600_000).toISOString(),
});
const submitJob = (b) => call('POST', '/api/integration/v1/jobs', { body: b, delegation: token({ sub: b.technician_id, org: b.organization_id, req_sha256: hashOf(b) }) });

const created = { businesses: [], users: [], quickConnectWas: null };

async function all() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });

  section('Fixtures (synthetic): Acme and Birch, each with a FRONTDESK');
  const acme = await prisma.customer.create({ data: { tenantId: tenant.id, name: `CT Acme ${sfx}`, quickConnectEnabled: true } });
  const birch = await prisma.customer.create({ data: { tenantId: tenant.id, name: `CT Birch ${sfx}`, quickConnectEnabled: true } });
  created.businesses.push(acme.id, birch.id);
  const ps = await prisma.platformSettings.upsert({ where: { id: 'singleton' }, create: { id: 'singleton', quickConnectEnabled: true }, update: {} });
  created.quickConnectWas = ps.quickConnectEnabled;
  await prisma.platformSettings.update({ where: { id: 'singleton' }, data: { quickConnectEnabled: true } });
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag, extra = {}) => { const u = await prisma.user.create({ data: { email: `ct-${tag}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'CT', lastName: tag, status: 'ACTIVE', ...extra } }); created.users.push(u.id); return u; };
  const admin1 = await mkUser('admin1', { isPlatformAdmin: true }), admin2 = await mkUser('admin2', { isPlatformAdmin: true });
  const mgr = await mkUser('mgr', { platformPermissions: ['technicians:manage'] });
  const owen = await mkUser('owen-owner-acme'), bea = await mkUser('bea-owner-birch');
  const dana = await mkUser('dana-l2'), csTech = await mkUser('cs-tech');
  const olivia = await mkUser('olivia-approver', { platformPermissions: ['technicians:manage'] });
  await prisma.membership.create({ data: { userId: owen.id, tenantId: tenant.id, customerId: acme.id, roleId: roleOwner.id, capabilities: ['support:quick_connect'] } });
  await prisma.membership.create({ data: { userId: bea.id, tenantId: tenant.id, customerId: birch.id, roleId: roleOwner.id, capabilities: ['support:quick_connect'] } });
  const l2 = await prisma.technicianPreset.findUnique({ where: { key: 'l2-technician' } });
  await prisma.technicianAssignment.create({ data: { tenantId: tenant.id, customerId: acme.id, userId: dana.id, presetId: l2.id, capabilities: [] } });
  await prisma.technicianAssignment.create({ data: { tenantId: tenant.id, customerId: acme.id, userId: csTech.id, capabilities: ['computers:view', 'integration:ticket_analysis'] } });
  const ORG_A = `org-a-${sfx}`;
  await prisma.integrationOrgMapping.create({ data: { peerId: PEER, externalOrgId: ORG_A, customerId: acme.id, tenantId: tenant.id, createdById: 'ct' } });
  await prisma.integrationTechnicianMapping.create({ data: { peerId: PEER, externalOrgId: ORG_A, externalTechnicianId: 'cs-tech-a', userId: csTech.id, createdById: 'ct' } });
  const mkEp = async (biz, hostname) => {
    const e = await prisma.endpoint.create({ data: { tenantId: tenant.id, customerId: biz.id, name: hostname, hostname, status: 'ACTIVE', isOnline: true, isManaged: true, accessMode: 'COMPANY_WIDE', lastSeenAt: new Date(), deviceClass: 'WORKSTATION' } });
    const rid = String(100000000 + ((Math.random() * 899999999) | 0));
    const secret = randomBytes(24).toString('hex');
    await prisma.rustdeskNode.create({ data: { tenantId: tenant.id, endpointId: e.id, rustdeskId: rid, agentSecretHash: sha(secret) } });
    const state = path.join(work, `agent-${hostname}-${biz.id.slice(-6)}`); mkdirSync(state);
    return { id: e.id, rid, secret, state, hostname };
  };
  const fdA = await mkEp(acme, 'FRONTDESK'), fdB = await mkEp(birch, 'FRONTDESK');
  const pk = { olivia: syntheticPasskey({ userId: olivia.id, name: 'CT olivia' }) };
  await prisma.userMfaMethod.create({ data: { userId: olivia.id, type: 'WEBAUTHN', isActive: true, credentialId: pk.olivia.credentialId, publicKey: Buffer.from(pk.olivia.publicKey, 'base64url'), signCount: 0, name: 'Test key' } });
  const kc = auditCli(['keygen', '--out', cpKey]);
  writeFileSync(cpPub, kc.stdout.slice(kc.stdout.indexOf('-----BEGIN')));
  check(kc.status === 0 && /key id [0-9a-f]{16}/.test(kc.stdout), 'rem0te-audit keygen writes a checkpoint key and prints its public half', kc.stderr);
  check(auditCli(['keygen', '--out', cpKey]).status === 2, 'and refuses to overwrite an existing key');

  start('signer', path.join(dist, 'approval-signer', 'main.js'), signerEnv);
  start('api', path.join(dist, 'main.js'), apiEnv);
  await waitUp(`http://127.0.0.1:${SIGNER_INTERNAL}/internal/v1/keys`, 'signer');
  await waitUp(`${API}/health`, 'api');
  const S = { admin1: await login(admin1.email), admin2: await login(admin2.email), mgr: await login(mgr.email), owen: await login(owen.email), bea: await login(bea.email), dana: await login(dana.email), olivia: await login(olivia.email) };
  {
    const list = await req('GET', '/auth/passkeys', { s: S.olivia });
    const mine = (list.body?.data ?? list.body ?? [])[0];
    const add = signerCli(['roster', 'add', '--export', mine.approvalExport, '--approve', '*', '--confirm-fingerprint', mine.approvalFingerprint]);
    if (add.status !== 0) throw new Error(`roster add: ${add.stderr}`);
  }
  for (const ep of [fdA, fdB]) await heartbeat(ep);
  const actionBody = { actionId: 'windows.service.start', version: 1, params: { service: 'Spooler' }, reason: 'Ticket 7: spooler stopped' };
  const connect = (s, ep, business) => req('POST', `/endpoints/${ep.id}/connect`, { s, business, body: {} });
  const quick = (s, business) => req('POST', '/quick-connect/connect', { s, business, body: { rustdeskId: '123456789', password: 'not-the-real-one' } });

  section('Before anything is paused: the baselines');
  {
    const qc = await quick(S.owen, acme.id);
    check(qc.status < 300, 'Quick Connect works for Acme', msg(qc));
    const c = await connect(S.owen, fdA, acme.id);
    check(c.status < 300, 'Acme\'s owner can connect to Acme FRONTDESK', msg(c));
    const st = await req('GET', '/containment', { s: S.dana, business: acme.id });
    check(st.status === 403, 'a technician cannot view or manage containment', msg(st));
  }

  section('A business suspends itself; the MSP cannot lift it');
  let own;
  {
    let r = await req('POST', '/containment/pauses', { s: S.bea, business: birch.id, body: { scope: 'business', businessId: acme.id, reason: 'not mine' } });
    check(r.status === 404, 'Birch\'s owner cannot suspend Acme (404)', msg(r));
    r = await req('POST', '/containment/pauses', { s: S.owen, business: acme.id, body: { scope: 'global', reason: 'stop the world' } });
    check(r.status === 403 && code(r) === 'NOT_ALLOWED', 'a Business Owner cannot set a global pause', msg(r));
    r = await req('POST', '/containment/pauses', { s: S.owen, business: acme.id, body: { scope: 'business', businessId: acme.id, reason: 'We think an account was phished', extra: 1 } });
    check(r.status === 400, 'an unknown field is refused', msg(r));
    r = await req('POST', '/containment/pauses', { s: S.owen, business: acme.id, body: { scope: 'business', businessId: acme.id, reason: 'We think an account was phished' } });
    own = r.body?.data;
    check(r.status === 201 && own?.setBy === 'customer' && own.kinds.length === 4 && /^held as [0-9a-f]{16}$/.test(own.signer?.result ?? ''), 'Acme\'s owner suspends Acme — no step-up needed, every kind, and the signer holds a copy', msg(r));
    const ban = await req('GET', '/containment/banner', { s: S.owen, business: acme.id });
    check(ban.body?.data?.[0]?.id === own.id, 'Acme\'s people see the banner', msg(ban));
    const banB = await req('GET', '/containment/banner', { s: S.bea, business: birch.id });
    check(Array.isArray(banB.body?.data) && banB.body.data.length === 0, 'Birch sees nothing', msg(banB));
  }

  section('While Acme is suspended, every write path refuses — and Birch carries on');
  {
    let r = await req('POST', `/endpoints/${fdA.id}/actions`, { s: S.dana, business: acme.id, body: actionBody });
    check(r.status === 403 && code(r) === 'CONTAINED', 'an action request → 403 CONTAINED', msg(r));
    r = await connect(S.owen, fdA, acme.id);
    check(r.status === 403 && code(r) === 'CONTAINED', 'a remote connection → 403 CONTAINED', msg(r));
    r = await quick(S.owen, acme.id);
    check(r.status === 403 && code(r) === 'CONTAINED', 'Quick Connect → 403 CONTAINED', msg(r));
    const j = await submitJob(jobBody(ORG_A, 'cs-tech-a'));
    check(j.status === 423 && j.body?.error?.code === 'CONTAINED', 'a ClientSt0r job → 423 CONTAINED', JSON.stringify(j.body).slice(0, 300));
    const outsider = await req('POST', `/endpoints/${fdA.id}/actions`, { s: S.bea, business: birch.id, body: actionBody });
    check(outsider.status === 404 || (outsider.status === 403 && code(outsider) !== 'CONTAINED'), 'someone outside Acme is refused for being outside, not told of the suspension', msg(outsider));
    const nodeA = await prisma.rustdeskNode.findUnique({ where: { endpointId: fdA.id } });
    const nodeB = await prisma.rustdeskNode.findUnique({ where: { endpointId: fdB.id } });
    await prisma.rustdeskNode.update({ where: { id: nodeA.id }, data: { reinstallRequestedAt: new Date(), reinstallDispatchedAt: null } });
    await prisma.rustdeskNode.update({ where: { id: nodeB.id }, data: { reinstallRequestedAt: new Date(), reinstallDispatchedAt: null } });
    const hbA = await heartbeat(fdA), hbB = await heartbeat(fdB);
    const nA = await prisma.rustdeskNode.findUnique({ where: { id: nodeA.id } }), nB = await prisma.rustdeskNode.findUnique({ where: { id: nodeB.id } });
    check(!hbA.body?.data?.reinstallAgent && !hbA.body?.data?.updateRustdesk && nA.reinstallDispatchedAt === null, 'Acme FRONTDESK\'s heartbeat carries no reinstall, and it is not recorded as sent', msg(hbA));
    check(!!hbB.body?.data?.reinstallAgent && nB.reinstallDispatchedAt !== null, 'Birch FRONTDESK\'s reinstall goes out as normal', msg(hbB));
    await prisma.rustdeskNode.updateMany({ where: { id: { in: [nodeA.id, nodeB.id] } }, data: { reinstallRequestedAt: null, reinstallDispatchedAt: null } });
    const qcB = await quick(S.bea, birch.id);
    check(qcB.status < 300, 'Birch\'s Quick Connect still works', msg(qcB));
    const cB = await connect(S.bea, fdB, birch.id);
    check(cB.status < 300, 'and so do Birch\'s connections', msg(cB));
  }

  section('Lifting a customer suspension: only that customer, with fresh authentication');
  {
    const A1 = await stepUp(S.admin1);
    let r = await req('POST', `/containment/pauses/${own.id}/clear`, { s: A1, body: { reason: 'we looked, it is fine' } });
    check(r.status === 403 && code(r) === 'CUSTOMER_SUSPENSION', 'a Platform Admin cannot lift a business\'s own suspension', msg(r));
    r = await req('POST', `/containment/pauses/${own.id}/clear`, { s: S.owen, business: acme.id, body: { reason: 'password reset done' } });
    check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED', 'Acme\'s owner without fresh authentication → STEP_UP_REQUIRED', msg(r));
    const O = await stepUp(S.owen);
    r = await req('POST', `/containment/pauses/${own.id}/clear`, { s: O, business: acme.id, body: { reason: 'password reset done' } });
    check(r.status === 200 && !!r.body?.data?.clearedAt, 'Acme\'s owner, freshly authenticated, lifts it', msg(r));
    const c = await connect(S.owen, fdA, acme.id);
    check(c.status < 300, 'connections work again at once', msg(c));
  }

  section('The approval signer keeps its copy until its own operator lifts it');
  let job;
  {
    let r = await req('POST', `/endpoints/${fdA.id}/actions`, { s: S.dana, business: acme.id, body: actionBody });
    check(r.status === 409 && code(r) === 'APPROVAL_SIGNER_REFUSED' && /paused/.test(r.body?.message ?? ''), 'the portal\'s pause is gone, but the signer still refuses the plan', msg(r));
    const routes = await Promise.all([
      fetch(`http://127.0.0.1:${SIGNER_INTERNAL}/internal/v1/pauses/x/clear`, { method: 'POST' }),
      fetch(`http://127.0.0.1:${SIGNER_INTERNAL}/internal/v1/pauses`, { method: 'DELETE' }),
    ]);
    check(routes.every((x) => x.status === 404 || x.status === 405), 'the signer has no HTTP route that lifts a pause', routes.map((x) => x.status).join(','));
    const list = signerCli(['pause', 'list']);
    const line = list.stdout.split('\n').find((l) => l.includes('ACTIVE') && l.includes(acme.id));
    check(!!line && line.includes(own.id), 'the signer operator sees it, with the portal pause it came from', list.stdout);
    const sid = line?.split(/\s+/)[0];
    const cl = signerCli(['pause', 'clear', '--id', sid, '--reason', 'portal lifted; checked with Acme']);
    check(cl.status === 0, 'and lifts it with the signer CLI', cl.stderr);
    r = await req('POST', `/endpoints/${fdA.id}/actions`, { s: S.dana, business: acme.id, body: actionBody });
    job = r.body?.data;
    check(r.status === 201 && job?.status === 'AWAITING_APPROVAL', 'now the request is accepted', msg(r));
    const a = await approve(job.id, pk.olivia);
    check(a.status === 200 && a.body.status === 'SIGNED', 'and approved on the signer', JSON.stringify(a.body).slice(0, 200));
  }

  section('An MSP suspension holds an approved plan; a second person lifts it');
  let msp;
  {
    let r = await req('POST', '/containment/pauses', { s: S.admin1, body: { scope: 'business', businessId: acme.id, kinds: ['actions'], reason: 'Investigating a technician account' } });
    msp = r.body?.data;
    check(r.status === 201 && msp?.setBy === 'msp' && msp.kinds.join() === 'actions', 'a Platform Admin suspends actions for Acme', msg(r));
    const g = await req('GET', `/actions/${job.id}`, { s: S.dana, business: acme.id });
    check(g.body?.data?.status === 'APPROVED', 'the plan is approved (the portal reads the signature)', msg(g));
    const hb = await heartbeat(fdA);
    const t = await prisma.actionTarget.findFirst({ where: { jobId: job.id } });
    check(!(hb.body?.data?.actions ?? []).length && t.status === 'PENDING', 'the next heartbeat delivers nothing; the target waits, PENDING', msg(hb));
    const c = await connect(S.owen, fdA, acme.id);
    check(c.status < 300, 'connections are not part of this pause', msg(c));
    r = await req('POST', `/containment/pauses/${msp.id}/clear`, { s: await stepUp(S.owen), business: acme.id, body: { reason: 'we want it back' } });
    check(r.status === 403 && code(r) === 'MSP_SUSPENSION', 'Acme\'s owner cannot lift the MSP\'s suspension', msg(r));
    r = await req('POST', `/containment/pauses/${msp.id}/clear`, { s: await stepUp(S.admin1), body: { reason: 'done' } });
    check(r.status === 403 && code(r) === 'SAME_PERSON', 'whoever set it cannot lift it alone', msg(r));
    r = await req('POST', `/containment/pauses/${msp.id}/clear`, { s: await stepUp(S.admin2), body: { reason: 'account checked, no misuse' } });
    check(r.status === 200, 'a second Platform Admin lifts it', msg(r));
    const sp = signerCli(['pause', 'list']).stdout.split('\n').find((l) => l.includes('ACTIVE') && l.includes(msp.id));
    if (sp) signerCli(['pause', 'clear', '--id', sp.split(/\s+/)[0], '--reason', 'portal lifted']);
  }

  section('The agent refuses under a signed pause, whatever the portal delivers');
  {
    const pauseFile = path.join(files, 'pause.json');
    const bad = relTry('pause-file', '-out', pauseFile, '-reason', 'x');
    check(bad.status !== 0, 'rem0te-release pause-file refuses a pause that names nothing');
    rel('pause-file', '-out', pauseFile, '-reason', 'Incident 7: Acme approvals under review', '-business', acme.id);
    const junk = path.join(files, 'junk.json'); writeFileSync(junk, '{"schema":"rem0te-pause/1","resume":true}');
    const r0 = relTry('release', '-repo', repo, ...TK, '-add', `control/pause.json=${junk}`);
    check(r0.status !== 0, 'a malformed control/pause.json is refused at release time', r0.stderr.slice(0, 200));
    rel('release', '-repo', repo, ...TK, '-add', `control/pause.json=${pauseFile}`);
    const metas = readdirSync(path.join(repo, 'metadata')).filter((f) => /^\d+\.targets\.json$/.test(f)).sort((a, b) => parseInt(b) - parseInt(a));
    const targets = await (await fetch(`${API}/public/updates/metadata/${metas[0]}`)).json();
    const t = targets.signed.targets['control/pause.json'];
    const served = Buffer.from(await (await fetch(`${API}/public/updates/targets/control/${t.hashes.sha256}.pause.json`)).arrayBuffer());
    check(sha(served) === t.hashes.sha256, 'the signed pause is published through the portal\'s mirror, pinned by signed targets metadata');
    const viaMirror = path.join(work, 'pause-from-mirror.json'); writeFileSync(viaMirror, served);

    const hb = await heartbeat(fdA);
    const d = (hb.body?.data?.actions ?? []).find((x) => x.jobId === job.id);
    check(!!d, 'with the portal pause lifted, the approved plan is delivered', msg(hb));
    simService(fdA, 'stopped');
    const res = runAgent(fdA, job.id, d.envelope, { pause: viaMirror });
    check(res.outcome === 'refused' && res.reason === 'paused' && simServiceNow(fdA) === 'stopped', 'FRONTDESK refuses it — paused — and the spooler is not started', JSON.stringify(res));
    const again = runAgent(fdA, job.id, d.envelope);
    check(again.outcome === 'refused' && again.reason === 'paused' && simServiceNow(fdA) === 'stopped', 'the refusal is final: re-delivered after the pause is lifted, it is still refused from the journal', JSON.stringify(again));
    const hb2 = await heartbeat(fdA, { actionResults: resultsOf(fdA) });
    const tt = await prisma.actionTarget.findFirst({ where: { jobId: job.id } });
    check((hb2.body?.data?.actionAcks ?? []).includes(job.id) && tt.status === 'REFUSED_BY_ENDPOINT', 'the portal records it as refused by the endpoint', `${tt.status} ${msg(hb2)}`);
  }

  section('A global pause: the MSP stops everything');
  {
    let r = await req('POST', '/containment/pauses', { s: S.dana, business: acme.id, body: { scope: 'global', reason: 'try' } });
    check(r.status === 403, 'a technician cannot', msg(r));
    r = await req('POST', '/containment/pauses', { s: S.mgr, body: { scope: 'global', kinds: ['remote', 'integration'], reason: 'Possible portal compromise' } });
    const g = r.body?.data;
    check(r.status === 201 && g?.scope === 'global' && g.signer === null, 'a technician manager sets a global pause (no actions, so nothing sent to the signer)', msg(r));
    const c = await connect(S.bea, fdB, birch.id);
    check(c.status === 403 && code(c) === 'CONTAINED', 'Birch is stopped too', msg(c));
    const ban = await req('GET', '/containment/banner', { s: S.bea, business: birch.id });
    check(ban.body?.data?.some((x) => x.scope === 'global'), 'and every business sees the banner', msg(ban));
    r = await req('POST', `/containment/pauses/${g.id}/clear`, { s: await stepUp(S.owen), business: acme.id, body: { reason: 'we disagree' } });
    check(r.status === 404, 'a Business Owner cannot lift a global pause', msg(r));
    const dry = auditCli(['containment', 'clear', '--id', g.id, '--reason', 'host operator']);
    const still = await prisma.containmentPause.findUnique({ where: { id: g.id } });
    check(dry.status === 0 && /Dry run/.test(dry.stdout) && !still.clearedAt, 'the host CLI without --yes changes nothing', dry.stdout + dry.stderr);
    const ls = auditCli(['containment', 'list']);
    check(ls.stdout.includes(g.id), 'rem0te-audit containment list shows it', ls.stdout);
    const yes = auditCli(['containment', 'clear', '--id', g.id, '--reason', 'both admins locked out; lifted on the host', '--yes']);
    const after = await prisma.containmentPause.findUnique({ where: { id: g.id } });
    const logged = await prisma.activityLog.findFirst({ where: { action: 'CONTAINMENT_CLEARED', resourceId: g.id } });
    check(yes.status === 0 && !!after.clearedAt && logged?.actorAgent === 'rem0te-audit-cli', 'the host CLI with --yes lifts it, and the audit log says so', yes.stdout + yes.stderr);
  }

  section('The audit chain: sealed, guarded, exported, checkpointed');
  let ours;
  {
    let st;
    for (let i = 0; i < 60; i++) {
      st = await req('GET', '/audit/integrity', { s: S.admin1 });
      if (st.body?.data?.unsealed === 0 && BigInt(st.body.data.export.exportedThroughSeq) >= BigInt(st.body.data.headSeq) && st.body.data.checkpoints.last) break;
      await sleep(1000);
    }
    const s = st.body?.data;
    check(st.status === 200 && s.unsealed === 0 && BigInt(s.headSeq) > 0n, 'every row is sealed within seconds', msg(st));
    check(s.export.configured.includes('file') && !s.export.error && BigInt(s.export.exportedThroughSeq) >= BigInt(s.headSeq), 'and exported to the file sink', JSON.stringify(s.export));
    check(s.checkpoints.signed && /^[0-9a-f]{16}$/.test(s.checkpoints.keyId ?? '') && !!s.checkpoints.last, 'checkpoints are signed with the configured key', JSON.stringify(s.checkpoints));
    const noView = await req('GET', '/audit/integrity', { s: S.owen, business: acme.id });
    check(noView.status === 403, 'a Business Owner cannot read the platform chain status', msg(noView));
    ours = await prisma.activityLog.findFirst({ where: { action: 'CONTAINMENT_PAUSED', resourceId: own.id } });
    check(!!ours?.chainHash && !!ours.sealedRefs, 'Acme\'s suspension is a sealed entry', `seq ${ours?.seq} hash ${ours?.chainHash}`);

    let blocked = '';
    try { await prisma.$executeRaw`UPDATE "ActivityLog" SET "metadata" = '{"reason":"nothing happened"}'::jsonb WHERE id = ${ours.id}`; } catch (e) { blocked = String(e.message); }
    check(/sealed/i.test(blocked), 'the database refuses to edit a sealed entry (trigger)', blocked.slice(0, 200));
    blocked = '';
    try { await prisma.$executeRaw`UPDATE "ActivityLog" SET "customerId" = ${birch.id} WHERE id = ${ours.id}`; } catch (e) { blocked = String(e.message); }
    check(/sealed/i.test(blocked), 'or to point it at another business', blocked.slice(0, 200));
    const n = await prisma.$executeRaw`UPDATE "ActivityLog" SET "actorId" = NULL WHERE id = ${ours.id}`;
    check(n === 1, 'but nulling a reference (a deleted user or business) is allowed');

    const base = await req('POST', '/audit/integrity/verify', { s: S.admin1 });
    const before = new Set((base.body?.data?.problems ?? []).map((p) => `${p.kind}:${p.seq}`));
    check(base.status === 200 && !(base.body?.data?.problems ?? []).some((p) => p.seq === String(ours.seq)), 'verify: our entry checks out (earlier scratch runs may have left their own deletions)', msg(base));

    const v0 = auditCli(['verify-export', exportFile, '--pub', cpPub]);
    // On a scratch database other suites' cleanups delete audit rows; those
    // deletions are real and both copies report them. Anything else is not.
    const exportProblems = [...v0.stdout.matchAll(/export seq (\d+): (\w+)/g)].map((m) => `${m[2]}:${m[1]}`);
    const unexpected = exportProblems.filter((p) => !before.has(p));
    check(/entries, seq/.test(v0.stdout) && unexpected.length === 0 && (v0.status === 0 || exportProblems.length > 0), 'the exported copy verifies on its own, signatures included (any deletion it reports, the database reports too)', v0.stdout + v0.stderr);
    const wrongPub = path.join(work, 'other.pub'); writeFileSync(wrongPub, pem(pair().publicKey));
    const v1 = auditCli(['verify-export', exportFile, '--pub', wrongPub]);
    check(v1.status === 1 && /checkpoint_signature/.test(v1.stdout), 'against another key, the checkpoints do not', v1.stdout);

    await prisma.$executeRaw`DELETE FROM "ActivityLog" WHERE id = ${ours.id}`;
    const after = await req('POST', '/audit/integrity/verify', { s: S.admin1 });
    const fresh = (after.body?.data?.problems ?? []).filter((p) => !before.has(`${p.kind}:${p.seq}`));
    check(after.body?.data?.ok === false && fresh.some((p) => p.kind === 'deleted' && p.seq === String(ours.seq)), `deleting it is detected: entry ${ours.seq} missing and undeclared`, JSON.stringify(fresh).slice(0, 300));
    if (base.body?.data?.ok) {
      const alert = await prisma.activityLog.findFirst({ where: { action: 'AUDIT_CHAIN_ALERT', createdAt: { gt: new Date(Date.now() - 60_000) } } });
      check(!!alert, 'the break raises AUDIT_CHAIN_ALERT');
    }
    const cmp = auditCli(['verify', '--export', exportFile, '--pub', cpPub]);
    check(cmp.status === 1 && new RegExp(`compare seq ${ours.seq}: deleted`).test(cmp.stdout), 'rem0te-audit verify --export: the export still holds the deleted entry', cmp.stdout.slice(-800));
    const hz = await fetch(`${API}/healthz`, { headers: { 'x-rem0te-health-token': HEALTH_TOKEN } }).then((r) => r.json());
    check(hz.status === 'degraded' && hz.audit?.verifyOk === false, '/healthz (with its token) reports the chain as degraded', JSON.stringify(hz).slice(0, 300));
  }

  section('/healthz: nothing without the token');
  {
    const bare = await fetch(`${API}/healthz`);
    const b = await bare.json();
    check(bare.status === 200 && JSON.stringify(b) === '{"status":"ok"}', 'no token: {"status":"ok"} and nothing else', JSON.stringify(b));
    const wrong = await fetch(`${API}/healthz`, { headers: { 'x-rem0te-health-token': 'x'.repeat(48) } }).then((r) => r.json());
    check(JSON.stringify(wrong) === '{"status":"ok"}', 'a wrong token: the same');
    const full = await fetch(`${API}/healthz`, { headers: { 'x-rem0te-health-token': HEALTH_TOKEN } }).then((r) => r.json());
    const text = JSON.stringify(full);
    check(full.database === 'up' && full.signer === 'up' && typeof full.version === 'string' && full.containment && 'exportLagSeconds' in full.audit, 'the token: database, signer, version, audit lags, containment counts', text.slice(0, 300));
    check(!text.includes(acme.id) && !text.includes('Acme') && !text.includes('@'), 'and no names, ids or addresses');
  }
}

async function cleanup() {
  await stop('api'); await stop('signer');
  try {
    if (created.quickConnectWas !== null) await prisma.platformSettings.update({ where: { id: 'singleton' }, data: { quickConnectEnabled: created.quickConnectWas } });
    if (created.businesses.length) {
      await prisma.containmentPause.updateMany({ where: { clearedAt: null, OR: [{ customerId: { in: created.businesses } }, { setById: { in: created.users } }] }, data: { clearedAt: new Date(), clearReason: 'e2e cleanup' } });
      await prisma.actionJob.deleteMany({ where: { customerId: { in: created.businesses } } });
      await prisma.integrationTechnicianMapping.deleteMany({ where: { peerId: PEER } });
      await prisma.integrationOrgMapping.deleteMany({ where: { peerId: PEER } });
      await prisma.technicianAssignment.deleteMany({ where: { customerId: { in: created.businesses } } });
      const eps = await prisma.endpoint.findMany({ where: { customerId: { in: created.businesses } }, select: { id: true } });
      await prisma.rustdeskNode.deleteMany({ where: { endpointId: { in: eps.map((e) => e.id) } } });
      await prisma.endpoint.deleteMany({ where: { id: { in: eps.map((e) => e.id) } } });
      await prisma.membership.deleteMany({ where: { customerId: { in: created.businesses } } });
      await prisma.customer.deleteMany({ where: { id: { in: created.businesses } } });
    }
    if (created.users.length) await prisma.user.deleteMany({ where: { id: { in: created.users } } });
  } catch (e) { console.error('cleanup:', e.message); }
  await prisma.$disconnect();
  rmSync(work, { recursive: true, force: true });
}

all().catch((e) => { fail++; failures.push(`crashed: ${e.stack ?? e}`); console.error(e); if (kids.api) console.error(kids.api.log.slice(-2500)); if (kids.signer) console.error(kids.signer.log.slice(-1500)); })
  .finally(async () => {
    await cleanup();
    console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
    if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
  });
