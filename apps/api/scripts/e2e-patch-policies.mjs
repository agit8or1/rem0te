#!/usr/bin/env node
/**
 * End-to-end proof of automatic patch policies and of installing from one
 * computer's Patches tab (v0.32).
 *
 *   - "Install updates" on one computer becomes a one-computer deployment
 *     that still needs two approvals, and runs to effective;
 *   - a computer that cannot be patched gets no button, and says why;
 *   - a bounded patch policy is approved once, by two people, on the
 *     approval signer;
 *   - the portal's sweep proposes the canary inside the open window, the
 *     signer signs it under the policy, the agent installs only what the
 *     policy allows;
 *   - after the canary is confirmed effective, the next ring is signed
 *     automatically — and no earlier;
 *   - plans a compromised portal might send are refused by the signer: a
 *     widened ring, a disallowed class, outside the window, the canary
 *     skipped or not yet effective, an altered policy digest, an expired
 *     policy, a revoked policy, a containment pause;
 *   - a restart of the API proposes nothing twice;
 *   - 0.34: each computer signs its results and scans with its own key; the
 *     policy binds those keys and the signer pins them on approval; a
 *     canary success the portal forges (its own key, an edited statement,
 *     another computer's genuine result, or no signature at all) is refused,
 *     and the genuine one opens ring 1. A computer whose results would open
 *     a ring but cannot sign them is refused at policy creation.
 *
 * Self-contained, like e2e-staged-patching.mjs: its own signed repository,
 * signer (ports 3262/3263) and API from dist (port 3261, sweep every 2 s),
 * against a scratch database, with fixtures removed afterwards.
 *
 *   cd apps/api && npx nest build
 *   RELEASE_BIN=/tmp/rem0te-release ACTION_SIM=/tmp/rem0te-action-sim \
 *   DATABASE_URL=postgresql://…/reboot_remote_it_scratch node scripts/e2e-patch-policies.mjs
 *
 * FIXTURE-TESTED: no Windows, no real Windows Update, no real authenticator.
 */
