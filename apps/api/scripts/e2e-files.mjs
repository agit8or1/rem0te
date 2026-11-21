#!/usr/bin/env node
/**
 * End-to-end proof of background file transfer (0.78 Courier,
 * check-security-invariants §87). It runs through the real routes and the
 * agent's real remote worker (rem0te-remote-sim, built from
 * tools/windows-installer/internal/remote, with -files-root).
 *
 *   - Default deny. A Business Owner, a Business User with every computer
 *     capability (and forged file capabilities) and an MSP technician get
 *     403 for both directions. Another business's computer is a 404.
 *   - files.transfer defaults to off. Set to ask, it is STEP_UP_REQUIRED
 *     naming it.
 *   - Refusals: the path rule (UNC, device, "..", relative, a stream), a
 *     reason, the size against the business's limit, the SHA-256, overwrite
 *     on a download; then a pooled computer, the standard agent, Linux, an
 *     agent older than 0.78.0, an offline computer, a `remote` pause and a
 *     third live transfer.
 *   - Upload round trip in chunks. The file on disk has the SHA-256 the
 *     browser declared. An existing file is refused unless overwrite is set.
 *     A missing folder, a symlink (a reparse point) and a wrong declared hash
 *     are refused by the agent. Chunks are gone after the transfer.
 *   - Download round trip. The chunks' and the file's SHA-256 match the file
 *     on disk. A missing file and a folder are refused.
 *   - Only the technician moves bytes. Cancel by the technician, revoke by a
 *     Platform Admin or the business's own member with Edit computers;
 *     another business is a 404.
 *   - A `remote` pause ends a live transfer. The 60-minute limit and 10
 *     minutes without progress end one, by a read and by the sweep.
 *   - The agent channel needs the device secret, and another computer's
 *     secret reaches nothing.
 *   - Audit rows carry ids, direction, path, size and SHA-256, never content.
 *
 *   cd apps/api && npx nest build
 *   (cd tools/windows-installer && go build -o /tmp/x/rem0te-remote-sim ./cmd/rem0te-remote-sim)
 *   REMOTE_SIM=/tmp/x/rem0te-remote-sim DATABASE_URL=postgresql://…/<scratch or test> node scripts/e2e-files.mjs
 *
 * Port 3977 (FILES_API_PORT). SIMULATION: the worker's code is the agent's,
 * but its file system is RootFS (C:\a\b is <root>/C/a/b, a symlink stands
 * in for a reparse point), not WinFS. The Windows file system is the lab's
 * (internal/remote/lab_files_windows_test.go).
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, symlinkSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const DB = process.env.DATABASE_URL ?? '';
const dbName = DB.split('/').pop()?.split('?')[0] ?? '';
if (!/scratch|test/.test(dbName)) { console.error(`Refusing to run against database "${dbName}": name must contain "scratch" or "test".`); process.exit(2); }
const PORT = Number(process.env.FILES_API_PORT ?? 3977);
if ([3000, 3001, 3201, 3202, 4000, 4001, 443].includes(PORT)) { console.error(`Refusing port ${PORT}`); process.exit(2); }
const SIM = process.env.REMOTE_SIM ?? '';
if (!SIM || !existsSync(SIM)) { console.error('REMOTE_SIM must name a built rem0te-remote-sim (tools/windows-installer/cmd/rem0te-remote-sim)'); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'files-e2e-password-123';
const VERSION_FILE = path.resolve(here, '..', '..', '..', 'version.json');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'rem0te-files-'));
const ROOT = path.join(tmp, 'root');
const CHUNK = 512 * 1024;
// A marker in a sent file: no audit row or log may carry it.
const MARKER = `courier-content-${randomBytes(4).toString('hex')}`;

let pass = 0, fail = 0;
const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const J = (x) => JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
const disk = (win) => path.join(ROOT, win[0], ...win.slice(3).split('\\'));

const env = {
  ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATABASE_URL: DB,
  JWT_SECRET: randomBytes(32).toString('hex'), LAUNCHER_TOKEN_SECRET: randomBytes(32).toString('hex'),
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? randomBytes(32).toString('hex'), TRUSTED_PROXIES: 'loopback', HBBS_PRESENCE_HOST: '127.0.0.2',
  VERSION_FILE, MONITOR_SWEEP: 'off', AUDIT_SEALER: 'off', CLIENT_UPDATE_SWEEP: 'off', SNAPSHOT_SWEEP: 'off', PATCH_POLICY_SWEEP: 'off', METRIC_SWEEP: 'off',
  AUTO_MIGRATION_SWEEP: 'off', TRAY_SWEEP: 'off', RETENTION_SWEEP: 'off', CHAT_RETENTION_SWEEP: 'off', STALE_SWEEP: 'off', AGENT_AUTO_UPDATE: 'off',
  // This suite proves the transfer sweep (it is TERMINAL_SWEEP's), fast.
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
  await sleep(10);
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

const F = (ep) => `/endpoints/${ep.id}/files`;
const upload = (s, ep, p, buf, extra = {}) => req('POST', `${F(ep)}/uploads`, { s, body: { path: p, size: buf.length, sha256: sha(buf), overwrite: false, reason: 'e2e: vendor driver', ...extra } });
const download = (s, ep, p, extra = {}) => req('POST', `${F(ep)}/downloads`, { s, body: { path: p, reason: 'e2e: setup log', ...extra } });
const get = (s, ep, tid) => req('GET', `${F(ep)}/${tid}`, { s });
const cancel = (s, ep, tid) => req('POST', `${F(ep)}/${tid}/cancel`, { s });
const row = (tid) => prisma.fileTransfer.findUnique({ where: { id: tid } });
const chunksLeft = (tid) => prisma.fileTransferChunk.count({ where: { transferId: tid } });
async function waitRow(tid, pred, ms = 20_000) {
  const until = Date.now() + ms;
  let r;
  while (Date.now() < until) { r = await row(tid); if (r && pred(r)) return r; await sleep(150); }
  return r;
}
const ended = (x) => !['pending', 'transferring'].includes(x.state);

/** The browser's side of an upload: every chunk in order, waiting while the window is full. */
async function sendChunks(s, ep, tid, buf, ms = 30_000) {
  const total = Math.ceil(buf.length / CHUNK);
  const until = Date.now() + ms;
  let seq = 1, waits = 0, last;
  while (seq <= total && Date.now() < until) {
    const part = buf.subarray((seq - 1) * CHUNK, seq * CHUNK);
    last = await req('POST', `${F(ep)}/${tid}/chunks`, { s, body: { seq, data: part.toString('base64'), sha256: sha(part) } });
    if (ok(last)) { seq++; continue; }
    if (['FILES_WINDOW_FULL', 'FILES_BUSY'].includes(code(last))) { waits++; await sleep(200); continue; }
    break;
  }
  return { sent: seq - 1, waits, last };
}
/** The browser's side of a download: every chunk in order, each checked. */
async function fetchChunks(s, ep, tid, ms = 30_000) {
  const until = Date.now() + ms;
  const parts = [];
  let seq = 1, bad = 0, v;
  while (Date.now() < until) {
    v = (await get(s, ep, tid)).data;
    if (!v || v.state === 'failed' || v.state === 'cancelled') break;
    if (v.state === 'completed' && seq > v.chunks) break;
    if (seq <= v.inSeq) {
      const r = await req('GET', `${F(ep)}/${tid}/chunks/${seq}`, { s });
      if (!ok(r)) { await sleep(200); continue; }
      const b = Buffer.from(r.data.data, 'base64');
      if (sha(b) !== r.data.sha256) bad++;
      parts.push(b); seq++;
      continue;
    }
    await sleep(200);
  }
  return { buf: Buffer.concat(parts), bad, v };
}

