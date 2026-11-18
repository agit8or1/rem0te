#!/usr/bin/env node
/**
 * End-to-end proof of the simple restart window (v0.60): set on a business,
 * a device group or one computer ("no automatic restarts" included), with
 * precedence computer > group > business; every automatic restart a signed
 * windows.reboot.schedule plan the approval signer checks against the
 * window two people approved (or that direct mode made active).
 *
 * Self-contained, like e2e-restart-windows.mjs: a signed update repository
 * from the offline release tool, the approval signer as its own process
 * (built from dist), the compiled API on its own port with
 * RESTART_WINDOW_SWEEP every 2 seconds, a scratch database, synthetic
 * passkeys checked by the signer's real WebAuthn verification, and
 * rem0te-action-sim — the agent's real verifier and executor — deciding each
 * restart from a simulated registry and RustDesk session state.
 *
 *   cd apps/api && npx nest build
 *   RELEASE_BIN=…/rem0te-release ACTION_SIM=…/rem0te-action-sim \
 *   DATABASE_URL=postgresql://…/<name containing scratch or test> node scripts/e2e-restart-window-settings.mjs
 *
 * Ports 3871 (API), 3872 (signer public), 3873 (signer internal).
 *
 * The windows are daily, UTC, around the current time ("open now") or hours
 * ahead ("closed"), so nothing waits for a clock. "Fifteen minutes later" is
 * simulated by moving the portal's attempt row and the signer's own ledger
 * entry back, as e2e-restart-windows.mjs does.
 *
 * FIXTURE-TESTED: no Windows, no real RustDesk, no real restart.
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
const PORT = Number(process.env.RWS_API_PORT ?? 3871);
const SIGNER_PUBLIC = Number(process.env.RWS_SIGNER_PUBLIC_PORT ?? 3872);
const SIGNER_INTERNAL = Number(process.env.RWS_SIGNER_INTERNAL_PORT ?? 3873);
if ([PORT, SIGNER_PUBLIC, SIGNER_INTERNAL].some((p) => [3000, 3001, 443, 3201, 3202, 4000, 4001].includes(p))) { console.error('refusing a production port'); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
const ORIGIN = `http://127.0.0.1:${SIGNER_PUBLIC}`;
const INTERNAL = `http://127.0.0.1:${SIGNER_INTERNAL}`;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'restart-window-e2e-password-123';

let pass = 0, fail = 0; const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const hex = (n) => randomBytes(n).toString('hex');

// ── The release machine ─────────────────────────────────────────────────────
const work = mkdtempSync(path.join(tmpdir(), 'rem0te-restart-window-'));
const keys = path.join(work, 'keys'); mkdirSync(keys);
const repo = path.join(work, 'repo');
const files = path.join(work, 'files'); mkdirSync(files);
const signerDir = path.join(work, 'signer'); mkdirSync(signerDir, { mode: 0o700 });
const rel = (...a) => execFileSync(BIN, a, { encoding: 'utf8' });
const signerCli = (args) => spawnSync(process.execPath, [path.join(dist, 'approval-signer', 'main.js'), ...args], { encoding: 'utf8', env: { ...process.env, APPROVAL_SIGNER_DIR: signerDir } });
for (const k of ['r1', 'targets', 'snapshot', 'timestamp']) rel('keygen', '-out', path.join(keys, `${k}.pem`));
rel('init', '-repo', repo, '-root-key', path.join(keys, 'r1.pem'), '-root-threshold', '1', '-targets-key', path.join(keys, 'targets.pem'), '-snapshot-key', path.join(keys, 'snapshot.pem'), '-timestamp-key', path.join(keys, 'timestamp.pem'));
const agentBin = Buffer.concat([Buffer.from('MZ stand-in signed agent 0.60 '), randomBytes(64), Buffer.from('REM0TE_INST_URL:'), Buffer.alloc(240)]);
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
  ENCRYPTION_KEY: randomBytes(32).toString('hex'), TRUSTED_PROXIES: 'loopback',
  VERSION_FILE: path.resolve(here, '..', '..', '..', 'version.json'),
  GEOIP_DB_PATH: path.join(work, 'no-geoip.mmdb'),
  MONITOR_SWEEP: 'off', CLIENT_UPDATE_SWEEP: 'off', METRIC_SWEEP: 'off', RETENTION_SWEEP: 'off', REPORT_SCHEDULE_SWEEP: 'off',
  CHAT_RETENTION_SWEEP: 'off', TRAY_SWEEP: 'off', SCRIPT_OUTPUT_SWEEP: 'off', AUTO_MIGRATION_SWEEP: 'off', WINGET_INDEX_SWEEP: 'off', SNAPSHOT_SWEEP: 'off',
  AGENT_AUTO_UPDATE: 'off', PATCH_POLICY_SWEEP: 'off', AUTOMATION_SWEEP: 'off', WARRANTY_SWEEP: 'off',
  // This suite tests the restart-window sweep: on, and fast.
  RESTART_WINDOW_SWEEP: 'on', RESTART_WINDOW_SWEEP_SECONDS: '2',
};
delete apiEnv.INTEGRATION_PEERS_FILE;
async function waitUp(url, name) {
  for (let i = 0; i < 120; i++) { try { const r = await fetch(url); if (r.status < 500) return; } catch { /* not yet */ } await sleep(300); }
  throw new Error(`${name} did not come up:\n${kids[name]?.log.slice(-3000)}`);
}

