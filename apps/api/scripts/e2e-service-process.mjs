#!/usr/bin/env node
/**
 * End-to-end proof of 0.45: controlling a Windows service
 * (windows.service.control@1: start, stop, restart, startup type) and ending
 * a process (windows.process.stop@1) from a computer's Services and
 * Processes tabs.
 *
 * Self-contained, like e2e-software-catalog.mjs: a signed update repository
 * from the offline release tool, the approval signer as its own process
 * (Acme in direct mode, set with the signer's CLI; Globex signed, two
 * approvers), the compiled API on its own port (3711, signer 3712/3713)
 * against a scratch database, and a stand-in ClientSt0r peer (keys only).
 * rem0te-action-sim is the agent's real verifier and executor
 * (internal/action) with a simulated service manager and process table
 * (`-scm STATE.json`).
 *
 *   cd apps/api && npx nest build
 *   (cd ../../tools/windows-installer && go build -o /tmp/rem0te-release ./cmd/rem0te-release \
 *      && go build -o /tmp/rem0te-action-sim ./cmd/rem0te-action-sim)
 *   RELEASE_BIN=/tmp/rem0te-release ACTION_SIM=/tmp/rem0te-action-sim \
 *   DATABASE_URL=postgresql://…/reboot_remote_it_scratch node scripts/e2e-service-process.mjs
 *
 * What it proves is FIXTURE-TESTED behaviour. The service control manager
 * and OpenProcess / TerminateProcess are simulated; none of it has run on a
 * real Windows computer.
 */
