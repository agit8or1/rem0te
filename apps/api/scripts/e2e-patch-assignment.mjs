#!/usr/bin/env node
/**
 * End-to-end proof of company-wide patch policies and the per-computer Patch
 * policy setting (0.50).
 *
 *   - a company-wide policy names every eligible computer of the business, in
 *     rings the portal builds: a canary it picks (the one that checks in most
 *     reliably), the rest in stable order, a computer without a result key
 *     only in the last ring; and says which computers are left out and why;
 *   - its signed document is an ordinary closed list, admitted by the signer
 *     exactly like a policy made by hand (direct mode: ACTIVE at admission);
 *   - a computer in two policies is refused, by the service and by the
 *     database's one-live-row-per-computer index;
 *   - a new computer brings a revision, after the settle time and inside the
 *     per-business bound, and the new revision supersedes the old;
 *   - Exclude removes a computer by revision; "use policy X" moves it to an
 *     assignable policy of the same business, in one pass;
 *   - nothing is revised while a deployment of the running revision is in
 *     progress;
 *   - (0.63) every revision never expires: its document says expiry "never"
 *     and the portal's expiresAt is null; a revision made before 0.63 (an
 *     expiring document) is renewed once, into one that never expires;
 *   - in signed mode a revision waits for two approvals and the previous
 *     revision keeps running until then;
 *   - revoking a revision by hand ends its policy.
 *
 * Self-contained, like e2e-patch-policies.mjs: its own signed repository,
 * signer (ports 3742/3743) and API from dist (port 3741, sweep every 2 s),
 * against a scratch database, with fixtures removed afterwards.
 *
 *   cd apps/api && npx nest build
 *   RELEASE_BIN=/tmp/rem0te-release ACTION_SIM=/tmp/rem0te-action-sim \
 *   DATABASE_URL=postgresql://…/reboot_remote_it_scratch node scripts/e2e-patch-assignment.mjs
 *
 * FIXTURE-TESTED: no Windows, no real Windows Update, no real authenticator.
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
const PORT = Number(process.env.ASSIGN_API_PORT ?? 3741);
const SIGNER_PUBLIC = Number(process.env.ASSIGN_SIGNER_PUBLIC_PORT ?? 3742);
const SIGNER_INTERNAL = Number(process.env.ASSIGN_SIGNER_INTERNAL_PORT ?? 3743);
if ([PORT, SIGNER_PUBLIC, SIGNER_INTERNAL].some((p) => [3000, 3001, 443, 3201, 3202, 4000, 4001].includes(p))) { console.error('refusing a production port'); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
const ORIGIN = `http://127.0.0.1:${SIGNER_PUBLIC}`;
const INTERNAL = `http://127.0.0.1:${SIGNER_INTERNAL}`;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'assign-e2e-password-123';
/** The per-business bound and the settle time, short for the test (NODE_ENV=test allows below a minute). */
const REVISION_MIN = 0.2, SETTLE_MIN = 0.05;

let pass = 0, fail = 0; const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const hex = (n) => randomBytes(n).toString('hex');

const SEC = '0fa1201d-4330-4fa8-8ae9-b877473b6441';
const CU = { updateId: '5a1b2c3d-0000-4000-8000-000000000021', revision: 201, kb: 'KB5046101', title: '2026-11 Cumulative Update (KB5046101)', classification: SEC, className: 'Security Updates', severity: 'Critical', downloaded: false, rebootBehavior: 1, userInput: false, eulaAccepted: true, browseOnly: false, sizeBytes: 600 << 20 };

// ── The release machine ─────────────────────────────────────────────────────
const work = mkdtempSync(path.join(tmpdir(), 'rem0te-assign-'));
const keys = path.join(work, 'keys'); mkdirSync(keys);
const repo = path.join(work, 'repo');
const files = path.join(work, 'files'); mkdirSync(files);
const signerDir = path.join(work, 'signer'); mkdirSync(signerDir, { mode: 0o700 });
const rel = (...a) => execFileSync(BIN, a, { encoding: 'utf8' });
const signerCli = (args) => spawnSync(process.execPath, [path.join(dist, 'approval-signer', 'main.js'), ...args], { encoding: 'utf8', env: { ...process.env, APPROVAL_SIGNER_DIR: signerDir } });
for (const k of ['r1', 'targets', 'snapshot', 'timestamp']) rel('keygen', '-out', path.join(keys, `${k}.pem`));
rel('init', '-repo', repo, '-root-key', path.join(keys, 'r1.pem'), '-root-threshold', '1', '-targets-key', path.join(keys, 'targets.pem'), '-snapshot-key', path.join(keys, 'snapshot.pem'), '-timestamp-key', path.join(keys, 'timestamp.pem'));
const agentBin = Buffer.concat([Buffer.from('MZ stand-in signed agent 0.50 '), randomBytes(64), Buffer.from('REM0TE_INST_URL:'), Buffer.alloc(240)]);
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
  // Never production's GeoIP file (§54): a path that does not exist.
  GEOIP_DB_PATH: path.join(work, 'no-geoip.mmdb'),
  PATCH_POLICY_SWEEP: 'on', PATCH_POLICY_SWEEP_SECONDS: '2', MONITOR_SWEEP: 'off',
  PATCH_POLICY_REVISION_MINUTES: String(REVISION_MIN), PATCH_POLICY_SETTLE_MINUTES: String(SETTLE_MIN),
};
async function waitUp(url, name) {
  for (let i = 0; i < 120; i++) { try { const r = await fetch(url); if (r.status < 500) return; } catch { /* not yet */ } await sleep(300); }
  throw new Error(`${name} did not come up:\n${kids[name]?.log.slice(-3000)}`);
}