import { Prisma, PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { syntheticPasskey } from './lib/synthetic-passkey.mjs';
import { deviceKey, signStatement } from './lib/device-sign.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const require = createRequire(import.meta.url);
const pp = require(path.join(dist, 'actions', 'patch-policy.js'));

const DB = process.env.DATABASE_URL ?? '';
const dbName = DB.split('/').pop()?.split('?')[0] ?? '';
if (!/scratch|test/.test(dbName)) { console.error(`Refusing to run against database "${dbName}": name must contain "scratch" or "test".`); process.exit(2); }
const BIN = process.env.RELEASE_BIN, SIM = process.env.ACTION_SIM;
if (!BIN || !SIM) { console.error('RELEASE_BIN (rem0te-release) and ACTION_SIM (rem0te-action-sim) are required'); process.exit(2); }
const PORT = Number(process.env.POLICY_API_PORT ?? 3261);
const SIGNER_PUBLIC = Number(process.env.POLICY_SIGNER_PUBLIC_PORT ?? 3262);
const SIGNER_INTERNAL = Number(process.env.POLICY_SIGNER_INTERNAL_PORT ?? 3263);
if ([PORT, SIGNER_PUBLIC, SIGNER_INTERNAL].some((p) => [3000, 3001, 443, 3201, 3202].includes(p))) { console.error('refusing a production port'); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
const ORIGIN = `http://127.0.0.1:${SIGNER_PUBLIC}`;
const INTERNAL = `http://127.0.0.1:${SIGNER_INTERNAL}`;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'policy-e2e-password-123';

let pass = 0, fail = 0; const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const hex = (n) => randomBytes(n).toString('hex');

// ── Updates as Windows Update describes them ────────────────────────────────
const SEC = '0fa1201d-4330-4fa8-8ae9-b877473b6441', UPD = 'cd5ffd1e-e932-4e3a-bf74-18bf0b1bbd83';
const u = (updateId, revision, kb, title, classification, className, extra = {}) => ({ updateId, revision, kb, title, classification, className, severity: classification === SEC ? 'Critical' : '', downloaded: false, rebootBehavior: 1, userInput: false, eulaAccepted: true, browseOnly: false, sizeBytes: 600 << 20, ...extra });
const CU = u('5a1b2c3d-0000-4000-8000-000000000011', 201, 'KB5046001', '2026-11 Cumulative Update for Windows 11 (KB5046001)', SEC, 'Security Updates');
const NET = u('5a1b2c3d-0000-4000-8000-000000000012', 3, 'KB5046002', '2026-11 .NET Framework update (KB5046002)', UPD, 'Updates', { rebootBehavior: 0 });
/** A plan in any of these never reached a signature (or was stopped before delivery). */
const SIGNED_NOT = ['AWAITING_APPROVAL', 'REJECTED', 'CANCELED', 'EXPIRED'];
const id = (x) => ({ updateId: x.updateId, revision: x.revision });
const key = (x) => `${x.updateId}@${x.revision}`;

// ── The release machine ─────────────────────────────────────────────────────
const work = mkdtempSync(path.join(tmpdir(), 'rem0te-policy-'));
const keys = path.join(work, 'keys'); mkdirSync(keys);
const repo = path.join(work, 'repo');
const files = path.join(work, 'files'); mkdirSync(files);
const signerDir = path.join(work, 'signer'); mkdirSync(signerDir, { mode: 0o700 });
const rel = (...a) => execFileSync(BIN, a, { encoding: 'utf8' });
const signerCli = (args) => spawnSync(process.execPath, [path.join(dist, 'approval-signer', 'main.js'), ...args], { encoding: 'utf8', env: { ...process.env, APPROVAL_SIGNER_DIR: signerDir } });
for (const k of ['r1', 'targets', 'snapshot', 'timestamp']) rel('keygen', '-out', path.join(keys, `${k}.pem`));
rel('init', '-repo', repo, '-root-key', path.join(keys, 'r1.pem'), '-root-threshold', '1', '-targets-key', path.join(keys, 'targets.pem'), '-snapshot-key', path.join(keys, 'snapshot.pem'), '-timestamp-key', path.join(keys, 'timestamp.pem'));
const agentBin = Buffer.concat([Buffer.from('MZ stand-in signed agent 0.32 '), randomBytes(64), Buffer.from('REM0TE_INST_URL:'), Buffer.alloc(240)]);
writeFileSync(path.join(files, 'agent.exe'), agentBin);
const AGENT_SHA = sha(agentBin);
const kg = signerCli(['keygen']);
if (kg.status !== 0) throw new Error(`signer keygen: ${kg.stderr}`);
const keysFile = path.join(files, 'approval-keys.json');
writeFileSync(keysFile, kg.stdout);
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
  APPROVAL_SIGNER_INTERNAL_URL: INTERNAL,
  JWT_SECRET: randomBytes(32).toString('hex'), LAUNCHER_TOKEN_SECRET: randomBytes(32).toString('hex'),
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? randomBytes(32).toString('hex'), TRUSTED_PROXIES: 'loopback',
  VERSION_FILE: path.resolve(here, '..', '..', '..', 'version.json'),
  // This suite tests the sweep: on, and fast. Monitoring stays off.
  PATCH_POLICY_SWEEP: 'on', PATCH_POLICY_SWEEP_SECONDS: '2', MONITOR_SWEEP: 'off',
};
async function waitUp(url, name) {
  for (let i = 0; i < 120; i++) { try { const r = await fetch(url); if (r.status < 500) return; } catch { /* not yet */ } await sleep(300); }
  throw new Error(`${name} did not come up:\n${kids[name]?.log.slice(-3000)}`);
}

// ── HTTP (paced under the 20 req/s burst throttler) ─────────────────────────
async function req(method, p, { s, body, business } = {}) {
  await sleep(60);
  const h = { 'content-type': 'application/json', 'x-forwarded-for': s?.ip ?? ip() };
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
const post = (url, body) => sj(url, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify(body) });
async function approveJob(jobId, who) {
  const c = await post(`${ORIGIN}/approve/${jobId}/challenge`, { decision: 'approve', role: 'approver' });
  if (c.status !== 200) return c;
  return post(`${ORIGIN}/approve/${jobId}/decide`, { challengeId: c.body.challengeId, assertion: who.assert(c.body.options, { origin: ORIGIN }) });
}
async function approvePolicy(pid, who) {
  const c = await post(`${ORIGIN}/approve/policy/${pid}/challenge`, { decision: 'approve', role: 'approver' });
  if (c.status !== 200) return c;
  return post(`${ORIGIN}/approve/policy/${pid}/decide`, { challengeId: c.body.challengeId, assertion: who.assert(c.body.options, { origin: ORIGIN }) });
}
/** What a compromised portal can do: post any plan it likes to the signer's internal policy route. */
const underPolicy = (pid, body) => sj(`${INTERNAL}/internal/v1/policies/${pid}/plans`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
async function until(what, f, ms = 30_000) {
  const t0 = Date.now();
  for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(500); }
}

// ── A simulated computer ────────────────────────────────────────────────────
const ACTIONS = ['windows.service.start@1', 'windows.update.install@1'];
// 0.36: '-portal': the agent fetches the signer's revocation statement from the portal's relay before each job.
function sim(pc, args) { return execFileSync(SIM, ['-wua', pc.wua, '-registry', pc.reg, '-portal', `127.0.0.1:${PORT}`, ...args], { encoding: 'utf8' }); }
// 0.34: the sim signs the scan with the computer's own key, kept in its state directory, as patch-scan does.
const scan = (pc) => JSON.parse(sim(pc, ['-scan', '-state', pc.state, '-rustdesk-id', pc.rid, '-secret', pc.secret]).trim());
const unsignedScan = (pc) => { const p = scan(pc); delete p.signed; return p; };
const resultKeyOf = (pc) => JSON.parse(execFileSync(SIM, ['-result-key', '-state', pc.state], { encoding: 'utf8' }).trim());
const restart = (pc) => sim(pc, ['-restart']);
const wuaNow = (pc) => JSON.parse(readFileSync(pc.wua, 'utf8'));
const heartbeat = (pc, extra = {}) => req('POST', '/enrollment/heartbeat', {
  body: { rustdeskId: pc.rid, agentSecret: pc.secret, hostname: pc.hostname, platform: 'Windows', updateChannel: pc.channel ?? 'signed', agentActions: ACTIONS, agentSha256: AGENT_SHA, ...extra },
});
function resultsOf(pc) {
  const d = path.join(pc.state, 'actions', 'results');
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => /^[0-9a-f]{32}\.json$/.test(f)).map((f) => JSON.parse(readFileSync(path.join(d, f), 'utf8')));
}
function clearAcked(pc, acks) { for (const a of acks ?? []) rmSync(path.join(pc.state, 'actions', 'results', `${a}.json`), { force: true }); }
function runAgent(pc, jobId, envelope) {
  const envFile = path.join(work, `env-${jobId}-${hex(3)}.json`);
  writeFileSync(envFile, JSON.stringify(envelope));
  const out = sim(pc, ['-state', pc.state, '-keys', keysFile, '-job', jobId, '-envelope', envFile, '-rustdesk-id', pc.rid, '-secret', pc.secret, '-product-type', '1', '-self-sha', AGENT_SHA]);
  return JSON.parse(out.trim());
}
async function cycle(pc) {
  const hb = await heartbeat(pc, { patchPosture: scan(pc) });
  const got = hb.body?.data?.actions ?? [];
  const outs = got.map((d) => runAgent(pc, d.jobId, d.envelope));
  const hb2 = await heartbeat(pc, { actionResults: resultsOf(pc), patchPosture: scan(pc) });
  clearAcked(pc, hb2.body?.data?.actionAcks);
  return { delivered: got, outs };
}
/** A later scan, strictly after the result, so the gate can call it effective. */
async function rescan(pc) { await sleep(1100); return heartbeat(pc, { patchPosture: scan(pc) }); }

const created = { businesses: [], users: [] };

/** A plan as the portal would build it, from a stored one: a new job id, a new window, anything else overridden. */
function craft(base, over = {}) {
  const now = Date.now();
  return {
    ...base, jobId: hex(16), createdAt: new Date(now).toISOString(),
    window: { notBefore: new Date(now).toISOString(), notAfter: new Date(now + 3600_000).toISOString() },
    ...over,
  };
}

