#!/usr/bin/env node
/**
 * End-to-end proof of running an approved library script (v0.34) through
 * the signed action path: windows.script.run@1.
 *
 * Self-contained, like e2e-maintenance-actions.mjs: a signed update
 * repository from the offline release tool, the approval signer as its own
 * process, the compiled API on its own port (3451) and a scratch database,
 * synthetic passkeys checked by the signer's real WebAuthn verification, and
 * rem0te-action-sim — the agent's real verifier and executor
 * (tools/windows-installer/internal/action) — running the script in REAL
 * PowerShell: PowerShell 7 (pwsh) on Linux.
 *
 *   cd apps/api && npx nest build
 *   (cd ../../tools/windows-installer && go build -o /tmp/rem0te-release ./cmd/rem0te-release \
 *      && go build -o /tmp/rem0te-action-sim ./cmd/rem0te-action-sim)
 *   RELEASE_BIN=/tmp/rem0te-release ACTION_SIM=/tmp/rem0te-action-sim PWSH=$(command -v pwsh) \
 *   DATABASE_URL=postgresql://…/rem0te_script_run_test node scripts/e2e-script-run.mjs
 *
 * The path: an author writes a version, a different person approves it in
 * the library with fresh authentication, a reviewer proposes it to the
 * signer, two signer approvers (neither the author) add its hash to the
 * signer's own allowlist on the signer's page, a technician requests a run
 * on two computers, two signer approvers approve the run, the heartbeat
 * delivers the envelope and the content, the agent verifies and runs it, and
 * the output comes back redacted (by the agent, and again by the portal)
 * onto each computer's Actions history, until it is pruned after 90 days.
 *
 * What it does NOT prove: anything about Windows. The sim runs PowerShell 7
 * on Linux, kills a process group rather than a job object, and runs as the
 * test user, not SYSTEM. None of this has run on a real Windows computer.
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
const PORT = Number(process.env.SCRIPT_RUN_API_PORT ?? 3451);
const SIGNER_PUBLIC = Number(process.env.SCRIPT_RUN_SIGNER_PUBLIC_PORT ?? 3452);
const SIGNER_INTERNAL = Number(process.env.SCRIPT_RUN_SIGNER_INTERNAL_PORT ?? 3453);
if ([PORT, SIGNER_PUBLIC, SIGNER_INTERNAL].some((p) => [3000, 3001, 443, 3201, 3202, 4000, 4001].includes(p))) { console.error('refusing a production port'); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
const ORIGIN = `http://127.0.0.1:${SIGNER_PUBLIC}`;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'script-run-e2e-password-123';
// The 0.34 catalog: the original six, then script run, then software.
const ACTIONS = ['windows.service.start@1', 'windows.update.install@1', 'windows.service.restart@1', 'windows.reboot.schedule@1', 'windows.reboot.cancel@1', 'windows.logs.collect@1', 'windows.script.run@1', 'windows.software.install@1', 'windows.software.uninstall@1'];

let pass = 0, fail = 0; const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const unb64 = (s) => Buffer.from(s ?? '', 'base64').toString('utf8');

// The script. Its output deliberately carries things redaction must catch.
const SCRIPT = [
  'param([Parameter(Mandatory)][string]$Name, [int]$Sleep = 0, [int]$Exit = 0)',
  'Write-Output "hello $Name"',
  'Write-Output "cwd-is-temp: $((Get-Location).Path -eq $env:TEMP)"',
  'Write-Output "password=hunter2"',
  "Write-Output ('C:' + [char]92 + 'Users' + [char]92 + 'carol' + [char]92 + 'notes.txt')",
  '[Console]::Error.WriteLine("api_key: sk-live-1234")',
  'if ($Sleep -gt 0) { Start-Sleep -Seconds $Sleep; Write-Output "slept" }',
  'exit $Exit',
  '',
].join('\n');
const DECLS = [
  { name: 'Name', type: 'string', required: true, charset: 'identifier', maxLength: 32, description: 'Who to greet' },
  { name: 'Sleep', type: 'integer', required: false, min: 0, max: 120 },
  { name: 'Exit', type: 'integer', required: false, min: 0, max: 255 },
];

// ── The release machine ─────────────────────────────────────────────────────
const work = mkdtempSync(path.join(tmpdir(), 'rem0te-script-run-'));
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
const agentBin = Buffer.concat([Buffer.from('MZ stand-in signed agent 0.34 '), randomBytes(64), slot]);
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

// ── HTTP helpers ────────────────────────────────────────────────────────────
async function req(method, p, { s, body, business } = {}) {
  const h = { 'content-type': 'application/json', 'x-forwarded-for': s?.ip ?? ip() };
  if (s) h.cookie = s.cookie + (s.stepUp ? `; step_up=${s.stepUp}` : '');
  if (business) h['x-rem0te-business'] = business;
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
const fresh = (s) => ({ ...s, ip: ip() }); // a new source address: the write routes allow 10 a minute per address
const code = (r) => r.body?.code ?? r.body?.message?.code ?? r.body?.error?.code;
const msg = (r) => `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`;
const sj = async (url, init = {}) => { const r = await fetch(url, init); let b = null; try { b = await r.json(); } catch { /* html */ } return { status: r.status, body: b }; };
const signerPost = (p, body) => sj(`${ORIGIN}/approve/${p}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify(body) });
async function approve(id, who, { decision = 'approve', role = 'approver', script = false } = {}) {
  const base = script ? `script/${id}` : id;
  const c = await signerPost(`${base}/challenge`, script ? { decision } : { decision, role });
  if (c.status !== 200) return c;
  return signerPost(`${base}/decide`, { challengeId: c.body.challengeId, assertion: who.assert(c.body.options, { origin: ORIGIN }) });
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
function runAgent(ep, jobId, item, { content, pwsh = PWSH, minute = '3s' } = {}) {
  const tag = `${jobId}-${randomBytes(3).toString('hex')}`;
  const envFile = path.join(work, `env-${tag}.json`);
  writeFileSync(envFile, JSON.stringify(item.envelope));
  const args = ['-state', ep.state, '-keys', keysFile, '-job', jobId, '-envelope', envFile, '-rustdesk-id', ep.rid, '-secret', ep.secret, '-product-type', '1', '-self-sha', AGENT_SHA];
  const c = content ?? item.script?.content;
  if (c !== undefined) { const f = path.join(work, `script-${tag}.b64`); writeFileSync(f, c); args.push('-script', f); }
  if (pwsh) args.push('-pwsh', pwsh, '-script-minute', minute);
  // 0.36: the agent fetches the signer's revocation statement from the portal's relay before each job.
  args.push('-portal', `127.0.0.1:${PORT}`);
  return JSON.parse(execFileSync(SIM, args, { encoding: 'utf8' }).trim());
}

const created = { businesses: [], users: [] };

async function all() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  const roleUser = await prisma.role.findFirst({ where: { type: 'BUSINESS_USER' } });
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });

  section('Fixtures (synthetic): Acme with FRONTDESK, BACKOFFICE (0.34 agents) and OLDPC (0.32); Birch with BIRCHPC');
  const acme = await prisma.customer.create({ data: { tenantId: tenant.id, name: `SR Acme ${sfx}` } });
  const birch = await prisma.customer.create({ data: { tenantId: tenant.id, name: `SR Birch ${sfx}` } });
  created.businesses.push(acme.id, birch.id);
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag, extra = {}) => { const u = await prisma.user.create({ data: { email: `sr-${tag}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'SR', lastName: tag, status: 'ACTIVE', ...extra } }); created.users.push(u.id); return u; };
  const member = (u, biz, role, capabilities = []) => prisma.membership.create({ data: { userId: u.id, tenantId: tenant.id, customerId: biz.id, roleId: role.id, capabilities } });
  const abe = await mkUser('abe-author'), rae = await mkUser('rae-reviewer'), sam = await mkUser('sam-l3'), bea = await mkUser('bea-birch-reviewer'), owen = await mkUser('owen-owner');
  const olivia = await mkUser('olivia-approver', { platformPermissions: ['technicians:manage'] }), quinn = await mkUser('quinn-approver', { platformPermissions: ['technicians:manage'] });
  await member(abe, acme, roleUser, ['computers:view', 'scripts:author']);
  await member(rae, acme, roleUser, ['computers:view', 'scripts:review']);
  await member(bea, birch, roleUser, ['computers:view', 'scripts:review', 'scripts:author', 'actions:request']);
  await member(owen, acme, roleOwner);
  // Sam: a technician for Acme (a whole-business custom grant) who may request actions and see the library.
  // (A preset-backed grant takes its capabilities from the preset alone, and no preset grants library rights.)
  await prisma.technicianAssignment.create({ data: { tenantId: tenant.id, customerId: acme.id, userId: sam.id, capabilities: ['computers:view', 'actions:request', 'scripts:author'] } });
  const mkEp = async (biz, hostname, actions) => {
    const e = await prisma.endpoint.create({ data: { tenantId: tenant.id, customerId: biz.id, name: hostname, hostname, status: 'ACTIVE', isOnline: true, isManaged: true, accessMode: 'COMPANY_WIDE', lastSeenAt: new Date(), deviceClass: 'WORKSTATION' } });
    const rid = String(100000000 + ((Math.random() * 899999999) | 0));
    const secret = randomBytes(24).toString('hex');
    await prisma.rustdeskNode.create({ data: { tenantId: tenant.id, endpointId: e.id, rustdeskId: rid, agentSecretHash: sha(secret) } });
    const state = path.join(work, `agent-${hostname}`); mkdirSync(state);
    return { id: e.id, rid, secret, state, hostname, actions };
  };
  const fd = await mkEp(acme, 'FRONTDESK', ACTIONS), bo = await mkEp(acme, 'BACKOFFICE', ACTIONS), old = await mkEp(acme, 'OLDPC', ACTIONS.slice(0, 6));
  const bp = await mkEp(birch, 'BIRCHPC', ACTIONS);
  const pk = {
    olivia: syntheticPasskey({ userId: olivia.id, name: 'SR olivia' }), quinn: syntheticPasskey({ userId: quinn.id, name: 'SR quinn' }),
    abe: syntheticPasskey({ userId: abe.id, name: 'SR abe' }),
  };
  for (const k of Object.values(pk)) await prisma.userMfaMethod.create({ data: { userId: k.userId, type: 'WEBAUTHN', isActive: true, credentialId: k.credentialId, publicKey: Buffer.from(k.publicKey, 'base64url'), signCount: 0, name: 'Test key' } });
  check(true, 'two businesses, four computers, seven people');

  start('signer', path.join(dist, 'approval-signer', 'main.js'), signerEnv);
  start('api', path.join(dist, 'main.js'), apiEnv);
  await waitUp(`http://127.0.0.1:${SIGNER_INTERNAL}/internal/v1/keys`, 'signer');
  await waitUp(`${API}/health`, 'api');
  const S = {};
  for (const [k, u] of Object.entries({ abe, rae, sam, bea, owen, olivia, quinn })) S[k] = await login(u.email);

  section('Roster and keys');
  for (const [who, scope] of [['olivia', '*'], ['quinn', '*'], ['abe', acme.id]]) {
    const list = await req('GET', '/auth/passkeys', { s: S[who] });
    const mine = (list.body?.data ?? list.body ?? [])[0];
    const add = signerCli(['roster', 'add', '--export', mine.approvalExport, '--approve', scope, '--confirm-fingerprint', mine.approvalFingerprint]);
    if (add.status !== 0) throw new Error(`roster add ${who}: ${add.stderr}`);
  }
  check(true, 'olivia and quinn approve for every business; abe (the author) is on the roster for Acme too');
  {
    const metas = readdirSync(path.join(repo, 'metadata')).filter((f) => /^\d+\.targets\.json$/.test(f)).sort((a, b) => parseInt(b) - parseInt(a));
    const targets = await (await fetch(`${API}/public/updates/metadata/${metas[0]}`)).json();
    const t = targets.signed.targets['approval/keys.json'];
    const buf = Buffer.from(await (await fetch(`${API}/public/updates/targets/approval/${t.hashes.sha256}.keys.json`)).arrayBuffer());
    check(sha(buf) === t.hashes.sha256, 'approval/keys.json comes through the portal mirror and matches signed metadata');
    keysFile = path.join(work, 'keys.json'); writeFileSync(keysFile, buf);
  }
  for (const ep of [fd, bo, old, bp]) await heartbeat(ep);

  section('The catalog: seven actions; script runs are not requested from the Actions tab');
  {
    const cat = await req('GET', '/actions/catalog', { s: S.sam, business: acme.id });
    const acts = cat.data?.actions ?? [];
    const sr = acts.find((a) => a.id === 'windows.script.run');
    check(acts.map((a) => `${a.id}@${a.version}`).join(',') === ACTIONS.join(','), 'GET /actions/catalog lists exactly the nine, in order (0.34: script run seventh, software after it)', acts.map((a) => a.id).join(','));
    check(sr?.workstationRisk === 'high' && sr?.direct === false, 'windows.script.run: high risk on a workstation, not requested directly', JSON.stringify(sr).slice(0, 300));
    const r = await req('POST', `/endpoints/${fd.id}/actions`, { s: fresh(S.sam), business: acme.id, body: { actionId: 'windows.script.run', version: 1, params: { scriptVersionId: 'ver_00000000', sha256: 'a'.repeat(64), parameters: {}, timeoutMinutes: 5 }, reason: 'try the side door' } });
    check(r.status === 400 && code(r) === 'ACTION_NOT_DIRECT', 'POST /endpoints/:id/actions with windows.script.run → 400 ACTION_NOT_DIRECT', msg(r));
  }

  section('The library: written by Abe, approved by Rae with fresh authentication');
  let scriptId, versionId;
  {
    let r = await req('POST', '/scripts', { s: fresh(S.abe), body: { scope: 'business', name: `Greeter ${sfx}`, description: 'Greets someone, optionally sleeps, exits with a chosen code.', risk: 'medium', parameters: DECLS, content: SCRIPT } });
    check(r.status === 201, 'Abe creates the script', msg(r));
    scriptId = r.data?.id;
    const v1 = await req('GET', `/scripts/${scriptId}/versions/1`, { s: S.abe });
    versionId = v1.data?.id ?? v1.data?.version?.id;
    check(!!versionId && (v1.data?.contentSha256 ?? v1.data?.version?.contentSha256) === sha(SCRIPT), 'version 1 holds the exact bytes', msg(v1));
    r = await req('GET', `/script-runs/versions/${versionId}`, { s: S.abe });
    check(r.status === 200 && r.data.you.canRun === false && r.data.allowlist === null && /Not yet run on a real Windows computer/.test(r.data.proven), 'before review: not runnable, nothing on the allowlist, and the page says what is not proven', msg(r));
    r = await req('POST', `/script-runs/versions/${versionId}/allowlist`, { s: fresh(S.rae) });
    check(r.status === 409 && code(r) === 'NOT_APPROVED', 'a draft cannot be proposed to the signer → 409 NOT_APPROVED', msg(r));
    await req('POST', `/scripts/${scriptId}/versions/1/submit`, { s: fresh(S.abe) });
    r = await req('POST', `/scripts/${scriptId}/versions/1/review`, { s: await stepUp(fresh(S.rae)), body: { decision: 'approve', expectedSha256: sha(SCRIPT), note: 'read it' } });
    check(r.status === 200 && r.data.status === 'APPROVED', 'Rae approves version 1 over the hash she saw', msg(r));
  }

  section('The allowlist: proposed by the portal, added only on the signer\'s page');
  let entry;
  {
    let r = await req('POST', `/script-runs/versions/${versionId}/allowlist`, { s: fresh(S.abe) });
    check(r.status === 403 && code(r) === 'NOT_A_REVIEWER', 'Abe (author only) cannot propose → 403 NOT_A_REVIEWER', msg(r));
    r = await req('POST', '/script-runs', { s: fresh(S.sam), business: acme.id, body: { scriptVersionId: versionId, endpointIds: [fd.id], parameters: { Name: 'world' }, timeoutMinutes: 5, reason: 'Ticket 12: greet' } });
    check(r.status === 409 && code(r) === 'SCRIPT_NOT_ALLOWLISTED', 'a run before the signer has it → 409 SCRIPT_NOT_ALLOWLISTED', msg(r));
    r = await req('POST', `/script-runs/versions/${versionId}/allowlist`, { s: fresh(S.rae) });
    entry = r.data;
    check(r.status === 201 && entry?.status === 'AWAITING_APPROVAL' && entry.contentSha256 === sha(SCRIPT) && entry.approvalUrl === `${ORIGIN}/approve/script/${entry.id}`, 'Rae proposes it: awaiting approval on the signer, at the signer\'s own URL', msg(r));
    const again = await req('POST', `/script-runs/versions/${versionId}/allowlist`, { s: fresh(S.rae) });
    check(again.data?.id === entry.id, 'proposing again returns the same entry');
    const page = await (await fetch(entry.approvalUrl)).text();
    check(page.includes('Write-Output &quot;hello $Name&quot;') || page.includes('Write-Output "hello $Name"') || page.includes('hello $Name'), 'the signer\'s page shows the content itself');
    check(page.includes(sha(SCRIPT)), 'and the hash the signer computed');
    r = await approve(entry.id, pk.abe, { script: true });
    check(r.status === 409 && r.body?.error === 'contributor_cannot_approve', 'Abe, the author, cannot approve the allowlist entry (SAME_PERSON on the signer)', JSON.stringify(r.body));
    r = await approve(entry.id, pk.olivia, { script: true });
    check(r.body?.status === 'AWAITING_APPROVAL', 'one signer approval is not enough', JSON.stringify(r.body));
    const mid = await req('GET', `/script-runs/versions/${versionId}`, { s: S.sam, business: acme.id });
    check(mid.data?.allowlist?.status === 'AWAITING_APPROVAL' && mid.data.you.canRun === false, 'the portal mirrors it as still awaiting', msg(mid));
    r = await approve(entry.id, pk.quinn, { script: true });
    check(r.body?.status === 'ACTIVE', 'a second, different approver adds it', JSON.stringify(r.body));
    const now = await req('GET', `/script-runs/versions/${versionId}`, { s: S.sam, business: acme.id });
    check(now.data?.allowlist?.status === 'ACTIVE' && now.data.you.canRun === true, 'the portal mirrors ACTIVE; a run can be requested', msg(now));
    check(existsSync(path.join(signerDir, 'scripts', `${entry.id}.json`)), 'the entry lives in the signer\'s own directory, not the portal database');
  }

  // Forge the portal's mirror: the signer still decides.
  section('The portal\'s mirror cannot make a script runnable');
  {
    const other = await req('POST', `/scripts/${scriptId}/versions`, { s: fresh(S.abe), body: { basedOnVersion: 1, description: 'Greets someone; version two adds a comment.', risk: 'medium', parameters: DECLS, content: SCRIPT + '# v2\n' } });
    check(other.status === 201, '(Abe writes version 2, and Rae approves it in the library)', msg(other));
    const v2 = (await req('GET', `/scripts/${scriptId}/versions/2`, { s: S.abe })).data;
    const v2id = v2?.id ?? v2?.version?.id;
    const sub2 = await req('POST', `/scripts/${scriptId}/versions/2/submit`, { s: fresh(S.abe) });
    const rev2 = await req('POST', `/scripts/${scriptId}/versions/2/review`, { s: await stepUp(fresh(S.rae)), body: { decision: 'approve', expectedSha256: sha(SCRIPT + '# v2\n'), note: 'read version two' } });
    check(sub2.status < 300 && rev2.data?.status === 'APPROVED', '(version 2 is approved in the library)', `${msg(sub2)} ${msg(rev2)}`);
    // A compromised portal writes an ACTIVE row for an id the signer never saw.
    const forged = randomBytes(16).toString('hex');
    await prisma.scriptAllowlistEntry.create({ data: { id: forged, scriptVersionId: v2id, customerId: acme.id, contentSha256: sha(SCRIPT + '# v2\n'), status: 'ACTIVE', approvalUrl: `${ORIGIN}/approve/script/${forged}`, proposedById: rae.id } });
    const r = await req('POST', '/script-runs', { s: fresh(S.sam), business: acme.id, body: { scriptVersionId: v2id, endpointIds: [fd.id], parameters: { Name: 'world' }, timeoutMinutes: 5, reason: 'forged allowlist' } });
    check(other.status === 201 && r.status === 409 && code(r) === 'APPROVAL_SIGNER_REFUSED' && /script_not_allowlisted|not on the approval signer/.test(JSON.stringify(r.body)),
      'a forged ACTIVE row in the portal database: the signer refuses the plan (script_not_allowlisted)', msg(r));
    await prisma.scriptAllowlistEntry.delete({ where: { id: forged } });
  }

  section('Requesting a run: typed arguments, the right business, ready computers');
  const runBody = (over = {}) => ({ scriptVersionId: versionId, endpointIds: [fd.id, bo.id], parameters: { Name: 'world' }, timeoutMinutes: 5, reason: 'Ticket 12: greet the front desk', windowHours: 2, ...over });
  {
    const sr = (b, s = S.sam) => req('POST', '/script-runs', { s: fresh(s), business: acme.id, body: b });
    for (const [n, args] of [['an argument with a quote and a command', { Name: 'x"; Remove-Item C:\\ -Recurse; "' }], ['$( ) subexpression', { Name: '$(whoami)' }], ['a space', { Name: 'a b' }],
      ['an undeclared argument', { Name: 'x', Command: 'whoami' }], ['a missing required argument', { Sleep: 1 }], ['an integer as a string', { Name: 'x', Sleep: '1' }], ['an integer out of range', { Name: 'x', Exit: 256 }],
      ['a name in another case', { name: 'x' }]]) {
      const r = await sr(runBody({ parameters: args }));
      check(r.status === 400 && code(r) === 'PARAMS_NOT_ALLOWED', `${n} → 400 PARAMS_NOT_ALLOWED`, msg(r));
    }
    let r = await sr(runBody({ timeoutMinutes: 45 }));
    check(r.status === 400 && code(r) === 'PARAMS_NOT_ALLOWED', 'a timeout off the list (45) → 400', msg(r));
    r = await sr(runBody({ command: 'whoami' }));
    check(r.status === 400 && code(r) === 'INVALID_REQUEST', 'an extra field in the request → 400', msg(r));
    r = await sr(runBody({ endpointIds: Array.from({ length: 26 }, (_, i) => `ep_${String(i).padStart(10, '0')}`) }));
    check(r.status === 400, 'more than 25 computers → 400', msg(r));
    r = await sr(runBody({ endpointIds: [old.id] }));
    check(r.status === 409 && code(r) === 'ENDPOINT_NOT_READY', 'a 0.32 agent that does not report windows.script.run → 409 ENDPOINT_NOT_READY', msg(r));
    r = await sr(runBody({ endpointIds: [bp.id] }));
    check(r.status === 404, 'Sam naming Birch\'s computer → 404', msg(r));
    r = await sr(runBody(), S.abe);
    check(r.status === 403, 'Abe (author, no actions:request) cannot request a run', msg(r));
  }

  section('Business isolation');
  {
    let r = await req('GET', `/script-runs/versions/${versionId}`, { s: S.bea });
    check(r.status === 404, 'Bea (Birch reviewer) cannot see Acme\'s version → 404', msg(r));
    r = await req('POST', `/script-runs/versions/${versionId}/allowlist`, { s: fresh(S.bea) });
    check(r.status === 404, 'nor propose it → 404', msg(r));
    r = await req('POST', `/script-runs/versions/${versionId}/allowlist/revoke`, { s: fresh(S.bea), body: { reason: 'not mine' } });
    check(r.status === 404, 'nor revoke it → 404', msg(r));
    r = await req('POST', '/script-runs', { s: fresh(S.bea), body: runBody({ endpointIds: [bp.id] }) });
    check(r.status === 404, 'nor run Acme\'s script on Birch\'s own computer → 404', msg(r));
  }

  // One run, through two approvals, to a delivered envelope and content.
  async function approvedRun(body) {
    const r = await req('POST', '/script-runs', { s: fresh(S.sam), business: acme.id, body });
    const job = r.data;
    if (r.status !== 201) return { r, job: null };
    const a1 = await approve(job.id, pk.olivia);
    const a2 = await approve(job.id, pk.quinn);
    const after = await req('GET', `/actions/${job.id}`, { s: S.sam, business: acme.id });
    return { r, job, a1, a2, status: after.data?.status };
  }
  const deliver = async (ep, jobId) => ((await heartbeat(ep)).data?.actions ?? []).find((d) => d.jobId === jobId);
  const report = async (ep, mutate = (x) => x) => { const h = await heartbeat(ep, { actionResults: resultsOf(ep).map(mutate) }); clearAcked(ep, h.data?.actionAcks); return h; };

  section('Run on two computers: approved, delivered, verified, run in PowerShell 7, reported');
  let run1;
  {
    run1 = await approvedRun(runBody({ parameters: { Name: 'world', Exit: 0 } }));
    check(run1.r.status === 201 && run1.job.risk === 'high' && run1.job.approvalsRequired === 2 && run1.job.targets.length === 2, 'Sam requests a run on FRONTDESK and BACKOFFICE: high risk, two approvals, one plan', msg(run1.r));
    check(run1.job.script?.contentSha256 === sha(SCRIPT) && run1.job.params.sha256 === sha(SCRIPT), 'the plan names the content hash');
    const page = await (await fetch(run1.job.approvalUrl)).text();
    check(page.includes('hello $Name') && page.includes(sha(SCRIPT)) && /SYSTEM/.test(page), 'the run approval page shows the script from the signer\'s allowlist, its hash and the SYSTEM warning');
    const abeTry = await (async () => { const r = await req('POST', '/script-runs', { s: fresh(S.sam), business: acme.id, body: runBody({ endpointIds: [fd.id] }) }); return r; })();
    check(abeTry.status === 409 && code(abeTry) === 'ACTION_PENDING', 'a second run on the same computer while one is open → 409 ACTION_PENDING', msg(abeTry));
    check(run1.a1.body?.status === 'AWAITING_APPROVAL' && run1.status === 'APPROVED', 'one approval is not enough; the second, different approver signs it', JSON.stringify([run1.a1.body?.status, run1.status]));

    const item = await deliver(fd, run1.job.id);
    check(!!item?.envelope && typeof item.script?.content === 'string' && unb64(item.script.content) === SCRIPT, 'the heartbeat delivers the envelope and, beside it, the exact content (base64)');
    const res = runAgent(fd, run1.job.id, item);
    check(res.outcome === 'succeeded' && res.script?.exitCode === 0 && res.script.timedOut === false && res.script.cleanup === 'removed', 'FRONTDESK runs it: exit 0, not timed out, temp folder removed', JSON.stringify(res).slice(0, 400));
    const out = unb64(res.script?.stdout);
    check(out.includes('hello world') && out.includes('cwd-is-temp: True'), 'the argument arrived as data, and the script ran in its own temp folder', out.slice(0, 300));
    check(!out.includes('hunter2') && !out.includes('carol') && !unb64(res.script?.stderr).includes('sk-live-1234'), 'the agent redacted the password, the profile path and the key before reporting', JSON.stringify({ out, err: unb64(res.script?.stderr) }));
    const j = JSON.parse(readFileSync(path.join(fd.state, 'actions', 'journal', `${run1.job.id}.json`), 'utf8'));
    check(j.state === 'done', 'the journal records it done');
    const again = runAgent(fd, run1.job.id, item);
    check(again.outcome === 'succeeded' && again.executedAt === res.executedAt, 'the same envelope again is answered from the journal: the script does not run twice', JSON.stringify(again).slice(0, 200));

    // The portal redacts again: a result whose output the agent did NOT redact (an old or broken agent).
    await report(fd, (x) => (x.jobId === run1.job.id ? { ...x, script: { ...x.script, stdout: b64('hello world\npassword=s3cret-from-a-broken-agent\nC:\\Users\\dave\\x\n') } } : x));
    const bi = await deliver(bo, run1.job.id);
    const resB = runAgent(bo, run1.job.id, bi);
    check(resB.outcome === 'succeeded', 'BACKOFFICE runs it too', JSON.stringify(resB).slice(0, 200));
    await report(bo);
    const g = await req('GET', `/actions/${run1.job.id}`, { s: S.sam, business: acme.id });
    const tF = g.data?.targets?.find((t) => t.endpointId === fd.id);
    check(g.data?.status === 'SUCCEEDED' && tF?.scriptOutput?.exitCode === 0, 'recorded SUCCEEDED, with each computer\'s exit code', msg(g));
    check(tF?.scriptOutput?.stdout.includes('hello world') && !tF.scriptOutput.stdout.includes('s3cret') && !tF.scriptOutput.stdout.includes('dave') && /password=\[redacted\]/.test(tF.scriptOutput.stdout),
      'the portal redacted again what a broken agent left in', JSON.stringify(tF?.scriptOutput).slice(0, 300));
    const row = await prisma.scriptRunOutput.findFirst({ where: { jobId: run1.job.id, endpointId: fd.id } });
    check(row && !/s3cret|dave|hunter2/.test(row.stdout + row.stderr), 'the database holds only the redacted text');
    const tRow = await prisma.actionTarget.findFirst({ where: { jobId: run1.job.id, endpointId: fd.id } });
    check(!/hello world/.test(JSON.stringify(tRow.result)) && tRow.result?.script?.exitCode === 0, 'the target row keeps the summary, never the text');
    const hist = await req('GET', `/endpoints/${fd.id}/actions`, { s: S.sam, business: acme.id });
    const hj = (hist.data ?? []).find((x) => x.id === run1.job.id);
    check(hj?.script?.name?.startsWith('Greeter') && hj.targets.find((t) => t.endpointId === fd.id)?.scriptOutput?.stdout.includes('hello world'), 'FRONTDESK\'s Actions history shows the run, the script and its output', JSON.stringify(hj?.script));
    const owenView = await req('GET', `/endpoints/${fd.id}/actions`, { s: S.owen });
    check(owenView.status === 200 && (owenView.data ?? []).some((x) => x.id === run1.job.id), 'Acme\'s owner sees it on the computer\'s history', msg(owenView));
    const beaView = await req('GET', `/actions/${run1.job.id}`, { s: S.bea });
    check(beaView.status === 404, 'Birch cannot read Acme\'s run → 404', msg(beaView));
    const beaHist = await req('GET', `/endpoints/${fd.id}/actions`, { s: S.bea });
    check(beaHist.status === 404 || beaHist.status === 403, 'nor Acme\'s computer history', msg(beaHist));
    const audit = await prisma.activityLog.findMany({ where: { resourceId: run1.job.id, action: 'ACTION_RESULT' } });
    check(audit.length === 2 && audit.every((a) => a.metadata?.script?.contentSha256 === sha(SCRIPT)) && !audit.some((a) => /hello world/.test(JSON.stringify(a.metadata))), 'each result is audited with the hash and sizes, never the output');
  }

  section('Content that is not the signed bytes is refused by the agent');
  {
    const x = await approvedRun(runBody({ endpointIds: [fd.id], parameters: { Name: 'tamper' } }));
    const item = await deliver(fd, x.job.id);
    const res = runAgent(fd, x.job.id, item, { content: b64(SCRIPT.replace('hello', 'pwned')) });
    check(res.outcome === 'refused' && res.reason === 'content_mismatch' && !res.script, 'a portal that swaps the content: refused content_mismatch, nothing run', JSON.stringify(res).slice(0, 300));
    await report(fd);
    const g = await req('GET', `/actions/${x.job.id}`, { s: S.sam, business: acme.id });
    check(g.data?.status === 'REFUSED_BY_ENDPOINT' && g.data.statusReason === 'content_mismatch', 'recorded REFUSED_BY_ENDPOINT, content_mismatch', msg(g));
  }

  section('An exit code and a timeout');
  {
    const x = await approvedRun(runBody({ endpointIds: [fd.id], parameters: { Name: 'x', Exit: 7 } }));
    const res = runAgent(fd, x.job.id, await deliver(fd, x.job.id));
    check(res.outcome === 'failed' && res.reason === 'exit_code' && res.script?.exitCode === 7, 'exit 7 → failed, exit_code 7', JSON.stringify(res).slice(0, 300));
    await report(fd);
    const t0 = Date.now();
    const y = await approvedRun(runBody({ endpointIds: [fd.id], parameters: { Name: 'x', Sleep: 60 }, timeoutMinutes: 1 }));
    const resT = runAgent(fd, y.job.id, await deliver(fd, y.job.id), { minute: '3s' });
    check(resT.outcome === 'timed_out' && resT.script?.timedOut === true && !unb64(resT.script.stdout).includes('slept') && Date.now() - t0 < 30_000,
      'a 1-minute timeout (one minute shortened to 3 s for the test): killed before it finished sleeping', JSON.stringify(resT).slice(0, 300));
    await report(fd);
    const g = await req('GET', `/actions/${y.job.id}`, { s: S.sam, business: acme.id });
    check(g.data?.targets?.[0]?.outcome === 'timed_out' && g.data.targets[0].scriptOutput?.timedOut === true && g.data.status === 'FAILED', 'recorded as timed out (FAILED), with the output it had produced', msg(g));
  }

  section('The author cannot approve a run of their own script');
  {
    const r = await req('POST', '/script-runs', { s: fresh(S.sam), business: acme.id, body: runBody({ endpointIds: [fd.id] }) });
    const a = await approve(r.data.id, pk.abe);
    check(a.status === 409 && a.body?.error === 'contributor_cannot_approve', 'Abe\'s passkey on the run → contributor_cannot_approve', JSON.stringify(a.body));
    await req('POST', `/actions/${r.data.id}/cancel`, { s: fresh(S.sam), business: acme.id });
  }

  section('Revocation: one-way');
  {
    const pending = await req('POST', '/script-runs', { s: fresh(S.sam), business: acme.id, body: runBody({ endpointIds: [bo.id] }) });
    await approve(pending.data.id, pk.olivia);
    let r = await req('POST', `/script-runs/versions/${versionId}/allowlist/revoke`, { s: fresh(S.abe), body: { reason: 'found a bug' } });
    check(r.status === 403, 'Abe (author only) cannot revoke', msg(r));
    r = await req('POST', `/script-runs/versions/${versionId}/allowlist/revoke`, { s: fresh(S.rae), body: { reason: 'found a bug' } });
    check(r.status === 200 && r.data?.status === 'REVOKED', 'Rae revokes it', msg(r));
    const a2 = await approve(pending.data.id, pk.quinn);
    check(a2.status === 409 && a2.body?.error === 'script_revoked', 'a run approved halfway before the revocation is not signed after it', JSON.stringify(a2.body));
    r = await req('POST', '/script-runs', { s: fresh(S.sam), business: acme.id, body: runBody({ endpointIds: [fd.id] }) });
    check(r.status === 409 && code(r) === 'SCRIPT_NOT_ALLOWLISTED', 'a new run → 409 SCRIPT_NOT_ALLOWLISTED', msg(r));
    r = await req('POST', `/script-runs/versions/${versionId}/allowlist`, { s: fresh(S.rae) });
    check(r.status === 409 && code(r) === 'SCRIPT_REVOKED', 'proposing it again → 409 SCRIPT_REVOKED', msg(r));
    // Even a portal that forgets the revocation cannot re-add it: the signer keys revocations by content hash.
    await prisma.scriptAllowlistEntry.deleteMany({ where: { scriptVersionId: versionId } });
    r = await req('POST', `/script-runs/versions/${versionId}/allowlist`, { s: fresh(S.rae) });
    check(r.status === 409 && code(r) === 'APPROVAL_SIGNER_REFUSED' && /revoked; it can never be allowlisted again/.test(r.body?.message ?? ''), 'a portal that deleted its record of the revocation: the signer still refuses (script_revoked)', msg(r));
    const ls = signerCli(['script', 'list']);
    check(ls.status === 0 && /REVOKED/.test(ls.stdout) && ls.stdout.includes(sha(SCRIPT)), '`script list` on the signer host shows it revoked', ls.stderr || ls.stdout.slice(0, 200));
    const audit = await prisma.activityLog.findMany({ where: { resourceId: versionId, action: { in: ['SCRIPT_ALLOWLIST_PROPOSED', 'SCRIPT_ALLOWLIST_REVOKED'] } } });
    check(audit.some((a) => a.action === 'SCRIPT_ALLOWLIST_PROPOSED') && audit.some((a) => a.action === 'SCRIPT_ALLOWLIST_REVOKED' && a.metadata?.reason === 'found a bug'), 'proposing and revoking are audited');
  }

  section('Retention: output is pruned after 90 days; the summary stays');
  {
    const { ScriptRunService } = require(path.join(dist, 'script-run', 'script-run.service.js'));
    const svc = new ScriptRunService(prisma, null, null, null, null);
    const rows = await prisma.scriptRunOutput.findMany({ where: { jobId: run1.job.id } });
    await prisma.scriptRunOutput.update({ where: { id: rows[0].id }, data: { createdAt: new Date(Date.now() - 91 * 86_400_000) } });
    await prisma.scriptRunOutput.update({ where: { id: rows[1].id }, data: { createdAt: new Date(Date.now() - 89 * 86_400_000) } });
    const n = await svc.prune();
    const left = await prisma.scriptRunOutput.findMany({ where: { jobId: run1.job.id } });
    check(n >= 1 && left.length === 1 && left[0].id === rows[1].id, 'the sweep removes the 91-day-old output and keeps the 89-day-old one', `${n} ${left.length}`);
    const g = await req('GET', `/actions/${run1.job.id}`, { s: S.sam, business: acme.id });
    const t = g.data?.targets?.find((x) => x.endpointId === rows[0].endpointId);
    check(t?.scriptOutput?.pruned === true && t.result?.script?.exitCode === 0 && t.status === 'SUCCEEDED', 'the pruned run shows "output pruned", keeping its status and exit code', JSON.stringify(t).slice(0, 300));
  }
}

async function cleanup() {
  await stop('api'); await stop('signer');
  try {
    if (created.businesses.length) {
      await prisma.actionJob.deleteMany({ where: { customerId: { in: created.businesses } } });
      await prisma.script.deleteMany({ where: { customerId: { in: created.businesses } } });
      await prisma.technicianAssignment.deleteMany({ where: { customerId: { in: created.businesses } } });
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

all().catch((e) => { fail++; failures.push(`crashed: ${e.stack ?? e}`); console.error(e); if (kids.api) console.error(kids.api.log.slice(-2500)); if (kids.signer) console.error(kids.signer.log.slice(-1500)); })
  .finally(async () => {
    await cleanup();
    console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
    if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
    process.exit(0);
  });