// ── HTTP ────────────────────────────────────────────────────────────────────
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
const post = (url, body) => sj(url, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify(body) });
async function approvePolicy(pid, who) {
  const c = await post(`${ORIGIN}/approve/policy/${pid}/challenge`, { decision: 'approve', role: 'approver' });
  if (c.status !== 200) return c;
  return post(`${ORIGIN}/approve/policy/${pid}/decide`, { challengeId: c.body.challengeId, assertion: who.assert(c.body.options, { origin: ORIGIN }) });
}
async function until(f, ms = 40_000) {
  const t0 = Date.now();
  for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(500); }
}

// ── Simulated computers ─────────────────────────────────────────────────────
const ACTIONS = ['windows.service.start@1', 'windows.update.install@1'];
function sim(pc, args) { return execFileSync(SIM, ['-wua', pc.wua, '-registry', pc.reg, '-portal', `127.0.0.1:${PORT}`, ...args], { encoding: 'utf8' }); }
const scan = (pc) => JSON.parse(sim(pc, ['-scan', '-state', pc.state, '-rustdesk-id', pc.rid, '-secret', pc.secret]).trim());
const unsignedScan = (pc) => { const p = scan(pc); delete p.signed; return p; };
const heartbeat = (pc, extra = {}) => req('POST', '/enrollment/heartbeat', {
  body: { rustdeskId: pc.rid, agentSecret: pc.secret, hostname: pc.hostname, platform: pc.platform ?? 'Windows', updateChannel: pc.channel ?? 'signed', agentActions: ACTIONS, agentSha256: AGENT_SHA, ...extra },
});
const report = (pc) => heartbeat(pc, pc.channel === 'standard' || pc.platform === 'Linux' ? {} : { patchPosture: pc.keyless ? unsignedScan(pc) : scan(pc) });

const created = { businesses: [], users: [] };

