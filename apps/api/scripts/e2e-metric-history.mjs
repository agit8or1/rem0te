#!/usr/bin/env node
/**
 * End-to-end proof of metric history (0.33): GET /endpoints/:id/metrics, the
 * heartbeat and inventory recording, and the roll-up / retention sweep.
 *
 *   - a heartbeat without the device secret, with the wrong one, or from a
 *     node that has none bound writes NO sample; an authenticated one writes
 *     exactly one, with the used percentages the agent's values imply, and a
 *     second inside the minimum interval writes nothing;
 *   - an inventory pass (command-result, device secret) writes one
 *     per-volume sample per drive, returned per volume;
 *   - with METRIC_SWEEP=off nothing is rolled up or pruned, however long the
 *     process runs;
 *   - with the sweep on: every complete hour rolls up to exactly the
 *     min / mean / max / count of its raw samples, no pass rolls more than
 *     METRIC_ROLLUP_HOURS_PER_PASS hours, re-running changes nothing, raw past
 *     retention is pruned once rolled, raw inside retention is kept, and
 *     hourly and per-volume rows past METRIC_HOURLY_DAYS are pruned;
 *   - ranges read the right store (24 h raw, longer hourly with the unrolled
 *     hours computed live), exclude what is outside them, and return gaps as
 *     gaps — no point inside one;
 *   - isolation: Business B's owner, a Business A user without a grant, and
 *     a technician restricted to another computer all get the same 404 as a
 *     nonexistent id; computers:view is required; the admin is the control.
 *
 * Self-starting: it runs its own API from dist/ on METRIC_API_PORT (3301),
 * twice (sweep off, then on), against DATABASE_URL, which must name a
 * scratch/test database. Fixtures are namespaced and removed at the end.
 *
 * Run:  DATABASE_URL=…/rem0te_metric_history_test node scripts/e2e-metric-history.mjs
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const M = createRequire(import.meta.url)(path.join(dist, 'metrics/metrics-math.js'));
const DB = process.env.DATABASE_URL ?? '';
const dbName = DB.split('/').pop()?.split('?')[0] ?? '';
if (!/scratch|test/.test(dbName)) { console.error(`Refusing to run against database "${dbName}": name must contain "scratch" or "test".`); process.exit(2); }
const PORT = Number(process.env.METRIC_API_PORT ?? 3301);
if ([3000, 3001, 443].includes(PORT)) { console.error(`Refusing port ${PORT}: that is a production port.`); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'metric-history-e2e-password-1';
const TAG = `MH${sfx}`;
const H = 3_600_000, MIN = 60_000, DAY = 24 * H;
const PER_PASS = 3;

let pass = 0, fail = 0;
const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;
const sha = (s) => createHash('sha256').update(s).digest('hex');
const near = (a, b, tol = 1e-3) => (a === null || b === null) ? a === b : Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

const baseEnv = {
  ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATABASE_URL: DB,
  JWT_SECRET: randomBytes(32).toString('hex'), LAUNCHER_TOKEN_SECRET: randomBytes(32).toString('hex'),
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? randomBytes(32).toString('hex'), TRUSTED_PROXIES: 'loopback',
  HBBS_PRESENCE_HOST: '127.0.0.2', MONITOR_SWEEP: 'off', AUDIT_SEALER: 'off',
  VERSION_FILE: path.resolve(here, '..', '..', '..', 'version.json'),
  // run-e2e.sh exports METRIC_SWEEP=off for every other suite; this one
  // tests the sweep, so it turns it on unless a phase says otherwise.
  METRIC_SWEEP: 'on', METRIC_SWEEP_SECONDS: '2', METRIC_ROLLUP_HOURS_PER_PASS: String(PER_PASS),
};
let api;
function startApi(extra) {
  api = spawn(process.execPath, [path.join(dist, 'main.js')], { env: { ...baseEnv, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  api.log = ''; api.stdout.on('data', (d) => { api.log += d; }); api.stderr.on('data', (d) => { api.log += d; });
}
async function stopApi() { if (!api || api.exitCode !== null) return; await new Promise((r) => { api.once('exit', r); api.kill('SIGTERM'); }); }
async function waitUp() {
  for (let i = 0; i < 150; i++) { try { const r = await fetch(`${API}/health`); if (r.status < 500) return; } catch { /* not yet */ } await sleep(300); }
  throw new Error(`api did not come up:\n${api.log.slice(-3000)}`);
}

