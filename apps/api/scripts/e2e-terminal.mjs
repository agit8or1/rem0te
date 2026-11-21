#!/usr/bin/env node
/**
 * End-to-end proof of the background terminal (0.77 Conduit,
 * check-security-invariants §87), through the real routes and the agent's
 * real remote worker (rem0te-remote-sim, built from
 * tools/windows-installer/internal/remote):
 *
 *   - default deny: a Business Owner, a Business User with every computer
 *     capability and an MSP technician cannot open, read or type (403);
 *     another business's computer is a 404 for everyone in scope elsewhere;
 *   - opening asks for a fresh confirmation (terminal.open, which defaults
 *     to ask), a shell and a reason, and refuses a pooled computer, the
 *     standard agent, Linux, an agent older than 0.77.0, an offline computer
 *     and a `remote` containment pause;
 *   - the heartbeat says remotePoll only while a terminal waits; the worker
 *     polls with the device secret (a wrong secret, the standard agent and a
 *     pooled computer are refused), starts the shell, types, streams output
 *     back; nobody but the session's technician sees the output or types;
 *   - reading again (a reconnect, a second sign-in) never moves the idle
 *     clock; Keep alive and input do; the hard limit is never extended;
 *   - ending: the technician closes, a Platform Admin or the business's own
 *     member with Edit computers revokes, anyone else is a 404; the shell
 *     AND a child it started are killed on the computer;
 *   - expiry (idle and hard limit), by a read and by the sweep; a `remote`
 *     pause ends a live session; a worker that lost its shells (restart)
 *     ends the session it no longer holds; another computer's secret cannot
 *     reach a session;
 *   - audit rows for open, start, close, revoke, expiry and end carry ids,
 *     the shell, the reason, durations and byte counts — never a command or
 *     output; no frame is left after a session ends;
 *   - transcripts: off by default (404), a Platform Admin's setting, kept
 *     only for a session opened while on.
 *
 *   cd apps/api && npx nest build
 *   (cd tools/windows-installer && go build -o /tmp/x/rem0te-remote-sim ./cmd/rem0te-remote-sim)
 *   REMOTE_SIM=/tmp/x/rem0te-remote-sim DATABASE_URL=postgresql://…/<scratch or test> node scripts/e2e-terminal.mjs
 *
 * Port 3975 (TERMINAL_API_PORT). SIMULATION: the worker's code is the
 * agent's, but its shell is /bin/sh in a process group, not cmd.exe in a Job
 * Object; the Windows exec site is the lab's (internal/remote/lab_windows_test.go).
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const DB = process.env.DATABASE_URL ?? '';
const dbName = DB.split('/').pop()?.split('?')[0] ?? '';
if (!/scratch|test/.test(dbName)) { console.error(`Refusing to run against database "${dbName}": name must contain "scratch" or "test".`); process.exit(2); }
const PORT = Number(process.env.TERMINAL_API_PORT ?? 3975);
if ([3000, 3001, 3201, 3202, 4000, 4001, 443].includes(PORT)) { console.error(`Refusing port ${PORT}`); process.exit(2); }
const SIM = process.env.REMOTE_SIM ?? '';
if (!SIM || !existsSync(SIM)) { console.error('REMOTE_SIM must name a built rem0te-remote-sim (tools/windows-installer/cmd/rem0te-remote-sim)'); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'terminal-e2e-password-123';
const VERSION_FILE = path.resolve(here, '..', '..', '..', 'version.json');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'rem0te-terminal-'));

let pass = 0, fail = 0;
const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const J = (x) => JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

const env = {
  ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATABASE_URL: DB,
  JWT_SECRET: randomBytes(32).toString('hex'), LAUNCHER_TOKEN_SECRET: randomBytes(32).toString('hex'),
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? randomBytes(32).toString('hex'), TRUSTED_PROXIES: 'loopback', HBBS_PRESENCE_HOST: '127.0.0.2',
  VERSION_FILE, MONITOR_SWEEP: 'off', AUDIT_SEALER: 'off', CLIENT_UPDATE_SWEEP: 'off', SNAPSHOT_SWEEP: 'off', PATCH_POLICY_SWEEP: 'off', METRIC_SWEEP: 'off',
  AUTO_MIGRATION_SWEEP: 'off', TRAY_SWEEP: 'off', RETENTION_SWEEP: 'off', CHAT_RETENTION_SWEEP: 'off', STALE_SWEEP: 'off', AGENT_AUTO_UPDATE: 'off',
  // This suite proves the terminal sweep, fast.
  TERMINAL_SWEEP: 'on', TERMINAL_SWEEP_MS: '1000', REMOTE_POLL_HOLD_MS: '3000',
  GEOIP_DB_PATH: path.join(here, 'no-such-geoip.mmdb'),
};
delete env.PUBLIC_API_URL;
delete env.MSA_GRANTS;
let api;
async function startApi() {
  api = spawn(process.execPath, [path.join(dist, 'main.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  api.log = ''; api.stdout.on('data', (d) => { api.log += d; }); api.stderr.on('data', (d) => { api.log += d; });
  for (let i = 0; i < 150; i++) { try { const r = await fetch(`${API}/health`); if (r.status < 500) return; } catch { /* not yet */ } await sleep(300); }
  throw new Error(`api did not come up:\n${api.log.slice(-3000)}`);
}
async function stopApi() { if (!api || api.exitCode !== null || api.signalCode !== null) return; await new Promise((r) => { api.once('exit', r); api.kill('SIGTERM'); }); }