async function all() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });
  const leftovers = await prisma.patchPolicy.count({ where: { status: { in: ['ACTIVE', 'AWAITING_APPROVAL'] } } });
  if (leftovers) throw new Error(`refusing: this database already has ${leftovers} live patch polic(y/ies), and this suite runs the sweep, which acts on all of them`);

  section('Fixtures (synthetic): Acme with five signed Windows computers, one standard, one Linux; Birch elsewhere');
  const acme = await prisma.customer.create({ data: { tenantId: tenant.id, name: `PA Acme ${sfx}` } });
  const birch = await prisma.customer.create({ data: { tenantId: tenant.id, name: `PA Birch ${sfx}` } });
  created.businesses.push(acme.id, birch.id);
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag, extra = {}) => { const x = await prisma.user.create({ data: { email: `pa-${tag}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'PA', lastName: tag, status: 'ACTIVE', ...extra } }); created.users.push(x.id); return x; };
  const owen = await mkUser('owen-owner'), bob = await mkUser('bob-birch');
  const olivia = await mkUser('olivia-approver', { platformPermissions: ['technicians:manage'] }), quinn = await mkUser('quinn-approver', { platformPermissions: ['technicians:manage'] });
  await prisma.membership.create({ data: { userId: owen.id, tenantId: tenant.id, customerId: acme.id, roleId: roleOwner.id, capabilities: [] } });
  await prisma.membership.create({ data: { userId: bob.id, tenantId: tenant.id, customerId: birch.id, roleId: roleOwner.id, capabilities: [] } });

  let order = 0;
  const mkPc = async (hostname, opts = {}) => {
    const biz = opts.business ?? acme;
    const e = await prisma.endpoint.create({ data: { tenantId: tenant.id, customerId: biz.id, name: hostname, hostname, status: 'ACTIVE', isOnline: true, isManaged: true, accessMode: 'COMPANY_WIDE', lastSeenAt: new Date(), deviceClass: 'WORKSTATION', platform: opts.platform ?? 'Windows 11 Pro', createdAt: new Date(Date.now() - 86_400_000 + (order++) * 1000) } });
    const rid = String(100000000 + ((Math.random() * 899999999) | 0));
    const secret = hex(24);
    await prisma.rustdeskNode.create({ data: { tenantId: tenant.id, endpointId: e.id, rustdeskId: rid, agentSecretHash: sha(secret) } });
    const state = path.join(work, `pc-${e.id}`); mkdirSync(state);
    const pc = { id: e.id, rid, secret, state, hostname, wua: path.join(state, 'wua.json'), reg: path.join(state, 'registry.json'), ...opts };
    writeFileSync(pc.wua, JSON.stringify({ offered: [], installed: [], superseded: [], history: [] }));
    writeFileSync(pc.reg, JSON.stringify({}));
    if (kids.api) await report(pc);
    return pc;
  };
  const A = await mkPc('PA-A'), B = await mkPc('PA-B'), C = await mkPc('PA-C'), D = await mkPc('PA-D');
  const K = await mkPc('PA-K-NOKEY', { keyless: true });
  const S = await mkPc('PA-STANDARD', { channel: 'standard' });
  const L = await mkPc('PA-LINUX', { platform: 'Linux' });
  const Z = await mkPc('PA-BIRCH', { business: birch });
  // B checks in most reliably: 120 of the last 168 hours; the others fewer.
  const hourly = (pc, n) => prisma.endpointMetricHourly.createMany({ data: Array.from({ length: n }, (_, i) => ({ endpointId: pc.id, hour: new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000 - (i + 1) * 3_600_000), samples: 20 })) });
  await hourly(A, 40); await hourly(B, 120); await hourly(C, 60); await hourly(D, 10);
  check(true, 'eight synthetic computers; B checks in most reliably');

  const pk = { olivia: syntheticPasskey({ userId: olivia.id, name: 'PA olivia' }), quinn: syntheticPasskey({ userId: quinn.id, name: 'PA quinn' }) };
  for (const k of Object.values(pk)) await prisma.userMfaMethod.create({ data: { userId: k.userId, type: 'WEBAUTHN', isActive: true, credentialId: k.credentialId, publicKey: Buffer.from(k.publicKey, 'base64url'), signCount: 0, name: 'Test key' } });

  start('signer', path.join(dist, 'approval-signer', 'main.js'), signerEnv);
  start('api', path.join(dist, 'main.js'), apiEnv);
  await waitUp(`${INTERNAL}/internal/v1/keys`, 'signer');
  await waitUp(`${API}/health`, 'api');
  for (const who of [olivia, quinn]) {
    const s = await login(who.email);
    const list = await req('GET', '/auth/passkeys', { s });
    const mine = (list.body?.data ?? list.body ?? [])[0];
    const add = signerCli(['roster', 'add', '--export', mine.approvalExport, '--approve', '*', '--confirm-fingerprint', mine.approvalFingerprint]);
    if (add.status !== 0) throw new Error(`roster add: ${add.stderr}`);
  }
  const direct = signerCli(['policy', 'set', '--business', acme.id, '--approval', 'direct']);
  check(direct.status === 0, 'Acme is in direct mode on the signer (the production setting)', direct.stderr);
  const Ses = { owen: await login(owen.email), bob: await login(bob.email) };
  for (const pc of [A, B, C, D, K, S, L, Z]) await report(pc);

  const series = async (sid) => (await req('GET', `/patching/series?businessId=${acme.id}`, { s: Ses.owen, business: acme.id })).body?.data?.series?.find((x) => x.id === sid);
  const running = async (sid) => { const s = await prisma.patchPolicySeries.findUnique({ where: { id: sid } }); return s?.currentPolicyId ? prisma.patchPolicy.findUnique({ where: { id: s.currentPolicyId } }) : null; };
  const live = async (pc) => prisma.patchPolicyComputer.findFirst({ where: { endpointId: pc.id, live: true }, include: { policy: { select: { id: true, seriesId: true, revision: true } } } });
  const ids = (doc) => doc.rings.map((r) => r.map((c) => c.endpointId));
  const window = { days: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'], start: '00:00', end: '23:59', timezone: 'UTC' };
  const settings = { allow: { classifications: [SEC] }, soakHours: 0, failureThreshold: 0, window, reboot: 'never', reason: 'Every computer, security updates, every night' };

  section('A company-wide policy: every eligible computer, rings built by the portal');
  let biz, rev1;
  {
    let r = await req('POST', '/patching/series', { s: Ses.owen, business: acme.id, body: { businessId: acme.id, scope: 'business', name: 'Acme company-wide', ...settings } });
    check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED', 'creating one needs a fresh sign-in (as creating any policy does)', msg(r));
    Ses.owenF = await stepUp(Ses.owen);
    r = await req('POST', '/patching/series', { s: Ses.owenF, business: acme.id, body: { businessId: acme.id, scope: 'business', name: 'Acme company-wide', ...settings, rings: [[A.id]] } });
    check(r.status === 400, 'it takes no rings: the portal builds them', msg(r));
    r = await req('POST', '/patching/series', { s: Ses.owenF, business: acme.id, body: { businessId: acme.id, scope: 'business', name: 'Acme company-wide', ...settings } });
    biz = r.body?.data;
    check(r.status === 201 && biz?.scope === 'business' && biz.revisions?.length === 1 && biz.revisions[0].status === 'ACTIVE', 'created; revision 1 is ACTIVE at admission (direct mode)', msg(r));
    rev1 = await running(biz.id);
    const doc = rev1?.document;
    check(!!rev1 && rev1.seriesId === biz.id && rev1.revision === 1, 'revision 1 is running', JSON.stringify(rev1 && { s: rev1.seriesId, r: rev1.revision }));
    check(rev1?.document?.expiry === 'never' && !('expiresAt' in (rev1?.document ?? {})) && rev1?.expiresAt === null, '0.63: revision 1 never expires (signed expiry "never"; the portal\'s expiresAt is null)', JSON.stringify(rev1 && { expiry: rev1.document.expiry, expiresAt: rev1.expiresAt }));
    r = await req('POST', '/patching/series', { s: Ses.owenF, business: acme.id, body: { businessId: acme.id, scope: 'assigned', name: 'With an expiry', ...settings, expiresInDays: 30 } });
    check(r.status === 400, '0.63: a new series takes no expiry (refused, not ignored)', msg(r));
    check(doc?.rings[0].length === 1 && doc.rings[0][0].endpointId === B.id && /most reliably/.test(biz.lastCheck?.canary?.why ?? ''), 'the canary is B, the computer that checks in most reliably', JSON.stringify(biz?.lastCheck?.canary));
    check(JSON.stringify(ids(doc ?? { rings: [] })) === JSON.stringify([[B.id], [A.id, C.id, D.id, K.id]]), 'the rest in one ring, in stable (enrolment) order, the computer without a result key last', JSON.stringify(doc && ids(doc)));
    check(doc?.rings[1].slice(0, 3).every((c) => !!c.resultKey) && !doc.rings[1][3].resultKey, 'K, with no result key, is only in the last ring (§38)');
    const lo = Object.fromEntries((biz.lastCheck?.leftOut ?? []).map((x) => [x.hostname, x.code]));
    check(lo['PA-STANDARD'] === 'no_signed_agent' && lo['PA-LINUX'] === 'not_windows' && !lo['PA-BIRCH'], 'left out, and why: the standard-agent computer (no signed agent), the Linux one (not Windows); another business\'s never appears', JSON.stringify(lo));
    const signer = await sj(`${INTERNAL}/internal/v1/policies/${rev1.id}`);
    check(signer.status === 200 && signer.body?.digest === rev1.digest && signer.body?.status === 'ACTIVE', 'the signer holds revision 1 as an ordinary policy: same digest, ACTIVE', JSON.stringify(signer.body).slice(0, 200));
    check((await prisma.patchPolicyComputer.count({ where: { policyId: rev1.id, live: true } })) === 5, 'its five computers are live in it');
    const created1 = await prisma.activityLog.findFirst({ where: { action: 'PATCH_POLICY_CREATED', resourceId: rev1.id } });
    check(created1?.metadata?.seriesId === biz.id && created1.metadata.revision === 1, 'the revision is audited through the same PATCH_POLICY_CREATED as any policy, naming its series', String(JSON.stringify(created1?.metadata)).slice(0, 200));
    r = await req('POST', '/patching/series', { s: Ses.owenF, business: acme.id, body: { businessId: acme.id, scope: 'business', name: 'A second', ...settings } });
    check(r.status === 409 && code(r) === 'SERIES_EXISTS', 'one company-wide policy per business', msg(r));
    const e = (await req('GET', `/endpoints/${C.id}/patch-policy`, { s: Ses.owen, business: acme.id })).body?.data;
    check(e?.effective?.state === 'covered' && /Inherits the company-wide policy "Acme company-wide" — revision 1, ring 1/.test(e.effective.why), 'the Patches tab: C inherits it — revision 1, ring 1', JSON.stringify(e?.effective));
    const es = (await req('GET', `/endpoints/${S.id}/patch-policy`, { s: Ses.owen, business: acme.id })).body?.data;
    check(es?.effective?.state === 'left_out' && /standard agent/.test(es.effective.why), 'the standard-agent computer: left out, and why', JSON.stringify(es?.effective));
  }

  section('One policy per computer');
  {
    const r = await req('POST', '/patching/policies', { s: Ses.owenF, business: acme.id, body: { businessId: acme.id, name: 'By hand', rings: [[C.id]], allow: { classifications: [SEC] }, soakHours: 0, failureThreshold: 0, window, expiresInDays: 30, reason: 'a second policy' } });
    check(r.status === 409 && code(r) === 'COMPUTER_IN_POLICY', 'a hand-made policy naming a computer the company-wide one patches is refused: COMPUTER_IN_POLICY', msg(r));
    const r2 = await req('POST', '/patching/policies', { s: Ses.owenF, business: acme.id, body: { businessId: acme.id, name: 'By hand', rings: [[S.id]], allow: { classifications: [SEC] }, soakHours: 0, failureThreshold: 0, window, expiresInDays: 30, reason: 'a second policy' } });
    check(r2.status === 409, '…and so is one the company-wide policy covers but left out', msg(r2));
    let refused = false;
    try {
      const other = await prisma.patchPolicy.create({ data: { id: hex(16), customerId: acme.id, name: 'db-only', document: rev1.document, digest: hex(32), status: 'ACTIVE', approvalUrl: 'http://x', expiresAt: null, createdById: owen.id } });
      try { await prisma.patchPolicyComputer.create({ data: { policyId: other.id, endpointId: C.id, customerId: acme.id, ring: 1, live: true } }); } catch { refused = true; }
      await prisma.patchPolicy.delete({ where: { id: other.id } });
    } catch (e) { failures.push(`db fixture: ${e.message}`); }
    check(refused, 'the database refuses a second live row for the same computer (PatchPolicyComputer_one_live)');
    let notActive = false;
    try { await prisma.patchPolicyComputer.update({ where: { policyId_endpointId: { policyId: rev1.id, endpointId: S.id } }, data: { live: true } }); } catch { notActive = true; }
    check(notActive, 'and a live row only for a computer the policy names (no row to widen)');
    let checkRefused = false;
    try { await prisma.$executeRawUnsafe(`UPDATE "Endpoint" SET "patchPolicyMode" = 'policy' WHERE id = $1`, C.id); } catch { checkRefused = true; }
    check(checkRefused, 'the CHECK refuses a setting naming no policy');
  }

  section('A new computer joins by a bounded revision');
  let rev2;
  {
    const E = await mkPc('PA-E-NEW');
    globalThis.E = E;
    const e0 = (await req('GET', `/endpoints/${E.id}/patch-policy`, { s: Ses.owen, business: acme.id })).body?.data;
    check(e0?.effective?.state === 'pending' && /Joins "Acme company-wide" at its next revision/.test(e0.effective.why), 'the new computer: joins at the next revision', JSON.stringify(e0?.effective));
    const claim0 = await prisma.patchPolicyRevisionClaim.findUnique({ where: { customerId: acme.id } });
    rev2 = await until(async () => { const r = await running(biz.id); return r && r.revision === 2 ? r : null; }, 60_000);
    check(!!rev2 && ids(rev2.document).flat().includes(E.id), 'revision 2 names it, and runs', JSON.stringify((await series(biz.id))?.lastCheck));
    if (!rev2) throw new Error('no revision 2');
    check(rev2.createdAt.getTime() - claim0.at.getTime() >= REVISION_MIN * 60_000 - 1500, `…no sooner than the per-business bound (${REVISION_MIN * 60} s) after the first`, `${rev2.createdAt.getTime() - claim0.at.getTime()} ms`);
    check(rev2.supersedesId === rev1.id && /revision 2 \(the computers changed\): adds PA-E-NEW/.test(rev2.document.reason), 'it supersedes revision 1, and its signed reason says what changed', rev2.document.reason);
    const old = await prisma.patchPolicy.findUnique({ where: { id: rev1.id } });
    check(old.status === 'REVOKED' && !!old.supersededAt && !!(await until(async () => (await prisma.patchPolicy.findUnique({ where: { id: rev1.id } }))?.signerRevokedAt)), 'revision 1 is revoked as superseded, and the signer confirms', JSON.stringify({ s: old.status, at: old.supersededAt }));
    check(!!(await prisma.activityLog.findFirst({ where: { action: 'PATCH_POLICY_SUPERSEDED', resourceId: rev1.id } })), 'audited: PATCH_POLICY_SUPERSEDED');
    check((await live(E))?.policy.id === rev2.id && (await live(C))?.policy.id === rev2.id, 'every computer is now live in revision 2 only');
    await sleep(REVISION_MIN * 60_000 + 4000);
    check((await prisma.patchPolicy.count({ where: { seriesId: biz.id } })) === 2, 'nothing changed: no further revision is proposed (no churn)');
  }

  section('Exclude removes a computer by revision');
  let rev3;
  {
    let r = await req('PUT', `/endpoints/${C.id}/patch-policy`, { s: Ses.owen, business: acme.id, body: { mode: 'exclude' } });
    check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED', 'changing the setting needs a fresh sign-in (patching.override)', msg(r));
    check(r.body?.action === 'patching.override' || r.body?.message?.action === 'patching.override' || /patch policy a computer follows/.test(JSON.stringify(r.body)), 'and says what is being confirmed', msg(r));
    r = await req('PUT', `/endpoints/${C.id}/patch-policy`, { s: Ses.bob, business: birch.id, body: { mode: 'exclude' } });
    check(r.status === 404 || r.status === 403, 'another business\'s owner cannot change it', msg(r));
    r = await req('PUT', `/endpoints/${C.id}/patch-policy`, { s: Ses.owenF, business: acme.id, body: { mode: 'everything' } });
    check(r.status === 400, 'only inherit, exclude or a policy', msg(r));
    r = await req('PUT', `/endpoints/${C.id}/patch-policy`, { s: Ses.owenF, business: acme.id, body: { mode: 'exclude' } });
    check(r.status === 200 && r.body?.data?.changed === true && r.body.data.effective?.state === 'excluded', 'set to Exclude: the tab says no automatic patching at once', msg(r));
    const au = await prisma.activityLog.findFirst({ where: { action: 'PATCH_POLICY_OVERRIDE_SET', resourceId: C.id }, orderBy: { createdAt: 'desc' } });
    check(au?.metadata?.before?.mode === 'inherit' && au.metadata.after?.mode === 'exclude' && au.actorId === owen.id, 'audited with the value before and after', JSON.stringify(au?.metadata));
    rev3 = await until(async () => { const x = await running(biz.id); return x && x.revision === 3 ? x : null; }, 60_000);
    check(!!rev3 && !ids(rev3.document).flat().includes(C.id) && ids(rev3.document).flat().length === 5, 'revision 3 no longer names C', JSON.stringify((await series(biz.id))?.lastCheck));
    check(!(await live(C)), 'C is live in no policy');
  }

  section('"Use policy X": an assignable policy for servers');
  let servers;
  {
    let r = await req('POST', '/patching/series', { s: Ses.owenF, business: acme.id, body: { businessId: acme.id, scope: 'assigned', name: 'Acme servers', ...settings, reboot: 'if_required_in_window' } });
    servers = r.body?.data;
    check(r.status === 201 && servers?.scope === 'assigned' && servers.revisions.length === 0, 'an assignable policy starts with no revision: no computer uses it yet', msg(r));
    const bx = await req('POST', '/patching/series', { s: Ses.bob, business: birch.id, body: { businessId: birch.id, scope: 'assigned', name: 'Birch servers', ...settings } });
    const bobF = await stepUp(Ses.bob);
    const bx2 = await req('POST', '/patching/series', { s: bobF, business: birch.id, body: { businessId: birch.id, scope: 'assigned', name: 'Birch servers', ...settings } });
    check(bx.status === 403 && bx2.status === 201, 'Birch has its own');
    r = await req('PUT', `/endpoints/${D.id}/patch-policy`, { s: Ses.owenF, business: acme.id, body: { mode: 'policy', seriesId: bx2.body.data.id } });
    check(r.status === 404, 'a computer cannot use another business\'s policy', msg(r));
    let trig = false;
    try { await prisma.endpoint.update({ where: { id: D.id }, data: { patchPolicyMode: 'policy', patchPolicySeriesId: bx2.body.data.id } }); } catch { trig = true; }
    check(trig, '…and the database trigger refuses it too');
    const choices = (await req('GET', `/endpoints/${D.id}/patch-policy`, { s: Ses.owen, business: acme.id })).body?.data?.choices ?? [];
    check(choices.length === 1 && choices[0].id === servers.id, 'the Patches tab offers this business\'s assignable policies only', JSON.stringify(choices));
    r = await req('PUT', `/endpoints/${D.id}/patch-policy`, { s: Ses.owenF, business: acme.id, body: { mode: 'policy', seriesId: servers.id } });
    check(r.status === 200 && r.body?.data?.effective?.state === 'pending', 'D is set to use it: pending until the revisions', msg(r));
    const moved = await until(async () => { const l = await live(D); return l?.policy.seriesId === servers.id ? l : null; }, 70_000);
    check(!!moved, 'D is now live in the servers policy', JSON.stringify({ biz: (await series(biz.id))?.lastCheck, srv: (await series(servers.id))?.lastCheck }));
    const rev4 = await running(biz.id);
    const srv1 = await running(servers.id);
    check(rev4?.revision === 4 && !ids(rev4.document).flat().includes(D.id) && JSON.stringify(ids(srv1.document)) === JSON.stringify([[D.id]]), 'company-wide revision 4 drops D; servers revision 1 names D alone', JSON.stringify({ r4: rev4 && ids(rev4.document), s1: srv1 && ids(srv1.document) }));
    check(Math.abs(rev4.createdAt.getTime() - srv1.createdAt.getTime()) < 10_000, 'both in one revision pass of the business (one claim)', `${rev4.createdAt.toISOString()} / ${srv1.createdAt.toISOString()}`);
    check(srv1.document.reboot === 'if_required_in_window' && rev4.document.reboot === 'never', 'each signed with its own settings');
    const e = (await req('GET', `/endpoints/${D.id}/patch-policy`, { s: Ses.owen, business: acme.id })).body?.data;
    check(e?.effective?.state === 'covered' && /Set to use "Acme servers" — revision 1, the canary/.test(e.effective.why), 'the tab: set to use "Acme servers", revision 1', JSON.stringify(e?.effective));
  }

  section('A monthly assignable policy (0.53)');
  {
    const pt = { kind: 'monthly', week: 'second', weekday: 'tue', offsetDays: 2, start: '22:00', end: '04:00', timezone: 'America/Chicago' };
    let r = await req('POST', '/patching/series', { s: Ses.owenF, business: acme.id, body: { businessId: acme.id, scope: 'assigned', name: 'Acme after Patch Tuesday', ...settings, window: { ...pt, kind: 'yearly' } } });
    check(r.status === 400, 'an unknown window kind is refused for a company-wide or assignable policy', msg(r));
    r = await req('POST', '/patching/series', { s: Ses.owenF, business: acme.id, body: { businessId: acme.id, scope: 'assigned', name: 'Acme after Patch Tuesday', ...settings, window: pt } });
    const mo = r.body?.data;
    const canon = (o) => JSON.stringify(Object.fromEntries(Object.entries(o ?? {}).sort(([x], [y]) => x.localeCompare(y))));
    check(r.status === 201 && canon(mo?.settings?.window) === canon(pt), 'an assignable policy two days after Patch Tuesday is created, its window kept exactly (jsonb orders the keys)', msg(r));
    const listed = (await req('GET', `/patching/series?businessId=${acme.id}`, { s: Ses.owen, business: acme.id })).body?.data?.series?.find((x) => x.id === mo?.id);
    check(listed?.settings?.window?.kind === 'monthly' && listed.nextWindow === null, 'the list shows it monthly, with no install window until a revision runs', JSON.stringify(listed?.settings));
    r = await req('POST', `/patching/series/${mo?.id}/retire`, { s: Ses.owenF, business: acme.id, body: { reason: 'monthly check done' } });
    check(r.status === 200, 'retired again (no computer used it)', msg(r));
  }

  section('Nothing is revised while a deployment is in progress');
  let rev5;
  {
    const canary = (await running(biz.id)).document.rings[0][0];
    const cpc = [A, B, D, K, globalThis.E].find((p) => p.id === canary.endpointId);
    writeFileSync(cpc.wua, JSON.stringify({ offered: [CU], installed: [], superseded: [], history: [] }));
    await sleep(1100); await report(cpc);
    const dep = await until(async () => prisma.patchDeployment.findFirst({ where: { policyId: (await running(biz.id)).id, status: 'ACTIVE' } }), 30_000);
    check(!!dep, 'the sweep starts a deployment of the running revision (its canary plan, signed under it)');
    let r = await req('PUT', `/endpoints/${C.id}/patch-policy`, { s: Ses.owenF, business: acme.id, body: { mode: 'inherit' } });
    check(r.status === 200, 'C goes back to Inherit');
    const held = await until(async () => ((await series(biz.id))?.lastCheck?.code === 'mid_ring' ? true : null), 40_000);
    check(!!held && (await running(biz.id)).revision === 4, 'held: mid_ring, and revision 4 keeps running', JSON.stringify((await series(biz.id))?.lastCheck));
    // Nothing for the next revision's canary to install, so it starts no deployment of its own.
    writeFileSync(cpc.wua, JSON.stringify({ offered: [], installed: [], superseded: [], history: [] }));
    await sleep(1100); await report(cpc);
    r = await req('POST', `/patching/deployments/${dep.id}/cancel`, { s: Ses.owenF, business: acme.id, body: { reason: 'let the revision through' } });
    check(r.status === 200, 'the deployment is canceled', msg(r));
    rev5 = await until(async () => { const x = await running(biz.id); return x?.revision === 5 ? x : null; }, 60_000);
    check(!!rev5 && ids(rev5.document).flat().includes(C.id), 'then revision 5 brings C back', JSON.stringify((await series(biz.id))?.lastCheck));
    if (!rev5) throw new Error('no revision 5');
  }

  section('Expiry (0.63): a never-expiring revision is not renewed; one made before 0.63 is renewed once, into one that never expires');
  {
    check(rev5.document.expiry === 'never' && rev5.expiresAt === null, 'revision 5 never expires', JSON.stringify({ expiry: rev5.document.expiry, expiresAt: rev5.expiresAt }));
    await sleep(6000);
    check((await running(biz.id))?.revision === 5 && (await prisma.patchPolicy.count({ where: { seriesId: biz.id, revision: 6 } })) === 0, 'with nothing changed, nothing is renewed: revision 5 keeps running', JSON.stringify((await series(biz.id))?.lastCheck));
    // The portal's mirror, as a pre-0.63 revision would be: an expiring document 3 days from its end
    // (0084's CHECK needs the stored document and the column to agree).
    const old = { ...rev5.document, expiresAt: new Date(Date.now() + 3 * 86_400_000).toISOString() };
    delete old.expiry;
    let refusedByCheck = false;
    try { await prisma.patchPolicy.update({ where: { id: rev5.id }, data: { expiresAt: new Date(Date.now() + 3 * 86_400_000) } }); } catch { refusedByCheck = true; }
    check(refusedByCheck, '0084: a date on a row whose signed document says "never" is refused by the database');
    await prisma.patchPolicy.update({ where: { id: rev5.id }, data: { document: old, expiresAt: new Date(old.expiresAt) } });
    const rev6 = await until(async () => { const x = await running(biz.id); return x?.revision === 6 ? x : null; }, 60_000);
    check(!!rev6 && /renewal before expiry/.test(rev6.document.reason) && JSON.stringify(ids(rev6.document)) === JSON.stringify(ids(rev5.document)), 'revision 6 renews it: the same computers', JSON.stringify((await series(biz.id))?.lastCheck));
    check(rev6?.document.expiry === 'never' && rev6.expiresAt === null, '…into a document that never expires, so that renewal is the last', JSON.stringify(rev6 && { expiry: rev6.document.expiry, expiresAt: rev6.expiresAt }));
  }

  section('Signed mode: a revision waits for approval; the running revision keeps running');
  {
    const set = signerCli(['policy', 'set', '--business', acme.id, '--approval', 'signed']);
    check(set.status === 0, 'Acme back to signed mode on the signer', set.stderr);
    const before = await running(biz.id);
    const E = globalThis.E;
    const r = await req('PUT', `/endpoints/${E.id}/patch-policy`, { s: Ses.owenF, business: acme.id, body: { mode: 'exclude' } });
    check(r.status === 200, 'E is set to Exclude');
    const pending = await until(async () => prisma.patchPolicy.findFirst({ where: { seriesId: biz.id, revision: { gt: before.revision }, status: 'AWAITING_APPROVAL' } }), 60_000);
    check(!!pending && !ids(pending.document).flat().includes(E.id), 'revision 7 is proposed and awaits approval', JSON.stringify((await series(biz.id))?.lastCheck));
    await sleep(5000);
    check((await running(biz.id)).id === before.id && (await live(A))?.policy.id === before.id, 'meanwhile revision 6 still runs and its computers stay live in it');
    const e = (await req('GET', `/endpoints/${E.id}/patch-policy`, { s: Ses.owen, business: acme.id })).body?.data;
    check(e?.effective?.state === 'excluded' && /still named by/.test(e.effective.why), 'E is excluded at once — the sweep leaves it out of revision 6 until it is replaced', JSON.stringify(e?.effective));
    await approvePolicy(pending.id, pk.olivia);
    const a2 = await approvePolicy(pending.id, pk.quinn);
    check(a2.body?.status === 'ACTIVE', 'two approvals on the signer: ACTIVE', JSON.stringify(a2.body).slice(0, 200));
    const took = await until(async () => ((await running(biz.id))?.id === pending.id ? true : null), 30_000);
    check(!!took && (await prisma.patchPolicy.findUnique({ where: { id: before.id } })).status === 'REVOKED', 'then it takes over, and revision 6 is superseded');
    signerCli(['policy', 'set', '--business', acme.id, '--approval', 'direct']);
  }

  section('Revoking a revision by hand ends its policy');
  {
    const cur = await running(biz.id);
    const r = await req('POST', `/patching/policies/${cur.id}/revoke`, { s: Ses.owenF, business: acme.id, body: { reason: 'stop automatic patching' } });
    check(r.status === 200, 'revoked', msg(r));
    const s = await prisma.patchPolicySeries.findUnique({ where: { id: biz.id } });
    check(s.status === 'retired' && !s.currentPolicyId, 'the company-wide policy is retired, so nothing proposes it again');
    await sleep(6000);
    check((await prisma.patchPolicy.count({ where: { seriesId: biz.id, status: { in: ['ACTIVE', 'AWAITING_APPROVAL'] } } })) === 0, 'and no revision is proposed after it');
    const e = (await req('GET', `/endpoints/${A.id}/patch-policy`, { s: Ses.owen, business: acme.id })).body?.data;
    check(e?.effective?.state === 'none', 'A now has no automatic patching, and the tab says so', JSON.stringify(e?.effective));
    const rt = await req('POST', `/patching/series/${servers.id}/retire`, { s: Ses.owenF, business: acme.id, body: { reason: 'done' } });
    check(rt.status === 200 && rt.body?.data?.status === 'retired' && !(await live(D)), 'retiring the servers policy withdraws its revision; D is live nowhere', msg(rt));
    check(!!(await prisma.activityLog.findFirst({ where: { action: 'PATCH_POLICY_SERIES_RETIRED', resourceId: servers.id } })), 'audited: PATCH_POLICY_SERIES_RETIRED');
  }
}

async function cleanup() {
  await stop('api'); await stop('signer');
  try {
    if (created.businesses.length) {
      const where = { customerId: { in: created.businesses } };
      await prisma.actionJob.deleteMany({ where });
      await prisma.patchDeployment.deleteMany({ where });
      await prisma.endpoint.updateMany({ where, data: { patchPolicyMode: 'inherit', patchPolicySeriesId: null } });
      await prisma.patchPolicy.deleteMany({ where });
      await prisma.patchPolicySeries.deleteMany({ where });
      await prisma.patchPolicyRevisionClaim.deleteMany({ where });
      const eps = await prisma.endpoint.findMany({ where, select: { id: true } });
      await prisma.endpointMetricHourly.deleteMany({ where: { endpointId: { in: eps.map((e) => e.id) } } });
      await prisma.rustdeskNode.deleteMany({ where: { endpointId: { in: eps.map((e) => e.id) } } });
      await prisma.endpoint.deleteMany({ where: { id: { in: eps.map((e) => e.id) } } });
      await prisma.membership.deleteMany({ where });
      await prisma.customer.deleteMany({ where: { id: { in: created.businesses } } });
    }
    if (created.users.length) await prisma.user.deleteMany({ where: { id: { in: created.users } } });
  } catch (e) { console.error('cleanup:', e.message); }
  await prisma.$disconnect();
  rmSync(work, { recursive: true, force: true });
}

all().catch((e) => { fail++; failures.push(`crashed: ${e.stack ?? e}`); console.error(e); if (kids.api) console.error(kids.api.log.slice(-3000)); if (kids.signer) console.error(kids.signer.log.slice(-1500)); })
  .finally(async () => {
    await cleanup();
    console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
    if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
  });
