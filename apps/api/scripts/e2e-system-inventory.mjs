#!/usr/bin/env node
/**
 * End-to-end proof of the 0.33 system-inventory snapshots — process list,
 * full service list and network adapter details — on the diagnostics-catalog
 * path (no second command channel):
 *   - GET /endpoints/:id/diagnostics/snapshots/:key before, during and after
 *     a refresh: takenAt, the latest result, the pending refresh, the last
 *     failure;
 *   - request (POST runs with the key) → authenticated heartbeat delivery
 *     (id and key only) → running → completed, each audited;
 *   - hostile and oversized results: command lines, binary paths, profile
 *     paths, tokens, bad accounts, MACs and addresses dropped or redacted;
 *     1,500 rows cut to 1,000 and the stored result capped at 128 KB and
 *     marked truncated; an agent post over 600,000 characters refused;
 *   - capability (no computers:view → 403), access mode (a user without
 *     access to a computer → 404), and business A/B isolation (another
 *     business's computer reads as missing, and its device cannot touch
 *     these runs);
 *   - unsupported (Linux) and unbound computers refused before anything is
 *     written; the history leaves snapshot results out;
 *   - the database refuses an unknown key and a snapshot over 256 KB.
 *
 *   cd apps/api && npx nest build
 *   DATABASE_URL=postgresql://…/<name containing scratch or test> node scripts/e2e-system-inventory.mjs
 *
 * Self-starting: it runs its own API from dist/ on INV_API_PORT (3311).
 * INTEGRATION, not Windows: heartbeats and results are posted the way the
 * generated heartbeat.ps1 posts them; the PowerShell itself is exercised
 * against stubs by unit-system-inventory.mjs. Nothing here ran on Windows.
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const DB = process.env.DATABASE_URL ?? '';
const dbName = DB.split('/').pop()?.split('?')[0] ?? '';
if (!/scratch|test/.test(dbName)) { console.error(`Refusing to run against database "${dbName}": name must contain "scratch" or "test".`); process.exit(2); }
const PORT = Number(process.env.INV_API_PORT ?? 3311);
if ([3000, 3001, 4000, 4001, 443].includes(PORT)) { console.error(`Refusing port ${PORT}`); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'inventory-e2e-password-123';

let pass = 0, fail = 0;
const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;
const sha = (b) => createHash('sha256').update(b).digest('hex');

const apiEnv = {
  ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATABASE_URL: DB,
  JWT_SECRET: randomBytes(32).toString('hex'), LAUNCHER_TOKEN_SECRET: randomBytes(32).toString('hex'),
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? randomBytes(32).toString('hex'), TRUSTED_PROXIES: 'loopback', HBBS_PRESENCE_HOST: '127.0.0.2',
  VERSION_FILE: path.resolve(here, '..', '..', '..', 'version.json'), MONITOR_SWEEP: 'off', AUDIT_SEALER: 'off', CLIENT_UPDATE_SWEEP: 'off',
};
let api;
function startApi() {
  api = spawn(process.execPath, [path.join(dist, 'main.js')], { env: apiEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  api.log = ''; api.stdout.on('data', (d) => { api.log += d; }); api.stderr.on('data', (d) => { api.log += d; });
}
async function stopApi() { if (!api || api.exitCode !== null) return; await new Promise((r) => { api.once('exit', r); api.kill('SIGTERM'); }); }
async function waitUp() {
  for (let i = 0; i < 120; i++) { try { const r = await fetch(`${API}/health`); if (r.status < 500) return; } catch { /* not yet */ } await sleep(300); }
  throw new Error(`api did not come up:\n${api.log.slice(-3000)}`);
}

// Paced under the 20 req/s burst throttler.
const pace = () => new Promise((res) => setTimeout(res, 60));
async function req(method, p, { s, body, business, raw } = {}) {
  await pace();
  const h = { 'content-type': 'application/json', 'x-forwarded-for': s?.ip ?? ip() };
  if (s) h.cookie = s.cookie;
  if (business) h['x-rem0te-business'] = business;
  const r = await fetch(`${API}${p}`, { method, headers: h, body: raw ?? (body ? JSON.stringify(body) : undefined) });
  const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j, data: j?.data, size: text.length };
}
async function login(email) {
  const s = { ip: ip() };
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': s.ip }, body: JSON.stringify({ email, password: PW }) });
  const mm = (r.headers.get('set-cookie') ?? '').match(/access_token=([^;]+)/);
  if (r.status !== 200 || !mm) throw new Error(`login ${email}: ${r.status} ${await r.text()}`);
  s.cookie = `access_token=${mm[1]}`;
  return s;
}
const code = (r) => r.body?.code ?? r.body?.message?.code ?? r.body?.error?.code;
const msg = (r) => `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 400)}`;

