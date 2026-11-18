#!/usr/bin/env node
/**
 * End-to-end proof of automation schedules (v0.58): a library script and a
 * catalog package run on a recurring schedule, every run signed by the
 * approval signer under a policy two people approved once with passkeys.
 *
 * Self-contained, like e2e-script-run.mjs: a signed update repository from
 * the offline release tool, the approval signer as its own process (built
 * from dist, the same files build-approval-signer.mjs installs), the compiled
 * API on its own port with AUTOMATION_SWEEP on every 2 seconds, a scratch
 * database, synthetic passkeys checked by the signer's real WebAuthn
 * verification, and rem0te-action-sim — the agent's real verifier and
 * executor — running the script in PowerShell 7 and the package through its
 * simulated winget.
 *
 *   cd apps/api && npx nest build
 *   RELEASE_BIN=/tmp/rem0te-release ACTION_SIM=/tmp/rem0te-action-sim PWSH=$(command -v pwsh) \
 *   DATABASE_URL=postgresql://…/rem0te_automation_scratch_test node scripts/e2e-automation-schedule.mjs
 *
 * Ports 3841 (API), 3842 (signer public), 3843 (signer internal).
 *
 * The schedules are hourly at a minute chosen so the current hour's
 * occurrence has just opened: the sweep has a whole open window to work in
 * without the test waiting for a clock. "The next occurrence" is simulated by
 * moving this occurrence's portal records to the hour before; the signer's
 * own ledger is never touched.
 *
 * What it does NOT prove: anything about Windows (see e2e-script-run.mjs),
 * or a schedule over days of real time.
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { syntheticPasskey } from './lib/synthetic-passkey.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');

const DB = process.env.DATABASE_URL ?? '';
const dbName = DB.split('/').pop()?.split('?')[0] ?? '';
if (!/scratch|test/.test(dbName)) {
  console.error(`Refusing to run against database "${dbName}": name must contain "scratch" or "test".`);
  process.exit(2);
}
const BIN = process.env.RELEASE_BIN, SIM = process.env.ACTION_SIM;
if (!BIN || !SIM) { console.error('RELEASE_BIN (rem0te-release) and ACTION_SIM (rem0te-action-sim) are required'); process.exit(2); }
const PWSH = process.env.PWSH || (spawnSync('sh', ['-c', 'command -v pwsh'], { encoding: 'utf8' }).stdout || '').trim();
if (!PWSH || !existsSync(PWSH)) { console.error('PowerShell 7 is required: set PWSH or put pwsh on PATH'); process.exit(2); }
const PORT = Number(process.env.AUTOMATION_API_PORT ?? 3841);
const SIGNER_PUBLIC = Number(process.env.AUTOMATION_SIGNER_PUBLIC_PORT ?? 3842);
const SIGNER_INTERNAL = Number(process.env.AUTOMATION_SIGNER_INTERNAL_PORT ?? 3843);
if ([PORT, SIGNER_PUBLIC, SIGNER_INTERNAL].some((p) => [3000, 3001, 443, 3201, 3202, 4000, 4001].includes(p))) { console.error('refusing a production port'); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
const ORIGIN = `http://127.0.0.1:${SIGNER_PUBLIC}`;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'automation-e2e-password-123';
const ACTIONS = ['windows.service.start@1', 'windows.update.install@1', 'windows.service.restart@1', 'windows.reboot.schedule@1', 'windows.reboot.cancel@1', 'windows.logs.collect@1', 'windows.script.run@1', 'windows.software.install@1', 'windows.software.uninstall@1', 'windows.software.remove@1', 'windows.service.control@1', 'windows.process.stop@1'];
const WINGET = 'v1.9.25200';

let pass = 0, fail = 0; const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const unb64 = (s) => Buffer.from(s ?? '', 'base64').toString('utf8');

const SCRIPT = ['param([Parameter(Mandatory)][string]$Name)', 'Write-Output "scheduled hello $Name"', 'exit 0', ''].join('\n');
const DECLS = [{ name: 'Name', type: 'string', required: true, charset: 'identifier', maxLength: 32, description: 'Who to greet' }];
const SEVEN = { id: '7zip.7zip', version: '24.08', bytes: '7-Zip 24.08 x64 installer (synthetic)' };
const sevenPkg = { installer: SEVEN.bytes, displayName: '7-Zip 24.08 (x64)', displayVersion: '24.08', uninstallKey: '7-Zip' };

// An hourly schedule whose current occurrence opened a minute ago (or now).
function justOpened() {
  const m = (new Date().getUTCMinutes() + 59) % 60;
  return { kind: 'hourly', everyHours: 1, minute: m, windowMinutes: 60, timezone: 'UTC' };
}

// ── The release machine ─────────────────────────────────────────────────────
const work = mkdtempSync(path.join(tmpdir(), 'rem0te-automation-'));
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
const agentBin = Buffer.concat([Buffer.from('MZ stand-in signed agent 0.58 '), randomBytes(64), slot]);
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
const apiEnv = {
  ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATABASE_URL: DB, UPDATE_REPO_DIR: repo,
  MONITOR_SWEEP: 'off', CLIENT_UPDATE_SWEEP: 'off', PATCH_POLICY_SWEEP: 'off', METRIC_SWEEP: 'off', SCRIPT_OUTPUT_SWEEP: 'off',
  RETENTION_SWEEP: 'off', REPORT_SCHEDULE_SWEEP: 'off', CHAT_RETENTION_SWEEP: 'off', TRAY_SWEEP: 'off', SNAPSHOT_SWEEP: 'off',
  AUTO_MIGRATION_SWEEP: 'off', WINGET_INDEX_SWEEP: 'off', AGENT_AUTO_UPDATE: 'off',
  AUTOMATION_SWEEP: 'on', AUTOMATION_SWEEP_SECONDS: '2',
  // Never this host's GeoIP file: a missing one leaves locations empty.
  GEOIP_DB_PATH: path.join(work, 'no-geoip.mmdb'),
  APPROVAL_SIGNER_INTERNAL_URL: `http://127.0.0.1:${SIGNER_INTERNAL}`,
  JWT_SECRET: randomBytes(32).toString('hex'), LAUNCHER_TOKEN_SECRET: randomBytes(32).toString('hex'),
  ENCRYPTION_KEY: randomBytes(32).toString('hex'), TRUSTED_PROXIES: 'loopback',
  VERSION_FILE: path.resolve(here, '..', '..', '..', 'version.json'),
};
delete apiEnv.INTEGRATION_PEERS_FILE;
async function waitUp(url, name) {
  for (let i = 0; i < 120; i++) { try { const r = await fetch(url); if (r.status < 500) return; } catch { /* not yet */ } await sleep(300); }
  throw new Error(`${name} did not come up:\n${kids[name]?.log.slice(-3000)}`);
}
async function waitFor(fn, ms = 20_000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await sleep(500); }
}

