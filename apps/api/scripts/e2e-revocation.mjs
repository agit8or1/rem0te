#!/usr/bin/env node
/**
 * End-to-end proof of signed revocation (v0.36): a script, or a software
 * catalog entry, revoked AFTER a plan using it was signed is refused by the
 * agent on delivery — from the approval signer's signed revocation
 * statement, not from anything the portal says.
 *
 * Self-contained, like e2e-script-run.mjs: a signed update repository from
 * the offline release tool, the approval signer as its own process, the
 * compiled API on its own port (3621) and a scratch database, synthetic
 * passkeys checked by the signer's real WebAuthn verification, and
 * rem0te-action-sim — the agent's real verifier and executor — which fetches
 * the statement from the portal's relay with the agent's own code
 * (internal/agent.FetchRevocations), or takes one from a file to play a
 * dishonest portal.
 *
 *   cd apps/api && npx nest build
 *   (cd ../../tools/windows-installer && go build -o /tmp/rem0te-release ./cmd/rem0te-release \
 *      && go build -o /tmp/rem0te-action-sim ./cmd/rem0te-action-sim)
 *   RELEASE_BIN=/tmp/rem0te-release ACTION_SIM=/tmp/rem0te-action-sim PWSH=$(command -v pwsh) \
 *   DATABASE_URL=postgresql://…/rem0te_revocation_test node scripts/e2e-revocation.mjs
 *
 * What it does NOT prove: anything about Windows (the sim runs PowerShell 7
 * on Linux and a stub winget), or that a deployed agent has this rule — it
 * takes effect only once a signed agent build containing it is published.
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign as edSign, verify as edVerify } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syntheticPasskey } from './lib/synthetic-passkey.mjs';

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
const PORT = Number(process.env.REVOCATION_API_PORT ?? 3621);
const SIGNER_PUBLIC = Number(process.env.REVOCATION_SIGNER_PUBLIC_PORT ?? 3622);
const SIGNER_INTERNAL = Number(process.env.REVOCATION_SIGNER_INTERNAL_PORT ?? 3623);
if ([PORT, SIGNER_PUBLIC, SIGNER_INTERNAL].some((p) => [3000, 3001, 443, 3201, 3202, 4000, 4001].includes(p))) { console.error('refusing a production port'); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
const ORIGIN = `http://127.0.0.1:${SIGNER_PUBLIC}`;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'revocation-e2e-password-123';
const ACTIONS = ['windows.service.start@1', 'windows.update.install@1', 'windows.service.restart@1', 'windows.reboot.schedule@1', 'windows.reboot.cancel@1', 'windows.logs.collect@1', 'windows.script.run@1', 'windows.software.install@1', 'windows.software.uninstall@1'];
const WINGET = 'v1.9.25200';

let pass = 0, fail = 0; const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;
const sha = (b) => createHash('sha256').update(b).digest('hex');

const scriptOf = (tag) => ['param([Parameter(Mandatory)][string]$Name)', `Write-Output "${tag} $Name"`, ''].join('\n');
const S1 = scriptOf('first-script'), S2 = scriptOf('second-script');
const DECLS = [{ name: 'Name', type: 'string', required: true, charset: 'identifier', maxLength: 32 }];
const NPP = { id: 'Notepad++.Notepad++', version: '8.7.1', bytes: 'Notepad++ 8.7.1 installer (synthetic)' };

// ── The release machine ─────────────────────────────────────────────────────
const work = mkdtempSync(path.join(tmpdir(), 'rem0te-revocation-'));
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
const agentBin = Buffer.concat([Buffer.from('MZ stand-in signed agent 0.36 '), randomBytes(64), slot]);
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
  MONITOR_SWEEP: 'off', CLIENT_UPDATE_SWEEP: 'off', PATCH_POLICY_SWEEP: 'off', METRIC_SWEEP: 'off', SCRIPT_OUTPUT_SWEEP: 'off', SNAPSHOT_SWEEP: 'off', RETENTION_SWEEP: 'off',
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
  await sleep(60); // under the 20 req/s burst throttler
  return { status: r.status, body: j, data: j?.data, setCookie: r.headers.get('set-cookie') ?? '', headers: r.headers };
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
const msg = (r) => `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`;
const sj = async (url, init = {}) => { const r = await fetch(url, init); let b = null; try { b = await r.json(); } catch { /* html */ } return { status: r.status, body: b }; };
const signerPost = (p, body) => sj(`${ORIGIN}/approve/${p}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify(body) });
async function approve(id, who, { script = false } = {}) {
  const base = script ? `script/${id}` : id;
  const c = await signerPost(`${base}/challenge`, script ? { decision: 'approve' } : { decision: 'approve', role: 'approver' });
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
const journalOf = (ep, jobId) => { const f = path.join(ep.state, 'actions', 'journal', `${jobId}.json`); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null; };
const heldOf = (ep) => { const f = path.join(ep.state, 'actions', 'revocations.json'); return existsSync(f) ? JSON.parse(Buffer.from(JSON.parse(readFileSync(f, 'utf8')).statement, 'base64').toString('utf8')) : null; };
let keysFile;
// How the agent gets its statement: 'portal' (the relay, through the agent's
// own fetch), a file (a dishonest portal), or none.
function runAgent(ep, jobId, item, { revocations = 'portal', winget = false } = {}) {
  const tag = `${jobId}-${randomBytes(3).toString('hex')}`;
  const envFile = path.join(work, `env-${tag}.json`);
  writeFileSync(envFile, JSON.stringify(item.envelope));
  const args = ['-state', ep.state, '-keys', keysFile, '-job', jobId, '-envelope', envFile, '-rustdesk-id', ep.rid, '-secret', ep.secret, '-product-type', '1', '-self-sha', AGENT_SHA];
  if (item.script?.content !== undefined) { const f = path.join(work, `script-${tag}.b64`); writeFileSync(f, item.script.content); args.push('-script', f, '-pwsh', PWSH, '-script-minute', '3s'); }
  if (revocations === 'portal') args.push('-portal', `127.0.0.1:${PORT}`);
  else if (revocations) { const f = path.join(work, `rev-${tag}.json`); writeFileSync(f, revocations); args.push('-revocations', f); }
  if (winget) args.push('-winget', path.join(ep.state, 'winget.json'));
  return JSON.parse(execFileSync(SIM, args, { encoding: 'utf8' }).trim());
}

// The approval key, as agents trust it (approval/keys.json).
let approvalKey;
function verifyStatement(env) {
  if (!env || env.schema !== 'rem0te-revocations-envelope/1' || env.kid !== approvalKey.kid) return null;
  const bytes = Buffer.from(env.statement, 'base64');
  const ok = edVerify(null, Buffer.concat([Buffer.from('rem0te-revocations-v1\n'), bytes]), approvalKey.pub, Buffer.from(env.sig, 'base64'));
  return ok ? JSON.parse(bytes.toString('utf8')) : null;
}
const relay = async () => { const r = await fetch(`${API}/public/approval/revocations.json`); const text = await r.text(); return { status: r.status, text, env: (() => { try { return JSON.parse(text); } catch { return null; } })(), cache: r.headers.get('cache-control') }; };

const created = { businesses: [], users: [] };

async function all() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  const roleUser = await prisma.role.findFirst({ where: { type: 'BUSINESS_USER' } });
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });

  section('Fixtures (synthetic): Acme with FRONTDESK, BACKOFFICE, RECEPTION; Birch with BIRCHPC');
  const acme = await prisma.customer.create({ data: { tenantId: tenant.id, name: `RV Acme ${sfx}` } });
  const birch = await prisma.customer.create({ data: { tenantId: tenant.id, name: `RV Birch ${sfx}` } });
  created.businesses.push(acme.id, birch.id);
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag, extra = {}) => { const u = await prisma.user.create({ data: { email: `rv-${tag}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'RV', lastName: tag, status: 'ACTIVE', ...extra } }); created.users.push(u.id); return u; };
  const member = (u, biz, role, capabilities = []) => prisma.membership.create({ data: { userId: u.id, tenantId: tenant.id, customerId: biz.id, roleId: role.id, capabilities } });
  const abe = await mkUser('abe-author'), rae = await mkUser('rae-reviewer'), sam = await mkUser('sam-l3'), owen = await mkUser('owen-owner');
  const bea = await mkUser('bea-birch-reviewer'), bob = await mkUser('bob-birch-owner');
  const olivia = await mkUser('olivia-approver', { platformPermissions: ['technicians:manage'] }), quinn = await mkUser('quinn-approver', { platformPermissions: ['technicians:manage'] });
  await member(abe, acme, roleUser, ['computers:view', 'scripts:author']);
  await member(rae, acme, roleUser, ['computers:view', 'scripts:review']);
  await member(owen, acme, roleOwner);
  await member(bea, birch, roleUser, ['computers:view', 'scripts:review', 'scripts:author', 'actions:request']);
  await member(bob, birch, roleOwner);
  await prisma.technicianAssignment.create({ data: { tenantId: tenant.id, customerId: acme.id, userId: sam.id, capabilities: ['computers:view', 'actions:request', 'scripts:author'] } });
  const mkEp = async (biz, hostname) => {
    const e = await prisma.endpoint.create({ data: { tenantId: tenant.id, customerId: biz.id, name: hostname, hostname, platform: 'Windows', status: 'ACTIVE', isOnline: true, isManaged: true, accessMode: 'COMPANY_WIDE', lastSeenAt: new Date(), deviceClass: 'WORKSTATION' } });
    const rid = String(100000000 + ((Math.random() * 899999999) | 0));
    const secret = randomBytes(24).toString('hex');
    await prisma.rustdeskNode.create({ data: { tenantId: tenant.id, endpointId: e.id, rustdeskId: rid, agentSecretHash: sha(secret) } });
    const state = path.join(work, `agent-${hostname}`); mkdirSync(state);
    writeFileSync(path.join(state, 'winget.json'), JSON.stringify({ version: WINGET, packages: { [`${NPP.id}@${NPP.version}`]: { installer: NPP.bytes, displayName: 'Notepad++ (64-bit x64)', displayVersion: NPP.version, uninstallKey: 'Notepad++' } } }));
    return { id: e.id, rid, secret, state, hostname };
  };
  const fd = await mkEp(acme, 'FRONTDESK'), bo = await mkEp(acme, 'BACKOFFICE'), rc = await mkEp(acme, 'RECEPTION');
  const bp = await mkEp(birch, 'BIRCHPC');
  const pk = { olivia: syntheticPasskey({ userId: olivia.id, name: 'RV olivia' }), quinn: syntheticPasskey({ userId: quinn.id, name: 'RV quinn' }) };
  for (const k of Object.values(pk)) await prisma.userMfaMethod.create({ data: { userId: k.userId, type: 'WEBAUTHN', isActive: true, credentialId: k.credentialId, publicKey: Buffer.from(k.publicKey, 'base64url'), signCount: 0, name: 'Test key' } });
  check(true, 'two businesses, four computers, eight people');

  start('signer', path.join(dist, 'approval-signer', 'main.js'), signerEnv);
  start('api', path.join(dist, 'main.js'), apiEnv);
  await waitUp(`http://127.0.0.1:${SIGNER_INTERNAL}/internal/v1/keys`, 'signer');
  await waitUp(`${API}/health`, 'api');
  const S = {};
  for (const [k, u] of Object.entries({ abe, rae, sam, owen, bea, bob, olivia, quinn })) S[k] = await login(u.email);

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
    const k = JSON.parse(buf).keys[0];
    approvalKey = { kid: k.kid, pub: createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(k.ed25519, 'base64')]), format: 'der', type: 'spki' }) };
  }
  for (const ep of [fd, bo, rc, bp]) await heartbeat(ep);

  section('The relay: the signer\'s statement, unauthenticated, signed, not cacheable');
  let OLD;
  {
    const r = await relay();
    const st = verifyStatement(r.env);
    check(r.status === 200 && r.cache === 'no-store' && !!st, 'GET /public/approval/revocations.json (no session) → a statement that verifies with the key in approval/keys.json', `${r.status} ${r.text.slice(0, 200)}`);
    check(st?.schema === 'rem0te-revocations/1' && st.seq === 0 && st.scripts.length === 0 && st.software.length === 0, 'nothing is revoked yet: seq 0', JSON.stringify(st));
    OLD = r.text;
  }

  section('Two library scripts, each approved and on the signer\'s allowlist');
  const lib = {};
  for (const [name, content] of [['first', S1], ['second', S2]]) {
    let r = await req('POST', '/scripts', { s: fresh(S.abe), body: { scope: 'business', name: `RV ${name} ${sfx}`, description: `The ${name} script.`, risk: 'medium', parameters: DECLS, content } });
    const scriptId = r.data?.id;
    const v1 = await req('GET', `/scripts/${scriptId}/versions/1`, { s: S.abe });
    const versionId = v1.data?.id ?? v1.data?.version?.id;
    await req('POST', `/scripts/${scriptId}/versions/1/submit`, { s: fresh(S.abe) });
    r = await req('POST', `/scripts/${scriptId}/versions/1/review`, { s: await stepUp(fresh(S.rae)), body: { decision: 'approve', expectedSha256: sha(content), note: 'read it' } });
    const reviewed = r.data?.status === 'APPROVED';
    r = await req('POST', `/script-runs/versions/${versionId}/allowlist`, { s: fresh(S.rae) });
    const entry = r.data;
    await approve(entry.id, pk.olivia, { script: true });
    r = await approve(entry.id, pk.quinn, { script: true });
    check(reviewed && r.body?.status === 'ACTIVE', `the ${name} script: approved in the library, ACTIVE on the signer`, JSON.stringify(r.body).slice(0, 200));
    lib[name] = { scriptId, versionId, entry, content };
  }

  const runBody = (which, endpointIds, over = {}) => ({ scriptVersionId: lib[which].versionId, endpointIds, parameters: { Name: 'world' }, timeoutMinutes: 5, reason: 'Ticket 36: greet', windowHours: 2, ...over });
  async function approvedRun(which, eps) {
    const r = await req('POST', '/script-runs', { s: fresh(S.sam), business: acme.id, body: runBody(which, eps.map((e) => e.id)) });
    if (r.status !== 201) return { r, job: null };
    await approve(r.data.id, pk.olivia);
    await approve(r.data.id, pk.quinn);
    const after = await req('GET', `/actions/${r.data.id}`, { s: S.sam, business: acme.id });
    const plan = await prisma.actionJob.findUnique({ where: { id: r.data.id }, select: { envelope: true } });
    const signedAt = plan?.envelope ? JSON.parse(Buffer.from(plan.envelope.plan, 'base64').toString('utf8')).signedAt : null;
    return { r, job: r.data, status: after.data?.status, signedAt };
  }
  const deliver = async (ep, jobId) => ((await heartbeat(ep)).data?.actions ?? []).find((d) => d.jobId === jobId);
  const report = async (ep) => { const h = await heartbeat(ep, { actionResults: resultsOf(ep) }); clearAcked(ep, h.data?.actionAcks); return h; };

  section('Signed BEFORE the revocation: a run of the first script on FRONTDESK and BACKOFFICE, the second on RECEPTION');
  const runA = await approvedRun('first', [fd, bo]);
  const runB = await approvedRun('second', [rc]);
  check(runA.status === 'APPROVED' && runB.status === 'APPROVED' && !!runA.signedAt, 'both signed by two approvers', JSON.stringify([runA.status, runB.status]));
  const itemA = await deliver(fd, runA.job.id);
  const itemB = await deliver(rc, runB.job.id);
  check(!!itemA?.envelope && !!itemB?.envelope, 'FRONTDESK has the first run\'s envelope and RECEPTION the second\'s (BACKOFFICE has not checked in yet)');

  section('Business isolation');
  {
    const r = await req('POST', `/script-runs/versions/${lib.first.versionId}/allowlist/revoke`, { s: fresh(S.bea), body: { reason: 'not mine' } });
    check(r.status === 404, 'Birch\'s reviewer cannot revoke Acme\'s script → 404', msg(r));
    const st = verifyStatement((await relay()).env);
    check(st?.seq === 0, 'and the statement is unchanged', JSON.stringify(st));
  }

  section('Revoked AFTER signing and delivery');
  {
    const r = await req('POST', `/script-runs/versions/${lib.first.versionId}/allowlist/revoke`, { s: fresh(S.rae), body: { reason: 'it deletes the wrong folder' } });
    check(r.status === 200 && r.data?.status === 'REVOKED', 'Rae revokes the first script', msg(r));
    const rr = await relay();
    const st = verifyStatement(rr.env);
    check(st?.seq === 1 && st.scripts.join() === sha(S1) && Date.parse(st.asOf) >= Date.parse(runA.signedAt), 'the relay at once hands out a new statement: seq 1, naming the content hash, newer than the plan\'s signature', JSON.stringify(st));
  }

  section('A dishonest portal cannot forge or roll back the statement');
  {
    // A statement saying nothing is revoked, freshly dated, signed with a key the agent does not trust.
    const { privateKey } = generateKeyPairSync('ed25519');
    const body = Buffer.from(JSON.stringify({ schema: 'rem0te-revocations/1', seq: 0, asOf: new Date().toISOString(), scripts: [], software: [] }));
    const forged = JSON.stringify({ schema: 'rem0te-revocations-envelope/1', kid: approvalKey.kid, statement: body.toString('base64'), sig: edSign(null, Buffer.concat([Buffer.from('rem0te-revocations-v1\n'), body]), privateKey).toString('base64') });
    let res = runAgent(fd, runA.job.id, itemA, { revocations: forged });
    check(res.outcome === 'refused' && res.reason === 'revocations_stale' && /was refused/.test(res.detail) && !res.script, 'a forged "nothing revoked" statement: refused; the run waits (revocations_stale), nothing ran', JSON.stringify(res).slice(0, 300));
    check(!journalOf(fd, runA.job.id) && !resultsOf(fd).length, 'the job is neither consumed nor reported: the next delivery tries again');
    check(!heldOf(fd), 'and the forgery was not kept');

    res = runAgent(fd, runA.job.id, itemA);
    check(res.outcome === 'refused' && res.reason === 'revoked' && !res.script && /removed from the approval signer's allowlist after the plan was signed/.test(res.detail), 'with the statement from the relay: refused "revoked" before anything ran', JSON.stringify(res).slice(0, 300));
    const j = journalOf(fd, runA.job.id);
    check(j?.state === 'done' && !j.actionId && j.result?.reason === 'revoked', 'journaled done straight from the refusal — never "executing"', JSON.stringify(j).slice(0, 200));
    check(heldOf(fd)?.seq === 1, 'FRONTDESK now holds seq 1');
    res = runAgent(fd, runA.job.id, itemA, { revocations: OLD });
    check(res.outcome === 'refused' && res.reason === 'revoked', 'the same envelope again, with the old statement: answered from the journal, still refused', JSON.stringify(res).slice(0, 200));
    await report(fd);
    const g = await req('GET', `/actions/${runA.job.id}`, { s: S.sam, business: acme.id });
    const tF = g.data?.targets?.find((t) => t.endpointId === fd.id);
    check(tF?.status === 'REFUSED_BY_ENDPOINT' && tF.statusReason === 'revoked' && /allowlist after the plan was signed/.test(tF.result?.detail ?? ''), 'the portal shows FRONTDESK as refused by the computer, reason "revoked", with the agent\'s explanation', JSON.stringify(tF).slice(0, 400));
    const hist = await req('GET', `/endpoints/${fd.id}/actions`, { s: S.owen });
    const hj = (hist.data ?? []).find((x) => x.id === runA.job.id);
    check(hist.status === 200 && hj?.targets?.find((t) => t.endpointId === fd.id)?.statusReason === 'revoked', 'and so does FRONTDESK\'s Actions history, to Acme\'s owner', msg(hist));
    const bh = await req('GET', `/actions/${runA.job.id}`, { s: S.bea });
    check(bh.status === 404, 'Birch cannot read it → 404', msg(bh));
  }

  section('Not yet delivered: the portal does not hand it over');
  {
    const h = await heartbeat(bo);
    check(!(h.data?.actions ?? []).some((a) => a.jobId === runA.job.id), 'BACKOFFICE\'s heartbeat carries no envelope for the revoked run');
    const t = await prisma.actionTarget.findFirst({ where: { jobId: runA.job.id, endpointId: bo.id } });
    check(t?.status === 'CANCELED' && t.statusReason === 'revoked', 'its target is cancelled, reason "revoked"', JSON.stringify(t && { status: t.status, statusReason: t.statusReason }));
  }

  section('An older plan of a script that was NOT revoked still runs');
  {
    const res = runAgent(rc, runB.job.id, itemB);
    check(res.outcome === 'succeeded' && Buffer.from(res.script?.stdout ?? '', 'base64').toString().includes('second-script world'), 'RECEPTION runs the second script (signed before the revocation; the statement names only the first)', JSON.stringify(res).slice(0, 300));
    await report(rc);
  }

  section('Signed AFTER the revocation: freshness and rollback');
  {
    const runC = await approvedRun('second', [fd]);
    const itemC = await deliver(fd, runC.job.id);
    check(!!itemC?.envelope && Date.parse(runC.signedAt) > Date.parse(JSON.parse(Buffer.from(JSON.parse(OLD).statement, 'base64').toString()).asOf), 'a run of the second script on FRONTDESK, signed after the old statement');
    let res = runAgent(fd, runC.job.id, itemC, { revocations: OLD });
    check(res.outcome === 'refused' && res.reason === 'revocations_stale' && res.detail.includes('refused an older revocation statement (seq 0; this computer holds seq 1)'), 'a portal relaying the pre-revocation statement: refused as a rollback, and the run waits', JSON.stringify(res).slice(0, 400));
    check(!journalOf(fd, runC.job.id) && heldOf(fd)?.seq === 1, 'not consumed; FRONTDESK still holds seq 1');
    res = runAgent(fd, runC.job.id, itemC, { revocations: null });
    check(res.outcome === 'refused' && res.reason === 'revocations_stale', 'no statement at all (withheld): the held one is older than the plan, so it waits', JSON.stringify(res).slice(0, 300));
    res = runAgent(fd, runC.job.id, itemC);
    check(res.outcome === 'succeeded', 'with the relay\'s current statement it runs', JSON.stringify(res).slice(0, 300));
    await report(fd);

    const runD = await approvedRun('second', [bo]);
    const itemD = await deliver(bo, runD.job.id);
    res = runAgent(bo, runD.job.id, itemD, { revocations: null });
    check(res.outcome === 'refused' && res.reason === 'revocations_stale' && /no revocation statement/.test(res.detail), 'BACKOFFICE has never had a statement: fail closed, nothing runs', JSON.stringify(res).slice(0, 300));
    res = runAgent(bo, runD.job.id, itemD);
    check(res.outcome === 'succeeded', 'then the relay\'s: it runs', JSON.stringify(res).slice(0, 200));
    await report(bo);
  }

  section('Software: an install signed before its catalog entry is archived');
  {
    const owenF = await stepUp(fresh(S.owen));
    let r = await req('POST', '/software/catalog', { s: owenF, body: { scope: 'business', businessId: acme.id, packageId: NPP.id, name: 'Notepad++', publisher: 'Notepad++ Team', version: NPP.version, hash: { source: 'admin_pasted', installerSha256: sha(NPP.bytes) }, detection: { kind: 'uninstall_key', key: 'Notepad++', compare: 'gte', version: '8.7' } } });
    const npp = r.body?.data;
    check(r.status === 201 && !!npp?.id, 'Acme\'s owner adds Notepad++ to Acme\'s catalog', msg(r));
    r = await req('POST', `/endpoints/${rc.id}/software/${npp.id}/install`, { s: fresh(S.sam), business: acme.id, body: { reason: 'Ticket 36: editor' } });
    const job = r.body?.data?.job;
    await approve(job?.id, pk.olivia);
    await approve(job?.id, pk.quinn);
    const st0 = (await req('GET', `/actions/${job?.id}`, { s: S.sam, business: acme.id })).data?.status;
    check(r.status === 201 && st0 === 'APPROVED', 'Sam requests the install on RECEPTION; two approvers sign it', msg(r));
    const item = await deliver(rc, job.id);
    check(!!item?.envelope, 'delivered to RECEPTION');

    const bobF = await stepUp(fresh(S.bob));
    r = await req('POST', `/software/catalog/${npp.id}/archive`, { s: bobF, body: { reason: 'not mine', expectedRevision: npp.revision } });
    check(r.status === 404, 'Birch\'s owner cannot archive Acme\'s entry → 404', msg(r));
    r = await req('POST', `/software/catalog/${npp.id}/archive`, { s: owenF, body: { reason: 'vendor pulled 8.7.1', expectedRevision: npp.revision } });
    check(r.status === 200 && !!r.body?.data?.archivedAt, 'Acme\'s owner archives it', msg(r));
    const ls = signerCli(['software', 'list']);
    check(ls.status === 0 && ls.stdout.includes(npp.id) && /by portal: vendor pulled 8\.7\.1/.test(ls.stdout), 'archiving revoked the entry on the approval signer, for good', ls.stdout + ls.stderr);
    const audit = await prisma.activityLog.findFirst({ where: { resourceId: npp.id, action: 'SOFTWARE_CATALOG_ARCHIVED' } });
    check(audit?.metadata?.revokedOnSigner === true, 'the archive is audited as revoked on the signer', JSON.stringify(audit?.metadata));
    const st = verifyStatement((await relay()).env);
    check(st?.seq === 2 && st.software.join() === npp.id && st.scripts.join() === sha(S1), 'the statement now names the entry: seq 2', JSON.stringify(st));

    const res = runAgent(rc, job.id, item, { winget: true });
    const calls = JSON.parse(readFileSync(path.join(rc.state, 'winget.json'), 'utf8')).calls ?? [];
    check(res.outcome === 'refused' && res.reason === 'revoked' && /catalog entry was archived after the plan was signed/.test(res.detail) && calls.length === 0, 'RECEPTION refuses the install "revoked"; winget is never asked anything', JSON.stringify({ res, calls }).slice(0, 400));
    await report(rc);
    const g = await req('GET', `/actions/${job.id}`, { s: S.sam, business: acme.id });
    check(g.data?.status === 'REFUSED_BY_ENDPOINT' && g.data.targets?.[0]?.statusReason === 'revoked', 'the portal records it refused by the computer, reason "revoked"', msg(g));
  }

  section('Birch is untouched');
  {
    const r = await req('POST', '/script-runs', { s: fresh(S.bea), body: runBody('second', [bp.id]) });
    check(r.status === 404, 'Birch cannot run Acme\'s script on its own computer → 404 (revocation changed no one\'s access)', msg(r));
    const h = await heartbeat(bp);
    check(h.status === 200 && !(h.data?.actions ?? []).length, 'BIRCHPC has nothing delivered');
  }
}

async function cleanup() {
  await stop('api'); await stop('signer');
  try {
    if (created.businesses.length) {
      await prisma.actionJob.deleteMany({ where: { customerId: { in: created.businesses } } });
      await prisma.softwareDeployment.deleteMany({ where: { customerId: { in: created.businesses } } });
      await prisma.softwareCatalogEntry.deleteMany({ where: { customerId: { in: created.businesses } } });
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