async function req(method, p, { s, body } = {}) {
  await sleep(20);
  const h = { 'content-type': 'application/json', 'x-forwarded-for': ip() };
  if (s) h.cookie = s.cookie;
  const r = await fetch(`${API}${p}`, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j, data: j?.data, text };
}
async function login(email) {
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip() }, body: JSON.stringify({ email, password: PW }) });
  const m = (r.headers.get('set-cookie') ?? '').match(/access_token=([^;]+)/);
  if (r.status !== 200 || !m) throw new Error(`login ${email}: ${r.status} ${await r.text()}`);
  return { cookie: `access_token=${m[1]}` };
}
async function stepUp(s) {
  const r = await fetch(`${API}/auth/step-up`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip(), cookie: s.cookie }, body: JSON.stringify({ password: PW }) });
  const m = (r.headers.get('set-cookie') ?? '').match(/step_up=([^;]+)/);
  if (r.status !== 200 || !m) throw new Error(`step-up: ${r.status} ${await r.text()}`);
  return { cookie: `${s.cookie}; step_up=${m[1]}` };
}
const msg = (r) => `HTTP ${r.status} ${(typeof r.body === 'string' ? r.body : J(r.body)).slice(0, 400)}`;
const code = (r) => r.body?.code ?? r.body?.message?.code ?? r.body?.error?.code;
const ok = (r) => r.status === 200 || r.status === 201;
const action = (r) => r.body?.action ?? r.body?.message?.action ?? r.body?.error?.action;
const isStepUp = (r, a) => r.status === 403 && code(r) === 'STEP_UP_REQUIRED' && (!a || action(r) === a);

const live = { loggedOnUser: 'PC\\user', uptimeSeconds: 7200, cpuLoadPercent: 4, memoryTotalMb: 16000, memoryFreeMb: 9000, rustdeskSessions: 0 };
const signedBeat = (ep) => req('POST', '/enrollment/heartbeat', { body: {
  rustdeskId: ep.rid, agentSecret: ep.secret, hostname: ep.hostname, platform: 'Windows', agentVersion: ep.agentVersion, rustdeskVersion: '1.4.7',
  updateChannel: 'signed', trustRootVersion: 1, targetsVersion: 7, agentSha256: 'c'.repeat(64), agentActions: ['windows.spooler.start@1'], ...live } });
const poll = (ep, extra = {}) => req('POST', '/remote/agent/poll', { body: { rustdeskId: ep.rid, agentSecret: ep.secret, wait: false, ...extra } });
const out = (ep, body) => req('POST', '/remote/agent/terminal/output', { body: { rustdeskId: ep.rid, agentSecret: ep.secret, ...body } });

const T = (ep) => `/endpoints/${ep.id}/terminal`;
const open = (s, ep, body = { shell: 'cmd', reason: 'e2e: check the spooler' }) => req('POST', T(ep), { s, body });
const read = (s, ep, sid, after = 0) => req('GET', `${T(ep)}/sessions/${sid}?after=${after}`, { s });
const type = (s, ep, sid, data) => req('POST', `${T(ep)}/sessions/${sid}/input`, { s, body: { data } });
const end = (s, ep, sid) => req('POST', `${T(ep)}/sessions/${sid}/end`, { s });
const row = (sid) => prisma.terminalSession.findUnique({ where: { id: sid } });

