#!/usr/bin/env node
/**
 * Heartbeat cost, measured — the source of the "measured" figures in
 * docs/server-sizing.md.
 *
 * It starts its own API from dist/ on BENCH_API_PORT (3337), against
 * DATABASE_URL (must name a scratch/test database), and:
 *
 *   1. creates BENCH_ENDPOINTS synthetic computers (default 1000) in one
 *      synthetic business, each with a bound device secret, and a scratch
 *      hbbs peer database listing them (RUSTDESK_DB_PATH, so the heartbeat's
 *      sqlite3 presence lookup runs as in production, never against the real
 *      hbbs database);
 *   2. warm-up: one heartbeat per computer, answering the inventory command it
 *      is handed with a synthetic 150-application inventory, so steady state
 *      is "nothing due" as it is between 6-hourly inventories;
 *   3. measures BENCH_ROUNDS rounds of one heartbeat per computer at
 *      BENCH_CONCURRENCY parallel requests: latency, throughput, the API
 *      process's CPU time (including its sqlite3 children), the CPU time of
 *      the PostgreSQL backends serving it, and this database's row activity;
 *   4. reports table sizes and average row sizes from this database.
 *
 * Bounded: one business, at most 10 000 computers, at most 20 rounds; every
 * fixture it made is removed at the end (except audit rows, which the
 * database refuses to update and which are expected on a scratch database).
 * Each computer has its own client address, as real ones do, so the
 * per-address throttles apply as they would in production.
 *
 * Run:  DATABASE_URL=…/rem0te_<x>_test node scripts/bench-heartbeat.mjs
 */
import { PrismaClient } from '@prisma/client';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const DB = process.env.DATABASE_URL ?? '';
const dbName = DB.split('/').pop()?.split('?')[0] ?? '';
if (!/scratch|test/.test(dbName)) { console.error(`Refusing to run against database "${dbName}": name must contain "scratch" or "test".`); process.exit(2); }
const PORT = Number(process.env.BENCH_API_PORT ?? 3337);
if ([3000, 3001, 443, 4000, 4001].includes(PORT)) { console.error(`Refusing port ${PORT}: production or the shared docs stack.`); process.exit(2); }
const N = Math.min(10_000, Number(process.env.BENCH_ENDPOINTS ?? 1000));
const ROUNDS = Math.min(20, Number(process.env.BENCH_ROUNDS ?? 3));
const CONC = Math.min(256, Number(process.env.BENCH_CONCURRENCY ?? 16));
const API = `http://127.0.0.1:${PORT}/api/v1`;
const VERSION_FILE = path.resolve(here, '..', '..', '..', 'version.json');
const AGENT_VERSION = JSON.parse(readFileSync(VERSION_FILE, 'utf8')).version;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const TAG = `BENCH${sfx}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TICK = Number(execFileSync('getconf', ['CLK_TCK']).toString().trim()) || 100;

const work = mkdtempSync(path.join(tmpdir(), 'rem0te-bench-'));
const hbbsDb = path.join(work, 'db_v2.sqlite3');

let api;
async function stopApi() { if (!api || api.exitCode !== null) return; await new Promise((r) => { api.once('exit', r); api.kill('SIGTERM'); }); }

/** utime+stime (+ reaped children) of a process, in ms. */
function cpuMs(pid, children = false) {
  try {
    const f = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = f.slice(f.lastIndexOf(')') + 2).split(' ');
    // fields after "(comm) ": state=0 … utime=11 stime=12 cutime=13 cstime=14
    const t = Number(rest[11]) + Number(rest[12]) + (children ? Number(rest[13]) + Number(rest[14]) : 0);
    return (t * 1000) / TICK;
  } catch { return 0; }
}
function rssMb(pid) {
  try { const m = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, 'utf8')); return m ? Number(m[1]) / 1024 : 0; } catch { return 0; }
}
async function backendPids() {
  const rows = await prisma.$queryRaw`SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`;
  return rows.map((r) => Number(r.pid));
}
async function dbStats() {
  const [r] = await prisma.$queryRaw`SELECT xact_commit::bigint AS c, tup_returned::bigint AS ret, tup_fetched::bigint AS f, tup_inserted::bigint AS i, tup_updated::bigint AS u, tup_deleted::bigint AS d, blks_hit::bigint AS h, blks_read::bigint AS rd FROM pg_stat_database WHERE datname = current_database()`;
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v)]));
}
const pct = (a, p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];

const devs = [];
const ipOf = (i) => `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${(i & 255) || 1}`;
function heartbeatBody(d) {
  return {
    rustdeskId: d.rid, agentSecret: d.secret, hostname: d.host, platform: 'Windows', osVersion: '10.0.22631',
    agentVersion: AGENT_VERSION, rustdeskVersion: '1.4.1', loggedOnUser: 'BENCH\\user', uptimeSeconds: 86_400,
    lastBootAt: new Date(Date.now() - 86_400_000).toISOString(), cpuLoadPercent: 7, memoryTotalMb: 16_384,
    memoryFreeMb: 8_200, systemDiskTotalMb: 486_000, systemDiskFreeMb: 210_000, rustdeskSessions: 0, updateChannel: 'legacy',
  };
}
function inventoryOf(d) {
  const software = Array.from({ length: 150 }, (_, i) => ({ name: `Bench Application ${i} Suite`, version: `${1 + (i % 9)}.${i % 13}.${i * 7 % 1000}`, publisher: `Bench Publisher ${i % 25} Ltd` }));
  return {
    manufacturer: 'Bench Computers', model: 'BX-1000', serialNumber: `SN-${d.rid}`, biosVersion: '1.2.3', osCaption: 'Microsoft Windows 11 Pro',
    osBuild: '22631', osArch: '64-bit', domain: 'bench.example.com', timezone: 'UTC', cpuModel: 'Bench CPU 8-core @ 3.0GHz', cpuCores: 8, cpuThreads: 16, cpuMhz: 3000,
    memoryTotalMb: 16_384, memoryFreeMb: 8_200,
    disks: [{ drive: 'C:', label: 'OS', fsType: 'NTFS', totalBytes: 512_000_000_000, freeBytes: 220_000_000_000 }, { drive: 'D:', label: 'Data', fsType: 'NTFS', totalBytes: 1_000_000_000_000, freeBytes: 600_000_000_000 }],
    networks: [{ name: 'Ethernet', mac: '00-11-22-33-44-55', ipv4: '10.0.0.10', gateway: '10.0.0.1' }, { name: 'Wi-Fi', mac: '00-11-22-33-44-66', ipv4: '10.0.1.10', gateway: '10.0.1.1' }],
    software,
  };
}
let reqBytes = 0, resBytes = 0;
async function post(p, d, body) {
  const s = JSON.stringify(body);
  reqBytes += Buffer.byteLength(s);
  const t0 = performance.now();
  const r = await fetch(`${API}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ipOf(d.i) }, body: s });
  const text = await r.text();
  resBytes += Buffer.byteLength(text);
  return { status: r.status, ms: performance.now() - t0, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}
