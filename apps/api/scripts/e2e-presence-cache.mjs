#!/usr/bin/env node
/**
 * End-to-end proof of the shared hbbs peer snapshot (0.34): the heartbeat's
 * `rustdeskRegistered` comes from one sqlite3 read per window instead of one
 * per heartbeat, and means exactly what it meant before.
 *
 *   - registered → true, never registered → false, through real heartbeats;
 *   - bounded: 60 heartbeats over ~6 s start at most one sqlite3 per window
 *     (a counting wrapper on the API's PATH counts them) — before 0.34 this
 *     was 60;
 *   - staleness is bounded by the window: an ID added to the peer table turns
 *     true, and an ID deleted from it turns false, within the window plus
 *     slack, and a deleted ID never answers true after that;
 *   - fail-safe: with the peer database unreadable every answer is null
 *     (unknown) — including for an ID the previous snapshot had as
 *     registered — and it recovers when the file returns;
 *   - business A/B isolation: the answer goes only to a caller holding the
 *     computer's device secret. Business B's secret with Business A's
 *     RustDesk ID (and the reverse), or no secret, is refused with 401 and
 *     no `rustdeskRegistered` at all.
 *
 * Self-starting: it runs its own API from dist/ on PRESENCE_API_PORT (3403)
 * against DATABASE_URL, which must name a scratch/test database, with a
 * scratch hbbs peer database (RUSTDESK_DB_PATH) — never the real one — and
 * HBBS_PEER_CACHE_SECONDS=2. Needs sqlite3. Fixtures are namespaced and
 * removed at the end.
 *
 * Run:  DATABASE_URL=…/rem0te_presence_test node scripts/e2e-presence-cache.mjs
 */