// The agent, as heartbeat.ps1 speaks.
const heartbeat = (ep, secret = ep.secret) => req('POST', '/enrollment/heartbeat', { body: { rustdeskId: ep.rid, ...(secret ? { agentSecret: secret } : {}), hostname: ep.hostname, platform: ep.platform } });
const post = (ep, body, secret = ep.secret) => req('POST', '/enrollment/diagnostic-result', { body: { rustdeskId: ep.rid, agentSecret: secret, ...body } });

const created = { businesses: [], users: [] };
const KEYS = ['process_list', 'service_list', 'network_adapters'];
const TOKEN = 'Q'.repeat(52);

// A hostile machine's results: everything the sanitizer must drop or redact.
const hostileProcesses = (n) => ({
  processCount: n + 3, userNamesRead: true,
  processes: [
    { name: 'chrome', pid: 100, cpuSeconds: 120.5, workingSetBytes: 9e8, user: 'CORP\\alice', startedAt: '2026-11-11T08:00:00Z', commandLine: 'chrome.exe --token=hunter2', path: 'C:\\Program Files\\Google\\chrome.exe', environment: { SECRET: 'hunter2' } },
    { name: 'C:\\Users\\mallory\\AppData\\evil.exe', pid: 200, user: 'mallory; whoami', startedAt: '1970-01-01T00:00:00Z' },
    { name: `agent-${TOKEN}`, pid: 300, user: '<script>alert(1)</script>', startedAt: 'yesterday' },
    ...Array.from({ length: n }, (_, i) => ({ name: `filler${i}`, pid: 1000 + i, cpuSeconds: 0.1, workingSetBytes: 4096 + i, user: 'NT AUTHORITY\\SYSTEM', startedAt: '2026-11-11T08:00:00Z' })),
  ],
  modules: ['C:\\Windows\\System32\\ntdll.dll'],
});
const hostileServices = {
  serviceCount: 4,
  services: [
    { name: 'Spooler', displayName: 'Print Spooler', state: 'Running', startMode: 'Automatic', account: 'LocalSystem', pathName: 'C:\\Windows\\System32\\spoolsv.exe --secret hunter2' },
    { name: 'svc;rm -rf', displayName: 'x', state: 'Running', startMode: 'Automatic', account: 'LocalSystem' },
    { name: 'MSSQL$SQLEXPRESS', displayName: 'SQL (C:\\Users\\dba\\data)', state: 'Exploded', startMode: 'Sometimes', account: 'CORP\\svc-sql' },
    { name: 'gupdate', displayName: 'Google Update', state: 'Stopped', startMode: 'AutomaticDelayedStart', account: 'a"b' },
  ],
};
const hostileAdapters = {
  adapters: [
    { name: 'Intel Ethernet', connectionId: 'Ethernet', status: 'Connected', up: true, mac: '00-11-22-aa-bb-cc', speedBps: 1e9, ipv4: ['10.0.0.5', 'x; rm -rf /'], ipv6: ['fe80::1%12'], gateway: ['10.0.0.1'], dnsServers: ['10.0.0.1', '<img>'], dnsSuffix: 'corp.example.com', dhcpEnabled: true, dhcpServer: '10.0.0.1', dhcpLeaseObtainedAt: '2026-11-11T00:00:00Z', dhcpLeaseExpiresAt: '2026-11-12T00:00:00Z', wifiPassword: 'hunter2' },
    { name: 'Wi-Fi', connectionId: 'Wi-Fi', status: 'Media disconnected', up: false, mac: 'zz', speedBps: 2 ** 63, dnsSuffix: 'bad/suffix', dhcpServer: 'evil host' },
  ],
};

