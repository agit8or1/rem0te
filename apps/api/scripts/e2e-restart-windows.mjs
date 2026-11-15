#!/usr/bin/env node
/**
 * End-to-end proof of restart scheduling and restart windows (0.54).
 *
 * Against the real API, the real approval signer (in direct mode, so the
 * proof is about the restart rules rather than the passkeys, which
 * e2e-approved-action covers) and the agent's real decision code
 * (rem0te-action-sim) over a simulated registry and RustDesk:
 *
 *   - a patch policy with a restart window: the sweep asks the signer for a
 *     windows.reboot.schedule plan inside the window for a computer Windows
 *     says needs a restart, and for no computer that does not; none while a
 *     policy's restart window is closed;
 *   - the plan carries onlyIfRequired and the fixed 15-minute warning, and
 *     the agent decides again from Windows' own state;
 *   - a technician connected through RustDesk (sim -sessions 1) defers it,
 *     and the sweep asks again later in the window (attempt 2);
 *   - a policy with the RustDesk exception restarts anyway, says so in the
 *     result, the audit and Tasks, and the 15-minute warning still shows;
 *   - the signer refuses the exception under a policy without it
 *     (override_not_allowed), and a policy restart outside its window;
 *   - a restart scheduled for a time: signed with its notBefore, not handed
 *     out before it, handed out after it;
 *   - only if required, decided by the agent: no restart pending → no_change;
 *   - an older agent: the portal refuses the flags for it
 *     (ENDPOINT_NOT_READY), and the 0.53 agent itself refuses such a plan
 *     (PRE054_ACTION_SIM, params_not_allowed);
 *   - bulk "Schedule restart" for a selection and a device group: one plan
 *     per computer, each the Actions tab's own request.
 *
 *   cd apps/api && npx nest build
 *   RELEASE_BIN=…/rem0te-release ACTION_SIM=…/rem0te-action-sim [PRE054_ACTION_SIM=…/0.53 sim] \
 *   DATABASE_URL=postgresql://…/<name containing scratch or test> node scripts/e2e-restart-windows.mjs
 *
 * FIXTURE-TESTED: no Windows, no real RustDesk, no real restart.
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');

const DB = process.env.DATABASE_URL ?? '';
const dbName = DB.split('/').pop()?.split('?')[0] ?? '';
if (!/scratch|test/.test(dbName)) { console.error(`Refusing to run against database "${dbName}": name must contain "scratch" or "test".`); process.exit(2); }
const BIN = process.env.RELEASE_BIN, SIM = process.env.ACTION_SIM, OLD_SIM = process.env.PRE054_ACTION_SIM;
if (!BIN || !SIM) { console.error('RELEASE_BIN (rem0te-release) and ACTION_SIM (rem0te-action-sim) are required'); process.exit(2); }
const PORT = Number(process.env.RW_API_PORT ?? 3801);
const SIGNER_PUBLIC = Number(process.env.RW_SIGNER_PUBLIC_PORT ?? 3802);
const SIGNER_INTERNAL = Number(process.env.RW_SIGNER_INTERNAL_PORT ?? 3803);
if ([PORT, SIGNER_PUBLIC, SIGNER_INTERNAL].some((p) => [3000, 3001, 443, 3201, 3202, 4000, 4001].includes(p))) { console.error('refusing a production port'); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
const ORIGIN = `http://127.0.0.1:${SIGNER_PUBLIC}`;
const INTERNAL = `http://127.0.0.1:${SIGNER_INTERNAL}`;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'restart-e2e-password-123';

let pass = 0, fail = 0; const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const hex = (n) => randomBytes(n).toString('hex');

// ── The release machine ─────────────────────────────────────────────────────
const work = mkdtempSync(path.join(tmpdir(), 'rem0te-restart-'));
const keys = path.join(work, 'keys'); mkdirSync(keys);
const repo = path.join(work, 'repo');
const files = path.join(work, 'files'); mkdirSync(files);
const signerDir = path.join(work, 'signer'); mkdirSync(signerDir, { mode: 0o700 });
const rel = (...a) => execFileSync(BIN, a, { encoding: 'utf8' });
const signerCli = (args) => spawnSync(process.execPath, [path.join(dist, 'approval-signer', 'main.js'), ...args], { encoding: 'utf8', env: { ...process.env, APPROVAL_SIGNER_DIR: signerDir } });
for (const k of ['r1', 'targets', 'snapshot', 'timestamp']) rel('keygen', '-out', path.join(keys, `${k}.pem`));
rel('init', '-repo', repo, '-root-key', path.join(keys, 'r1.pem'), '-root-threshold', '1', '-targets-key', path.join(keys, 'targets.pem'), '-snapshot-key', path.join(keys, 'snapshot.pem'), '-timestamp-key', path.join(keys, 'timestamp.pem'));
const agentBin = Buffer.concat([Buffer.from('MZ stand-in signed agent 0.54 '), randomBytes(64), Buffer.from('REM0TE_INST_URL:'), Buffer.alloc(240)]);
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
  MONITOR_SWEEP: 'off', CLIENT_UPDATE_SWEEP: 'off', METRIC_SWEEP: 'off', RETENTION_SWEEP: 'off', REPORT_SCHEDULE_SWEEP: 'off',
  CHAT_RETENTION_SWEEP: 'off', TRAY_SWEEP: 'off', SCRIPT_OUTPUT_SWEEP: 'off', AUTO_MIGRATION_SWEEP: 'off', WINGET_INDEX_SWEEP: 'off', SNAPSHOT_SWEEP: 'off', AGENT_AUTO_UPDATE: 'off',
  // This suite tests the policy sweep's restarts: on, and fast.
  PATCH_POLICY_SWEEP: 'on', PATCH_POLICY_SWEEP_SECONDS: '2',
};
async function waitUp(url, name) {
  for (let i = 0; i < 120; i++) { try { const r = await fetch(url); if (r.status < 500) return; } catch { /* not yet */ } await sleep(300); }
  throw new Error(`${name} did not come up:\n${kids[name]?.log.slice(-3000)}`);
}