/** Everything the technician has been shown for one session, decoded. */
async function screen(s, ep, sid, want, ms = 15_000) {
  let text = '', after = 0, last;
  const until = Date.now() + ms;
  while (Date.now() < until) {
    last = await read(s, ep, sid, after);
    if (!ok(last)) return { text, last };
    for (const f of last.data.frames) { text += Buffer.from(f.data, 'base64').toString('utf8'); after = f.seq; }
    if (want(text, last.data.session)) return { text, last };
    await sleep(150);
  }
  return { text, last };
}
async function waitRow(sid, pred, ms = 15_000) {
  const until = Date.now() + ms;
  let r;
  while (Date.now() < until) { r = await row(sid); if (r && pred(r)) return r; await sleep(150); }
  return r;
}
const alive = (pid) => { try { process.kill(pid, 0); } catch { return false; } try { return !/^\S+ \S+ Z/.test(readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/\(.*\)/, 'x')); } catch { return false; } };
async function gone(pid, ms = 10_000) { const until = Date.now() + ms; while (Date.now() < until) { if (!alive(pid)) return true; await sleep(100); } return false; }

const sims = [];
function startSim(ep, extra = []) {
  const log = path.join(tmp, `sim-${ep.hostname}-${sims.length}.log`);
  const p = spawn(SIM, ['-api', API, '-rustdesk-id', ep.rid, '-secret', ep.secret, '-sh', '/bin/sh', '-idle-exit', '60s', '-log', log, ...extra], { stdio: 'ignore' });
  p.logPath = log;
  sims.push(p);
  return p;
}
async function stopSim(p) { if (p.exitCode !== null || p.signalCode !== null) return; await new Promise((r) => { p.once('exit', r); p.kill('SIGTERM'); }); }

const created = { businesses: [], users: [], pauses: [], endpoints: [] };
let savedConfirm;