// ── HTTP helpers ────────────────────────────────────────────────────────────
async function req(method, p, { s, body, business } = {}) {
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
const fresh = (s) => ({ ...s, ip: ip() });
const code = (r) => r.body?.code ?? r.body?.message?.code ?? r.body?.error?.code;
const msg = (r) => `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 400)}`;
const sj = async (url, init = {}) => { const r = await fetch(url, init); let b = null; try { b = await r.json(); } catch { /* html */ } return { status: r.status, body: b }; };
const signerPost = (p, body) => sj(`${ORIGIN}/approve/${p}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify(body) });
async function approveAt(base, who, body = { decision: 'approve' }) {
  const c = await signerPost(`${base}/challenge`, body);
  if (c.status !== 200) return c;
  return signerPost(`${base}/decide`, { challengeId: c.body.challengeId, assertion: who.assert(c.body.options, { origin: ORIGIN }) });
}
const heartbeat = (ep, extra = {}) => req('POST', '/enrollment/heartbeat', {
  body: { rustdeskId: ep.rid, agentSecret: ep.secret, hostname: ep.hostname, platform: 'Windows', updateChannel: 'signed', agentActions: ACTIONS, agentSha256: AGENT_SHA, ...extra },
});
function resultsOf(ep) {
  const d = path.join(ep.state, 'actions', 'results');
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => /^[0-9a-f]{32}\.json$/.test(f)).map((f) => JSON.parse(readFileSync(path.join(d, f), 'utf8')));
}
function clearAcked(ep, acks) { for (const a of acks ?? []) rmSync(path.join(ep.state, 'actions', 'results', `${a}.json`), { force: true }); }
const wingetFile = (ep) => path.join(ep.state, 'winget.json');
let keysFile;
function runAgent(ep, jobId, item) {
  const tag = `${jobId}-${randomBytes(3).toString('hex')}`;
  const envFile = path.join(work, `env-${tag}.json`);
  writeFileSync(envFile, JSON.stringify(item.envelope));
  const args = ['-state', ep.state, '-keys', keysFile, '-job', jobId, '-envelope', envFile, '-rustdesk-id', ep.rid, '-secret', ep.secret, '-product-type', '1', '-self-sha', AGENT_SHA, '-winget', wingetFile(ep)];
  if (item.script?.content !== undefined) { const f = path.join(work, `script-${tag}.b64`); writeFileSync(f, item.script.content); args.push('-script', f, '-pwsh', PWSH, '-script-minute', '3s'); }
  args.push('-portal', `127.0.0.1:${PORT}`);
  return JSON.parse(execFileSync(SIM, args, { encoding: 'utf8', timeout: 120_000 }).trim());
}
const deliver = async (ep, jobId) => ((await heartbeat(ep)).data?.actions ?? []).find((d) => d.jobId === jobId);
const report = async (ep) => { const h = await heartbeat(ep, { actionResults: resultsOf(ep) }); clearAcked(ep, h.data?.actionAcks); return h; };
const occRows = (policyId) => prisma.automationOccurrence.findMany({ where: { policyId }, orderBy: [{ occurrenceKey: 'asc' }, { attempt: 'asc' }] });
const plansOf = async (policyId) => (await occRows(policyId)).filter((o) => o.jobId);
// "The next occurrence": this occurrence's portal records become last hour's.
async function nextOccurrence(policyId) {
  const rows = await occRows(policyId);
  for (const o of rows) await prisma.automationOccurrence.update({ where: { id: o.id }, data: { occurrenceKey: new Date(Date.parse(o.occurrenceKey) - 3_600_000).toISOString() } });
  await prisma.automationPolicy.update({ where: { id: policyId }, data: { lastProposal: null } });
}

const created = { businesses: [], users: [], policies: [] };

async function all() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  const roleUser = await prisma.role.findFirst({ where: { type: 'BUSINESS_USER' } });
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });

  section('Fixtures (synthetic): Acme (FRONTDESK, BACKOFFICE), Delta in direct mode (DELTAPC), Birch (BIRCHPC)');
  const acme = await prisma.customer.create({ data: { tenantId: tenant.id, name: `AU Acme ${sfx}` } });
  const delta = await prisma.customer.create({ data: { tenantId: tenant.id, name: `AU Delta ${sfx}` } });
  const birch = await prisma.customer.create({ data: { tenantId: tenant.id, name: `AU Birch ${sfx}` } });
  created.businesses.push(acme.id, delta.id, birch.id);
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag, extra = {}) => { const u = await prisma.user.create({ data: { email: `au-${tag}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'AU', lastName: tag, status: 'ACTIVE', ...extra } }); created.users.push(u.id); return u; };
  const member = (u, biz, role, capabilities = []) => prisma.membership.create({ data: { userId: u.id, tenantId: tenant.id, customerId: biz.id, roleId: role.id, capabilities } });
  const abe = await mkUser('abe-author'), rae = await mkUser('rae-reviewer'), sam = await mkUser('sam-l3'), bea = await mkUser('bea-birch'), owen = await mkUser('owen-owner');
  const olivia = await mkUser('olivia-approver', { platformPermissions: ['technicians:manage'] }), quinn = await mkUser('quinn-approver', { platformPermissions: ['technicians:manage'] });
  await member(abe, acme, roleUser, ['computers:view', 'scripts:author']);
  await member(rae, acme, roleUser, ['computers:view', 'scripts:review']);
  await member(bea, birch, roleUser, ['computers:view', 'actions:request']);
  await member(owen, acme, roleOwner);
  for (const b of [acme, delta]) await prisma.technicianAssignment.create({ data: { tenantId: tenant.id, customerId: b.id, userId: sam.id, capabilities: ['computers:view', 'actions:request', 'scripts:author'] } });
  const mkEp = async (biz, hostname) => {
    const e = await prisma.endpoint.create({ data: { tenantId: tenant.id, customerId: biz.id, name: hostname, hostname, platform: 'Windows', status: 'ACTIVE', isOnline: true, isManaged: true, accessMode: 'COMPANY_WIDE', lastSeenAt: new Date(), deviceClass: 'WORKSTATION' } });
    const rid = String(100000000 + ((Math.random() * 899999999) | 0));
    const secret = randomBytes(24).toString('hex');
    await prisma.rustdeskNode.create({ data: { tenantId: tenant.id, endpointId: e.id, rustdeskId: rid, agentSecretHash: sha(secret) } });
    const state = path.join(work, `agent-${hostname}`); mkdirSync(state);
    const ep = { id: e.id, rid, secret, state, hostname };
    writeFileSync(wingetFile(ep), JSON.stringify({ version: WINGET, packages: { [`${SEVEN.id}@${SEVEN.version}`]: sevenPkg } }));
    return ep;
  };
  const fd = await mkEp(acme, 'FRONTDESK'), bo = await mkEp(acme, 'BACKOFFICE'), dp = await mkEp(delta, 'DELTAPC'), bp = await mkEp(birch, 'BIRCHPC');
  const pk = {
    olivia: syntheticPasskey({ userId: olivia.id, name: 'AU olivia' }), quinn: syntheticPasskey({ userId: quinn.id, name: 'AU quinn' }),
    abe: syntheticPasskey({ userId: abe.id, name: 'AU abe' }), sam: syntheticPasskey({ userId: sam.id, name: 'AU sam' }),
  };
  for (const k of Object.values(pk)) await prisma.userMfaMethod.create({ data: { userId: k.userId, type: 'WEBAUTHN', isActive: true, credentialId: k.credentialId, publicKey: Buffer.from(k.publicKey, 'base64url'), signCount: 0, name: 'Test key' } });
  const mkEntry = (biz) => prisma.softwareCatalogEntry.create({ data: {
    scope: 'BUSINESS', tenantId: tenant.id, customerId: biz.id, packageId: SEVEN.id, name: '7-Zip', publisher: 'Igor Pavlov', version: SEVEN.version,
    installerSha256: sha(SEVEN.bytes), hashSource: 'ADMIN_PASTED', architecture: 'x64',
    detection: { kind: 'display_name', name: '7-Zip', match: 'prefix', compare: 'gte', version: '24.08' }, createdById: owen.id, updatedById: owen.id,
  } });
  const acmeEntry = await mkEntry(acme), deltaEntry = await mkEntry(delta);
  const group = await prisma.endpointGroup.create({ data: { tenantId: tenant.id, customerId: delta.id, name: `Delta tills ${sfx}`, kind: 'STATIC' } });
  await prisma.endpointGroupMember.create({ data: { endpointGroupId: group.id, endpointId: dp.id } });
  check(true, 'three businesses, four computers, seven people, two catalog entries, one group');

  start('signer', path.join(dist, 'approval-signer', 'main.js'), signerEnv);
  await waitUp(`http://127.0.0.1:${SIGNER_INTERNAL}/internal/v1/keys`, 'signer');
  const pol = signerCli(['policy', 'set', '--business', delta.id, '--approval', 'direct']);
  check(pol.status === 0, 'the signer CLI puts Delta in direct mode (the only way to)', pol.stderr);
  start('api', path.join(dist, 'main.js'), apiEnv);
  await waitUp(`${API}/health`, 'api');
  const S = {};
  for (const [k, u] of Object.entries({ abe, rae, sam, bea, owen, olivia, quinn })) S[k] = await login(u.email);
  // Which business each acts in (the console sends it as a header).
  for (const k of ['abe', 'rae', 'sam', 'owen']) S[k].business = acme.id;
  S.bea.business = birch.id;

  for (const [who, scope] of [['olivia', '*'], ['quinn', '*'], ['abe', acme.id], ['sam', acme.id]]) {
    const list = await req('GET', '/auth/passkeys', { s: S[who] });
    const mine = (list.body?.data ?? list.body ?? [])[0];
    const add = signerCli(['roster', 'add', '--export', mine.approvalExport, '--approve', scope, '--confirm-fingerprint', mine.approvalFingerprint]);
    if (add.status !== 0) throw new Error(`roster add ${who}: ${add.stderr}`);
  }
  {
    const metas = readdirSync(path.join(repo, 'metadata')).filter((f) => /^\d+\.targets\.json$/.test(f)).sort((a, b) => parseInt(b) - parseInt(a));
    const targets = await (await fetch(`${API}/public/updates/metadata/${metas[0]}`)).json();
    const t = targets.signed.targets['approval/keys.json'];
    keysFile = path.join(work, 'keys.json');
    writeFileSync(keysFile, Buffer.from(await (await fetch(`${API}/public/updates/targets/approval/${t.hashes.sha256}.keys.json`)).arrayBuffer()));
  }
  for (const ep of [fd, bo, dp, bp]) await heartbeat(ep);

  section('The script: written by Abe, approved by Rae, on the signer\'s allowlist by two approvers');
  let versionId, scriptEntry;
  {
    let r = await req('POST', '/scripts', { s: fresh(S.abe), body: { scope: 'business', name: `Scheduled greeter ${sfx}`, description: 'Greets someone on a schedule.', risk: 'medium', parameters: DECLS, content: SCRIPT } });
    const scriptId = r.data?.id;
    const v1 = await req('GET', `/scripts/${scriptId}/versions/1`, { s: S.abe });
    versionId = v1.data?.id ?? v1.data?.version?.id;
    await req('POST', `/scripts/${scriptId}/versions/1/submit`, { s: fresh(S.abe) });
    r = await req('POST', `/scripts/${scriptId}/versions/1/review`, { s: await stepUp(fresh(S.rae)), body: { decision: 'approve', expectedSha256: sha(SCRIPT), note: 'read it' } });
    check(r.data?.status === 'APPROVED', 'version 1 approved in the library', msg(r));
    r = await req('POST', `/script-runs/versions/${versionId}/allowlist`, { s: fresh(S.rae) });
    scriptEntry = r.data;
    await approveAt(`script/${scriptEntry.id}`, pk.olivia);
    r = await approveAt(`script/${scriptEntry.id}`, pk.quinn);
    check(r.body?.status === 'ACTIVE', 'and ACTIVE on the signer\'s allowlist', JSON.stringify(r.body));
  }

  section('Readiness and the editor\'s preview');
  {
    const r = await req('GET', `/automation/schedules?businessId=${acme.id}`, { s: S.sam });
    check(r.status === 200 && r.data.readiness.signerSupportsAutomation === true && r.data.readiness.sweep.enabled === true && Array.isArray(r.data.schedules) && r.data.schedules.length === 0,
      'GET /automation/schedules: the signer supports automation policies, the sweep is on, nothing scheduled yet', msg(r));
    const p = await req('POST', '/automation/schedules/preview', { s: S.sam, body: { recurrence: { kind: 'hourly', everyHours: 6, minute: 30, windowMinutes: 60, timezone: 'Europe/London' } } });
    check(p.status === 200 && /Every 6 hours at :30/.test(p.data?.description) && p.data?.occurrences?.length >= 3, 'the preview describes the schedule and its next runs, by the signer\'s functions', msg(p));
    const bad = await req('POST', '/automation/schedules/preview', { s: S.sam, body: { recurrence: { kind: 'hourly', everyHours: 5, minute: 0, windowMinutes: 60, timezone: 'UTC' } } });
    check(bad.status === 200 && bad.data?.valid === false && bad.data.occurrences.length === 0, 'every 5 hours is not a schedule: the preview says so and lists no runs', msg(bad));
  }

  const scriptBody = (over = {}) => ({
    businessId: acme.id, name: `Hourly greeting ${sfx}`, task: { kind: 'script', scriptVersionId: versionId, parameters: { Name: 'world' }, timeoutMinutes: 5 },
    targets: { kind: 'computers', endpointIds: [fd.id, bo.id] }, recurrence: justOpened(), offline: { mode: 'run_when_online' }, maxRunsPerOccurrence: 1,
    reason: 'Ticket 41: greet the front desk every hour', ...over,
  });

  section('Creating a schedule: fresh sign-in, typed arguments, the right business');
  let sp;
  {
    let r = await req('POST', '/automation/schedules', { s: fresh(S.sam), body: scriptBody() });
    check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED', 'without a fresh sign-in → 403 STEP_UP_REQUIRED (automation.policy)', msg(r));
    const samF = await stepUp(fresh(S.sam));
    for (const [n, over, want] of [
      ['an argument the declarations refuse', { task: { kind: 'script', scriptVersionId: versionId, parameters: { Name: '$(whoami)' }, timeoutMinutes: 5 } }, 'PARAMS_NOT_ALLOWED'],
      ['every 5 hours', { recurrence: { kind: 'hourly', everyHours: 5, minute: 0, windowMinutes: 60, timezone: 'UTC' } }, 'INVALID_REQUEST'],
      ['an extra field', { command: 'whoami' }, 'INVALID_REQUEST'],
      ['an offline rule off the list', { offline: { mode: 'retry_forever' } }, 'INVALID_REQUEST'],
      ['four plans an occurrence', { maxRunsPerOccurrence: 4 }, 'INVALID_REQUEST'],
      ['a 91-day expiry', { expiresInDays: 91 }, 'INVALID_REQUEST'],
      ['a computer named twice', { targets: { kind: 'computers', endpointIds: [fd.id, fd.id] } }, 'BAD_TARGETS'],
    ]) {
      r = await req('POST', '/automation/schedules', { s: fresh(samF), body: scriptBody(over) });
      check(r.status === 400 && code(r) === want, `${n} → 400 ${want}`, msg(r));
    }
    r = await req('POST', '/automation/schedules', { s: fresh(samF), body: scriptBody({ targets: { kind: 'computers', endpointIds: [bp.id] } }) });
    check(r.status === 404, 'naming Birch\'s computer → 404', msg(r));
    r = await req('POST', '/automation/schedules', { s: await stepUp(fresh(S.bea)), body: scriptBody({ businessId: birch.id, targets: { kind: 'computers', endpointIds: [bp.id] } }) });
    check(r.status === 404 || r.status === 403, 'Birch cannot schedule Acme\'s script on its own computer', msg(r));
    r = await req('POST', '/automation/schedules', { s: fresh(samF), body: scriptBody() });
    sp = r.data;
    check(r.status === 201 && sp?.status === 'AWAITING_APPROVAL' && sp.approvalUrl === `${ORIGIN}/approve/automation/${sp.id}` && sp.document.targets.computers.length === 2, 'created: awaiting approval, on the signer\'s own URL', msg(r));
    if (sp?.id) created.policies.push(sp.id);
    // 0.63 (§76): no expiry asked for, so the document signs "never" and the portal's mirror is null.
    const row = sp?.id ? await prisma.automationPolicy.findUnique({ where: { id: sp.id } }) : null;
    check(sp?.document?.expiry === 'never' && !('expiresAt' in (sp?.document ?? {})) && row?.expiresAt === null, '0.63: a schedule made with no expiry signs expiry "never"; the portal\'s expiresAt is null', JSON.stringify({ expiry: sp?.document?.expiry, expiresAt: row?.expiresAt }));
    const a = await prisma.activityLog.findFirst({ where: { resourceId: sp?.id, action: 'AUTOMATION_POLICY_CREATED' } });
    check(a?.metadata?.digest === sp?.digest && a.metadata.sha256 === sha(SCRIPT) && a.metadata.approval === 'signed', 'creating it is audited with the digest, the script hash and the arguments');
    for (const route of ['approve', 'activate', 'sign']) {
      const x = await req('POST', `/automation/schedules/${sp.id}/${route}`, { s: fresh(samF) });
      check(x.status === 404, `there is no ${route} route in the portal → 404`, msg(x));
    }
  }

  section('Nothing runs while it awaits approval');
  {
    await sleep(5000);
    check((await plansOf(sp.id)).length === 0, 'two sweeps later, no plan has been asked for');
    const page = await (await fetch(sp.approvalUrl)).text();
    check(page.includes('Hourly greeting') && page.includes('FRONTDESK') && page.includes('scheduled hello') && page.includes(sha(SCRIPT)) && /Every hour at :/.test(page), 'the signer\'s page shows the script, its hash, the computers and the schedule');
    check(/<strong>Never<\/strong>/.test(page) && /until the policy is revoked\. It does not ask/.test(page), '0.63: …and says it never expires');
    let r = await approveAt(`automation/${sp.id}`, pk.sam, { decision: 'approve', role: 'approver' });
    check(r.status === 403 && r.body?.error === 'requester_cannot_approve', 'Sam, who created it, cannot approve it', JSON.stringify(r.body));
    r = await approveAt(`automation/${sp.id}`, pk.abe, { decision: 'approve', role: 'approver' });
    check(r.status === 409 && r.body?.error === 'contributor_cannot_approve', 'Abe, who wrote the script, cannot approve its schedule', JSON.stringify(r.body));
    r = await approveAt(`automation/${sp.id}`, pk.olivia, { decision: 'approve', role: 'approver' });
    check(r.body?.status === 'AWAITING_APPROVAL', 'one approval is not enough', JSON.stringify(r.body));
    r = await approveAt(`automation/${sp.id}`, pk.quinn, { decision: 'approve', role: 'approver' });
    check(r.body?.status === 'ACTIVE', 'a second, different approver makes it ACTIVE', JSON.stringify(r.body));
  }

  section('The sweep asks for this occurrence\'s plan; the signer signs it; the agent runs it');
  let job1;
  {
    const plans = await waitFor(async () => { const p = await plansOf(sp.id); return p.length ? p : null; });
    check(plans?.length === 1 && plans[0].attempt === 1 && plans[0].targets === 2, 'one plan for this occurrence, for both computers', JSON.stringify(plans));
    job1 = plans?.[0]?.jobId;
    const j = await req('GET', `/actions/${job1}`, { s: S.sam, business: acme.id });
    const job = await prisma.actionJob.findUnique({ where: { id: job1 } });
    check(j.data?.status === 'APPROVED' && j.data.targets.length === 2 && job.requestedById === sam.id, 'the job is APPROVED with no further approval, requested on Sam\'s behalf', msg(j));
    const occ = Date.parse(plans[0].occurrenceKey);
    check(job.notBefore.getTime() >= occ && job.notAfter.getTime() <= occ + 3_600_000, 'its signed window lies inside the occurrence (run when online: until the window closes)', `${job.notBefore.toISOString()} ${job.notAfter.toISOString()}`);
    for (const ep of [fd, bo]) {
      const item = await deliver(ep, job1);
      const res = runAgent(ep, job1, item);
      check(res.outcome === 'succeeded' && unb64(res.script?.stdout).includes('scheduled hello world'), `${ep.hostname} verifies the signed plan and runs the script`, JSON.stringify(res).slice(0, 300));
      await report(ep);
    }
    const d = await req('GET', `/automation/schedules/${sp.id}`, { s: S.sam });
    check(d.data?.succeeded === 2 && d.data.failed === 0 && d.data.occurrences?.[0]?.plans?.[0]?.computers?.length === 2 && !!d.data.lastRun && !!d.data.nextRun && d.data.upcoming.length === 5,
      'the history: two succeeded, the last and next run, the next five', msg(d));
    const l = await req('GET', `/automation/schedules?businessId=${acme.id}`, { s: S.owen });
    check(l.data?.schedules?.find((x) => x.id === sp.id)?.succeeded === 2, 'Acme\'s owner sees it in the list with its counts', msg(l));
    const audit = await prisma.activityLog.findMany({ where: { resourceId: sp.id, action: 'AUTOMATION_RUN_PROPOSED' } });
    check(audit.length === 1 && audit[0].metadata?.jobId === job1, 'the proposal is audited with its job');
    const ja = await prisma.activityLog.findFirst({ where: { resourceId: job1, action: 'ACTION_REQUESTED' } });
    check(ja?.metadata?.automation === true, 'and the job\'s own request audit says it came from an automation policy', JSON.stringify(ja?.metadata).slice(0, 200));
    await sleep(5000);
    check((await plansOf(sp.id)).length === 1, 'one plan per occurrence: two sweeps later there is still one');
  }

  section('Isolation');
  {
    let r = await req('GET', `/automation/schedules/${sp.id}`, { s: S.bea });
    check(r.status === 404, 'Birch cannot read Acme\'s schedule → 404', msg(r));
    r = await req('POST', `/automation/schedules/${sp.id}/pause`, { s: fresh(S.bea), body: { reason: 'not mine' } });
    check(r.status === 404, 'nor pause it → 404', msg(r));
    r = await req('POST', `/automation/schedules/${sp.id}/pause`, { s: fresh(S.rae), body: { reason: 'not mine either' } });
    check(r.status === 403 || r.status === 404, 'Rae (neither author, owner nor admin) cannot pause it', msg(r));
  }

  section('Pause is immediate and audited; resume needs a fresh sign-in');
  {
    await nextOccurrence(sp.id);
    let r = await req('POST', `/automation/schedules/${sp.id}/pause`, { s: fresh(S.owen), body: { reason: 'office move this week' } });
    check(r.status === 200 && r.data?.paused?.reason === 'office move this week' && r.data.nextRun === null, 'Acme\'s owner pauses it with no fresh sign-in: no next run', msg(r));
    await sleep(5000);
    check((await plansOf(sp.id)).length === 1, 'paused, at the start of a new occurrence: the sweep asks for nothing');
    const a = await prisma.activityLog.findFirst({ where: { resourceId: sp.id, action: 'AUTOMATION_POLICY_PAUSED' } });
    check(a?.metadata?.reason === 'office move this week', 'pausing is audited with the reason');
    r = await req('POST', `/automation/schedules/${sp.id}/resume`, { s: fresh(S.sam) });
    check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED', 'resuming without a fresh sign-in → 403', msg(r));
  }

  section('Revoking the script stops every later run');
  {
    let r = await req('POST', `/script-runs/versions/${versionId}/allowlist/revoke`, { s: fresh(S.rae), body: { reason: 'found a bug' } });
    check(r.status === 200, 'Rae revokes the script from the allowlist', msg(r));
    r = await req('POST', `/automation/schedules/${sp.id}/resume`, { s: await stepUp(fresh(S.sam)) });
    check(r.status === 200 && r.data?.paused === null, 'Sam resumes the schedule with a fresh sign-in', msg(r));
    const p = await waitFor(async () => { const x = await prisma.automationPolicy.findUnique({ where: { id: sp.id } }); return x.lastProposal?.code === 'task_revoked' ? x : null; });
    check(!!p && (await plansOf(sp.id)).length === 1, 'the next occurrence asks for nothing: task_revoked, recorded in its history', JSON.stringify(p?.lastProposal));
    // And the signer refuses regardless, should a portal ask.
    const stale = await prisma.actionJob.findUnique({ where: { id: job1 } });
    const s2 = await sj(`http://127.0.0.1:${SIGNER_INTERNAL}/internal/v1/automations/${sp.id}`);
    check(s2.body?.status === 'ACTIVE' && s2.body.signedPlans === 1 && !!stale, 'the signer has signed exactly one plan under it', JSON.stringify(s2.body).slice(0, 300));
  }

  section('A catalog package, under containment and then without');
  let wp;
  {
    const samF = await stepUp(fresh(S.sam));
    let r = await req('POST', '/automation/schedules', { s: samF, body: {
      businessId: acme.id, name: `Keep 7-Zip ${sfx}`, task: { kind: 'software', entryId: acmeEntry.id, operation: 'install' },
      targets: { kind: 'computers', endpointIds: [fd.id] }, recurrence: justOpened(), offline: { mode: 'expire_after', hours: 2 }, expiresInDays: 7, reason: 'Keep 7-Zip installed',
    } });
    wp = r.data;
    check(r.status === 201 && wp?.status === 'AWAITING_APPROVAL' && wp.task.includes('7-Zip'), 'a software schedule, awaiting approval', msg(r));
    check(typeof wp?.document?.expiresAt === 'string' && !('expiry' in (wp?.document ?? {})) && wp.expiresAt !== null, '0.63: an API caller may still ask for an expiry (7 days): the document carries the date and no "never"', JSON.stringify({ expiresAt: wp?.document?.expiresAt, expiry: wp?.document?.expiry }));
    if (wp?.id) created.policies.push(wp.id);
    const pause = await prisma.containmentPause.create({ data: { scope: 'BUSINESS', customerId: acme.id, kinds: ['actions'], reason: 'containment drill', setById: owen.id, setBy: 'msp' } });
    await approveAt(`automation/${wp.id}`, pk.olivia, { decision: 'approve', role: 'approver' });
    r = await approveAt(`automation/${wp.id}`, pk.quinn, { decision: 'approve', role: 'approver' });
    check(r.body?.status === 'ACTIVE', 'approved by two', JSON.stringify(r.body));
    const c = await waitFor(async () => { const x = await prisma.automationPolicy.findUnique({ where: { id: wp.id } }); return x.lastProposal?.code === 'contained' ? x : null; });
    check(!!c && (await plansOf(wp.id)).length === 0, 'an actions containment pause: the sweep submits nothing and says why', JSON.stringify(c?.lastProposal));
    await prisma.containmentPause.update({ where: { id: pause.id }, data: { clearedAt: new Date(), clearedById: owen.id, clearReason: 'drill over' } });
    await prisma.automationPolicy.update({ where: { id: wp.id }, data: { lastProposal: null } });
    const plans = await waitFor(async () => { const p = await plansOf(wp.id); return p.length ? p : null; });
    check(plans?.length === 1, 'lifted: the plan is asked for', JSON.stringify(plans));
    const jid = plans?.[0]?.jobId;
    const job = jid ? await prisma.actionJob.findUnique({ where: { id: jid } }) : null;
    check(job && job.notAfter.getTime() <= Date.parse(plans[0].occurrenceKey) + 2 * 3_600_000 && job.notAfter.getTime() > Date.parse(plans[0].occurrenceKey) + 3_600_000 - 60_000,
      'expire after 2 hours: the signed window runs past the occurrence, to two hours from its start', `${job?.notAfter?.toISOString()} ${plans?.[0]?.occurrenceKey}`);
    const res = runAgent(fd, jid, await deliver(fd, jid));
    check(res.outcome === 'succeeded', 'FRONTDESK installs 7-Zip through winget, the hash checked', JSON.stringify(res).slice(0, 300));
    await report(fd);
    r = await req('POST', `/software/catalog/${acmeEntry.id}/archive`, { s: await stepUp(fresh(S.owen)), body: { reason: 'moving to a business policy', expectedRevision: 1 } });
    check(r.status === 200, 'Acme\'s owner archives the catalog entry (the signer records it revoked)', msg(r));
    await nextOccurrence(wp.id);
    const p = await waitFor(async () => { const x = await prisma.automationPolicy.findUnique({ where: { id: wp.id } }); return x.lastProposal?.code === 'task_revoked' ? x : null; });
    check(!!p && (await plansOf(wp.id)).length === 1, 'the next occurrence asks for nothing: task_revoked', JSON.stringify(p?.lastProposal));
  }

  section('Revoking a schedule: one-way, on the signer too');
  {
    let r = await req('POST', `/automation/schedules/${wp.id}/revoke`, { s: fresh(S.sam), body: { reason: 'done with it' } });
    check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED', 'without a fresh sign-in → 403', msg(r));
    r = await req('POST', `/automation/schedules/${wp.id}/revoke`, { s: await stepUp(fresh(S.sam)), body: { reason: 'done with it' } });
    check(r.status === 200 && r.data?.status === 'REVOKED' && r.data.signerConfirmedRevocation === true, 'revoked, and the signer confirms', msg(r));
    const s2 = await sj(`http://127.0.0.1:${SIGNER_INTERNAL}/internal/v1/automations/${wp.id}`);
    check(s2.body?.status === 'REVOKED' && existsSync(path.join(signerDir, 'automation-revocations', `${wp.id}.json`)), 'the signer holds it REVOKED in its own write-once file', JSON.stringify(s2.body).slice(0, 200));
    r = await req('POST', `/automation/schedules/${wp.id}/resume`, { s: await stepUp(fresh(S.sam)) });
    check(r.status === 409, 'a revoked schedule cannot be resumed', msg(r));
    let threw = false;
    try { await prisma.automationPolicy.update({ where: { id: wp.id }, data: { status: 'ACTIVE' } }); } catch { threw = true; }
    check(threw, 'the database refuses to bring a REVOKED schedule back (trigger)');
    const a = await prisma.activityLog.findFirst({ where: { resourceId: wp.id, action: 'AUTOMATION_POLICY_REVOKED' } });
    check(a?.metadata?.reason === 'done with it' && a.metadata.signerConfirmed === true, 'revoking is audited');
  }

  section('Direct mode, a device group: active at once, run on the group\'s members');
  {
    const body = {
      businessId: delta.id, name: `Delta tills 7-Zip ${sfx}`, task: { kind: 'software', entryId: deltaEntry.id, operation: 'install' },
      targets: { kind: 'group', groupId: group.id, maxTargets: 5 }, recurrence: justOpened(), offline: { mode: 'skip_if_offline' }, expiresInDays: 3, reason: 'Delta tills keep 7-Zip',
    };
    const r = await req('POST', '/automation/schedules', { s: await stepUp(fresh(S.sam)), business: delta.id, body });
    check(r.status === 201 && r.data?.status === 'ACTIVE' && r.data.direct === true && r.data.document.targets.kind === 'group', 'in direct mode a schedule is ACTIVE at creation, with no approvers', msg(r));
    if (r.data?.id) created.policies.push(r.data.id);
    const plans = await waitFor(async () => { const p = await plansOf(r.data.id); return p.length ? p : null; });
    const job = plans?.[0]?.jobId ? await prisma.actionJob.findUnique({ where: { id: plans[0].jobId }, include: { targets: true } }) : null;
    check(job?.targets?.length === 1 && job.targets[0].endpointId === dp.id && job.approvalsRequired === 0, 'the group\'s one member is named, signed in direct mode', JSON.stringify({ t: job?.targets?.map((t) => t.endpointId), a: job?.approvalsRequired }));
    check(job && job.notAfter.getTime() - job.notBefore.getTime() <= 15 * 60_000 + 1000, 'skip if offline: the plan is valid for at most 15 minutes', `${job?.notBefore?.toISOString()} ${job?.notAfter?.toISOString()}`);
    const res = runAgent(dp, job.id, await deliver(dp, job.id));
    check(res.outcome === 'succeeded', 'DELTAPC verifies the direct plan and installs', JSON.stringify(res).slice(0, 300));
    await report(dp);
    await req('POST', `/automation/schedules/${r.data.id}/revoke`, { s: await stepUp(fresh(S.sam)), business: delta.id, body: { reason: 'end of test' } });
  }

  section('The signer CLI');
  {
    const ls = signerCli(['automation', 'list']);
    check(ls.status === 0 && ls.stdout.includes(sp.id) && ls.stdout.includes(wp.id) && /REVOKED/.test(ls.stdout), '`automation list` on the signer host shows every policy', ls.stderr || ls.stdout.slice(0, 300));
    const rv = signerCli(['automation', 'revoke', '--id', sp.id, '--reason', 'operator revoked']);
    check(rv.status === 0, '`automation revoke` on the signer host', rv.stderr);
    const p = await waitFor(async () => { const x = await prisma.automationPolicy.findUnique({ where: { id: sp.id } }); return x.status === 'REVOKED' ? x : null; });
    check(!!p, 'the portal mirrors a revocation made on the signer host');
  }
}

async function cleanup() {
  await stop('api'); await stop('signer');
  try {
    if (created.businesses.length) {
      await prisma.automationPolicy.deleteMany({ where: { customerId: { in: created.businesses } } });
      await prisma.containmentPause.deleteMany({ where: { customerId: { in: created.businesses } } });
      await prisma.actionJob.deleteMany({ where: { customerId: { in: created.businesses } } });
      await prisma.script.deleteMany({ where: { customerId: { in: created.businesses } } });
      await prisma.softwareCatalogEntry.deleteMany({ where: { customerId: { in: created.businesses } } });
      await prisma.technicianAssignment.deleteMany({ where: { customerId: { in: created.businesses } } });
      await prisma.endpointGroup.deleteMany({ where: { customerId: { in: created.businesses } } });
      const eps = await prisma.endpoint.findMany({ where: { customerId: { in: created.businesses } }, select: { id: true } });
      await prisma.rustdeskNode.deleteMany({ where: { endpointId: { in: eps.map((e) => e.id) } } });
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