// ── HTTP (paced under the burst throttler) ──────────────────────────────────
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
const msg = (r) => `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 500)}`;
const sj = async (url, init = {}) => { const r = await fetch(url, init); let b = null; try { b = await r.json(); } catch { /* html */ } return { status: r.status, body: b }; };
/** What a compromised portal can do: post any plan it likes to the signer's internal policy route. */
const underPolicy = (pid, body) => sj(`${INTERNAL}/internal/v1/policies/${pid}/plans`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
async function until(f, ms = 30_000) {
  const t0 = Date.now();
  for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(500); }
}

// ── A simulated computer ────────────────────────────────────────────────────
const ACTIONS = ['windows.update.install@1', 'windows.reboot.schedule@1', 'windows.reboot.cancel@1'];
const PENDING = { values: ['SYSTEM\\CurrentControlSet\\Control\\Session Manager|PendingFileRenameOperations'] };
function sim(pc, args, bin = SIM) { return execFileSync(bin, ['-wua', pc.wua, '-registry', pc.reg, '-portal', `127.0.0.1:${PORT}`, ...args], { encoding: 'utf8' }); }
const scan = (pc) => JSON.parse(sim(pc, ['-scan', '-state', pc.state, '-rustdesk-id', pc.rid, '-secret', pc.secret]).trim());
const heartbeat = (pc, extra = {}) => req('POST', '/enrollment/heartbeat', {
  body: { rustdeskId: pc.rid, agentSecret: pc.secret, hostname: pc.hostname, platform: 'Windows', updateChannel: 'signed', agentVersion: pc.version ?? '0.54.0', agentActions: ACTIONS, agentSha256: AGENT_SHA, ...extra },
});
function resultsOf(pc) {
  const d = path.join(pc.state, 'actions', 'results');
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => /^[0-9a-f]{32}\.json$/.test(f)).map((f) => JSON.parse(readFileSync(path.join(d, f), 'utf8')));
}
function clearAcked(pc, acks) { for (const a of acks ?? []) rmSync(path.join(pc.state, 'actions', 'results', `${a}.json`), { force: true }); }
function runAgent(pc, jobId, envelope, extra = [], { bin = SIM, state = pc.state } = {}) {
  const envFile = path.join(work, `env-${jobId}-${hex(3)}.json`);
  writeFileSync(envFile, JSON.stringify(envelope));
  const out = sim(pc, ['-state', state, '-keys', keysFile, '-job', jobId, '-envelope', envFile, '-rustdesk-id', pc.rid, '-secret', pc.secret, '-product-type', '1', '-self-sha', AGENT_SHA, ...extra], bin);
  return JSON.parse(out.trim());
}
async function report(pc) {
  const hb = await heartbeat(pc, { actionResults: resultsOf(pc), patchPosture: scan(pc) });
  clearAcked(pc, hb.body?.data?.actionAcks);
  return hb;
}
const envelopeFor = async (pc, jobId) => ((await heartbeat(pc)).body?.data?.actions ?? []).find((a) => a.jobId === jobId);
const hhmm = (t) => `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`;
const ALL_DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const win = (fromMin, toMin) => ({ days: ALL_DAYS, start: hhmm(new Date(Date.now() + fromMin * 60_000)), end: hhmm(new Date(Date.now() + toMin * 60_000)), timezone: 'UTC' });

const created = { businesses: [], users: [] };