// ── HTTP (paced under the burst throttler) ──────────────────────────────────
async function req(method, p, { s, body, business } = {}) {
  await sleep(60);
  const h = { 'content-type': 'application/json', 'x-forwarded-for': s?.ip ?? ip() };
  if (s) h.cookie = s.cookie + (s.stepUp ? `; step_up=${s.stepUp}` : '');
  const biz = business ?? s?.business;
  if (biz) h['x-rem0te-business'] = biz;
  const r = await fetch(`${API}${p}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j, data: j?.data, setCookie: r.headers.get('set-cookie') ?? '' };
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
const plain = (s) => ({ ...s, stepUp: undefined });
const code = (r) => r.body?.code ?? r.body?.message?.code ?? r.body?.error?.code;
const msg = (r) => `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 500)}`;
const sj = async (url, init = {}) => { const r = await fetch(url, init); let b = null; try { b = await r.json(); } catch { /* html */ } return { status: r.status, body: b }; };
const signerPost = (p, body) => sj(`${ORIGIN}/approve/${p}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify(body) });
async function approveAt(base, who, body = { decision: 'approve', role: 'approver' }) {
  const c = await signerPost(`${base}/challenge`, body);
  if (c.status !== 200) return c;
  return signerPost(`${base}/decide`, { challengeId: c.body.challengeId, assertion: who.assert(c.body.options, { origin: ORIGIN }) });
}
/** What a compromised portal can do: post any plan it likes to the signer's internal automation route. */
const underPolicy = (pid, body) => sj(`${INTERNAL}/internal/v1/automations/${pid}/plans`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
async function until(f, ms = 30_000) {
  const t0 = Date.now();
  for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(500); }
}

// ── A simulated computer ────────────────────────────────────────────────────
const ACTIONS = ['windows.update.install@1', 'windows.reboot.schedule@1', 'windows.reboot.cancel@1'];
const PENDING = { values: ['SYSTEM\\CurrentControlSet\\Control\\Session Manager|PendingFileRenameOperations'] };
function sim(pc, args) { return execFileSync(SIM, ['-wua', pc.wua, '-registry', pc.reg, '-portal', `127.0.0.1:${PORT}`, ...args], { encoding: 'utf8' }); }
const scan = (pc) => JSON.parse(sim(pc, ['-scan', '-state', pc.state, '-rustdesk-id', pc.rid, '-secret', pc.secret]).trim());
const heartbeat = (pc, extra = {}) => req('POST', '/enrollment/heartbeat', {
  body: { rustdeskId: pc.rid, agentSecret: pc.secret, hostname: pc.hostname, platform: 'Windows', updateChannel: 'signed', agentVersion: '0.54.0', agentActions: ACTIONS, agentSha256: AGENT_SHA, ...extra },
});
function resultsOf(pc) {
  const d = path.join(pc.state, 'actions', 'results');
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => /^[0-9a-f]{32}\.json$/.test(f)).map((f) => JSON.parse(readFileSync(path.join(d, f), 'utf8')));
}
function clearAcked(pc, acks) { for (const a of acks ?? []) rmSync(path.join(pc.state, 'actions', 'results', `${a}.json`), { force: true }); }
function runAgent(pc, jobId, envelope, extra = []) {
  const envFile = path.join(work, `env-${jobId}-${hex(3)}.json`);
  writeFileSync(envFile, JSON.stringify(envelope));
  return JSON.parse(sim(pc, ['-state', pc.state, '-keys', keysFile, '-job', jobId, '-envelope', envFile, '-rustdesk-id', pc.rid, '-secret', pc.secret, '-product-type', '1', '-self-sha', AGENT_SHA, ...extra]).trim());
}
async function report(pc) {
  const hb = await heartbeat(pc, { actionResults: resultsOf(pc), patchPosture: scan(pc) });
  clearAcked(pc, hb.data?.actionAcks);
  return hb;
}
const envelopeFor = async (pc, jobId) => ((await heartbeat(pc)).data?.actions ?? []).find((a) => a.jobId === jobId);
const hhmm = (t) => `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`;
const ALL_DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const win = (fromMin, toMin) => ({ days: ALL_DAYS, start: hhmm(new Date(Date.now() + fromMin * 60_000)), end: hhmm(new Date(Date.now() + toMin * 60_000)), timezone: 'UTC' });
const OPEN = () => win(-60, 120);
const CLOSED = () => win(300, 420);
const attempts = (pc) => prisma.restartWindowAttempt.findMany({ where: { endpointId: pc.id }, orderBy: [{ windowKey: 'asc' }, { attempt: 'asc' }] });
const signedAttempt = (pc, n = 1) => prisma.restartWindowAttempt.findFirst({ where: { endpointId: pc.id, attempt: n, code: 'signed' } });

const created = { businesses: [], users: [] };

