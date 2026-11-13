#!/usr/bin/env node
/**
 * End-to-end proof of the maintenance actions (v0.32) in the signed catalog:
 * restart an allowlisted service, schedule a warned restart, cancel it, and
 * collect a fixed set of logs.
 *
 * Self-contained, like e2e-approved-action.mjs: a signed update repository
 * from the offline release tool, the approval signer as its own process, the
 * compiled API on its own port (3251) and a scratch database, synthetic
 * passkeys checked by the signer's real WebAuthn verification, and
 * rem0te-action-sim — the agent's real verifier and executor
 * (tools/windows-installer/internal/action) against a simulated Windows.
 *
 *   cd apps/api && npx nest build
 *   (cd ../../tools/windows-installer && go build -o /tmp/rem0te-release ./cmd/rem0te-release \
 *      && go build -o /tmp/rem0te-action-sim ./cmd/rem0te-action-sim)
 *   RELEASE_BIN=/tmp/rem0te-release ACTION_SIM=/tmp/rem0te-action-sim \
 *   DATABASE_URL=postgresql://…/reboot_remote_it_scratch node scripts/e2e-maintenance-actions.mjs
 *
 * What it proves is FIXTURE-TESTED behaviour. The service manager,
 * shutdown.exe, wevtutil and the RustDesk session check are simulated; none
 * of it has run on a real Windows computer.
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
const { ActionProposalRequest } = require(path.join(dist, 'integration/contract.js'));
const { canonicalJson } = C;

const DB = process.env.DATABASE_URL ?? '';
const dbName = DB.split('/').pop()?.split('?')[0] ?? '';
if (!/scratch|test/.test(dbName)) {
  console.error(`Refusing to run against database "${dbName}": name must contain "scratch" or "test".`);
  process.exit(2);
}
const BIN = process.env.RELEASE_BIN, SIM = process.env.ACTION_SIM;
if (!BIN || !SIM) { console.error('RELEASE_BIN (rem0te-release) and ACTION_SIM (rem0te-action-sim) are required'); process.exit(2); }
const PORT = Number(process.env.MAINT_API_PORT ?? 3251);
const SIGNER_PUBLIC = Number(process.env.MAINT_SIGNER_PUBLIC_PORT ?? 3252);
const SIGNER_INTERNAL = Number(process.env.MAINT_SIGNER_INTERNAL_PORT ?? 3253);
if ([PORT, SIGNER_PUBLIC, SIGNER_INTERNAL].some((p) => [3000, 3001, 443, 3201, 3202, 4000, 4001].includes(p))) { console.error('refusing a production port'); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
const ROOT = `http://127.0.0.1:${PORT}`;
const ORIGIN = `http://127.0.0.1:${SIGNER_PUBLIC}`;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'maint-e2e-password-123';
const ALL_ACTIONS = ['windows.service.start@1', 'windows.update.install@1', 'windows.service.restart@1', 'windows.reboot.schedule@1', 'windows.reboot.cancel@1', 'windows.logs.collect@1'];

let pass = 0, fail = 0; const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;
const sha = (b) => createHash('sha256').update(b).digest('hex');

// ── The release machine ─────────────────────────────────────────────────────
const work = mkdtempSync(path.join(tmpdir(), 'rem0te-maint-'));
const keys = path.join(work, 'keys'); mkdirSync(keys);
const repo = path.join(work, 'repo');
const files = path.join(work, 'files'); mkdirSync(files);
const signerDir = path.join(work, 'signer'); mkdirSync(signerDir, { mode: 0o700 });
const rel = (...a) => execFileSync(BIN, a, { encoding: 'utf8' });
const signerCli = (args) => spawnSync(process.execPath, [path.join(dist, 'approval-signer', 'main.js'), ...args], { encoding: 'utf8', env: { ...process.env, APPROVAL_SIGNER_DIR: signerDir } });
for (const k of ['r1', 'r2', 'r3', 'targets', 'snapshot', 'timestamp']) rel('keygen', '-out', path.join(keys, `${k}.pem`));
rel('init', '-repo', repo, '-root-key', path.join(keys, 'r1.pem'), '-root-key', path.join(keys, 'r2.pem'), '-root-key', path.join(keys, 'r3.pem'),
  '-root-threshold', '2', '-targets-key', path.join(keys, 'targets.pem'), '-snapshot-key', path.join(keys, 'snapshot.pem'), '-timestamp-key', path.join(keys, 'timestamp.pem'));
const slot = Buffer.concat([Buffer.from('REM0TE_INST_URL:'), Buffer.alloc(240)]);
const agentBin = Buffer.concat([Buffer.from('MZ stand-in signed agent 0.32 '), randomBytes(64), slot]);
writeFileSync(path.join(files, 'agent.exe'), agentBin);
const AGENT_SHA = sha(agentBin);
const kg = signerCli(['keygen']);
if (kg.status !== 0) throw new Error(`signer keygen: ${kg.stderr}`);
writeFileSync(path.join(files, 'approval-keys.json'), kg.stdout);
rel('release', '-repo', repo, '-targets-key', path.join(keys, 'targets.pem'), '-snapshot-key', path.join(keys, 'snapshot.pem'), '-timestamp-key', path.join(keys, 'timestamp.pem'),
  '-add', `windows/rem0te-agent.exe=${path.join(files, 'agent.exe')}`, '-add', `approval/keys.json=${path.join(files, 'approval-keys.json')}`);

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

// ClientSt0r, only to show the maintenance actions are not offered to it.
const pair = () => generateKeyPairSync('ed25519');
const pem = (k) => k.export({ type: 'spki', format: 'pem' }).toString();
const self = pair(), peerReq = pair(), peerDel = pair();
writeFileSync(path.join(work, 'self.pem'), self.privateKey.export({ type: 'pkcs8', format: 'pem' }));
const AUD = 'rem0te:maint-lab', PEER = `clientst0r-maint-${sfx}`;
const peersFile = path.join(work, 'peers.json');
writeFileSync(peersFile, JSON.stringify({
  self: { keyId: 'rem0te-maint-1', privateKeyFile: path.join(work, 'self.pem') },
  peers: [{ id: PEER, audience: AUD, peerAudience: 'clientst0r:maint-lab', requestKeys: [{ kid: 'req-1', publicKeyPem: pem(peerReq.publicKey) }], delegationKeys: [{ kid: 'del-1', publicKeyPem: pem(peerDel.publicKey) }], inferenceUrl: 'http://127.0.0.1:9/api/integration/v1/inference', eventsUrl: 'http://127.0.0.1:9/api/integration/v1/events', modelProfiles: ['triage-fast'] }],
}));
const apiEnv = {
  ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATABASE_URL: DB, UPDATE_REPO_DIR: repo, MONITOR_SWEEP: 'off',
  APPROVAL_SIGNER_INTERNAL_URL: `http://127.0.0.1:${SIGNER_INTERNAL}`, INTEGRATION_PEERS_FILE: peersFile,
  JWT_SECRET: randomBytes(32).toString('hex'), LAUNCHER_TOKEN_SECRET: randomBytes(32).toString('hex'),
  ENCRYPTION_KEY: randomBytes(32).toString('hex'), TRUSTED_PROXIES: 'loopback',
  VERSION_FILE: path.resolve(here, '..', '..', '..', 'version.json'),
};
async function waitUp(url, name) {
  for (let i = 0; i < 120; i++) { try { const r = await fetch(url); if (r.status < 500) return; } catch { /* not yet */ } await sleep(300); }
  throw new Error(`${name} did not come up:\n${kids[name]?.log.slice(-3000)}`);
}