import { PrismaClient } from '@prisma/client';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const DB = process.env.DATABASE_URL ?? '';
const dbName = DB.split('/').pop()?.split('?')[0] ?? '';
if (!/scratch|test/.test(dbName)) { console.error(`Refusing to run against database "${dbName}": name must contain "scratch" or "test".`); process.exit(2); }
const PORT = Number(process.env.PRESENCE_API_PORT ?? 3403);
if ([3000, 3001, 443, 4000, 4001].includes(PORT)) { console.error(`Refusing port ${PORT}: production or the shared docs stack.`); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
const WINDOW_S = 2;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const TAG = `PC${sfx}`;

let pass = 0, fail = 0;
const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;

let realSqlite;
try { realSqlite = execFileSync('sh', ['-c', 'command -v sqlite3']).toString().trim(); } catch { /* below */ }
if (!realSqlite) { console.error('sqlite3 is required (the presence lookup runs it).'); process.exit(2); }

const work = mkdtempSync(path.join(tmpdir(), 'rem0te-presence-'));
const hbbsDb = path.join(work, 'db_v2.sqlite3');
const counter = path.join(work, 'sqlite3-calls');
const bin = path.join(work, 'bin');
execFileSync('mkdir', ['-p', bin]);
// Counts every sqlite3 the API starts, then runs the real one.
writeFileSync(path.join(bin, 'sqlite3'), `#!/bin/sh\necho x >> '${counter}'\nexec '${realSqlite}' "$@"\n`);
chmodSync(path.join(bin, 'sqlite3'), 0o755);
const calls = () => (existsSync(counter) ? readFileSync(counter, 'utf8').split('\n').filter(Boolean).length : 0);
const sql = (q) => execFileSync(realSqlite, [hbbsDb, q]);

const apiEnv = {
  ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATABASE_URL: DB,
  PATH: `${bin}:${process.env.PATH}`,
  JWT_SECRET: randomBytes(32).toString('hex'), LAUNCHER_TOKEN_SECRET: randomBytes(32).toString('hex'),
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? randomBytes(32).toString('hex'), TRUSTED_PROXIES: 'loopback',
  HBBS_PRESENCE_HOST: '127.0.0.2', RUSTDESK_DB_PATH: hbbsDb, HBBS_PEER_CACHE_SECONDS: String(WINDOW_S),
  MONITOR_SWEEP: 'off', AUDIT_SEALER: 'off', CLIENT_UPDATE_SWEEP: 'off', PATCH_POLICY_SWEEP: 'off', METRIC_SWEEP: 'off',
  VERSION_FILE: path.resolve(here, '..', '..', '..', 'version.json'),
};
let api;
function startApi() {
  api = spawn(process.execPath, [path.join(dist, 'main.js')], { env: apiEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  api.log = ''; api.stdout.on('data', (d) => { api.log = (api.log + d).slice(-20000); }); api.stderr.on('data', (d) => { api.log = (api.log + d).slice(-20000); });
}
async function stopApi() { if (!api || api.exitCode !== null) return; await new Promise((r) => { api.once('exit', r); api.kill('SIGTERM'); }); }
async function waitUp() {
  for (let i = 0; i < 150; i++) { try { const r = await fetch(`${API}/health`); if (r.status < 500) return; } catch { /* not yet */ } await sleep(300); }
  throw new Error(`api did not come up:\n${api.log.slice(-3000)}`);
}

async function heartbeat(rustdeskId, agentSecret) {
  const body = { rustdeskId, hostname: `${TAG}-host`, platform: 'Windows' };
  if (agentSecret) body.agentSecret = agentSecret;
  const r = await fetch(`${API}/enrollment/heartbeat`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip() }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => null);
  return { status: r.status, data: j?.data ?? null };
}
/** Poll A's answer until it equals `want`; returns seconds taken, or null. */
async function until(dev, want, limitS) {
  const t0 = Date.now();
  while ((Date.now() - t0) / 1000 < limitS) {
    const r = await heartbeat(dev.rid, dev.secret);
    if (r.data?.rustdeskRegistered === want) return (Date.now() - t0) / 1000;
    await sleep(150);
  }
  return null;
}

const businesses = [];
async function makeDevice(tenantId, customerId, n) {
  const d = { rid: String(810_000_000 + Math.floor(Math.random() * 89_999_999)), secret: randomBytes(24).toString('base64url') };
  const ep = await prisma.endpoint.create({ data: { tenantId, customerId, name: `${TAG}-${n}`, hostname: `${TAG}-${n}`, platform: 'windows', status: 'ACTIVE', isManaged: true, enrollment: { create: { status: 'ACTIVE' } } } });
  await prisma.rustdeskNode.create({ data: { tenantId, endpointId: ep.id, rustdeskId: d.rid, platform: 'Windows', agentSecretHash: createHash('sha256').update(d.secret).digest('hex'), agentSecretSetAt: new Date() } });
  return d;
}

async function main() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  if (await fetch(`${API}/health`).then(() => true, () => false)) throw new Error(`port ${PORT} is already in use; set PRESENCE_API_PORT`);
  const bizA = await prisma.customer.create({ data: { tenantId: tenant.id, name: `${TAG} Business A` } });
  const bizB = await prisma.customer.create({ data: { tenantId: tenant.id, name: `${TAG} Business B` } });
  businesses.push(bizA.id, bizB.id);
  const A = await makeDevice(tenant.id, bizA.id, 'a');
  const B = await makeDevice(tenant.id, bizB.id, 'b');
  if (A.rid === B.rid) B.rid = String(Number(B.rid) + 1);
  sql(`CREATE TABLE peer(id TEXT PRIMARY KEY, info TEXT); INSERT INTO peer VALUES('${A.rid}', '{}');`);

  startApi();
  await waitUp();

  section('Answers through real heartbeats');
  const a1 = await heartbeat(A.rid, A.secret);
  check(a1.status === 200 && a1.data?.authenticated === true, 'Business A computer heartbeats authenticated', JSON.stringify(a1).slice(0, 200));
  check(a1.data?.rustdeskRegistered === true, 'a peer in the hbbs table answers rustdeskRegistered: true', String(a1.data?.rustdeskRegistered));
  const b1 = await heartbeat(B.rid, B.secret);
  check(b1.data?.rustdeskRegistered === false, 'a computer hbbs has never seen answers false', String(b1.data?.rustdeskRegistered));

  section('Business A/B isolation: the answer needs the computer\'s own device secret');
  // A computer with a bound secret refuses a heartbeat without it (401), so
  // the response carries nothing at all — let alone the registration answer.
  const refused = (r) => r.status === 401 && !JSON.stringify(r.data ?? {}).includes('rustdeskRegistered');
  const cross = await heartbeat(A.rid, B.secret);
  check(refused(cross), "Business B's device secret with Business A's RustDesk ID is refused, with no rustdeskRegistered", `${cross.status} ${JSON.stringify(cross.data)}`);
  const none = await heartbeat(A.rid, undefined);
  check(refused(none), 'no device secret is refused, with no rustdeskRegistered', `${none.status} ${JSON.stringify(none.data)}`);
  const crossB = await heartbeat(B.rid, A.secret);
  check(refused(crossB), "Business A's device secret with Business B's RustDesk ID is refused, with no rustdeskRegistered", `${crossB.status} ${JSON.stringify(crossB.data)}`);

  section('Bounded: one sqlite3 per window, not per heartbeat');
  await sleep(WINDOW_S * 1000 + 200);
  const c0 = calls();
  const t0 = Date.now();
  let wrong = 0;
  for (let i = 0; i < 60; i++) {
    const d = i % 2 ? A : B;
    const r = await heartbeat(d.rid, d.secret);
    if (r.data?.rustdeskRegistered !== (d === A)) wrong++;
    await sleep(100); // ~10/s, under the 20/s burst throttler
  }
  const spanS = (Date.now() - t0) / 1000;
  const spawned = calls() - c0;
  const bound = Math.ceil(spanS / WINDOW_S) + 1;
  check(wrong === 0, '60 heartbeats all answered correctly from the snapshot', `${wrong} wrong`);
  check(spawned >= 1 && spawned <= bound, `60 heartbeats over ${spanS.toFixed(1)} s started ${spawned} sqlite3 (at most ${bound}; was 60 before 0.34)`, `spawned=${spawned}`);

  section('Staleness is bounded by the window');
  sql(`INSERT INTO peer VALUES('${B.rid}', '{}');`);
  const tReg = await until(B, true, WINDOW_S + 3);
  check(tReg !== null && tReg <= WINDOW_S + 1.5, `a newly registered peer answers true within the window (${tReg?.toFixed(2)} s)`, String(tReg));
  sql(`DELETE FROM peer WHERE id='${A.rid}';`);
  const tDel = await until(A, false, WINDOW_S + 3);
  check(tDel !== null && tDel <= WINDOW_S + 1.5, `a peer deleted from hbbs stops answering true within the window (${tDel?.toFixed(2)} s)`, String(tDel));
  let backToTrue = 0;
  for (let i = 0; i < 12; i++) { const r = await heartbeat(A.rid, A.secret); if (r.data?.rustdeskRegistered !== false) backToTrue++; await sleep(250); }
  check(backToTrue === 0, 'the deleted peer never answers true again over the next 3 s (more than one window)', `${backToTrue} non-false answers`);

  section('Fail-safe: an unreadable peer database answers null, never an older snapshot');
  const before = (await heartbeat(B.rid, B.secret)).data?.rustdeskRegistered;
  check(before === true, 'B is registered just before the database goes away', String(before));
  renameSync(hbbsDb, `${hbbsDb}.away`);
  const tNull = await until(B, null, WINDOW_S + 3);
  check(tNull !== null && tNull <= WINDOW_S + 1.5, `with the database gone a registered peer answers null within the window (${tNull?.toFixed(2)} s)`, String(tNull));
  let notNull = 0;
  for (let i = 0; i < 12; i++) {
    const d = i % 2 ? A : B;
    const r = await heartbeat(d.rid, d.secret);
    if (r.status !== 200 || r.data?.rustdeskRegistered !== null) notNull++;
    await sleep(250);
  }
  check(notNull === 0, 'every heartbeat while it is unreadable succeeds and answers null (unknown), for both computers', `${notNull} other answers`);
  const cFail0 = calls();
  for (let i = 0; i < 10; i++) { await heartbeat(B.rid, B.secret); await sleep(50); }
  check(calls() - cFail0 <= 2, 'an unreadable database is not re-read on every heartbeat', `spawned=${calls() - cFail0}`);
  renameSync(`${hbbsDb}.away`, hbbsDb);
  const tBack = await until(B, true, WINDOW_S + 3);
  check(tBack !== null, `answers return when the database does (${tBack?.toFixed(2)} s)`, String(tBack));
  const aBack = (await heartbeat(A.rid, A.secret)).data?.rustdeskRegistered;
  check(aBack === false, 'and the deleted peer is still false after recovery', String(aBack));

  section('Corrupt peer table: null, not false');
  writeFileSync(hbbsDb, 'not a sqlite database');
  const tCorrupt = await until(B, null, WINDOW_S + 3);
  check(tCorrupt !== null, 'a file that is not a SQLite database answers null', String(tCorrupt));
}

async function cleanup() {
  await stopApi();
  try {
    for (const id of businesses) {
      const eps = await prisma.endpoint.findMany({ where: { customerId: id }, select: { id: true } });
      const ids = eps.map((e) => e.id);
      await prisma.endpointCommand.deleteMany({ where: { endpointId: { in: ids } } }).catch(() => {});
      await prisma.endpointLiveState?.deleteMany({ where: { endpointId: { in: ids } } }).catch(() => {});
      await prisma.endpointMonitorState?.deleteMany({ where: { endpointId: { in: ids } } }).catch(() => {});
      await prisma.rustdeskNode.deleteMany({ where: { endpointId: { in: ids } } });
      await prisma.endpointEnrollment.deleteMany({ where: { endpointId: { in: ids } } }).catch(() => {});
      await prisma.endpoint.deleteMany({ where: { id: { in: ids } } }).catch((e) => console.error('cleanup endpoints:', e.message));
      await prisma.customer.delete({ where: { id } }).catch((e) => console.error('cleanup business:', e.message));
    }
  } catch (e) { console.error('cleanup:', e.message); }
  rmSync(work, { recursive: true, force: true });
  await prisma.$disconnect();
}

main()
  .catch((e) => { fail++; failures.push(String(e?.stack ?? e)); console.error(e); if (api?.log) console.error(api.log.slice(-3000)); })
  .finally(async () => {
    await cleanup();
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) { console.log('\nFailures:'); for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1); }
    console.log('ALL PASSED');
    process.exit(0);
  });