const sims = [];
function startSim(ep, extra = []) {
  const log = path.join(tmp, `sim-${ep.hostname}-${sims.length}.log`);
  const p = spawn(SIM, ['-api', API, '-rustdesk-id', ep.rid, '-secret', ep.secret, '-sh', '/bin/sh', '-idle-exit', '120s', '-log', log, '-files-root', ROOT, ...extra], { stdio: 'ignore' });
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
  // files.transfer starts at its catalog default (off) for this run: no row.
  savedConfirm = await prisma.confirmPolicy.findUnique({ where: { key: 'files.transfer' } });
  if (savedConfirm) await prisma.confirmPolicy.delete({ where: { key: 'files.transfer' } });
  mkdirSync(path.join(ROOT, 'C', 'Temp'), { recursive: true });

  section('Fixtures (synthetic): businesses A and B, two Platform Admins, owners, a Business User, an MSP technician; signed, standard, Linux, old, offline and pooled computers');
  const bizA = await prisma.customer.create({ data: { tenantId: tenant.id, name: `Files A ${sfx}` } });
  const bizB = await prisma.customer.create({ data: { tenantId: tenant.id, name: `Files B ${sfx}` } });
  created.businesses.push(bizA.id, bizB.id);
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag, biz, role, { capabilities = [], admin = false } = {}) => {
    const u = await prisma.user.create({ data: { email: `files-${tag}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'Files', lastName: tag, status: 'ACTIVE', isPlatformAdmin: admin } });
    created.users.push(u.id);
    if (biz) await prisma.membership.create({ data: { userId: u.id, tenantId: tenant.id, customerId: biz.id, roleId: role.id, capabilities } });
    return u;
  };
  const admin = await mkUser('admin', null, null, { admin: true });
  const admin2 = await mkUser('admin2', null, null, { admin: true });
  const ownerA = await mkUser('owner-a', bizA, roleOwner);
  const ownerB = await mkUser('owner-b', bizB, roleOwner);
  const userA = await mkUser('user-a', bizA, roleUser, { capabilities: ['computers:view', 'computers:edit', 'computers:connect', 'computers:files_upload', 'computers:files_download'] });
  const tech = await mkUser('tech', null, null);
  const preset = await prisma.technicianPreset.findUnique({ where: { key: 'l2-technician' } });
  if (preset) await prisma.technicianAssignment.create({ data: { tenantId: tenant.id, customerId: bizA.id, userId: tech.id, presetId: preset.id, capabilities: [] } });
  const mkEp = async (tag, biz, { channel = 'signed', pooled = false, platform = 'Windows', agentVersion = '0.78.0', online = true } = {}) => {
    const hostname = `FILES-${tag}-${sfx}`;
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
  const A3 = await mkEp('A3-OLD', bizA, { agentVersion: '0.77.0' });
  const A4 = await mkEp('A4-OFF', bizA, { online: false });
  const A5 = await mkEp('A5', bizA);
  const L1 = await mkEp('L1-LNX', bizA, { platform: 'linux' });
  const P1 = await mkEp('POOL', null, { pooled: true });
  const B1 = await mkEp('B1', bizB);

  await startApi();
  const SAdmin = await login(admin.email);
  const SAd = await stepUp(SAdmin);
  const SAd2 = await stepUp(await login(admin2.email));
  const SOA = await stepUp(await login(ownerA.email));
  const SOB = await stepUp(await login(ownerB.email));
  const SUA = await stepUp(await login(userA.email));
  const ST = await login(tech.email);
  const small = Buffer.from(`hello ${MARKER}\n`);

  // ── Default deny ──────────────────────────────────────────────────────────
  section('Default deny: only a Platform Admin holds computers:files_upload and computers:files_download');
  for (const [who, s] of [['the Business Owner', SOA], ['a Business User with every computer capability (and forged file capabilities)', SUA], ['an MSP technician', ST]]) {
    const u = await upload(s, A1, 'C:\\Temp\\deny.txt', small);
    const d = await download(s, A1, 'C:\\Temp\\deny.txt');
    check(u.status === 403 && d.status === 403 && code(u) !== 'STEP_UP_REQUIRED', `${who}: upload and download are 403`, `${msg(u)} / ${msg(d)}`);
  }
  let r = await req('GET', F(A1), { s: SOA });
  check(ok(r) && Array.isArray(r.data.transfers) && r.data.limits.maxBytes === 100 * 1048576, "the owner may list A1's transfers (metadata only), with the 100 MB default limit", msg(r));
  r = await req('GET', F(A1), { s: SOB });
  check(r.status === 404, "business B's owner listing A1: 404", msg(r));
  r = await upload(SOB, A1, 'C:\\Temp\\x.txt', small);
  check(r.status === 403 || r.status === 404, "business B's owner sending to A1: refused", msg(r));
  check((await prisma.fileTransfer.count({ where: { endpointId: { in: created.endpoints } } })) === 0, 'nothing was created');

  // ── The confirmation ──────────────────────────────────────────────────────
  section('files.transfer: off by default; set to ask, it asks');
  r = await upload(SAdmin, A1, 'C:\\Temp\\off.txt', small);
  check(ok(r) && r.data.state === 'pending' && r.data.identity === 'SYSTEM', 'default off: a Platform Admin without a fresh confirmation may ask for a transfer', msg(r));
  const t0 = r.data?.id;
  check(ok(await cancel(SAdmin, A1, t0)), 'and cancels it');
  r = await req('PUT', '/security/confirm-policy', { s: SAdmin, body: { values: { 'files.transfer': 'ask' } } });
  check(ok(r), 'a Platform Admin sets files.transfer to ask (tightening never asks)', msg(r));
  r = await upload(SAdmin, A1, 'C:\\Temp\\ask.txt', small);
  check(isStepUp(r, 'files.transfer'), 'upload without a fresh confirmation: STEP_UP_REQUIRED naming files.transfer', msg(r));
  r = await download(SAdmin, A1, 'C:\\Temp\\ask.txt');
  check(isStepUp(r, 'files.transfer'), 'download, the same', msg(r));

  // ── Refusals by the request ───────────────────────────────────────────────
  section('Refusals by the request (before anything is stored)');
  for (const [p, what] of [['\\\\server\\share\\x.txt', 'a UNC path'], ['\\\\?\\C:\\x.txt', 'a device path'], ['C:\\Temp\\..\\Windows\\x.txt', '".."'],
    ['Temp\\x.txt', 'a relative path'], ['C:\\Temp\\x.txt:stream', 'an alternate stream'], ['C:\\Temp\\CON', 'a reserved name'], ['C:/Temp/x.txt', 'forward slashes']]) {
    r = await upload(SAd, A1, p, small);
    check(r.status === 400 && code(r) === 'FILES_PATH_REFUSED', `${what}: 400 FILES_PATH_REFUSED`, msg(r));
  }
  r = await upload(SAd, A1, 'C:\\Temp\\x.txt', small, { reason: ' ' });
  check(r.status === 400 && code(r) === 'FILES_REASON_REQUIRED', 'no reason: 400', msg(r));
  r = await upload(SAd, A1, 'C:\\Temp\\x.txt', small, { sha256: 'abc' });
  check(r.status === 400 && code(r) === 'FILES_SHA256_INVALID', 'no SHA-256: 400', msg(r));
  r = await download(SAd, A1, 'C:\\Temp\\x.txt', { overwrite: true });
  check(r.status === 400 && code(r) === 'FILES_INVALID', 'overwrite on a download: 400', msg(r));
  r = await req('PUT', `/remote-ops/settings/${bizA.id}`, { s: SOA, body: { fileMaxMb: 2048 } });
  check(r.status === 403, 'the owner cannot change the size limit', msg(r));
  r = await req('PUT', `/remote-ops/settings/${bizA.id}`, { s: SAd, body: { fileMaxMb: 4096 } });
  check(r.status === 400, 'a limit above 2 GB: 400', msg(r));
  r = await req('PUT', `/remote-ops/settings/${bizA.id}`, { s: SAd, body: { fileMaxMb: 1 } });
  check(ok(r) && r.data.fileMaxMb === 1, 'a Platform Admin sets business A to 1 MB', msg(r));
  r = await req('POST', `${F(A1)}/uploads`, { s: SAd, body: { path: 'C:\\Temp\\big.bin', size: 1048577, sha256: 'a'.repeat(64), overwrite: false, reason: 'e2e: too big' } });
  check(r.status === 400 && code(r) === 'FILES_TOO_LARGE' && /1 MB/.test(r.body.message), 'one byte over the limit: 400 FILES_TOO_LARGE', msg(r));
  await req('PUT', `/remote-ops/settings/${bizA.id}`, { s: SAd, body: { fileMaxMb: 100 } });
  check(!!(await prisma.activityLog.findFirst({ where: { action: 'REMOTE_OPS_SETTINGS_CHANGED', customerId: bizA.id } })), 'the limit change is audited');

  section('Refusals by the computer');
  for (const [ep, st, c, what] of [[P1, 403, 'ENDPOINT_UNASSIGNED', 'a pooled computer'], [A2, 409, 'FILES_SIGNED_AGENT_REQUIRED', 'the standard agent'],
    [L1, 409, 'FILES_SIGNED_AGENT_REQUIRED', 'Linux'], [A3, 409, 'FILES_AGENT_TOO_OLD', 'an agent older than 0.78.0 (0.77.0)'], [A4, 409, 'FILES_OFFLINE', 'an offline computer']]) {
    r = await download(SAd, ep, 'C:\\Temp\\x.txt');
    check(r.status === st && code(r) === c, `${what}: ${st} ${c}`, msg(r));
  }

  // ── Upload ────────────────────────────────────────────────────────────────
  section('Upload: chunks through the portal, the agent writes and checks the SHA-256');
  let sim = startSim(A1);
  const up = Buffer.concat([randomBytes(2 * CHUNK + 4321), Buffer.from(MARKER)]);
  r = await upload(SAd, A1, 'C:\\Temp\\up.bin', up);
  check(ok(r) && r.data.chunks === 3 && r.data.size === up.length, 'a three-chunk upload is accepted', msg(r));
  const tU = r.data?.id;
  r = await req('POST', `${F(A1)}/${tU}/chunks`, { s: SAd2, body: { seq: 1, data: up.subarray(0, CHUNK).toString('base64'), sha256: sha(up.subarray(0, CHUNK)) } });
  check(r.status === 404, "another Platform Admin cannot send chunks for this technician's transfer (404)", msg(r));
  r = await req('POST', `${F(A1)}/${tU}/chunks`, { s: SAd, body: { seq: 1, data: up.subarray(0, CHUNK).toString('base64'), sha256: 'b'.repeat(64) } });
  check(r.status === 400 && code(r) === 'FILES_CHUNK_INVALID', 'a chunk whose SHA-256 does not match: 400', msg(r));
  r = await req('POST', `${F(A1)}/${tU}/chunks`, { s: SAd, body: { seq: 2, data: up.subarray(CHUNK, 2 * CHUNK).toString('base64'), sha256: sha(up.subarray(CHUNK, 2 * CHUNK)) } });
  check(r.status === 409 && code(r) === 'FILES_CHUNK_ORDER', 'chunk 2 before chunk 1: 409 FILES_CHUNK_ORDER', msg(r));
  const sent = await sendChunks(SAd, A1, tU, up);
  check(sent.sent === 3, 'all three chunks sent', msg(sent.last ?? { status: 0, body: '' }));
  let x = await waitRow(tU, ended);
  check(x?.state === 'completed' && x.endReason === 'completed', 'the agent finished the upload', J({ s: x?.state, e: x?.endReason }));
  const onDisk = existsSync(disk('C:\\Temp\\up.bin')) ? readFileSync(disk('C:\\Temp\\up.bin')) : Buffer.alloc(0);
  check(sha(onDisk) === sha(up) && onDisk.length === up.length, 'the file on the computer has the declared SHA-256 and size', `${sha(onDisk)} vs ${sha(up)}`);
  check((await chunksLeft(tU)) === 0, 'no chunk is left on the server');
  check(!readdirSync(path.join(ROOT, 'C', 'Temp')).some((n) => n.endsWith('.part')), 'no temporary file is left on the computer');

  section('Never over an existing file unless asked');
  const v2 = Buffer.from('version two');
  r = await upload(SAd, A1, 'C:\\Temp\\up.bin', v2);
  const tE = r.data?.id;
  await sendChunks(SAd, A1, tE, v2);
  x = await waitRow(tE, ended);
  check(x?.state === 'failed' && x.endReason === 'exists', 'a file is already there: the agent refuses (exists)', J({ s: x?.state, e: x?.endReason }));
  check(sha(readFileSync(disk('C:\\Temp\\up.bin'))) === sha(up), 'and the file is unchanged');
  r = await upload(SAd, A1, 'C:\\Temp\\up.bin', v2, { overwrite: true });
  const tO = r.data?.id;
  await sendChunks(SAd, A1, tO, v2);
  x = await waitRow(tO, ended);
  check(x?.state === 'completed' && readFileSync(disk('C:\\Temp\\up.bin')).equals(v2), 'with overwrite ticked: replaced', J({ s: x?.state, e: x?.endReason }));

  section('The agent refuses what it cannot check');
  r = await upload(SAd, A1, 'C:\\Nowhere\\x.txt', small);
  const tN = r.data?.id;
  await sendChunks(SAd, A1, tN, small);
  x = await waitRow(tN, ended);
  check(x?.endReason === 'no_folder', 'a folder that does not exist: no_folder (nothing is created)', J({ e: x?.endReason }));
  symlinkSync(path.join(ROOT, 'C', 'Temp'), path.join(ROOT, 'C', 'Link'));
  r = await upload(SAd, A1, 'C:\\Link\\x.txt', small);
  const tL = r.data?.id;
  await sendChunks(SAd, A1, tL, small);
  x = await waitRow(tL, ended);
  check(x?.endReason === 'reparse_point' && !existsSync(path.join(ROOT, 'C', 'Temp', 'x.txt')), 'a link on the path: reparse_point, and nothing written through it', J({ e: x?.endReason }));
  r = await upload(SAd, A1, 'C:\\Temp\\lie.txt', small, { sha256: sha(Buffer.from('something else')) });
  const tH = r.data?.id;
  await sendChunks(SAd, A1, tH, small);
  x = await waitRow(tH, ended);
  check(x?.endReason === 'hash_mismatch' && !existsSync(disk('C:\\Temp\\lie.txt')), 'chunks that do not make up the declared SHA-256: hash_mismatch, and nothing is put in place', J({ e: x?.endReason }));

  // ── Download ──────────────────────────────────────────────────────────────
  section('Download: the agent reads and declares the SHA-256, the browser checks it');
  const down = randomBytes(CHUNK + 777);
  writeFileSync(disk('C:\\Temp\\down.bin'), down);
  r = await download(SAd, A1, 'C:\\Temp\\down.bin');
  check(ok(r) && r.data.direction === 'from_computer' && r.data.size === null, 'a download is accepted, its size not yet known', msg(r));
  const tD = r.data?.id;
  r = await req('GET', `${F(A1)}/${tD}/chunks/1`, { s: SAd2 });
  check(r.status === 404, "another Platform Admin cannot read this technician's chunks (404)", msg(r));
  const got = await fetchChunks(SAd, A1, tD);
  check(got.v?.state === 'completed' && got.bad === 0, 'every chunk arrived with its own SHA-256', J({ s: got.v?.state, e: got.v?.endReason, bad: got.bad }));
  check(got.buf.equals(down) && got.v?.sha256 === sha(down) && got.v?.size === down.length, "the bytes and the agent's SHA-256 match the file on the computer", `${got.v?.sha256} vs ${sha(down)}`);
  r = await req('POST', `${F(A1)}/${tD}/received`, { s: SAd, body: { sha256: sha(got.buf) } });
  check(ok(r) && r.data.verified === true, 'the browser says received: verified', msg(r));
  check((await chunksLeft(tD)) === 0, 'and the server holds no chunk after that');
  for (const [p, want] of [['C:\\Temp\\missing.bin', 'not_found'], ['C:\\Temp', 'not_a_file']]) {
    r = await download(SAd, A1, p);
    const tid = r.data?.id;
    x = tid ? await waitRow(tid, ended) : null;
    check(x?.state === 'failed' && x.endReason === want, `${p}: ${want}`, J({ r: msg(r), e: x?.endReason }));
  }

  // ── The agent channel ─────────────────────────────────────────────────────
  section('The agent channel needs the device secret');
  r = await download(SAd, A5, 'C:\\Temp\\down.bin');
  const tA5 = r.data?.id;
  r = await req('POST', '/remote/agent/files/begin', { body: { rustdeskId: A5.rid, agentSecret: 'f'.repeat(48), id: tA5, size: 1, sha256: 'a'.repeat(64) } });
  check(r.status === 401, 'a wrong device secret: 401', msg(r));
  r = await req('POST', '/remote/agent/files/begin', { body: { rustdeskId: A1.rid, agentSecret: A1.secret, id: tA5, size: 1, sha256: 'a'.repeat(64) } });
  check(r.status === 404, "another computer's secret cannot reach this transfer (404)", msg(r));
  r = await req('POST', '/remote/agent/files/pull', { body: { rustdeskId: A5.rid, agentSecret: A5.secret, id: tA5, seq: 1, extra: true } });
  check(r.status === 400, 'an unknown field: 400', msg(r));

  // ── Cancel and revoke ────────────────────────────────────────────────────
  section('Cancelling: the technician, a Platform Admin, or the business\'s own member with Edit computers');
  r = await cancel(SOB, A5, tA5);
  check(r.status === 404, "business B's owner: 404", msg(r));
  r = await cancel(SOA, A5, tA5);
  check(ok(r) && r.data.cancelled === true && r.data.transfer.endReason === 'revoked', "business A's owner revokes the admin's transfer", msg(r));
  r = await upload(SAd, A5, 'C:\\Temp\\c.txt', small);
  const tC = r.data?.id;
  r = await cancel(SAd, A5, tC);
  check(ok(r) && r.data.transfer.endReason === 'cancelled', 'the technician cancels their own (cancelled)', msg(r));
  r = await req('POST', `${F(A5)}/${tC}/chunks`, { s: SAd, body: { seq: 1, data: small.toString('base64'), sha256: sha(small) } });
  check(r.status === 409 && code(r) === 'FILES_ENDED', 'a chunk after cancelling: 409 FILES_ENDED', msg(r));
  r = await upload(SAd, A5, 'C:\\Temp\\d.txt', small);
  r = await cancel(SAd2, A5, r.data?.id);
  check(ok(r) && r.data.transfer.endReason === 'revoked', 'another Platform Admin revokes', msg(r));

  section('Two live transfers per computer');
  const l1 = await upload(SAd, A5, 'C:\\Temp\\l1.txt', small);
  const l2 = await upload(SAd, A5, 'C:\\Temp\\l2.txt', small);
  r = await upload(SAd, A5, 'C:\\Temp\\l3.txt', small);
  check(ok(l1) && ok(l2) && r.status === 409 && code(r) === 'FILES_TOO_MANY', 'a third: 409 FILES_TOO_MANY', msg(r));

  // ── Clocks ────────────────────────────────────────────────────────────────
  section('Clocks: 10 minutes without progress, and the 60-minute limit');
  await prisma.fileTransfer.update({ where: { id: l1.data.id }, data: { lastProgressAt: new Date(Date.now() - 11 * 60_000) } });
  r = await get(SAd, A5, l1.data.id);
  check(r.data?.state === 'failed' && r.data.endReason === 'stalled', 'nothing moved for 11 minutes: stalled, on the next read', msg(r));
  await prisma.fileTransfer.update({ where: { id: l2.data.id }, data: { createdAt: new Date(Date.now() - 59 * 60_000), lastProgressAt: new Date(Date.now() - 60_000), notAfter: new Date(Date.now() - 1000) } });
  x = await waitRow(l2.data.id, ended, 10_000);
  check(x?.endReason === 'expired', 'past its limit: expired, by the sweep with nobody reading', J({ e: x?.endReason }));
  const exp = await prisma.activityLog.findMany({ where: { action: 'FILE_TRANSFER_FAILED', resourceId: { in: [l1.data.id, l2.data.id] } } });
  check(exp.length === 2, 'both audited as FILE_TRANSFER_FAILED', String(exp.length));

  // ── Containment ──────────────────────────────────────────────────────────
  section('A remote pause ends a live transfer and refuses new ones');
  const mid = randomBytes(3 * CHUNK);
  r = await upload(SAd, A1, 'C:\\Temp\\paused.bin', mid);
  const tP = r.data?.id;
  // Only the first chunk: the agent waits for the second.
  await req('POST', `${F(A1)}/${tP}/chunks`, { s: SAd, body: { seq: 1, data: mid.subarray(0, CHUNK).toString('base64'), sha256: sha(mid.subarray(0, CHUNK)) } });
  await waitRow(tP, (y) => y.state === 'transferring');
  const pause = await prisma.containmentPause.create({ data: { scope: 'BUSINESS', customerId: bizA.id, kinds: ['remote'], reason: 'e2e files', setById: admin.id, setBy: 'msp' } });
  created.pauses.push(pause.id);
  x = await waitRow(tP, ended, 10_000);
  check(x?.endReason === 'paused', 'the live transfer ends: paused', J({ e: x?.endReason }));
  await sleep(1500);
  check(!existsSync(disk('C:\\Temp\\paused.bin')) && !readdirSync(path.join(ROOT, 'C', 'Temp')).some((n) => n.endsWith('.part')), 'nothing is left on the computer, not even the partial file');
  r = await upload(SAd, A1, 'C:\\Temp\\after.txt', small);
  check(r.status === 403 && code(r) === 'CONTAINED', 'a new transfer under the pause: 403 CONTAINED', msg(r));
  await prisma.containmentPause.deleteMany({ where: { id: pause.id } });
  await stopSim(sim);

  // ── Audit ────────────────────────────────────────────────────────────────
  section('Audit rows: ids, direction, path, size and SHA-256 — never content');
  const rows = await prisma.activityLog.findMany({ where: { action: { in: ['FILE_TRANSFER_REQUESTED', 'FILE_TRANSFER_COMPLETED', 'FILE_TRANSFER_FAILED', 'FILE_TRANSFER_CANCELLED'] }, customerId: { in: created.businesses } } });
  const done = rows.find((a) => a.action === 'FILE_TRANSFER_COMPLETED' && a.resourceId === tU);
  check(done?.metadata?.sha256 === sha(up) && done?.metadata?.size === up.length && done?.metadata?.direction === 'to_computer' && done?.metadata?.path === 'C:\\Temp\\up.bin', 'the completed upload is audited with its SHA-256, size, direction and path', J(done?.metadata));
  const dl = rows.find((a) => a.action === 'FILE_TRANSFER_COMPLETED' && a.resourceId === tD);
  check(dl?.metadata?.sha256 === sha(down), "the completed download is audited with the agent's SHA-256", J(dl?.metadata));
  const reqRow = rows.find((a) => a.action === 'FILE_TRANSFER_REQUESTED' && a.resourceId === tU);
  check(reqRow?.metadata?.reason === 'e2e: vendor driver' && reqRow?.metadata?.identity === 'SYSTEM' && reqRow?.actorId === admin.id, 'the request is audited with its reason, technician and SYSTEM', J(reqRow?.metadata));
  const blob = J(rows);
  check(rows.length >= 20 && !blob.includes(MARKER) && !blob.includes(up.subarray(0, 64).toString('base64')), `${rows.length} file audit rows: none holds content`, blob.slice(0, 200));
  const simLogs = sims.map((p) => { try { return readFileSync(p.logPath, 'utf8'); } catch { return ''; } }).join('\n');
  check(simLogs.length > 0 && !simLogs.includes(MARKER) && !simLogs.includes(A1.secret) && !simLogs.includes('Temp'), 'the worker logged no content, path or secret', simLogs.slice(0, 300));
  check(!api.log.includes(MARKER), 'the API logged no content');
  check((await prisma.fileTransferChunk.count({ where: { transfer: { endpointId: { in: created.endpoints } } } })) === 0, 'no chunk of any of these transfers is left');

  section('Restoring files.transfer to off');
  r = await req('PUT', '/security/confirm-policy', { s: SAd, body: { values: { 'files.transfer': 'off' } } });
  check(ok(r), 'relaxing it back to off (with a fresh confirmation)', msg(r));
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
  await prisma.fileTransfer.deleteMany({ where: { endpointId: { in: ids } } }).catch(() => {});
  await prisma.remoteOpsSetting.deleteMany({ where: { businessId: { in: created.businesses } } }).catch(() => {});
  await prisma.containmentPause.deleteMany({ where: { id: { in: created.pauses } } }).catch(() => {});
  await prisma.confirmPolicy.deleteMany({ where: { key: 'files.transfer' } }).catch(() => {});
  if (savedConfirm) await prisma.confirmPolicy.create({ data: { key: 'files.transfer', value: savedConfirm.value } }).catch(() => {});
  await prisma.endpoint.updateMany({ where: { id: { in: ids } }, data: { status: 'ARCHIVED', isOnline: false, lastSeenAt: new Date(Date.now() - 24 * 3600_000) } }).catch(() => {});
  await prisma.$disconnect();
}
console.log(`\nfiles: ${pass} passed, ${fail} failed`);
if (fail) { for (const f of failures) console.error(`  ✗ ${f}`); process.exit(1); }