// ── HTTP helpers ────────────────────────────────────────────────────────────
async function req(method, p, { s, body, business } = {}) {
  const h = { 'content-type': 'application/json', 'x-forwarded-for': s?.ip ?? ip() };
  if (s) h.cookie = s.cookie;
  if (business) h['x-rem0te-business'] = business;
  const r = await fetch(`${API}${p}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j };
}
async function login(email) {
  const s = { ip: ip() };
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': s.ip }, body: JSON.stringify({ email, password: PW }) });
  const m = (r.headers.get('set-cookie') ?? '').match(/access_token=([^;]+)/);
  if (r.status !== 200 || !m) throw new Error(`login ${email}: ${r.status} ${await r.text()}`);
  s.cookie = `access_token=${m[1]}`;
  return s;
}
const code = (r) => r.body?.code ?? r.body?.message?.code ?? r.body?.error?.code;
const msg = (r) => `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`;
const sj = async (url, init = {}) => { const r = await fetch(url, init); let b = null; try { b = await r.json(); } catch { /* html */ } return { status: r.status, body: b }; };
const signerPost = (id, p, body) => sj(`${ORIGIN}/approve/${id}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify(body) });
async function approve(jobId, who, { decision = 'approve', role = 'approver' } = {}) {
  const c = await signerPost(jobId, '/challenge', { decision, role });
  if (c.status !== 200) return c;
  return signerPost(jobId, '/decide', { challengeId: c.body.challengeId, assertion: who.assert(c.body.options, { origin: ORIGIN }) });
}
const heartbeat = (ep, extra = {}) => req('POST', '/enrollment/heartbeat', {
  body: { rustdeskId: ep.rid, agentSecret: ep.secret, hostname: ep.hostname, platform: 'Windows', updateChannel: 'signed', agentActions: ep.actions, agentSha256: AGENT_SHA, ...extra },
});
function resultsOf(ep) {
  const d = path.join(ep.state, 'actions', 'results');
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => /^[0-9a-f]{32}\.json$/.test(f)).map((f) => JSON.parse(readFileSync(path.join(d, f), 'utf8')));
}
function clearAcked(ep, acks) { for (const a of acks ?? []) rmSync(path.join(ep.state, 'actions', 'results', `${a}.json`), { force: true }); }
let keysFile;
function runAgent(ep, jobId, envelope, { service, sessions, eventsDir, rustdeskLogs, pause, stopFails } = {}) {
  const envFile = path.join(work, `env-${jobId}-${randomBytes(3).toString('hex')}.json`);
  writeFileSync(envFile, JSON.stringify(envelope));
  const args = ['-state', ep.state, '-keys', keysFile, '-job', jobId, '-envelope', envFile, '-rustdesk-id', ep.rid, '-secret', ep.secret, '-product-type', String(ep.productType), '-self-sha', AGENT_SHA];
  if (service) args.push('-service', service);
  if (sessions !== undefined) args.push(`-sessions=${sessions}`);
  if (stopFails) args.push('-stop-fails');
  if (eventsDir) args.push('-events-dir', eventsDir);
  if (rustdeskLogs) args.push('-rustdesk-logs', rustdeskLogs);
  if (pause) args.push('-pause', pause);
  // 0.36: the agent fetches the signer's revocation statement from the portal's relay before each job.
  args.push('-portal', `127.0.0.1:${PORT}`);
  return JSON.parse(execFileSync(SIM, args, { encoding: 'utf8' }).trim());
}
const simService = (ep, v) => writeFileSync(path.join(ep.state, 'sim-service'), v);
const simServiceNow = (ep) => readFileSync(path.join(ep.state, 'sim-service'), 'utf8');
const simRestart = (ep) => (existsSync(path.join(ep.state, 'sim-restart')) ? readFileSync(path.join(ep.state, 'sim-restart'), 'utf8') : null);