import { PrismaClient } from '@prisma/client';
import { confirmEverythingAsks } from './lib/confirm-asks.mjs';
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
const PORT = Number(process.env.SVC_API_PORT ?? 3711);
const SIGNER_PUBLIC = Number(process.env.SVC_SIGNER_PUBLIC_PORT ?? 3712);
const SIGNER_INTERNAL = Number(process.env.SVC_SIGNER_INTERNAL_PORT ?? 3713);
if ([PORT, SIGNER_PUBLIC, SIGNER_INTERNAL].some((p) => [3000, 3001, 443, 3201, 3202, 4000, 4001].includes(p))) { console.error('refusing a production port'); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
const ROOT = `http://127.0.0.1:${PORT}`;
const ORIGIN = `http://127.0.0.1:${SIGNER_PUBLIC}`;
const prisma = new PrismaClient();
// 0.64: every confirmation defaults to off. This suite proves step-ups, so it
// asks for them all before its API reads the policy.
await confirmEverythingAsks(prisma);
const sfx = randomBytes(3).toString('hex');
const PW = 'service-process-e2e-password-123';
const ALL_ACTIONS = ['windows.service.start@1', 'windows.update.install@1', 'windows.service.restart@1', 'windows.reboot.schedule@1', 'windows.reboot.cancel@1', 'windows.logs.collect@1', 'windows.script.run@1', 'windows.software.install@1', 'windows.software.uninstall@1', 'windows.software.remove@1', 'windows.service.control@1', 'windows.process.stop@1'];

let pass = 0, fail = 0; const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const work = mkdtempSync(path.join(tmpdir(), 'rem0te-svc-'));

// ── The release machine ─────────────────────────────────────────────────────
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
const agentBin = Buffer.concat([Buffer.from('MZ stand-in signed agent 0.45 '), randomBytes(64), slot]);
writeFileSync(path.join(files, 'agent.exe'), agentBin);
const AGENT_SHA = sha(agentBin);
const kg = signerCli(['keygen']);
if (kg.status !== 0) throw new Error(`signer keygen: ${kg.stderr}`);
writeFileSync(path.join(files, 'approval-keys.json'), kg.stdout);
rel('release', '-repo', repo, '-targets-key', path.join(keys, 'targets.pem'), '-snapshot-key', path.join(keys, 'snapshot.pem'), '-timestamp-key', path.join(keys, 'timestamp.pem'),
  '-add', `windows/rem0te-agent.exe=${path.join(files, 'agent.exe')}`, '-add', `approval/keys.json=${path.join(files, 'approval-keys.json')}`);

// ClientSt0r, only to show neither action is offered to it.
const pair = () => generateKeyPairSync('ed25519');
const pem = (k) => k.export({ type: 'spki', format: 'pem' }).toString();
const selfKey = pair(), peerReq = pair(), peerDel = pair();
writeFileSync(path.join(work, 'self.pem'), selfKey.privateKey.export({ type: 'pkcs8', format: 'pem' }));
const AUD = 'rem0te:svc-lab', PEER = `clientst0r-svc-${sfx}`;
const peersFile = path.join(work, 'peers.json');
writeFileSync(peersFile, JSON.stringify({
  self: { keyId: 'rem0te-svc-1', privateKeyFile: path.join(work, 'self.pem') },
  peers: [{ id: PEER, audience: AUD, peerAudience: 'clientst0r:svc-lab', requestKeys: [{ kid: 'req-1', publicKeyPem: pem(peerReq.publicKey) }], delegationKeys: [{ kid: 'del-1', publicKeyPem: pem(peerDel.publicKey) }], inferenceUrl: 'http://127.0.0.1:9/api/integration/v1/inference', eventsUrl: 'http://127.0.0.1:9/api/integration/v1/events', modelProfiles: ['triage-fast'] }],
}));
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
const apiEnv = {
  ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATABASE_URL: DB, UPDATE_REPO_DIR: repo,
  MONITOR_SWEEP: 'off', PATCH_POLICY_SWEEP: 'off', METRIC_SWEEP: 'off', CLIENT_UPDATE_SWEEP: 'off', AUTO_MIGRATION_SWEEP: 'off', AGENT_AUTO_UPDATE: 'off', WINGET_INDEX_SWEEP: 'off', SNAPSHOT_SWEEP: 'off',
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
  await sleep(60);
  const h = { 'content-type': 'application/json', 'x-forwarded-for': ip() };
  if (s) h.cookie = s.cookie + (s.stepUp ? `; step_up=${s.stepUp}` : '');
  if (business) h['x-rem0te-business'] = business;
  const r = await fetch(`${API}${p}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j, setCookie: r.headers.get('set-cookie') ?? '' };
}
async function login(email) {
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip() }, body: JSON.stringify({ email, password: PW }) });
  const m = (r.headers.get('set-cookie') ?? '').match(/access_token=([^;]+)/);
  if (r.status !== 200 || !m) throw new Error(`login ${email}: ${r.status} ${await r.text()}`);
  return { cookie: `access_token=${m[1]}` };
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
const signerPost = (id, p, body) => sj(`${ORIGIN}/approve/${id}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify(body) });
async function approve(jobId, who) {
  const c = await signerPost(jobId, '/challenge', { decision: 'approve', role: 'approver' });
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
let keysFile;
const scmFile = (ep) => path.join(ep.state, 'scm.json');
const setScm = (ep, st) => writeFileSync(scmFile(ep), JSON.stringify({ calls: [], ...st }));
const scmNow = (ep) => JSON.parse(readFileSync(scmFile(ep), 'utf8'));
const svcOf = (ep, name) => scmNow(ep).services.find((s) => s.name === name);
function runAgent(ep, jobId, envelope, { sessions, pause, revocations } = {}) {
  const envFile = path.join(work, `env-${jobId}-${randomBytes(3).toString('hex')}.json`);
  writeFileSync(envFile, JSON.stringify(envelope));
  const args = ['-state', ep.state, '-keys', keysFile, '-job', jobId, '-envelope', envFile, '-rustdesk-id', ep.rid, '-secret', ep.secret, '-product-type', '1', '-self-sha', AGENT_SHA, '-scm', scmFile(ep), ...(revocations ? ['-revocations', revocations] : ['-portal', `127.0.0.1:${PORT}`])];
  if (sessions !== undefined) args.push(`-sessions=${sessions}`);
  if (pause) args.push('-pause', pause);
  return JSON.parse(execFileSync(SIM, args, { encoding: 'utf8', timeout: 120_000 }).trim());
}
const deliver = async (ep, jobId) => ((await heartbeat(ep)).body?.data?.actions ?? []).find((d) => d.jobId === jobId)?.envelope;
const report = async (ep) => {
  const h = await heartbeat(ep, { actionResults: resultsOf(ep) });
  for (const a of h.body?.data?.actionAcks ?? []) rmSync(path.join(ep.state, 'actions', 'results', `${a}.json`), { force: true });
  return h;
};

// The computer's Windows, as the simulated service manager and process table hold it.
const T0 = '2026-11-14T09:30:01.1234567Z';           // what Windows reports, to 100 ns
const T0_MS = '2026-11-14T09:30:01.123Z';            // what the portal's snapshot keeps
const SERVICES = [
  { name: 'Spooler', displayName: 'Print Spooler', state: 'stopped', startType: 'automatic' },
  { name: 'W32Time', displayName: 'Windows Time', state: 'running', startType: 'manual' },
  { name: 'Fax', displayName: 'Fax', state: 'running', startType: 'manual' },
  { name: 'wuauserv', displayName: 'Windows Update', state: 'running', startType: 'manual' },
  { name: 'RustDesk', displayName: 'RustDesk Service', state: 'running', startType: 'automatic' },
  { name: 'WinDefend', displayName: 'Microsoft Defender Antivirus Service', state: 'running', startType: 'automatic' },
  { name: 'Renamed', displayName: 'Something Else Now', state: 'running', startType: 'manual' },
  { name: 'Stubborn', displayName: 'Stubborn Service', state: 'running', startType: 'automatic', stopFails: true },
  { name: 'kbdclass', displayName: 'Keyboard Class Driver', state: 'running', startType: 'system', driver: true },
];
const PROCS = [
  { pid: 4, ppid: 0, name: 'System', created: T0 },
  { pid: 700, ppid: 4, name: 'lsass.exe', created: T0 },
  { pid: 1100, ppid: 700, name: 'svchost.exe', created: T0 },
  { pid: 4242, ppid: 3000, name: 'notepad.exe', created: T0 },
  { pid: 5150, ppid: 3000, name: 'EXCEL.EXE', created: T0 },
  { pid: 5151, ppid: 5150, name: 'splwow64.exe', created: '2026-11-14T09:31:00.5Z' },
  { pid: 6000, ppid: 3000, name: 'setup.exe', created: T0 },
  { pid: 6001, ppid: 6000, name: 'MsMpEng.exe', created: '2026-11-14T09:32:00Z' },
  { pid: 7000, ppid: 3000, name: 'reused.exe', created: '2026-11-14T10:00:00.000Z' },
  { pid: 7100, ppid: 3000, name: 'stuck.exe', created: T0, survives: true },
];
// What the portal's latest snapshots say (the agent's collector, as stored).
const svcSnapshot = SERVICES.filter((s) => !s.driver).map((s) => ({ name: s.name, displayName: s.name === 'Renamed' ? 'Renamed Service' : s.displayName, state: s.state === 'running' ? 'Running' : 'Stopped', startMode: s.startType === 'automatic' ? 'Auto' : 'Manual', account: 'LocalSystem' }));
const procSnapshot = PROCS.map((p) => ({ name: p.name.replace(/\.exe$/i, '').replace(/\.EXE$/, ''), pid: p.pid, cpuSeconds: 1, workingSetBytes: 1 << 20, user: null, startedAt: p.pid === 7000 ? T0_MS : new Date(p.created).toISOString() }));

const created = { businesses: [], users: [] };

async function all() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });

  section('Fixtures (synthetic): Acme (direct mode) and Globex (signed)');
  const acme = await prisma.customer.create({ data: { tenantId: tenant.id, name: `SVC Acme ${sfx}` } });
  const globex = await prisma.customer.create({ data: { tenantId: tenant.id, name: `SVC Globex ${sfx}` } });
  created.businesses.push(acme.id, globex.id);
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag, extra = {}) => { const u = await prisma.user.create({ data: { email: `svc-${tag}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'SVC', lastName: tag, status: 'ACTIVE', ...extra } }); created.users.push(u.id); return u; };
  const admin = await mkUser('admin', { isPlatformAdmin: true });
  const owen = await mkUser('owen-owner'), bob = await mkUser('bob-globex-owner');
  const olivia = await mkUser('olivia-approver', { platformPermissions: ['technicians:manage'] }), quinn = await mkUser('quinn-approver', { platformPermissions: ['technicians:manage'] });
  await prisma.membership.create({ data: { userId: owen.id, tenantId: tenant.id, customerId: acme.id, roleId: roleOwner.id, capabilities: [] } });
  await prisma.membership.create({ data: { userId: bob.id, tenantId: tenant.id, customerId: globex.id, roleId: roleOwner.id, capabilities: [] } });
  const mkEp = async (hostname, business, actions = ALL_ACTIONS) => {
    const e = await prisma.endpoint.create({ data: { tenantId: tenant.id, customerId: business.id, name: hostname, hostname, platform: 'Windows', status: 'ACTIVE', isOnline: true, isManaged: true, accessMode: 'COMPANY_WIDE', lastSeenAt: new Date(), deviceClass: 'WORKSTATION' } });
    const rid = String(100000000 + ((Math.random() * 899999999) | 0));
    const secret = randomBytes(24).toString('hex');
    await prisma.rustdeskNode.create({ data: { tenantId: tenant.id, endpointId: e.id, rustdeskId: rid, agentSecretHash: sha(secret) } });
    const now = new Date();
    for (const [key, result] of [['service_list', { serviceCount: svcSnapshot.length, services: svcSnapshot }], ['process_list', { processCount: procSnapshot.length, userNamesRead: false, processes: procSnapshot }]]) {
      await prisma.diagnosticRun.create({ data: { endpointId: e.id, tenantId: tenant.id, customerId: business.id, key, status: 'COMPLETED', requestedById: null, requestedAt: now, completedAt: now, expiresAt: new Date(now.getTime() + 3_600_000), result } });
    }
    const ep = { id: e.id, rid, secret, hostname, actions, state: path.join(work, `agent-${hostname}`) };
    mkdirSync(ep.state);
    setScm(ep, { services: JSON.parse(JSON.stringify(SERVICES)), processes: JSON.parse(JSON.stringify(PROCS)) });
    return ep;
  };
  const pc = await mkEp('SVC-ACME', acme);
  const old = await mkEp('SVC-OLD', acme, ALL_ACTIONS.slice(0, 10));
  const gpc = await mkEp('SVC-GLOBEX', globex);
  const pk = { olivia: syntheticPasskey({ userId: olivia.id, name: 'SVC olivia' }), quinn: syntheticPasskey({ userId: quinn.id, name: 'SVC quinn' }) };
  for (const k of Object.values(pk)) await prisma.userMfaMethod.create({ data: { userId: k.userId, type: 'WEBAUTHN', isActive: true, credentialId: k.credentialId, publicKey: Buffer.from(k.publicKey, 'base64url'), signCount: 0, name: 'Test key' } });
  check(true, 'two businesses, three computers, five people');

  start('signer', path.join(dist, 'approval-signer', 'main.js'), signerEnv);
  start('api', path.join(dist, 'main.js'), apiEnv);
  await waitUp(`http://127.0.0.1:${SIGNER_INTERNAL}/internal/v1/keys`, 'signer');
  await waitUp(`${API}/health`, 'api');
  const S = {};
  for (const [k, u] of Object.entries({ admin, owen, bob, olivia, quinn })) S[k] = await login(u.email);
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
    keysFile = path.join(work, 'keys.json');
    writeFileSync(keysFile, Buffer.from(await (await fetch(`${API}/public/updates/targets/approval/${t.hashes.sha256}.keys.json`)).arrayBuffer()));
  }
  const set = signerCli(['policy', 'set', '--business', acme.id, '--approval', 'direct']);
  check(set.status === 0, 'the signer\'s operator puts Acme in direct mode (its CLI); Globex stays signed', set.stderr);
  for (const ep of [pc, old, gpc]) await heartbeat(ep);
  S.owenF = await stepUp(S.owen);

  // One request through the tab's route, the job it made, its envelope delivered.
  const ask = async (ep, kind, body, s = S.owenF, business = acme.id) => {
    const r = await req('POST', `/endpoints/${ep.id}/${kind === 'svc' ? 'services/control' : 'processes/stop'}`, { s, business, body });
    return { r, job: r.body?.data?.job };
  };
  const finish = async (ep, job, opts) => {
    const env = await deliver(ep, job.id);
    const res = env ? runAgent(ep, job.id, env, opts) : null;
    await report(ep);
    const t = await prisma.actionTarget.findFirst({ where: { jobId: job.id } });
    return { env, res, t };
  };

  section('Catalog and the tabs\' overview');
  {
    const cat = (await req('GET', `/actions/catalog?endpointId=${pc.id}`, { s: S.owen, business: acme.id })).body?.data;
    const by = Object.fromEntries((cat?.actions ?? []).map((a) => [a.id, a]));
    check(cat?.actions?.map((a) => `${a.id}@${a.version}`).join(',') === ALL_ACTIONS.join(','), 'GET /actions/catalog lists the twelve, the two new ones last', JSON.stringify(cat?.actions?.map((a) => a.id)));
    check(['windows.service.control', 'windows.process.stop'].every((id) => by[id]?.direct === false && by[id]?.maxTargets === 1 && by[id]?.workstationRisk === 'high' && by[id]?.warnings?.some((w) => /not yet run on a real Windows computer/.test(w))),
      'both: high impact even on a workstation, one computer, not from the Actions tab, and they say they have not run on real Windows');
    const o = await req('GET', `/endpoints/${pc.id}/device-control`, { s: S.owen, business: acme.id });
    const d = o.body?.data;
    check(o.status === 200 && d?.service?.possible === true && d?.process?.possible === true && d?.approval === 'direct' && /not yet run on a real Windows computer/.test(d?.unproven ?? ''),
      'the overview: both possible, direct mode, and the unproven note', msg(o));
    check(d?.protected?.services?.includes('WinDefend') && d.protected.keepRunning.join() === 'RustDesk' && d.protected.processes.includes('lsass') && d.protected.maxTree === 64, 'the overview carries the protected lists the buttons are drawn from');
    const g = (await req('GET', `/endpoints/${gpc.id}/device-control`, { s: S.bob, business: globex.id })).body?.data;
    check(g?.approval === 'signed', 'Globex\'s computer says signed');
    const od = (await req('GET', `/endpoints/${old.id}/device-control`, { s: S.owen, business: acme.id })).body?.data;
    check(od?.service?.possible === false && /does not report support/.test(od.service.reason) && /0\.45/.test(od.service.fix ?? ''), 'an agent without the actions: not possible, update it', JSON.stringify(od?.service));
    const x = (await req('GET', `/endpoints/${gpc.id}/device-control`, { s: S.owen, business: acme.id }));
    check(x.status === 403 || x.status === 404, 'another business\'s computer: refused', msg(x));
  }

  section('ClientSt0r: neither action is offered or accepted');
  {
    const caps = await call('GET', '/api/integration/v1/capabilities');
    const acts = caps.body?.features?.actions ?? [];
    check(caps.status === 200 && !acts.some((a) => /service\.control|process\.stop/.test(a)), 'the capabilities document does not offer them', JSON.stringify(acts));
    for (const [id, params] of [['windows.service.control', { service: 'Spooler', displayName: 'Print Spooler', op: 'stop' }], ['windows.process.stop', { pid: 4242, name: 'notepad', startedAt: T0_MS }]]) {
      const pb = { contract: 'ticket-rmm-v1', idempotency_key: `cs-${randomBytes(6).toString('hex')}`, organization_id: 'org-x', technician_id: 'cs-tech', rem0te_endpoint_id: pc.id, action: { id, version: 1 }, params, reason: 'AI triage suggests it', origin: 'ai_suggestion', ticket_ref: 't-1' };
      const pr = await call('POST', '/api/integration/v1/action-proposals', { body: pb, delegation: token({ sub: 'cs-tech', org: 'org-x', scope: 'actions:propose', req_sha256: hashProposal(pb) }) });
      check(pr.status === 400 && pr.body?.error?.code === 'ACTION_NOT_IN_CATALOG', `a ClientSt0r proposal of ${id} → ACTION_NOT_IN_CATALOG`, JSON.stringify(pr.body).slice(0, 200));
    }
  }

  section('The portal refuses before a plan exists');
  {
    const before = await prisma.actionJob.count({ where: { customerId: acme.id } });
    let r = await req('POST', `/endpoints/${pc.id}/actions`, { s: S.owenF, business: acme.id, body: { actionId: 'windows.service.control', version: 1, params: { service: 'Spooler', displayName: 'Print Spooler', op: 'start' }, reason: 'from the Actions tab' } });
    check(r.status === 400 && code(r) === 'ACTION_NOT_DIRECT', 'service control from the Actions tab → 400 ACTION_NOT_DIRECT', msg(r));
    r = await req('POST', `/endpoints/${pc.id}/actions`, { s: S.owenF, business: acme.id, body: { actionId: 'windows.process.stop', version: 1, params: { pid: 4242, name: 'notepad', startedAt: T0_MS }, reason: 'from the Actions tab' } });
    check(r.status === 400 && code(r) === 'ACTION_NOT_DIRECT', 'ending a process from the Actions tab → 400 ACTION_NOT_DIRECT', msg(r));
    const svcCases = [
      ['WinDefend, stop', { service: 'WinDefend', displayName: 'Microsoft Defender Antivirus Service', op: 'stop' }, 409, 'PROTECTED_SERVICE'],
      ['windefend (any case), restart', { service: 'windefend', displayName: 'Microsoft Defender Antivirus Service', op: 'restart' }, 409, 'PROTECTED_SERVICE'],
      ['Schedule (the heartbeat), disable', { service: 'Schedule', displayName: 'Task Scheduler', op: 'set_start_type', startType: 'disabled' }, 409, 'PROTECTED_SERVICE'],
      ['Rem0te\'s own service', { service: 'Rem0teAgent', displayName: 'Rem0te Agent', op: 'stop' }, 409, 'PROTECTED_SERVICE'],
      ['RustDesk, stop', { service: 'RustDesk', displayName: 'RustDesk Service', op: 'stop' }, 409, 'PROTECTED_SERVICE'],
      ['RustDesk, Disabled', { service: 'RustDesk', displayName: 'RustDesk Service', op: 'set_start_type', startType: 'disabled' }, 409, 'PROTECTED_SERVICE'],
      ['RustDesk, Manual', { service: 'RustDesk', displayName: 'RustDesk Service', op: 'set_start_type', startType: 'manual' }, 409, 'PROTECTED_SERVICE'],
      ['Windows Update, Disabled', { service: 'wuauserv', displayName: 'Windows Update', op: 'set_start_type', startType: 'disabled' }, 409, 'PROTECTED_SERVICE'],
      ['a binary path', { service: 'Spooler', displayName: 'Print Spooler', op: 'start', binaryPath: 'C:\\x.exe' }, 400, 'INVALID_REQUEST'],
      ['an account and password', { service: 'Spooler', displayName: 'Print Spooler', op: 'set_start_type', startType: 'manual', account: 'LocalSystem', password: 'x' }, 400, 'INVALID_REQUEST'],
      ['a boot start type', { service: 'Spooler', displayName: 'Print Spooler', op: 'set_start_type', startType: 'boot' }, 400, 'INVALID_REQUEST'],
      ['a name with a $', { service: 'MSSQL$X', displayName: 'SQL', op: 'start' }, 400, 'INVALID_REQUEST'],
      ['a service the snapshot does not list', { service: 'Nope', displayName: 'Nope', op: 'start' }, 404, 'SERVICE_NOT_IN_SNAPSHOT'],
      ['a display name the snapshot does not show', { service: 'Spooler', displayName: 'Print Spooler (fake)', op: 'start' }, 404, 'SERVICE_NOT_IN_SNAPSHOT'],
    ];
    for (const [what, body, st, c] of svcCases) {
      r = (await ask(pc, 'svc', body)).r;
      check(r.status === st && code(r) === c, `service: ${what} → ${st} ${c}`, msg(r));
    }
    r = (await ask(pc, 'svc', { service: 'RustDesk', displayName: 'RustDesk Service', op: 'stop' })).r;
    check(/never stopped or set to Manual or Disabled/.test(r.body?.message ?? JSON.stringify(r.body)), 'the RustDesk refusal says why', msg(r));
    const procCases = [
      ['svchost', { pid: 1100, name: 'svchost', startedAt: new Date(T0).toISOString() }, 'PROTECTED_PROCESS', /stop the service instead/],
      ['lsass', { pid: 700, name: 'lsass', startedAt: new Date(T0).toISOString() }, 'PROTECTED_PROCESS', /protected/],
      ['System (pid 4)', { pid: 4, name: 'System', startedAt: new Date(T0).toISOString() }, 'PROTECTED_PROCESS', /kernel/],
      ['rustdesk', { pid: 900, name: 'rustdesk', startedAt: T0_MS }, 'PROTECTED_PROCESS', /how this device is reached/],
    ];
    for (const [what, body, c, re] of procCases) {
      r = (await ask(pc, 'proc', body)).r;
      check(r.status === 409 && code(r) === c && re.test(JSON.stringify(r.body)), `process: ${what} → 409 ${c}`, msg(r));
    }
    r = (await ask(pc, 'proc', { pid: 4242, name: 'notepad', startedAt: '2026-11-14T09:30:02.000Z' })).r;
    check(r.status === 404 && code(r) === 'PROCESS_NOT_IN_SNAPSHOT', 'process: a start time the snapshot does not show → 404 PROCESS_NOT_IN_SNAPSHOT', msg(r));
    r = (await ask(pc, 'proc', { pid: 4242, name: 'notepad', startedAt: T0_MS, force: true })).r;
    check(r.status === 400, 'process: an extra key → 400', msg(r));
    r = (await ask(old, 'svc', { service: 'Spooler', displayName: 'Print Spooler', op: 'start' })).r;
    check(r.status === 409 && code(r) === 'SERVICE_CONTROL_NOT_POSSIBLE', 'an agent without the action → 409 SERVICE_CONTROL_NOT_POSSIBLE', msg(r));
    r = (await ask(pc, 'svc', { service: 'Spooler', displayName: 'Print Spooler', op: 'start' }, S.owen)).r;
    check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED', 'direct mode without a fresh sign-in → 403 STEP_UP_REQUIRED', msg(r));
    check(await prisma.actionJob.count({ where: { customerId: acme.id } }) === before, 'none of those made a job');
  }

  section('Direct mode (Acme): each operation, signed at once, run and verified on the computer');
  {
    const ops = [
      ['start Spooler', { service: 'Spooler', displayName: 'Print Spooler', op: 'start' }, (o) => o.state === 'running' && o.startType === 'automatic', 'start Spooler', () => svcOf(pc, 'Spooler').state === 'running'],
      ['stop Fax', { service: 'Fax', displayName: 'Fax', op: 'stop' }, (o) => o.state === 'stopped', 'stop Fax', () => svcOf(pc, 'Fax').state === 'stopped'],
      ['restart W32Time', { service: 'W32Time', displayName: 'Windows Time', op: 'restart' }, (o) => o.state === 'running', 'stop W32Time,start W32Time', () => svcOf(pc, 'W32Time').state === 'running'],
      ['set Fax to Disabled', { service: 'Fax', displayName: 'Fax', op: 'set_start_type', startType: 'disabled' }, (o) => o.startType === 'disabled' && o.want === 'disabled', 'config Fax disabled', () => svcOf(pc, 'Fax').startType === 'disabled'],
      ['set W32Time to Automatic (delayed)', { service: 'W32Time', displayName: 'Windows Time', op: 'set_start_type', startType: 'automatic_delayed' }, (o) => o.startType === 'automatic_delayed', 'config W32Time automatic_delayed', () => svcOf(pc, 'W32Time').startType === 'automatic_delayed'],
      ['stop Windows Update (allowed; disabling is not)', { service: 'wuauserv', displayName: 'Windows Update', op: 'stop' }, (o) => o.state === 'stopped', 'stop wuauserv', () => svcOf(pc, 'wuauserv').state === 'stopped'],
    ];
    for (const [what, body, okObs, calls, okState] of ops) {
      const st0 = scmNow(pc); st0.calls = []; writeFileSync(scmFile(pc), JSON.stringify(st0));
      const { r, job } = await ask(pc, 'svc', body);
      check(r.status === 201 && job?.status === 'APPROVED' && job.direct === true && job.approvalsRequired === 0 && job.risk === 'high', `${what}: signed at once — APPROVED, direct, no approvers, high`, msg(r));
      if (!job) continue;
      const signed = (await prisma.actionJob.findUnique({ where: { id: job.id } })).plan.params;
      check(JSON.stringify(Object.keys(signed).sort()) === JSON.stringify(Object.keys(body).sort()), `${what}: the plan signs exactly the closed parameters`, JSON.stringify(signed));
      const { res, t } = await finish(pc, job);
      check(res?.outcome === 'succeeded' && okObs(res.observed ?? {}) && scmNow(pc).calls.join(',') === calls && okState(), `${what}: the computer did it, read it back and reported state and startup type`, JSON.stringify({ res, calls: scmNow(pc).calls }).slice(0, 400));
      check(t?.status === 'SUCCEEDED' && t.result?.observed?.state, `${what}: recorded SUCCEEDED with what the computer saw`, JSON.stringify(t?.result).slice(0, 200));
    }
    // Starting a running service changes nothing.
    {
      const { job } = await ask(pc, 'svc', { service: 'Spooler', displayName: 'Print Spooler', op: 'start' });
      const { res } = await finish(pc, job);
      check(res?.outcome === 'no_change', 'starting a service that is already running: no_change', JSON.stringify(res));
    }
    // One at a time: a second request while the first is open.
    {
      const a = await ask(pc, 'svc', { service: 'Spooler', displayName: 'Print Spooler', op: 'stop' });
      const b = await ask(pc, 'svc', { service: 'Fax', displayName: 'Fax', op: 'start' });
      check(a.r.status === 201 && b.r.status === 409 && code(b.r) === 'SERVICE_CONTROL_NOT_POSSIBLE' && /still/.test(b.r.body?.message ?? ''), 'a second service change while one is open → 409, the first is still pending', msg(b.r));
      const o = (await req('GET', `/endpoints/${pc.id}/device-control`, { s: S.owen, business: acme.id })).body?.data;
      check(o?.service?.possible === false && o?.process?.possible === true, 'the overview says the same, and ending a process is still possible');
      await finish(pc, a.job);
    }
    // A failed stop is reported, not hidden.
    {
      const { job } = await ask(pc, 'svc', { service: 'Stubborn', displayName: 'Stubborn Service', op: 'stop' });
      const { res, t } = await finish(pc, job);
      check(res?.outcome === 'failed' && t?.status === 'FAILED', 'a service that will not stop: failed, recorded FAILED', JSON.stringify(res).slice(0, 300));
    }
    const o = (await req('GET', `/endpoints/${pc.id}/device-control`, { s: S.owen, business: acme.id })).body?.data;
    check(o?.recent?.length >= 8 && o.recent[0].observed && o.recent.every((x) => ['windows.service.control', 'windows.process.stop'].includes(x.actionId)), 'the overview lists recent requests with what the computer reported', JSON.stringify(o?.recent?.[0]).slice(0, 300));
  }

  section('The computer checks again: display name, RustDesk sessions');
  {
    // The snapshot says Renamed is "Renamed Service"; Windows now says otherwise.
    const { r, job } = await ask(pc, 'svc', { service: 'Renamed', displayName: 'Renamed Service', op: 'stop' });
    const { res } = await finish(pc, job);
    check(r.status === 201 && res?.outcome === 'refused' && res.reason === 'service_changed' && svcOf(pc, 'Renamed').state === 'running' && !scmNow(pc).calls.includes('stop Renamed'),
      'a display name that no longer matches: refused service_changed, nothing stopped', JSON.stringify(res));
    for (const [sessions, reason] of [[1, 'remote_session_open'], [-1, 'session_state_unknown']]) {
      const x = await ask(pc, 'svc', { service: 'RustDesk', displayName: 'RustDesk Service', op: 'restart' });
      const st0 = scmNow(pc); st0.calls = []; writeFileSync(scmFile(pc), JSON.stringify(st0));
      const f = await finish(pc, x.job, { sessions });
      check(x.r.status === 201 && f.res?.outcome === 'not_executed' && f.res.reason === reason && scmNow(pc).calls.length === 0, `RustDesk restart with ${sessions === 1 ? 'a session open' : 'sessions unknown'}: not_executed ${reason}, nothing touched`, JSON.stringify(f.res));
    }
    const x = await ask(pc, 'svc', { service: 'RustDesk', displayName: 'RustDesk Service', op: 'restart' });
    const f = await finish(pc, x.job, { sessions: 0 });
    check(f.res?.outcome === 'succeeded' && f.res.observed?.state === 'running', 'RustDesk restart with no session open: succeeded, running again', JSON.stringify(f.res));
  }

  section('Ending a process (Acme, direct)');
  {
    let x = await ask(pc, 'proc', { pid: 4242, name: 'notepad', startedAt: T0_MS });
    let f = await finish(pc, x.job);
    check(x.r.status === 201 && x.job.direct === true && f.res?.outcome === 'succeeded' && f.res.observed?.stillRunning === 'false' && !scmNow(pc).processes.some((p) => p.pid === 4242),
      'notepad (its pid, name and start time to the millisecond): ended, verified gone', JSON.stringify(f.res));
    x = await ask(pc, 'proc', { pid: 5150, name: 'EXCEL', startedAt: T0_MS, tree: true });
    f = await finish(pc, x.job);
    check(f.res?.outcome === 'succeeded' && f.res.observed?.childrenEnded === '1' && scmNow(pc).calls.join(',') .endsWith('terminate 5151,terminate 5150'), 'EXCEL with the processes it started: the child first, then EXCEL', JSON.stringify({ res: f.res, calls: scmNow(pc).calls.slice(-3) }));
    x = await ask(pc, 'proc', { pid: 6000, name: 'setup', startedAt: T0_MS, tree: true });
    f = await finish(pc, x.job);
    check(f.res?.outcome === 'refused' && f.res.reason === 'protected_process' && scmNow(pc).processes.some((p) => p.pid === 6000), 'a tree holding a protected process (MsMpEng): refused, nothing ended', JSON.stringify(f.res));
    // PID reuse: the snapshot's pid 7000 started at T0; Windows has since given it to a process started later.
    x = await ask(pc, 'proc', { pid: 7000, name: 'reused', startedAt: T0_MS });
    f = await finish(pc, x.job);
    check(x.r.status === 201 && f.res?.outcome === 'refused' && f.res.reason === 'process_changed' && scmNow(pc).processes.some((p) => p.pid === 7000) && !scmNow(pc).calls.includes('terminate 7000'),
      'a reused process id (same pid and name, a later start): refused process_changed, never ended', JSON.stringify(f.res));
    x = await ask(pc, 'proc', { pid: 7100, name: 'stuck', startedAt: T0_MS });
    f = await finish(pc, x.job);
    check(f.res?.outcome === 'failed' && f.res.observed?.stillRunning === 'true', 'a process still running afterwards: failed, still running', JSON.stringify(f.res));
    x = await ask(pc, 'proc', { pid: 4242, name: 'notepad', startedAt: T0_MS });
    f = await finish(pc, x.job);
    check(f.res?.outcome === 'no_change' && f.res.reason === 'not_running', 'a process already gone: no_change not_running', JSON.stringify(f.res));
  }

  section('A plan the portal should never have made: the computer refuses it too');
  {
    // As a compromised portal would: take a signed plan, change its
    // parameters, and give it straight to the signer (which, in direct mode,
    // signs at admission). The agent's own lists still refuse it.
    const base = await prisma.actionJob.findFirst({ where: { customerId: acme.id, actionId: 'windows.service.control' }, orderBy: { createdAt: 'desc' } });
    const forge = async (params, actionId = 'windows.service.control') => {
      const plan = { ...base.plan, jobId: randomBytes(16).toString('hex'), action: { id: actionId, version: 1 }, params, createdAt: new Date().toISOString(), approvers: [], signedAt: null,
        window: { notBefore: new Date(Date.now() - 60_000).toISOString(), notAfter: new Date(Date.now() + 3_600_000).toISOString() } };
      const s = await sj(`http://127.0.0.1:${SIGNER_INTERNAL}/internal/v1/plans`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plan }) });
      const g = await sj(`http://127.0.0.1:${SIGNER_INTERNAL}/internal/v1/plans/${plan.jobId}`);
      // The portal's relay never saw this plan signed, so its cached statement
      // is older than the signature; the agent is handed the signer's own.
      const rv = await sj(`http://127.0.0.1:${SIGNER_INTERNAL}/internal/v1/revocations`);
      const rf = path.join(work, `rev-${plan.jobId}.json`);
      writeFileSync(rf, JSON.stringify({ schema: rv.body?.schema, kid: rv.body?.kid, statement: rv.body?.statement, sig: rv.body?.sig }));
      return { s, jobId: plan.jobId, env: g.body?.envelope, rf };
    };
    const cases = [
      ['stop WinDefend', { service: 'WinDefend', displayName: 'Microsoft Defender Antivirus Service', op: 'stop' }, 'protected_service', () => svcOf(pc, 'WinDefend').state === 'running'],
      ['stop RustDesk', { service: 'RustDesk', displayName: 'RustDesk Service', op: 'stop' }, 'protected_service', () => svcOf(pc, 'RustDesk').state === 'running'],
      ['disable Windows Update', { service: 'wuauserv', displayName: 'Windows Update', op: 'set_start_type', startType: 'disabled' }, 'protected_service', () => svcOf(pc, 'wuauserv').startType === 'manual'],
      ['stop a driver', { service: 'kbdclass', displayName: 'Keyboard Class Driver', op: 'stop' }, 'not_a_service', () => svcOf(pc, 'kbdclass').state === 'running'],
    ];
    for (const [what, params, reason, unchanged] of cases) {
      const fz = await forge(params);
      const st0 = scmNow(pc); st0.calls = []; writeFileSync(scmFile(pc), JSON.stringify(st0));
      const res = fz.env ? runAgent(pc, fz.jobId, fz.env, { revocations: fz.rf }) : null;
      check(!!fz.env && res?.outcome === 'refused' && res.reason === reason && scmNow(pc).calls.length === 0 && unchanged(), `forged "${what}", signed: the computer refuses (${reason}) and changes nothing`, JSON.stringify({ signer: fz.s.status, res }).slice(0, 300));
    }
    for (const [what, params] of [['end lsass', { pid: 700, name: 'lsass', startedAt: new Date(T0).toISOString() }], ['end svchost', { pid: 1100, name: 'svchost', startedAt: new Date(T0).toISOString() }]]) {
      const fz = await forge(params, 'windows.process.stop');
      const res = fz.env ? runAgent(pc, fz.jobId, fz.env, { revocations: fz.rf }) : null;
      check(!!fz.env && res?.outcome === 'refused' && res.reason === 'protected_process' && scmNow(pc).processes.some((p) => p.pid === params.pid), `forged "${what}", signed: the computer refuses (protected_process)`, JSON.stringify(res).slice(0, 300));
      if (what === 'end svchost') check(/stop the service instead/.test(res?.detail ?? ''), 'and for svchost says to stop the service instead', res?.detail);
    }
    const fz = await forge({ service: 'Spooler', displayName: 'Print Spooler', op: 'stop', binaryPath: 'C:\\evil.exe' });
    check(fz.s.status >= 400 && !fz.env, 'a plan with a binary path: the signer refuses to sign it', JSON.stringify(fz.s).slice(0, 200));
  }

  section('Containment: the portal holds, the computer refuses under a signed pause');
  {
    const pause = await prisma.containmentPause.create({ data: { scope: 'BUSINESS', customerId: acme.id, kinds: ['actions'], reason: 'service e2e', setById: admin.id, setBy: 'msp' } });
    const r = (await ask(pc, 'svc', { service: 'Spooler', displayName: 'Print Spooler', op: 'start' })).r;
    check(r.status === 409 && code(r) === 'SERVICE_CONTROL_NOT_POSSIBLE' && /suspended|pause/i.test(r.body?.message ?? '') && /service e2e/.test(r.body?.message ?? ''), 'while actions are paused for the business: 409, with the pause\'s reason', msg(r));
    const p2 = (await ask(pc, 'proc', { pid: 5150, name: 'EXCEL', startedAt: T0_MS })).r;
    check(p2.status === 409 && code(p2) === 'PROCESS_STOP_NOT_POSSIBLE', 'and ending a process: 409', msg(p2));
    await prisma.containmentPause.update({ where: { id: pause.id }, data: { clearedAt: new Date(), clearedById: admin.id, clearReason: 'test' } });
    const x = await ask(pc, 'svc', { service: 'Spooler', displayName: 'Print Spooler', op: 'start' });
    const env = await deliver(pc, x.job.id);
    const pf = path.join(work, 'pause.json');
    writeFileSync(pf, JSON.stringify({ schema: 'rem0te-pause/1', issuedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), reason: 'incident 45', actions: { all: false, businesses: [acme.id] }, updates: { all: false } }));
    const st0 = scmNow(pc); st0.calls = []; writeFileSync(scmFile(pc), JSON.stringify(st0));
    const res = runAgent(pc, x.job.id, env, { pause: pf });
    check(res.outcome === 'refused' && res.reason === 'paused' && scmNow(pc).calls.length === 0, 'a signed pause covering the business: refused "paused" before the service manager is asked anything', JSON.stringify(res));
    await report(pc);
  }

  section('Signed mode (Globex): two approvers, then the computer');
  {
    const { r, job } = await ask(gpc, 'svc', { service: 'Spooler', displayName: 'Print Spooler', op: 'start', reason: 'printing stopped' }, S.bob, globex.id);
    check(r.status === 201 && job?.status === 'AWAITING_APPROVAL' && job.approvalsRequired === 2 && !job.direct, 'no fresh sign-in needed to ask: AWAITING_APPROVAL, two approvers', msg(r));
    const page = await (await fetch(job.approvalUrl)).text();
    check(page.includes('windows.service.control') && page.includes('Spooler') && page.includes('Print Spooler'), 'the approval page shows the action, the service and its display name');
    check(!(await deliver(gpc, job.id)), 'nothing is delivered before it is approved');
    await approve(job.id, pk.olivia); await approve(job.id, pk.quinn);
    check((await req('GET', `/actions/${job.id}`, { s: S.bob, business: globex.id })).body?.data?.status === 'APPROVED', 'the second approver signs it');
    const f = await finish(gpc, job);
    check(f.res?.outcome === 'succeeded' && svcOf(gpc, 'Spooler').state === 'running' && f.t?.status === 'SUCCEEDED', 'the computer starts it; recorded SUCCEEDED', JSON.stringify(f.res));
    const p = await ask(gpc, 'proc', { pid: 4242, name: 'notepad', startedAt: T0_MS }, S.bob, globex.id);
    check(p.r.status === 201 && p.job?.status === 'AWAITING_APPROVAL', 'ending a process: AWAITING_APPROVAL', msg(p.r));
    await approve(p.job.id, pk.olivia); await approve(p.job.id, pk.quinn);
    await req('GET', `/actions/${p.job.id}`, { s: S.bob, business: globex.id });
    const g = await finish(gpc, p.job);
    check(g.res?.outcome === 'succeeded' && !scmNow(gpc).processes.some((x) => x.pid === 4242), 'approved, the computer ends it', JSON.stringify(g.res));
    const t = await ask(gpc, 'svc', { service: 'Fax', displayName: 'Fax', op: 'set_start_type', startType: 'manual' }, S.bob, globex.id);
    await approve(t.job.id, pk.olivia); await approve(t.job.id, pk.quinn);
    await req('GET', `/actions/${t.job.id}`, { s: S.bob, business: globex.id });
    const h = await finish(gpc, t.job);
    check(h.res?.outcome === 'no_change' && h.res.observed?.startType === 'manual', 'setting the startup type it already has: no_change, reported', JSON.stringify(h.res));
  }
}

async function cleanup() {
  await stop('api'); await stop('signer');
  try {
    if (created.businesses.length) {
      await prisma.actionJob.deleteMany({ where: { customerId: { in: created.businesses } } });
      await prisma.containmentPause.deleteMany({ where: { customerId: { in: created.businesses } } });
      const eps = await prisma.endpoint.findMany({ where: { customerId: { in: created.businesses } }, select: { id: true } });
      const ids = eps.map((e) => e.id);
      await prisma.diagnosticRun.deleteMany({ where: { endpointId: { in: ids } } });
      await prisma.rustdeskNode.deleteMany({ where: { endpointId: { in: ids } } });
      await prisma.endpoint.deleteMany({ where: { id: { in: ids } } });
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