async function all() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  const leftovers = await prisma.restartWindowSetting.count();
  if (leftovers) throw new Error(`refusing: this database already has ${leftovers} restart window setting(s), and this suite runs the sweep, which acts on all of them`);
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });
  const roleUser = await prisma.role.findFirst({ where: { type: 'BUSINESS_USER' } });

  section('Fixtures (synthetic): Acme (signed mode), Delta (direct mode), Birch');
  const acme = await prisma.customer.create({ data: { tenantId: tenant.id, name: `RWS Acme ${sfx}` } });
  const delta = await prisma.customer.create({ data: { tenantId: tenant.id, name: `RWS Delta ${sfx}` } });
  const birch = await prisma.customer.create({ data: { tenantId: tenant.id, name: `RWS Birch ${sfx}` } });
  created.businesses.push(acme.id, delta.id, birch.id);
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag, extra = {}) => { const u = await prisma.user.create({ data: { email: `rws-${tag}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'RWS', lastName: tag, status: 'ACTIVE', ...extra } }); created.users.push(u.id); return u; };
  const owen = await mkUser('owen-owner'), dora = await mkUser('dora-delta-owner'), vic = await mkUser('vic-viewer'), bea = await mkUser('bea-birch');
  const olivia = await mkUser('olivia-approver', { platformPermissions: ['technicians:manage'] }), quinn = await mkUser('quinn-approver', { platformPermissions: ['technicians:manage'] });
  await prisma.membership.create({ data: { userId: owen.id, tenantId: tenant.id, customerId: acme.id, roleId: roleOwner.id, capabilities: [] } });
  await prisma.membership.create({ data: { userId: dora.id, tenantId: tenant.id, customerId: delta.id, roleId: roleOwner.id, capabilities: [] } });
  await prisma.membership.create({ data: { userId: vic.id, tenantId: tenant.id, customerId: acme.id, roleId: roleUser.id, capabilities: ['computers:view'] } });
  await prisma.membership.create({ data: { userId: bea.id, tenantId: tenant.id, customerId: birch.id, roleId: roleOwner.id, capabilities: [] } });
  const mkPc = async (biz, hostname, reg = {}) => {
    const e = await prisma.endpoint.create({ data: { tenantId: tenant.id, customerId: biz.id, name: hostname, hostname, status: 'ACTIVE', isOnline: true, isManaged: true, accessMode: 'COMPANY_WIDE', lastSeenAt: new Date(), deviceClass: 'WORKSTATION' } });
    const rid = String(100000000 + ((Math.random() * 899999999) | 0));
    const secret = hex(24);
    await prisma.rustdeskNode.create({ data: { tenantId: tenant.id, endpointId: e.id, rustdeskId: rid, agentSecretHash: sha(secret) } });
    const state = path.join(work, `pc-${e.id}`); mkdirSync(state);
    const pc = { id: e.id, rid, secret, state, hostname, wua: path.join(state, 'wua.json'), reg: path.join(state, 'registry.json') };
    writeFileSync(pc.wua, JSON.stringify({ offered: [], installed: [], superseded: [], history: [] }));
    writeFileSync(pc.reg, JSON.stringify(reg));
    return pc;
  };
  const aPend = await mkPc(acme, 'A-PENDING', PENDING);   // dewey-wks2022's case: Windows wants a restart
  const aClean = await mkPc(acme, 'A-CLEAN');             // nothing pending
  const aOff = await mkPc(acme, 'A-OFF', PENDING);        // pending, its own setting says no automatic restarts
  const dPend = await mkPc(delta, 'D-PENDING', PENDING);
  const dSess = await mkPc(delta, 'D-SESSION', PENDING);  // a technician connected through RustDesk
  const dGroup = await mkPc(delta, 'D-GROUP', PENDING);   // in a group whose window is closed
  const dOwn = await mkPc(delta, 'D-OWN');                // its own window, "always"
  const bPend = await mkPc(birch, 'B-PENDING', PENDING);
  const allPcs = [aPend, aClean, aOff, dPend, dSess, dGroup, dOwn, bPend];
  const servers = await prisma.endpointGroup.create({ data: { tenantId: tenant.id, customerId: delta.id, name: `RWS Servers ${sfx}`, kind: 'STATIC' } });
  await prisma.endpointGroupMember.create({ data: { endpointGroupId: servers.id, endpointId: dGroup.id } });
  const pk = { olivia: syntheticPasskey({ userId: olivia.id, name: 'RWS olivia' }), quinn: syntheticPasskey({ userId: quinn.id, name: 'RWS quinn' }), owen: syntheticPasskey({ userId: owen.id, name: 'RWS owen' }) };
  for (const k of Object.values(pk)) await prisma.userMfaMethod.create({ data: { userId: k.userId, type: 'WEBAUTHN', isActive: true, credentialId: k.credentialId, publicKey: Buffer.from(k.publicKey, 'base64url'), signCount: 0, name: 'Test key' } });
  check(true, 'three businesses, eight computers, six people, one device group');

  const set = signerCli(['policy', 'set', '--business', delta.id, '--approval', 'direct']);
  check(set.status === 0, 'the signer CLI puts Delta in direct mode (the only way to)', set.stderr);
  start('signer', path.join(dist, 'approval-signer', 'main.js'), signerEnv);
  start('api', path.join(dist, 'main.js'), apiEnv);
  await waitUp(`${INTERNAL}/internal/v1/keys`, 'signer');
  await waitUp(`${API}/health`, 'api');
  const S = {};
  for (const [k, u] of Object.entries({ owen, dora, vic, bea, olivia, quinn })) S[k] = await login(u.email);
  S.owen.business = acme.id; S.vic.business = acme.id; S.dora.business = delta.id; S.bea.business = birch.id;
  for (const [who, scope] of [['olivia', '*'], ['quinn', '*'], ['owen', acme.id]]) {
    const list = await req('GET', '/auth/passkeys', { s: S[who] });
    const mine = (list.body?.data ?? list.body ?? [])[0];
    const add = signerCli(['roster', 'add', '--export', mine.approvalExport, '--approve', scope, '--confirm-fingerprint', mine.approvalFingerprint]);
    if (add.status !== 0) throw new Error(`roster add ${who}: ${add.stderr}`);
  }
  for (const pc of allPcs) await heartbeat(pc, { patchPosture: scan(pc) });
  const caps = await sj(`${INTERNAL}/internal/v1/capabilities`);
  check(caps.body?.restartWindows === 1, 'the 0.60 signer says it supports restart windows', JSON.stringify(caps.body));

  section('Nothing set: nothing restarts a computer automatically');
  {
    const b = await req('GET', `/restart-windows/businesses/${acme.id}`, { s: S.owen });
    check(b.status === 200 && b.data.business === null && b.data.readiness.signerSupportsRestartWindows === true && b.data.readiness.sweep.enabled === true && b.data.may.edit === true,
      'GET the business: no window, the signer is ready, the sweep is on, the owner may edit', msg(b));
    const c = await req('GET', `/restart-windows/computers/${aPend.id}`, { s: S.owen });
    check(c.status === 200 && c.data.effective === null && c.data.restartPending === true && /never restarted automatically/.test(c.data.text), 'A-PENDING: restart pending, and the card says it is never restarted automatically', msg(c));
    await sleep(4000);
    check((await prisma.restartWindowAttempt.count({ where: { customerId: { in: created.businesses } } })) === 0, 'two sweeps later, nothing has been asked for');
  }

  section('Who may set one, and what it must look like');
  {
    let r = await req('PUT', `/restart-windows/businesses/${acme.id}`, { s: S.owen, body: { mode: 'window', rule: 'if_required', window: OPEN() } });
    check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED', 'a window without a fresh sign-in → 403 STEP_UP_REQUIRED (restart.window)', msg(r));
    S.owen = await stepUp(S.owen);
    r = await req('PUT', `/restart-windows/businesses/${acme.id}`, { s: await stepUp(S.vic), body: { mode: 'window', rule: 'if_required', window: OPEN() } });
    check(r.status === 403 && code(r) === 'NOT_ALLOWED', 'Vic (View computers only) → 403', msg(r));
    r = await req('PUT', `/restart-windows/businesses/${acme.id}`, { s: await stepUp(S.bea), business: birch.id, body: { mode: 'window', rule: 'if_required', window: OPEN() } });
    check(r.status === 404 || r.status === 403, 'Birch\'s owner cannot set Acme\'s', msg(r));
    r = await req('GET', `/restart-windows/computers/${aPend.id}`, { s: S.bea, business: birch.id });
    check(r.status === 404 || r.status === 403, '…nor read Acme\'s computer', msg(r));
    for (const [n, body, want] of [
      ['an unknown rule', { mode: 'window', rule: 'whenever', window: OPEN() }, 'INVALID_REQUEST'],
      ['an hourly schedule', { mode: 'window', rule: 'always', window: { kind: 'hourly', everyHours: 4, minute: 0, windowMinutes: 60, timezone: 'UTC' } }, 'INVALID_REQUEST'],
      ['a 20-minute window', { mode: 'window', rule: 'always', window: win(-5, 15) }, 'RESTART_WINDOW_TOO_SHORT'],
      ['the exception as false', { mode: 'window', rule: 'always', window: OPEN(), ignoreRemoteSession: false }, 'INVALID_REQUEST'],
      ['an extra field', { mode: 'window', rule: 'always', window: OPEN(), delayMinutes: 1 }, 'INVALID_REQUEST'],
      ['a 120-day expiry', { mode: 'window', rule: 'always', window: OPEN(), expiresInDays: 120 }, 'INVALID_REQUEST'],
      ['"no automatic restarts" for a whole business', { mode: 'off' }, 'INVALID_REQUEST'],
      ['a priority on a business', { mode: 'window', rule: 'always', window: OPEN(), priority: 1 }, 'INVALID_REQUEST'],
    ]) {
      r = await req('PUT', `/restart-windows/businesses/${acme.id}`, { s: S.owen, body });
      check(r.status === 400 && code(r) === want, `${n} → 400 ${want}`, msg(r));
    }
  }

  section('"No automatic restarts" on one computer: at once, no fresh sign-in');
  {
    const r = await req('PUT', `/restart-windows/computers/${aOff.id}`, { s: plain(S.owen), body: { mode: 'off', reason: 'Lab instrument PC' } });
    check(r.status === 200 && r.data.own?.mode === 'off' && r.data.effective?.source === 'set on this computer' && r.data.effective.mode === 'off' && /No automatic restarts/.test(r.data.text), 'A-OFF: no automatic restarts, set on this computer, with no fresh sign-in', msg(r));
  }

  section('Signed mode: a window waits for two passkey approvals, and says so');
  let acmePol;
  {
    const r = await req('PUT', `/restart-windows/businesses/${acme.id}`, { s: S.owen, body: { mode: 'window', rule: 'if_required', window: OPEN(), reason: 'Ticket 7: dewey-wks2022 never restarted' } });
    acmePol = r.data?.business?.window;
    check(r.status === 200 && acmePol?.status === 'AWAITING_APPROVAL' && acmePol.approvalUrl === `${ORIGIN}/approve/automation/${acmePol.id}` && r.data.business.inForce === false,
      'set: the business\'s window is AWAITING_APPROVAL, on the signer\'s own URL, and not in force', msg(r));
    const a = await prisma.activityLog.findFirst({ where: { resourceId: r.data?.business?.id, action: 'RESTART_WINDOW_SET' } });
    check(a?.metadata?.after?.rule === 'if_required' && a.metadata.after.status === 'AWAITING_APPROVAL' && a.metadata.before === null && a.metadata.reason === 'Ticket 7: dewey-wks2022 never restarted', 'audited as RESTART_WINDOW_SET with before and after', JSON.stringify(a?.metadata));
    const doc = (await prisma.automationPolicy.findUnique({ where: { id: acmePol.id } })).document;
    check(doc.task.kind === 'restart' && doc.task.rule === 'if_required' && doc.task.ignoreRemoteSession === undefined && doc.targets.kind === 'business' && doc.maxRunsPerOccurrence === 3 && doc.offline.mode === 'run_when_online',
      'the document: a restart task (no exception), the whole business, three tries a window', JSON.stringify(doc).slice(0, 400));
    const c = await req('GET', `/restart-windows/computers/${aPend.id}`, { s: S.owen });
    check(c.data?.effective === null && c.data.notInForce?.[0]?.window?.status === 'AWAITING_APPROVAL' && /waiting for approval/.test(c.data.text), 'A-PENDING: governed by nothing yet; the card names the window waiting for approval', msg(c));
    await sleep(4000);
    check((await attempts(aPend)).length === 0, 'two sweeps later, no restart has been asked for');
    const page = await (await fetch(acmePol.approvalUrl)).text();
    check(/Approve restart window/.test(page) && /cannot see which computers that is/.test(page) && /restarts 15 minutes later/.test(page), 'the signer\'s page says what it approves, and that it cannot see which computers');
    let x = await approveAt(`automation/${acmePol.id}`, pk.owen);
    check(x.status === 403 && x.body?.error === 'requester_cannot_approve', 'Owen, who set it, cannot approve it', JSON.stringify(x.body));
    x = await approveAt(`automation/${acmePol.id}`, pk.olivia);
    check(x.body?.status === 'AWAITING_APPROVAL', 'one approval is not enough', JSON.stringify(x.body));
    x = await approveAt(`automation/${acmePol.id}`, pk.quinn);
    check(x.body?.status === 'ACTIVE', 'a second, different approver makes it ACTIVE', JSON.stringify(x.body));
    for (const route of ['approve', 'activate', 'sign']) {
      const y = await req('POST', `/restart-windows/businesses/${acme.id}/${route}`, { s: S.owen });
      check(y.status === 404, `there is no ${route} route in the portal → 404`, msg(y));
    }
  }

  section('In force: the sweep asks for a restart only where Windows needs one');
  let aJob;
  {
    const row = await until(() => signedAttempt(aPend));
    check(!!row, 'A-PENDING: a restart plan is signed under the business\'s window', JSON.stringify(await attempts(aPend)));
    aJob = row && await prisma.actionJob.findUnique({ where: { id: row.jobId } });
    const p = aJob?.plan;
    check(p?.action?.id === 'windows.reboot.schedule' && JSON.stringify(p.params) === JSON.stringify({ delayMinutes: 15, onlyIfRequired: true }) && p.targets.length === 1 && p.display.policy.id === acmePol.id,
      'the plan: windows.reboot.schedule, the fixed 15-minute warning, onlyIfRequired, one computer, naming the window', JSON.stringify(p?.params));
    check(aJob?.status === 'APPROVED' && aJob.requestedById === owen.id, 'APPROVED with no further approval, requested on Owen\'s behalf', `${aJob?.status} ${aJob?.requestedById}`);
    check(aJob && aJob.notAfter.getTime() - aJob.notBefore.getTime() <= 15 * 60_000 + 1000, 'valid for at most 15 minutes', `${aJob?.notBefore?.toISOString()} ${aJob?.notAfter?.toISOString()}`);
    await sleep(4000);
    check((await attempts(aClean)).length === 0, 'A-CLEAN (Windows needs no restart) gets none');
    check((await attempts(aOff)).length === 0, 'A-OFF (no automatic restarts on the computer) gets none');
    check((await attempts(bPend)).length === 0, 'B-PENDING (Birch has no window) gets none');
    check((await attempts(aPend)).length === 1, 'and A-PENDING still one: a plan is open');
    const env = await envelopeFor(aPend, aJob.id);
    const out = env ? runAgent(aPend, aJob.id, env.envelope) : null;
    check(out?.outcome === 'succeeded' && out.observed?.delayMinutes === '15' && !!out.observed?.scheduledFor, 'A-PENDING verifies the signed plan: restart scheduled with the 15-minute warning', JSON.stringify(out));
    await report(aPend);
    const c = await req('GET', `/restart-windows/computers/${aPend.id}`, { s: S.owen });
    check(/^Restart scheduled for/.test(c.data?.text ?? '') && c.data.effective?.source === `from business ${acme.name}`, 'the card: "Restart scheduled for …", from the business', c.data?.text);
    const ca = await req('GET', `/restart-windows/computers/${aClean.id}`, { s: S.owen });
    check(/No restart is pending/.test(ca.data?.text ?? '') && /next window/.test(ca.data.text), 'A-CLEAN\'s card: no restart pending, and when its next window is', ca.data?.text);
  }

  section('Direct mode: active at once; precedence computer > group > business');
  let deltaPol, groupPol, ownPol, deltaBase;
  {
    let r = await req('PUT', `/restart-windows/businesses/${delta.id}`, { s: plain(S.dora), body: { mode: 'window', rule: 'if_required', window: OPEN() } });
    check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED', 'direct mode still needs a fresh sign-in', msg(r));
    S.dora = await stepUp(S.dora);
    r = await req('PUT', `/restart-windows/businesses/${delta.id}`, { s: S.dora, body: { mode: 'window', rule: 'if_required', window: OPEN() } });
    deltaPol = r.data?.business?.window;
    check(r.status === 200 && deltaPol?.status === 'ACTIVE' && deltaPol.direct === true && r.data.business.inForce === true, 'Delta\'s window is ACTIVE at once (direct mode)', msg(r));
    const dRow = deltaPol ? await prisma.automationPolicy.findUnique({ where: { id: deltaPol.id } }) : null;
    check(deltaPol?.expiresAt === null && deltaPol.expiresSoon === false && dRow?.expiresAt === null && dRow.document.expiry === 'never', '0.63: it never expires (signed expiry "never", no date), and a null expiry is in force, not expired', JSON.stringify({ expiresAt: deltaPol?.expiresAt, soon: deltaPol?.expiresSoon, expiry: dRow?.document?.expiry }));
    r = await req('PUT', `/restart-windows/businesses/${delta.id}/groups/${servers.id}`, { s: S.dora, body: { mode: 'window', rule: 'if_required', window: CLOSED() } });
    groupPol = r.data?.groups?.[0]?.window;
    check(r.status === 200 && groupPol?.status === 'ACTIVE' && r.data.groups[0].priority === 1, 'a group window (closed for hours), priority 1', msg(r));
    r = await req('PUT', `/restart-windows/computers/${dOwn.id}`, { s: S.dora, body: { mode: 'window', rule: 'always', window: OPEN() } });
    ownPol = r.data?.own?.window;
    check(r.status === 200 && ownPol?.status === 'ACTIVE' && r.data.effective?.source === 'set on this computer', 'D-OWN: its own window, "always"', msg(r));
    const doc = (await prisma.automationPolicy.findUnique({ where: { id: ownPol.id } })).document;
    check(doc.targets.kind === 'computers' && doc.targets.computers.length === 1 && doc.targets.computers[0].endpointId === dOwn.id && doc.targets.computers[0].deviceSecretSha256 === sha(dOwn.secret), 'a computer\'s window names it as enrolled');
    const cg = await req('GET', `/restart-windows/computers/${dGroup.id}`, { s: S.dora });
    check(cg.data?.effective?.source === `from device group ${servers.name}` && /next window/.test(cg.data.text), 'D-GROUP: governed by its group, not the business', cg.data?.text);
    const d = await until(() => signedAttempt(dPend));
    const o = await until(() => signedAttempt(dOwn));
    const s1 = await until(() => signedAttempt(dSess));
    check(!!d && !!o && !!s1, 'D-PENDING (business), D-OWN (its own) and D-SESSION (business) each get a plan', JSON.stringify({ d: !!d, o: !!o, s: !!s1 }));
    const oj = o && await prisma.actionJob.findUnique({ where: { id: o.jobId } });
    check(JSON.stringify(oj?.plan?.params) === JSON.stringify({ delayMinutes: 15 }) && oj.plan.display.policy.id === ownPol.id && oj.approvalsRequired === 0, 'D-OWN\'s plan: "always" (no onlyIfRequired), under its own window, direct', JSON.stringify(oj?.plan?.params));
    await sleep(4000);
    check((await attempts(dGroup)).length === 0, 'D-GROUP gets none: its group\'s window is closed, and it wins over the business\'s open one');
    const dj = await prisma.actionJob.findUnique({ where: { id: d.jobId } });
    deltaBase = dj.plan;
    const env = await envelopeFor(dPend, dj.id);
    const out = env ? runAgent(dPend, dj.id, env.envelope) : null;
    check(out?.outcome === 'succeeded', 'D-PENDING restarts (scheduled)', JSON.stringify(out));
    await report(dPend);
  }

  section('A RustDesk session defers it; it is asked again 15 minutes later in the same window');
  {
    const first = await signedAttempt(dSess);
    const j1 = await prisma.actionJob.findUnique({ where: { id: first.jobId } });
    let env = await envelopeFor(dSess, j1.id);
    let out = env ? runAgent(dSess, j1.id, env.envelope, ['-sessions', '1']) : null;
    check(out?.outcome === 'not_executed' && out.reason === 'remote_session_open', 'a technician connected (sim -sessions 1) → not restarted (remote_session_open)', JSON.stringify(out));
    await report(dSess);
    await sleep(4000);
    check((await attempts(dSess)).length === 1, 'not at once: the sweep waits 15 minutes');
    const c = await req('GET', `/restart-windows/computers/${dSess.id}`, { s: S.dora });
    check(/deferred because a technician was connected through RustDesk/.test(c.data?.text ?? ''), 'the card says the last try was deferred for a RustDesk session', c.data?.text);
    await prisma.$executeRawUnsafe('UPDATE "RestartWindowAttempt" SET "updatedAt" = now() - interval \'16 minutes\' WHERE id = $1', first.id);
    const recFile = path.join(signerDir, 'automations', `${deltaPol.id}.json`);
    const rec = JSON.parse(readFileSync(recFile, 'utf8'));
    for (const e of rec.ledger) if (e.jobId === first.jobId) e.notAfter = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(recFile, JSON.stringify(rec));
    const second = await until(() => signedAttempt(dSess, 2));
    check(!!second, 'attempt 2: a new plan is signed in the same window', JSON.stringify(await attempts(dSess)));
    if (second) {
      env = await envelopeFor(dSess, second.jobId);
      out = env ? runAgent(dSess, second.jobId, env.envelope) : null;
      check(out?.outcome === 'succeeded', 'the technician has gone: this time it restarts', JSON.stringify(out));
      await report(dSess);
    }
  }

  section('A compromised portal: what the signer refuses under an approved window');
  {
    const base = aJob.plan;
    const craft = (pol, over = {}) => ({ ...base, jobId: hex(16), createdAt: new Date().toISOString(), window: { notBefore: new Date().toISOString(), notAfter: new Date(Date.now() + 15 * 60_000).toISOString() }, display: { ...base.display, policy: { id: pol.id, name: base.display.policy.name, digest: pol.digest } }, ...over });
    const pols = Object.fromEntries(await Promise.all([['acme', acmePol.id], ['delta', deltaPol.id], ['group', groupPol.id], ['own', ownPol.id]].map(async ([k, id]) => [k, await prisma.automationPolicy.findUnique({ where: { id } })])));
    const tgt = (pc, biz) => ({ ...base.targets[0], endpointId: pc.id, hostname: pc.hostname, rustdeskId: pc.rid, deviceSecretSha256: sha(pc.secret), businessId: biz.id, businessName: biz.name });
    // Delta is in direct mode: its plans carry the direct policy block, so craft from one of its own.
    const deltaPlan = (pol, over = {}) => ({ ...deltaBase, jobId: hex(16), createdAt: new Date().toISOString(), window: { notBefore: new Date().toISOString(), notAfter: new Date(Date.now() + 15 * 60_000).toISOString() }, display: { ...deltaBase.display, policy: { id: pol.id, name: deltaBase.display.policy.name, digest: pol.digest } }, ...over });
    const cases = [
      ['a shorter warning', pols.acme, craft(pols.acme, { targets: [tgt(aClean, acme)], params: { delayMinutes: 5, onlyIfRequired: true } }), 'restart_params_not_allowed'],
      ['"if required" dropped', pols.acme, craft(pols.acme, { targets: [tgt(aClean, acme)], params: { delayMinutes: 15 } }), 'restart_params_not_allowed'],
      ['the RustDesk exception, not in the window', pols.acme, craft(pols.acme, { targets: [tgt(aClean, acme)], params: { delayMinutes: 15, onlyIfRequired: true, ignoreRemoteSession: true } }), 'override_not_allowed'],
      ['another business\'s computer', pols.acme, craft(pols.acme, { targets: [tgt(bPend, birch)] }), 'computer_not_in_policy'],
      ['two computers in one plan (the action itself allows one)', pols.acme, craft(pols.acme, { targets: [tgt(aClean, acme), tgt(aOff, acme)] }), 'too_many_targets'],
      ['someone else as requester', pols.acme, craft(pols.acme, { targets: [tgt(aClean, acme)], requestedBy: { ...base.requestedBy, userId: olivia.id } }), 'requester_mismatch'],
      ['a plan valid past the window', pols.acme, craft(pols.acme, { targets: [tgt(aClean, acme)], window: { notBefore: new Date().toISOString(), notAfter: new Date(Date.now() + 119 * 60_000).toISOString() } }), 'outside_restart_window'],
      ['a closed group window', pols.group, deltaPlan(pols.group, { targets: [tgt(dGroup, delta)] }), 'outside_restart_window'],
      ['another computer under a computer\'s own window', pols.own, deltaPlan(pols.own, { targets: [tgt(dPend, delta)], params: { delayMinutes: 15 } }), 'computer_not_in_policy'],
      ['a deployment named', pols.acme, craft(pols.acme, { targets: [tgt(aClean, acme)], display: { ...base.display, policy: { id: pols.acme.id, name: 'x', digest: pols.acme.digest }, deployment: { id: 'dep_x_000001', name: 'x', ring: 0, rings: 1 } } }), 'bad_display'],
    ];
    for (const [n, pol, plan, want] of cases) {
      const r = await underPolicy(pol.id, { plan, policyDigest: pol.digest, evidence: null });
      check(r.status === 409 && r.body?.error === want, `${n} → ${want}`, JSON.stringify(r.body));
    }
    let r = await underPolicy(pols.acme.id, { plan: craft(pols.acme, { targets: [tgt(aClean, acme)] }), policyDigest: pols.acme.digest, evidence: null });
    check(r.status === 200 || r.status === 201, 'a well-formed plan for A-CLEAN is signed (the signer cannot see whether Windows needs it; the agent decides, onlyIfRequired)', JSON.stringify(r.body));
    r = await underPolicy(pols.acme.id, { plan: craft(pols.acme, { targets: [tgt(aClean, acme)] }), policyDigest: pols.acme.digest, evidence: null });
    check(r.status === 409 && r.body?.error === 'restart_already_signed', 'again while it is open → restart_already_signed (the signer\'s own ledger)', JSON.stringify(r.body));
    const recFile = path.join(signerDir, 'automations', `${pols.acme.id}.json`);
    const close = () => { const rec = JSON.parse(readFileSync(recFile, 'utf8')); for (const e of rec.ledger) e.notAfter = new Date(Date.now() - 60_000).toISOString(); writeFileSync(recFile, JSON.stringify(rec)); };
    close();
    r = await underPolicy(pols.acme.id, { plan: craft(pols.acme, { targets: [tgt(aClean, acme)] }), policyDigest: pols.acme.digest, evidence: null });
    close();
    const r3 = await underPolicy(pols.acme.id, { plan: craft(pols.acme, { targets: [tgt(aClean, acme)] }), policyDigest: pols.acme.digest, evidence: null });
    close();
    const r4 = await underPolicy(pols.acme.id, { plan: craft(pols.acme, { targets: [tgt(aClean, acme)] }), policyDigest: pols.acme.digest, evidence: null });
    check(r.status < 300 && r3.status < 300 && r4.status === 409 && r4.body?.error === 'restart_retry_limit', 'a fourth plan for one computer in one window → restart_retry_limit', JSON.stringify([r.status, r3.status, r4.body]));
  }

  section('A change waits for approval; the window in force stays until it is approved');
  {
    const r = await req('PUT', `/restart-windows/businesses/${acme.id}`, { s: S.owen, body: { mode: 'window', rule: 'always', window: OPEN() } });
    const pend = r.data?.business?.pending;
    check(r.status === 200 && r.data.business.window?.id === acmePol.id && r.data.business.inForce === true && pend?.status === 'AWAITING_APPROVAL' && pend.rule === 'always',
      'the new window is pending; the approved one is still in force', msg(r));
    await approveAt(`automation/${pend.id}`, pk.olivia);
    await approveAt(`automation/${pend.id}`, pk.quinn);
    const swapped = await until(async () => { const s = await prisma.restartWindowSetting.findFirst({ where: { customerId: acme.id, scope: 'business' } }); return s?.policyId === pend.id && !s.pendingPolicyId ? s : null; });
    check(!!swapped, 'once approved it takes over (the sweep settles it)');
    const old = await until(async () => { const p = await prisma.automationPolicy.findUnique({ where: { id: acmePol.id } }); return p.status === 'REVOKED' && p.signerRevokedAt ? p : null; });
    check(!!old, 'and the one it replaced is revoked, on the signer too');
  }

  section('Removing: a group\'s or computer\'s setting asks for a fresh sign-in; the business\'s does not');
  {
    let r = await req('DELETE', `/device-groups/${servers.id}`, { s: S.dora });
    check(r.status === 409 && code(r) === 'GROUP_HAS_POLICIES', 'a group carrying a restart window cannot be deleted → 409 GROUP_HAS_POLICIES', msg(r));
    r = await req('DELETE', `/restart-windows/businesses/${delta.id}/groups/${servers.id}`, { s: plain(S.dora), body: {} });
    check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED', 'removing the group\'s window (its computers inherit the business\'s) without a fresh sign-in → 403', msg(r));
    r = await req('DELETE', `/restart-windows/businesses/${delta.id}/groups/${servers.id}`, { s: S.dora, body: { reason: 'servers follow the business now' } });
    check(r.status === 200 && r.data.groups.length === 0, 'with one → removed', msg(r));
    const a = await prisma.activityLog.findFirst({ where: { customerId: delta.id, action: 'RESTART_WINDOW_CLEARED' } });
    check(a?.metadata?.scope === 'group' && a.metadata.withdrawnPolicies?.includes(groupPol.id), 'audited as RESTART_WINDOW_CLEARED, with the window withdrawn', JSON.stringify(a?.metadata));
    const gp = await until(async () => { const p = await prisma.automationPolicy.findUnique({ where: { id: groupPol.id } }); return p.status === 'REVOKED' ? p : null; });
    check(!!gp, 'its window is revoked');
    const dg = await until(() => signedAttempt(dGroup));
    check(!!dg, 'D-GROUP now inherits the business\'s open window and gets a plan');
    r = await req('POST', '/restart-windows/computers/bulk', { s: plain(S.dora), body: { endpointIds: [dOwn.id, dPend.id], mode: 'inherit' } });
    check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED', 'bulk "inherit" without a fresh sign-in → 403', msg(r));
    r = await req('POST', '/restart-windows/computers/bulk', { s: plain(S.dora), body: { endpointIds: [dOwn.id, dPend.id, bPend.id], mode: 'off' } });
    const res = r.data?.results ?? [];
    check(r.status === 200 && res.find((x) => x.endpointId === dOwn.id)?.ok && res.find((x) => x.endpointId === dPend.id)?.ok && !res.find((x) => x.endpointId === bPend.id)?.ok,
      'bulk "no automatic restarts": Delta\'s two done, Birch\'s refused', msg(r));
    const op = await until(async () => { const p = await prisma.automationPolicy.findUnique({ where: { id: ownPol.id } }); return p.status === 'REVOKED' ? p : null; });
    check(!!op, 'D-OWN\'s own window is withdrawn when it is set to no automatic restarts');
    r = await req('DELETE', `/restart-windows/businesses/${acme.id}`, { s: plain(S.owen), body: {} });
    check(r.status === 200 && r.data.business === null, 'removing the business\'s window needs no fresh sign-in (it only narrows)', msg(r));
    const c = await req('GET', `/restart-windows/computers/${aPend.id}`, { s: S.owen });
    check(c.data?.effective === null && /never restarted automatically/.test(c.data.text), 'A-PENDING is back to "never restarted automatically"', c.data?.text);
  }

  section('Containment pauses restarts');
  {
    await prisma.containmentPause.create({ data: { scope: 'BUSINESS', customerId: delta.id, kinds: ['actions'], reason: 'containment drill', setById: dora.id, setBy: 'msp' } });
    await prisma.restartWindowSetting.deleteMany({ where: { endpointId: { in: [dPend.id] } } });
    await prisma.restartWindowAttempt.deleteMany({ where: { endpointId: dPend.id } });
    await sleep(5000);
    check((await attempts(dPend)).length === 0, 'under an actions pause, D-PENDING (inheriting the open window again) gets no plan');
    const p = await prisma.automationPolicy.findUnique({ where: { id: deltaPol.id } });
    check(p.lastProposal?.code === 'contained', 'the window says why', JSON.stringify(p.lastProposal));
  }
}

async function cleanup() {
  await stop('api'); await stop('signer');
  try {
    if (created.businesses.length) {
      await prisma.restartWindowAttempt.deleteMany({ where: { customerId: { in: created.businesses } } });
      await prisma.restartWindowSetting.deleteMany({ where: { customerId: { in: created.businesses } } });
      await prisma.automationPolicy.deleteMany({ where: { customerId: { in: created.businesses } } });
      await prisma.containmentPause.deleteMany({ where: { customerId: { in: created.businesses } } });
      await prisma.actionJob.deleteMany({ where: { customerId: { in: created.businesses } } });
      const eps = await prisma.endpoint.findMany({ where: { customerId: { in: created.businesses } }, select: { id: true } });
      await prisma.endpointCommand.deleteMany({ where: { endpointId: { in: eps.map((e) => e.id) } } });
      await prisma.rustdeskNode.deleteMany({ where: { endpointId: { in: eps.map((e) => e.id) } } });
      await prisma.endpointGroup.deleteMany({ where: { customerId: { in: created.businesses } } });
      await prisma.endpoint.deleteMany({ where: { id: { in: eps.map((e) => e.id) } } });
      await prisma.membership.deleteMany({ where: { customerId: { in: created.businesses } } });
      await prisma.customer.deleteMany({ where: { id: { in: created.businesses } } });
    }
    if (created.users.length) {
      await prisma.userMfaMethod.deleteMany({ where: { userId: { in: created.users } } });
      await prisma.user.deleteMany({ where: { id: { in: created.users } } });
    }
  } catch (e) { console.error('cleanup:', e.message); }
  await prisma.$disconnect();
  rmSync(work, { recursive: true, force: true });
}

all().catch((e) => { fail++; failures.push(`crashed: ${e.stack ?? e}`); console.error(e); if (kids.api) console.error(kids.api.log.slice(-3000)); if (kids.signer) console.error(kids.signer.log.slice(-1500)); })
  .finally(async () => {
    await cleanup();
    console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
    if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
    process.exit(0);
  });