async function all() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });
  const roleUser = await prisma.role.findFirst({ where: { type: 'BUSINESS_USER' } });

  section('Fixtures (synthetic): Acme (Windows ×2, Linux, unbound) and Birch (Windows), owners, a viewer, a user without computers:view');
  const acme = await prisma.customer.create({ data: { tenantId: tenant.id, name: `INV Acme ${sfx}` } });
  const birch = await prisma.customer.create({ data: { tenantId: tenant.id, name: `INV Birch ${sfx}` } });
  created.businesses.push(acme.id, birch.id);
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag) => { const u = await prisma.user.create({ data: { email: `inv-${tag}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'INV', lastName: tag, status: 'ACTIVE' } }); created.users.push(u.id); return u; };
  const owen = await mkUser('owen-owner-acme'), bea = await mkUser('bea-owner-birch'), uma = await mkUser('uma-viewer-acme'), nora = await mkUser('nora-noview-acme');
  await prisma.membership.create({ data: { userId: owen.id, tenantId: tenant.id, customerId: acme.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: bea.id, tenantId: tenant.id, customerId: birch.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: uma.id, tenantId: tenant.id, customerId: acme.id, roleId: roleUser.id, capabilities: ['computers:view'] } });
  await prisma.membership.create({ data: { userId: nora.id, tenantId: tenant.id, customerId: acme.id, roleId: roleUser.id, capabilities: ['sessions:view'] } });
  const mkEp = async (biz, hostname, { platform = 'Windows', bound = true } = {}) => {
    const e = await prisma.endpoint.create({ data: { tenantId: tenant.id, customerId: biz.id, name: hostname, hostname, platform, status: 'ACTIVE', isOnline: true, isManaged: true, accessMode: 'ASSIGNED_USERS', lastSeenAt: new Date(), deviceClass: 'WORKSTATION' } });
    const rid = String(100000000 + ((Math.random() * 899999999) | 0));
    const secret = randomBytes(24).toString('hex');
    await prisma.rustdeskNode.create({ data: { tenantId: tenant.id, endpointId: e.id, rustdeskId: rid, ...(bound ? { agentSecretHash: sha(secret) } : {}) } });
    return { id: e.id, rid, secret, hostname, platform };
  };
  const pc1 = await mkEp(acme, 'FRONTDESK'), pc2 = await mkEp(acme, 'BACKOFFICE'), lin = await mkEp(acme, 'web01', { platform: 'Linux' }), old = await mkEp(acme, 'OLD-PC', { bound: false });
  const bpc = await mkEp(birch, 'FRONTDESK');
  await prisma.computerAccess.create({ data: { tenantId: tenant.id, endpointId: pc1.id, userId: uma.id } });
  await prisma.computerAccess.create({ data: { tenantId: tenant.id, endpointId: pc1.id, userId: nora.id } });

  startApi();
  await waitUp();
  const S = { owen: await login(owen.email), bea: await login(bea.email), uma: await login(uma.email), nora: await login(nora.email) };
  const snap = (s, ep, key, opts = {}) => req('GET', `/endpoints/${ep.id}/diagnostics/snapshots/${key}`, { s, ...opts });
  const ask = (s, ep, key, opts = {}) => req('POST', `/endpoints/${ep.id}/diagnostics/runs`, { s, body: { key }, ...opts });

  section('The catalog and an empty snapshot');
  let r = await req('GET', `/endpoints/${pc1.id}/diagnostics/catalog`, { s: S.owen });
  const tabs = Object.fromEntries((r.data?.items ?? []).filter((i) => i.tab).map((i) => [i.key, i.tab]));
  check(r.status === 200 && JSON.stringify(tabs) === '{"process_list":"processes","service_list":"services","network_adapters":"network"}', 'the catalog carries the three snapshot keys, each naming its tab', JSON.stringify(tabs));
  check((r.data?.items ?? []).filter((i) => i.tab).every((i) => i.risk === 'read_only' && i.approvals === 'none (read-only)' && i.capability === 'computers:view' && i.allowed), 'read-only, no approvals, computers:view, allowed to the owner');
  for (const k of KEYS) {
    r = await snap(S.owen, pc1, k);
    check(r.status === 200 && r.data?.key === k && r.data.supported === true && r.data.agentBound === true && r.data.takenAt === null && r.data.latest === null && r.data.pending === null, `${k}: never taken — takenAt null, nothing pending`, msg(r));
  }

  section('Refusals before anything is written');
  const before = await prisma.diagnosticRun.count();
  for (const k of ['top_processes', 'kill_process', 'process_list; whoami', '__proto__']) {
    r = await snap(S.owen, pc1, encodeURIComponent(k));
    check(r.status === 400 && (code(r) === 'UNKNOWN_SNAPSHOT'), `GET snapshots/${JSON.stringify(k)} is refused (UNKNOWN_SNAPSHOT)`, msg(r));
  }
  r = await req('POST', `/endpoints/${pc1.id}/diagnostics/runs`, { s: S.owen, body: { key: 'process_list', params: { kill: 1234 } } });
  check(r.status === 400, 'a refresh carrying parameters is refused: a key and nothing else', msg(r));
  r = await ask(S.owen, lin, 'process_list');
  check(r.status === 400 && code(r) === 'DIAGNOSTIC_OS_UNSUPPORTED', 'a Linux computer is refused (its agent runs nothing the console asks for)', msg(r));
  r = await snap(S.owen, lin, 'service_list');
  check(r.status === 200 && r.data?.supported === false, 'and its snapshot says unsupported', msg(r));
  r = await ask(S.owen, old, 'service_list');
  check(r.status === 409 && code(r) === 'AGENT_NOT_BOUND', 'a computer that never authenticated is refused', msg(r));

  section('Capability and access mode');
  r = await snap(S.nora, pc1, 'process_list');
  check(r.status === 403, 'without computers:view, the snapshot is refused (403)', msg(r));
  r = await ask(S.nora, pc1, 'process_list');
  check(r.status === 403, 'and so is a refresh', msg(r));
  r = await snap(S.uma, pc2, 'process_list');
  check(r.status === 404, 'a viewer without access to a computer cannot read its snapshot (404, as for a missing one)', msg(r));
  r = await ask(S.uma, pc2, 'process_list');
  check(r.status === 404, 'or refresh it', msg(r));
  r = await req('GET', `/endpoints/${pc2.id}/diagnostics/runs`, { s: S.uma });
  check(r.status === 404, 'or read its diagnostics history (0.33: the device-list visibility rule, not just business scope)', msg(r));
  r = await req('GET', `/endpoints/${pc2.id}/diagnostics/catalog`, { s: S.uma });
  check(r.status === 404, 'or its catalog', msg(r));
  r = await snap(S.owen, pc2, 'process_list');
  check(r.status === 200 && r.data?.latest === null, 'while the owner reads the same computer\'s snapshot', msg(r));

  section('Business A/B isolation');
  for (const k of KEYS) {
    r = await snap(S.bea, pc1, k);
    check(r.status === 404, `Birch cannot read Acme's ${k} (404)`, msg(r));
  }
  r = await ask(S.bea, pc1, 'process_list');
  check(r.status === 404, 'nor refresh it', msg(r));
  r = await ask(S.bea, pc1, 'process_list', { business: acme.id });
  check(r.status === 403 || r.status === 404, 'nor by naming Acme as the active business', msg(r));
  check((await prisma.diagnosticRun.count()) === before, 'none of the refusals wrote a run');

  section('Requested → delivered (authenticated heartbeat, id and key only)');
  const ids = {};
  for (const k of KEYS) {
    r = await ask(S.owen, pc1, k);
    ids[k] = r.data?.run?.id;
    check(r.status === 201 && r.data.run.status === 'REQUESTED' && r.data.deduplicated === false, `${k} is requested`, msg(r));
  }
  r = await ask(S.owen, pc1, 'process_list');
  check(r.data?.deduplicated === true && r.data.run.id === ids.process_list, 'a second Refresh while one is open returns the open one');
  r = await snap(S.owen, pc1, 'process_list');
  check(r.data?.pending?.id === ids.process_list && r.data.pending.status === 'REQUESTED' && r.data.latest === null, 'the snapshot shows the refresh pending', msg(r));
  r = await snap(S.bea, bpc, 'process_list');
  check(r.status === 200 && r.data?.pending === null && r.data.latest === null, 'Birch\'s own computer shows nothing of Acme\'s');
  r = await heartbeat(pc1, null);
  check(!(r.data?.diagnostics ?? []).length, 'a heartbeat without the device secret is handed nothing', msg(r));
  r = await heartbeat(bpc);
  check(Array.isArray(r.data?.diagnostics) && r.data.diagnostics.length === 0, 'Birch\'s computer is handed none of Acme\'s runs');
  r = await heartbeat(pc1);
  const d1 = r.data?.diagnostics ?? [];
  check(d1.length === 3 && d1.every((d) => Object.keys(d).sort().join() === 'id,key') && d1.map((d) => d.key).join() === KEYS.join(), 'pc1 is handed the three runs, as id and key only, oldest first', JSON.stringify(d1));

  section('Results: device secret, own device, own key');
  r = await post(bpc, { runId: ids.process_list, key: 'process_list', state: 'running' });
  check(r.data?.accepted === false && r.data.reason === 'unknown_run', 'Birch\'s computer cannot write into Acme\'s run', msg(r));
  r = await post(pc1, { runId: ids.process_list, key: 'process_list', state: 'running' }, randomBytes(24).toString('hex'));
  check(r.status === 401, 'a wrong device secret is refused (401)', msg(r));
  r = await post(pc1, { runId: ids.process_list, key: 'service_list', state: 'completed', result: hostileServices });
  check(r.data?.accepted === false && r.data.reason === 'key_mismatch', 'a service list filed under the process run is refused', msg(r));
  r = await post(pc1, { runId: ids.process_list, key: 'process_list', state: 'running' });
  check(r.data?.accepted === true, 'running is recorded', msg(r));
  r = await snap(S.owen, pc1, 'process_list');
  check(r.data?.pending?.status === 'RUNNING', 'and the snapshot shows it running');

  section('Hostile and oversized results are trimmed and redacted');
  r = await post(pc1, { runId: ids.process_list, key: 'process_list', state: 'completed', result: hostileProcesses(1500) });
  let row = await prisma.diagnosticRun.findUnique({ where: { id: ids.process_list } });
  const pj = JSON.stringify(row.result);
  check(r.data?.accepted === true && row.status === 'COMPLETED', 'process_list completes', msg(r));
  check(!/hunter2|Program Files|commandLine|environment|modules|ntdll|mallory|<script>/.test(pj) && !pj.includes(TOKEN), 'no command line, path, environment, module, profile name, markup or token is stored', pj.match(/.{30}(hunter2|Program Files|mallory|<script>|QQQQ).{20}/)?.[0]);
  const procs = row.result.processes;
  check(procs[0].name === 'chrome' && procs[0].user === 'CORP\\alice' && procs[1].name === 'evil.exe' && procs[1].user === null && procs[1].startedAt === null && procs[2].user === null && procs[2].name.includes('[redacted]'), 'a path is cut to its file name; bad users and dates dropped; the token redacted', JSON.stringify(procs.slice(0, 3)));
  check(row.resultBytes <= 131_072 && row.truncated === true && procs.length < 1000 && procs.length >= 400 && row.result.processCount === 1503, '1,503 rows → at most 1,000 kept, then cut to fit 128 KB and marked truncated', `${procs.length} rows, ${row.resultBytes} bytes`);
  const [{ n: octets }] = await prisma.$queryRawUnsafe(`SELECT octet_length("result"::text) AS n FROM "DiagnosticRun" WHERE id = $1`, ids.process_list);
  check(Number(octets) <= 262_144, 'and the stored jsonb is inside the database backstop', String(octets));

  r = await post(pc1, { runId: ids.service_list, key: 'service_list', state: 'completed', result: hostileServices });
  row = await prisma.diagnosticRun.findUnique({ where: { id: ids.service_list } });
  const sv = Object.fromEntries((row.result.services ?? []).map((s) => [s.name, s]));
  check(r.data?.accepted === true && row.status === 'COMPLETED' && !/spoolsv|hunter2|pathName|dba/.test(JSON.stringify(row.result)), 'service_list completes with no binary path, argument or profile name', JSON.stringify(row.result).slice(0, 300));
  check(Object.keys(sv).sort().join() === 'MSSQL$SQLEXPRESS,Spooler,gupdate' && sv.Spooler.account === 'LocalSystem' && sv.MSSQL$SQLEXPRESS.account === 'CORP\\svc-sql' && sv.gupdate.account === null, 'a bad service name dropped; accounts kept or dropped by charset', JSON.stringify(sv));
  check(sv.MSSQL$SQLEXPRESS.state === 'Unknown' && sv.MSSQL$SQLEXPRESS.startMode === 'Unknown' && sv.gupdate.startMode === 'AutomaticDelayedStart', 'states and start modes from a fixed list');

  r = await post(pc1, { runId: ids.network_adapters, key: 'network_adapters', state: 'completed', result: hostileAdapters });
  row = await prisma.diagnosticRun.findUnique({ where: { id: ids.network_adapters } });
  const [eth, wifi] = row.result.adapters ?? [];
  check(r.data?.accepted === true && eth?.mac === '00:11:22:AA:BB:CC' && wifi?.mac === null && JSON.stringify(eth.ipv4) === '["10.0.0.5"]' && JSON.stringify(eth.dnsServers) === '["10.0.0.1"]', 'network_adapters: MAC normalised, non-addresses dropped', JSON.stringify(row.result).slice(0, 300));
  check(eth.dhcpServer === '10.0.0.1' && !!eth.dhcpLeaseExpiresAt && eth.dnsSuffix === 'corp.example.com' && wifi.dnsSuffix === null && wifi.dhcpServer === null && wifi.speedBps === null && !('wifiPassword' in eth), 'DHCP, DNS suffix and speed checked; unknown fields dropped');

  section('The snapshot after: when, how old, what');
  for (const k of KEYS) {
    r = await snap(S.owen, pc1, k);
    check(r.status === 200 && !!r.data?.takenAt && r.data.latest?.id === ids[k] && r.data.latest.status === 'COMPLETED' && r.data.pending === null && r.data.lastFailure === null && !!r.data.latest.result, `${k}: takenAt set, the result shown, nothing pending`, msg(r).slice(0, 300));
  }
  r = await snap(S.uma, pc1, 'process_list');
  check(r.status === 200 && r.data?.latest?.result?.processes?.length > 0, 'a viewer with access to the computer reads it too');
  r = await req('GET', `/endpoints/${pc1.id}/diagnostics/runs`, { s: S.owen });
  const hist = (r.data ?? []).filter((h) => KEYS.includes(h.key));
  check(r.status === 200 && hist.length === 3 && hist.every((h) => h.result === null && h.resultOnTab === true) && r.size < 20_000, 'the run history lists the snapshots without their results (they are on the tabs)', `${hist.length} rows, ${r.size} bytes`);

  section('Refresh: a newer result replaces it; a failure is shown beside the old one');
  r = await ask(S.uma, pc1, 'process_list');
  const second = r.data?.run?.id;
  check(r.status === 201 && second && second !== ids.process_list, 'the viewer asks for a fresh process list', msg(r));
  r = await snap(S.owen, pc1, 'process_list');
  check(r.data?.latest?.id === ids.process_list && r.data.pending?.id === second, 'while it is pending the old snapshot stays, with the refresh beside it');
  await heartbeat(pc1);
  // Over the agent's own 600,000-character cap: the server refuses it as well.
  await post(pc1, { runId: second, key: 'process_list', state: 'completed', result: { processCount: 1, processes: [{ name: 'x', pid: 1, user: 'y'.repeat(700_000) }] } });
  row = await prisma.diagnosticRun.findUnique({ where: { id: second } });
  check(row.status === 'FAILED' && /too large/.test(row.error) && row.result === null, 'a result over 600,000 characters is not stored; the run fails saying why', JSON.stringify({ status: row.status, error: row.error }));
  r = await snap(S.owen, pc1, 'process_list');
  check(r.data?.latest?.id === ids.process_list && r.data.lastFailure?.id === second && r.data.pending === null, 'the snapshot keeps the last good result and shows the failed refresh', msg(r).slice(0, 300));
  r = await ask(S.owen, pc1, 'process_list');
  const third = r.data?.run?.id;
  await heartbeat(pc1);
  await post(pc1, { runId: third, key: 'process_list', state: 'completed', result: { processCount: 1, userNamesRead: false, processes: [{ name: 'explorer', pid: 4242, cpuSeconds: 3, workingSetBytes: 1e8, startedAt: '2026-11-11T09:00:00Z' }] } });
  r = await snap(S.owen, pc1, 'process_list');
  check(r.data?.latest?.id === third && r.data.latest.result.processes.length === 1 && r.data.latest.result.userNamesRead === false && r.data.lastFailure === null && !r.data.latest.truncated, 'a newer result becomes the snapshot (and the failure is no longer shown)', msg(r).slice(0, 300));

  section('Database backstop');
  let refused = false;
  try { await prisma.diagnosticRun.create({ data: { endpointId: pc1.id, key: 'kill_process', requestedById: owen.id, expiresAt: new Date() } }); } catch (e) { refused = /DiagnosticRun_key_catalog/.test(String(e.message)); }
  check(refused, 'the database refuses a key outside the catalog');
  refused = false;
  try { await prisma.diagnosticRun.create({ data: { endpointId: pc1.id, key: 'process_list', requestedById: owen.id, expiresAt: new Date(), result: { blob: 'x'.repeat(270_000) } } }); } catch (e) { refused = /DiagnosticRun_result_bounded/.test(String(e.message)); }
  check(refused, 'and a snapshot over 256 KB');
  refused = false;
  try { await prisma.diagnosticRun.create({ data: { endpointId: pc1.id, key: 'top_processes', requestedById: owen.id, expiresAt: new Date(), result: { blob: 'x'.repeat(100_000) } } }); } catch (e) { refused = /DiagnosticRun_result_bounded/.test(String(e.message)); }
  check(refused, 'while every other key keeps its 64 KB backstop');
  const within = await prisma.diagnosticRun.create({ data: { endpointId: pc1.id, key: 'service_list', requestedById: owen.id, expiresAt: new Date(), status: 'FAILED', result: { blob: 'x'.repeat(100_000) } } }).catch(() => null);
  if (within) await prisma.diagnosticRun.delete({ where: { id: within.id } });
  check(!!within, 'a 100 KB snapshot is within its backstop');

  section('Audit');
  const audit = await prisma.activityLog.findMany({ where: { customerId: acme.id, action: { in: ['ENDPOINT_DIAGNOSTIC_REQUESTED', 'ENDPOINT_DIAGNOSTIC_COMPLETED'] } } });
  const reqd = audit.filter((a) => a.action === 'ENDPOINT_DIAGNOSTIC_REQUESTED');
  check(reqd.length === 5 && reqd.every((a) => a.actorId && KEYS.includes(a.metadata.key) && a.metadata.risk === 'read_only'), 'each refresh is audited once with who and which key (deduplicated clicks are not)', `${reqd.length} requested`);
  const outcomes = audit.filter((a) => a.action === 'ENDPOINT_DIAGNOSTIC_COMPLETED').map((a) => `${a.metadata.key}:${a.metadata.outcome}`).sort();
  check(JSON.stringify(outcomes) === JSON.stringify(['network_adapters:completed', 'process_list:completed', 'process_list:completed', 'process_list:failed', 'service_list:completed']), 'each completion and failure is audited', JSON.stringify(outcomes));
  const big = audit.find((a) => a.action === 'ENDPOINT_DIAGNOSTIC_COMPLETED' && a.metadata.runId === ids.process_list);
  check(big?.metadata.truncated === true && big.metadata.resultBytes <= 131_072, 'the audit records the size and that it was truncated');
  check(!audit.some((a) => /alice|hunter2|svc-sql|10\.0\.0\.5|explorer/.test(JSON.stringify(a.metadata))), 'no result content in the audit trail');
}

async function cleanup() {
  await stopApi();
  try {
    const ids = created.businesses;
    const eps = await prisma.endpoint.findMany({ where: { customerId: { in: ids } }, select: { id: true } });
    await prisma.diagnosticRun.deleteMany({ where: { endpointId: { in: eps.map((e) => e.id) } } });
    await prisma.computerAccess.deleteMany({ where: { endpointId: { in: eps.map((e) => e.id) } } });
    await prisma.rustdeskNode.deleteMany({ where: { endpointId: { in: eps.map((e) => e.id) } } });
    await prisma.endpoint.deleteMany({ where: { id: { in: eps.map((e) => e.id) } } });
    await prisma.membership.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.customer.deleteMany({ where: { id: { in: ids } } });
    if (created.users.length) await prisma.user.deleteMany({ where: { id: { in: created.users } } });
  } catch (e) { console.error('cleanup:', e.message); }
  await prisma.$disconnect();
}

all().catch((e) => { fail++; failures.push(`crashed: ${e.stack ?? e}`); console.error(e); if (api) console.error(api.log.slice(-3000)); })
  .finally(async () => {
    await cleanup();
    console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
    if (failures.length) { for (const f of failures) console.log(`  - ${f}`); if (api?.log) console.log(`\n── API output (last 6000 characters)\n${api.log.slice(-6000)}`); process.exit(1); }
    process.exit(0);
  });
