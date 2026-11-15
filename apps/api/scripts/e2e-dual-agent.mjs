#!/usr/bin/env node
/**
 * End-to-end proof that which agent a computer runs is sticky to signed
 * (0.51, check-security-invariants §64), through the real heartbeat route,
 * the tray route and the Agent card.
 *
 * It replays what production showed on DS-HOME1 and DEWEY-WKS2022: the
 * signed heartbeat, then the signed install script's own check-ins
 * (Register: a version and no channel; Test-Registered: the device secret
 * only), then a leftover standard heartbeat with live state — and proves:
 *
 *   - none of the three is handed a standard install, a queued reinstall, a
 *     staged RustDesk update, an open migration, or an automatic update
 *     (no AgentAutoUpdateAttempt row, no `standard_pre015`);
 *   - updateChannel stays `signed`, and agentVersion, agentSha256, the
 *     action list and the tray protocol are the signed agent's;
 *   - the leftover is recorded (legacySeenAt), audited once
 *     (AGENT_DUAL_REPORT, not again on the next one) and told retireStandard;
 *     the installers' check-ins are not;
 *   - the signed tray host's identify (POST /tray/status with the device
 *     secret) is accepted — even with updateChannel forced to `legacy`, as a
 *     pre-0.51 portal left DEWEY — and a tray key is refused for it;
 *   - the Agent card says "Two agents are reporting from this computer" and
 *     shows the signed agent's version; the Devices list shows it too;
 *   - the signed heartbeat itself is still handed the queued reinstall (as
 *     `rem0te-agent.exe update`), and a standard computer beside it is still
 *     handed its automatic update;
 *   - once no signed heartbeat has come for seven days the computer is
 *     standard again, and a standard heartbeat acts.
 *
 *   cd apps/api && npx nest build
 *   DATABASE_URL=postgresql://…/<name ending _scratch_test> node scripts/e2e-dual-agent.mjs
 *   (optional RELEASE_BIN=…/rem0te-release: publishes a signed agent, so the
 *   card compares the build and the signed automatic update has a target)
 *
 * Self-starting: its API runs from dist/ on DUAL_API_PORT (3771). INTEGRATION,
 * not Windows: heartbeats are posted the way heartbeat.ps1 and install.ps1
 * post them. Nothing here ran on Windows.
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const DB = process.env.DATABASE_URL ?? '';
const dbName = DB.split('/').pop()?.split('?')[0] ?? '';
if (!/scratch|test/.test(dbName)) { console.error(`Refusing to run against database "${dbName}": name must contain "scratch" or "test".`); process.exit(2); }
const PORT = Number(process.env.DUAL_API_PORT ?? 3771);
if ([3000, 3001, 3201, 3202, 4000, 4001, 443].includes(PORT)) { console.error(`Refusing port ${PORT}`); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'dual-agent-e2e-password-123';
const D = 24 * 3600_000;
const VERSION_FILE = path.resolve(here, '..', '..', '..', 'version.json');
const SERVED = JSON.parse(readFileSync(VERSION_FILE, 'utf8')).version;

let pass = 0, fail = 0;
const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;
const sha = (b) => createHash('sha256').update(b).digest('hex');

// Optional: a real signed repository with a published agent.
let repo = null, SIGNED_SHA = 'c'.repeat(64);
if (process.env.RELEASE_BIN) {
  const BIN = process.env.RELEASE_BIN;
  const work = mkdtempSync(path.join(tmpdir(), 'rem0te-dual-'));
  const keys = path.join(work, 'keys'); mkdirSync(keys);
  repo = path.join(work, 'repo');
  const rel = (...a) => execFileSync(BIN, a, { encoding: 'utf8' });
  for (const k of ['r1', 'r2', 'targets', 'snapshot', 'timestamp']) rel('keygen', '-out', path.join(keys, `${k}.pem`));
  rel('init', '-repo', repo, '-root-key', path.join(keys, 'r1.pem'), '-root-key', path.join(keys, 'r2.pem'), '-root-threshold', '2',
    '-targets-key', path.join(keys, 'targets.pem'), '-snapshot-key', path.join(keys, 'snapshot.pem'), '-timestamp-key', path.join(keys, 'timestamp.pem'));
  const files = path.join(work, 'files'); mkdirSync(files);
  const bin = Buffer.concat([Buffer.from('MZ fake signed agent 0.51 '), randomBytes(64), Buffer.from('REM0TE_INST_URL:'), Buffer.alloc(240)]);
  writeFileSync(path.join(files, 'agent.exe'), bin);
  execFileSync(process.execPath, [path.join(here, 'build-signed-installer.mjs'), '--out', path.join(files, 'install.ps1')]);
  rel('release', '-repo', repo, '-targets-key', path.join(keys, 'targets.pem'), '-snapshot-key', path.join(keys, 'snapshot.pem'), '-timestamp-key', path.join(keys, 'timestamp.pem'),
    '-add', `windows/rem0te-agent.exe=${path.join(files, 'agent.exe')}`, '-add', `windows/install.ps1=${path.join(files, 'install.ps1')}`);
  SIGNED_SHA = sha(bin);
}

const env = {
  ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATABASE_URL: DB,
  JWT_SECRET: randomBytes(32).toString('hex'), LAUNCHER_TOKEN_SECRET: randomBytes(32).toString('hex'),
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? randomBytes(32).toString('hex'), TRUSTED_PROXIES: 'loopback', HBBS_PRESENCE_HOST: '127.0.0.2',
  VERSION_FILE, MONITOR_SWEEP: 'off', AUDIT_SEALER: 'off', CLIENT_UPDATE_SWEEP: 'off', SNAPSHOT_SWEEP: 'off', PATCH_POLICY_SWEEP: 'off', METRIC_SWEEP: 'off',
  AUTO_MIGRATION_SWEEP: 'off', TRAY_SWEEP: 'off', RETENTION_SWEEP: 'off', CHAT_RETENTION_SWEEP: 'off', STALE_SWEEP: 'off',
  // run-e2e.sh exports AGENT_AUTO_UPDATE=off; this suite needs it on to prove nothing is handed out.
  AGENT_AUTO_UPDATE: 'on',
  ...(repo ? { UPDATE_REPO_DIR: repo } : {}),
};
delete env.PUBLIC_API_URL;
let api;
async function startApi() {
  api = spawn(process.execPath, [path.join(dist, 'main.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  api.log = ''; api.stdout.on('data', (d) => { api.log += d; }); api.stderr.on('data', (d) => { api.log += d; });
  for (let i = 0; i < 150; i++) { try { const r = await fetch(`${API}/health`); if (r.status < 500) return; } catch { /* not yet */ } await sleep(300); }
  throw new Error(`api did not come up:\n${api.log.slice(-3000)}`);
}
async function stopApi() { if (!api || api.exitCode !== null || api.signalCode !== null) return; await new Promise((r) => { api.once('exit', r); api.kill('SIGTERM'); }); }

