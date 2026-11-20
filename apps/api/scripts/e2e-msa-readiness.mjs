#!/usr/bin/env node
/**
 * End-to-end proof of Managed Secure Access readiness (0.69,
 * check-security-invariants §80), through the real heartbeat route and the
 * read-only readiness routes:
 *
 *   - an authenticated signed heartbeat that may act stores the agent's
 *     RustDesk preflight and is answered rustdeskPreflightAck; a newer report
 *     replaces it, an older or repeated one does not;
 *   - a standard heartbeat, an unauthenticated one, the signed install
 *     script's own check-in (no channel, no live state), a leftover standard
 *     heartbeat on a signed computer and a pooled (unassigned) computer store
 *     nothing and are acknowledged nothing;
 *   - a malformed block — a string, an array, an unknown field (a path), an
 *     unknown key, a bad version, a future date, cli disagreeing with the
 *     keys — is ignored, and the heartbeat still succeeds with its ordinary
 *     answer;
 *   - an old signed agent that sends no block gets the same answer as before
 *     (no rustdeskPreflightAck key at all) and reads "Upgrade available";
 *   - GET /msa/readiness counts and lists only the computers the caller can
 *     see (another business's, and a Business User's ungranted computer, are
 *     absent), filters by state, and needs computers:view; the per-computer
 *     route is a 404 outside the caller's view;
 *   - no answer is ever managed, managed_verified or enforcement_failure, and
 *     none is "verified";
 *   - the database refuses a not_run row that claims answered reads.
 *
 *   cd apps/api && npx nest build
 *   DATABASE_URL=postgresql://…/<name containing scratch or test> node scripts/e2e-msa-readiness.mjs
 *
 * Self-starting: its API runs from dist/ on MSA_API_PORT (3941). INTEGRATION,
 * not Windows: heartbeats are posted the way heartbeat.ps1 posts them. The
 * preflight itself ran only in the Windows lab (TestLabRustdeskPreflight).
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const DB = process.env.DATABASE_URL ?? '';
const dbName = DB.split('/').pop()?.split('?')[0] ?? '';
if (!/scratch|test/.test(dbName)) { console.error(`Refusing to run against database "${dbName}": name must contain "scratch" or "test".`); process.exit(2); }
const PORT = Number(process.env.MSA_API_PORT ?? 3941);
if ([3000, 3001, 3201, 3202, 4000, 4001, 443].includes(PORT)) { console.error(`Refusing port ${PORT}`); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'msa-readiness-e2e-password-123';
const VERSION_FILE = path.resolve(here, '..', '..', '..', 'version.json');

let pass = 0, fail = 0;
const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;
const sha = (b) => createHash('sha256').update(b).digest('hex');

const env = {
  ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATABASE_URL: DB,
  JWT_SECRET: randomBytes(32).toString('hex'), LAUNCHER_TOKEN_SECRET: randomBytes(32).toString('hex'),
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? randomBytes(32).toString('hex'), TRUSTED_PROXIES: 'loopback', HBBS_PRESENCE_HOST: '127.0.0.2',
  VERSION_FILE, MONITOR_SWEEP: 'off', AUDIT_SEALER: 'off', CLIENT_UPDATE_SWEEP: 'off', SNAPSHOT_SWEEP: 'off', PATCH_POLICY_SWEEP: 'off', METRIC_SWEEP: 'off',
  AUTO_MIGRATION_SWEEP: 'off', TRAY_SWEEP: 'off', RETENTION_SWEEP: 'off', CHAT_RETENTION_SWEEP: 'off', STALE_SWEEP: 'off', AGENT_AUTO_UPDATE: 'off',
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

async function req(method, p, { s, body } = {}) {
  await sleep(40);
  const h = { 'content-type': 'application/json', 'x-forwarded-for': ip() };
  if (s) h.cookie = s.cookie;
  const r = await fetch(`${API}${p}`, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
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
const ok = (r) => r.status === 200 || r.status === 201;

// ── What the signed agent writes (tools/windows-installer/internal/msa) ──────
const KEYS = ['access-mode', 'enable-keyboard', 'enable-clipboard', 'enable-file-transfer', 'enable-audio', 'enable-tunnel', 'enable-remote-restart',
  'approve-mode', 'verification-method', 'allow-auto-disconnect', 'auto-disconnect-timeout'];
const at = (msAgo) => new Date(Date.now() - msAgo).toISOString().replace(/\.\d{3}Z$/, 'Z');
const block = (over = {}) => ({
  schema: 'rem0te-rustdesk-preflight/1', checkedAt: at(120_000), installed: true, expectedPath: true, version: '1.4.7+65', build: 'flutter',
  service: 'running', cli: 'ok', keys: Object.fromEntries(KEYS.map((k) => [k, 'ok'])), durationMs: 1400, ...over,
});
const live = { loggedOnUser: 'PC\\user', uptimeSeconds: 7200, cpuLoadPercent: 4, memoryTotalMb: 16000, memoryFreeMb: 9000, rustdeskSessions: 0 };
const signedBeat = (ep, extra = {}) => req('POST', '/enrollment/heartbeat', { body: {
  rustdeskId: ep.rid, agentSecret: ep.secret, hostname: ep.hostname, platform: 'Windows', agentVersion: '0.69.0', rustdeskVersion: '1.4.7',
  updateChannel: 'signed', trustRootVersion: 1, targetsVersion: 7, agentSha256: 'c'.repeat(64), agentActions: ['windows.spooler.start@1'], ...live, ...extra } });
const standardBeat = (ep, extra = {}) => req('POST', '/enrollment/heartbeat', { body: {
  rustdeskId: ep.rid, agentSecret: ep.secret, hostname: ep.hostname, platform: 'Windows', agentVersion: '0.68.3', rustdeskVersion: '1.4.7',
  updateChannel: 'legacy', ...live, ...extra } });
const row = (ep) => prisma.rustdeskPreflight.findUnique({ where: { endpointId: ep.id } });

const created = { businesses: [], users: [] };

async function all() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });
  const roleUser = await prisma.role.findFirst({ where: { type: 'BUSINESS_USER' } });

  section('Fixtures (synthetic): business A (owner, a Business User granted one computer, a Business User without View computers), business B (owner)');
  const bizA = await prisma.customer.create({ data: { tenantId: tenant.id, name: `MSA A ${sfx}` } });
  const bizB = await prisma.customer.create({ data: { tenantId: tenant.id, name: `MSA B ${sfx}` } });
  created.businesses.push(bizA.id, bizB.id);
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag, biz, role, capabilities = []) => {
    const u = await prisma.user.create({ data: { email: `msa-${tag}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'Msa', lastName: tag, status: 'ACTIVE' } });
    created.users.push(u.id);
    await prisma.membership.create({ data: { userId: u.id, tenantId: tenant.id, customerId: biz.id, roleId: role.id, capabilities } });
    return u;
  };
  const ownerA = await mkUser('owner-a', bizA, roleOwner);
  const userA = await mkUser('user-a', bizA, roleUser, ['computers:view']);
  const noView = await mkUser('noview-a', bizA, roleUser, []);
  const ownerB = await mkUser('owner-b', bizB, roleOwner);
  const mkEp = async (hostname, biz, { channel = 'signed', signedSeenAt = new Date(), pooled = false, agentVersion = '0.69.0' } = {}) => {
    const e = await prisma.endpoint.create({ data: {
      tenantId: pooled ? null : tenant.id, customerId: pooled ? null : biz.id, name: hostname, hostname, platform: 'Windows', status: pooled ? 'PENDING_ENROLLMENT' : 'ACTIVE',
      isOnline: true, isManaged: true, accessMode: 'ASSIGNED_USERS', lastSeenAt: new Date(), agentVersion, updateChannel: channel,
      signedSeenAt: channel === 'signed' ? signedSeenAt : null, deviceClass: 'WORKSTATION' } });
    const rid = String(100000000 + ((Math.random() * 899999999) | 0));
    const secret = randomBytes(24).toString('hex');
    await prisma.rustdeskNode.create({ data: { tenantId: pooled ? null : tenant.id, endpointId: e.id, rustdeskId: rid, version: '1.4.7', agentSecretHash: sha(secret) } });
    return { id: e.id, rid, secret, hostname };
  };
  const A1 = await mkEp(`MSA-A1-${sfx}`, bizA);
  const A2 = await mkEp(`MSA-A2-STD-${sfx}`, bizA, { channel: 'legacy', agentVersion: '0.68.3' });
  const A3 = await mkEp(`MSA-A3-OLD-${sfx}`, bizA, { agentVersion: '0.68.3' });
  const A4 = await mkEp(`MSA-A4-BAD-${sfx}`, bizA);
  const B1 = await mkEp(`MSA-B1-${sfx}`, bizB);
  const P1 = await mkEp(`MSA-POOL-${sfx}`, null, { pooled: true });
  await prisma.computerAccess.create({ data: { tenantId: tenant.id, endpointId: A1.id, userId: userA.id } });
  await startApi();
  const SA = await login(ownerA.email);
  const SU = await login(userA.email);
  const SN = await login(noView.email);
  const SB = await login(ownerB.email);

  section('An authenticated signed heartbeat stores the preflight and is acknowledged');
  const b1 = block();
  let r = await signedBeat(A1, { rustdeskPreflight: b1 });
  check(ok(r) && r.data.authenticated === true && r.data.rustdeskPreflightAck === b1.checkedAt, 'A1: 200, rustdeskPreflightAck is the block\'s checkedAt', msg(r));
  let x = await row(A1);
  check(!!x && x.checkedAt.toISOString().replace(/\.\d{3}Z$/, 'Z') === b1.checkedAt && x.version === '1.4.7+65' && x.build === 'flutter' && x.service === 'running'
    && x.cli === 'ok' && x.keysOk === 11 && x.installed && x.expectedPath && x.agentVersion === '0.69.0' && Object.keys(x.keys).length === 11,
    'the row holds the facts, 11 of 11 reads, agent 0.69.0', JSON.stringify(x));
  check(!JSON.stringify(x).includes('Program Files') && !('path' in x), 'no path text is stored');
  r = await req('GET', `/msa/readiness/${A1.id}`, { s: SA });
  check(ok(r) && r.data.readiness.state === 'compatible' && r.data.readiness.verified === false && r.data.readiness.labTested === true
    && /not available yet; nothing has changed on this computer/.test(r.data.note), 'GET /msa/readiness/A1: compatible, lab-tested, not verified, with the readiness-only note', msg(r));

  section('A repeated or older report never replaces a newer one');
  r = await signedBeat(A1, { rustdeskPreflight: b1 });
  check(ok(r) && r.data.rustdeskPreflightAck === b1.checkedAt, 'the same report again: acknowledged again', msg(r));
  const older = block({ checkedAt: at(3600_000), version: '1.4.6+64' });
  r = await signedBeat(A1, { rustdeskPreflight: older });
  x = await row(A1);
  check(ok(r) && r.data.rustdeskPreflightAck === older.checkedAt && x.version === '1.4.7+65', 'an older report: acknowledged (so the agent stops sending it) but not stored', JSON.stringify({ ack: r.data?.rustdeskPreflightAck, v: x.version }));
  const newer = block({ checkedAt: at(10_000), cli: 'partial', keys: { ...b1.keys, 'enable-tunnel': 'timeout' } });
  r = await signedBeat(A1, { rustdeskPreflight: newer });
  x = await row(A1);
  check(ok(r) && x.cli === 'partial' && x.keysOk === 10 && x.keys['enable-tunnel'] === 'timeout', 'a newer report replaces it: 10 of 11', JSON.stringify(x));
  r = await req('GET', `/msa/readiness/${A1.id}`, { s: SA });
  check(ok(r) && r.data.readiness.state === 'unknown' && /10 of 11/.test(r.data.readiness.reasons[0]), 'and readiness follows: unknown, "10 of 11"', msg(r));
  await signedBeat(A1, { rustdeskPreflight: block({ checkedAt: at(5_000) }) });

  section('Nothing else may write it');
  r = await standardBeat(A2, { rustdeskPreflight: block() });
  check(ok(r) && r.data.rustdeskPreflightAck === undefined && !(await row(A2)), 'a standard heartbeat (A2): 200, no ack, nothing stored', msg(r));
  r = await req('POST', '/enrollment/heartbeat', { body: { rustdeskId: A4.rid, agentSecret: 'f'.repeat(48), hostname: A4.hostname, platform: 'Windows', updateChannel: 'signed', agentVersion: '0.69.0', ...live, rustdeskPreflight: block() } });
  check(r.data?.rustdeskPreflightAck === undefined && !(await row(A4)), `an unauthenticated heartbeat (wrong secret, HTTP ${r.status}): nothing stored, no ack`, msg(r));
  r = await req('POST', '/enrollment/heartbeat', { body: { rustdeskId: A4.rid, hostname: A4.hostname, platform: 'Windows', updateChannel: 'signed', agentVersion: '0.69.0', ...live, rustdeskPreflight: block() } });
  check(r.data?.rustdeskPreflightAck === undefined && !(await row(A4)), `no secret at all (HTTP ${r.status}): nothing stored`, msg(r));
  r = await req('POST', '/enrollment/heartbeat', { body: { rustdeskId: A4.rid, agentSecret: A4.secret, hostname: A4.hostname, platform: 'Windows', agentVersion: '0.69.0', rustdeskPreflight: block() } });
  check(ok(r) && r.data.rustdeskPreflightAck === undefined && !(await row(A4)), 'the signed install script\'s check-in (no channel, no live state): nothing stored', msg(r));
  r = await standardBeat(A4, { rustdeskPreflight: block() });
  check(ok(r) && r.data.retireStandard === true && r.data.rustdeskPreflightAck === undefined && !(await row(A4)), 'a leftover standard heartbeat on a signed computer: retireStandard, nothing stored', msg(r));
  r = await signedBeat(P1, { rustdeskPreflight: block() });
  check(ok(r) && r.data.rustdeskPreflightAck === undefined && !(await row(P1)), 'a pooled (unassigned) computer\'s signed heartbeat: nothing stored', msg(r));

  section('A malformed block is ignored and never fails the heartbeat');
  const bad = [
    ['a string', 'not a block'], ['an array', [block()]], ['a number', 42], ['null', null], ['true', true],
    ['an unknown field (a path)', { ...block(), path: 'C:\\Users\\alice\\AppData\\Local\\rustdesk\\rustdesk.exe' }],
    ['the settings\' values', { ...block(), values: { 'access-mode': 'full' } }],
    ['an unknown key', block({ keys: { ...block().keys, password: 'ok' } })],
    ['a bad version', block({ version: '1.4.7; rm -rf' })],
    ['a future checkedAt', block({ checkedAt: at(-3 * 3600_000) })],
    ['cli ok, a read timed out', block({ keys: { ...block().keys, 'access-mode': 'timeout' } })],
    ['a newer schema', block({ schema: 'rem0te-rustdesk-preflight/2' })],
    ['not run, but run', block({ cli: 'ok', installed: false })],
    ['deeply nested', { a: { b: { c: { d: { e: [1, 2, { f: 'x'.repeat(2000) }] } } } } }],
  ];
  const baseline = await signedBeat(A4);
  for (const [name, b] of bad) {
    r = await signedBeat(A4, { rustdeskPreflight: b });
    const sameShape = ok(r) && JSON.stringify(Object.keys(r.data ?? {}).sort()) === JSON.stringify(Object.keys(baseline.data ?? {}).sort());
    check(sameShape && r.data.rustdeskPreflightAck === undefined && !(await row(A4)), `${name}: 200, the ordinary answer, no ack, nothing stored`, msg(r));
  }
  r = await req('GET', `/msa/readiness/${A4.id}`, { s: SA });
  check(ok(r) && r.data.readiness.state === 'unknown' && /No readiness report yet/.test(r.data.readiness.reasons[0]) && r.data.preflight === null, 'A4: unknown, no report yet', msg(r));

  section('An older signed agent sends nothing and is unaffected');
  const before = await signedBeat(A3, { agentVersion: '0.68.3' });
  check(ok(before) && before.data.authenticated === true && !('rustdeskPreflightAck' in before.data) && 'patchPostureAck' in before.data && 'rustdeskRegistered' in before.data,
    'A3 (signed 0.68.3, no block): 200, the 0.68 answer — no rustdeskPreflightAck key at all', msg(before));
  check(!(await row(A3)), 'nothing stored');
  r = await req('GET', `/msa/readiness/${A3.id}`, { s: SA });
  check(ok(r) && r.data.readiness.state === 'upgrade_available' && /too old/.test(r.data.readiness.reasons[0]), 'readiness: Upgrade available (the agent is too old to check)', msg(r));
  r = await req('GET', `/msa/readiness/${A2.id}`, { s: SA });
  check(ok(r) && r.data.readiness.state === 'unsupported' && /standard agent/.test(r.data.readiness.reasons[0]), 'A2 (standard agent): Unsupported', msg(r));

  section('The fleet view: visibility, the filter and the capability');
  r = await req('GET', '/msa/readiness', { s: SA });
  const ids = (r.data?.computers ?? []).map((c) => c.id);
  check(ok(r) && [A1, A2, A3, A4].every((e) => ids.includes(e.id)) && !ids.includes(B1.id) && !ids.includes(P1.id), 'owner A: A1–A4, not B1, not the pooled computer', msg(r));
  const sum = Object.values(r.data?.counts ?? {}).reduce((a, b) => a + b, 0);
  check(sum === r.data?.total && r.data.total === ids.length && r.data.counts.compatible >= 1 && r.data.counts.unsupported >= 1 && r.data.counts.upgrade_available >= 1, 'counts add up to the list', JSON.stringify(r.data?.counts));
  check(JSON.stringify(r.data?.states?.map((s) => s.state)) === JSON.stringify(['unsupported', 'upgrade_available', 'compatible', 'unknown'])
      && r.data?.managedControls === false && Object.keys(r.data?.counts ?? {}).length === 7,
    'MSA_GRANTS off: the four readiness tiles only (nothing can be Managed), managedControls false; counts still name all seven', JSON.stringify(r.data?.states));
  check((r.data?.computers ?? []).every((c) => !['managed', 'managed_verified', 'enforcement_failure'].includes(c.state)), 'no computer is managed');
  check(/not available yet; nothing has changed on any computer|not available yet; nothing has changed on this computer/.test(r.data?.note ?? ''), 'the note is there', r.data?.note);
  r = await req('GET', '/msa/readiness?state=compatible', { s: SA });
  check(ok(r) && r.data.computers.length >= 1 && r.data.computers.every((c) => c.state === 'compatible') && r.data.computers.some((c) => c.id === A1.id), '?state=compatible lists only compatible ones', msg(r));
  r = await req('GET', '/msa/readiness?state=managed', { s: SA });
  check(ok(r) && r.data.computers.length === 0, '?state=managed is a filter (0.72) and lists none: nothing was cut over', msg(r));
  r = await req('GET', '/msa/readiness?state=bogus', { s: SA });
  check(ok(r) && r.data.computers.length === r.data.total, '?state=bogus is not a filter (ignored), never an error', msg(r));
  r = await req('GET', '/msa/readiness', { s: SU });
  const uids = (r.data?.computers ?? []).map((c) => c.id);
  check(ok(r) && uids.includes(A1.id) && !uids.includes(A2.id) && !uids.includes(A3.id) && !uids.includes(B1.id), 'a Business User granted A1: only A1', JSON.stringify(uids));
  r = await req('GET', `/msa/readiness/${A2.id}`, { s: SU });
  check(r.status === 404, 'and A2 by id is a 404', msg(r));
  r = await req('GET', `/msa/readiness/${A1.id}`, { s: SU });
  check(ok(r) && r.data.readiness.state === 'compatible', 'A1 by id is readable', msg(r));
  r = await req('GET', '/msa/readiness', { s: SN });
  check(r.status === 403, 'a Business User without View computers: 403', msg(r));
  r = await req('GET', `/msa/readiness/${A1.id}`, { s: SN });
  check(r.status === 403, 'and 403 by id', msg(r));
  r = await req('GET', '/msa/readiness', { s: SB });
  const bids = (r.data?.computers ?? []).map((c) => c.id);
  check(ok(r) && !bids.includes(A1.id) && !bids.includes(A4.id), 'owner B: none of business A\'s computers', JSON.stringify(bids));
  r = await req('GET', `/msa/readiness/${A1.id}`, { s: SB });
  check(r.status === 404, 'owner B: A1 by id is a 404', msg(r));
  r = await req('GET', `/msa/readiness?businessId=${bizA.id}`, { s: SB });
  check(r.status === 403 || r.status === 404 || (ok(r) && !(r.data?.computers ?? []).some((c) => c.id === A1.id)), 'owner B naming business A: refused or empty', msg(r));
  r = await req('GET', '/msa/readiness');
  check(r.status === 401, 'no session: 401', msg(r));

  section('The database holds the rules too');
  let refused = false;
  try {
    await prisma.rustdeskPreflight.create({ data: { endpointId: A2.id, checkedAt: new Date(), schema: 'rem0te-rustdesk-preflight/1', installed: false, expectedPath: false, version: null, build: 'flutter', service: 'missing', cli: 'not_run', keys: {}, keysOk: 3, durationMs: 0 } });
  } catch { refused = true; }
  check(refused, 'a not_run row claiming answered reads is refused (CHECK)');
  refused = false;
  try {
    await prisma.rustdeskPreflight.create({ data: { endpointId: A2.id, checkedAt: new Date(), schema: 'rem0te-rustdesk-preflight/1', installed: true, expectedPath: true, version: '1.4.7', build: 'qt', service: 'running', cli: 'ok', keys: {}, keysOk: 11, durationMs: 0 } });
  } catch { refused = true; }
  check(refused, 'an unknown build is refused (CHECK)');
}

try {
  await all();
} catch (err) {
  fail++; failures.push(String(err?.stack ?? err));
  console.error(err);
  if (api?.log) console.error(api.log.slice(-2000));
} finally {
  await stopApi();
  const eps = await prisma.endpoint.findMany({ where: { OR: [{ customerId: { in: created.businesses } }, { hostname: { endsWith: sfx } }] }, select: { id: true } });
  const ids = eps.map((x) => x.id);
  await prisma.rustdeskPreflight.deleteMany({ where: { endpointId: { in: ids } } }).catch(() => {});
  // Suites that sweep every computer must not find these online.
  await prisma.endpoint.updateMany({ where: { id: { in: ids } }, data: { status: 'ARCHIVED', isOnline: false, lastSeenAt: new Date(Date.now() - 24 * 3600_000) } }).catch(() => {});
  await prisma.$disconnect();
}
console.log(`\nmsa readiness: ${pass} passed, ${fail} failed`);
if (fail) { for (const f of failures) console.error(`  ✗ ${f}`); process.exit(1); }