async function all() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });
  const leftovers = await prisma.patchPolicy.count({ where: { status: { in: ['ACTIVE', 'AWAITING_APPROVAL'] } } });
  if (leftovers) throw new Error(`refusing: this database already has ${leftovers} live patch polic(y/ies), and this suite runs the sweep, which acts on all of them`);

  section('Fixtures (synthetic): Acme, in direct mode, with seven computers');
  const acme = await prisma.customer.create({ data: { tenantId: tenant.id, name: `RW Acme ${sfx}` } });
  created.businesses.push(acme.id);
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const owen = await prisma.user.create({ data: { email: `rw-owen-${sfx}@test.invalid`, passwordHash: hash, firstName: 'RW', lastName: 'Owen', status: 'ACTIVE' } });
  created.users.push(owen.id);
  await prisma.membership.create({ data: { userId: owen.id, tenantId: tenant.id, customerId: acme.id, roleId: roleOwner.id, capabilities: [] } });
  const mkPc = async (hostname, reg = {}, version = '0.54.0') => {
    const e = await prisma.endpoint.create({ data: { tenantId: tenant.id, customerId: acme.id, name: hostname, hostname, status: 'ACTIVE', isOnline: true, isManaged: true, accessMode: 'COMPANY_WIDE', lastSeenAt: new Date(), deviceClass: 'WORKSTATION' } });
    const rid = String(100000000 + ((Math.random() * 899999999) | 0));
    const secret = hex(24);
    await prisma.rustdeskNode.create({ data: { tenantId: tenant.id, endpointId: e.id, rustdeskId: rid, agentSecretHash: sha(secret) } });
    const state = path.join(work, `pc-${e.id}`); mkdirSync(state);
    const pc = { id: e.id, rid, secret, state, hostname, version, wua: path.join(state, 'wua.json'), reg: path.join(state, 'registry.json') };
    writeFileSync(pc.wua, JSON.stringify({ offered: [], installed: [], superseded: [], history: [] }));
    writeFileSync(pc.reg, JSON.stringify(reg));
    return pc;
  };
  const pend = await mkPc('RW-PENDING', PENDING);   // DS-HOME1's case: a pending file rename
  const clean = await mkPc('RW-CLEAN');             // nothing pending
  const sess = await mkPc('RW-SESSION', PENDING);   // pending, a technician connected
  const ovr = await mkPc('RW-OVERRIDE', PENDING);   // pending, a technician connected, policy has the exception
  const shut = await mkPc('RW-CLOSED', PENDING);    // pending, its policy's restart window is closed
  const sched = await mkPc('RW-SCHEDULED');
  const old = await mkPc('RW-OLD-AGENT', PENDING, '0.53.1');
  const all7 = [pend, clean, sess, ovr, shut, sched, old];
  check(true, 'RW-PENDING, RW-CLEAN, RW-SESSION, RW-OVERRIDE, RW-CLOSED, RW-SCHEDULED and RW-OLD-AGENT (reports 0.53.1)');

  const set = signerCli(['policy', 'set', '--business', acme.id, '--approval', 'direct']);
  if (set.status !== 0) throw new Error(`direct mode: ${set.stderr}`);
  start('signer', path.join(dist, 'approval-signer', 'main.js'), signerEnv);
  start('api', path.join(dist, 'main.js'), apiEnv);
  await waitUp(`${INTERNAL}/internal/v1/keys`, 'signer');
  await waitUp(`${API}/health`, 'api');
  let S = await stepUp(await login(owen.email));
  const as = () => ({ s: S, business: acme.id });
  for (const pc of all7) await heartbeat(pc, { patchPosture: scan(pc) });
  const tasksOf = async (pc) => (await req('GET', `/endpoints/${pc.id}/tasks`, as())).body?.data?.tasks ?? [];

  section('Restart now, at a time, or only if required — from the Actions tab');
  {
    // Only if required: RW-CLEAN has nothing pending, so the agent changes nothing.
    let r = await req('POST', `/endpoints/${clean.id}/actions`, { ...as(), body: { actionId: 'windows.reboot.schedule', version: 1, params: { delayMinutes: 15, onlyIfRequired: true }, reason: 'Only if it needs one', windowHours: 2 } });
    const j1 = r.body?.data;
    check(r.status === 201 && j1?.direct === true && j1.params?.onlyIfRequired === true, 'a restart "only if required" is an ordinary windows.reboot.schedule plan carrying onlyIfRequired', msg(r));
    let env = await envelopeFor(clean, j1.id);
    let out = env ? runAgent(clean, j1.id, env.envelope) : null;
    check(out?.outcome === 'no_change' && out.reason === 'no_restart_required', 'the agent reads Windows itself: nothing pending → no_change, no_restart_required, not restarted', JSON.stringify(out));
    await report(clean);
    const t = (await tasksOf(clean)).find((x) => x.jobId === j1.id || x.id?.includes(j1.id));
    check(!!t, 'the Tasks panel shows it', JSON.stringify((await tasksOf(clean)).map((x) => [x.type, x.state])));

    // A false flag, or any other key, is refused by the portal.
    r = await req('POST', `/endpoints/${clean.id}/actions`, { ...as(), body: { actionId: 'windows.reboot.schedule', version: 1, params: { delayMinutes: 15, ignoreRemoteSession: false }, reason: 'false flag', windowHours: 2 } });
    check(r.status === 400, 'ignoreRemoteSession: false is refused (present only when true)', msg(r));
    r = await req('POST', `/endpoints/${clean.id}/actions`, { ...as(), body: { actionId: 'windows.reboot.schedule', version: 1, params: { delayMinutes: 15, ignoreSignedInUser: true }, reason: 'unknown key', windowHours: 2 } });
    check(r.status === 400, 'an unknown restart parameter is refused', msg(r));

    // At a time: notBefore is the time minus the warning.
    const far = await req('POST', `/endpoints/${sched.id}/actions`, { ...as(), body: { actionId: 'windows.reboot.schedule', version: 1, params: { delayMinutes: 15 }, reason: 'too far', windowHours: 2, restartAt: { local: new Date(Date.now() + 15 * 86_400_000).toISOString().slice(0, 16), timeZone: 'UTC' } } });
    check(far.status === 400 && code(far) === 'SCHEDULE_TOO_FAR', 'more than 14 days ahead → SCHEDULE_TOO_FAR', msg(far));
    const both = await req('POST', `/endpoints/${sched.id}/actions`, { ...as(), body: { actionId: 'windows.reboot.schedule', version: 1, params: { delayMinutes: 15 }, reason: 'both', windowHours: 2, startsInMinutes: 10, restartAt: { local: new Date(Date.now() + 3600_000).toISOString().slice(0, 16), timeZone: 'UTC' } } });
    check(both.status === 400, 'a time and startsInMinutes together are refused', msg(both));
    const notR = await req('POST', `/endpoints/${sched.id}/actions`, { ...as(), body: { actionId: 'windows.service.restart', version: 1, params: { service: 'Spooler' }, reason: 'not a restart', windowHours: 2, restartAt: { local: new Date(Date.now() + 3600_000).toISOString().slice(0, 16), timeZone: 'UTC' } } });
    check(notR.status === 400, 'restartAt applies only to windows.reboot.schedule', msg(notR));
    const at = new Date(Math.ceil((Date.now() + 5.4 * 60_000) / 60_000) * 60_000); // the restart; the warning (5 min) starts within the next minute
    r = await req('POST', `/endpoints/${sched.id}/actions`, { ...as(), body: { actionId: 'windows.reboot.schedule', version: 1, params: { delayMinutes: 5 }, reason: 'Tonight, after the backup', windowHours: 2, restartAt: { local: at.toISOString().slice(0, 16), timeZone: 'UTC' } } });
    const j2 = r.body?.data;
    const row = j2 ? await prisma.actionJob.findUnique({ where: { id: j2.id } }) : null;
    check(r.status === 201 && row && row.notBefore.getTime() === at.getTime() - 5 * 60_000 && row.plan.window.notBefore === row.notBefore.toISOString(),
      `restart at ${at.toISOString().slice(11, 16)} UTC: the signed plan opens the 5-minute warning before it`, msg(r));
    check(row && row.notAfter.getTime() - row.notBefore.getTime() === 2 * 3600_000, 'and runs for at most 2 hours', JSON.stringify(row?.plan?.window));
    const audit = await prisma.activityLog.findFirst({ where: { action: 'ACTION_REQUESTED', resourceId: j2?.id } });
    check(audit?.metadata?.notBefore === row?.notBefore.toISOString(), 'the audit entry records when it starts', JSON.stringify(audit?.metadata));
    const st = (await tasksOf(sched)).find((x) => x.type === 'restart');
    check(st?.stage === 'scheduled' && st.cancelJobId === j2.id, 'Tasks: scheduled, and cancelable with the existing cancel', JSON.stringify(st));
    check(!(await envelopeFor(sched, j2.id)), 'the heartbeat before notBefore hands nothing out');
    const wait = row.notBefore.getTime() - Date.now() + 1500;
    console.log(`      (waiting ${Math.max(0, Math.round(wait / 1000))} s for the scheduled time)`);
    if (wait > 0) await sleep(wait);
    env = await envelopeFor(sched, j2.id);
    out = env ? runAgent(sched, j2.id, env.envelope) : null;
    check(out?.outcome === 'succeeded' && out.observed?.delayMinutes === '5' && Math.abs(Date.parse(out.observed?.scheduledFor) - at.getTime()) < 90_000, 'after notBefore it is handed out, and the restart is scheduled for the chosen time', JSON.stringify(out));
    await report(sched);
  }

  section('An older agent: the portal refuses the flags, and the 0.53 agent refuses such a plan itself');
  {
    let r = await req('POST', `/endpoints/${old.id}/actions`, { ...as(), body: { actionId: 'windows.reboot.schedule', version: 1, params: { delayMinutes: 15, ignoreRemoteSession: true }, reason: 'override on an old agent', windowHours: 2 } });
    check(r.status === 409 && code(r) === 'ENDPOINT_NOT_READY' && /0\.54/.test(JSON.stringify(r.body)), 'the exception on a 0.53.1 agent → ENDPOINT_NOT_READY, needs 0.54', msg(r));
    r = await req('POST', `/endpoints/${old.id}/actions`, { ...as(), body: { actionId: 'windows.reboot.schedule', version: 1, params: { delayMinutes: 15, onlyIfRequired: true }, reason: 'only if on an old agent', windowHours: 2 } });
    check(r.status === 409 && code(r) === 'ENDPOINT_NOT_READY', '…and so is onlyIfRequired', msg(r));
    r = await req('POST', `/endpoints/${old.id}/actions`, { ...as(), body: { actionId: 'windows.reboot.schedule', version: 1, params: { delayMinutes: 15 }, reason: 'a plain restart on an old agent', windowHours: 2 } });
    check(r.status === 201, 'a plain restart is still fine on it', msg(r));
    if (r.status === 201) await req('POST', `/actions/${r.body.data.id}/cancel`, as());
  }

  section('Bulk "Schedule restart": a selection and a device group, one plan per computer');
  let bulkJobs = [];
  {
    const grp = await prisma.endpointGroup.create({ data: { tenantId: tenant.id, customerId: acme.id, name: `RW group ${sfx}` } });
    await prisma.endpointGroupMember.create({ data: { endpointGroupId: grp.id, endpointId: clean.id } });
    let r = await req('POST', '/endpoints/bulk', { ...as(), body: { action: 'restart.schedule', endpointIds: [clean.id], restart: { delayMinutes: 30 } } });
    check(r.status === 400 && code(r) === 'REASON_REQUIRED', 'a reason is required', msg(r));
    r = await req('POST', '/endpoints/bulk', { ...as(), body: { action: 'restart.schedule', endpointIds: [clean.id], reason: 'no options' } });
    check(r.status === 400, 'the restart options are required', msg(r));
    r = await req('POST', '/endpoints/bulk', { ...as(), body: { action: 'inventory.refresh', endpointIds: [clean.id], restart: { delayMinutes: 30 } } });
    check(r.status === 400, '…and apply only to restart.schedule', msg(r));
    r = await req('POST', '/endpoints/bulk', { ...as(), body: { action: 'restart.schedule', endpointIds: [clean.id, old.id], reason: 'Month end', restart: { delayMinutes: 30, onlyIfRequired: true } } });
    const res = Object.fromEntries((r.body?.data?.results ?? []).map((x) => [x.endpointId, x]));
    check(r.status === 200 && res[clean.id]?.ok && !!res[clean.id].jobId && res[old.id]?.ok === false && res[old.id].code === 'ENDPOINT_NOT_READY', 'a selection: RW-CLEAN gets its own plan; the 0.53 agent is refused on its own, with the reason', msg(r));
    if (res[clean.id]?.jobId) bulkJobs.push(res[clean.id].jobId);
    const j = res[clean.id]?.jobId ? await prisma.actionJob.findUnique({ where: { id: res[clean.id].jobId } }) : null;
    check(j?.actionId === 'windows.reboot.schedule' && j.plan.targets.length === 1 && j.plan.params.delayMinutes === 30 && j.plan.params.onlyIfRequired === true, 'the plan is the single computer\'s windows.reboot.schedule, with the chosen options', JSON.stringify(j?.plan?.params));
    r = await req('POST', '/endpoints/bulk', { ...as(), body: { action: 'restart.schedule', targetGroupId: grp.id, reason: 'Month end, by group', restart: { delayMinutes: 30 } } });
    const gr = r.body?.data?.results?.[0];
    check(r.status === 200 && r.body.data.target?.id === grp.id && gr?.endpointId === clean.id && gr.ok === false && /already open|one at a time|ACTION_PENDING|open/i.test(`${gr.code} ${gr.reason}`),
      'a device group resolves to its members; RW-CLEAN already has an open restart, so it is refused one at a time', msg(r));
    for (const id of bulkJobs) await req('POST', `/actions/${id}/cancel`, as());
    r = await req('POST', '/endpoints/bulk', { ...as(), body: { action: 'restart.schedule', targetGroupId: grp.id, reason: 'Month end, by group', restart: { delayMinutes: 30 } } });
    check(r.status === 200 && r.body?.data?.results?.[0]?.ok === true, '…and once that one is canceled, the group request plans it', msg(r));
    const gj = r.body?.data?.results?.[0]?.jobId;
    if (gj) await req('POST', `/actions/${gj}/cancel`, as());
  }

  section('Patch policies with restart windows, proposed here and active at once (direct mode)');
  const mkPolicy = async (name, pc, restart, extra = {}) => {
    const r = await req('POST', '/patching/policies', { ...as(), body: {
      businessId: acme.id, name, rings: [[pc.id]], allow: { classifications: ['0fa1201d-4330-4fa8-8ae9-b877473b6441'] }, soakHours: 0, failureThreshold: 0,
      // The install window is hours away: this suite is about the restart window.
      window: win(8 * 60, 9 * 60), expiresInDays: 30, reason: 'Restart window test', ...(restart ? { restart } : {}), ...extra,
    } });
    return r;
  };
  let polA, polB, polC;
  {
    let r = await mkPolicy('Bad rule', pend, { rule: 'sometimes', window: win(-60, 180) });
    check(r.status === 400, 'an unknown restart rule is refused', msg(r));
    r = await mkPolicy('Exception, no restart', pend, null, { ignoreRemoteSession: true });
    check(r.status === 400 && /override_without_restart|never restarts/.test(JSON.stringify(r.body)), 'the exception on a policy that never restarts is refused', msg(r));
    r = await mkPolicy('If required, now', pend, { rule: 'if_required', window: win(-60, 180) }, { rings: [[pend.id], [clean.id, sess.id]] });
    polA = r.body?.data;
    check(r.status === 201 && polA?.status === 'ACTIVE' && polA.document?.restart?.rule === 'if_required' && !('ignoreRemoteSession' in (polA.document ?? {})), 'policy A: restart if required, in a window open now; no exception', msg(r));
    r = await mkPolicy('Maintenance restart, with the exception', ovr, { rule: 'always', window: win(-60, 180) }, { ignoreRemoteSession: true });
    polB = r.body?.data;
    check(r.status === 201 && polB?.status === 'ACTIVE' && polB.document?.ignoreRemoteSession === true, 'policy B: a maintenance restart, with the RustDesk exception', msg(r));
    r = await mkPolicy('If required, later', shut, { rule: 'if_required', window: win(5 * 60, 6 * 60) });
    polC = r.body?.data;
    check(r.status === 201 && polC?.status === 'ACTIVE', 'policy C: its restart window opens in 5 hours', msg(r));
    const list = (await req('GET', `/patching/policies?businessId=${acme.id}`, as())).body?.data ?? [];
    const la = list.find((x) => x.id === polA?.id);
    check(/^Installs: Every day \d\d:\d\d–\d\d:\d\d UTC · Restarts: if required, Every day \d\d:\d\d–\d\d:\d\d UTC$/.test(la?.schedule ?? ''), 'the policy list says the schedule in plain words', la?.schedule);
    check(!!list.find((x) => x.id === polC?.id)?.nextRestartWindow, '…and the next restart window', JSON.stringify(list.find((x) => x.id === polC?.id)));
  }

  section('The sweep: a restart plan inside the window, only for computers Windows says need one');
  let aJob, sJob;
  {
    const rowOf = (pc) => prisma.patchPolicyRestart.findFirst({ where: { endpointId: pc.id, code: 'signed' }, orderBy: { createdAt: 'desc' } });
    const a = await until(() => rowOf(pend));
    const s = await until(() => rowOf(sess));
    check(!!a && !!s, 'within a few sweeps RW-PENDING and RW-SESSION each have a restart plan signed under policy A', JSON.stringify(await prisma.patchPolicyRestart.findMany({ where: { policyId: polA?.id } })));
    aJob = a && await prisma.actionJob.findUnique({ where: { id: a.jobId } });
    sJob = s && await prisma.actionJob.findUnique({ where: { id: s.jobId } });
    const p = aJob?.plan;
    check(p?.action?.id === 'windows.reboot.schedule' && JSON.stringify(p.params) === JSON.stringify({ delayMinutes: 15, onlyIfRequired: true }), 'the plan: windows.reboot.schedule, the fixed 15-minute warning, onlyIfRequired, no exception', JSON.stringify(p?.params));
    check(p?.display?.policy?.id === polA.id && p.display.deployment === null && p.display.updates.length === 0 && p.targets.length === 1, 'it names the policy, no deployment or update, and one computer', JSON.stringify(p?.display));
    const occ = { end: Date.now() + 180 * 60_000 };
    check(Date.parse(p?.window?.notAfter) + 15 * 60_000 <= occ.end + 60_000, 'it closes in time for the restart to fall inside the window', JSON.stringify(p?.window));
    await sleep(5000);
    check((await prisma.patchPolicyRestart.count({ where: { endpointId: clean.id } })) === 0, 'RW-CLEAN (no restart required) gets none');
    check((await prisma.patchPolicyRestart.count({ where: { endpointId: shut.id } })) === 0, 'RW-CLOSED (its policy\'s restart window is closed) gets none');
    const ep = (await req('GET', `/endpoints/${pend.id}/patch-policy`, as())).body?.data;
    check(/^Restart planned/.test(ep?.restart?.text ?? ''), 'the Patches tab says "Restart planned …"', ep?.restart?.text);
    const epC = (await req('GET', `/endpoints/${shut.id}/patch-policy`, as())).body?.data;
    check(/planned in the next restart window/.test(epC?.restart?.text ?? ''), '…and for RW-CLOSED, "planned in the next restart window"', epC?.restart?.text);
  }

  section('The agent: restart (pending), or defer (a technician connected through RustDesk)');
  {
    let env = await envelopeFor(pend, aJob.id);
    let out = env ? runAgent(pend, aJob.id, env.envelope) : null;
    check(out?.outcome === 'succeeded' && out.observed?.delayMinutes === '15' && !!out.observed?.scheduledFor && out.observed?.sessionOverride === undefined, 'RW-PENDING: a restart is pending, nobody is connected → scheduled with the 15-minute warning', JSON.stringify(out));
    await report(pend);
    env = await envelopeFor(sess, sJob.id);
    out = env ? runAgent(sess, sJob.id, env.envelope, ['-sessions', '1']) : null;
    check(out?.outcome === 'not_executed' && out.reason === 'remote_session_open', 'RW-SESSION, a technician connected (sim -sessions 1), no exception → not restarted (remote_session_open)', JSON.stringify(out));
    await report(sess);
    const t = (await tasksOf(sess)).find((x) => x.type === 'restart');
    check(/technician was connected through RustDesk/.test(t?.text ?? '') && !/signed in/i.test(t?.text ?? ''), 'Tasks says a technician was connected through RustDesk — not "someone signed in"', t?.text);
  }

  section('A deferred restart is asked for again later in the window');
  {
    const first = await prisma.patchPolicyRestart.findFirst({ where: { endpointId: sess.id }, orderBy: { attempt: 'asc' } });
    await sleep(4000);
    check((await prisma.patchPolicyRestart.count({ where: { endpointId: sess.id } })) === 1, 'not at once: the sweep waits 15 minutes before trying again');
    // A policy restart plan lasts 15 minutes, and the next attempt waits 15:
    // the signer counts a plan open until its notAfter, since it cannot know
    // the agent deferred it.
    const j1 = await prisma.actionJob.findUnique({ where: { id: first.jobId } });
    check(j1.notAfter.getTime() - j1.notBefore.getTime() <= 15 * 60_000, 'a policy restart plan is valid for 15 minutes, no longer than the wait before the next attempt', JSON.stringify(j1.plan.window));
    // Fifteen minutes pass. Time is moved where each side reads it: the
    // portal's attempt row (updatedAt) and the signer's ledger entry
    // (notAfter) — the ledger is the signer's own file, not part of what the
    // approvers signed.
    await prisma.$executeRawUnsafe('UPDATE "PatchPolicyRestart" SET "updatedAt" = now() - interval \'16 minutes\' WHERE id = $1', first.id);
    const recFile = path.join(signerDir, 'policies', `${polA.id}.json`);
    const rec = JSON.parse(readFileSync(recFile, 'utf8'));
    for (const e of rec.ledger) if (e.jobId === first.jobId) e.notAfter = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(recFile, JSON.stringify(rec));
    const second = await until(() => prisma.patchPolicyRestart.findFirst({ where: { endpointId: sess.id, attempt: 2, code: 'signed' } }));
    check(!!second, 'attempt 2: a new plan is signed in the same window', JSON.stringify(await prisma.patchPolicyRestart.findMany({ where: { endpointId: sess.id } })));
    if (second) {
      const env = await envelopeFor(sess, second.jobId);
      const out = env ? runAgent(sess, second.jobId, env.envelope) : null;
      check(out?.outcome === 'succeeded', 'the technician has gone: this time it restarts', JSON.stringify(out));
      await report(sess);
    }
    // The ledger keeps the window's attempts: the signer itself refuses a fourth.
    const fresh = await prisma.patchPolicyRestart.count({ where: { endpointId: pend.id } });
    check(fresh === 1, 'RW-PENDING, restarted, is not asked again in this window', String(fresh));
  }

  section('The RustDesk exception: a policy that has it restarts anyway, and says so');
  {
    const row = await until(() => prisma.patchPolicyRestart.findFirst({ where: { endpointId: ovr.id, code: 'signed' } }));
    const j = row && await prisma.actionJob.findUnique({ where: { id: row.jobId } });
    check(JSON.stringify(j?.plan?.params) === JSON.stringify({ delayMinutes: 15, ignoreRemoteSession: true }), 'policy B\'s plan: the fixed warning and the exception, no onlyIfRequired (a maintenance restart)', JSON.stringify(j?.plan?.params));
    const req0 = j && await prisma.activityLog.findFirst({ where: { action: 'ACTION_REQUESTED', resourceId: j.id } });
    check(req0?.metadata?.ignoreRemoteSession === true, 'the request\'s audit entry says the exception was asked for', JSON.stringify(req0?.metadata));
    // The 0.53 agent, handed the same plan: it refuses it (the agent must be published before anyone uses the option).
    if (OLD_SIM) {
      const env0 = await envelopeFor(ovr, j.id);
      const copy = path.join(work, `old-${ovr.id}`); cpSync(ovr.state, copy, { recursive: true });
      const o0 = env0 ? runAgent(ovr, j.id, env0.envelope, ['-sessions', '1'], { bin: OLD_SIM, state: copy }) : null;
      check(o0?.outcome === 'refused' && o0.reason === 'params_not_allowed', 'the 0.53 agent refuses a plan carrying the exception (params_not_allowed)', JSON.stringify(o0));
    } else console.log('      (PRE054_ACTION_SIM not set: the 0.53 agent\'s own refusal is proven by the Go test TestRestartFlagsAreClosed)');
    const env = await envelopeFor(ovr, j.id);
    const out = env ? runAgent(ovr, j.id, env.envelope, ['-sessions', '1']) : null;
    check(out?.outcome === 'succeeded' && out.observed?.sessionOverride === 'true' && out.observed?.remoteSessions === '1' && out.observed?.delayMinutes === '15',
      'a technician connected (sim -sessions 1), the exception signed → restarts anyway, after the same 15-minute warning, and records it', JSON.stringify(out));
    await report(ovr);
    const res = j && await prisma.activityLog.findFirst({ where: { action: 'ACTION_RESULT', resourceId: j.id } });
    check(res?.metadata?.sessionOverride === true && res.metadata.remoteSessions === '1', 'the result\'s audit entry records that the exception was used', JSON.stringify(res?.metadata));
    const t = (await tasksOf(ovr)).find((x) => x.type === 'restart');
    check(/restarted although a technician was connected through RustDesk/.test(t?.text ?? ''), 'Tasks: "restarted although a technician was connected through RustDesk"', t?.text);
    const det = (await req('GET', `/patching/policies/${polB.id}`, as())).body?.data;
    check(det?.restarts?.some((x) => x.endpointId === ovr.id && x.sessionOverride), 'the policy page lists the restart and that the exception was used', JSON.stringify(det?.restarts));
  }

  section('The signer refuses what a compromised portal might send under a policy');
  {
    const base = aJob.plan;
    const craft = (over) => ({ ...base, jobId: hex(16), createdAt: new Date().toISOString(), window: { notBefore: new Date().toISOString(), notAfter: new Date(Date.now() + 3600_000).toISOString() }, ...over });
    let r = await underPolicy(polA.id, { plan: craft({ params: { ...base.params, ignoreRemoteSession: true } }), policyDigest: polA.digest, evidence: null });
    check(r.status === 409 && r.body?.error === 'override_not_allowed', 'the exception under a policy without it → override_not_allowed', JSON.stringify(r.body));
    r = await underPolicy(polA.id, { plan: craft({ params: { delayMinutes: 5, onlyIfRequired: true } }), policyDigest: polA.digest, evidence: null });
    check(r.status === 409 && r.body?.error === 'restart_params_not_allowed', 'a shorter warning → restart_params_not_allowed', JSON.stringify(r.body));
    r = await underPolicy(polA.id, { plan: craft({ params: { delayMinutes: 15 } }), policyDigest: polA.digest, evidence: null });
    check(r.status === 409 && r.body?.error === 'restart_params_not_allowed', '"if required" without onlyIfRequired → restart_params_not_allowed', JSON.stringify(r.body));
    const late = Date.now() + 4 * 3600_000;
    r = await underPolicy(polA.id, { plan: craft({ window: { notBefore: new Date(late).toISOString(), notAfter: new Date(late + 3600_000).toISOString() } }), policyDigest: polA.digest, evidence: null });
    check(r.status === 409 && r.body?.error === 'outside_restart_window', 'a restart after the restart window → outside_restart_window', JSON.stringify(r.body));
    const cBase = { ...base, targets: [{ ...base.targets[0], endpointId: shut.id, hostname: shut.hostname, rustdeskId: shut.rid, deviceSecretSha256: sha(shut.secret) }], display: { ...base.display, policy: { ...base.display.policy, id: polC.id, digest: polC.digest } } };
    r = await underPolicy(polC.id, { plan: { ...craft({}), targets: cBase.targets, display: cBase.display }, policyDigest: polC.digest, evidence: null });
    check(r.status === 409 && r.body?.error === 'outside_restart_window', 'policy C, whose restart window is closed → outside_restart_window', JSON.stringify(r.body));
    r = await underPolicy(polA.id, { plan: craft({}), policyDigest: polA.digest, evidence: null });
    check(r.status === 409 && r.body?.error === 'restart_already_signed', 'RW-PENDING again while its plan is open → restart_already_signed (the signer\'s own ledger)', JSON.stringify(r.body));
    r = await underPolicy(polA.id, { plan: craft({ targets: [{ ...base.targets[0], endpointId: ovr.id, hostname: ovr.hostname, rustdeskId: ovr.rid, deviceSecretSha256: sha(ovr.secret) }] }), policyDigest: polA.digest, evidence: null });
    check(r.status === 409 && r.body?.error === 'computer_not_in_policy', 'a computer in another policy → computer_not_in_policy', JSON.stringify(r.body));
  }
}

async function cleanup() {
  await stop('api'); await stop('signer');
  try {
    if (created.businesses.length) {
      await prisma.patchPolicyRestart.deleteMany({ where: { customerId: { in: created.businesses } } });
      await prisma.actionJob.deleteMany({ where: { customerId: { in: created.businesses } } });
      await prisma.patchDeployment.deleteMany({ where: { customerId: { in: created.businesses } } });
      await prisma.patchPolicyComputer.deleteMany({ where: { customerId: { in: created.businesses } } });
      await prisma.patchPolicy.updateMany({ where: { customerId: { in: created.businesses } }, data: { status: 'REVOKED', revokedAt: new Date() } });
      await prisma.patchPolicy.deleteMany({ where: { customerId: { in: created.businesses } } });
      const eps = await prisma.endpoint.findMany({ where: { customerId: { in: created.businesses } }, select: { id: true } });
      await prisma.endpointCommand.deleteMany({ where: { endpointId: { in: eps.map((e) => e.id) } } });
      await prisma.rustdeskNode.deleteMany({ where: { endpointId: { in: eps.map((e) => e.id) } } });
      await prisma.endpointGroup.deleteMany({ where: { customerId: { in: created.businesses } } });
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
