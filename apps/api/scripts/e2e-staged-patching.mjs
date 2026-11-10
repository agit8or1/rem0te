#!/usr/bin/env node
/**
 * End-to-end proof of staged Windows patching (v0.27): a canary, then a ring,
 * each approved by two people on the approval signer's roster with their
 * passkeys, installed by the agent's real decision code against a simulated
 * Windows Update.
 *
 * Self-contained, like e2e-approved-action.mjs. It
 *   - builds a signed update repository carrying a stand-in agent build and
 *     the signer's approval/keys.json;
 *   - starts the approval signer and the compiled API on scratch ports and a
 *     scratch database;
 *   - gives each synthetic computer a simulated Windows Update (offered,
 *     installed and superseded updates, install results, crashes) and a
 *     simulated registry (WSUS, pending-restart keys);
 *   - scans and installs with rem0te-action-sim, which runs the agent's real
 *     internal/patch and internal/action code;
 * and removes its fixtures.
 *
 *   cd apps/api && npx nest build
 *   RELEASE_BIN=/tmp/rem0te-release ACTION_SIM=/tmp/rem0te-action-sim \
 *   DATABASE_URL=postgresql://…/reboot_remote_it_scratch node scripts/e2e-staged-patching.mjs
 *
 * FIXTURE-TESTED: no Windows, no real Windows Update, no real authenticator.
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syntheticPasskey } from './lib/synthetic-passkey.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');

const DB = process.env.DATABASE_URL ?? '';
const dbName = DB.split('/').pop()?.split('?')[0] ?? '';
if (!/scratch|test/.test(dbName)) { console.error(`Refusing to run against database "${dbName}": name must contain "scratch" or "test".`); process.exit(2); }
const BIN = process.env.RELEASE_BIN, SIM = process.env.ACTION_SIM;
if (!BIN || !SIM) { console.error('RELEASE_BIN (rem0te-release) and ACTION_SIM (rem0te-action-sim) are required'); process.exit(2); }
const PORT = Number(process.env.PATCH_API_PORT ?? 3171);
const SIGNER_PUBLIC = Number(process.env.PATCH_SIGNER_PUBLIC_PORT ?? 3273);
const SIGNER_INTERNAL = Number(process.env.PATCH_SIGNER_INTERNAL_PORT ?? 3274);
if ([PORT, SIGNER_PUBLIC, SIGNER_INTERNAL].some((p) => [3000, 3001, 443, 3201, 3202].includes(p))) { console.error('refusing a production port'); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
const ORIGIN = `http://127.0.0.1:${SIGNER_PUBLIC}`;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'patch-e2e-password-123';

let pass = 0, fail = 0; const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;
const sha = (b) => createHash('sha256').update(b).digest('hex');

// ── Updates as Windows Update describes them ────────────────────────────────
const SEC = '0fa1201d-4330-4fa8-8ae9-b877473b6441', UPD = 'cd5ffd1e-e932-4e3a-bf74-18bf0b1bbd83', DRV = 'ebfc1fc5-71a4-4f7b-9aca-3b9a503104a0';
const u = (updateId, revision, kb, title, classification, className, extra = {}) => ({ updateId, revision, kb, title, classification, className, severity: classification === SEC ? 'Critical' : '', downloaded: false, rebootBehavior: 1, userInput: false, eulaAccepted: true, browseOnly: false, sizeBytes: 600 << 20, ...extra });
const CU = u('5a1b2c3d-0000-4000-8000-000000000001', 201, 'KB5044284', '2026-11 Cumulative Update for Windows 11 (KB5044284)', SEC, 'Security Updates');
const NET = u('5a1b2c3d-0000-4000-8000-000000000002', 3, 'KB5044099', '2026-11 .NET Framework update (KB5044099)', UPD, 'Updates', { rebootBehavior: 0 });
const DRIVER = u('5a1b2c3d-0000-4000-8000-000000000003', 1, undefined, 'Contoso - Display - 31.0.101', DRV, 'Drivers');
const OPT = u('5a1b2c3d-0000-4000-8000-000000000004', 1, 'KB5044777', '2026-11 Optional preview update', UPD, 'Updates', { browseOnly: true });
const id = (x) => ({ updateId: x.updateId, revision: x.revision });
const key = (x) => `${x.updateId}@${x.revision}`;

// ── The release machine ─────────────────────────────────────────────────────
const work = mkdtempSync(path.join(tmpdir(), 'rem0te-patch-'));
const keys = path.join(work, 'keys'); mkdirSync(keys);
const repo = path.join(work, 'repo');
const files = path.join(work, 'files'); mkdirSync(files);
const signerDir = path.join(work, 'signer'); mkdirSync(signerDir, { mode: 0o700 });
const rel = (...a) => execFileSync(BIN, a, { encoding: 'utf8' });
const signerCli = (args) => spawnSync(process.execPath, [path.join(dist, 'approval-signer', 'main.js'), ...args], { encoding: 'utf8', env: { ...process.env, APPROVAL_SIGNER_DIR: signerDir } });
for (const k of ['r1', 'targets', 'snapshot', 'timestamp']) rel('keygen', '-out', path.join(keys, `${k}.pem`));
rel('init', '-repo', repo, '-root-key', path.join(keys, 'r1.pem'), '-root-threshold', '1', '-targets-key', path.join(keys, 'targets.pem'), '-snapshot-key', path.join(keys, 'snapshot.pem'), '-timestamp-key', path.join(keys, 'timestamp.pem'));
const agentBin = Buffer.concat([Buffer.from('MZ stand-in signed agent 0.27 '), randomBytes(64), Buffer.from('REM0TE_INST_URL:'), Buffer.alloc(240)]);
writeFileSync(path.join(files, 'agent.exe'), agentBin);
const AGENT_SHA = sha(agentBin);
const kg = signerCli(['keygen']);
if (kg.status !== 0) throw new Error(`signer keygen: ${kg.stderr}`);
writeFileSync(path.join(files, 'approval-keys.json'), kg.stdout);
const keysFile = path.join(files, 'approval-keys.json');
rel('release', '-repo', repo, '-targets-key', path.join(keys, 'targets.pem'), '-snapshot-key', path.join(keys, 'snapshot.pem'), '-timestamp-key', path.join(keys, 'timestamp.pem'),
  '-add', `windows/rem0te-agent.exe=${path.join(files, 'agent.exe')}`, '-add', `approval/keys.json=${keysFile}`);

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
  APPROVAL_SIGNER_INTERNAL_URL: `http://127.0.0.1:${SIGNER_INTERNAL}`,
  JWT_SECRET: randomBytes(32).toString('hex'), LAUNCHER_TOKEN_SECRET: randomBytes(32).toString('hex'),
  ENCRYPTION_KEY: randomBytes(32).toString('hex'), TRUSTED_PROXIES: 'loopback',
  VERSION_FILE: path.resolve(here, '..', '..', '..', 'version.json'),
};
async function waitUp(url, name) {
  for (let i = 0; i < 120; i++) { try { const r = await fetch(url); if (r.status < 500) return; } catch { /* not yet */ } await sleep(300); }
  throw new Error(`${name} did not come up:\n${kids[name]?.log.slice(-3000)}`);
}