async function pool(items, conc, fn) {
  let next = 0; const out = new Array(items.length);
  await Promise.all(Array.from({ length: conc }, async () => { while (next < items.length) { const k = next++; out[k] = await fn(items[k], k); } }));
  return out;
}

let businessId = null;
async function main() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  const busy = await fetch(`${API}/health`).then(() => true, () => false);
  if (busy) throw new Error(`port ${PORT} is already in use; set BENCH_API_PORT`);

  console.log(`fixtures: ${N} computers in one synthetic business (${TAG})`);
  const biz = await prisma.customer.create({ data: { tenantId: tenant.id, name: `${TAG} Bench` } });
  businessId = biz.id;
  for (let i = 0; i < N; i++) devs.push({ i: i + 1, rid: String(700_000_000 + Math.floor(Math.random() * 99_999_999)), secret: randomBytes(24).toString('base64url'), host: `${TAG}-${i}` });
  const seen = new Set(); for (const d of devs) { while (seen.has(d.rid)) d.rid = String(Number(d.rid) + 1); seen.add(d.rid); }
  for (let k = 0; k < devs.length; k += 500) {
    const chunk = devs.slice(k, k + 500);
    await prisma.$transaction(async (tx) => {
      for (const d of chunk) {
        const ep = await tx.endpoint.create({ data: { tenantId: tenant.id, customerId: biz.id, name: d.host, hostname: d.host, platform: 'windows', status: 'ACTIVE', isManaged: true, enrollment: { create: { status: 'ACTIVE' } } } });
        await tx.rustdeskNode.create({ data: { tenantId: tenant.id, endpointId: ep.id, rustdeskId: d.rid, platform: 'Windows', agentSecretHash: createHash('sha256').update(d.secret).digest('hex'), agentSecretSetAt: new Date() } });
      }
    }, { timeout: 120_000 });
  }
  execFileSync('sqlite3', [hbbsDb, `CREATE TABLE peer(id TEXT PRIMARY KEY); ${devs.map((d) => `INSERT INTO peer VALUES('${d.rid}');`).join('')}`]);

  api = spawn(process.execPath, [path.join(dist, 'main.js')], {
    env: {
      ...process.env, NODE_ENV: 'production', COOKIE_SECURE: 'false', PORT: String(PORT), DATABASE_URL: DB, I_KNOW_THIS_IS_NOT_PRODUCTION: '1',
      JWT_SECRET: randomBytes(32).toString('hex'), LAUNCHER_TOKEN_SECRET: randomBytes(32).toString('hex'),
      ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? randomBytes(32).toString('hex'), TRUSTED_PROXIES: 'loopback',
      HBBS_PRESENCE_HOST: '127.0.0.2', RUSTDESK_DB_PATH: hbbsDb, MONITOR_SWEEP: 'off', CLIENT_UPDATE_SWEEP: 'off', VERSION_FILE,
      LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  api.log = ''; api.stdout.on('data', (d) => { api.log = (api.log + d).slice(-20000); }); api.stderr.on('data', (d) => { api.log = (api.log + d).slice(-20000); });
  for (let i = 0; i < 200; i++) { try { const r = await fetch(`${API}/health`); if (r.status < 500) break; } catch { /* not yet */ } await sleep(300); if (i === 199) throw new Error(`api did not come up:\n${api.log}`); }
  await sleep(2000);
  const idleRss = rssMb(api.pid);

  // ── warm-up ──
  console.log('warm-up: first heartbeat + inventory per computer');
  let invCount = 0, invMs = 0;
  const cpuW0 = cpuMs(api.pid, true);
  await pool(devs, CONC, async (d) => {
    const r = await post('/enrollment/heartbeat', d, heartbeatBody(d));
    if (r.status !== 200) throw new Error(`warm-up heartbeat ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`);
    for (const c of r.json?.data?.commands ?? []) {
      if (c.type === 'INVENTORY_REFRESH') {
        const x = await post('/enrollment/command-result', d, { rustdeskId: d.rid, agentSecret: d.secret, commandId: c.id, ok: true, inventory: inventoryOf(d) });
        invCount++; invMs += x.ms;
      } else {
        await post('/enrollment/command-result', d, { rustdeskId: d.rid, agentSecret: d.secret, commandId: c.id, ok: true });
      }
    }
  });
  const warmCpu = cpuMs(api.pid, true) - cpuW0;
  console.log(`  ${invCount} inventories answered, mean ${(invMs / Math.max(1, invCount)).toFixed(1)} ms`);

  // ── steady state ──
  const results = [];
  for (let round = 1; round <= ROUNDS; round++) {
    reqBytes = 0; resBytes = 0;
    const pids = await backendPids();
    const pg0 = pids.reduce((a, p) => a + cpuMs(p), 0);
    const s0 = await dbStats();
    const c0 = cpuMs(api.pid, true);
    const self0 = cpuMs(api.pid, false);
    const t0 = performance.now();
    const lat = await pool(devs, CONC, async (d) => { const r = await post('/enrollment/heartbeat', d, heartbeatBody(d)); if (r.status !== 200) throw new Error(`heartbeat ${r.status}`); return r.ms; });
    const wall = (performance.now() - t0) / 1000;
    const apiCpu = cpuMs(api.pid, true) - c0;
    const selfCpu = cpuMs(api.pid, false) - self0;
    const pids2 = await backendPids();
    const pg1 = pids2.filter((p) => pids.includes(p)).reduce((a, p) => a + cpuMs(p), 0);
    const s1 = await dbStats();
    lat.sort((a, b) => a - b);
    const d = Object.fromEntries(Object.keys(s1).map((k) => [k, (s1[k] - s0[k]) / N]));
    results.push({ round, wall, rate: N / wall, p50: pct(lat, 0.5), p95: pct(lat, 0.95), p99: pct(lat, 0.99), apiCpuPerHb: apiCpu / N, selfCpuPerHb: selfCpu / N, childCpuPerHb: (apiCpu - selfCpu) / N, pgCpuPerHb: (pg1 - pg0) / N, pgBackends: pids.length, perHb: d, reqB: reqBytes / N, resB: resBytes / N, rss: rssMb(api.pid) });
    await sleep(1500);
  }

  // ── sizes ──
  const tables = ['Endpoint', 'RustdeskNode', 'EndpointInventory', 'EndpointCommand', 'EndpointChange', 'EndpointEnrollment', 'ActivityLog', 'SupportSession', 'SupportSessionEvent', 'MonitorAlert', 'MonitorAlertEvent', 'EndpointMonitorState', 'DiagnosticRun', 'ActionJob', 'ActionTarget', 'UpdateJob', 'UpdateJobEvent', 'AuditCheckpoint', 'DeviceClaimToken'];
  const sizes = [];
  for (const t of tables) {
    const [r] = await prisma.$queryRawUnsafe(`SELECT count(*)::bigint AS n, coalesce(avg(pg_column_size(x.*)),0)::float AS avg, pg_total_relation_size('"${t}"')::bigint AS total, pg_relation_size('"${t}"')::bigint AS heap, pg_indexes_size('"${t}"')::bigint AS idx FROM "${t}" x`);
    sizes.push({ table: t, rows: Number(r.n), avgRowB: Math.round(r.avg), totalPerRowB: Number(r.n) ? Math.round(Number(r.total) / Number(r.n)) : null, heapMB: (Number(r.heap) / 1048576).toFixed(2), idxMB: (Number(r.idx) / 1048576).toFixed(2) });
  }
  const invRow = await prisma.$queryRaw`SELECT avg(pg_column_size(i.*))::float AS row, avg(pg_column_size(i.software))::float AS sw FROM "EndpointInventory" i JOIN "Endpoint" e ON e.id = i."endpointId" WHERE e."customerId" = ${biz.id}`;
  const auditByAction = await prisma.$queryRaw`SELECT action::text AS action, count(*)::bigint AS n, avg(pg_column_size(a.*))::float AS avg FROM "ActivityLog" a GROUP BY action ORDER BY count(*) DESC LIMIT 40`;

  console.log('\n── steady-state heartbeats');
  console.table(results.map((r) => ({ round: r.round, 'hb/s': r.rate.toFixed(0), 'p50 ms': r.p50.toFixed(1), 'p95 ms': r.p95.toFixed(1), 'p99 ms': r.p99.toFixed(1), 'API cpu ms/hb': r.apiCpuPerHb.toFixed(2), 'node ms/hb': r.selfCpuPerHb.toFixed(2), 'sqlite3 ms/hb': r.childCpuPerHb.toFixed(2), 'PG cpu ms/hb': r.pgCpuPerHb.toFixed(2), 'PG backends': r.pgBackends, 'req B': r.reqB.toFixed(0), 'res B': r.resB.toFixed(0), 'RSS MB': r.rss.toFixed(0) })));
  console.log('per heartbeat, this database:'); console.table(results.map((r) => Object.fromEntries(Object.entries(r.perHb).map(([k, v]) => [k, v.toFixed(2)]))));
  console.log(`API RSS idle ${idleRss.toFixed(0)} MB; warm-up API CPU ${(warmCpu / N).toFixed(2)} ms per computer (heartbeat + inventory)`);
  console.log(`inventory row (150 apps): ${Math.round(invRow[0]?.row ?? 0)} B, of which software ${Math.round(invRow[0]?.sw ?? 0)} B`);
  console.log('\n── table sizes (this scratch database)'); console.table(sizes);
  console.log('\n── audit rows by action'); console.table(auditByAction.map((a) => ({ action: a.action, n: Number(a.n), avgB: Math.round(a.avg) })));
}

async function cleanup() {
  await stopApi();
  try {
    if (businessId) {
      const eps = await prisma.endpoint.findMany({ where: { customerId: businessId }, select: { id: true } });
      const ids = eps.map((e) => e.id);
      for (let k = 0; k < ids.length; k += 1000) {
        const c = ids.slice(k, k + 1000);
        await prisma.endpointChange.deleteMany({ where: { endpointId: { in: c } } });
        await prisma.endpointCommand.deleteMany({ where: { endpointId: { in: c } } });
        await prisma.endpointInventory.deleteMany({ where: { endpointId: { in: c } } });
        await prisma.rustdeskNode.deleteMany({ where: { endpointId: { in: c } } });
        await prisma.endpointMonitorState.deleteMany({ where: { endpointId: { in: c } } }).catch(() => {});
        await prisma.endpoint.deleteMany({ where: { id: { in: c } } });
      }
      await prisma.customer.delete({ where: { id: businessId } });
    }
  } catch (e) { console.error('cleanup:', e.message); }
  rmSync(work, { recursive: true, force: true });
  await prisma.$disconnect();
}

main()
  .then(() => cleanup().then(() => process.exit(0)))
  .catch(async (e) => { console.error(e); if (api?.log) console.error(api.log.slice(-3000)); await cleanup(); process.exit(1); });