// ClientSt0r client.
function token({ sub, org, scope, req_sha256 }) {
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
const hashProposal = (b) => { const r = ActionProposalRequest.safeParse(b); return C.sha256Hex(canonicalJson(r.success ? r.data : b)); };

const created = { businesses: [], users: [] };

async function all() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  const roleUser = await prisma.role.findFirst({ where: { type: 'BUSINESS_USER' } });
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });

  section('Fixtures (synthetic): Acme, with FRONTDESK (0.32 agent), OLDPC (0.26 agent) and a standard-channel PC');
  const acme = await prisma.customer.create({ data: { tenantId: tenant.id, name: `MA Acme ${sfx}` } });
  created.businesses.push(acme.id);
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag, extra = {}) => { const u = await prisma.user.create({ data: { email: `ma-${tag}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'MA', lastName: tag, status: 'ACTIVE', ...extra } }); created.users.push(u.id); return u; };
  const admin = await mkUser('admin', { isPlatformAdmin: true });
  const dana = await mkUser('dana-l2'), sam = await mkUser('sam-l3'), lena = await mkUser('lena-custom'), pat = await mkUser('pat-user'), owen = await mkUser('owen-owner');
  const olivia = await mkUser('olivia-approver', { platformPermissions: ['technicians:manage'] }), quinn = await mkUser('quinn-approver', { platformPermissions: ['technicians:manage'] });
  await prisma.membership.create({ data: { userId: owen.id, tenantId: tenant.id, customerId: acme.id, roleId: roleOwner.id, capabilities: [] } });
  await prisma.membership.create({ data: { userId: pat.id, tenantId: tenant.id, customerId: acme.id, roleId: roleUser.id, capabilities: ['computers:view', 'actions:request'] } });
  const l2 = await prisma.technicianPreset.findUnique({ where: { key: 'l2-technician' } });
  const l3 = await prisma.technicianPreset.findUnique({ where: { key: 'l3-senior' } });
  if (!l2 || !l3) throw new Error('built-in presets missing: boot the API once against this database (run-e2e.sh does)');
  await prisma.technicianAssignment.create({ data: { tenantId: tenant.id, customerId: acme.id, userId: dana.id, presetId: l2.id, capabilities: [] } });
  await prisma.technicianAssignment.create({ data: { tenantId: tenant.id, customerId: acme.id, userId: sam.id, presetId: l3.id, capabilities: [] } });
  const lenaGrant = await prisma.technicianAssignment.create({ data: { tenantId: tenant.id, customerId: acme.id, userId: lena.id, capabilities: ['computers:view', 'actions:request', 'computers:event_logs'] } });
  const mkEp = async (hostname, actions, channel = 'signed') => {
    const e = await prisma.endpoint.create({ data: { tenantId: tenant.id, customerId: acme.id, name: hostname, hostname, status: 'ACTIVE', isOnline: true, isManaged: true, accessMode: 'COMPANY_WIDE', lastSeenAt: new Date(), deviceClass: 'WORKSTATION' } });
    const rid = String(100000000 + ((Math.random() * 899999999) | 0));
    const secret = randomBytes(24).toString('hex');
    await prisma.rustdeskNode.create({ data: { tenantId: tenant.id, endpointId: e.id, rustdeskId: rid, agentSecretHash: sha(secret) } });
    const state = path.join(work, `agent-${hostname}`); mkdirSync(state);
    return { id: e.id, rid, secret, state, productType: 1, hostname, actions, channel };
  };
  const fd = await mkEp('FRONTDESK', ALL_ACTIONS);
  const old = await mkEp('OLDPC', ALL_ACTIONS.slice(0, 2));
  const std = await mkEp('STDPC', [], 'legacy');
  const pk = { olivia: syntheticPasskey({ userId: olivia.id, name: 'MA olivia' }), quinn: syntheticPasskey({ userId: quinn.id, name: 'MA quinn' }) };
  for (const k of Object.values(pk)) await prisma.userMfaMethod.create({ data: { userId: k.userId, type: 'WEBAUTHN', isActive: true, credentialId: k.credentialId, publicKey: Buffer.from(k.publicKey, 'base64url'), signCount: 0, name: 'Test key' } });
  check(true, 'one business, three computers, seven people');

  start('signer', path.join(dist, 'approval-signer', 'main.js'), signerEnv);
  start('api', path.join(dist, 'main.js'), apiEnv);
  await waitUp(`http://127.0.0.1:${SIGNER_INTERNAL}/internal/v1/keys`, 'signer');
  await waitUp(`${API}/health`, 'api');
  const S = {};
  for (const [k, u] of Object.entries({ admin, dana, sam, lena, pat, owen, olivia, quinn })) S[k] = await login(u.email);

  section('Roster and keys');
  for (const who of ['olivia', 'quinn']) {
    const list = await req('GET', '/auth/passkeys', { s: S[who] });
    const mine = (list.body?.data ?? list.body ?? [])[0];
    const add = signerCli(['roster', 'add', '--export', mine.approvalExport, '--approve', '*', '--confirm-fingerprint', mine.approvalFingerprint]);
    if (add.status !== 0) throw new Error(`roster add ${who}: ${add.stderr}`);
  }
  {
    const metas = readdirSync(path.join(repo, 'metadata')).filter((f) => /^\d+\.targets\.json$/.test(f)).sort((a, b) => parseInt(b) - parseInt(a));
    const targets = await (await fetch(`${API}/public/updates/metadata/${metas[0]}`)).json();
    const t = targets.signed.targets['approval/keys.json'];
    const buf = Buffer.from(await (await fetch(`${API}/public/updates/targets/approval/${t.hashes.sha256}.keys.json`)).arrayBuffer());
    check(sha(buf) === t.hashes.sha256, 'approval/keys.json comes through the portal mirror and matches signed metadata');
    keysFile = path.join(work, 'keys.json'); writeFileSync(keysFile, buf);
  }
  for (const ep of [fd, old]) await heartbeat(ep);
  await req('POST', '/enrollment/heartbeat', { body: { rustdeskId: std.rid, agentSecret: std.secret, hostname: std.hostname, platform: 'Windows' } });

  section('Catalog: the six actions here (plus 0.34\'s script run); the four maintenance ones closed, high impact, not offered to ClientSt0r');
  {
    const cat = await req('GET', '/actions/catalog', { s: S.sam, business: acme.id });
    const acts = cat.body?.data?.actions ?? [];
    const by = Object.fromEntries(acts.map((a) => [a.id, a]));
    // The six through 0.32, in order, then 0.34's script run and software install/uninstall, and 0.41's program removal: the exact, ordered catalog (§ 14).
    check(acts.map((a) => `${a.id}@${a.version}`).join(',') === [...ALL_ACTIONS, 'windows.script.run@1', 'windows.software.install@1', 'windows.software.uninstall@1', 'windows.software.remove@1'].join(','), 'GET /actions/catalog lists exactly the six, in order, then 0.34\'s windows.script.run, windows.software.install and windows.software.uninstall, and 0.41\'s windows.software.remove', acts.map((a) => a.id).join(','));
    check(['windows.service.restart', 'windows.reboot.schedule', 'windows.reboot.cancel', 'windows.logs.collect'].every((id) => by[id]?.workstationRisk === 'high' && by[id]?.direct === true),
      'each maintenance action is high impact even on a standard workstation, and requestable from the computer');
    check(by['windows.service.restart']?.choice?.options.map((o) => o.value).join(',') === 'Spooler,wuauserv,BITS,W32Time,WinRM,RustDesk', 'restart offers exactly the allowlist', JSON.stringify(by['windows.service.restart']?.choice));
    check(by['windows.reboot.schedule']?.maxWindowHours === 2 && by['windows.reboot.schedule'].choice.options[0].value === 5 && /closed without saving/.test(by['windows.reboot.schedule'].warnings.join(' ')),
      'restart: 2-hour window, 5-minute minimum warning, and the warning says unsaved work is lost');
    check(by['windows.logs.collect']?.requiresCapability === 'computers:event_logs', 'log collection needs computers:event_logs');
    const caps = await call('GET', '/api/integration/v1/capabilities');
    check(caps.status === 200 && caps.body.features.actions.join(',') === 'windows.service.start@1,windows.update.install@1', 'ClientSt0r is offered only the two 0.26/0.27 actions', JSON.stringify(caps.body?.features?.actions));
    const pb = { contract: 'ticket-rmm-v1', idempotency_key: `cs-${randomBytes(6).toString('hex')}`, organization_id: 'org-x', technician_id: 'cs-tech', rem0te_endpoint_id: fd.id, action: { id: 'windows.reboot.schedule', version: 1 }, params: { delayMinutes: 30 }, reason: 'AI triage suggests a restart', origin: 'ai_suggestion', ticket_ref: 't-1' };
    const pr = await call('POST', '/api/integration/v1/action-proposals', { body: pb, delegation: token({ sub: 'cs-tech', org: 'org-x', scope: 'actions:propose', req_sha256: hashProposal(pb) }) });
    check(pr.status === 400 && pr.body?.error?.code === 'ACTION_NOT_IN_CATALOG', 'a ClientSt0r proposal to schedule a restart → ACTION_NOT_IN_CATALOG', JSON.stringify(pr.body).slice(0, 200));
  }

  section('Requests: closed parameters, the right people, ready computers');
  const restart = (service, over = {}) => ({ actionId: 'windows.service.restart', version: 1, params: { service }, reason: 'Ticket 7: Windows Update stuck', ...over });
  const reboot = (delayMinutes, over = {}) => ({ actionId: 'windows.reboot.schedule', version: 1, params: { delayMinutes }, reason: 'Ticket 8: pending updates need a restart', windowHours: 1, ...over });
  const cancelB = { actionId: 'windows.reboot.cancel', version: 1, params: {}, reason: 'Ticket 8: user asked to postpone', windowHours: 1 };
  const logsB = { actionId: 'windows.logs.collect', version: 1, params: {}, reason: 'Ticket 9: RustDesk drops' };
  {
    // A fresh source address per refusal: the request route allows 10 a
    // minute per address (RateLimit(10)), and this section makes 16.
    const sam = (b, ep = fd) => req('POST', `/endpoints/${ep.id}/actions`, { s: { ...S.sam, ip: ip() }, business: acme.id, body: b });
    for (const [n, b] of [['WinDefend (a security product)', restart('WinDefend')], ['lsass', restart('lsass')], ['EventLog', restart('EventLog')], ['lower-case spooler', restart('spooler')],
      ['an extra field', restart('Spooler', { params: { service: 'Spooler', args: '/c whoami' } })], ['an immediate restart (0)', reboot(0)], ['a 4-minute restart', reboot(4)],
      ['a restart over 24 hours', reboot(1441)], ['a fractional delay', reboot(7.5)], ['a custom restart message', reboot(30, { params: { delayMinutes: 30, message: 'Click here' } })],
      ['a log collection naming a file', { ...logsB, params: { path: 'C:\\Windows\\System32\\config\\SAM' } }], ['a cancel with parameters', { ...cancelB, params: { force: true } }]]) {
      const r = await sam(b);
      check(r.status === 400 && code(r) === 'PARAMS_NOT_ALLOWED', `${n} → 400 PARAMS_NOT_ALLOWED`, msg(r));
    }
    let r = await sam(reboot(30, { windowHours: 4 }));
    check(r.status === 400 && code(r) === 'WINDOW_TOO_LONG', 'a restart plan with a 4-hour window → 400 WINDOW_TOO_LONG', msg(r));
    r = await req('POST', `/endpoints/${fd.id}/actions`, { s: S.dana, business: acme.id, body: restart('Spooler') });
    check(r.status === 403 && code(r) === 'ACTION_NOT_GRANTED', 'an L2 technician (low-risk fixes only) → 403: maintenance is higher risk', msg(r));
    r = await req('POST', `/endpoints/${fd.id}/actions`, { s: S.pat, body: logsB });
    check(r.status === 403 && code(r) === 'ACTION_NOT_GRANTED' && /computers:event_logs/.test(JSON.stringify(r.body)), 'a Business User with actions:request but not computers:event_logs cannot collect logs', msg(r));
    r = await sam(restart('Spooler'), old);
    check(r.status === 409 && code(r) === 'ENDPOINT_NOT_READY', 'a 0.26 agent that does not report the action → 409 ENDPOINT_NOT_READY', msg(r));
    r = await sam(restart('Spooler'), std);
    check(r.status === 409 && code(r) === 'ENDPOINT_NOT_READY', 'a standard-channel computer → 409 ENDPOINT_NOT_READY', msg(r));
  }

  // One request, through two approvals, to a delivered envelope.
  async function approved(s, ep, body, business = acme.id) {
    const r = await req('POST', `/endpoints/${ep.id}/actions`, { s, business, body });
    const job = r.body?.data;
    if (r.status !== 201) return { r, job: null };
    const a1 = await approve(job.id, pk.olivia);
    const mid = await req('GET', `/actions/${job.id}`, { s, business });
    const a2 = await approve(job.id, pk.quinn);
    const after = await req('GET', `/actions/${job.id}`, { s, business });
    return { r, job, oneApproval: mid.body?.data?.status, a1, a2, status: after.body?.data?.status };
  }
  const deliver = async (ep, jobId) => ((await heartbeat(ep)).body?.data?.actions ?? []).find((d) => d.jobId === jobId)?.envelope;
  const report = async (ep) => { const h = await heartbeat(ep, { actionResults: resultsOf(ep) }); clearAcked(ep, h.body?.data?.actionAcks); return h; };
  const audited = async (id) => new Set((await prisma.activityLog.findMany({ where: { resourceId: id }, select: { action: true } })).map((a) => a.action));

  section('Restart an approved service: two approvers, stop, start, verify, journal');
  {
    const x = await approved(S.sam, fd, restart('wuauserv'));
    check(x.r.status === 201 && x.job.risk === 'high' && x.job.approvalsRequired === 2, 'Sam (L3) requests a restart of wuauserv: high risk, two approvals', msg(x.r));
    check(x.oneApproval === 'AWAITING_APPROVAL' && x.status === 'APPROVED', 'one approval is not enough; the second, different approver signs it');
    const page = await (await fetch(x.job.approvalUrl)).text();
    check(page.includes('wuauserv') && /disconnects anyone connected/.test(page), 'the approval page shows the service and the warnings');
    const env = await deliver(fd, x.job.id);
    simService(fd, 'running');
    const res = runAgent(fd, x.job.id, env);
    check(res.outcome === 'succeeded' && res.observed?.service === 'wuauserv' && res.observed?.before === 'running' && res.observed?.stopped === 'stopped'
      // The sim's checks are 1 ms apart, so they share one afterNs key; on Windows they are after10s and after30s.
      && Object.keys(res.observed).some((k) => /^after\d+s$/.test(k)) && Object.entries(res.observed).filter(([k]) => /^after\d+s$/.test(k)).every(([, v]) => v === 'running') && simServiceNow(fd) === 'running',
      'the agent stops it, starts it and sees it running at both checks', JSON.stringify(res));
    const j = JSON.parse(readFileSync(path.join(fd.state, 'actions', 'journal', `${x.job.id}.json`), 'utf8'));
    check(j.state === 'done' && j.result?.outcome === 'succeeded', 'the journal records the job as done, with its result');
    simService(fd, 'stopped');
    const again = runAgent(fd, x.job.id, env);
    check(again.outcome === 'succeeded' && simServiceNow(fd) === 'stopped', 'a re-delivered envelope is answered from the journal: nothing is restarted twice', JSON.stringify(again));
    await report(fd);
    const g = await req('GET', `/actions/${x.job.id}`, { s: S.sam, business: acme.id });
    check(g.body?.data?.status === 'SUCCEEDED' && g.body.data.result?.observed?.stopped === 'stopped', 'recorded SUCCEEDED with what the agent saw', msg(g));
    const acts = await audited(x.job.id);
    check(['ACTION_REQUESTED', 'ACTION_APPROVAL_UPDATED', 'ACTION_DISPATCHED', 'ACTION_RESULT'].every((a) => acts.has(a)), 'requested, approved, dispatched and result are audited', [...acts].join(','));
  }
  {
    const x = await approved(S.sam, fd, restart('WinRM'));
    const env = await deliver(fd, x.job.id);
    simService(fd, 'running');
    const res = runAgent(fd, x.job.id, env, { stopFails: true });
    check(res.outcome === 'failed' && res.reason === 'stop_failed' && simServiceNow(fd) === 'running', 'a service with running dependents: the stop fails, nothing else is stopped and nothing is started', JSON.stringify(res));
    await report(fd);
  }

  section('Restarting RustDesk waits until nobody is connected');
  {
    const x = await approved(S.sam, fd, restart('RustDesk'));
    const env = await deliver(fd, x.job.id);
    simService(fd, 'running');
    const res = runAgent(fd, x.job.id, env, { sessions: 1 });
    check(res.outcome === 'not_executed' && res.reason === 'remote_session_open' && simServiceNow(fd) === 'running', 'an open RustDesk session → not executed; RustDesk keeps running', JSON.stringify(res));
    const sent = resultsOf(fd).map((r) => ({ ...r, logs: [{ source: 'agent_log', text: 'smuggled', truncated: false }] }));
    const h = await heartbeat(fd, { actionResults: sent }); clearAcked(fd, h.body?.data?.actionAcks);
    const row = await prisma.actionJob.findUnique({ where: { id: x.job.id } });
    check(row.status === 'NOT_EXECUTED' && !('logs' in (row.result ?? {})), 'recorded NOT_EXECUTED; a "logs" field on a non-collection result is dropped', JSON.stringify(row.result).slice(0, 200));
    const y = await approved(S.sam, fd, restart('RustDesk'));
    const res2 = runAgent(fd, y.job.id, await deliver(fd, y.job.id), { sessions: -1 });
    check(res2.outcome === 'not_executed' && res2.reason === 'session_state_unknown', 'if the agent cannot tell, it counts as connected: not executed', JSON.stringify(res2));
    await report(fd);
  }

  section('Schedule a restart: fixed warning, bounded delay, never immediate');
  let rebootJob;
  {
    const x = await approved(S.sam, fd, reboot(30));
    check(x.r.status === 201 && x.job.risk === 'high' && x.status === 'APPROVED', 'a 30-minute restart on a workstation needs and gets two approvals', msg(x.r));
    const w = x.job.window;
    check(Date.parse(w.notAfter) - Date.parse(w.notBefore) === 3600_000, 'its signed window is the 1 hour asked for');
    const env = await deliver(fd, x.job.id);
    const sess = runAgent(fd, x.job.id, env, { sessions: 2 });
    check(sess.outcome === 'not_executed' && sess.reason === 'remote_session_open' && simRestart(fd) === null, 'with a session open the restart is not scheduled (and the job is final)', JSON.stringify(sess));
    await report(fd);
    const x2 = await approved(S.sam, fd, reboot(30));
    rebootJob = x2.job;
    const res = runAgent(fd, x2.job.id, await deliver(fd, x2.job.id), { sessions: 0 });
    const sched = simRestart(fd) ?? '';
    const [secs, ...m] = sched.split('\n');
    const message = m.join('\n');
    check(res.outcome === 'succeeded' && secs === '1800' && /^Your IT support provider has scheduled a restart of this computer for .+ \(in 30 minutes\)\. Please save your work/.test(message) && message.includes(x2.job.id.slice(0, 8)),
      'with nobody connected: shutdown /r /t 1800 with the fixed message naming the time and the job', JSON.stringify({ res, sched }));
    check(Math.abs(Date.parse(res.observed?.scheduledFor) - (Date.now() + 1800_000)) < 120_000, 'the agent reports the time it scheduled the restart for', JSON.stringify(res.observed));
    check(!/Ticket 8/.test(message), 'nothing the requester typed reaches the message');
    await report(fd);
    const g = await req('GET', `/actions/${x2.job.id}`, { s: S.sam, business: acme.id });
    check(g.body?.data?.status === 'SUCCEEDED' && g.body.data.result?.observed?.delayMinutes === '30', 'recorded SUCCEEDED (scheduled — the restart itself is not claimed)', msg(g));
    const x3 = await approved(S.sam, fd, reboot(60));
    const res3 = runAgent(fd, x3.job.id, await deliver(fd, x3.job.id), { sessions: 0 });
    check(res3.outcome === 'failed' && res3.reason === 'restart_already_scheduled' && simRestart(fd).startsWith('1800\n'), 'a second schedule while one is pending fails and leaves the first alone', JSON.stringify(res3));
    await report(fd);
  }

  section('Cancel the scheduled restart: a second signed action');
  {
    const x = await approved(S.sam, fd, cancelB);
    check(x.r.status === 201 && x.status === 'APPROVED' && x.job.approvalsRequired === 2, 'the cancel is its own plan with two approvals', msg(x.r));
    const res = runAgent(fd, x.job.id, await deliver(fd, x.job.id));
    check(res.outcome === 'succeeded' && simRestart(fd) === null && res.observed?.scheduledBy === rebootJob.id, 'the pending restart is canceled; the agent names the job that scheduled it', JSON.stringify(res));
    await report(fd);
    const y = await approved(S.sam, fd, cancelB);
    const res2 = runAgent(fd, y.job.id, await deliver(fd, y.job.id));
    check(res2.outcome === 'no_change', 'canceling when nothing is pending: no change', JSON.stringify(res2));
    await report(fd);
    const row = await prisma.actionJob.findUnique({ where: { id: y.job.id } });
    check(row.status === 'SUCCEEDED' && row.outcome === 'no_change', 'recorded as no change');
  }

  section('Collect logs: fixed sources, bounded, redacted twice, shown only to who may read event logs');
  {
    const ev = path.join(work, 'events'); mkdirSync(ev);
    writeFileSync(path.join(ev, 'System.txt'), 'Event[0]:\r\n  Log Name: System\r\n  Source: Service Control Manager\r\n  Date: 2026-11-11T09:00:00.000\r\n  Event ID: 7031\r\n  Level: Error\r\n  User Name: CORP\\alice\r\n  Computer: FRONTDESK.corp.example\r\n  Description: \r\nThe RustDesk service terminated unexpectedly. C:\\Users\\alice\\AppData\\Local\\x.log token=abc123def\r\n');
    writeFileSync(path.join(ev, 'Application.txt'), '');
    const rd = path.join(work, 'rustdesk-log'); mkdirSync(path.join(rd, 'server'), { recursive: true });
    writeFileSync(path.join(rd, 'server', 'rustdesk_rCURRENT.log'), `[2026-11-11 09:00:01] INFO connection closed key=${'Q'.repeat(48)}\n${'a perfectly ordinary log line\n'.repeat(2000)}[2026-11-11 09:05] ERROR relay timeout\n`);
    writeFileSync(path.join(rd, 'server', 'RustDesk.toml'), "password = 'never-read'");
    mkdirSync(path.join(fd.state, 'Logs'), { recursive: true });
    writeFileSync(path.join(fd.state, 'Logs', 'agent.log'), '=== 2026-11-11 [action]\n  action x: succeeded\n  Authorization: Bearer live-bearer-token\n');
    const x = await approved(S.owen, fd, logsB, undefined);
    check(x.r.status === 201 && x.status === 'APPROVED', 'the Business Owner requests a log collection; two approvals', msg(x.r));
    const res = runAgent(fd, x.job.id, await deliver(fd, x.job.id), { eventsDir: ev, rustdeskLogs: rd });
    const src = (res.logs ?? []).map((s) => s.source).join(',');
    check(res.outcome === 'succeeded' && src === 'system_errors,application_errors,agent_journal,agent_log,rustdesk_log', 'the agent returns exactly the five fixed sources', JSON.stringify(res).slice(0, 300));
    const text = (res.logs ?? []).map((s) => s.text).join('\n');
    check(!/alice|abc123def|live-bearer-token|never-read|QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ/.test(text) && /%USERPROFILE%/.test(text) && /relay timeout/.test(text) && /Event ID: 7031/.test(text),
      'the agent redacts profile paths, tokens and credentials, never reads RustDesk\'s config, and keeps the useful lines', text.slice(0, 400));
    check(res.logs.every((s) => s.text.length <= 12 * 1024) && text.length <= 40 * 1024 && res.logs[4].truncated === true, 'each source at most 12 KB, all at most 40 KB; the long RustDesk log is marked shortened');
    // A compromised agent that skips redaction: the portal redacts again.
    const sent = resultsOf(fd).map((r) => r.jobId === x.job.id ? { ...r, logs: r.logs.map((s) => s.source === 'agent_log' ? { ...s, text: `${s.text}\npassword=hunter2 C:\\Users\\carol\\secret.txt ${'Z'.repeat(50)}` } : s) } : r);
    const h = await heartbeat(fd, { actionResults: sent }); clearAcked(fd, h.body?.data?.actionAcks);
    const asOwner = await req('GET', `/actions/${x.job.id}`, { s: S.owen });
    const stored = JSON.stringify(asOwner.body?.data?.result?.logs ?? []);
    check(asOwner.body?.data?.status === 'SUCCEEDED' && asOwner.body.data.result.logs?.length === 5, 'the owner sees the collected text on the Actions tab', msg(asOwner));
    check(!/hunter2|carol|ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ/.test(stored) && /password=\[redacted\]/.test(stored), 'what an agent sends unredacted is redacted again before it is stored', stored.slice(0, 300));
    const raw = await prisma.actionTarget.findFirst({ where: { jobId: x.job.id } });
    check(!/hunter2|carol/.test(JSON.stringify(raw.result)), 'the database row holds only the redacted text');
    const asPat = await req('GET', `/endpoints/${fd.id}/actions`, { s: S.pat });
    const patRow = (asPat.body?.data ?? []).find((j) => j.id === x.job.id);
    check(asPat.status === 200 && patRow && !patRow.result?.logs && !patRow.targets[0].result?.logs && /computers:event_logs/.test(patRow.result?.logsWithheld ?? ''),
      'a user without computers:event_logs sees that logs were collected, never the text', JSON.stringify(patRow?.result).slice(0, 200));
    const ar = await prisma.activityLog.findFirst({ where: { resourceId: x.job.id, action: 'ACTION_RESULT' } });
    check(Array.isArray(ar?.metadata?.logs) && !/relay timeout/.test(JSON.stringify(ar.metadata)), 'the audit entry records sizes, not the text');
  }

  section('A requester who loses computers:event_logs after approval: never delivered');
  {
    const x = await approved(S.lena, fd, logsB);
    check(x.r.status === 201 && x.status === 'APPROVED', 'Lena (custom grant with computers:event_logs) requests; approved', msg(x.r));
    await prisma.technicianAssignment.update({ where: { id: lenaGrant.id }, data: { capabilities: ['computers:view', 'actions:request'] } });
    const env = await deliver(fd, x.job.id);
    const row = await prisma.actionJob.findUnique({ where: { id: x.job.id } });
    check(!env && row.status === 'CANCELED' && row.statusReason === 'requester_lost_capability', 'the dispatch recheck cancels it: requester_lost_capability', JSON.stringify({ s: row.status, r: row.statusReason }));
  }

  section('Containment: held by the portal, refused by the agent before anything is asked');
  {
    const x = await approved(S.sam, fd, reboot(15));
    const pause = await prisma.containmentPause.create({ data: { scope: 'BUSINESS', customerId: acme.id, kinds: ['actions'], reason: 'maintenance e2e', setById: admin.id, setBy: 'msp' } });
    const held = await deliver(fd, x.job.id);
    check(!held, 'while actions are paused for the business the approved restart is not delivered');
    await prisma.containmentPause.update({ where: { id: pause.id }, data: { clearedAt: new Date(), clearedById: admin.id, clearReason: 'test' } });
    const env = await deliver(fd, x.job.id);
    check(!!env, 'delivered once the pause is lifted');
    const pf = path.join(work, 'pause.json');
    writeFileSync(pf, JSON.stringify({ schema: 'rem0te-pause/1', issuedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), reason: 'incident 12', actions: { all: false, businesses: [acme.id] }, updates: { all: false } }));
    const res = runAgent(fd, x.job.id, env, { pause: pf, sessions: 3 });
    check(res.outcome === 'refused' && res.reason === 'paused' && simRestart(fd) === null, 'a signed pause covering the business: refused "paused" — before the session check, and nothing scheduled', JSON.stringify(res));
    await report(fd);
  }
}

async function cleanup() {
  await stop('api'); await stop('signer');
  try {
    if (created.businesses.length) {
      await prisma.containmentPause.deleteMany({ where: { customerId: { in: created.businesses } } });
      await prisma.actionJob.deleteMany({ where: { customerId: { in: created.businesses } } });
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