const pace = () => new Promise((res) => setTimeout(res, 60));
async function req(method, p, { s, body } = {}) {
  await pace();
  const h = { 'content-type': 'application/json', 'x-forwarded-for': ip() };
  if (s) h.cookie = s.cookie;
  const r = await fetch(`${API}${p}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j, data: j?.data };
}
async function login(email) {
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip() }, body: JSON.stringify({ email, password: PW }) });
  const m = (r.headers.get('set-cookie') ?? '').match(/access_token=([^;]+)/);
  if (r.status !== 200 || !m) throw new Error(`login ${email}: ${r.status} ${await r.text()}`);
  return { cookie: `access_token=${m[1]}` };
}
const msg = (r) => `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 400)}`;
const code = (r) => r.body?.code ?? r.body?.message?.code ?? r.body?.error?.code;
const ok = (r) => r.status === 200 || r.status === 201;

// ── The four report shapes ───────────────────────────────────────────────────
const live = { loggedOnUser: 'DEWEY\\owner', uptimeSeconds: 7200, cpuLoadPercent: 4, memoryTotalMb: 16000, memoryFreeMb: 9000, rustdeskSessions: 0 };
// heartbeat.ps1, signed variant (channelReport reads agent-status.json).
const signedBeat = (ep, extra = {}) => req('POST', '/enrollment/heartbeat', { body: {
  rustdeskId: ep.rid, agentSecret: ep.secret, hostname: ep.hostname, platform: 'Windows', agentVersion: '0.47.0', rustdeskVersion: '1.4.6',
  updateChannel: 'signed', trustRootVersion: 1, targetsVersion: 7, agentSha256: SIGNED_SHA, agentActions: ['windows.spooler.start@1'], agentTray: 1, agentChat: 2,
  ...live, ...extra } });
// install.ps1 step 6, Register (after a claim, or instead of one).
const register = (ep) => req('POST', '/enrollment/heartbeat', { body: {
  rustdeskId: ep.rid, hostname: ep.hostname, platform: 'Windows', osVersion: 'Microsoft Windows NT 10.0.20348.0', password: 'Perm-Password-1', agentSecret: ep.secret, agentVersion: '0.47.0' } });
// install.ps1 Test-Registered, before 0.51: the device secret and nothing else.
const testRegistered = (ep) => req('POST', '/enrollment/heartbeat', { body: { rustdeskId: ep.rid, hostname: ep.hostname, platform: 'Windows', agentSecret: ep.secret } });
// heartbeat.ps1, standard variant (a leftover).
const legacyBeat = (ep, extra = {}) => req('POST', '/enrollment/heartbeat', { body: {
  rustdeskId: ep.rid, agentSecret: ep.secret, hostname: ep.hostname, platform: 'Windows', agentVersion: '0.46.0', rustdeskVersion: '1.4.6',
  updateChannel: 'legacy', agentTray: 1, trayKeyId: 'a'.repeat(24), ...live, ...extra } });
const flagsOf = (r) => ({ reinstall: r.data?.reinstallAgent ?? null, rustdesk: r.data?.updateRustdesk ?? null, rotate: r.data?.rotate ?? null });
const noFlags = (r) => { const f = flagsOf(r); return f.reinstall === null && f.rustdesk === null && f.rotate === null; };

const created = { businesses: [], users: [] };

async function all() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });
  await prisma.platformSettings.upsert({ where: { id: 'singleton' }, update: { agentAutoUpdateEnabled: true, agentAutoUpdatePerHour: 120, agentAutoUpdateMaxAttempts: 3 }, create: { id: 'singleton' } });

  section(`Fixtures (synthetic): this server serves ${SERVED}${repo ? ', and publishes a signed agent' : ''}. One business, its owner, DEWEY (will run the signed agent) and CONTROL (a standard 0.46.0 agent)`);
  const biz = await prisma.customer.create({ data: { tenantId: tenant.id, name: `Dual ${sfx}` } });
  created.businesses.push(biz.id);
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const owner = await prisma.user.create({ data: { email: `dual-owner-${sfx}@test.invalid`, passwordHash: hash, firstName: 'Dual', lastName: 'Owner', status: 'ACTIVE' } });
  created.users.push(owner.id);
  await prisma.membership.create({ data: { userId: owner.id, tenantId: tenant.id, customerId: biz.id, roleId: roleOwner.id } });
  const mkEp = async (hostname) => {
    const e = await prisma.endpoint.create({ data: { tenantId: tenant.id, customerId: biz.id, name: hostname, hostname, platform: 'Windows', status: 'ACTIVE', isOnline: true, isManaged: true, accessMode: 'COMPANY_WIDE', lastSeenAt: new Date(), agentVersion: '0.46.0', updateChannel: 'legacy', deviceClass: 'WORKSTATION' } });
    const rid = String(100000000 + ((Math.random() * 899999999) | 0));
    const secret = randomBytes(24).toString('hex');
    await prisma.rustdeskNode.create({ data: { tenantId: tenant.id, endpointId: e.id, rustdeskId: rid, version: '1.4.6', agentSecretHash: sha(secret) } });
    return { id: e.id, rid, secret, hostname };
  };
  const dewey = await mkEp(`DEWEY-${sfx}`);
  const control = await mkEp(`CONTROL-${sfx}`);
  await startApi();
  const S = await login(owner.email);
  const ep = () => prisma.endpoint.findUnique({ where: { id: dewey.id } });
  const attempts = (e = dewey) => prisma.agentAutoUpdateAttempt.findMany({ where: { endpointId: e.id } });
  const duals = () => prisma.activityLog.count({ where: { resourceId: dewey.id, action: 'AGENT_DUAL_REPORT' } });

  section('The signed agent reports: the computer is signed, and signedSeenAt is recorded');
  let r = await signedBeat(dewey);
  check(ok(r) && r.data.authenticated === true, 'DEWEY: the signed heartbeat is accepted', msg(r));
  let e = await ep();
  check(e.updateChannel === 'signed' && e.agentSha256 === SIGNED_SHA && e.agentVersion === '0.47.0' && !!e.signedSeenAt && e.trayProtocol === 1 && e.agentActions.length === 1,
    'updateChannel signed, its build, 0.47.0, the tray and its action list on record', JSON.stringify({ c: e.updateChannel, v: e.agentVersion, s: e.signedSeenAt, t: e.trayProtocol, a: e.agentActions }));
  const signedSeen1 = e.signedSeenAt;

  section('Something standard is waiting for it: a queued Reinstall, a staged RustDesk update, an open migration');
  await prisma.rustdeskNode.update({ where: { endpointId: dewey.id }, data: { reinstallRequestedAt: new Date(), reinstallRequestedBy: owner.id, updateRequestedAt: new Date(), updateTargetVersion: '9.9.9', updateRequestSource: 'MANUAL' } });
  const migration = await prisma.agentMigration.create({ data: { tenantId: tenant.id, customerId: biz.id, endpointId: dewey.id, nonce: `mig_${randomBytes(30).toString('base64url')}`, reason: 'e2e: an old 0.37-era request', requestedAt: new Date(Date.now() - 2 * D) } }).catch((err) => { console.log(`      (no migration row: ${String(err.message).slice(0, 160)})`); return null; });
  check(true, `queued (${migration ? 'with' : 'without'} a migration row)`);

  section('The signed install script\'s own check-ins (DS-HOME1 18:17, DEWEY 23:17–23:24) get nothing and change nothing');
  r = await register(dewey);
  check(ok(r) && noFlags(r) && (r.data.commands ?? []).length === 0 && r.data.retireStandard === undefined && 'rustdeskRegistered' in r.data,
    'Register (a version, no channel): no flag, no rotation, no command, no retireStandard; the registration answer is there', msg(r));
  r = await testRegistered(dewey);
  check(ok(r) && noFlags(r) && 'rustdeskRegistered' in r.data && r.data.retireStandard === undefined, 'Test-Registered (the device secret only): the same', msg(r));
  e = await ep();
  check(e.updateChannel === 'signed' && e.agentSha256 === SIGNED_SHA && e.agentVersion === '0.47.0' && e.trayProtocol === 1 && e.agentActions.length === 1 && e.chatProtocol === 2,
    'updateChannel still signed; version, build, actions, chat and tray untouched', JSON.stringify({ c: e.updateChannel, v: e.agentVersion, sha: e.agentSha256?.slice(0, 8), t: e.trayProtocol, a: e.agentActions, ch: e.chatProtocol }));
  check((await attempts()).length === 0, 'no automatic update attempt (no standard_pre015 row)', JSON.stringify(await attempts()));
  check((await duals()) === 0 && e.legacySeenAt === null, 'not recorded as a second agent: an installer check-in is not one');
  let n = await prisma.rustdeskNode.findUnique({ where: { endpointId: dewey.id } });
  check(!!n.reinstallRequestedAt && n.reinstallDispatchedAt === null && !!n.updateRequestedAt, 'the queued Reinstall was not handed out (not marked dispatched) and the RustDesk update is still staged');
  if (migration) {
    const m = await prisma.agentMigration.findUnique({ where: { id: migration.id } });
    check(m.dispatchedAt === null && m.lastDispatchedAt === null, 'the old migration was not handed out again', JSON.stringify(m));
  }

  section('A leftover standard heartbeat (live state, 0.46.0) beside the signed agent');
  r = await legacyBeat(dewey);
  check(ok(r) && noFlags(r) && r.data.retireStandard === true, 'no flag of any kind, and retireStandard: true', msg(r));
  check((r.data.commands ?? []).length === 0 && (r.data.actions ?? []).length === 0 && r.data.monitor === null && r.data.chat === null && r.data.tray === null && (r.data.diagnostics ?? []).length === 0,
    'no command, action, monitor query, diagnostic, chat or tray pairing', msg(r));
  e = await ep();
  check(e.updateChannel === 'signed' && e.agentVersion === '0.47.0' && e.agentSha256 === SIGNED_SHA && e.trayProtocol === 1, 'still signed, 0.47.0, its build and tray', JSON.stringify({ c: e.updateChannel, v: e.agentVersion, t: e.trayProtocol }));
  check(!!e.legacySeenAt && e.legacySeenVersion === '0.46.0', 'recorded: legacySeenAt, version 0.46.0');
  check((await duals()) === 1, 'audited once as AGENT_DUAL_REPORT');
  r = await legacyBeat(dewey);
  check(noFlags(r) && (await duals()) === 1, 'the next one: still nothing handed out, and not audited again the same day');
  check((await attempts()).length === 0, 'no automatic update attempt');
  n = await prisma.rustdeskNode.findUnique({ where: { endpointId: dewey.id } });
  check(n.reinstallDispatchedAt === null, 'the queued Reinstall is still not handed out');

  section('The signed tray host is recognised by the rule, not by the last heartbeat');
  r = await req('POST', '/tray/status', { body: { rustdeskId: dewey.rid, agentSecret: dewey.secret, localUser: 'DEWEY\\owner' } });
  check(ok(r) && r.data?.agent === 'signed', 'POST /tray/status with the device secret: accepted, as the signed agent', msg(r));
  // What a pre-0.51 portal left on DEWEY: updateChannel legacy, with a signed heartbeat a minute earlier.
  await prisma.endpoint.update({ where: { id: dewey.id }, data: { updateChannel: 'legacy' } });
  r = await req('POST', '/tray/status', { body: { rustdeskId: dewey.rid, agentSecret: dewey.secret, localUser: 'DEWEY\\owner' } });
  check(ok(r) && r.data?.agent === 'signed', 'even with updateChannel forced to legacy (no TRAY_KEY_REQUIRED)', msg(r));
  r = await req('POST', '/tray/self-help/begin', { body: { rustdeskId: dewey.rid, agentSecret: dewey.secret, localUser: 'DEWEY\\owner', tool: 'dns.check' } });
  check(ok(r) && !!r.data?.runId, '"Check DNS" begins (the call that failed on DEWEY at 23:24)', msg(r));
  r = await req('POST', '/tray/pair', { body: { rustdeskId: dewey.rid, agentSecret: dewey.secret } });
  check(r.status === 409 && code(r) === 'TRAY_SIGNED', 'and it cannot be paired for a standard tray key (TRAY_SIGNED)', msg(r));
  await prisma.endpoint.update({ where: { id: dewey.id }, data: { updateChannel: 'signed' } });

  section('The console: the Agent card warns, and both views show the signed agent\'s version');
  r = await req('GET', `/endpoints/${dewey.id}/agent`, { s: S });
  check(ok(r) && r.data.kind === 'signed' && r.data.version === '0.47.0', 'Agent card: Signed (Windows), version 0.47.0', msg(r));
  const w = r.data?.dualAgent;
  check(!!w && /^Two agents are reporting from this computer: /.test(w.text) && /0\.46\.0/.test(w.text) && /rem0te-agent\.exe" update$/.test(w.command) && !!w.fix,
    'it says "Two agents are reporting from this computer: …", with what to do and the command', JSON.stringify(w));
  r = await req('GET', `/endpoints?search=${encodeURIComponent(dewey.hostname)}`, { s: S });
  const row = (r.data?.endpoints ?? r.data?.items ?? []).find?.((x) => x.id === dewey.id);
  check(ok(r) && row && row.agentVersion === '0.47.0' && row.updateChannel === 'signed', 'Devices list: 0.47.0, signed', row ? JSON.stringify({ v: row.agentVersion, c: row.updateChannel }) : msg(r));
  r = await req('GET', `/endpoints/${control.id}/agent`, { s: S });
  check(ok(r) && r.data.dualAgent === null, 'a computer with one agent: no warning', msg(r));

  section('The signed heartbeat still gets what is meant for it; a standard computer still gets its update');
  r = await signedBeat(dewey);
  check(ok(r) && flagsOf(r).reinstall !== null, 'the signed heartbeat is handed the queued Reinstall (it runs rem0te-agent.exe update)', msg(r));
  e = await ep();
  check(e.signedSeenAt > signedSeen1, 'signedSeenAt moves on with each signed heartbeat');
  r = await legacyBeat(control);
  check(ok(r) && flagsOf(r).reinstall?.targetVersion === SERVED && r.data.retireStandard === undefined, `CONTROL (standard 0.46.0) is handed its automatic update to ${SERVED}, and no retireStandard`, msg(r));
  check((await attempts(control)).length === 1 && (await attempts(control))[0].channel === 'standard', 'one standard attempt for CONTROL');

  section('Seven days without a signed heartbeat: the computer is standard again');
  await prisma.endpoint.update({ where: { id: dewey.id }, data: { signedSeenAt: new Date(Date.now() - 8 * D) } });
  r = await legacyBeat(dewey);
  e = await ep();
  check(ok(r) && r.data.retireStandard === undefined && e.updateChannel === 'legacy' && e.agentVersion === '0.46.0', 'a standard heartbeat now acts: legacy, 0.46.0', JSON.stringify({ c: e.updateChannel, v: e.agentVersion, f: flagsOf(r) }));
  r = await req('POST', '/tray/status', { body: { rustdeskId: dewey.rid, agentSecret: dewey.secret, localUser: 'DEWEY\\owner' } });
  check(r.status === 403 && code(r) === 'TRAY_KEY_REQUIRED', 'and the device secret is no longer a tray credential (TRAY_KEY_REQUIRED)', msg(r));
  r = await req('GET', `/endpoints/${dewey.id}/agent`, { s: S });
  check(ok(r) && r.data.kind === 'standard' && r.data.dualAgent === null, 'the card: standard, no warning', msg(r));
}

try {
  await all();
} catch (err) {
  fail++; failures.push(String(err?.stack ?? err));
  console.error(err);
  if (api?.log) console.error(api.log.slice(-2000));
} finally {
  await stopApi();
  for (const id of created.businesses) {
    const eps = await prisma.endpoint.findMany({ where: { customerId: id }, select: { id: true } });
    const ids = eps.map((x) => x.id);
    await prisma.agentAutoUpdateAttempt.deleteMany({ where: { endpointId: { in: ids } } }).catch(() => {});
    await prisma.agentMigration.deleteMany({ where: { endpointId: { in: ids } } }).catch(() => {});
  }
  await prisma.$disconnect();
}
console.log(`\ndual agent: ${pass} passed, ${fail} failed`);
if (fail) { for (const f of failures) console.error(`  ✗ ${f}`); process.exit(1); }