async function all() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });
  const roleUser = await prisma.role.findFirst({ where: { type: 'BUSINESS_USER' } });
  // terminal.open must be at its default (ask) for this run: no row.
  savedConfirm = await prisma.confirmPolicy.findUnique({ where: { key: 'terminal.open' } });
  if (savedConfirm) await prisma.confirmPolicy.delete({ where: { key: 'terminal.open' } });

  section('Fixtures (synthetic): businesses A and B, two Platform Admins, owners, a Business User with Edit computers, an MSP technician; signed, standard, Linux, old, offline and pooled computers');
  const bizA = await prisma.customer.create({ data: { tenantId: tenant.id, name: `Term A ${sfx}` } });
  const bizB = await prisma.customer.create({ data: { tenantId: tenant.id, name: `Term B ${sfx}` } });
  created.businesses.push(bizA.id, bizB.id);
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag, biz, role, { capabilities = [], admin = false } = {}) => {
    const u = await prisma.user.create({ data: { email: `term-${tag}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'Term', lastName: tag, status: 'ACTIVE', isPlatformAdmin: admin } });
    created.users.push(u.id);
    if (biz) await prisma.membership.create({ data: { userId: u.id, tenantId: tenant.id, customerId: biz.id, roleId: role.id, capabilities } });
    return u;
  };
  const admin = await mkUser('admin', null, null, { admin: true });
  const admin2 = await mkUser('admin2', null, null, { admin: true });
  const ownerA = await mkUser('owner-a', bizA, roleOwner);
  const ownerB = await mkUser('owner-b', bizB, roleOwner);
  // Every capability a business can grant — and a forged computers:terminal, which the sanitiser must not honour.
  const userA = await mkUser('user-a', bizA, roleUser, { capabilities: ['computers:view', 'computers:edit', 'computers:connect', 'computers:terminal'] });
  const tech = await mkUser('tech', null, null);
  const mkEp = async (tag, biz, { channel = 'signed', pooled = false, platform = 'Windows', agentVersion = '0.77.0', online = true } = {}) => {
    const hostname = `TERM-${tag}-${sfx}`;
    const e = await prisma.endpoint.create({ data: {
      tenantId: pooled ? null : tenant.id, customerId: pooled ? null : biz.id, name: hostname, hostname, platform, status: pooled ? 'PENDING_ENROLLMENT' : 'ACTIVE',
      isOnline: online, isManaged: true, accessMode: 'COMPANY_WIDE', lastSeenAt: online ? new Date() : new Date(Date.now() - 3 * 3600_000), agentVersion, updateChannel: channel,
      signedSeenAt: channel === 'signed' ? new Date() : null, deviceClass: 'WORKSTATION' } });
    const rid = String(100000000 + ((Math.random() * 899999999) | 0));
    const secret = randomBytes(24).toString('hex');
    await prisma.rustdeskNode.create({ data: { tenantId: pooled ? null : tenant.id, endpointId: e.id, rustdeskId: rid, version: '1.4.7', agentSecretHash: sha(secret) } });
    created.endpoints.push(e.id);
    return { id: e.id, rid, secret, hostname, agentVersion };
  };
  const A1 = await mkEp('A1', bizA);
  const A2 = await mkEp('A2-STD', bizA, { channel: 'legacy', agentVersion: '0.68.3' });
  const A3 = await mkEp('A3-OLD', bizA, { agentVersion: '0.76.0' });
  const A4 = await mkEp('A4-OFF', bizA, { online: false });
  const L1 = await mkEp('L1-LNX', bizA, { platform: 'linux' });
  const P1 = await mkEp('POOL', null, { pooled: true });
  const B1 = await mkEp('B1', bizB);

  await startApi();
  // The built-in presets are written when the API starts, so a fresh database has them only now.
  const preset = await prisma.technicianPreset.findUnique({ where: { key: 'l2-technician' } });
  if (!preset) throw new Error('the l2-technician preset is missing after the API started');
  await prisma.technicianAssignment.create({ data: { tenantId: tenant.id, customerId: bizA.id, userId: tech.id, presetId: preset.id, capabilities: [] } });
  const SAdmin = await login(admin.email);
  const SAd = await stepUp(SAdmin);
  const SAd2 = await stepUp(await login(admin2.email));
  const SOA = await stepUp(await login(ownerA.email));
  const SOB = await stepUp(await login(ownerB.email));
  const SUA = await stepUp(await login(userA.email));
  // A technician signs in without a business of their own; the capability guard refuses before any confirmation is read.
  const ST = await login(tech.email);

  // ── Default deny ──────────────────────────────────────────────────────────
  section('Default deny: only a Platform Admin holds computers:terminal');
  for (const [who, s] of [['the Business Owner', SOA], ['a Business User with every computer capability (and a forged computers:terminal)', SUA], ['an MSP technician', ST]]) {
    const r = await open(s, A1);
    check(r.status === 403 && code(r) !== 'STEP_UP_REQUIRED', `${who}, confirmed: open is 403`, msg(r));
  }
  let r = await req('GET', T(A1), { s: SOA });
  check(ok(r) && Array.isArray(r.data.sessions), "the owner may list A1's terminals (View computers: metadata only)", msg(r));
  r = await req('GET', T(A1), { s: SOB });
  check(r.status === 404, "business B's owner listing A1: 404", msg(r));
  r = await req('GET', T(B1), { s: SOA });
  check(r.status === 404, "business A's owner listing B1: 404", msg(r));
  check((await prisma.terminalSession.count({ where: { endpointId: { in: created.endpoints } } })) === 0, 'nothing was created');

  section('Opening: a fresh confirmation (terminal.open defaults to ask), a shell and a reason');
  r = await open(SAdmin, A1);
  check(isStepUp(r, 'terminal.open'), 'a Platform Admin without a fresh confirmation: STEP_UP_REQUIRED naming terminal.open', msg(r));
  r = await open(SAd, A1, { shell: 'bash', reason: 'e2e reason' });
  check(r.status === 400 && code(r) === 'TERMINAL_INVALID', 'a shell other than cmd or powershell: 400 TERMINAL_INVALID', msg(r));
  r = await open(SAd, A1, { shell: 'cmd', reason: '  ' });
  check(r.status === 400 && code(r) === 'TERMINAL_REASON_REQUIRED', 'no reason: 400 TERMINAL_REASON_REQUIRED', msg(r));
  r = await open(SAd, A1, { shell: 'cmd', reason: 'x', extra: 1 });
  check(r.status === 400, 'an unknown field: 400', msg(r));

  section('Refusals by the computer');
  const refusals = [[P1, 403, 'ENDPOINT_UNASSIGNED', 'a pooled computer'], [A2, 409, 'TERMINAL_SIGNED_AGENT_REQUIRED', 'the standard agent'],
    [L1, 409, 'TERMINAL_SIGNED_AGENT_REQUIRED', 'Linux'], [A3, 409, 'TERMINAL_AGENT_TOO_OLD', 'an agent older than 0.77.0'], [A4, 409, 'TERMINAL_OFFLINE', 'an offline computer']];
  for (const [ep, st, c, what] of refusals) {
    r = await open(SAd, ep);
    check(r.status === st && code(r) === c, `${what}: ${st} ${c}`, msg(r));
  }
  r = await open(SAd, B1, { shell: 'cmd', reason: 'cross-business is fine for a Platform Admin' });
  check(ok(r) && r.data.state === 'pending', "a Platform Admin may open on business B's computer too", msg(r));
  const sB = r.data?.id;
  check((await end(SOA, B1, sB)).status === 404, "business A's owner cannot end business B's session (404)");
  check(ok(await end(SAd, B1, sB)), 'and the admin closes it');

  // ── The agent channel ────────────────────────────────────────────────────
  section('The heartbeat and the poll');
  r = await signedBeat(A1);
  check(ok(r) && r.data.authenticated === true && r.data.remotePoll === undefined, 'no terminal waiting: the heartbeat says no remotePoll', msg(r));
  r = await req('POST', '/remote/agent/poll', { body: { rustdeskId: A1.rid, agentSecret: 'f'.repeat(48), wait: false } });
  check(r.status === 401, 'a wrong device secret: 401', msg(r));
  r = await poll(A2);
  check(r.status === 403 && code(r) === 'REMOTE_SIGNED_AGENT_REQUIRED', 'the standard agent: 403', msg(r));
  r = await poll(P1);
  check(r.status === 403, 'a pooled computer: 403', msg(r));
  r = await req('POST', '/remote/agent/poll', { body: { rustdeskId: A1.rid, agentSecret: A1.secret, wait: false, junk: 1 } });
  check(r.status === 400, 'an unknown field in the poll: 400', msg(r));

  r = await open(SAd, A1, { shell: 'powershell', reason: 'e2e: check the spooler' });
  check(ok(r) && r.data.state === 'pending' && r.data.identity === 'SYSTEM' && r.data.mine === true && r.data.totalSeconds > 3590, 'open: pending, identity SYSTEM, 60 minutes on the clock', msg(r));
  const s1 = r.data.id;
  r = await open(SAd, A1);
  check(r.status === 409 && code(r) === 'TERMINAL_ALREADY_OPEN', 'a second one by the same technician: 409', msg(r));
  const opened = await prisma.activityLog.findFirst({ where: { action: 'TERMINAL_OPENED', resourceId: s1 } });
  check(!!opened && opened.actorId === admin.id && opened.customerId === bizA.id && opened.metadata.endpointId === A1.id && opened.metadata.reason === 'e2e: check the spooler' && opened.metadata.identity === 'SYSTEM',
    'TERMINAL_OPENED: who, which computer, the reason, SYSTEM', J(opened?.metadata));
  r = await signedBeat(A1);
  check(ok(r) && r.data.remotePoll === true, 'a terminal waits: the heartbeat says remotePoll: true', msg(r));
  r = await poll(B1);
  check(ok(r) && r.data.terminals.length === 0, "business B's computer is told nothing about A1's terminal", msg(r));
  r = await out(B1, { sessionId: s1, started: true });
  check(r.status === 404, "B1's secret posting for A1's session: 404", msg(r));

  section('The worker (the agent\'s code): start, type, output');
  let sim = startSim(A1);
  let row1 = await waitRow(s1, (x) => x.state === 'open');
  check(row1?.state === 'open' && row1.startedAt, 'the worker started the shell: open', J(row1));
  check(!!(await prisma.activityLog.findFirst({ where: { action: 'TERMINAL_STARTED', resourceId: s1 } })), 'TERMINAL_STARTED audited');
  r = await type(SAd, A1, s1, 'echo hello-$((40+2))\n');
  check(ok(r) && r.data.seq === 1, 'input accepted, seq 1', msg(r));
  let sc = await screen(SAd, A1, s1, (t) => t.includes('hello-42'));
  check(sc.text.includes('hello-42'), 'the output came back', sc.text.slice(0, 200));
  r = await type(SAd, A1, s1, 'echo to-stderr 1>&2\n');
  sc = await screen(SAd, A1, s1, (t) => t.includes('to-stderr'));
  check(ok(r) && sc.text.includes('to-stderr'), 'stderr comes back too', sc.text.slice(0, 200));
  r = await type(SAd, A1, s1, 'x'.repeat(4097));
  check(r.status === 400 && code(r) === 'TERMINAL_INPUT_INVALID', 'one input over 4,096 bytes: 400', msg(r));

  section('Bound to one technician');
  r = await read(SAd2, A1, s1);
  check(ok(r) && r.data.frames.length === 0 && r.data.session.mine === false, 'another Platform Admin sees the session, never its output', msg(r));
  r = await type(SAd2, A1, s1, 'whoami\n');
  check(r.status === 404, 'and cannot type into it (404)', msg(r));
  r = await read(SOA, A1, s1);
  check(r.status === 403, 'the owner cannot read it (403)', msg(r));
  r = await req('GET', `${T(A1)}/sessions/${s1}/transcript`, { s: SAd });
  check(r.status === 404 && code(r) === 'TERMINAL_NO_TRANSCRIPT', 'transcripts are off by default: 404', msg(r));

  section('Reconnecting does not move the idle clock; Keep alive and input do');
  const before = (await row(s1)).lastActivityAt.getTime();
  await sleep(1200);
  const SAdAgain = await stepUp(await login(admin.email));
  for (const s of [SAd, SAdAgain, SAdAgain]) await read(s, A1, s1, 0);
  await req('GET', T(A1), { s: SAdAgain });
  await poll(A1, { terminals: [{ id: s1, inAcked: 2 }] });
  check((await row(s1)).lastActivityAt.getTime() === before, 'reads from two sign-ins, a list and the agent\'s poll left lastActivityAt alone');
  r = await req('POST', `${T(A1)}/sessions/${s1}/keepalive`, { s: SAdAgain });
  const afterKeep = (await row(s1)).lastActivityAt.getTime();
  check(ok(r) && afterKeep > before, 'Keep alive moved it', msg(r));
  check((await row(s1)).notAfter.getTime() === row1.notAfter.getTime(), 'the hard limit never moved');

  section('Revocation kills the shell and its child on the computer');
  r = await type(SAd, A1, s1, 'sleep 300 & echo child=$!\n');
  sc = await screen(SAd, A1, s1, (t) => /child=\d+/.test(t));
  const child = Number(sc.text.match(/child=(\d+)/)?.[1]);
  check(ok(r) && child > 0 && alive(child), 'a child process is running under the shell', sc.text.slice(-120));
  r = await end(ST, A1, s1);
  check(r.status === 403 || r.status === 404, 'an MSP technician who did not open it cannot end it', msg(r));
  r = await end(SOB, A1, s1);
  check(r.status === 404, "business B's owner cannot (404)", msg(r));
  r = await end(SUA, A1, s1);
  check(ok(r) && r.data.ended === true && r.data.session.endReason === 'revoked', "business A's own member with Edit computers revokes it", msg(r));
  check(await gone(child), 'the child is gone (the whole process group was killed)');
  r = await type(SAd, A1, s1, 'echo late\n');
  check(r.status === 409 && code(r) === 'TERMINAL_ENDED', 'input after the end: 409 TERMINAL_ENDED', msg(r));
  const revoked = await prisma.activityLog.findFirst({ where: { action: 'TERMINAL_REVOKED', resourceId: s1 } });
  check(revoked && revoked.actorId === userA.id && revoked.metadata.bytesIn > 0 && revoked.metadata.bytesOut > 0 && revoked.metadata.durationMs > 0,
    'TERMINAL_REVOKED: who, duration, byte counts', J(revoked?.metadata));
  check((await prisma.terminalFrame.count({ where: { sessionId: s1 } })) === 0, 'no frame is left after the end');

  section('Closing, and the shell exiting');
  r = await open(SAd, A1, { shell: 'cmd', reason: 'e2e: exit code' });
  const s2 = r.data?.id;
  await waitRow(s2, (x) => x.state === 'open');
  await type(SAd, A1, s2, 'exit 7\n');
  const r2 = await waitRow(s2, (x) => x.state === 'ended');
  check(r2?.endReason === 'exited' && r2.exitCode === 7, 'the shell exiting ends the session with its exit code', J({ e: r2?.endReason, c: r2?.exitCode }));
  r = await open(SAd, A1, { shell: 'cmd', reason: 'e2e: close' });
  const s3 = r.data?.id;
  await waitRow(s3, (x) => x.state === 'open');
  r = await end(SAd, A1, s3);
  check(ok(r) && r.data.session.endReason === 'closed', 'its technician closes it', msg(r));
  check(!!(await prisma.activityLog.findFirst({ where: { action: 'TERMINAL_CLOSED', resourceId: s3, actorId: admin.id } })), 'TERMINAL_CLOSED audited');

  section('Expiry: idle (on read), the hard limit (by the sweep, nobody reading)');
  r = await open(SAd, A1, { shell: 'cmd', reason: 'e2e: idle' });
  const s4 = r.data?.id;
  await waitRow(s4, (x) => x.state === 'open');
  await type(SAd, A1, s4, 'sleep 300 & echo child=$!\n');
  sc = await screen(SAd, A1, s4, (t) => /child=\d+/.test(t));
  const child4 = Number(sc.text.match(/child=(\d+)/)?.[1]);
  await prisma.terminalSession.update({ where: { id: s4 }, data: { lastActivityAt: new Date(Date.now() - 16 * 60_000) } });
  r = await read(SAd, A1, s4);
  check(ok(r) && r.data.session.state === 'ended' && r.data.session.endReason === 'expired_idle', 'after 15 minutes without input: expired_idle', msg(r));
  check(child4 > 0 && await gone(child4), 'the worker was told and killed the tree');
  check(!!(await prisma.activityLog.findFirst({ where: { action: 'TERMINAL_EXPIRED', resourceId: s4 } })), 'TERMINAL_EXPIRED audited');
  r = await open(SAd, A1, { shell: 'cmd', reason: 'e2e: hard limit' });
  const s5 = r.data?.id;
  await waitRow(s5, (x) => x.state === 'open');
  const past = Date.now() - 61 * 60_000;
  await prisma.terminalSession.update({ where: { id: s5 }, data: { createdAt: new Date(past), notAfter: new Date(past + 60 * 60_000), lastActivityAt: new Date(Date.now() - 60_000) } });
  const r5 = await waitRow(s5, (x) => x.state === 'ended', 8000);
  check(r5?.state === 'ended' && r5.endReason === 'expired_max', 'the sweep ended a session past its hard limit with nobody reading it', J({ s: r5?.state, e: r5?.endReason }));

  section('A `remote` containment pause ends a live session and refuses new ones');
  r = await open(SAd, A1, { shell: 'cmd', reason: 'e2e: pause' });
  const s6 = r.data?.id;
  await waitRow(s6, (x) => x.state === 'open');
  const pause = await prisma.containmentPause.create({ data: { scope: 'BUSINESS', customerId: bizA.id, kinds: ['remote'], reason: 'e2e terminal', setById: admin.id, setBy: 'msp' } });
  created.pauses.push(pause.id);
  r = await type(SAd, A1, s6, 'echo paused\n');
  check(r.status === 409 && code(r) === 'TERMINAL_ENDED', 'input under the pause: the session has ended', msg(r));
  check((await row(s6)).endReason === 'paused', 'endReason paused');
  r = await open(SAd, A1);
  check(r.status === 403 && code(r) === 'CONTAINED', 'opening under the pause: 403 CONTAINED', msg(r));
  await prisma.containmentPause.delete({ where: { id: pause.id } });
  created.pauses = created.pauses.filter((x) => x !== pause.id);

  section('A worker that lost its shells ends the session it no longer holds');
  r = await open(SAd, A1, { shell: 'cmd', reason: 'e2e: restart' });
  const s7 = r.data?.id;
  await waitRow(s7, (x) => x.state === 'open');
  await stopSim(sim);
  sim = startSim(A1);
  const r7 = await waitRow(s7, (x) => x.state === 'ended');
  check(r7?.endReason === 'agent_error', 'a new worker polls holding nothing: the open session ends (agent_error)', J({ s: r7?.state, e: r7?.endReason }));

  section('Transcripts: a Platform Admin\'s per-business setting, off by default');
  r = await req('GET', `/remote-ops/settings/${bizA.id}`, { s: SOA });
  check(r.status === 403, 'the owner cannot read the setting', msg(r));
  r = await req('GET', `/remote-ops/settings/${bizA.id}`, { s: SAd });
  check(ok(r) && r.data.terminalTranscripts === false && r.data.transcriptDays === 30, 'default: off, 30 days', msg(r));
  r = await req('PUT', `/remote-ops/settings/${bizA.id}`, { s: SAd, body: { terminalTranscripts: true, transcriptDays: 7 } });
  check(ok(r) && r.data.terminalTranscripts === true, 'turned on', msg(r));
  check(!!(await prisma.activityLog.findFirst({ where: { action: 'REMOTE_OPS_SETTINGS_CHANGED', customerId: bizA.id } })), 'REMOTE_OPS_SETTINGS_CHANGED audited');
  r = await req('PUT', `/remote-ops/settings/${bizA.id}`, { s: SAd, body: { transcriptDays: 999 } });
  check(r.status === 400, 'days outside 1–365: 400', msg(r));
  r = await open(SAd, A1, { shell: 'cmd', reason: 'e2e: transcript' });
  const s8 = r.data?.id;
  check(r.data?.retained === true, 'a session opened while on is retained');
  await waitRow(s8, (x) => x.state === 'open');
  await type(SAd, A1, s8, 'echo kept-$((1+1))\n');
  await screen(SAd, A1, s8, (t) => t.includes('kept-2'));
  await end(SAd, A1, s8);
  r = await req('GET', `${T(A1)}/sessions/${s8}/transcript`, { s: SAd });
  const tx = ok(r) ? r.data.chunks.map((c) => `${c.dir}:${Buffer.from(c.data, 'base64').toString()}`).join('') : '';
  check(tx.includes('in:echo kept-') && tx.includes('out:kept-2'), 'the transcript holds what was typed and printed', msg(r));
  r = await req('GET', `${T(A1)}/sessions/${s8}/transcript`, { s: SOA });
  check(r.status === 403, 'the owner cannot read a transcript', msg(r));
  await req('PUT', `/remote-ops/settings/${bizA.id}`, { s: SAd, body: { terminalTranscripts: false } });

  section('No audit row carries a command or output');
  const rows = await prisma.activityLog.findMany({ where: { action: { in: ['TERMINAL_OPENED', 'TERMINAL_STARTED', 'TERMINAL_CLOSED', 'TERMINAL_EXPIRED', 'TERMINAL_REVOKED', 'TERMINAL_ENDED'] }, customerId: { in: created.businesses } } });
  const blob = J(rows);
  check(rows.length >= 10 && !/hello|echo|sleep|stderr|kept-|child=/.test(blob), `${rows.length} terminal audit rows: none holds input or output`, blob.slice(0, 300));
  const simLogs = sims.map((p) => { try { return readFileSync(p.logPath, 'utf8'); } catch { return ''; } }).join('\n');
  check(simLogs.length > 0 && !/hello|kept-|child=/.test(simLogs) && !simLogs.includes(A1.secret), 'the worker logged no input, output or secret', simLogs.slice(0, 300));
  check(!/hello-42|kept-2/.test(api.log), 'the API logged no input or output');
  await stopSim(sim);
}

try {
  await all();
} catch (err) {
  fail++; failures.push(String(err?.stack ?? err));
  console.error(err);
  if (api?.log) console.error(api.log.slice(-2000));
} finally {
  for (const p of sims) await stopSim(p).catch(() => {});
  await stopApi();
  const ids = created.endpoints;
  await prisma.terminalSession.deleteMany({ where: { endpointId: { in: ids } } }).catch(() => {});
  await prisma.remoteOpsSetting.deleteMany({ where: { businessId: { in: created.businesses } } }).catch(() => {});
  await prisma.containmentPause.deleteMany({ where: { id: { in: created.pauses } } }).catch(() => {});
  if (savedConfirm) await prisma.confirmPolicy.upsert({ where: { key: 'terminal.open' }, update: { value: savedConfirm.value }, create: { key: 'terminal.open', value: savedConfirm.value } }).catch(() => {});
  await prisma.endpoint.updateMany({ where: { id: { in: ids } }, data: { status: 'ARCHIVED', isOnline: false, lastSeenAt: new Date(Date.now() - 24 * 3600_000) } }).catch(() => {});
  await prisma.$disconnect();
}
console.log(`\nterminal: ${pass} passed, ${fail} failed`);
if (fail) { for (const f of failures) console.error(`  ✗ ${f}`); process.exit(1); }
