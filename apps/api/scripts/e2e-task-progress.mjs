#!/usr/bin/env node
/**
 * End-to-end proof of task progress and scheduled installs (0.52).
 *
 * The case it was built for: on DEWEY-WKS2022 an update install was
 * requested, handed out two minutes later, delivered four times and answered
 * fourteen minutes after the request — eight updates installed, restart
 * required — while the Patches tab still showed the old list and nothing
 * else. This replays that against the real API, the real approval signer and
 * the agent's real decision code (rem0te-action-sim) over a simulated Windows
 * Update, and checks every read the console now makes:
 *
 *   - queued → handed out → result, as the computer's Tasks panel, the Tasks
 *     page and the Patches tab's banner each show it;
 *   - the overdue sentence;
 *   - the toast poll (GET /tasks/mine);
 *   - visibility: another business's tasks never appear, by list or by id;
 *   - a scheduled install: signed with its notBefore, not handed out before
 *     it, refused by the agent before it (not consumed), handed out after it;
 *   - cancelling a scheduled install that reached no computer, and not one
 *     that did;
 *   - the banner's Schedule restart going through windows.reboot.schedule,
 *     and the scan it asks for after the restart.
 *
 *   cd apps/api && npx nest build
 *   RELEASE_BIN=…/rem0te-release ACTION_SIM=…/rem0te-action-sim \
 *   DATABASE_URL=postgresql://…/<name containing scratch or test> node scripts/e2e-task-progress.mjs
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
const PORT = Number(process.env.TASKS_API_PORT ?? 3781);
const SIGNER_PUBLIC = Number(process.env.TASKS_SIGNER_PUBLIC_PORT ?? 3782);
const SIGNER_INTERNAL = Number(process.env.TASKS_SIGNER_INTERNAL_PORT ?? 3783);
if ([PORT, SIGNER_PUBLIC, SIGNER_INTERNAL].some((p) => [3000, 3001, 443, 3201, 3202, 4000, 4001].includes(p))) { console.error('refusing a production port'); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
const ORIGIN = `http://127.0.0.1:${SIGNER_PUBLIC}`;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'tasks-e2e-password-123';

let pass = 0, fail = 0; const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;
const sha = (b) => createHash('sha256').update(b).digest('hex');

// ── Updates as Windows Update describes them ────────────────────────────────
const SEC = '0fa1201d-4330-4fa8-8ae9-b877473b6441', UPD = 'cd5ffd1e-e932-4e3a-bf74-18bf0b1bbd83', DEF = 'e0789628-ce08-4437-be74-2495b842f43b';
const u = (updateId, revision, kb, title, classification, className, extra = {}) => ({ updateId, revision, kb, title, classification, className, severity: classification === SEC ? 'Critical' : '', downloaded: false, rebootBehavior: 1, userInput: false, eulaAccepted: true, browseOnly: false, sizeBytes: 600 << 20, ...extra });
const CU = u('5a1b2c3d-0000-4000-8000-000000000101', 201, 'KB5135243', '2026-11 Cumulative Update for Microsoft server operating system (KB5135243)', SEC, 'Security Updates');
const MSRT = u('5a1b2c3d-0000-4000-8000-000000000102', 3, 'KB890830', 'Windows Malicious Software Removal Tool x64 - v5.137 (KB890830)', UPD, 'Updates', { rebootBehavior: 0 });
const DEFS = u('5a1b2c3d-0000-4000-8000-000000000103', 7, 'KB2267602', 'Security Intelligence Update for Microsoft Defender Antivirus - KB2267602', DEF, 'Definition Updates', { rebootBehavior: 0 });
const id = (x) => ({ updateId: x.updateId, revision: x.revision });
const key = (x) => `${x.updateId}@${x.revision}`;

// ── The release machine ─────────────────────────────────────────────────────
const work = mkdtempSync(path.join(tmpdir(), 'rem0te-tasks-'));
const keys = path.join(work, 'keys'); mkdirSync(keys);
const repo = path.join(work, 'repo');
const files = path.join(work, 'files'); mkdirSync(files);
const signerDir = path.join(work, 'signer'); mkdirSync(signerDir, { mode: 0o700 });
const rel = (...a) => execFileSync(BIN, a, { encoding: 'utf8' });
const signerCli = (args) => spawnSync(process.execPath, [path.join(dist, 'approval-signer', 'main.js'), ...args], { encoding: 'utf8', env: { ...process.env, APPROVAL_SIGNER_DIR: signerDir } });
for (const k of ['r1', 'targets', 'snapshot', 'timestamp']) rel('keygen', '-out', path.join(keys, `${k}.pem`));
rel('init', '-repo', repo, '-root-key', path.join(keys, 'r1.pem'), '-root-threshold', '1', '-targets-key', path.join(keys, 'targets.pem'), '-snapshot-key', path.join(keys, 'snapshot.pem'), '-timestamp-key', path.join(keys, 'timestamp.pem'));
const agentBin = Buffer.concat([Buffer.from('MZ stand-in signed agent 0.52 '), randomBytes(64), Buffer.from('REM0TE_INST_URL:'), Buffer.alloc(240)]);
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
  APPROVAL_SIGNER_INTERNAL_URL: `http://127.0.0.1:${SIGNER_INTERNAL}`,
  JWT_SECRET: randomBytes(32).toString('hex'), LAUNCHER_TOKEN_SECRET: randomBytes(32).toString('hex'),
  ENCRYPTION_KEY: randomBytes(32).toString('hex'), TRUSTED_PROXIES: 'loopback',
  VERSION_FILE: path.resolve(here, '..', '..', '..', 'version.json'),
  MONITOR_SWEEP: 'off', CLIENT_UPDATE_SWEEP: 'off', PATCH_POLICY_SWEEP: 'off', METRIC_SWEEP: 'off', RETENTION_SWEEP: 'off', REPORT_SCHEDULE_SWEEP: 'off',
  CHAT_RETENTION_SWEEP: 'off', TRAY_SWEEP: 'off', SCRIPT_OUTPUT_SWEEP: 'off', AUTO_MIGRATION_SWEEP: 'off', WINGET_INDEX_SWEEP: 'off', SNAPSHOT_SWEEP: 'off', AGENT_AUTO_UPDATE: 'off',
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
const msg = (r) => `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 500)}`;
const sj = async (url, init = {}) => { const r = await fetch(url, init); let b = null; try { b = await r.json(); } catch { /* html */ } return { status: r.status, body: b }; };
const signerPost = (jid, p, body) => sj(`${ORIGIN}/approve/${jid}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify(body) });
async function approve(jobId, who) {
  const c = await signerPost(jobId, '/challenge', { decision: 'approve', role: 'approver' });
  if (c.status !== 200) return c;
  return signerPost(jobId, '/decide', { challengeId: c.body.challengeId, assertion: who.assert(c.body.options, { origin: ORIGIN }) });
}

// ── A simulated computer ────────────────────────────────────────────────────
const ACTIONS = ['windows.update.install@1', 'windows.reboot.schedule@1', 'windows.reboot.cancel@1'];
function sim(pc, args) { return execFileSync(SIM, ['-wua', pc.wua, '-registry', pc.reg, '-portal', `127.0.0.1:${PORT}`, ...args], { encoding: 'utf8' }); }
const scan = (pc) => JSON.parse(sim(pc, ['-scan']).trim());
const heartbeat = (pc, extra = {}) => req('POST', '/enrollment/heartbeat', {
  body: { rustdeskId: pc.rid, agentSecret: pc.secret, hostname: pc.hostname, platform: 'Windows', updateChannel: 'signed', agentActions: ACTIONS, agentSha256: AGENT_SHA, ...extra },
});
function resultsOf(pc) {
  const d = path.join(pc.state, 'actions', 'results');
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => /^[0-9a-f]{32}\.json$/.test(f)).map((f) => JSON.parse(readFileSync(path.join(d, f), 'utf8')));
}
function clearAcked(pc, acks) { for (const a of acks ?? []) rmSync(path.join(pc.state, 'actions', 'results', `${a}.json`), { force: true }); }
function runAgent(pc, jobId, envelope, extra = []) {
  const envFile = path.join(work, `env-${jobId}-${randomBytes(3).toString('hex')}.json`);
  writeFileSync(envFile, JSON.stringify(envelope));
  const out = sim(pc, ['-state', pc.state, '-keys', keysFile, '-job', jobId, '-envelope', envFile, '-rustdesk-id', pc.rid, '-secret', pc.secret, '-product-type', '1', '-self-sha', AGENT_SHA, ...extra]);
  return JSON.parse(out.trim());
}
/** The agent reports what it has, without a new scan (the posture stays the pre-install one, as on DEWEY). */
async function report(pc) {
  const hb = await heartbeat(pc, { actionResults: resultsOf(pc) });
  clearAcked(pc, hb.body?.data?.actionAcks);
  return hb;
}
/** UTC wall-clock time, minute precision, `minutes` from now (rounded up to the next whole minute). */
const utcLocal = (minutes) => { const t = new Date(Math.ceil((Date.now() + minutes * 60_000) / 60_000) * 60_000); return { at: t, local: t.toISOString().slice(0, 16) }; };

const created = { businesses: [], users: [] };

async function all() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });

  section('Fixtures (synthetic): Acme with DEWEY, SCHED and SPARE; Birch next door');
  const acme = await prisma.customer.create({ data: { tenantId: tenant.id, name: `TP Acme ${sfx}` } });
  const birch = await prisma.customer.create({ data: { tenantId: tenant.id, name: `TP Birch ${sfx}` } });
  created.businesses.push(acme.id, birch.id);
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag, extra = {}) => { const x = await prisma.user.create({ data: { email: `tp-${tag}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'TP', lastName: tag, status: 'ACTIVE', ...extra } }); created.users.push(x.id); return x; };
  const owen = await mkUser('owen-owner-acme'), bea = await mkUser('bea-owner-birch');
  const olivia = await mkUser('olivia-approver', { platformPermissions: ['technicians:manage'] }), quinn = await mkUser('quinn-approver', { platformPermissions: ['technicians:manage'] });
  await prisma.membership.create({ data: { userId: owen.id, tenantId: tenant.id, customerId: acme.id, roleId: roleOwner.id, capabilities: [] } });
  await prisma.membership.create({ data: { userId: bea.id, tenantId: tenant.id, customerId: birch.id, roleId: roleOwner.id, capabilities: [] } });
  const mkPc = async (biz, hostname, offered, wuaExtra = {}) => {
    const e = await prisma.endpoint.create({ data: { tenantId: tenant.id, customerId: biz.id, name: hostname, hostname, status: 'ACTIVE', isOnline: true, isManaged: true, accessMode: 'COMPANY_WIDE', lastSeenAt: new Date(), deviceClass: 'WORKSTATION' } });
    const rid = String(100000000 + ((Math.random() * 899999999) | 0));
    const secret = randomBytes(24).toString('hex');
    await prisma.rustdeskNode.create({ data: { tenantId: tenant.id, endpointId: e.id, rustdeskId: rid, agentSecretHash: sha(secret) } });
    const state = path.join(work, `pc-${e.id}`); mkdirSync(state);
    const pc = { id: e.id, rid, secret, state, hostname, wua: path.join(state, 'wua.json'), reg: path.join(state, 'registry.json') };
    writeFileSync(pc.wua, JSON.stringify({ offered, installed: [], superseded: [], history: [], ...wuaExtra }));
    writeFileSync(pc.reg, JSON.stringify({}));
    return pc;
  };
  const restartCU = { results: { [key(CU)]: { resultCode: 2, rebootRequired: true, hresult: '0x00000000' } } };
  const dewey = await mkPc(acme, 'DEWEY-WKS2022', [CU, MSRT, DEFS], restartCU);
  const sched = await mkPc(acme, 'SCHED-PC', [CU, MSRT], restartCU);
  const spare = await mkPc(acme, 'SPARE-PC', [MSRT]);
  const birchPc = await mkPc(birch, 'BIRCH-PC', [CU]);
  check(true, 'Acme: DEWEY-WKS2022 (the production case), SCHED-PC (scheduled), SPARE-PC (canceled); Birch: BIRCH-PC');

  const pk = { olivia: syntheticPasskey({ userId: olivia.id, name: 'TP olivia' }), quinn: syntheticPasskey({ userId: quinn.id, name: 'TP quinn' }) };
  for (const k of Object.values(pk)) await prisma.userMfaMethod.create({ data: { userId: k.userId, type: 'WEBAUTHN', isActive: true, credentialId: k.credentialId, publicKey: Buffer.from(k.publicKey, 'base64url'), signCount: 0, name: 'Test key' } });

  start('signer', path.join(dist, 'approval-signer', 'main.js'), signerEnv);
  start('api', path.join(dist, 'main.js'), apiEnv);
  await waitUp(`http://127.0.0.1:${SIGNER_INTERNAL}/internal/v1/keys`, 'signer');
  await waitUp(`${API}/health`, 'api');
  const S = { owen: await login(owen.email), bea: await login(bea.email), olivia: await login(olivia.email), quinn: await login(quinn.email) };
  for (const who of ['olivia', 'quinn']) {
    const list = await req('GET', '/auth/passkeys', { s: S[who] });
    const mine = (list.body?.data ?? list.body ?? [])[0];
    const add = signerCli(['roster', 'add', '--export', mine.approvalExport, '--approve', '*', '--confirm-fingerprint', mine.approvalFingerprint]);
    if (add.status !== 0) throw new Error(`roster add ${who}: ${add.stderr}`);
  }
  for (const pc of [dewey, sched, spare, birchPc]) await heartbeat(pc, { patchPosture: scan(pc) });
  const T0 = new Date().toISOString();
  const asOwen = { s: S.owen, business: acme.id }, asBea = { s: S.bea, business: birch.id };
  const tasksOf = async (pc, who = asOwen) => (await req('GET', `/endpoints/${pc.id}/tasks`, who));
  const patchesOf = async (pc) => (await req('GET', `/endpoints/${pc.id}/patches`, asOwen)).body?.data;
  const installTask = (r) => (r.body?.data?.tasks ?? []).find((t) => t.type === 'update_install');

  section('Install now on DEWEY: waiting for approval → queued → handed out → result');
  let job;
  {
    const r = await req('POST', `/endpoints/${dewey.id}/patches/install`, { ...asOwen, body: { updates: [id(CU), id(MSRT), id(DEFS)], reboot: 'never', reason: 'November updates, as on DEWEY' } });
    job = r.body?.data?.job;
    check(r.status === 201 && job?.status === 'AWAITING_APPROVAL', 'requested from the Patches tab', msg(r));
    let t = await tasksOf(dewey);
    let v = installTask(t);
    check(t.status === 200 && v?.stage === 'awaiting_approval' && v.waitingFor === 'approval' && v.inFlight && v.cancelJobId === job.id, 'Tasks panel: waiting for approval, cancelable', msg(t));
    check(t.body.data.inFlight >= 1 && t.body.data.pollMs === 5000 && !!t.body.data.checkedAt, 'something in flight: the console polls every 5 s, and is told when it last checked', JSON.stringify({ inFlight: t.body.data.inFlight, pollMs: t.body.data.pollMs }));
    await approve(job.id, pk.olivia); await approve(job.id, pk.quinn);
    v = installTask(await tasksOf(dewey));
    check(v?.stage === 'queued' && v.state === 'queued' && v.waitingFor === 'check_in' && /next check-in \(about every 3 minutes\)/.test(v.text) && !v.overdue, 'approved: queued, waiting for the next check-in (about every 3 minutes)', JSON.stringify(v));
    let p = await patchesOf(dewey);
    check(p?.afterInstall?.task?.state === 'queued' && p.afterInstall.installed === 0, 'the Patches tab shows the same queued install in its banner', JSON.stringify(p?.afterInstall?.task?.state));
    const mine0 = (await req('GET', `/tasks/mine?since=${encodeURIComponent(T0)}`, asOwen)).body?.data;
    check(mine0?.inFlight >= 1 && mine0.finished.length === 0 && mine0.pollMs === 5000, 'toast poll: Owen has one in flight, nothing finished yet', JSON.stringify(mine0));

    const hb = await heartbeat(dewey);
    const env = (hb.body?.data?.actions ?? []).find((a) => a.jobId === job.id);
    check(!!env, 'the next heartbeat hands it out');
    await heartbeat(dewey); await heartbeat(dewey); await heartbeat(dewey);
    v = installTask(await tasksOf(dewey));
    check(v?.stage === 'handed_out' && v.deliveries === 4 && /^Handed to the computer at \d\d:\d\d UTC \(4 deliveries, the last at \d\d:\d\d UTC\)/.test(v.text) && !v.overdue && v.cancelJobId === null,
      'handed out: four deliveries, as on DEWEY — not overdue yet, and no longer cancelable', JSON.stringify(v));

    // 31 minutes pass without a result (time moved in the database; nothing else changed).
    const tgt = await prisma.actionTarget.findFirst({ where: { jobId: job.id } });
    await prisma.actionTarget.update({ where: { id: tgt.id }, data: { dispatchedAt: new Date(Date.now() - 31 * 60_000) } });
    v = installTask(await tasksOf(dewey));
    check(v?.overdue && /^Handed out 31 min ago, no result yet: the agent may be busy \(a large update can take a long time\) or offline\./.test(v.overdueText), 'overdue: "Handed out 31 min ago, no result yet: the agent may be busy or offline"', v?.overdueText);
    const list = (await req('GET', '/tasks?state=problem', asOwen)).body?.data;
    check(list?.tasks.some((x) => x.id === v.id) && list.overdue >= 1, 'the Tasks page lists it under "Problems", and counts it overdue', JSON.stringify(list?.tasks?.map((x) => x.id)));
    await prisma.actionTarget.update({ where: { id: tgt.id }, data: { dispatchedAt: tgt.dispatchedAt } });

    const out = runAgent(dewey, job.id, env.envelope);
    check(out.outcome === 'restart_required', 'the agent installs the three: the CU needs a restart', JSON.stringify(out));
    await report(dewey);
    v = installTask(await tasksOf(dewey));
    check(v?.stage === 'done' && v.state === 'restart_required' && !v.inFlight && v.restartPending === true && /^Installed 3 updates — restart required\./.test(v.text), 'done: "Installed 3 updates — restart required"', JSON.stringify(v));
    const items = Object.fromEntries((v?.items ?? []).map((i) => [i.label.split(' ')[0], i.state]));
    check(items.KB5135243 === 'restart_required' && items.KB890830 === 'installed' && items.KB2267602 === 'installed', 'each update with its result', JSON.stringify(v?.items));
    p = await patchesOf(dewey);
    const a = p?.afterInstall;
    check(a?.installed === 3 && a.failed === 0 && a.restartRequired === true && a.scannedSince === false && a.scheduleRestart?.possible === true, 'banner: installed 3, restart required, no scan since; Schedule restart is offered', JSON.stringify(a && { ...a, task: undefined }));
    const marks = Object.fromEntries((p?.updates ?? []).map((x) => [x.kb, x]));
    check(marks.KB5135243?.installedByJob?.waiting === 'restart' && marks.KB5135243.installable === false && /waiting for the restart/.test(marks.KB5135243.notInstallableBecause),
      'the old pending list marks each one "installed, waiting for the restart" instead of offering it again', JSON.stringify(marks.KB5135243));
    const mine1 = (await req('GET', `/tasks/mine?since=${encodeURIComponent(T0)}`, asOwen)).body?.data;
    const f = mine1?.finished.find((x) => x.id === v.id);
    check(f?.state === 'restart_required' && f.computerName === 'DEWEY-WKS2022' && /restart required/.test(f.text), 'toast poll: the install finished, restart required, on DEWEY-WKS2022', JSON.stringify(mine1));
    const mine2 = (await req('GET', `/tasks/mine?since=${encodeURIComponent(f?.finishedAt ?? new Date().toISOString())}`, asOwen)).body?.data;
    check(mine2 && !mine2.finished.some((x) => x.id === v.id), 'asked again since then: not toasted twice');
  }

  section('Visibility: another business\'s tasks never appear');
  {
    const scanReq = await req('POST', `/endpoints/${birchPc.id}/inventory/refresh`, asBea);
    check(scanReq.status < 300, 'Bea asks Birch\'s computer for a scan', msg(scanReq));
    const bl = (await req('GET', '/tasks', asBea)).body?.data;
    check(bl?.tasks.length >= 1 && bl.tasks.every((x) => x.endpointId === birchPc.id), 'Bea\'s Tasks page lists only Birch\'s computer', JSON.stringify(bl?.tasks?.map((x) => x.computerName)));
    const ol = (await req('GET', '/tasks', asOwen)).body?.data;
    check(ol?.tasks.length >= 1 && !ol.tasks.some((x) => x.endpointId === birchPc.id || x.businessId === birch.id), 'Owen\'s Tasks page never shows Birch\'s', JSON.stringify(ol?.tasks?.map((x) => x.computerName)));
    const cross = await tasksOf(dewey, asBea);
    check(cross.status === 404, 'Bea reading DEWEY\'s tasks by id → 404', msg(cross));
    const crossBiz = await req('GET', `/tasks?businessId=${acme.id}`, asBea);
    check(crossBiz.status === 404 || crossBiz.status === 403 || (crossBiz.body?.data?.tasks ?? []).every((x) => x.endpointId === birchPc.id), 'Bea naming Acme\'s business id sees nothing of Acme', msg(crossBiz));
    const bm = (await req('GET', `/tasks/mine?since=${encodeURIComponent(T0)}`, asBea)).body?.data;
    check(bm && !bm.finished.some((x) => x.endpointId === dewey.id), 'Bea\'s toast poll never names Acme\'s computers');
    const bad = await req('GET', '/tasks?state=everything', asOwen);
    check(bad.status === 400, 'an unknown state filter is refused', msg(bad));
    const typed = (await req('GET', '/tasks?type=update_install&state=done', asOwen)).body?.data;
    check(typed?.tasks.length >= 1 && typed.tasks.every((x) => x.type === 'update_install' && !x.inFlight), 'filtered by type and state', JSON.stringify(typed?.tasks?.map((x) => [x.type, x.state])));
  }

  section('Schedule restart from the banner: windows.reboot.schedule, and the scan after it');
  {
    const r = await req('POST', `/endpoints/${dewey.id}/actions`, { ...asOwen, body: { actionId: 'windows.reboot.schedule', version: 1, params: { delayMinutes: 15 }, reason: 'Restart to finish installing updates (from the Patches tab)', windowHours: 2 } });
    const rj = r.body?.data;
    check(r.status === 201 && rj?.action?.id === 'windows.reboot.schedule' && rj.approvalsRequired === 2, 'the banner\'s request is an ordinary windows.reboot.schedule plan — its own two approvals', msg(r));
    let a = (await patchesOf(dewey))?.afterInstall;
    check(a?.restart?.state === 'awaiting_approval' && a.scheduleRestart.possible === false && /already open/.test(a.scheduleRestart.reason), 'the banner shows the restart request, and offers no second one', JSON.stringify(a?.restart));
    await approve(rj.id, pk.olivia); await approve(rj.id, pk.quinn);
    const hb = await heartbeat(dewey);
    const env = (hb.body?.data?.actions ?? []).find((x) => x.jobId === rj.id);
    const out = env ? runAgent(dewey, rj.id, env.envelope) : null;
    check(out?.outcome === 'succeeded' && out.observed?.delayMinutes === '15' && !!out.observed?.scheduledFor, 'the agent schedules it with its fixed 15-minute warning', JSON.stringify(out));
    await report(dewey);
    a = (await patchesOf(dewey))?.afterInstall;
    check(a?.restart?.state === 'succeeded' && a.restart.type === 'restart', 'the banner shows the restart scheduled', JSON.stringify(a?.restart));
    const ep = await prisma.endpoint.findUnique({ where: { id: dewey.id }, select: { patchScanRequestedAt: true } });
    const due = Date.parse(out.observed.scheduledFor) + 2 * 60_000;
    check(ep.patchScanRequestedAt?.getTime() === due && a.scan?.state === 'scheduled' && /after the scheduled restart/.test(a.scan.text), 'and a scan is asked for just after the restart, shown as scheduled', JSON.stringify({ at: ep.patchScanRequestedAt, scan: a?.scan }));
  }

  section('A scheduled install: signed with its notBefore, held until then, refused by the agent before it');
  {
    const past = await req('POST', `/endpoints/${sched.id}/patches/install`, { ...asOwen, body: { updates: [id(CU)], reason: 'too late', schedule: { local: '2020-01-01T00:00', timeZone: 'UTC' } } });
    check(past.status === 400 && code(past) === 'SCHEDULE_IN_PAST', 'a time in the past is refused', msg(past));
    const tz = await req('POST', `/endpoints/${sched.id}/patches/install`, { ...asOwen, body: { updates: [id(CU)], reason: 'nowhere', schedule: { local: utcLocal(60).local, timeZone: 'Atlantis/Lost' } } });
    check(tz.status === 400 && code(tz) === 'INVALID_TIMEZONE', 'an unknown zone is refused', msg(tz));
    const before = await prisma.patchDeployment.count({ where: { customerId: acme.id } });
    check(before === 1, 'neither refusal left a deployment behind', String(before));
    const when = utcLocal(1.2);
    const r = await req('POST', `/endpoints/${sched.id}/patches/install`, { ...asOwen, body: { updates: [id(CU), id(MSRT)], reboot: 'never', reason: 'Scheduled for the evening', windowHours: 2, schedule: { local: when.local, timeZone: 'UTC' } } });
    const sj2 = r.body?.data?.job;
    check(r.status === 201 && new Date(sj2?.window?.notBefore).getTime() === when.at.getTime(), `scheduled for ${when.local} UTC`, msg(r));
    const row = await prisma.actionJob.findUnique({ where: { id: sj2.id } });
    check(row.plan.window.notBefore === when.at.toISOString() && row.notBefore.getTime() === when.at.getTime() && row.notAfter.getTime() - row.notBefore.getTime() === 2 * 3600_000, 'the plan the signer signs carries the same notBefore, and the 2-hour window after it', JSON.stringify(row.plan.window));
    const audit = await prisma.activityLog.findFirst({ where: { action: 'PATCH_INSTALL_REQUESTED', resourceId: sched.id }, orderBy: { createdAt: 'desc' } });
    check(audit?.metadata?.scheduledFor ?? audit?.meta?.scheduledFor, 'the audit entry records when it was scheduled for', JSON.stringify(audit?.metadata ?? audit?.meta));
    await approve(sj2.id, pk.olivia); await approve(sj2.id, pk.quinn);
    let v = installTask(await tasksOf(sched));
    check(v?.stage === 'scheduled' && v.state === 'scheduled' && /Nothing is handed to the computer before then/.test(v.text) && v.cancelJobId === sj2.id, 'Tasks panel: "Scheduled for …", cancelable', JSON.stringify(v));
    const sl = (await req('GET', '/tasks?state=scheduled', asOwen)).body?.data;
    check(sl?.tasks.some((x) => x.id === v.id) && sl.scheduled >= 1, 'the Tasks page lists it under Scheduled');
    const hb = await heartbeat(sched);
    check(!(hb.body?.data?.actions ?? []).some((x) => x.jobId === sj2.id), 'the heartbeat before notBefore hands nothing out');
    const t0 = await prisma.actionTarget.findFirst({ where: { jobId: sj2.id } });
    check(t0.status === 'PENDING' && t0.deliveries === 0 && !t0.dispatchedAt, 'the target is still PENDING, never delivered');
    // A plan that somehow reached the agent early is refused by its own clock, and not consumed.
    const signed = (await prisma.actionJob.findUnique({ where: { id: sj2.id } })).envelope;
    const early = runAgent(sched, sj2.id, signed);
    check(early.outcome === 'refused' && early.reason === 'not_yet_valid', 'the agent, handed the envelope early, refuses it: not_yet_valid', JSON.stringify(early));
    const wait = when.at.getTime() - Date.now() + 1500;
    console.log(`      (waiting ${Math.max(0, Math.round(wait / 1000))} s for the scheduled time)`);
    if (wait > 0) await sleep(wait);
    const hb2 = await heartbeat(sched);
    const env = (hb2.body?.data?.actions ?? []).find((x) => x.jobId === sj2.id);
    check(!!env, 'after notBefore the next heartbeat hands it out');
    const behind = runAgent(sched, sj2.id, env.envelope, ['-clock-offset', '-10m']);
    check(behind.outcome === 'refused' && behind.reason === 'not_yet_valid', 'an agent whose clock is ten minutes behind still waits (sim -clock-offset -10m)', JSON.stringify(behind));
    const ran = runAgent(sched, sj2.id, env.envelope);
    check(ran.outcome === 'restart_required', 'with its clock right, it runs: the refusals did not consume the plan', JSON.stringify(ran));
    await report(sched);
    v = installTask(await tasksOf(sched));
    check(v?.state === 'restart_required' && v.stage === 'done', 'and the task shows it done', JSON.stringify(v?.state));
  }

  section('Cancel a scheduled install that reached no computer — and not one that did');
  {
    const when = utcLocal(24 * 60);
    const r = await req('POST', `/endpoints/${spare.id}/patches/install`, { ...asOwen, body: { updates: [id(MSRT)], reason: 'Tomorrow night', schedule: { local: when.local, timeZone: 'UTC' } } });
    const cj = r.body?.data?.job;
    check(r.status === 201, 'scheduled for tomorrow', msg(r));
    await approve(cj.id, pk.olivia); await approve(cj.id, pk.quinn);
    const nosy = await req('POST', `/actions/${cj.id}/cancel`, asBea);
    check(nosy.status === 404, 'Bea cannot cancel Acme\'s → 404', msg(nosy));
    const c = await req('POST', `/actions/${cj.id}/cancel`, asOwen);
    check(c.status === 200 && c.body?.data?.status === 'CANCELED', 'Owen cancels it (the existing cancel, POST /actions/:id/cancel)', msg(c));
    const t = await prisma.actionTarget.findFirst({ where: { jobId: cj.id } });
    check(t.status === 'CANCELED' && t.statusReason === 'plan canceled' && !t.dispatchedAt && t.deliveries === 0, 'its undelivered target is canceled, never delivered');
    const audit = await prisma.activityLog.findFirst({ where: { action: 'ACTION_CANCELED', resourceId: cj.id } });
    check(!!audit, 'and the cancel is audited');
    const hb = await heartbeat(spare);
    check(!(hb.body?.data?.actions ?? []).some((x) => x.jobId === cj.id), 'nothing is handed out for it afterwards');
    const v = installTask(await tasksOf(spare));
    check(v?.state === 'canceled' && !v.inFlight && /Nothing reached the computer/.test(v.text) && v.cancelJobId === null, 'the task shows it canceled', JSON.stringify(v));
    const late = await req('POST', `/actions/${job.id}/cancel`, asOwen);
    check(late.status === 409 && code(late) === 'NOT_CANCELABLE', 'DEWEY\'s install, already delivered and answered, cannot be canceled', msg(late));
  }

  section('A ring requested from a deployment can be scheduled too');
  {
    const d = await req('POST', '/patching/deployments', { ...asOwen, body: { businessId: acme.id, name: 'Weekend', updates: [id(MSRT)], rings: [[spare.id]], soakHours: 0, failureThreshold: 0, windowHours: 4 } });
    check(d.status === 201, 'a deployment', msg(d));
    const both = await req('POST', `/patching/deployments/${d.body.data.id}/rings/0/request`, { ...asOwen, body: { reason: 'both', startsInMinutes: 30, schedule: { local: utcLocal(120).local, timeZone: 'UTC' } } });
    check(both.status === 400, 'a schedule and startsInMinutes together are refused', msg(both));
    const when = utcLocal(180);
    const r = await req('POST', `/patching/deployments/${d.body.data.id}/rings/0/request`, { ...asOwen, body: { reason: 'Saturday', schedule: { local: when.local, timeZone: 'UTC' } } });
    const rj = r.body?.data?.job;
    check(r.status === 201 && new Date(rj?.window?.notBefore).getTime() === when.at.getTime() && new Date(rj.window.notAfter).getTime() - when.at.getTime() === 4 * 3600_000, 'the canary\'s plan opens at the scheduled time, with the deployment\'s 4-hour window', msg(r));
    const det = (await req('GET', `/patching/deployments/${d.body.data.id}`, asOwen)).body?.data;
    check(det?.maxScheduleDays === 14 && 'timeZones' in det, 'the deployment page is told the scheduling bounds and the viewer\'s zone');
  }
}

async function cleanup() {
  await stop('api'); await stop('signer');
  try {
    if (created.businesses.length) {
      await prisma.actionJob.deleteMany({ where: { customerId: { in: created.businesses } } });
      await prisma.patchDeployment.deleteMany({ where: { customerId: { in: created.businesses } } });
      const eps = await prisma.endpoint.findMany({ where: { customerId: { in: created.businesses } }, select: { id: true } });
      await prisma.endpointCommand.deleteMany({ where: { endpointId: { in: eps.map((e) => e.id) } } });
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
