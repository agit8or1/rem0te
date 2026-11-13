#!/usr/bin/env node
/**
 * End-to-end proof of the first approved action (v0.26): start the Windows
 * Print Spooler once on one computer, approved by people on the approval
 * signer's roster with their passkeys.
 *
 * Self-contained. It
 *   - builds a signed update repository with the offline release tool,
 *     carrying a stand-in agent build and the signer's approval/keys.json;
 *   - starts the approval signer (dist/approval-signer/main.js) as its own
 *     process with its own directory, key, roster and policy;
 *   - starts the compiled API on a scratch port and database, pointed at both;
 *   - seeds two synthetic businesses, Acme and Birch, each with a FRONTDESK;
 *   - approves with synthetic passkeys (scripts/lib/synthetic-passkey.mjs)
 *     that the signer's real WebAuthn verification checks;
 *   - executes delivered envelopes with rem0te-action-sim, which is the
 *     agent's real verifier and executor (tools/windows-installer/
 *     internal/action) against a simulated Windows;
 *   - plays ClientSt0r for the action-proposal route, with signed requests and
 *     delegation tokens;
 * and removes its fixtures.
 *
 *   cd apps/api && npx nest build
 *   (cd ../../tools/windows-installer && go build -o /tmp/rem0te-release ./cmd/rem0te-release \
 *      && go build -o /tmp/rem0te-action-sim ./cmd/rem0te-action-sim)
 *   RELEASE_BIN=/tmp/rem0te-release ACTION_SIM=/tmp/rem0te-action-sim \
 *   DATABASE_URL=postgresql://…/reboot_remote_it_scratch node scripts/e2e-approved-action.mjs
 *
 * Optional: OLD_ACTION_SIM, a rem0te-action-sim built from a release before
 * 0.39, proves that an older agent refuses a direct-mode plan (bad_plan).
 *
 * What it proves is FIXTURE-TESTED behaviour: the portal, the signer and the
 * agent's decision code, with Windows, RustDesk and the person at the
 * authenticator simulated. It is not a paired lab and not production.
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, sign as edSign } from 'node:crypto';
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
const BIN = process.env.RELEASE_BIN, SIM = process.env.ACTION_SIM, OLD_SIM = process.env.OLD_ACTION_SIM;
if (!BIN || !SIM) { console.error('RELEASE_BIN (rem0te-release) and ACTION_SIM (rem0te-action-sim) are required'); process.exit(2); }
const PORT = Number(process.env.ACTIONS_API_PORT ?? 3161);
const SIGNER_PUBLIC = Number(process.env.ACTIONS_SIGNER_PUBLIC_PORT ?? 3263);
const SIGNER_INTERNAL = Number(process.env.ACTIONS_SIGNER_INTERNAL_PORT ?? 3264);
if ([PORT, SIGNER_PUBLIC, SIGNER_INTERNAL].some((p) => [3000, 3001, 443, 3201, 3202].includes(p))) { console.error('refusing a production port'); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
const ROOT = `http://127.0.0.1:${PORT}`;
const ORIGIN = `http://127.0.0.1:${SIGNER_PUBLIC}`;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'actions-e2e-password-123';

let pass = 0, fail = 0; const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;
const sha = (b) => createHash('sha256').update(b).digest('hex');

// ── The release machine: repository with the agent and the approval keys ───
const work = mkdtempSync(path.join(tmpdir(), 'rem0te-actions-'));
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
const agentBin = Buffer.concat([Buffer.from('MZ stand-in signed agent 0.26 '), randomBytes(64), slot]);
writeFileSync(path.join(files, 'agent.exe'), agentBin);
const AGENT_SHA = sha(agentBin);
const kg = signerCli(['keygen']);
if (kg.status !== 0) throw new Error(`signer keygen: ${kg.stderr}`);
writeFileSync(path.join(files, 'approval-keys.json'), kg.stdout);
const T = (n) => ['-targets-key', path.join(keys, 'targets.pem'), '-snapshot-key', path.join(keys, 'snapshot.pem'), '-timestamp-key', path.join(keys, 'timestamp.pem'), ...n];
// A malformed key list is refused before it can be signed into the chain.
writeFileSync(path.join(files, 'bad-keys.json'), JSON.stringify({ schema: 'rem0te-approval-keys/1', keys: [{ kid: 'attacker', ed25519: 'AAAA' }] }));
const badRel = spawnSync(BIN, ['release', '-repo', repo, ...T(['-add', `approval/keys.json=${path.join(files, 'bad-keys.json')}`])], { encoding: 'utf8' });
rel('release', '-repo', repo, ...T(['-add', `windows/rem0te-agent.exe=${path.join(files, 'agent.exe')}`, '-add', `approval/keys.json=${path.join(files, 'approval-keys.json')}`]));

// ── Processes ───────────────────────────────────────────────────────────────
const kids = {};
function start(name, script, env) {
  const p = spawn(process.execPath, [script, ...(name === 'signer' ? ['serve'] : [])], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  p.log = ''; p.stdout.on('data', (d) => { p.log += d; }); p.stderr.on('data', (d) => { p.log += d; });
  kids[name] = p; return p;
}
async function stop(name) { const p = kids[name]; if (!p || p.exitCode !== null) return; await new Promise((r) => { p.once('exit', r); p.kill('SIGTERM'); }); }
const signerEnv = { ...process.env, APPROVAL_SIGNER_DIR: signerDir, APPROVAL_ORIGIN: ORIGIN, APPROVAL_RP_ID: '127.0.0.1', APPROVAL_PUBLIC_PORT: String(SIGNER_PUBLIC), APPROVAL_INTERNAL_PORT: String(SIGNER_INTERNAL) };
delete signerEnv.DATABASE_URL; // the signer has no database; prove it does not need one

// ClientSt0r side keys and the peers file.
const pair = () => generateKeyPairSync('ed25519');
const pem = (k) => k.export({ type: 'spki', format: 'pem' }).toString();
const self = pair(), peerReq = pair(), peerDel = pair();
writeFileSync(path.join(work, 'self.pem'), self.privateKey.export({ type: 'pkcs8', format: 'pem' }));
const AUD = 'rem0te:actions-lab', PEER = `clientst0r-act-${sfx}`;
const peersFile = path.join(work, 'peers.json');
writeFileSync(peersFile, JSON.stringify({
  self: { keyId: 'rem0te-act-1', privateKeyFile: path.join(work, 'self.pem') },
  peers: [{ id: PEER, audience: AUD, peerAudience: 'clientst0r:actions-lab', requestKeys: [{ kid: 'req-1', publicKeyPem: pem(peerReq.publicKey) }], delegationKeys: [{ kid: 'del-1', publicKeyPem: pem(peerDel.publicKey) }], inferenceUrl: 'http://127.0.0.1:9/api/integration/v1/inference', eventsUrl: 'http://127.0.0.1:9/api/integration/v1/events', modelProfiles: ['triage-fast'] }],
}));
const apiEnv = {
  ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATABASE_URL: DB, UPDATE_REPO_DIR: repo,
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
  if (s) h.cookie = s.cookie + (s.stepUp ? `; step_up=${s.stepUp}` : '');
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
// 0.39: a fresh sign-in (direct mode needs one for every request).
async function stepUp(s) {
  const r = await fetch(`${API}/auth/step-up`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': s.ip, cookie: s.cookie }, body: JSON.stringify({ password: PW }) });
  const m = (r.headers.get('set-cookie') ?? '').match(/step_up=([^;]+)/);
  if (r.status !== 200 || !m) throw new Error(`step-up: ${r.status} ${await r.text()}`);
  s.stepUp = m[1];
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

// The heartbeat a signed agent sends; results are whatever the agent wrote.
const heartbeat = (ep, extra = {}) => req('POST', '/enrollment/heartbeat', {
  body: { rustdeskId: ep.rid, agentSecret: ep.secret, hostname: ep.hostname, platform: 'Windows', updateChannel: 'signed', agentActions: ['windows.service.start@1'], agentSha256: AGENT_SHA, ...extra },
});
function resultsOf(ep) {
  const d = path.join(ep.state, 'actions', 'results');
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => /^[0-9a-f]{32}\.json$/.test(f)).map((f) => JSON.parse(readFileSync(path.join(d, f), 'utf8')));
}
function clearAcked(ep, acks) { for (const a of acks ?? []) rmSync(path.join(ep.state, 'actions', 'results', `${a}.json`), { force: true }); }

// The approval keys as an agent would get them: through the portal's mirror
// of the signed repository, checked against signed targets metadata.
let keysFile;
async function fetchKeysViaMirror() {
  const metas = readdirSync(path.join(repo, 'metadata')).filter((f) => /^\d+\.targets\.json$/.test(f)).sort((a, b) => parseInt(b) - parseInt(a));
  const tr = await fetch(`${API}/public/updates/metadata/${metas[0]}`);
  const targets = await tr.json();
  const t = targets.signed.targets['approval/keys.json'];
  const r = await fetch(`${API}/public/updates/targets/approval/${t.hashes.sha256}.keys.json`);
  const buf = Buffer.from(await r.arrayBuffer());
  return { ok: tr.status === 200 && r.status === 200 && sha(buf) === t.hashes.sha256 && buf.length === t.length, buf };
}
function runAgent(ep, jobId, envelope, { productType = ep.productType, rid = ep.rid, secret = ep.secret, self = AGENT_SHA, state = ep.state, service, sim = SIM } = {}) {
  const envFile = path.join(work, `env-${jobId}-${randomBytes(3).toString('hex')}.json`);
  writeFileSync(envFile, JSON.stringify(envelope));
  const args = ['-state', state, '-keys', keysFile, '-job', jobId, '-envelope', envFile, '-rustdesk-id', rid, '-secret', secret, '-product-type', String(productType), '-self-sha', self];
  if (service) args.push('-service', service);
  // 0.36: the agent fetches the signer's revocation statement from the portal's relay before each job.
  args.push('-portal', `127.0.0.1:${PORT}`);
  const out = execFileSync(sim, args, { encoding: 'utf8' });
  return JSON.parse(out.trim());
}
const simService = (ep, v) => writeFileSync(path.join(ep.state, 'sim-service'), v);
const simServiceNow = (ep) => readFileSync(path.join(ep.state, 'sim-service'), 'utf8');

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
  return { status: r.status, body: j, headers: r.headers };
}
const hashProposal = (b) => { const r = ActionProposalRequest.safeParse(b); return C.sha256Hex(canonicalJson(r.success ? r.data : b)); };
const propose = (b, { sub = b.technician_id, org = b.organization_id } = {}) => call('POST', '/api/integration/v1/action-proposals', { body: b, delegation: token({ sub, org, scope: 'actions:propose', req_sha256: hashProposal(b) }) });

const created = { businesses: [], users: [] };


// ─────────────────────────────────────────────────────────────────────────────
// Everything runs from here, in order.
async function all() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  const roleUser = await prisma.role.findFirst({ where: { type: 'BUSINESS_USER' } });
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });

  section('Release and signer setup (offline)');
  check(badRel.status !== 0, 'rem0te-release refuses to sign a malformed approval key list', badRel.stderr.slice(0, 200));
  check(/rem0te-approval-keys\/1/.test(kg.stdout), 'the signer generates its key and prints approval/keys.json for the release machine');

  section('Fixtures (synthetic): Acme and Birch, each with a FRONTDESK');
  const acme = await prisma.customer.create({ data: { tenantId: tenant.id, name: `AA Acme ${sfx}` } });
  const birch = await prisma.customer.create({ data: { tenantId: tenant.id, name: `AA Birch ${sfx}` } });
  created.businesses.push(acme.id, birch.id);
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag, extra = {}) => { const u = await prisma.user.create({ data: { email: `aa-${tag}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'AA', lastName: tag, status: 'ACTIVE', ...extra } }); created.users.push(u.id); return u; };
  const admin = await mkUser('admin', { isPlatformAdmin: true });
  const dana = await mkUser('dana-l2'), sam = await mkUser('sam-l3'), pat = await mkUser('pat-user');
  const olivia = await mkUser('olivia-approver', { platformPermissions: ['technicians:manage'] }), quinn = await mkUser('quinn-approver', { platformPermissions: ['technicians:manage'] });
  const owen = await mkUser('owen-owner-acme'), bea = await mkUser('bea-owner-birch');
  const csTech = await mkUser('cs-tech');
  await prisma.membership.create({ data: { userId: owen.id, tenantId: tenant.id, customerId: acme.id, roleId: roleOwner.id, capabilities: [] } });
  await prisma.membership.create({ data: { userId: bea.id, tenantId: tenant.id, customerId: birch.id, roleId: roleOwner.id, capabilities: [] } });
  await prisma.membership.create({ data: { userId: pat.id, tenantId: tenant.id, customerId: acme.id, roleId: roleUser.id, capabilities: ['computers:view', 'computers:connect', 'integration:ticket_analysis'] } });
  const l2 = await prisma.technicianPreset.findUnique({ where: { key: 'l2-technician' } });
  const l3 = await prisma.technicianPreset.findUnique({ where: { key: 'l3-senior' } });
  await prisma.technicianAssignment.create({ data: { tenantId: tenant.id, customerId: acme.id, userId: dana.id, presetId: l2.id, capabilities: [] } });
  await prisma.technicianAssignment.create({ data: { tenantId: tenant.id, customerId: acme.id, userId: sam.id, presetId: l3.id, capabilities: [] } });
  await prisma.technicianAssignment.create({ data: { tenantId: tenant.id, customerId: acme.id, userId: csTech.id, capabilities: ['computers:view', 'integration:ticket_analysis', 'actions:request'] } });

  const mkEp = async (biz, hostname, deviceClass, productType, channel = 'signed') => {
    const e = await prisma.endpoint.create({ data: { tenantId: tenant.id, customerId: biz.id, name: hostname, hostname, status: 'ACTIVE', isOnline: true, isManaged: true, accessMode: 'COMPANY_WIDE', lastSeenAt: new Date(), deviceClass } });
    const rid = String(100000000 + ((Math.random() * 899999999) | 0));
    const secret = randomBytes(24).toString('hex');
    await prisma.rustdeskNode.create({ data: { tenantId: tenant.id, endpointId: e.id, rustdeskId: rid, agentSecretHash: sha(secret) } });
    const state = path.join(work, `agent-${hostname}-${biz.id.slice(-6)}`); mkdirSync(state);
    return { id: e.id, rid, secret, state, productType, channel, hostname };
  };
  const fdA = await mkEp(acme, 'FRONTDESK', 'WORKSTATION', 1);
  const fdB = await mkEp(birch, 'FRONTDESK', 'WORKSTATION', 1);
  const srv = await mkEp(acme, 'APPSRV', 'SERVER', 3);
  const old = await mkEp(acme, 'OLDPC', 'WORKSTATION', 1, 'legacy');
  check(true, 'Acme FRONTDESK and Birch FRONTDESK (same hostname), Acme APPSRV (server), Acme OLDPC (legacy agent)');
  const ORG_A = `org-a-${sfx}`;
  await prisma.integrationOrgMapping.create({ data: { peerId: PEER, externalOrgId: ORG_A, customerId: acme.id, tenantId: tenant.id, createdById: 'aa' } });
  await prisma.integrationTechnicianMapping.create({ data: { peerId: PEER, externalOrgId: ORG_A, externalTechnicianId: 'cs-tech-a', userId: csTech.id, createdById: 'aa' } });
  await prisma.integrationTechnicianMapping.create({ data: { peerId: PEER, externalOrgId: ORG_A, externalTechnicianId: 'cs-pat', userId: pat.id, createdById: 'aa' } });

  const pk = {
    dana: syntheticPasskey({ userId: dana.id, name: 'AA dana-l2' }),
    olivia: syntheticPasskey({ userId: olivia.id, name: 'AA olivia-approver' }),
    quinn: syntheticPasskey({ userId: quinn.id, name: 'AA quinn-approver' }),
    owen: syntheticPasskey({ userId: owen.id, name: 'AA owen-owner-acme' }),
    bea: syntheticPasskey({ userId: bea.id, name: 'AA bea-owner-birch' }),
  };
  for (const k of Object.values(pk)) {
    await prisma.userMfaMethod.create({ data: { userId: k.userId, type: 'WEBAUTHN', isActive: true, credentialId: k.credentialId, publicKey: Buffer.from(k.publicKey, 'base64url'), signCount: 0, name: 'Test key' } });
  }

  start('signer', path.join(dist, 'approval-signer', 'main.js'), signerEnv);
  start('api', path.join(dist, 'main.js'), apiEnv);
  await waitUp(`http://127.0.0.1:${SIGNER_INTERNAL}/internal/v1/keys`, 'signer');
  await waitUp(`${API}/health`, 'api');
  const S = { admin: await login(admin.email), dana: await login(dana.email), sam: await login(sam.email), pat: await login(pat.email), owen: await login(owen.email), olivia: await login(olivia.email) };

  section('Roster ceremony: the portal shows the fingerprint, the operator confirms it');
  {
    for (const [who, roles] of [['dana', ['--approve', '*']], ['olivia', ['--approve', '*']], ['quinn', ['--approve', acme.id]], ['owen', ['--customer', acme.id]], ['bea', ['--customer', birch.id]]]) {
      const s = who === 'quinn' || who === 'bea' ? await login(who === 'quinn' ? quinn.email : bea.email) : S[who];
      const list = await req('GET', '/auth/passkeys', { s });
      const mine = (list.body?.data ?? list.body ?? [])[0];
      if (who === 'olivia') check(list.status === 200 && /^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/.test(mine?.approvalFingerprint ?? '') && !!mine?.approvalExport, 'the approver\'s own Passkeys list shows an approval fingerprint and export', msg(list));
      if (who === 'olivia') {
        const wrong = signerCli(['roster', 'add', '--export', mine.approvalExport, ...roles, '--confirm-fingerprint', '0000-0000-0000-0000']);
        check(wrong.status !== 0, 'roster add refuses a fingerprint the approver did not read back');
      }
      const add = signerCli(['roster', 'add', '--export', mine.approvalExport, ...roles, '--confirm-fingerprint', mine.approvalFingerprint]);
      if (add.status !== 0) throw new Error(`roster add ${who}: ${add.stderr}`);
    }
    const pol = signerCli(['policy', 'set', '--business', birch.id, '--customer-signoff', 'required']);
    check(pol.status === 0, 'Birch requires customer sign-off — set on the signer, not in the portal');
    const kf = await fetchKeysViaMirror();
    check(kf.ok, 'approval/keys.json is served through the portal\'s mirror and matches signed targets metadata');
    keysFile = path.join(work, 'keys-from-mirror.json'); writeFileSync(keysFile, kf.buf);
  }

  section('Agents report what they can run');
  for (const ep of [fdA, fdB, srv]) await heartbeat(ep);
  await req('POST', '/enrollment/heartbeat', { body: { rustdeskId: old.rid, agentSecret: old.secret, hostname: 'OLDPC', platform: 'Windows' } });
  {
    const e = await prisma.endpoint.findUnique({ where: { id: fdA.id } });
    check(e.updateChannel === 'signed' && e.agentActions.includes('windows.service.start@1') && e.agentSha256 === AGENT_SHA, 'FRONTDESK recorded as a signed agent supporting windows.service.start@1, on the published build');
    const cat = await req('GET', '/actions/catalog', { s: S.dana });
    check(cat.status === 200 && cat.body.data.configured === true && cat.body.data.actions[0].id === 'windows.service.start' && /cannot be recalled/.test(cat.body.data.actions[0].warnings.join(' ')), 'catalog: one action, with the queued-documents warning', msg(cat));
  }

  section('Requests: only the catalog, only by people who may, only on ready computers');
  const body = (over = {}) => ({ actionId: 'windows.service.start', version: 1, params: { service: 'Spooler' }, reason: 'Ticket 42: nothing prints, spooler stopped', ...over });
  {
    let r = await req('POST', `/endpoints/${fdA.id}/actions`, { s: S.pat, body: body() });
    check(r.status === 403 && code(r) === 'ACTION_NOT_GRANTED', 'Business User without actions:request → 403', msg(r));
    r = await req('POST', `/endpoints/${fdB.id}/actions`, { s: S.dana, business: acme.id, body: body() });
    check(r.status === 404, 'Dana (Acme L2) → Birch\'s FRONTDESK: 404', msg(r));
    r = await req('POST', `/endpoints/${fdA.id}/actions`, { s: S.dana, business: acme.id, body: body({ params: { service: 'WinDefend' } }) });
    check(r.status === 400 && code(r) === 'PARAMS_NOT_ALLOWED', 'another service (WinDefend) → 400 PARAMS_NOT_ALLOWED', msg(r));
    r = await req('POST', `/endpoints/${fdA.id}/actions`, { s: S.dana, business: acme.id, body: body({ actionId: 'windows.shell.run', params: { command: 'whoami' } }) });
    check(r.status === 400 && code(r) === 'ACTION_NOT_IN_CATALOG', 'an arbitrary command → 400 ACTION_NOT_IN_CATALOG', msg(r));
    r = await req('POST', `/endpoints/${srv.id}/actions`, { s: S.dana, business: acme.id, body: body() });
    check(r.status === 403 && code(r) === 'ACTION_NOT_GRANTED', 'L2 on a server → 403 (standard workstations only)', msg(r));
    r = await req('POST', `/endpoints/${old.id}/actions`, { s: S.dana, business: acme.id, body: body() });
    check(r.status === 409 && code(r) === 'ENDPOINT_NOT_READY', 'legacy agent → 409 ENDPOINT_NOT_READY', msg(r));
  }

  section('One workstation, one approver: request → approve → dispatch → execute → verify');
  let job1;
  {
    const r = await req('POST', `/endpoints/${fdA.id}/actions`, { s: S.dana, business: acme.id, body: body() });
    job1 = r.body?.data;
    check(r.status === 201 && job1?.status === 'AWAITING_APPROVAL' && job1.approvalsRequired === 1 && job1.risk === 'low' && job1.approvalUrl === `${ORIGIN}/approve/${job1.id}`, 'Dana requests: awaiting one approval on the signer\'s own origin', msg(r));
    const dup = await req('POST', `/endpoints/${fdA.id}/actions`, { s: S.dana, business: acme.id, body: body() });
    check(dup.status === 409 && code(dup) === 'ACTION_PENDING', 'a second request while one is pending → 409 ACTION_PENDING', msg(dup));
    const noRoute = await req('POST', `/actions/${job1.id}/approve`, { s: S.admin, body: {} });
    check(noRoute.status === 404, 'the portal has no approve route, even for a Platform Admin', msg(noRoute));
    const hb0 = await heartbeat(fdA);
    check((hb0.body?.data?.actions ?? []).length === 0, 'nothing is delivered before approval');
    const page = await (await fetch(job1.approvalUrl)).text();
    check(page.includes('FRONTDESK') && page.includes('Acme') && /cannot be recalled/.test(page) && page.includes(job1.digest), 'the approval page shows the computer, the business, the warning and the digest');
    let a = await approve(job1.id, pk.dana);
    check(a.status === 403 && a.body.error === 'requester_cannot_approve', 'Dana is on the roster but cannot approve her own request', JSON.stringify(a.body));
    a = await approve(job1.id, pk.bea);
    check(a.status === 403, 'Birch\'s owner cannot approve for Acme');
    a = await approve(job1.id, pk.olivia);
    check(a.status === 200 && a.body.status === 'SIGNED', 'Olivia approves with her passkey → signed', JSON.stringify(a.body).slice(0, 200));
    const g = await req('GET', `/actions/${job1.id}`, { s: S.dana, business: acme.id });
    check(g.body?.data?.status === 'APPROVED' && g.body.data.approvers?.[0]?.userId === olivia.id, 'the portal picks up the signature: APPROVED, approver recorded', msg(g));

    const hb = await heartbeat(fdA);
    const delivered = hb.body?.data?.actions ?? [];
    check(delivered.length === 1 && delivered[0].jobId === job1.id && delivered[0].envelope?.schema === 'rem0te-action-envelope/1', 'the next heartbeat delivers the envelope', msg(hb));
    const env1 = delivered[0].envelope;
    const row = await prisma.actionJob.findUnique({ where: { id: job1.id } });
    check(row.status === 'DISPATCHED' && row.deliveries === 1, 'status DISPATCHED, one delivery');

    // Other machines given the same envelope refuse it.
    let x = runAgent(fdB, job1.id, env1, { state: path.join(work, 'xb') });
    check(x.outcome === 'refused' && x.reason === 'wrong_target', 'Birch\'s FRONTDESK (same hostname) refuses Acme\'s envelope: wrong_target', JSON.stringify(x));
    x = runAgent(fdA, job1.id, env1, { state: path.join(work, 'xs'), productType: 3 });
    check(x.outcome === 'refused' && x.reason === 'risk_understated', 'a machine that is really a server refuses a one-approver plan: risk_understated', JSON.stringify(x));
    x = runAgent(fdA, job1.id, env1, { state: path.join(work, 'xa'), self: 'f'.repeat(64) });
    check(x.outcome === 'refused' && x.reason === 'artifact_mismatch', 'a different agent build refuses it: artifact_mismatch', JSON.stringify(x));

    simService(fdA, 'stopped');
    const res = runAgent(fdA, job1.id, env1);
    check(res.outcome === 'succeeded' && res.observed?.before === 'stopped' && simServiceNow(fdA) === 'running', 'FRONTDESK verifies and starts the spooler; it is observed running afterwards', JSON.stringify(res));

    // Lost acknowledgement: the result never reaches the portal.
    const hbLost = await heartbeat(fdA);
    check((hbLost.body?.data?.actions ?? []).some((d) => d.jobId === job1.id), 'no result yet → the same envelope is re-delivered for reconciliation');
    simService(fdA, 'stopped');
    const again = runAgent(fdA, job1.id, hbLost.body.data.actions[0].envelope);
    check(again.outcome === 'succeeded' && simServiceNow(fdA) === 'stopped', 're-delivery is answered from the journal: the spooler is NOT started a second time', JSON.stringify(again));

    const sent = resultsOf(fdA);
    const hbR = await heartbeat(fdA, { actionResults: sent });
    check((hbR.body?.data?.actionAcks ?? []).includes(job1.id), 'the result is acknowledged', `${sent.length} sent; ${msg(hbR)}`);
    clearAcked(fdA, hbR.body?.data?.actionAcks);
    const done = await req('GET', `/actions/${job1.id}`, { s: S.dana, business: acme.id });
    check(done.body?.data?.status === 'SUCCEEDED' && done.body.data.result?.observed?.before === 'stopped', 'SUCCEEDED, with what the agent observed — and nothing about printing', msg(done));
    const birchHb = await heartbeat(fdB, { actionResults: [{ ...res }] });
    check(!(birchHb.body?.data?.actionAcks ?? []).includes(job1.id), 'another computer cannot report on Acme\'s job');
    const audits = await prisma.activityLog.findMany({ where: { resourceId: job1.id }, select: { action: true } });
    const acts = new Set(audits.map((a2) => a2.action));
    check(['ACTION_REQUESTED', 'ACTION_DISPATCHED', 'ACTION_RESULT'].every((a2) => acts.has(a2)), 'evidence: requested, dispatched and result are all in the audit log', [...acts].join(','));
  }

  section('Replay after a restart: the journal survives');
  {
    await stop('api'); start('api', path.join(dist, 'main.js'), apiEnv); await waitUp(`${API}/health`, 'api');
    const env1 = (await prisma.actionJob.findUnique({ where: { id: job1.id } })).envelope;
    simService(fdA, 'stopped');
    const r = runAgent(fdA, job1.id, env1);
    check(r.outcome === 'succeeded' && simServiceNow(fdA) === 'stopped', 'a replayed envelope after restarts of the API and the agent does not run again');
    await stop('signer'); start('signer', path.join(dist, 'approval-signer', 'main.js'), signerEnv); await waitUp(`http://127.0.0.1:${SIGNER_INTERNAL}/internal/v1/keys`, 'signer');
    const st = await sj(`http://127.0.0.1:${SIGNER_INTERNAL}/internal/v1/plans/${job1.id}`);
    check(st.body?.status === 'SIGNED', 'the signer\'s record survives its own restart');
  }

  section('Uncertain outcome: reconciled by a person before any retry');
  let job2;
  {
    S.dana = await login(dana.email);
    const r = await req('POST', `/endpoints/${fdA.id}/actions`, { s: S.dana, business: acme.id, body: body() });
    job2 = r.body?.data;
    await approve(job2.id, pk.olivia);
    await req('GET', `/actions/${job2.id}`, { s: S.dana, business: acme.id });
    const hb = await heartbeat(fdA);
    const env2 = (hb.body?.data?.actions ?? []).find((d) => d.jobId === job2.id)?.envelope;
    check(!!env2, 'job 2 approved and delivered');
    // The agent died mid-action: its journal says "executing".
    mkdirSync(path.join(fdA.state, 'actions', 'journal'), { recursive: true });
    writeFileSync(path.join(fdA.state, 'actions', 'journal', `${job2.id}.json`), JSON.stringify({ jobId: job2.id, state: 'executing', at: new Date().toISOString() }));
    // 0.27: the deadline runs per computer, from that computer's delivery.
    await prisma.actionTarget.update({ where: { jobId_endpointId: { jobId: job2.id, endpointId: fdA.id } }, data: { dispatchedAt: new Date(Date.now() - 31 * 60_000) } });
    const hbLate = await heartbeat(fdA);
    const row = await prisma.actionJob.findUnique({ where: { id: job2.id } });
    check(row.status === 'UNKNOWN' && (hbLate.body?.data?.actions ?? []).some((d) => d.jobId === job2.id), 'no result in 30 minutes → UNKNOWN, envelope re-delivered to reconcile');
    simService(fdA, 'running');
    const res = runAgent(fdA, job2.id, env2);
    check(res.outcome === 'uncertain' && res.reason === 'interrupted' && res.observed?.now === 'running', 'the agent reports uncertain, with the state it sees now — and does not run it again', JSON.stringify(res));
    const hbR = await heartbeat(fdA, { actionResults: resultsOf(fdA) });
    clearAcked(fdA, hbR.body?.data?.actionAcks);
    const retry = await req('POST', `/endpoints/${fdA.id}/actions`, { s: S.dana, business: acme.id, body: body() });
    check(retry.status === 409 && code(retry) === 'ACTION_UNRECONCILED', 'a retry is refused until someone reconciles: 409 ACTION_UNRECONCILED', msg(retry));
    const pr = await req('POST', `/actions/${job2.id}/reconcile`, { s: S.pat, body: { found: 'running', note: 'looked' } });
    check(pr.status === 403 || pr.status === 404, 'a Business User cannot reconcile', msg(pr));
    const rc = await req('POST', `/actions/${job2.id}/reconcile`, { s: S.dana, business: acme.id, body: { found: 'running', note: 'Checked services.msc on FRONTDESK: Print Spooler is running.' } });
    check(rc.status === 200 && rc.body.data.reconciled?.byId === dana.id, 'the requester records what she found', msg(rc));
    const ev = await prisma.activityLog.findFirst({ where: { resourceId: job2.id, action: 'ACTION_RECONCILED' } });
    check(!!ev, 'the reconciliation is audited');
  }

  section('Recheck at dispatch: a requester revoked after approval');
  {
    const r = await req('POST', `/endpoints/${fdA.id}/actions`, { s: S.dana, business: acme.id, body: body() });
    const job3 = r.body?.data;
    check(r.status === 201, 'after reconciliation a new request is accepted', msg(r));
    await approve(job3.id, pk.olivia);
    await req('GET', `/actions/${job3.id}`, { s: S.dana, business: acme.id });
    await prisma.technicianAssignment.deleteMany({ where: { userId: dana.id } });
    const hb = await heartbeat(fdA);
    const row = await prisma.actionJob.findUnique({ where: { id: job3.id } });
    check(!(hb.body?.data?.actions ?? []).some((d) => d.jobId === job3.id) && row.status === 'CANCELED' && row.statusReason === 'requester_no_longer_authorized', 'Dana lost her Acme assignment → the signed plan is never delivered', JSON.stringify({ s: row.status, r: row.statusReason }));
    const ev = await prisma.activityLog.findFirst({ where: { resourceId: job3.id, action: 'ACTION_DISPATCH_BLOCKED' } });
    check(ev?.metadata?.reason === 'requester_no_longer_authorized', 'the block is audited with its reason');
  }

  section('A server: two distinct approvers');
  {
    const r = await req('POST', `/endpoints/${srv.id}/actions`, { s: S.sam, business: acme.id, body: body() });
    const j = r.body?.data;
    check(r.status === 201 && j.risk === 'high' && j.approvalsRequired === 2, 'Sam (L3) on APPSRV: high risk, two approvals', msg(r));
    await approve(j.id, pk.olivia);
    let g = await req('GET', `/actions/${j.id}`, { s: S.sam, business: acme.id });
    check(g.body?.data?.status === 'AWAITING_APPROVAL', 'one approval is not enough');
    const twice = await approve(j.id, pk.olivia);
    check(twice.status === 409, 'the same approver cannot count twice');
    await approve(j.id, pk.quinn);
    g = await req('GET', `/actions/${j.id}`, { s: S.sam, business: acme.id });
    check(g.body?.data?.status === 'APPROVED' && g.body.data.approvers.length === 2, 'a second, different approver → APPROVED');
    const hb = await heartbeat(srv);
    const env = (hb.body?.data?.actions ?? []).find((d) => d.jobId === j.id)?.envelope;
    const res = runAgent(srv, j.id, env);
    check(res.outcome === 'succeeded', 'APPSRV (product type: server) accepts the two-approver plan and starts the spooler', JSON.stringify(res));
    const hbR = await heartbeat(srv, { actionResults: resultsOf(srv) });
    clearAcked(srv, hbR.body?.data?.actionAcks);
    const done = await prisma.actionJob.findUnique({ where: { id: j.id } });
    check(done.status === 'SUCCEEDED', 'reported and recorded SUCCEEDED');
  }

  section('Customer sign-off where the business requires it (Birch)');
  {
    const r = await req('POST', `/endpoints/${fdB.id}/actions`, { s: S.admin, business: birch.id, body: body() });
    const j = r.body?.data;
    check(r.status === 201 && j.customerSignoff === true, 'Birch\'s policy on the signer → the plan needs customer sign-off', msg(r));
    await approve(j.id, pk.olivia);
    let g = await req('GET', `/actions/${j.id}`, { s: S.admin, business: birch.id });
    check(g.body?.data?.status === 'AWAITING_APPROVAL', 'an MSP approval alone is not enough');
    const wrong = await approve(j.id, pk.owen, { role: 'customer' });
    check(wrong.status === 403, 'Acme\'s owner cannot sign off for Birch');
    await approve(j.id, pk.bea, { role: 'customer' });
    g = await req('GET', `/actions/${j.id}`, { s: S.admin, business: birch.id });
    check(g.body?.data?.status === 'APPROVED' && g.body.data.approvers.some((a) => a.role === 'customer'), 'Birch\'s owner signs off → APPROVED, sign-off recorded in the signed plan');
    await prisma.actionJob.update({ where: { id: j.id }, data: { status: 'CANCELED', statusReason: 'test cleanup' } });
  }

  section('An offline computer: the window closes, nothing runs');
  {
    const r = await req('POST', `/endpoints/${fdA.id}/actions`, { s: S.owen, body: { ...body(), windowHours: 1 } });
    const j = r.body?.data;
    check(r.status === 201, 'Acme\'s owner may request on her own business', msg(r));
    await approve(j.id, pk.olivia);
    await req('GET', `/actions/${j.id}`, { s: S.owen });
    const env = (await prisma.actionJob.findUnique({ where: { id: j.id } })).envelope;
    await prisma.actionJob.update({ where: { id: j.id }, data: { notAfter: new Date(Date.now() - 1000) } });
    const hb = await heartbeat(fdA);
    const row = await prisma.actionJob.findUnique({ where: { id: j.id } });
    check(row.status === 'EXPIRED' && !(hb.body?.data?.actions ?? []).some((d) => d.jobId === j.id), 'the portal does not deliver after the window');
    const late = runAgent(fdA, j.id, env, { state: path.join(work, 'late') });
    check(late.outcome === 'succeeded', '(the agent itself decides by the SIGNED window, which the database cannot shorten or lengthen)', JSON.stringify(late));
  }

  section('A compromised portal or database cannot sign');
  {
    const real = await prisma.actionJob.findUnique({ where: { id: job1.id } });
    const plan = { ...JSON.parse(Buffer.from(real.envelope.plan, 'base64').toString('utf8')), jobId: randomBytes(16).toString('hex') };
    const attacker = generateKeyPairSync('ed25519');
    const bytes = Buffer.from(canonicalJson(plan));
    const forged = { schema: 'rem0te-action-envelope/1', kid: 'attackerkey0001', plan: bytes.toString('base64'), sig: edSign(null, Buffer.concat([Buffer.from('rem0te-action-plan-v1\n'), bytes]), attacker.privateKey).toString('base64') };
    const kid = JSON.parse(readFileSync(keysFile, 'utf8')).keys[0].kid;
    const tampered = { ...real.envelope, plan: Buffer.from(canonicalJson({ ...plan, jobId: randomBytes(16).toString('hex') })).toString('base64') };
    const tamperedPlan = JSON.parse(Buffer.from(tampered.plan, 'base64').toString('utf8'));
    for (const [id, env, p] of [[plan.jobId, forged, plan], [tamperedPlan.jobId, { ...tampered, kid }, tamperedPlan]]) {
      await prisma.actionJob.create({ data: {
        id, tenantId: tenant.id, customerId: acme.id, endpointId: fdA.id, actionId: 'windows.service.start', actionVersion: 1, params: { service: 'Spooler' }, reason: 'forged in the database',
        origin: 'technician', via: 'portal', requestedById: dana.id, status: 'DISPATCHED', dispatchedAt: new Date(), risk: 'low', approvalsRequired: 1, customerSignoff: false,
        notBefore: new Date(Date.now() - 60_000), notAfter: new Date(Date.now() + 3600_000), plan: p, digest: 'f'.repeat(64), approvalUrl: 'x', envelope: env,
        targets: { create: [{ endpointId: fdA.id, status: 'DISPATCHED', dispatchedAt: new Date() }] },
      } });
    }
    const hb = await heartbeat(fdA);
    const got = hb.body?.data?.actions ?? [];
    check(got.length === 2, 'a database row is delivered — the portal is only a courier', msg(hb));
    simService(fdA, 'stopped');
    const outs = got.map((d) => runAgent(fdA, d.jobId, d.envelope));
    check(outs.some((o) => o.reason === 'unknown_key') && outs.some((o) => o.reason === 'bad_signature') && simServiceNow(fdA) === 'stopped', 'the agent refuses both: an attacker\'s key (unknown_key) and a real envelope with an altered plan (bad_signature); the spooler stays stopped', JSON.stringify(outs));
    const hbR = await heartbeat(fdA, { actionResults: resultsOf(fdA) });
    clearAcked(fdA, hbR.body?.data?.actionAcks);
    const rows = await prisma.actionJob.findMany({ where: { id: { in: got.map((d) => d.jobId) } } });
    check(rows.every((r) => r.status === 'REFUSED_BY_ENDPOINT'), 'both are recorded REFUSED_BY_ENDPOINT');
  }

  section('ClientSt0r proposes; it cannot approve');
  {
    const caps = await call('GET', '/api/integration/v1/capabilities');
    check(caps.status === 200 && caps.body.features.actions.includes('windows.service.start@1'), 'capabilities list windows.service.start@1 while a signer is configured', JSON.stringify(caps.body?.features));
    const pb = (over = {}) => ({ contract: 'ticket-rmm-v1', idempotency_key: `cs-${randomBytes(6).toString('hex')}`, organization_id: ORG_A, technician_id: 'cs-tech-a', rem0te_endpoint_id: srv.id, action: { id: 'windows.service.start', version: 1 }, params: { service: 'Spooler' }, reason: 'Ticket 42: AI triage suggests the spooler is stopped', origin: 'ai_suggestion', ticket_ref: 'ticket-42', ...over });
    let r = await propose(pb({ action: { id: 'windows.defender.disable', version: 1 }, params: {} }));
    check(r.status === 400 && r.body?.error?.code === 'ACTION_NOT_IN_CATALOG' && /disabling defenses|defense disable/.test(r.body.error.message), 'disabling defenses → ACTION_NOT_IN_CATALOG', JSON.stringify(r.body));
    r = await propose({ ...pb(), command: 'whoami' });
    check(r.status === 400, 'a smuggled command field → 400 (schema)', JSON.stringify(r.body));
    r = await propose(pb({ technician_id: 'cs-pat' }));
    check(r.status === 403 && r.body?.error?.code === 'ACTION_NOT_GRANTED', 'a mapped technician without actions:request → ACTION_NOT_GRANTED', JSON.stringify(r.body));
    r = await propose(pb({ rem0te_endpoint_id: fdB.id }));
    check(r.status === 400 && r.body?.error?.code === 'INVALID_REQUEST', 'Birch\'s FRONTDESK from Acme\'s organization → not found', JSON.stringify(r.body));
    const b = pb();
    r = await propose(b);
    const p = r.body;
    check(r.status === 201 && p.status === 'awaiting_approval' && p.origin === 'ai_suggestion' && p.approvals_required === 2 && p.approval_url.startsWith(ORIGIN), 'an AI suggestion on the server: awaiting TWO approvals, same as a person\'s request', JSON.stringify(p).slice(0, 300));
    const replay = await propose(b);
    check(replay.status === 200 && replay.headers.get('idempotent-replayed') === 'true' && replay.body.job_id === p.job_id, 'the same proposal again → the same job (idempotent)');
    const conflict = await propose({ ...b, reason: 'something else entirely' });
    check(conflict.status === 409, 'the same key with a different body → 409');
    const page = await (await fetch(p.approval_url)).text();
    check(/AI suggestion/.test(page) && page.includes('ticket-42') && /via clientst0r/.test(page), 'the approvers see that it is an AI suggestion from ClientSt0r ticket 42');
    const row = await prisma.actionJob.findUnique({ where: { id: p.job_id } });
    check(row.via === 'clientst0r' && row.origin === 'ai_suggestion' && row.requestedById === csTech.id, 'recorded as requested by the mapped technician, via clientst0r');
    await approve(p.job_id, pk.olivia); await approve(p.job_id, pk.quinn);
    const g = await call('GET', `/api/integration/v1/action-proposals/${p.job_id}`, { delegation: token({ sub: 'cs-tech-a', org: ORG_A, scope: 'actions:read' }) });
    check(g.status === 200 && g.body.status === 'approved', 'ClientSt0r polls: approved — by the roster, not by ClientSt0r', JSON.stringify(g.body).slice(0, 200));
    const wrongScope = await call('GET', `/api/integration/v1/action-proposals/${p.job_id}`, { delegation: token({ sub: 'cs-tech-a', org: ORG_A, scope: 'ticket_analysis:read' }) });
    check(wrongScope.status === 401, 'reading needs the actions:read scope');
  }
  section('Direct mode (0.39): set on the signer, signed at the request, run with no approval step');
  {
    // Earlier sections leave approved plans undelivered on these computers.
    const settle = () => prisma.actionJob.updateMany({ where: { endpointId: { in: [srv.id, fdA.id, fdB.id] }, status: { in: ['AWAITING_APPROVAL', 'APPROVED', 'DISPATCHED'] } }, data: { status: 'CANCELED', statusReason: 'test cleanup' } });
    await settle();
    const set = signerCli(['policy', 'set', '--business', acme.id, '--approval', 'direct']);
    check(set.status === 0 && /Direct mode is now ON/.test(set.stderr), 'the signer\'s operator sets Acme to direct mode (CLI only)', set.stderr);
    const log = readFileSync(path.join(signerDir, 'policy-changes.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    check(log.at(-1).business === acme.id && log.at(-1).after.approval === 'direct', 'the change is in the signer\'s own policy-changes.log');
    const bad = signerCli(['policy', 'set', '--business', birch.id, '--approval', 'direct']);
    check(bad.status === 2 && /requires customer sign-off/.test(bad.stderr), 'Birch requires customer sign-off, so the signer refuses direct mode for it and says why', bad.stderr);

    // A request needs a fresh sign-in, and is refused before anything is written without one.
    const n0 = await prisma.actionJob.count({ where: { endpointId: srv.id } });
    let r = await req('POST', `/endpoints/${srv.id}/actions`, { s: S.admin, business: acme.id, body: body() });
    check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED' && await prisma.actionJob.count({ where: { endpointId: srv.id } }) === n0, 'in direct mode a request without a fresh sign-in → 403 STEP_UP_REQUIRED, nothing written', msg(r));
    await stepUp(S.admin);

    // A server, the admin alone: request → signed → delivered → run.
    simService(srv, 'stopped');
    r = await req('POST', `/endpoints/${srv.id}/actions`, { s: S.admin, business: acme.id, body: body() });
    const j = r.body?.data;
    check(r.status === 201 && j.status === 'APPROVED' && j.direct === true && j.approvalsRequired === 0 && j.risk === 'high' && (j.approvers ?? []).length === 0, 'with a fresh sign-in the admin\'s request on APPSRV (high risk) is signed at once: APPROVED, direct, no approvers', msg(r));
    const row = await prisma.actionJob.findUnique({ where: { id: j?.id } });
    const signedPlan = row?.envelope ? JSON.parse(Buffer.from(row.envelope.plan, 'base64').toString('utf8')) : null;
    check(signedPlan?.policy?.approval === 'direct' && signedPlan.requestedBy.userId === admin.id && signedPlan.approvers.length === 0, 'the stored signed plan says direct and who requested it');
    const audit = await prisma.activityLog.findFirst({ where: { resourceId: j?.id, action: 'ACTION_REQUESTED' } });
    check(audit?.actorId === admin.id && audit?.metadata?.approval === 'direct', 'the request is audited as direct, with who asked', JSON.stringify(audit?.metadata));
    let hb = await heartbeat(srv);
    const env = (hb.body?.data?.actions ?? []).find((d) => d.jobId === j?.id)?.envelope;
    check(!!env, 'the next heartbeat delivers it', msg(hb));
    if (OLD_SIM) {
      const o = runAgent(srv, j.id, env, { sim: OLD_SIM, state: path.join(work, 'old-agent') });
      check(o.outcome === 'refused' && o.reason === 'bad_plan', 'an agent from before 0.39 refuses the direct plan (bad_plan) — it fails closed', JSON.stringify(o));
    }
    const res = runAgent(srv, j.id, env);
    check(res.outcome === 'succeeded' && simServiceNow(srv) === 'running', 'APPSRV (product type: server) runs the direct plan and starts the spooler', JSON.stringify(res));
    hb = await heartbeat(srv, { actionResults: resultsOf(srv) });
    clearAcked(srv, hb.body?.data?.actionAcks);
    check((await prisma.actionJob.findUnique({ where: { id: j.id } })).status === 'SUCCEEDED', 'reported and recorded SUCCEEDED');

    // A forged "direct" in the database still needs the signer's signature.
    {
      const real = JSON.parse(Buffer.from(env.plan, 'base64').toString('utf8'));
      const other = { ...real, jobId: randomBytes(16).toString('hex') };
      const forgedEnv = { ...env, plan: Buffer.from(canonicalJson(other)).toString('base64') };
      simService(fdA, 'stopped');
      const o = runAgent(srv, other.jobId, forgedEnv, { state: path.join(work, 'forged-direct') });
      check(o.outcome === 'refused' && o.reason === 'bad_signature', 'a direct plan the signer did not sign is refused (bad_signature)', JSON.stringify(o));
    }

    // ClientSt0r cannot have something run with nobody signed in behind it.
    {
      const pb = { contract: 'ticket-rmm-v1', idempotency_key: `cs-${randomBytes(6).toString('hex')}`, organization_id: ORG_A, technician_id: 'cs-tech-a', rem0te_endpoint_id: fdA.id, action: { id: 'windows.service.start', version: 1 }, params: { service: 'Spooler' }, reason: 'Ticket 43: AI triage suggests the spooler is stopped', origin: 'ai_suggestion', ticket_ref: 'ticket-43' };
      const p = await propose(pb);
      check(p.status === 403 && p.body?.error?.code === 'DIRECT_MODE_PORTAL_ONLY', 'in direct mode a ClientSt0r proposal is refused (DIRECT_MODE_PORTAL_ONLY), never signed', JSON.stringify(p.body));
    }

    // Birch is unaffected: signed mode, customer sign-off.
    r = await req('POST', `/endpoints/${fdB.id}/actions`, { s: S.admin, business: birch.id, body: body() });
    check(r.status === 201 && r.body.data.status === 'AWAITING_APPROVAL' && !r.body.data.direct && r.body.data.customerSignoff === true, 'Birch\'s plans still wait for approval and customer sign-off (the mode is per business)', msg(r));
    await settle();

    // A signer pause still refuses a direct request.
    const ps = signerCli(['pause', 'set', '--business', acme.id, '--reason', 'incident 12']);
    r = await req('POST', `/endpoints/${fdA.id}/actions`, { s: S.admin, business: acme.id, body: body() });
    check(r.status === 409 && code(r) === 'APPROVAL_SIGNER_REFUSED' && /signer is paused/.test(r.body?.message ?? ''), 'a pause on the signer still refuses a direct request', msg(r));
    const pid = (ps.stdout.match(/paused (\S+)/) ?? [])[1];
    signerCli(['pause', 'clear', '--id', pid, '--reason', 'incident 12 over']);

    // Back to signed: a server needs two approvals again.
    signerCli(['policy', 'set', '--business', acme.id, '--approval', 'signed']);
    r = await req('POST', `/endpoints/${srv.id}/actions`, { s: S.admin, business: acme.id, body: body() });
    check(r.status === 201 && r.body.data.status === 'AWAITING_APPROVAL' && r.body.data.approvalsRequired === 2 && !r.body.data.direct, 'set back to signed: a new request on a server waits for two approvals', msg(r));
    await settle();
  }
}

async function cleanup() {
  await stop('api'); await stop('signer');
  try {
    if (created.businesses.length) {
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