async function req(method, p, { s, body } = {}) {
  // A fresh address per request: the throttler is keyed by client address.
  const h = { 'content-type': 'application/json', 'x-forwarded-for': ip() };
  if (s) h.cookie = s.cookie;
  const r = await fetch(`${API}${p}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = text; }
  await sleep(60); // well under 20 req/s
  return { status: r.status, body: j, data: j?.data };
}
async function login(email) {
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip() }, body: JSON.stringify({ email, password: PW }) });
  const mm = (r.headers.get('set-cookie') ?? '').match(/access_token=([^;]+)/);
  if (r.status !== 200 || !mm) throw new Error(`login ${email}: ${r.status} ${await r.text()}`);
  return { cookie: `access_token=${mm[1]}` };
}
const msg = (r) => `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`;
const metrics = (s, id, range) => req('GET', `/endpoints/${id}/metrics${range ? `?range=${range}` : ''}`, { s });
const heartbeat = (ep, extra = {}, secret = ep.secret) => req('POST', '/enrollment/heartbeat', { body: { rustdeskId: ep.rid, ...(secret ? { agentSecret: secret } : {}), hostname: ep.hostname, platform: 'Windows', ...extra } });
const live = { cpuLoadPercent: 42, memoryTotalMb: 16000, memoryFreeMb: 4000, systemDiskTotalMb: 400000, systemDiskFreeMb: 100000 };

const created = { businesses: [], users: [], endpoints: [] };

async function all() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });
  const roleUser = await prisma.role.findFirst({ where: { type: 'BUSINESS_USER' } });

  section('Fixtures (synthetic): Business A (three computers), Business B (one), six users');
  const A = await prisma.customer.create({ data: { tenantId: tenant.id, name: `${TAG} Acme` } });
  const B = await prisma.customer.create({ data: { tenantId: tenant.id, name: `${TAG} Birch` } });
  created.businesses.push(A.id, B.id);
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag, extra = {}) => { const u = await prisma.user.create({ data: { email: `mh-${tag}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'MH', lastName: tag, status: 'ACTIVE', ...extra } }); created.users.push(u.id); return u; };
  const admin = await mkUser('admin', { isPlatformAdmin: true });
  const ownerA = await mkUser('owner-a'), ownerB = await mkUser('owner-b'), userA = await mkUser('user-a'), noView = await mkUser('noview-a'), techOne = await mkUser('tech-one');
  await prisma.membership.create({ data: { userId: ownerA.id, tenantId: tenant.id, customerId: A.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: ownerB.id, tenantId: tenant.id, customerId: B.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: userA.id, tenantId: tenant.id, customerId: A.id, roleId: roleUser.id, capabilities: ['computers:view'] } });
  await prisma.membership.create({ data: { userId: noView.id, tenantId: tenant.id, customerId: A.id, roleId: roleUser.id, capabilities: ['computers:connect'] } });

  const born = new Date(Date.now() - 120 * DAY);
  const mkEp = async (biz, hostname, { mode = 'COMPANY_WIDE', secret = true } = {}) => {
    const e = await prisma.endpoint.create({ data: { tenantId: tenant.id, customerId: biz.id, name: `${TAG}-${hostname}`, hostname, platform: 'Windows', status: 'ACTIVE', isOnline: true, isManaged: true, accessMode: mode, lastSeenAt: new Date(), deviceClass: 'WORKSTATION', createdAt: born } });
    created.endpoints.push(e.id);
    const rid = String(100000000 + ((Math.random() * 899999999) | 0));
    const s = secret ? randomBytes(24).toString('hex') : null;
    await prisma.rustdeskNode.create({ data: { tenantId: tenant.id, endpointId: e.id, rustdeskId: rid, ...(s ? { agentSecretHash: sha(s) } : {}) } });
    return { id: e.id, rid, secret: s, hostname };
  };
  const a1 = await mkEp(A, 'A1'), a2 = await mkEp(A, 'A2-NOT-GRANTED', { mode: 'ASSIGNED_USERS' }), aLegacy = await mkEp(A, 'A3-LEGACY', { secret: false });
  const b1 = await mkEp(B, 'B1');
  await prisma.technicianAssignment.create({ data: { tenantId: tenant.id, customerId: A.id, userId: techOne.id, capabilities: ['computers:view'], endpointIds: [a1.id] } });
  const samplesOf = (id) => prisma.endpointMetricSample.count({ where: { endpointId: id } });

  // ── Phase 1: sweep off ─────────────────────────────────────────────────────
  startApi({ METRIC_SWEEP: 'off' });
  await waitUp();
  const S = { admin: await login(admin.email), ownerA: await login(ownerA.email), ownerB: await login(ownerB.email), userA: await login(userA.email), noView: await login(noView.email), techOne: await login(techOne.email) };

  section('Recording: only an authenticated heartbeat writes a sample');
  let r = await heartbeat(a1, live, null);
  check(r.status === 401 && (await samplesOf(a1.id)) === 0, 'a heartbeat without the device secret is refused and writes nothing', msg(r));
  r = await heartbeat(a1, live, 'f'.repeat(48));
  check(r.status === 401 && (await samplesOf(a1.id)) === 0, 'a heartbeat with the wrong secret is refused and writes nothing', msg(r));
  r = await heartbeat(aLegacy, live, 'a'.repeat(48));
  check(r.status === 200 && r.data?.authenticated === false && (await samplesOf(aLegacy.id)) === 0, 'a node with no bound secret gets liveness, and no sample', msg(r));
  r = await heartbeat(a1, live);
  const first = await prisma.endpointMetricSample.findMany({ where: { endpointId: a1.id } });
  check(r.status === 200 && r.data?.authenticated === true && first.length === 1, 'an authenticated heartbeat writes one sample', msg(r));
  check(first[0]?.cpu === 42 && first[0]?.memory === 75 && first[0]?.disk === 75, 'cpu 42 as sent; memory and system disk as used share (12000/16000, 300000/400000)', JSON.stringify(first[0]));
  r = await heartbeat(a1, { ...live, cpuLoadPercent: 99 });
  check(r.status === 200 && (await samplesOf(a1.id)) === 1, 'a second heartbeat inside the minimum interval writes nothing more');
  r = await heartbeat(b1, { cpuLoadPercent: 7 });
  check(r.status === 200 && (await samplesOf(b1.id)) === 1, 'B\'s computer records its own sample (cpu only)');

  section('Recording: an inventory pass writes one sample per volume');
  await prisma.endpointCommand.deleteMany({ where: { endpointId: a1.id } });
  await prisma.endpointMetricSample.deleteMany({ where: { endpointId: a1.id } }); // let the next beat through the interval
  const hb = await heartbeat(a1, live);
  const inv = hb.data?.commands?.find((c) => c.type === 'INVENTORY_REFRESH');
  check(!!inv, 'the heartbeat hands out an inventory refresh', msg(hb));
  if (inv) {
    r = await req('POST', '/enrollment/command-result', { body: { rustdeskId: a1.rid, agentSecret: a1.secret, commandId: inv.id, ok: true, inventory: { disks: [{ drive: 'C:', totalBytes: 512e9, freeBytes: 128e9 }, { drive: 'D:', totalBytes: 2e12, freeBytes: 1.5e12 }, { drive: 'E:', totalBytes: null, freeBytes: 1 }] } } });
    const ds = await prisma.endpointDiskSample.findMany({ where: { endpointId: a1.id }, orderBy: { drive: 'asc' } });
    check(r.status === 200 && ds.length === 2 && ds[0].drive === 'C:' && ds[0].used === 75 && ds[1].drive === 'D:' && ds[1].used === 25, 'C: 75 % and D: 25 % recorded; a volume with no size is skipped', JSON.stringify(ds));
  }
  r = await req('POST', '/enrollment/command-result', { body: { rustdeskId: a1.rid, agentSecret: 'f'.repeat(48), commandId: inv?.id ?? 'x', ok: true, inventory: { disks: [{ drive: 'Z:', totalBytes: 10, freeBytes: 1 }] } } });
  check(r.status === 401 && (await prisma.endpointDiskSample.count({ where: { endpointId: a1.id, drive: 'Z:' } })) === 0, 'a command result with the wrong secret writes no volume sample', msg(r));

  // ── Fixtures in the past (as if the agent had been reporting) ─────────────
  // a1: raw every 3 min for 60 h → 50 h ago (past raw retention; rolls then prunes),
  //     and 6 h → 4 h ago, 2 h → 1 h ago (inside 24 h, with a 2 h gap between),
  //     an hourly row 80 d ago and one 100 d ago (past retention), and old volume samples.
  const now0 = Date.now();
  const mk = (from, to, f) => { const out = []; for (let t = from, i = 0; t < to; t += 3 * MIN, i++) out.push({ endpointId: a1.id, at: new Date(t), ...f(i) }); return out; };
  // Varied, with every fifth sample missing its disk value and every seventh its cpu.
  const wave = (i) => ({ cpu: i % 7 === 3 ? null : (i * 37) % 101, memory: 40 + ((i * 11) % 13) + 0.5, disk: i % 5 === 0 ? null : 60 + (i % 4) });
  const old = mk(M.hourStart(now0 - 60 * H), M.hourStart(now0 - 50 * H), wave);
  const recentA = mk(now0 - 6 * H, now0 - 4 * H, wave), recentB = mk(now0 - 2 * H, now0 - 1 * H, wave);
  await prisma.endpointMetricSample.createMany({ data: [...old, ...recentA, ...recentB] });
  const fixedHour = (d, avg) => ({ endpointId: a1.id, hour: new Date(M.hourStart(now0 - d * DAY)), samples: 20, cpuMin: avg - 5, cpuAvg: avg, cpuMax: avg + 5, memoryMin: 1, memoryAvg: 2, memoryMax: 3, diskMin: 50, diskAvg: 50, diskMax: 50 });
  await prisma.endpointMetricHourly.createMany({ data: [fixedHour(80, 33), fixedHour(100, 44)] });
  await prisma.endpointDiskSample.createMany({ data: [{ endpointId: a1.id, at: new Date(now0 - 100 * DAY), drive: 'C:', used: 10 }, { endpointId: a1.id, at: new Date(now0 - 20 * DAY), drive: 'C:', used: 50 }] });
  check(true, `fixtures: ${old.length} raw samples 60–50 h ago, ${recentA.length + recentB.length} in the last 6 h, hourly rows 80 d and 100 d ago`);

  section('METRIC_SWEEP=off: nothing is rolled or pruned');
  await sleep(7000); // three sweep intervals and the first-run delay, were it on
  const hourlyOff = await prisma.endpointMetricHourly.count({ where: { endpointId: a1.id } });
  check(hourlyOff === 2, 'no hourly rows were written (only the two fixtures)', `count ${hourlyOff}`);
  check((await samplesOf(a1.id)) === old.length + recentA.length + recentB.length + 1, 'no raw sample was pruned, including those 60 h old');
  check((await prisma.endpointDiskSample.count({ where: { endpointId: a1.id } })) === 4, 'no volume sample was pruned, including the 100-day-old one');
  check(!/MetricHistory/.test(api.log), 'the sweep never logged');

  section('Ranges and gaps (served before any roll-up)');
  r = await metrics(S.ownerA, a1.id, '24h');
  const d24 = r.data;
  const inside24 = [...recentA, ...recentB].length + 1;
  check(r.status === 200 && d24.resolution === 'raw' && d24.series.t.length === inside24, `24 h reads raw: the ${inside24} samples inside it, none of the 60-hour-old ones`, msg(r));
  check(d24.series.t.every((t, i) => i === 0 || d24.series.t[i - 1] < t) && d24.series.t.every((t) => t >= Date.parse(d24.from)), 'points are in time order and inside the window');
  const gapMid = d24.gaps.find((g) => Math.abs(Date.parse(g.from) - (recentA.at(-1).at.getTime())) < 1000);
  check(!!gapMid && Math.abs(Date.parse(gapMid.to) - recentB[0].at.getTime()) < 1000, 'the 2 hours of silence are one gap, from the last sample to the next', JSON.stringify(d24.gaps));
  check(gapMid && !d24.series.t.some((t) => t > Date.parse(gapMid.from) && t < Date.parse(gapMid.to)), 'no point is invented inside the gap');
  check(d24.gaps.some((g) => Date.parse(g.from) === Date.parse(d24.from)), 'the 18 hours before the first sample are a gap too');
  check(d24.series.cpu.length === inside24 && d24.series.memory.length === inside24 && d24.series.disk.includes(null), 'one value per point per metric; a metric a sample lacked is null, not 0');
  check(JSON.stringify(d24.disks.volumes.map((v) => v.drive)) === '["C:","D:"]', 'volumes are returned per drive', JSON.stringify(d24.disks.volumes.map((v) => v.drive)));
  const c24 = d24.disks.volumes.find((v) => v.drive === 'C:');
  check(c24 && c24.used.length === 1 && c24.used[0] === 75, '24 h shows only the volume sample inside it (not the 20- or 100-day-old ones)', JSON.stringify(d24.disks));

  r = await metrics(S.ownerA, a1.id, '7d');
  const d7 = r.data;
  const expectLive = M.rollup([...old, ...recentA, ...recentB].map((x) => ({ ...x, at: x.at.getTime() })));
  check(r.status === 200 && d7.resolution === 'hour' && d7.bucketSeconds === 3600, '7 d reads hourly', msg(r));
  check(d7.series.t.length >= expectLive.length && expectLive.every((h) => d7.series.t.includes(h.hour)), 'hours not rolled yet are computed from raw, so nothing is missing before the sweep runs', `${d7.series.t.length} vs ${expectLive.length}`);
  check(d7.series.t.every((t) => t % H === 0), 'buckets are whole hours');
  check(d7.gaps.some((g) => Date.parse(g.from) === M.hourStart(old.at(-1).at.getTime()) + H), 'the silence after 50 h ago is a gap starting where the last bucket ends', JSON.stringify(d7.gaps.slice(0, 4)));
  r = await metrics(S.ownerA, a1.id, '30d');
  check(r.status === 200 && !r.data.series.t.includes(M.hourStart(now0 - 80 * DAY)), '30 d excludes the 80-day-old hour');
  r = await metrics(S.ownerA, a1.id, '90d');
  const i80 = r.data.series.t.indexOf(M.hourStart(now0 - 80 * DAY));
  check(r.status === 200 && i80 >= 0 && r.data.series.cpu[i80] === 33 && r.data.series.cpuMin[i80] === 28 && r.data.series.cpuMax[i80] === 38, '90 d includes it, with its min / mean / max', msg(r));
  check(!r.data.series.t.includes(M.hourStart(now0 - 100 * DAY)), 'and nothing older than 90 d');
  r = await metrics(S.ownerA, a1.id);
  check(r.status === 200 && r.data.range === '24h', 'no range means 24h');
  for (const bad of ['1y', '24H', 'toString', '7d%26range%3D90d']) {
    r = await metrics(S.ownerA, a1.id, bad);
    check(r.status === 400, `range=${decodeURIComponent(bad)} is refused`, msg(r));
  }

  section('Isolation: another business\'s computer looks like a missing one');
  const missing = await metrics(S.ownerA, 'c' + randomBytes(12).toString('hex'), '24h');
  check(missing.status === 404, 'a nonexistent id is 404', msg(missing));
  r = await metrics(S.ownerB, a1.id, '24h');
  check(r.status === 404 && r.body?.code === missing.body?.code && r.body?.message === missing.body?.message, 'B\'s owner gets A\'s computer as the same 404', msg(r));
  r = await metrics(S.ownerA, b1.id, '7d');
  check(r.status === 404, 'A\'s owner gets B\'s computer as 404', msg(r));
  r = await metrics(S.ownerB, b1.id, '24h');
  check(r.status === 200 && r.data.series.t.length === 1 && r.data.series.cpu[0] === 7 && !JSON.stringify(r.data).includes(String(old[0].at.getTime())), 'B\'s owner sees B\'s single sample and nothing of A\'s', msg(r));
  r = await metrics(S.userA, a1.id, '24h');
  check(r.status === 200, 'A\'s user sees the company-wide computer', msg(r));
  r = await metrics(S.userA, a2.id, '24h');
  check(r.status === 404, 'A\'s user gets an ASSIGNED_USERS computer they have no grant to as 404 (visibility, not just business)', msg(r));
  r = await metrics(S.techOne, a1.id, '24h');
  check(r.status === 200, 'a technician restricted to a1 sees a1', msg(r));
  r = await metrics(S.techOne, a2.id, '24h');
  check(r.status === 404, 'and gets a2, in the same business, as 404', msg(r));
  r = await metrics(S.noView, a1.id, '24h');
  check(r.status === 403, 'without computers:view it is refused', msg(r));
  r = await req('GET', `/endpoints/${a1.id}/metrics?range=24h`);
  check(r.status === 401, 'unauthenticated is 401', msg(r));
  r = await metrics(S.admin, b1.id, '24h');
  check(r.status === 200 && r.data.series.t.length === 1, 'negative control: the Platform Admin reads B\'s computer');

  // ── Phase 2: sweep on ──────────────────────────────────────────────────────
  await stopApi();
  // The normal pass looks only after the newest rolled hour (any computer's);
  // the full scan finds older ones. On a database of its own this suite's
  // fixtures are the oldest unrolled data, so only the process's first pass
  // is a full scan and the rest prove the normal path. In a shared database
  // (run-e2e.sh) other suites have rolled newer hours already, so every pass
  // is a full scan and the suite proves catch-up instead.
  const newer = await prisma.endpointMetricHourly.count({ where: { endpointId: { notIn: created.endpoints }, hour: { gt: new Date(now0 - 61 * H) } } });
  const fullEvery = newer ? 1 : 1000;
  console.log(`  (other computers' roll-ups newer than the fixtures: ${newer}; METRIC_FULL_SCAN_PASSES=${fullEvery})`);
  startApi({ METRIC_FULL_SCAN_PASSES: String(fullEvery) });
  await waitUp();

  section(`Sweep on: roll-up (≤ ${PER_PASS} hours a pass), idempotent, then retention`);
  const oldHours = M.rollup(old.map((x) => ({ ...x, at: x.at.getTime() })));
  const end = M.lastCompleteHour(Date.now());
  // Everything raw a1 has (fixtures and the live heartbeat), as the reference.
  const allRaw = await prisma.endpointMetricSample.findMany({ where: { endpointId: a1.id } });
  const want = M.rollup(allRaw.map((x) => ({ ...x, at: x.at.getTime() }))).filter((h) => h.hour < end);
  let rolled = [];
  for (let i = 0; i < 120; i++) {
    rolled = await prisma.endpointMetricHourly.findMany({ where: { endpointId: a1.id, hour: { gt: new Date(now0 - 70 * H) } }, orderBy: { hour: 'asc' } });
    if (rolled.length >= want.length) break;
    await sleep(1000);
  }
  check(rolled.length === want.length, `every complete hour with samples is rolled (${want.length})`, `got ${rolled.length}`);
  let exact = true, bad = '';
  for (const w of want) {
    const g = rolled.find((x) => x.hour.getTime() === w.hour);
    for (const k of ['samples', 'cpuMin', 'cpuAvg', 'cpuMax', 'memoryMin', 'memoryAvg', 'memoryMax', 'diskMin', 'diskAvg', 'diskMax']) {
      if (!g || !near(g[k], w[k])) { exact = false; bad = `${new Date(w.hour).toISOString()} ${k}: db ${g?.[k]} want ${w[k]}`; break; }
    }
    if (!exact) break;
  }
  check(exact, 'each hour is exactly the count, min, mean and max of its raw samples (nulls left out of the mean)', bad);
  check(!rolled.some((x) => x.hour.getTime() >= end), 'the hour in progress is not rolled');
  const passes = [...api.log.matchAll(/rolled (\d+) hour\(s\) \(\d+ row\(s\), ([a-z ]+)\)/g)].map((m) => ({ n: Number(m[1]), how: m[2] }));
  check(passes.length >= Math.ceil(want.length / PER_PASS) && passes.every((p) => p.n <= PER_PASS), `bounded: ${passes.filter((p) => p.n).length} passes rolled hours, none more than ${PER_PASS}`, JSON.stringify(passes));
  if (fullEvery > 1) check(passes[0]?.how === 'full scan' && passes.slice(1).filter((p) => p.n).every((p) => p.how === 'after newest'), 'after the first (full) pass, the normal pass alone carried the roll-up forward', JSON.stringify(passes));
  // Pruning runs after the roll-up in the same pass; give it one more.
  await sleep(4500);
  const snapshot = JSON.stringify(await prisma.endpointMetricHourly.findMany({ where: { endpointId: a1.id }, orderBy: { hour: 'asc' } }));
  await sleep(4500);
  check(JSON.stringify(await prisma.endpointMetricHourly.findMany({ where: { endpointId: a1.id }, orderBy: { hour: 'asc' } })) === snapshot, 'idempotent: further passes change nothing');
  const rawLeft = await prisma.endpointMetricSample.findMany({ where: { endpointId: a1.id }, select: { at: true } });
  check(!rawLeft.some((x) => x.at.getTime() < now0 - 48 * H), 'raw samples past 48 h are pruned once rolled up', `${rawLeft.filter((x) => x.at.getTime() < now0 - 48 * H).length} left`);
  check(rawLeft.length === recentA.length + recentB.length + 1, 'raw samples inside 48 h are kept', `${rawLeft.length}`);
  const hourlyLeft = await prisma.endpointMetricHourly.findMany({ where: { endpointId: a1.id }, select: { hour: true } });
  check(!hourlyLeft.some((x) => x.hour.getTime() < now0 - 90 * DAY) && hourlyLeft.some((x) => x.hour.getTime() === M.hourStart(now0 - 80 * DAY)), 'hourly rows past 90 d are pruned; the 80-day-old one is kept');
  const diskLeft = await prisma.endpointDiskSample.findMany({ where: { endpointId: a1.id }, select: { at: true } });
  check(diskLeft.length === 3 && !diskLeft.some((x) => x.at.getTime() < now0 - 90 * DAY), 'the 100-day-old volume sample is pruned; the rest are kept', `${diskLeft.length}`);

  section('After the roll-up the API serves the same history');
  const S2 = { ownerA: await login(ownerA.email) };
  r = await metrics(S2.ownerA, a1.id, '7d');
  const ii = r.data.series.t.indexOf(oldHours[0].hour);
  check(r.status === 200 && ii >= 0 && r.data.series.samples[ii] === oldHours[0].samples && near(r.data.series.cpu[ii], M.round1(oldHours[0].cpuAvg), 0.051), 'the rolled 60-hour-old hour is served from the roll-up (its raw rows are gone)', msg(r));
  const settled = (t) => t.filter((x) => x < M.hourStart(now0) && x > now0 - 6 * DAY);
  check(JSON.stringify(settled(r.data.series.t)) === JSON.stringify(settled(d7.series.t)), 'the same hours as before the roll-up: rolling changed storage, not the answer');
  r = await metrics(S2.ownerA, a1.id, '24h');
  check(r.status === 200 && r.data.series.t.length === inside24, '24 h still reads every raw sample inside it');
}

async function cleanup() {
  await stopApi();
  try {
    const ids = created.businesses;
    await prisma.technicianAssignment.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.endpointCommand.deleteMany({ where: { endpointId: { in: created.endpoints } } });
    await prisma.rustdeskNode.deleteMany({ where: { endpointId: { in: created.endpoints } } });
    await prisma.endpoint.deleteMany({ where: { id: { in: created.endpoints } } }); // metric rows cascade
    await prisma.membership.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.customer.deleteMany({ where: { id: { in: ids } } });
    if (created.users.length) await prisma.user.deleteMany({ where: { id: { in: created.users } } });
  } catch (e) { console.error('cleanup:', e.message); }
  await prisma.$disconnect();
}

all()
  .catch((e) => { fail++; failures.push(`fatal: ${e.stack ?? e.message}`); console.error(e); })
  .finally(async () => {
    await cleanup();
    console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
    if (failures.length) { for (const f of failures) console.log(`  - ${f}`); if (api?.log) console.log(`\n── API output (last 4000 characters)\n${api.log.slice(-4000)}`); process.exit(1); }
    process.exit(0);
  });