// ── HTTP ────────────────────────────────────────────────────────────────────
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
const msg = (r) => `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 400)}`;
const sj = async (url, init = {}) => { const r = await fetch(url, init); let b = null; try { b = await r.json(); } catch { /* html */ } return { status: r.status, body: b }; };
const signerPost = (jid, p, body) => sj(`${ORIGIN}/approve/${jid}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify(body) });
async function approve(jobId, who) {
  const c = await signerPost(jobId, '/challenge', { decision: 'approve', role: 'approver' });
  if (c.status !== 200) return c;
  return signerPost(jobId, '/decide', { challengeId: c.body.challengeId, assertion: who.assert(c.body.options, { origin: ORIGIN }) });
}

// ── A simulated computer ────────────────────────────────────────────────────
const ACTIONS = ['windows.service.start@1', 'windows.update.install@1'];
function sim(pc, args) { return execFileSync(SIM, ['-wua', pc.wua, '-registry', pc.reg, ...args], { encoding: 'utf8' }); }
const scan = (pc) => JSON.parse(sim(pc, ['-scan']).trim());
const restart = (pc) => sim(pc, ['-restart']);
const setWUA = (pc, f) => { const w = JSON.parse(readFileSync(pc.wua, 'utf8')); f(w); writeFileSync(pc.wua, JSON.stringify(w)); };
const wuaNow = (pc) => JSON.parse(readFileSync(pc.wua, 'utf8'));
const heartbeat = (pc, extra = {}) => req('POST', '/enrollment/heartbeat', {
  body: { rustdeskId: pc.rid, agentSecret: pc.secret, hostname: pc.hostname, platform: 'Windows', updateChannel: 'signed', agentActions: ACTIONS, agentSha256: AGENT_SHA, ...extra },
});
function resultsOf(pc) {
  const d = path.join(pc.state, 'actions', 'results');
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => /^[0-9a-f]{32}\.json$/.test(f)).map((f) => JSON.parse(readFileSync(path.join(d, f), 'utf8')));
}
function clearAcked(pc, acks) { for (const a of acks ?? []) rmSync(path.join(pc.state, 'actions', 'results', `${a}.json`), { force: true }); }
function runAgent(pc, jobId, envelope) {
  const envFile = path.join(work, `env-${jobId}-${randomBytes(3).toString('hex')}.json`);
  writeFileSync(envFile, JSON.stringify(envelope));
  const out = sim(pc, ['-state', pc.state, '-keys', keysFile, '-job', jobId, '-envelope', envFile, '-rustdesk-id', pc.rid, '-secret', pc.secret, '-product-type', '1', '-self-sha', AGENT_SHA]);
  return JSON.parse(out.trim());
}
/** One full heartbeat cycle: report posture, take envelopes, run them, report results. */
async function cycle(pc) {
  const hb = await heartbeat(pc, { patchPosture: scan(pc) });
  const got = hb.body?.data?.actions ?? [];
  const outs = got.map((d) => runAgent(pc, d.jobId, d.envelope));
  const hb2 = await heartbeat(pc, { actionResults: resultsOf(pc), patchPosture: scan(pc) });
  clearAcked(pc, hb2.body?.data?.actionAcks);
  return { delivered: got, outs, hb, hb2 };
}

const created = { businesses: [], users: [] };

async function all() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });

  section('Fixtures (synthetic): Acme with a canary and a ring, Birch next door');
  const acme = await prisma.customer.create({ data: { tenantId: tenant.id, name: `SP Acme ${sfx}` } });
  const birch = await prisma.customer.create({ data: { tenantId: tenant.id, name: `SP Birch ${sfx}` } });
  created.businesses.push(acme.id, birch.id);
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag, extra = {}) => { const x = await prisma.user.create({ data: { email: `sp-${tag}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'SP', lastName: tag, status: 'ACTIVE', ...extra } }); created.users.push(x.id); return x; };
  const owen = await mkUser('owen-owner-acme'), bea = await mkUser('bea-owner-birch'), dana = await mkUser('dana-l2');
  const olivia = await mkUser('olivia-approver', { platformPermissions: ['technicians:manage'] }), quinn = await mkUser('quinn-approver', { platformPermissions: ['technicians:manage'] });
  await prisma.membership.create({ data: { userId: owen.id, tenantId: tenant.id, customerId: acme.id, roleId: roleOwner.id, capabilities: [] } });
  await prisma.membership.create({ data: { userId: bea.id, tenantId: tenant.id, customerId: birch.id, roleId: roleOwner.id, capabilities: [] } });
  const l2 = await prisma.technicianPreset.findUnique({ where: { key: 'l2-technician' } });
  await prisma.technicianAssignment.create({ data: { tenantId: tenant.id, customerId: acme.id, userId: dana.id, presetId: l2.id, capabilities: [] } });

  const mkPc = async (biz, hostname, offered, wuaExtra = {}, registry = {}) => {
    const e = await prisma.endpoint.create({ data: { tenantId: tenant.id, customerId: biz.id, name: hostname, hostname, status: 'ACTIVE', isOnline: true, isManaged: true, accessMode: 'COMPANY_WIDE', lastSeenAt: new Date(), deviceClass: 'WORKSTATION' } });
    const rid = String(100000000 + ((Math.random() * 899999999) | 0));
    const secret = randomBytes(24).toString('hex');
    await prisma.rustdeskNode.create({ data: { tenantId: tenant.id, endpointId: e.id, rustdeskId: rid, agentSecretHash: sha(secret) } });
    const state = path.join(work, `pc-${e.id}`); mkdirSync(state);
    const pc = { id: e.id, rid, secret, state, hostname, wua: path.join(state, 'wua.json'), reg: path.join(state, 'registry.json') };
    writeFileSync(pc.wua, JSON.stringify({ offered, installed: [], superseded: [], history: [], ...wuaExtra }));
    writeFileSync(pc.reg, JSON.stringify(registry));
    return pc;
  };
  const canary = await mkPc(acme, 'CANARY', [CU, NET, DRIVER, OPT], { results: { [key(CU)]: { resultCode: 2, rebootRequired: true, hresult: '0x00000000' } } });
  const r1a = await mkPc(acme, 'R1-A', [CU, NET], { results: { [key(CU)]: { resultCode: 2, rebootRequired: true, hresult: '0x00000000' } } });
  const r1b = await mkPc(acme, 'R1-B', [CU], { installed: [id(NET)] });
  const r1c = await mkPc(acme, 'R1-C', [CU, NET], { results: { [key(CU)]: { resultCode: 4, hresult: '0x80240022' } } });
  const wsus = await mkPc(acme, 'WSUS-PC', [CU], {}, { strings: { 'SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate|WUServer': 'http://wsus.acme.example.com:8530' }, dwords: { 'SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate\\AU|UseWUServer': 1 } });
  const birchPc = await mkPc(birch, 'CANARY', [CU]);
  check(true, 'Acme: CANARY, R1-A, R1-B (has .NET already), R1-C (CU will fail), WSUS-PC (WSUS-managed); Birch: its own CANARY');

  const pk = { owen: syntheticPasskey({ userId: owen.id, name: 'SP owen' }), olivia: syntheticPasskey({ userId: olivia.id, name: 'SP olivia' }), quinn: syntheticPasskey({ userId: quinn.id, name: 'SP quinn' }) };
  for (const k of Object.values(pk)) await prisma.userMfaMethod.create({ data: { userId: k.userId, type: 'WEBAUTHN', isActive: true, credentialId: k.credentialId, publicKey: Buffer.from(k.publicKey, 'base64url'), signCount: 0, name: 'Test key' } });

  start('signer', path.join(dist, 'approval-signer', 'main.js'), signerEnv);
  start('api', path.join(dist, 'main.js'), apiEnv);
  await waitUp(`http://127.0.0.1:${SIGNER_INTERNAL}/internal/v1/keys`, 'signer');
  await waitUp(`${API}/health`, 'api');
  const S = { owen: await login(owen.email), bea: await login(bea.email), dana: await login(dana.email), olivia: await login(olivia.email), quinn: await login(quinn.email) };
  for (const [who, roles] of [['owen', ['--approve', '*']], ['olivia', ['--approve', '*']], ['quinn', ['--approve', acme.id]]]) {
    const list = await req('GET', '/auth/passkeys', { s: S[who] });
    const mine = (list.body?.data ?? list.body ?? [])[0];
    const add = signerCli(['roster', 'add', '--export', mine.approvalExport, ...roles, '--confirm-fingerprint', mine.approvalFingerprint]);
    if (add.status !== 0) throw new Error(`roster add ${who}: ${add.stderr}`);
  }

  section('Posture: the signed agent scans, the heartbeat reports, the portal acknowledges');
  {
    const p = scan(canary);
    check(p.schema === 'rem0te-patch-posture/1' && p.updates.length === 4 && p.managers.length === 0, 'patch-scan (the agent\'s real internal/patch) reports what Windows Update offers', JSON.stringify(p).slice(0, 200));
    const hb = await heartbeat(canary, { patchPosture: p });
    check(hb.status === 201 || hb.status === 200, 'heartbeat accepted', msg(hb));
    check(hb.body?.data?.patchPostureAck === p.scannedAt && hb.body?.data?.patchScan === false, 'the portal acknowledges that exact scan, and does not ask for another', msg(hb));
    const inv = await prisma.endpointInventory.findUnique({ where: { endpointId: canary.id } });
    check(inv.pendingUpdateCount === 4 && inv.patchScannedAt?.toISOString() === new Date(p.scannedAt).toISOString(), 'the inventory page\'s update count comes from the same scan');
    const forged = await heartbeat(r1a, { patchPosture: { ...scan(r1a), command: 'powershell -enc ...' } });
    const inv2 = await prisma.endpointInventory.findUnique({ where: { endpointId: r1a.id } });
    check(forged.body?.data?.patchPostureAck === null && !inv2?.patchPosture, 'a posture with an unknown field is refused whole: not stored, not acknowledged', msg(forged));
    const legacy = await req('POST', '/enrollment/heartbeat', { body: { rustdeskId: r1a.rid, agentSecret: r1a.secret, hostname: 'R1-A', platform: 'Windows', patchPosture: scan(r1a) } });
    check(legacy.body?.data?.patchPostureAck == null && !(await prisma.endpointInventory.findUnique({ where: { endpointId: r1a.id } }))?.patchPosture, 'a legacy-channel heartbeat\'s posture is ignored');
    const first = await heartbeat(r1b);
    check(first.body?.data?.patchScan === true, 'a signed agent with no posture is asked to scan', msg(first));
    for (const pc of [r1a, r1b, r1c, wsus, birchPc]) await heartbeat(pc, { patchPosture: scan(pc) });
    const view = await req('GET', `/endpoints/${canary.id}/patches`, { s: S.owen, business: acme.id });
    const byKb = Object.fromEntries((view.body?.data?.updates ?? []).map((x) => [x.kb ?? x.title, x]));
    check(view.status === 200 && byKb.KB5044284?.installable === true && byKb['Contoso - Display - 31.0.101']?.installable === false && byKb.KB5044777?.installable === false,
      'the computer\'s Patches view: the CU installable; the driver and the optional preview are not, with why', msg(view));
    const w = await req('GET', `/endpoints/${wsus.id}/patches`, { s: S.owen, business: acme.id });
    check(w.body?.data?.managers?.[0]?.label === 'WSUS', 'WSUS-PC shows its updates are managed by WSUS', msg(w));
    const refresh = await req('POST', `/endpoints/${canary.id}/inventory/refresh`, { s: S.owen, business: acme.id });
    const asked = await heartbeat(canary);
    check(refresh.status < 300 && asked.body?.data?.patchScan === true, 'Refresh inventory asks a signed agent for a new patch scan', msg(asked));
    const fresh = await heartbeat(canary, { patchPosture: scan(canary) });
    check(fresh.body?.data?.patchScan === false, 'and stops asking once a newer scan arrives');
  }

  section('Deployments: only installable, offered updates; only ready, unmanaged computers');
  const good = { businessId: acme.id, name: 'November security', updates: [id(CU), id(NET)], rings: [[canary.id], [r1a.id, r1b.id, r1c.id]], soakHours: 0, failureThreshold: 0, windowHours: 8 };
  let dep;
  {
    let r = await req('POST', `/endpoints/${canary.id}/actions`, { s: S.owen, business: acme.id, body: { actionId: 'windows.update.install', version: 1, params: { updates: [id(CU)], reboot: 'never' }, reason: 'just this one' } });
    check(r.status === 400 && code(r) === 'ACTION_NOT_DIRECT', 'updates are not requestable one computer at a time from the Actions tab', msg(r));
    r = await req('POST', '/patching/deployments', { s: S.owen, business: acme.id, body: { ...good, rings: [[canary.id, r1a.id]] } });
    check(r.status === 400 && code(r) === 'BAD_RINGS', 'ring 0 must be exactly one computer (the canary)', msg(r));
    r = await req('POST', '/patching/deployments', { s: S.owen, business: acme.id, body: { ...good, rings: [[canary.id], [wsus.id]] } });
    check(r.status === 409 && code(r) === 'MANAGED_ELSEWHERE', 'a WSUS-managed computer is refused, by name', msg(r));
    r = await req('POST', '/patching/deployments', { s: S.owen, business: acme.id, body: { ...good, updates: [id(DRIVER)] } });
    check(r.status === 400 && code(r) === 'UPDATE_NOT_INSTALLABLE', 'a driver is refused', msg(r));
    r = await req('POST', '/patching/deployments', { s: S.owen, business: acme.id, body: { ...good, updates: [id(OPT)] } });
    check(r.status === 400 && code(r) === 'UPDATE_NOT_INSTALLABLE', 'an optional preview update is refused', msg(r));
    r = await req('POST', '/patching/deployments', { s: S.owen, business: acme.id, body: { ...good, updates: [{ updateId: '5a1b2c3d-0000-4000-8000-0000000000ff', revision: 1 }] } });
    check(r.status === 400 && code(r) === 'UPDATE_NOT_OFFERED', 'an update no computer is offered is refused (and so is anything named by URL or KB alone)', msg(r));
    r = await req('POST', '/patching/deployments', { s: S.owen, business: acme.id, body: { ...good, updates: [{ url: 'https://evil.example/x.msu' }] } });
    check(r.status === 400, 'an update given as a URL does not even parse', msg(r));
    r = await req('POST', '/patching/deployments', { s: S.owen, business: acme.id, body: { ...good, rings: [[canary.id], [birchPc.id]] } });
    check(r.status === 404, 'Birch\'s computer in Acme\'s deployment → 404', msg(r));
    r = await req('POST', '/patching/deployments', { s: S.dana, business: acme.id, body: good });
    check(r.status === 403 && code(r) === 'ACTION_NOT_GRANTED', 'an L2 technician cannot request software installs (high impact)', msg(r));
    const cand = await req('GET', `/patching/candidates?businessId=${acme.id}`, { s: S.owen, business: acme.id });
    check(cand.status === 200 && cand.body.data.updates.find((x) => x.kb === 'KB5044284')?.offeredOn === 5 && cand.body.data.computers.find((c) => c.hostname === 'WSUS-PC')?.managers[0] === 'WSUS', 'candidates: what each computer is offered, and which are managed elsewhere', msg(cand));
    r = await req('POST', '/patching/deployments', { s: S.owen, business: acme.id, body: good });
    dep = r.body?.data;
    check(r.status === 201 && dep?.status === 'ACTIVE' && dep.next.ring === 0 && dep.next.canRequest && dep.updates[0].kb === 'KB5044284', 'Owen creates "November security": CU + .NET, canary then a ring of three', msg(r));
    const early = await req('POST', `/patching/deployments/${dep.id}/rings/1/request`, { s: S.owen, business: acme.id, body: { reason: 'skip the canary' } });
    check(early.status === 409 && code(early) === 'RING_GATE', 'ring 1 cannot be requested before the canary', msg(early));
    const nosy = await req('GET', `/patching/deployments/${dep.id}`, { s: S.bea, business: birch.id });
    check(nosy.status === 404, 'Birch\'s owner cannot see Acme\'s deployment', msg(nosy));
  }

  section('The canary: two approvals, install, never a restart');
  let canaryJob;
  {
    const r = await req('POST', `/patching/deployments/${dep.id}/rings/0/request`, { s: S.owen, business: acme.id, body: { reason: 'Patch Tuesday' } });
    canaryJob = r.body?.data?.job;
    check(r.status === 201 && canaryJob?.status === 'AWAITING_APPROVAL' && canaryJob.approvalsRequired === 2 && canaryJob.risk === 'high', 'the canary plan awaits TWO approvals — software installs are high impact even on one workstation', msg(r));
    const page = await (await fetch(canaryJob.approvalUrl)).text();
    check(page.includes('KB5044284') && page.includes('canary (ring 0)') && page.includes('never restarting') && /may not stay|cannot be uninstalled/.test(page), 'the approval page names the KBs, the canary ring, and that it never restarts', page.slice(0, 200));
    const self = await approve(canaryJob.id, pk.owen);
    check(self.status >= 400 && /requester/.test(JSON.stringify(self.body)), 'Owen, who asked, cannot approve it', JSON.stringify(self.body));
    await approve(canaryJob.id, pk.olivia);
    const hb = await heartbeat(canary);
    check(!(hb.body?.data?.actions ?? []).length, 'one approval is not enough: nothing is delivered');
    await approve(canaryJob.id, pk.quinn);
    const other = await heartbeat(r1a);
    check(!(other.body?.data?.actions ?? []).some((a) => a.jobId === canaryJob.id), 'R1-A is not in the canary plan and is not given it');
    const c = await cycle(canary);
    const out = c.outs[0];
    const st = Object.fromEntries((out?.updates ?? []).map((x) => [x.kb ?? x.updateId, x.state]));
    check(c.delivered.length === 1 && out.outcome === 'restart_required' && st.KB5044284 === 'restart_required' && st.KB5044099 === 'installed', 'the canary installs both: the CU needs a restart, .NET does not', JSON.stringify(out));
    check(wuaNow(canary).rebootRequired === true, 'the computer was not restarted: its restart is still pending');
    const d = (await req('GET', `/patching/deployments/${dep.id}`, { s: S.owen, business: acme.id })).body.data;
    const m = Object.fromEntries(d.rings[0].computers[0].updates.map((x) => [x.key, x.state]));
    check(d.rings[0].gate.reason === 'canary_not_effective' && m[key(CU)] === 'restart_required' && m[key(NET)] === 'installed', 'until the canary restarts, the CU is "restart required", .NET "installed" (not yet confirmed), and the gate holds', JSON.stringify(d.rings[0].gate) + JSON.stringify(m));
    const blocked = await req('POST', `/patching/deployments/${dep.id}/rings/1/request`, { s: S.owen, business: acme.id, body: { reason: 'impatient' } });
    check(blocked.status === 409 && /canary/.test(JSON.stringify(blocked.body)), 'ring 1 is refused while the canary has not confirmed', msg(blocked));
    const replay = runAgent(canary, canaryJob.id, c.delivered[0].envelope);
    check(replay.outcome === 'restart_required' && wuaNow(canary).history.length === 2, 'a re-delivered canary envelope is answered from the journal; Windows Update is not asked again', JSON.stringify({ replay, h: wuaNow(canary).history.length }));
  }

  section('Restart, rescan: effective. The gate opens.');
  {
    restart(canary);
    await heartbeat(canary, { patchPosture: scan(canary) });
    const d = (await req('GET', `/patching/deployments/${dep.id}`, { s: S.owen, business: acme.id })).body.data;
    const m = Object.fromEntries(d.rings[0].computers[0].updates.map((x) => [x.key, x.state]));
    check(m[key(CU)] === 'effective' && d.rings[0].gate.ok && d.next.ring === 1 && d.next.canRequest, 'after the restart, a later scan confirms both effective; ring 1 may be requested', JSON.stringify(d.rings[0].gate) + JSON.stringify(d.next));
  }

  section('Ring 1: three computers, one plan, one approval');
  let ring1;
  {
    // R1-B's installer will die half-way.
    setWUA(r1b, (w) => { w.fail = 'install_crash'; });
    const r = await req('POST', `/patching/deployments/${dep.id}/rings/1/request`, { s: S.owen, business: acme.id, body: { reason: 'canary good' } });
    ring1 = r.body?.data?.job;
    check(r.status === 201 && ring1?.targets.length === 3 && ring1.approvalsRequired === 2, 'ring 1 is ONE signed plan naming three computers', msg(r));
    const page = await (await fetch(ring1.approvalUrl)).text();
    check(page.includes('3 computers') && page.includes('R1-A') && page.includes('R1-C') && page.includes('ring 1'), 'the approvers see every computer in the ring');
    await approve(ring1.id, pk.olivia); await approve(ring1.id, pk.quinn);
    const a = await cycle(r1a), b = await cycle(r1b), c = await cycle(r1c);
    check(a.outs[0]?.outcome === 'restart_required', 'R1-A: installed, restart required', JSON.stringify(a.outs[0]));
    const bst = Object.fromEntries((b.outs[0]?.updates ?? []).map((x) => [x.kb ?? x.updateId, x.state]));
    check(b.outs[0]?.outcome === 'uncertain' && bst.KB5044284 === 'unknown', 'R1-B: the installer died — "uncertain", never "failed"; what it installed is not known', JSON.stringify(b.outs[0]));
    const cst = (c.outs[0]?.updates ?? []).find((x) => x.kb === 'KB5044284');
    check(c.outs[0]?.outcome === 'partial' && cst?.state === 'failed' && cst.hresult === '0x80240022', 'R1-C: the CU failed with Windows\' own HRESULT; .NET installed (partial)', JSON.stringify(c.outs[0]));
    const j = await prisma.actionJob.findUnique({ where: { id: ring1.id }, include: { targets: true } });
    check(j.status === 'UNKNOWN' && j.targets.find((t) => t.endpointId === r1b.id).status === 'UNKNOWN', 'the ring plan is UNKNOWN while one computer is uncertain', j.status);
    const d = (await req('GET', `/patching/deployments/${dep.id}`, { s: S.owen, business: acme.id })).body.data;
    check(d.rings[1].gate.reason === 'unreconciled', 'the gate holds until a person reconciles R1-B', JSON.stringify(d.rings[1].gate));
    const noTarget = await req('POST', `/actions/${ring1.id}/reconcile`, { s: S.owen, business: acme.id, body: { found: 'not_installed', note: 'checked' } });
    check(noTarget.status === 400, 'reconciling a ring plan names the computer', msg(noTarget));
    const rec = await req('POST', `/actions/${ring1.id}/reconcile`, { s: S.owen, business: acme.id, body: { found: 'not_installed', note: 'Settings > Update history shows KB5044284 failed to install', endpointId: r1b.id } });
    check(rec.status === 200, 'Owen reconciles R1-B after looking at it (the agent answered, so it cannot run again)', msg(rec));
    const d2 = (await req('GET', `/patching/deployments/${dep.id}`, { s: S.owen, business: acme.id })).body.data;
    check(d2.status === 'PAUSED' && d2.rings[1].gate.reason === 'too_many_failures', 'two failed computers > threshold 0: the deployment pauses itself', JSON.stringify({ s: d2.status, g: d2.rings[1].gate }));
    const r1cRow = d2.rings[1].computers.find((x) => x.hostname === 'R1-C');
    check(r1cRow.updates.find((x) => x.key === key(CU)).state === 'failed' && /0x80240022/.test(r1cRow.updates.find((x) => x.key === key(CU)).detail), 'the matrix shows R1-C\'s CU failed, with the HRESULT');
    const r1bRow = d2.rings[1].computers.find((x) => x.hostname === 'R1-B');
    check(r1bRow.updates.find((x) => x.key === key(NET)).state !== 'effective', 'R1-B\'s already-installed .NET is not claimed effective from an uncertain run');
  }

  section('Resume, retry what failed, and a computer whose identity changed');
  {
    const res = await req('POST', `/patching/deployments/${dep.id}/resume`, { s: S.owen, business: acme.id, body: { reason: 'R1-C has a known issue; retry without it' } });
    check(res.status === 200 && res.body.data.status === 'ACTIVE' && res.body.data.next.ring === 1 && res.body.data.next.canRequest, 'resumed: ring 1 can be retried — never promoted past', msg(res));
    const again = await req('GET', `/patching/deployments/${dep.id}`, { s: S.owen, business: acme.id });
    check(again.body.data.status === 'ACTIVE', 'resuming does not immediately re-pause over the same ring plan');
    setWUA(r1b, (w) => { delete w.fail; });
    const r = await req('POST', `/patching/deployments/${dep.id}/rings/1/request`, { s: S.owen, business: acme.id, body: { reason: 'retry', exclude: [{ endpointId: r1c.id, why: 'vendor ticket open for KB5044284 on this model' }] } });
    const retry = r.body?.data?.job;
    check(r.status === 201 && retry.targets.length === 2, 'retry names R1-A and R1-B; R1-C is left out with a reason', msg(r));
    await approve(retry.id, pk.olivia); await approve(retry.id, pk.quinn);
    // R1-B re-enrolled between approval and delivery.
    const newSecret = randomBytes(24).toString('hex');
    await prisma.rustdeskNode.update({ where: { endpointId: r1b.id }, data: { agentSecretHash: sha(newSecret) } });
    const hbB = await heartbeat({ ...r1b, secret: newSecret });
    check(hbB.status < 300 && !(hbB.body?.data?.actions ?? []).some((x) => x.jobId === retry.id), 'R1-B\'s identity changed since approval: it is not delivered to', msg(hbB));
    const t = await prisma.actionTarget.findUnique({ where: { jobId_endpointId: { jobId: retry.id, endpointId: r1b.id } } });
    check(t.status === 'CANCELED' && t.statusReason === 'device_identity_changed', 'that one computer is canceled (device_identity_changed); the rest of the ring proceeds', JSON.stringify(t));
    const a = await cycle(r1a);
    check(a.outs[0]?.outcome === 'no_change', 'R1-A has both already: no change', JSON.stringify(a.outs[0]));
    const d = (await req('GET', `/patching/deployments/${dep.id}`, { s: S.owen, business: acme.id })).body.data;
    check(d.status === 'COMPLETED', 'the last ring passed: the deployment is complete', JSON.stringify({ s: d.status, g: d.rings[1].gate, n: d.next }));
  }

  section('A compromised database cannot add a computer to a ring');
  {
    const row = await prisma.actionJob.findUnique({ where: { id: ring1.id } });
    const plan = JSON.parse(Buffer.from(row.envelope.plan, 'base64').toString('utf8'));
    const extra = { endpointId: wsus.id, businessId: acme.id, businessName: plan.targets[0].businessName, hostname: 'WSUS-PC', deviceClass: 'WORKSTATION', rustdeskId: wsus.rid, deviceSecretSha256: sha(wsus.secret) };
    const tampered = { ...row.envelope, plan: Buffer.from(JSON.stringify({ ...plan, targets: [...plan.targets, extra] })).toString('base64') };
    const out = runAgent(wsus, ring1.id, tampered);
    check(out.outcome === 'refused' && out.reason === 'bad_signature' && wuaNow(wsus).installed.length === 0, 'a ring plan edited to add WSUS-PC: bad_signature, nothing installed', JSON.stringify(out));
    const asIs = runAgent(birchPc, ring1.id, row.envelope);
    check(asIs.outcome === 'refused' && asIs.reason === 'wrong_target', 'the genuine ring plan, handed to a computer it does not name (Birch\'s): wrong_target', JSON.stringify(asIs));
  }

  section('Cancel');
  {
    const r = await req('POST', '/patching/deployments', { s: S.owen, business: acme.id, body: { ...good, name: 'To cancel', updates: [id(CU)], rings: [[r1c.id]] } });
    const d = r.body.data;
    const rr = await req('POST', `/patching/deployments/${d.id}/rings/0/request`, { s: S.owen, business: acme.id, body: { reason: 'will cancel' } });
    const c = await req('POST', `/patching/deployments/${d.id}/cancel`, { s: S.owen, business: acme.id, body: { reason: 'wrong update' } });
    const j = await prisma.actionJob.findUnique({ where: { id: rr.body.data.job.id } });
    check(c.status === 200 && c.body.data.status === 'CANCELED' && j.status === 'CANCELED', 'canceling the deployment cancels its plan awaiting approval', msg(c));
    const hb = await heartbeat(r1c);
    check(!(hb.body?.data?.actions ?? []).length, 'and nothing is delivered');
  }
}

async function cleanup() {
  await stop('api'); await stop('signer');
  try {
    if (created.businesses.length) {
      await prisma.actionJob.deleteMany({ where: { customerId: { in: created.businesses } } });
      await prisma.patchDeployment.deleteMany({ where: { customerId: { in: created.businesses } } });
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