async function all() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });
  const leftovers = await prisma.patchPolicy.count({ where: { status: { in: ['ACTIVE', 'AWAITING_APPROVAL'] } } });
  if (leftovers) throw new Error(`refusing: this database already has ${leftovers} live patch polic(y/ies), and this suite runs the sweep, which acts on all of them`);

  section('Fixtures (synthetic): Acme with a canary, a ring of two, one outsider, one manual, one standard-agent PC');
  const acme = await prisma.customer.create({ data: { tenantId: tenant.id, name: `PP Acme ${sfx}` } });
  created.businesses.push(acme.id);
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag, extra = {}) => { const x = await prisma.user.create({ data: { email: `pp-${tag}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'PP', lastName: tag, status: 'ACTIVE', ...extra } }); created.users.push(x.id); return x; };
  const owen = await mkUser('owen-owner'), adam = await mkUser('adam-admin', { isPlatformAdmin: true });
  const olivia = await mkUser('olivia-approver', { platformPermissions: ['technicians:manage'] }), quinn = await mkUser('quinn-approver', { platformPermissions: ['technicians:manage'] });
  await prisma.membership.create({ data: { userId: owen.id, tenantId: tenant.id, customerId: acme.id, roleId: roleOwner.id, capabilities: [] } });

  const mkPc = async (hostname, offered, wuaExtra = {}, channel = 'signed', extra = {}) => {
    const e = await prisma.endpoint.create({ data: { tenantId: tenant.id, customerId: acme.id, name: hostname, hostname, status: 'ACTIVE', isOnline: true, isManaged: true, accessMode: 'COMPANY_WIDE', lastSeenAt: new Date(), deviceClass: 'WORKSTATION', ...extra } });
    const rid = String(100000000 + ((Math.random() * 899999999) | 0));
    const secret = hex(24);
    await prisma.rustdeskNode.create({ data: { tenantId: tenant.id, endpointId: e.id, rustdeskId: rid, agentSecretHash: sha(secret) } });
    const state = path.join(work, `pc-${e.id}`); mkdirSync(state);
    const pc = { id: e.id, rid, secret, state, hostname, channel, wua: path.join(state, 'wua.json'), reg: path.join(state, 'registry.json') };
    writeFileSync(pc.wua, JSON.stringify({ offered, installed: [], superseded: [], history: [], ...wuaExtra }));
    writeFileSync(pc.reg, JSON.stringify({}));
    return pc;
  };
  const restartCU = { results: { [key(CU)]: { resultCode: 2, rebootRequired: true, hresult: '0x00000000' } } };
  const canary = await mkPc('PP-CANARY', [CU, NET], restartCU);
  const r1a = await mkPc('PP-R1-A', [CU, NET]);
  const r1b = await mkPc('PP-R1-B', [CU]);
  const outsider = await mkPc('PP-OUTSIDER', [CU, NET]);
  const manual = await mkPc('PP-MANUAL', [NET]);
  // A standard-agent Windows computer, as one in the field reports itself (0.34: the
  // Patches tab's remedy is the Agent card's upgrade, which needs Windows).
  const std = await mkPc('PP-STANDARD', [CU], {}, 'standard', { platform: 'Windows 11 Pro' });
  check(true, 'six synthetic computers; the canary will need a restart after the CU');

  const pk = { owen: syntheticPasskey({ userId: owen.id, name: 'PP owen' }), olivia: syntheticPasskey({ userId: olivia.id, name: 'PP olivia' }), quinn: syntheticPasskey({ userId: quinn.id, name: 'PP quinn' }) };
  for (const k of Object.values(pk)) await prisma.userMfaMethod.create({ data: { userId: k.userId, type: 'WEBAUTHN', isActive: true, credentialId: k.credentialId, publicKey: Buffer.from(k.publicKey, 'base64url'), signCount: 0, name: 'Test key' } });

  start('signer', path.join(dist, 'approval-signer', 'main.js'), signerEnv);
  start('api', path.join(dist, 'main.js'), apiEnv);
  await waitUp(`${INTERNAL}/internal/v1/keys`, 'signer');
  await waitUp(`${API}/health`, 'api');
  const S = { owen: await login(owen.email), adam: await login(adam.email) };

  section('Pre-flight, before any approver is enrolled');
  {
    const r = await req('GET', '/patching/preflight', { s: S.adam });
    const c = Object.fromEntries((r.body?.data?.checks ?? []).map((x) => [x.id, x]));
    check(r.status === 200 && c.signed_release?.ok && c.signer_configured?.ok && c.signer_reachable?.ok && c.signer_policies?.ok && c.signer_key_published?.ok,
      'pre-flight: a signed release is served, the signer answers, supports policies, and agents trust its key (read from approval/keys.json)', msg(r));
    check(c.approvers?.ok === false && /0 approver/.test(c.approvers.detail) && r.body.data.ready === false, 'pre-flight: no approvers enrolled yet — reported missing, from the signer\'s own roster count', JSON.stringify(c.approvers));
    check(c.sweep?.ok === true && /Every 2 s/.test(c.sweep.detail), 'pre-flight: the sweep is on (every 2 s here)', JSON.stringify(c.sweep));
    const no = await req('GET', '/patching/preflight', { s: S.owen, business: acme.id });
    check(no.status === 403, 'pre-flight is for Platform Admins', msg(no));
  }
  for (const [who, roles] of [['owen', ['--approve', '*']], ['olivia', ['--approve', '*']], ['quinn', ['--approve', acme.id]]]) {
    const s = who === 'owen' ? S.owen : await login(who === 'olivia' ? olivia.email : quinn.email);
    const list = await req('GET', '/auth/passkeys', { s });
    const mine = (list.body?.data ?? list.body ?? [])[0];
    const add = signerCli(['roster', 'add', '--export', mine.approvalExport, ...roles, '--confirm-fingerprint', mine.approvalFingerprint]);
    if (add.status !== 0) throw new Error(`roster add ${who}: ${add.stderr}`);
  }
  {
    const r = await req('GET', '/patching/preflight', { s: S.adam });
    const c = Object.fromEntries((r.body?.data?.checks ?? []).map((x) => [x.id, x]));
    check(c.approvers?.ok === true && /3 approver/.test(c.approvers.detail), 'pre-flight: three approvers once enrolled', JSON.stringify(c.approvers));
  }
  for (const pc of [canary, r1a, r1b, outsider, manual]) await heartbeat(pc, { patchPosture: scan(pc) });
  await heartbeat(std);
  {
    const r = await req('GET', '/patching/preflight', { s: S.adam });
    const c = Object.fromEntries((r.body?.data?.checks ?? []).map((x) => [x.id, x]));
    check(c.computers_signed?.ok && /5 run the published build/.test(c.computers_signed.detail) && c.computers_scanned?.ok, 'pre-flight counts computers on the signed channel, on the published build, with a scan', JSON.stringify(c.computers_signed));
  }

  section('Install updates from one computer\'s Patches tab');
  {
    const v = await req('GET', `/endpoints/${std.id}/patches`, { s: S.owen, business: acme.id });
    const i = v.body?.data?.install;
    check(v.status === 200 && i?.possible === false && /standard agent/.test(i.reason) && i.fixAction === 'agent-card' && /Upgrade to full agent/.test(i.fix), 'a standard-agent computer: no Install button — it says why (standard agent) and what to do (Upgrade to full agent, on the Agent card)', msg(v));
    const r0 = await req('POST', `/endpoints/${std.id}/patches/install`, { s: S.owen, business: acme.id, body: { updates: [id(CU)], reboot: 'never', reason: 'try anyway' } });
    check(r0.status === 409 && code(r0) === 'INSTALL_NOT_POSSIBLE', 'and asking anyway is refused with the same reason', msg(r0));
    const m = await req('GET', `/endpoints/${manual.id}/patches`, { s: S.owen, business: acme.id });
    check(m.body?.data?.install?.possible === true && m.body.data.install.installable === 1, 'a signed, scanned, online computer: Install is offered, with one installable update', msg(m));
    const direct = await req('POST', `/endpoints/${manual.id}/actions`, { s: S.owen, business: acme.id, body: { actionId: 'windows.update.install', version: 1, params: { updates: [id(NET)], reboot: 'never' }, reason: 'direct' } });
    check(direct.status === 400 && code(direct) === 'ACTION_NOT_DIRECT', 'ACTION_NOT_DIRECT still holds on the Actions tab', msg(direct));
    const rb = await req('POST', `/endpoints/${manual.id}/patches/install`, { s: S.owen, business: acme.id, body: { updates: [id(NET)], reboot: 'if_required', reason: 'with a restart' } });
    check(rb.status === 400, 'a restart rule outside the closed pair ("never" | "if_required_in_window") is refused', msg(rb));
    const r = await req('POST', `/endpoints/${manual.id}/patches/install`, { s: S.owen, business: acme.id, body: { updates: [id(NET)], reboot: 'never', reason: 'user reports .NET app crash' } });
    const job = r.body?.data?.job, dep = r.body?.data?.deployment;
    check(r.status === 201 && job?.status === 'AWAITING_APPROVAL' && job.approvalsRequired === 2 && job.targets.length === 1, 'Install becomes one plan for one computer, awaiting TWO approvals', msg(r));
    check(dep?.origin === 'MANUAL' && dep.rings.length === 1 && dep.rings[0].canary, 'it is a one-computer deployment: a single canary ring, origin MANUAL', JSON.stringify({ o: dep?.origin, r: dep?.rings?.length }));
    const again = await req('GET', `/endpoints/${manual.id}/patches`, { s: S.owen, business: acme.id });
    check(again.body?.data?.install?.possible === false && /already been requested/.test(again.body.data.install.reason), 'while it awaits approval, no second Install button — it says why', JSON.stringify(again.body?.data?.install));
    const self = await approveJob(job.id, pk.owen);
    check(self.status >= 400 && /requester/.test(JSON.stringify(self.body)), 'the requester cannot approve it', JSON.stringify(self.body));
    await approveJob(job.id, pk.olivia);
    check(!((await heartbeat(manual)).body?.data?.actions ?? []).length, 'one approval delivers nothing');
    await approveJob(job.id, pk.quinn);
    const c = await cycle(manual);
    check(c.outs[0]?.outcome === 'success' || c.outs[0]?.updates?.[0]?.state === 'installed', 'after two approvals the agent installs it', JSON.stringify(c.outs[0]));
    await rescan(manual);
    const d = (await req('GET', `/patching/deployments/${dep.id}`, { s: S.owen, business: acme.id })).body?.data;
    check(d?.status === 'COMPLETED' && d.rings[0].computers[0].updates[0].state === 'effective', 'a later scan confirms it effective; the one-computer deployment completes', JSON.stringify({ s: d?.status, u: d?.rings?.[0]?.computers?.[0]?.updates }));
  }

  section('A patch policy: proposed here, approved once on the signer');
  const now = new Date();
  const hhmm = (t) => `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`;
  const window = { days: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'], start: hhmm(new Date(now.getTime() - 3600_000)), end: hhmm(new Date(now.getTime() + 3 * 3600_000)), timezone: 'UTC' };
  const body = { businessId: acme.id, name: 'Acme security, nightly', rings: [[canary.id], [r1a.id, r1b.id]], allow: { classifications: [SEC], severities: ['Critical', 'Important'] }, soakHours: 0, failureThreshold: 0, window, expiresInDays: 30, reason: 'Security updates without a ticket per night' };
  let pol;
  {
    let r = await req('POST', '/patching/policies', { s: S.owen, business: acme.id, body });
    check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED', 'creating a policy needs a fresh sign-in', msg(r));
    S.owenF = await stepUp(S.owen);
    r = await req('POST', '/patching/policies', { s: S.owenF, business: acme.id, body: { ...body, rings: [[canary.id, r1a.id]] } });
    check(r.status === 400 && code(r) === 'BAD_RINGS', 'ring 0 is the canary: exactly one computer', msg(r));
    r = await req('POST', '/patching/policies', { s: S.owenF, business: acme.id, body: { ...body, expiresInDays: 91 } });
    check(r.status === 400, 'an expiry beyond 90 days is refused', msg(r));
    r = await req('POST', '/patching/policies', { s: S.owenF, business: acme.id, body: { ...body, reboot: 'always' } });
    check(r.status === 400, 'a policy restart rule outside the closed pair is refused', msg(r));
    r = await req('POST', '/patching/policies', { s: S.owenF, business: acme.id, body: { ...body, allow: { classifications: ['ebfc1fc5-71a4-4f7b-9aca-3b9a503104a0'] } } });
    check(r.status === 400, 'drivers are not a class a policy can allow', msg(r));
    // 0.34, fail closed: a canary whose agent cannot sign its results (its latest scan is unsigned, as from a 0.33 agent).
    await sleep(1100); await heartbeat(outsider, { patchPosture: unsignedScan(outsider) });
    r = await req('POST', '/patching/policies', { s: S.owenF, business: acme.id, body: { ...body, rings: [[outsider.id], [r1a.id, r1b.id]] } });
    check(r.status === 409 && code(r) === 'RESULT_KEY_MISSING' && /0\.34/.test(JSON.stringify(r.body)), 'a canary that cannot sign its results is refused: RESULT_KEY_MISSING (fail closed)', msg(r));
    r = await req('POST', '/patching/policies', { s: S.owenF, business: acme.id, body: { ...body, rings: [[canary.id], [outsider.id], [r1a.id, r1b.id]] } });
    check(r.status === 409 && code(r) === 'RESULT_KEY_MISSING' && /PP-OUTSIDER/.test(JSON.stringify(r.body)), '…and so is one in a middle ring, whose results open the next ring', msg(r));
    await sleep(1100); await heartbeat(outsider, { patchPosture: scan(outsider) });
    r = await req('POST', '/patching/policies', { s: S.owenF, business: acme.id, body });
    pol = r.body?.data;
    check(r.status === 201 && pol?.status === 'AWAITING_APPROVAL' && /\/approve\/policy\/[0-9a-f]{32}$/.test(pol.approvalUrl), 'the policy is proposed and awaits approval on the signer', msg(r));
    const page = await (await fetch(pol.approvalUrl)).text();
    check(page.includes('PP-CANARY') && page.includes('PP-R1-B') && page.includes('Security Updates') && page.includes('UTC'), 'the signer\'s approval page shows its computers, classes and window', page.slice(0, 200));
    // 0.34: the key the policy binds is the one the computer itself reports (rem0te-agent.exe status).
    const own = resultKeyOf(canary);
    check(pol.document.rings[0][0].resultKey === own.publicKey && pol.document.rings[1].every((c) => !!c.resultKey), 'the policy binds each computer to the result key its own signed scans name', JSON.stringify(pol.document.rings[0][0]));
    check(page.includes(own.fingerprint) && /first time this signer sees it/.test(page), 'the approval page shows the canary\'s key fingerprint — the same one the computer\'s own status shows — as first seen', own.fingerprint);
    check(pol.resultKeys?.[canary.id] === own.fingerprint, 'the portal\'s policy page shows the same fingerprint', JSON.stringify(pol.resultKeys));
    await sleep(2500);
    check((await prisma.patchDeployment.count({ where: { policyId: pol.id } })) === 0, 'an unapproved policy proposes nothing, though its window is open');
    const self = await approvePolicy(pol.id, pk.owen);
    check(self.status >= 400, 'its author cannot approve it', JSON.stringify(self.body));
    const a1 = await approvePolicy(pol.id, pk.olivia);
    check(a1.status === 200 && a1.body.status === 'AWAITING_APPROVAL', 'one approval is not enough', JSON.stringify(a1.body).slice(0, 200));
    const a2 = await approvePolicy(pol.id, pk.quinn);
    check(a2.status === 200 && a2.body.status === 'ACTIVE', 'two approvals: the signer signs the policy and it is ACTIVE', JSON.stringify(a2.body).slice(0, 200));
    const list = signerCli(['patch-policy', 'list']);
    check(list.status === 0 && list.stdout.includes(pol.id) && /ACTIVE/.test(list.stdout) && /signature ok|verified/i.test(list.stdout), 'the signer operator\'s CLI lists it ACTIVE with a verified signature', list.stdout.slice(0, 300) + list.stderr);
    const pins = signerCli(['device-key', 'list']);
    check(pins.status === 0 && [canary, r1a, r1b].every((pc) => pins.stdout.includes(pc.id)) && pins.stdout.includes(resultKeyOf(canary).fingerprint), 'approving it pinned each computer\'s result key on the signer (device-key list)', pins.stdout + pins.stderr);
  }

  section('The sweep proposes the canary inside the window; the signer signs it under the policy');
  let dep, canaryJob;
  {
    canaryJob = await until('canary', async () => (await prisma.actionJob.findFirst({ where: { deployment: { policyId: pol.id }, ring: 0, status: { notIn: SIGNED_NOT } } })));
    check(!!canaryJob, 'within a few sweeps the canary plan is signed — with no person approving it', canaryJob ? '' : JSON.stringify((await prisma.patchPolicy.findUnique({ where: { id: pol.id } }))?.lastProposal));
    if (!canaryJob) throw new Error('no canary plan; stopping');
    dep = await prisma.patchDeployment.findUnique({ where: { id: canaryJob.deploymentId } });
    const plan = canaryJob.plan;
    check(dep.origin === 'POLICY' && dep.policyId === pol.id && /^\d{4}-\d\d-\d\dT/.test(dep.windowKey), 'its deployment is origin POLICY, keyed to this window', JSON.stringify({ o: dep.origin, k: dep.windowKey }));
    check(plan.display?.policy?.id === pol.id && plan.display.policy.digest === pol.digest, 'the plan names the policy and its digest', JSON.stringify(plan.display?.policy));
    check(JSON.stringify(plan.params.allow?.classifications) === JSON.stringify([SEC]) && JSON.stringify(plan.params.allow?.severities) === JSON.stringify(['Critical', 'Important']) && !plan.params.allow?.excludeKbs && plan.params.reboot === 'never', 'the plan carries the policy\'s filter for the agent to apply, and never restarts', JSON.stringify(plan.params));
    check(plan.params.updates.length === 1 && plan.params.updates[0].updateId === CU.updateId, 'only the CU (Security, Critical): the .NET update (class Updates) is not in it', JSON.stringify(plan.params.updates));
    check(plan.targets.length === 1 && plan.targets[0].endpointId === canary.id, 'it names the canary alone', JSON.stringify(plan.targets.map((t) => t.hostname)));
    const occ = pp.occurrenceAt(new Date(), window);
    check(Date.parse(plan.window.notAfter) <= occ.end.getTime() && Date.parse(plan.window.notBefore) >= occ.start.getTime(), 'its window lies inside the maintenance window', JSON.stringify(plan.window));
    const env = await until('envelope', async () => (await prisma.actionJob.findUnique({ where: { id: canaryJob.id } }))?.envelope);
    const signed = JSON.parse(Buffer.from(env.plan, 'base64').toString('utf8'));
    check(signed.approvers.length === 2 && signed.approvers.every((a) => [olivia.id, quinn.id].includes(a.userId)), 'the signed plan carries the policy\'s two approvers', JSON.stringify(signed.approvers));
    const audit = await prisma.activityLog.findFirst({ where: { action: 'PATCH_POLICY_PROPOSED', resourceId: pol.id } });
    check(!!audit, 'the auto-proposal is audited (PATCH_POLICY_PROPOSED)');
  }

  section('Signer refusals: what a compromised portal might send');
  {
    const base = canaryJob.plan;
    const cDigest = pol.digest;
    const target = (pc, hostname) => ({ ...base.targets[0], endpointId: pc.id, hostname, rustdeskId: pc.rid, deviceSecretSha256: sha(pc.secret) });
    let r = await underPolicy(pol.id, { plan: craft(base, { display: { ...base.display, deployment: { ...base.display.deployment, ring: 1 } }, targets: [target(r1a, 'PP-R1-A'), target(outsider, 'PP-OUTSIDER')] }), policyDigest: cDigest, evidence: null });
    check(r.status === 409 && r.body?.error === 'computer_not_in_policy', 'a ring widened with a computer the policy does not name → computer_not_in_policy', JSON.stringify(r.body));
    r = await underPolicy(pol.id, { plan: craft(base, { targets: [target(outsider, 'PP-OUTSIDER')] }), policyDigest: cDigest, evidence: null });
    check(r.status === 409 && r.body?.error === 'computer_not_in_policy', 'the canary swapped for another computer → computer_not_in_policy', JSON.stringify(r.body));
    const netShown = { updateId: NET.updateId, revision: NET.revision, kb: NET.kb, title: NET.title, className: 'Updates', severity: null };
    r = await underPolicy(pol.id, { plan: craft(base, { params: { ...base.params, updates: [...base.params.updates, id(NET)] }, display: { ...base.display, updates: [...base.display.updates, netShown] } }), policyDigest: cDigest, evidence: null });
    check(r.status === 409 && r.body?.error === 'class_not_allowed', 'a class the policy does not allow (.NET, "Updates") → class_not_allowed', JSON.stringify(r.body));
    r = await underPolicy(pol.id, { plan: craft(base, { params: { ...base.params, allow: { classifications: [SEC, UPD] } } }), policyDigest: cDigest, evidence: null });
    check(r.status === 409 && r.body?.error === 'filter_mismatch', 'a plan carrying a wider filter for the agent → filter_mismatch', JSON.stringify(r.body));
    const late = Date.now() + 5 * 3600_000;
    r = await underPolicy(pol.id, { plan: craft(base, { window: { notBefore: new Date(late).toISOString(), notAfter: new Date(late + 3600_000).toISOString() } }), policyDigest: cDigest, evidence: null });
    check(r.status === 409 && r.body?.error === 'outside_window', 'a plan outside the maintenance window → outside_window', JSON.stringify(r.body));
    r = await underPolicy(pol.id, { plan: craft(base), policyDigest: 'f'.repeat(64), evidence: null });
    check(r.status === 409 && r.body?.error === 'policy_digest_mismatch', 'an altered policy digest → policy_digest_mismatch', JSON.stringify(r.body));
    r = await underPolicy(pol.id, { plan: craft(base, { display: { ...base.display, deployment: { ...base.display.deployment, id: `skip${hex(6)}`, ring: 1 } }, targets: [target(r1a, 'PP-R1-A')] }), policyDigest: cDigest, evidence: null });
    check(r.status === 409 && r.body?.error === 'ring_out_of_order', 'ring 1 of a deployment whose canary was never signed → ring_out_of_order (the canary cannot be skipped)', JSON.stringify(r.body));
    r = await underPolicy(pol.id, { plan: craft(base), policyDigest: cDigest, evidence: null });
    check(r.status === 409 && r.body?.error === 'ring_already_signed', 'the canary again while its window is open → ring_already_signed', JSON.stringify(r.body));
    r = await underPolicy(pol.id, { plan: craft(base, { requestedBy: { ...base.requestedBy, userId: olivia.id } }), policyDigest: cDigest, evidence: null });
    check(r.status === 409 && r.body?.error === 'requester_mismatch', 'a plan requested as someone other than the policy\'s author → requester_mismatch', JSON.stringify(r.body));
    // 0.34: the policy says never; a plan may not ask for a restart under it.
    r = await underPolicy(pol.id, { plan: craft(base, { params: { ...base.params, reboot: 'if_required_in_window' } }), policyDigest: cDigest, evidence: null });
    check(r.status === 409 && r.body?.error === 'reboot_not_allowed', 'the policy forbids restarts; a plan asking to restart in its window → reboot_not_allowed', JSON.stringify(r.body));
    r = await underPolicy(pol.id, { plan: craft(base, { params: { ...base.params, reboot: 'always' } }), policyDigest: cDigest, evidence: null });
    check(r.status >= 400 && r.status < 500 && r.body?.error !== undefined && !r.body?.jobId, 'a restart rule outside the closed pair is refused outright', JSON.stringify(r.body));
    const st = await sj(`${INTERNAL}/internal/v1/policies/${pol.id}`);
    check(st.body?.refusals?.length >= 5, 'the signer keeps each refusal with the policy (for its operator and the portal)', JSON.stringify(st.body?.refusals?.length));
  }

  section('Canary: installs only what the policy allows; ring 1 waits for it to be effective');
  {
    const c = await cycle(canary);
    const st = Object.fromEntries((c.outs[0]?.updates ?? []).map((x) => [x.kb ?? x.updateId, x.state]));
    check(c.delivered.length === 1 && st.KB5046001 === 'restart_required' && !st.KB5046002, 'the canary installs the CU (restart required) and not .NET', JSON.stringify(c.outs[0]));
    check(!wuaNow(canary).installed.some((x) => x.updateId === NET.updateId) && wuaNow(canary).rebootRequired === true, 'Windows Update shows .NET untouched, and no restart was made');
    await sleep(4500);
    check(!(await prisma.actionJob.findFirst({ where: { deploymentId: dep.id, ring: 1 } })), 'with the CU not yet effective, the sweep does not request ring 1');
    // A compromised portal sends ring 1 anyway, with honest evidence: refused.
    const row = await prisma.actionJob.findUnique({ where: { id: canaryJob.id }, include: { targets: true } });
    const inv = await prisma.endpointInventory.findUnique({ where: { endpointId: canary.id } });
    const t = row.targets[0];
    const ev = { previousJobId: row.id, jobStatus: row.status, targets: [pp.toEvidenceTarget({ endpointId: t.endpointId, status: t.status, statusReason: t.statusReason, reconciled: !!t.reconciledAt, reconcileNote: t.reconcileNote, resultAt: t.resultAt, result: t.result, scan: inv.patchPosture }, row.plan.params.updates)] };
    const ring1 = craft(row.plan, { display: { ...row.plan.display, deployment: { ...row.plan.display.deployment, ring: 1 } }, targets: [
      { ...row.plan.targets[0], endpointId: r1a.id, hostname: 'PP-R1-A', rustdeskId: r1a.rid, deviceSecretSha256: sha(r1a.secret) },
    ] });
    const r = await underPolicy(pol.id, { plan: ring1, policyDigest: pol.digest, evidence: ev });
    check(r.status === 409 && r.body?.error === 'canary_not_effective', 'ring 1 sent before the canary is confirmed → canary_not_effective (the signer re-runs the gate)', JSON.stringify(r.body));

    // 0.34: the portal stores and relays what the computer signed, unmodified
    // (Postgres orders a jsonb object's keys its own way; every value is the agent's).
    const same = (a, b) => !!a && !!b && ['schema', 'key', 'statement', 'sig'].every((f) => a[f] === b[f]) && Object.keys(a).length === 4 && Object.keys(b).length === 4;
    check(same(t.result.signed, c.outs[0]?.signed), 'the canary\'s result carries its own signature, stored by the portal exactly as the agent wrote it', JSON.stringify(t.result?.signed ?? null).slice(0, 120));
    check(same(ev.targets[0].signedResult, c.outs[0]?.signed) && same(ev.targets[0].signedScan, inv.patchPosture.signed), 'and the evidence relays the signed result and signed scan untouched');

    // A compromised portal forges the canary's success: every way it can, refused by the signer.
    const st0 = JSON.parse(Buffer.from(c.outs[0].signed.statement, 'base64').toString('utf8'));
    const scanSt = JSON.parse(Buffer.from(inv.patchPosture.signed.statement, 'base64').toString('utf8'));
    const effScan = { ...scanSt, scannedAt: new Date(Date.parse(st0.completedAt) + 60_000).toISOString(), rebootPending: false, offered: [], installed: [key(CU)] };
    const portalKey = deviceKey();
    const forgedEv = (signedResult, signedScan, over = {}) => ({ ...ev, targets: [{ ...ev.targets[0], status: 'SUCCEEDED', result: { outcome: 'succeeded', updates: [{ ...id(CU), state: 'installed' }] }, scan: { scannedAt: effScan.scannedAt, error: false, rebootPending: false, offered: [], installed: [key(CU)] }, signedResult, signedScan, ...over }] });
    const attempt = async (label, evidence, want) => {
      const x = await underPolicy(pol.id, { plan: craft(row.plan, { display: ring1.display, targets: ring1.targets }), policyDigest: pol.digest, evidence });
      check(x.status === 409 && x.body?.error === want, `FORGED canary success: ${label} → ${want}`, JSON.stringify(x.body));
    };
    await attempt('the portal\'s own copy says effective, no signatures', forgedEv(null, null), 'result_signature_missing');
    await attempt('the genuine signed result, plus an "effective" scan the portal signed with a key of its own', forgedEv(c.outs[0].signed, signStatement(portalKey, 'scan', effScan)), 'result_wrong_device');
    await attempt('…the same, but the envelope claims the canary\'s key', forgedEv(c.outs[0].signed, signStatement(portalKey, 'scan', effScan, { claimKey: inv.patchPosture.signed.key })), 'result_signature_invalid');
    await attempt('the canary\'s genuine scan statement, edited to "effective"', forgedEv(c.outs[0].signed, { ...inv.patchPosture.signed, statement: Buffer.from(JSON.stringify(effScan)).toString('base64') }), 'result_signature_invalid');
    const manualRow = await prisma.actionTarget.findFirst({ where: { endpointId: manual.id, result: { not: Prisma.DbNull } }, orderBy: { resultAt: 'desc' } });
    await attempt('another computer\'s genuine, valid signed success (PP-MANUAL\'s) relayed as the canary\'s', forgedEv(manualRow?.result?.signed ?? null, inv.patchPosture.signed), 'result_wrong_device');
    const signerPolicy = await sj(`${INTERNAL}/internal/v1/policies/${pol.id}`);
    check(['result_signature_missing', 'result_wrong_device', 'result_signature_invalid'].every((x) => signerPolicy.body?.refusals?.some((f) => f.code === x)), 'the signer keeps each forged-evidence refusal with the policy', JSON.stringify(signerPolicy.body?.refusals?.map((f) => f.code)));
  }

  section('Restart the API: nothing is proposed twice');
  {
    await stop('api');
    start('api', path.join(dist, 'main.js'), apiEnv);
    await waitUp(`${API}/health`, 'api');
    await sleep(5000);
    const deps = await prisma.patchDeployment.count({ where: { policyId: pol.id } });
    const jobs = await prisma.actionJob.count({ where: { deployment: { policyId: pol.id } } });
    check(deps === 1 && jobs === 1, 'after a restart and several sweeps: still one deployment for this window and one canary plan', JSON.stringify({ deps, jobs }));
  }

  section('The canary restarts and is confirmed effective: ring 1 is signed automatically');
  let ring1Job;
  {
    restart(canary);
    await rescan(canary);
    ring1Job = await until('ring 1', async () => prisma.actionJob.findFirst({ where: { deploymentId: dep.id, ring: 1, status: { notIn: SIGNED_NOT } }, include: { targets: true } }));
    check(!!ring1Job && ring1Job.targets.length === 2, 'ring 1 (two computers) is signed under the policy once the canary is effective', ring1Job ? '' : JSON.stringify((await prisma.patchPolicy.findUnique({ where: { id: pol.id } }))?.lastProposal));
    if (ring1Job) {
      check(JSON.stringify(ring1Job.plan.params.updates) === JSON.stringify(canaryJob.plan.params.updates), 'with exactly the canary\'s updates');
      const a = await cycle(r1a), b = await cycle(r1b);
      check(a.outs[0]?.updates?.find((x) => x.kb === 'KB5046001')?.state === 'installed' && !wuaNow(r1a).installed.some((x) => x.updateId === NET.updateId), 'R1-A installs the CU, and not the .NET update it is also offered', JSON.stringify(a.outs[0]));
      check(b.outs[0]?.updates?.find((x) => x.kb === 'KB5046001')?.state === 'installed', 'R1-B installs the CU', JSON.stringify(b.outs[0]));
      await rescan(r1a); await rescan(r1b);
      const d = await until('completed', async () => (await prisma.patchDeployment.findUnique({ where: { id: dep.id } }))?.status === 'COMPLETED' || (await req('GET', `/patching/deployments/${dep.id}`, { s: S.owen, business: acme.id })).body?.data?.status === 'COMPLETED', 10_000);
      check(!!d, 'the policy\'s deployment completes');
      await sleep(4500);
      check((await prisma.patchDeployment.count({ where: { policyId: pol.id } })) === 1, 'and no second deployment is proposed in the same window');
    }
  }

  section('A policy that allows a restart inside its window (0.34)');
  {
    // Through the portal: accepted, signed into the document, shown to the approvers. Left unapproved, so the sweep never acts on it.
    const r = await req('POST', '/patching/policies', { s: S.owenF, business: acme.id, body: { ...body, name: 'Acme security, with restarts', reboot: 'if_required_in_window' } });
    check(r.status === 201 && r.body?.data?.document?.reboot === 'if_required_in_window', 'the portal proposes a policy whose rule is "restart if required, inside the window"', msg(r));
    const page = r.status === 201 ? await (await fetch(r.body.data.approvalUrl)).text() : '';
    check(page.includes('if Windows requires one') && page.includes('15-minute warning') && page.includes('not yet run on a real Windows computer'), 'its approval page says it restarts, with the fixed warning, and that this has not run on real Windows', page.slice(0, 200));
    const dflt = await prisma.patchPolicy.findUnique({ where: { id: pol.id } });
    check(dflt.document.reboot === 'never', 'a policy proposed without a rule says never (the default)', JSON.stringify(dflt.document.reboot));
    // Straight to the signer (the portal never sees it), approved, then plans under it.
    const t0 = new Date();
    const doc = { ...pol.document, policyId: hex(16), name: 'Restarts allowed', reboot: 'if_required_in_window', createdAt: t0.toISOString(), expiresAt: new Date(t0.getTime() + 86_400_000).toISOString() };
    const sub = await sj(`${INTERNAL}/internal/v1/policies`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ policy: doc }) });
    check(sub.status === 201, 'the signer accepts it', JSON.stringify(sub.body));
    await approvePolicy(doc.policyId, pk.olivia); const a = await approvePolicy(doc.policyId, pk.quinn);
    check(a.body?.status === 'ACTIVE', 'approved by two', JSON.stringify(a.body).slice(0, 200));
    const under = (rule) => craft(canaryJob.plan, {
      params: { ...canaryJob.plan.params, reboot: rule },
      display: { ...canaryJob.plan.display, policy: { id: doc.policyId, name: doc.name, digest: sub.body.digest }, deployment: { ...canaryJob.plan.display.deployment, id: `rb${hex(8)}` } },
    });
    const ok = await underPolicy(doc.policyId, { plan: under('if_required_in_window'), policyDigest: sub.body.digest, evidence: null });
    check(ok.status === 201 && /^[0-9a-f]{32}$/.test(ok.body?.jobId ?? ''), 'a canary plan asking to restart in the window is signed under it', JSON.stringify(ok.body));
    const less = await underPolicy(doc.policyId, { plan: under('never'), policyDigest: sub.body.digest, evidence: null });
    check(less.status === 201, 'and so is one asking for less (never)', JSON.stringify(less.body));
  }

  section('Revoke: one-way, and it reaches the signer');
  {
    let r = await req('POST', `/patching/policies/${pol.id}/revoke`, { s: S.owen, business: acme.id, body: { reason: 'pausing for the holidays' } });
    check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED', 'revoking needs a fresh sign-in', msg(r));
    r = await req('POST', `/patching/policies/${pol.id}/revoke`, { s: S.owenF, business: acme.id, body: { reason: 'pausing for the holidays' } });
    check(r.status === 200 && r.body.data.status === 'REVOKED' && r.body.data.signerConfirmedRevocation === true, 'revoked here, and the signer confirmed it', msg(r));
    const p = await underPolicy(pol.id, { plan: craft(canaryJob.plan), policyDigest: pol.digest, evidence: null });
    check(p.status === 409 && p.body?.error === 'policy_revoked', 'the signer refuses any plan under a revoked policy → policy_revoked', JSON.stringify(p.body));
    const list = signerCli(['patch-policy', 'list']);
    check(/REVOKED/.test(list.stdout), 'the signer CLI shows it REVOKED', list.stdout.slice(0, 300));
    check(existsSync(path.join(signerDir, 'revocations', `${pol.id}.json`)), 'the revocation is its own write-once file on the signer');
    const jobs0 = await prisma.actionJob.count({ where: { deployment: { policyId: pol.id } } });
    await sleep(4500);
    check((await prisma.actionJob.count({ where: { deployment: { policyId: pol.id } } })) === jobs0, 'the sweep proposes nothing more under it');
    const audits = await prisma.activityLog.findMany({ where: { resourceId: pol.id }, select: { action: true } });
    const acts = new Set(audits.map((a) => a.action));
    check(['PATCH_POLICY_CREATED', 'PATCH_POLICY_UPDATED', 'PATCH_POLICY_PROPOSED', 'PATCH_POLICY_REVOKED'].every((a) => acts.has(a)), 'audit: created, updated (approved), proposed, revoked', [...acts].join(','));
    check(!!(await prisma.activityLog.findFirst({ where: { action: 'PATCH_INSTALL_REQUESTED', resourceId: manual.id } })), 'audit: the manual install request');
  }

  section('An expired policy (proposed straight to the signer, approved, then left to expire)');
  {
    const t0 = new Date();
    const doc = {
      ...pol.document, policyId: hex(16), name: 'Short-lived', createdAt: t0.toISOString(), expiresAt: new Date(t0.getTime() + 15_000).toISOString(),
    };
    const s = await sj(`${INTERNAL}/internal/v1/policies`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ policy: doc }) });
    check(s.status === 201, 'the signer accepts a policy that expires in 15 s', JSON.stringify(s.body));
    await approvePolicy(doc.policyId, pk.olivia); const a = await approvePolicy(doc.policyId, pk.quinn);
    check(a.body?.status === 'ACTIVE', 'approved', JSON.stringify(a.body).slice(0, 200));
    await sleep(Math.max(0, Date.parse(doc.expiresAt) - Date.now()) + 500);
    const p = await underPolicy(doc.policyId, { plan: craft(canaryJob.plan, { display: { ...canaryJob.plan.display, policy: { id: doc.policyId, name: doc.name, digest: s.body.digest } } }), policyDigest: s.body.digest, evidence: null });
    check(p.status === 409 && p.body?.error === 'policy_expired', 'after its expiry → policy_expired', JSON.stringify(p.body));
  }

  section('Containment still stops everything');
  {
    const r = await req('POST', '/containment/pauses', { s: S.owen, business: acme.id, body: { scope: 'business', businessId: acme.id, reason: 'suspected phish' } });
    check(r.status === 201, 'Acme\'s owner pauses Acme', msg(r));
    const t0 = new Date();
    const doc = { ...pol.document, policyId: hex(16), name: 'During a pause', createdAt: t0.toISOString(), expiresAt: new Date(t0.getTime() + 86_400_000).toISOString() };
    const s = await sj(`${INTERNAL}/internal/v1/policies`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ policy: doc }) });
    check(s.status === 409 && s.body?.error === 'paused', 'the signer accepts no new policy for a paused business', JSON.stringify(s.body));
    const p = await underPolicy(pol.id, { plan: craft(canaryJob.plan), policyDigest: pol.digest, evidence: null });
    check(p.status === 409 && p.body?.error === 'paused', 'and signs nothing under any policy of it', JSON.stringify(p.body));
  }
}

async function cleanup() {
  await stop('api'); await stop('signer');
  try {
    if (created.businesses.length) {
      await prisma.actionJob.deleteMany({ where: { customerId: { in: created.businesses } } });
      await prisma.patchDeployment.deleteMany({ where: { customerId: { in: created.businesses } } });
      await prisma.patchPolicy.deleteMany({ where: { customerId: { in: created.businesses } } });
      await prisma.containmentPause.updateMany({ where: { clearedAt: null, customerId: { in: created.businesses } }, data: { clearedAt: new Date(), clearReason: 'e2e cleanup' } });
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
