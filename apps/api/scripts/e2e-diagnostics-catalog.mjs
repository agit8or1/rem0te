#!/usr/bin/env node
/**
 * End-to-end proof of the one-click read-only diagnostics catalog (v0.31):
 *   - the catalog served per computer, with what each person may run;
 *   - unknown keys, extra parameters, the wrong OS and an unbound agent are
 *     refused before anything is written;
 *   - another business's computer is indistinguishable from a missing one;
 *   - requested → delivered (authenticated heartbeat only, keys only) →
 *     running → completed / failed, timestamps and requester recorded;
 *   - results only through the device secret, only for this device's runs,
 *     only under the run's own key; sanitised, redacted and size-capped;
 *   - refresh_inventory and pending_updates feed the existing inventory;
 *   - a result withheld from someone without the key's capability;
 *   - expiry when the computer does not pick a run up (offline) or never
 *     starts it (old agent), re-authorization at delivery, rate limits per
 *     device and per user, and the audit trail.
 *
 *   cd apps/api && npx nest build
 *   DATABASE_URL=postgresql://…/<name containing scratch or test> node scripts/e2e-diagnostics-catalog.mjs
 *
 * INTEGRATION, not Windows: the real API and database, with heartbeats and
 * results posted the way the generated heartbeat.ps1 posts them. The
 * PowerShell side is exercised against stubs by unit-diagnostics-catalog.mjs.
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
const PORT = Number(process.env.DIAG_API_PORT ?? 3231);
if ([3000, 3001, 4000, 4001, 443].includes(PORT)) { console.error(`Refusing port ${PORT}`); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'diagnostics-e2e-password-123';

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
  VERSION_FILE: path.resolve(here, '..', '..', '..', 'version.json'), MONITOR_SWEEP: 'off', AUDIT_SEALER: 'off',
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

// The API's burst throttler allows 20 requests a second per address, and a
// signed-in session keeps one address. CI's runner is fast enough to cross it
// (a ThrottlerException 429 crashed this suite there), so pace every call.
const pace = () => new Promise((res) => setTimeout(res, 60));
async function req(method, p, { s, body, business } = {}) {
  await pace();
  const h = { 'content-type': 'application/json', 'x-forwarded-for': s?.ip ?? ip() };
  if (s) h.cookie = s.cookie;
  if (business) h['x-rem0te-business'] = business;
  const r = await fetch(`${API}${p}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j, data: j?.data };
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
const heartbeat = (ep, secret = ep.secret) => req('POST', '/enrollment/heartbeat', { body: { rustdeskId: ep.rid, ...(secret ? { agentSecret: secret } : {}), hostname: ep.hostname, platform: 'Windows' } });
const post = (ep, body, secret = ep.secret) => req('POST', '/enrollment/diagnostic-result', { body: { rustdeskId: ep.rid, agentSecret: secret, ...body } });

const created = { businesses: [], users: [] };

async function all() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });
  const roleUser = await prisma.role.findFirst({ where: { type: 'BUSINESS_USER' } });

  section('Fixtures (synthetic): Acme (four computers) and Birch (one), owners, and a view-only user');
  const acme = await prisma.customer.create({ data: { tenantId: tenant.id, name: `DG Acme ${sfx}` } });
  const birch = await prisma.customer.create({ data: { tenantId: tenant.id, name: `DG Birch ${sfx}` } });
  created.businesses.push(acme.id, birch.id);
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag) => { const u = await prisma.user.create({ data: { email: `dg-${tag}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'DG', lastName: tag, status: 'ACTIVE' } }); created.users.push(u.id); return u; };
  const owen = await mkUser('owen-owner-acme'), bea = await mkUser('bea-owner-birch'), uma = await mkUser('uma-viewer-acme');
  await prisma.membership.create({ data: { userId: owen.id, tenantId: tenant.id, customerId: acme.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: bea.id, tenantId: tenant.id, customerId: birch.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: uma.id, tenantId: tenant.id, customerId: acme.id, roleId: roleUser.id, capabilities: ['computers:view'] } });
  const mkEp = async (biz, hostname, { platform = 'Windows', bound = true } = {}) => {
    const e = await prisma.endpoint.create({ data: { tenantId: tenant.id, customerId: biz.id, name: hostname, hostname, platform, status: 'ACTIVE', isOnline: true, isManaged: true, accessMode: 'ASSIGNED_USERS', lastSeenAt: new Date(), deviceClass: 'WORKSTATION' } });
    const rid = String(100000000 + ((Math.random() * 899999999) | 0));
    const secret = randomBytes(24).toString('hex');
    await prisma.rustdeskNode.create({ data: { tenantId: tenant.id, endpointId: e.id, rustdeskId: rid, ...(bound ? { agentSecretHash: sha(secret) } : {}) } });
    return { id: e.id, rid, secret, hostname };
  };
  const pc1 = await mkEp(acme, 'FRONTDESK'), pc2 = await mkEp(acme, 'BACKOFFICE'), mac = await mkEp(acme, 'DESIGN-MAC', { platform: 'macOS' }), old = await mkEp(acme, 'OLD-PC', { bound: false });
  const bpc = await mkEp(birch, 'FRONTDESK');
  await prisma.computerAccess.create({ data: { tenantId: tenant.id, endpointId: pc1.id, userId: uma.id } });

  startApi();
  await waitUp();
  const S = { owen: await login(owen.email), bea: await login(bea.email), uma: await login(uma.email) };
  const runs = (ep) => prisma.diagnosticRun.findMany({ where: { endpointId: ep.id }, orderBy: { requestedAt: 'asc' } });

  section('The catalog');
  let r = await req('GET', `/endpoints/${pc1.id}/diagnostics/catalog`, { s: S.owen });
  const keys = r.data?.items?.map((i) => i.key) ?? [];
  check(r.status === 200 && keys.length === 9 && keys.includes('recent_system_errors') && r.data.supported === true && r.data.agentBound === true, 'the owner is served nine catalog entries for a bound Windows computer', msg(r));
  check(r.data?.items?.every((i) => i.risk === 'read_only' && i.expectedImpact === 'none' && i.approvals === 'none (read-only)' && i.allowed), 'every entry is read-only, no impact, no approvals, and all are allowed to the owner');
  r = await req('GET', `/endpoints/${pc1.id}/diagnostics/catalog`, { s: S.uma });
  const umaAllowed = Object.fromEntries((r.data?.items ?? []).map((i) => [i.key, i.allowed]));
  check(r.status === 200 && umaAllowed.recent_system_errors === false && umaAllowed.disk_space === true, 'a view-only user may run everything except recent_system_errors (event-log text)', JSON.stringify(umaAllowed));
  r = await req('GET', `/endpoints/${mac.id}/diagnostics/catalog`, { s: S.owen });
  check(r.data?.supported === false, 'a Mac is marked unsupported');

  section('Refusals before anything is written');
  const before = await prisma.diagnosticRun.count();
  r = await req('POST', `/endpoints/${pc1.id}/diagnostics/runs`, { s: S.owen, body: { key: 'run_script' } });
  check(r.status === 400 && code(r) === 'UNKNOWN_DIAGNOSTIC', 'an unknown key is refused (UNKNOWN_DIAGNOSTIC)', msg(r));
  for (const k of ['__proto__', 'Disk_Space', 'disk_space; whoami', '']) {
    r = await req('POST', `/endpoints/${pc1.id}/diagnostics/runs`, { s: S.owen, body: { key: k } });
    check(r.status === 400, `a malformed key ${JSON.stringify(k)} is refused`, msg(r));
  }
  r = await req('POST', `/endpoints/${pc1.id}/diagnostics/runs`, { s: S.owen, body: { key: 'disk_space', params: { command: 'whoami' } } });
  check(r.status === 400, 'a request with parameters is refused: a key and nothing else', msg(r));
  r = await req('POST', `/endpoints/${mac.id}/diagnostics/runs`, { s: S.owen, body: { key: 'disk_space' } });
  check(r.status === 400 && code(r) === 'DIAGNOSTIC_OS_UNSUPPORTED', 'a Mac is refused', msg(r));
  r = await req('POST', `/endpoints/${old.id}/diagnostics/runs`, { s: S.owen, body: { key: 'disk_space' } });
  check(r.status === 409 && code(r) === 'AGENT_NOT_BOUND', 'a computer that never authenticated is refused, with the reason', msg(r));
  r = await req('POST', `/endpoints/${pc1.id}/diagnostics/runs`, { s: S.uma, body: { key: 'recent_system_errors' } });
  check(r.status === 403, 'a view-only user cannot run recent_system_errors', msg(r));
  check((await prisma.diagnosticRun.count()) === before, 'none of those wrote a run');

  section('Cross-business: Birch\'s owner and Acme\'s computer');
  r = await req('POST', `/endpoints/${pc1.id}/diagnostics/runs`, { s: S.bea, body: { key: 'disk_space' } });
  check(r.status === 404, 'Birch cannot run a diagnostic on Acme\'s computer (404, as for a missing one)', msg(r));
  r = await req('POST', `/endpoints/${pc1.id}/diagnostics/runs`, { s: S.bea, business: acme.id, body: { key: 'disk_space' } });
  check(r.status === 403 || r.status === 404, 'nor by naming Acme as the active business', msg(r));
  r = await req('GET', `/endpoints/${pc1.id}/diagnostics/catalog`, { s: S.bea });
  check(r.status === 404, 'nor read its catalog', msg(r));
  check((await prisma.diagnosticRun.count()) === before, 'still nothing written');

  section('Requested');
  const ask = async (s, ep, key) => req('POST', `/endpoints/${ep.id}/diagnostics/runs`, { s, body: { key } });
  r = await ask(S.owen, pc1, 'disk_space');
  const diskRun = r.data?.run;
  check(r.status === 201 && diskRun?.status === 'REQUESTED' && diskRun.requestedBy?.id === owen.id && !!diskRun.requestedAt && !!diskRun.expiresAt, 'disk_space is REQUESTED, with the requester and an expiry', msg(r));
  r = await ask(S.owen, pc1, 'disk_space');
  check(r.data?.deduplicated === true && r.data.run.id === diskRun.id, 'a second click returns the open run instead of a new one');
  const ids = { disk_space: diskRun.id };
  for (const k of ['network_connectivity', 'recent_system_errors', 'reboot_status', 'service_health', 'top_processes', 'dns_resolution', 'refresh_inventory', 'pending_updates']) {
    r = await ask(S.owen, pc1, k);
    ids[k] = r.data?.run?.id;
  }
  check(Object.values(ids).every(Boolean), 'all nine are requested', JSON.stringify(ids));
  r = await req('GET', `/endpoints/${pc1.id}/diagnostics/runs`, { s: S.bea });
  check(r.status === 404, 'Birch cannot read Acme\'s run history');
  r = await req('GET', `/endpoints/${pc1.id}/diagnostics/runs/${ids.disk_space}`, { s: S.bea });
  check(r.status === 404, 'or one of its runs by id');
  r = await req('GET', `/endpoints/${bpc.id}/diagnostics/runs/${ids.disk_space}`, { s: S.bea });
  check(r.status === 404, 'or reach it through Birch\'s own computer id');

  section('Delivered: authenticated heartbeats only, keys only');
  r = await heartbeat(pc1, null);
  check((r.status === 401 || r.status === 200) && !r.data?.diagnostics?.length, 'a heartbeat without the device secret is handed nothing (a bound computer must authenticate: 401)', msg(r));
  r = await heartbeat(pc1, randomBytes(24).toString('hex'));
  check(!r.data?.diagnostics?.length, 'nor is one with the wrong secret');
  r = await heartbeat(bpc);
  check(Array.isArray(r.data?.diagnostics) && r.data.diagnostics.length === 0, 'Birch\'s computer is handed none of Acme\'s runs');
  r = await heartbeat(pc1);
  const d1 = r.data?.diagnostics ?? [];
  check(d1.length === 3 && d1.every((d) => Object.keys(d).sort().join() === 'id,key'), 'the device is handed three runs per beat, as id and key and nothing else', JSON.stringify(d1));
  check(d1.map((d) => d.key).join() === 'disk_space,network_connectivity,recent_system_errors', 'oldest first', JSON.stringify(d1));
  const row = await prisma.diagnosticRun.findUnique({ where: { id: ids.disk_space } });
  check(row.status === 'DELIVERED' && !!row.deliveredAt && row.dispatchCount === 1, 'and they are DELIVERED with a timestamp');
  r = await heartbeat(pc1);
  check((r.data?.diagnostics ?? []).length === 3 && r.data.diagnostics[0].key === 'reboot_status', 'the next beat hands out the next three, not the same ones again', JSON.stringify(r.data?.diagnostics));

  section('Running → completed: device secret, own device, own key');
  r = await post(pc1, { runId: ids.disk_space, key: 'disk_space', state: 'running' }, randomBytes(24).toString('hex'));
  check(r.status === 401, 'a result with the wrong device secret is refused (401)', msg(r));
  r = await post(bpc, { runId: ids.disk_space, key: 'disk_space', state: 'running' });
  check(r.data?.accepted === false && r.data.reason === 'unknown_run', 'Birch\'s computer cannot touch Acme\'s run', msg(r));
  r = await post(pc1, { runId: ids.disk_space, key: 'reboot_status', state: 'running' });
  check(r.data?.accepted === false && r.data.reason === 'key_mismatch', 'a result under another key is refused', msg(r));
  r = await post(pc1, { runId: ids.disk_space, key: 'run_script', state: 'running' });
  check(r.data?.accepted === false && r.data.reason === 'unknown_key', 'a result under a non-catalog key is refused', msg(r));
  r = await post(pc1, { runId: ids.disk_space, key: 'disk_space', state: 'running' });
  check(r.data?.accepted === true && (await prisma.diagnosticRun.findUnique({ where: { id: ids.disk_space } })).status === 'RUNNING', 'running is recorded', msg(r));
  r = await post(pc1, { runId: ids.disk_space, key: 'disk_space', state: 'completed', result: { disks: [{ drive: 'C:', label: 'C:\\Users\\alice\\stuff', fsType: 'NTFS', totalBytes: 500e9, freeBytes: 25e9, secret: 'x' }], shell: 'whoami' } });
  let done = await prisma.diagnosticRun.findUnique({ where: { id: ids.disk_space } });
  check(r.data?.accepted === true && done.status === 'COMPLETED' && !!done.startedAt && !!done.completedAt && done.resultBytes > 0 && done.resultBytes <= 32768, 'completed, with timestamps and a stored size', JSON.stringify(done));
  check(done.result.disks[0].percentFree === 5 && !('secret' in done.result.disks[0]) && !('shell' in done.result) && done.result.disks[0].label === '%USERPROFILE%\\stuff', 'the result is sanitised: unknown fields dropped, profile path redacted, percentage computed', JSON.stringify(done.result));
  r = await post(pc1, { runId: ids.disk_space, key: 'disk_space', state: 'completed', result: { disks: [] } });
  check(r.data?.accepted === false && /already_completed/.test(r.data.reason), 'a completed run cannot be overwritten', msg(r));

  const groups = Array.from({ length: 80 }, (_, i) => ({ log: 'System', provider: 'P'.repeat(200), eventId: i, level: 2, count: 5, firstAt: '2026-11-10T00:00:00Z', lastAt: '2026-11-11T00:00:00Z', message: 'word '.repeat(400) + 'C:\\Users\\bob\\file' }));
  await post(pc1, { runId: ids.recent_system_errors, key: 'recent_system_errors', state: 'running' });
  r = await post(pc1, { runId: ids.recent_system_errors, key: 'recent_system_errors', state: 'completed', result: { scanned: 400, capped: false, groups } });
  done = await prisma.diagnosticRun.findUnique({ where: { id: ids.recent_system_errors } });
  check(r.data?.accepted === true && done.status === 'COMPLETED' && done.result.groups.length === 50 && done.result.groups.every((g) => g.message.length <= 300 && g.provider.length <= 128) && done.resultBytes <= 32768, 'an oversized error report is bounded: 50 groups, 300-character messages, 32 KB', `${done.result.groups.length} groups, ${done.resultBytes} bytes`);
  r = await post(pc1, { runId: ids.network_connectivity, key: 'network_connectivity', state: 'completed', result: { target: { host: 'portal.example.com', port: 443, reachable: true, latencyMs: 22 }, adapters: [{ name: 'Ethernet', up: true, status: 'Connected', ipv4: ['10.0.0.5'] }] } });
  done = await prisma.diagnosticRun.findUnique({ where: { id: ids.network_connectivity } });
  check(r.data?.accepted === true && done.status === 'COMPLETED' && done.result.target.reachable === true, 'a result may arrive without a separate running report (from DELIVERED)');
  await post(pc1, { runId: ids.reboot_status, key: 'reboot_status', state: 'running' });
  r = await post(pc1, { runId: ids.reboot_status, key: 'reboot_status', state: 'failed', error: 'Access denied\u0000 reading the registry' });
  done = await prisma.diagnosticRun.findUnique({ where: { id: ids.reboot_status } });
  check(r.data?.accepted === true && done.status === 'FAILED' && done.error === 'Access denied  reading the registry', 'a failure is recorded with its (cleaned) error', JSON.stringify(done.error));
  r = await post(pc1, { runId: ids.service_health, key: 'service_health', state: 'completed', result: { totalServices: 200, stoppedAutomatic: [{ name: 'gupdate', status: 'Stopped', startType: 'Automatic' }], monitored: [{ name: 'Spooler', status: 'Stopped', startType: 'Automatic' }] } });
  done = await prisma.diagnosticRun.findUnique({ where: { id: ids.service_health } });
  check(r.data?.accepted === true && done.status === 'COMPLETED' && done.result.stoppedAutomatic.length === 1 && done.result.monitored.length === 0, 'service_health keeps only monitored services this server asked about (none here)', JSON.stringify(done.result));
  await post(pc1, { runId: ids.top_processes, key: 'top_processes', state: 'completed', result: { processCount: 2, byCpu: [{ name: 'chrome', pid: 1, cpuSeconds: 10, workingSetBytes: 5, commandLine: '--token=abc' }], byMemory: [] } });
  done = await prisma.diagnosticRun.findUnique({ where: { id: ids.top_processes } });
  check(done.status === 'COMPLETED' && !JSON.stringify(done.result).includes('token'), 'top_processes never stores a command line');

  section('refresh_inventory and pending_updates reuse the inventory');
  r = await heartbeat(pc1);
  const d3 = (r.data?.diagnostics ?? []).map((d) => d.key);
  check(d3.join() === 'dns_resolution,refresh_inventory,pending_updates', 'the last three are handed out', d3.join());
  await post(pc1, { runId: ids.refresh_inventory, key: 'refresh_inventory', state: 'completed', result: { inventory: { osCaption: 'Microsoft Windows 11 Pro', osBuild: '26100', disks: [{ drive: 'C:', totalBytes: 1, freeBytes: 1 }], networks: [], software: [{ name: '7-Zip' }] } } });
  await post(pc1, { runId: ids.pending_updates, key: 'pending_updates', state: 'completed', result: { updates: { pending: [{ title: '2026-11 Cumulative Update (KB5000001)', kb: 'KB5000001', severity: 'Critical', sizeBytes: 100 }], rebootRequired: true } } });
  const inv = await prisma.endpointInventory.findUnique({ where: { endpointId: pc1.id } });
  check(inv?.osBuild === '26100' && !!inv.collectedAt && inv.pendingUpdateCount === 1 && inv.rebootRequired === true && !!inv.updatesCheckedAt, 'the stored inventory and update scan are updated', JSON.stringify({ osBuild: inv?.osBuild, pending: inv?.pendingUpdateCount }));
  done = await prisma.diagnosticRun.findUnique({ where: { id: ids.refresh_inventory } });
  check(done.result.collected === true && done.result.software === 1 && !('inventory' in done.result), 'and the run keeps a summary, not the whole inventory', JSON.stringify(done.result));
  check((await prisma.diagnosticRun.findUnique({ where: { id: ids.pending_updates } })).result.pending[0].kb === 'KB5000001', 'pending_updates keeps the list');

  section('Reading results');
  r = await req('GET', `/endpoints/${pc1.id}/diagnostics/runs`, { s: S.owen });
  const hist = r.data ?? [];
  check(r.status === 200 && hist.length === 9 && hist[0].requestedBy?.name, 'the owner sees nine runs with who asked', msg(r));
  const ownErr = hist.find((h) => h.key === 'recent_system_errors');
  check(ownErr?.result?.groups?.length === 50, 'and the event-log result');
  r = await req('GET', `/endpoints/${pc1.id}/diagnostics/runs`, { s: S.uma });
  const umaErr = (r.data ?? []).find((h) => h.key === 'recent_system_errors');
  check(r.status === 200 && umaErr && umaErr.result === null && umaErr.resultWithheld === true, 'a view-only user sees that recent_system_errors ran, not what it said', JSON.stringify(umaErr).slice(0, 200));
  check((r.data ?? []).find((h) => h.key === 'disk_space')?.result?.disks?.length === 1, 'but does see disk_space');
  r = await req('GET', `/endpoints/${pc1.id}/diagnostics/runs/${ids.recent_system_errors}`, { s: S.uma });
  check(r.status === 200 && r.data?.result === null && r.data.resultWithheld, 'including when asked by id');

  section('Expiry: offline, and an agent that predates the catalog');
  r = await ask(S.owen, pc2, 'disk_space');
  const offRun = r.data?.run?.id;
  await prisma.diagnosticRun.update({ where: { id: offRun }, data: { requestedAt: new Date(Date.now() - 20 * 60_000), expiresAt: new Date(Date.now() - 5 * 60_000) } });
  r = await req('GET', `/endpoints/${pc2.id}/diagnostics/runs/${offRun}`, { s: S.owen });
  check(r.data?.status === 'EXPIRED' && /did not check in/.test(r.data.error) && /offline/.test(r.data.error), 'a run nobody picked up expires, saying the computer did not check in (offline)', msg(r));
  r = await ask(S.owen, pc2, 'disk_space');
  check(r.data?.deduplicated === false && r.data?.run?.id && r.data.run.id !== offRun, 'and asking again makes a new run', msg(r));
  const oldAgentRun = r.data?.run?.id;
  await heartbeat(pc2);
  await prisma.diagnosticRun.update({ where: { id: oldAgentRun }, data: { deliveredAt: new Date(Date.now() - 11 * 60_000) } });
  r = await req('GET', `/endpoints/${pc2.id}/diagnostics/runs/${oldAgentRun}`, { s: S.owen });
  check(r.data?.status === 'EXPIRED' && /never started/.test(r.data.error) && /predates/.test(r.data.error), 'a run delivered but never started expires, naming the likely cause (old agent)', msg(r));
  r = await ask(S.owen, pc2, 'top_processes');
  if (!r.data?.run?.id) throw new Error(`asking pc2 for top_processes returned no run: ${msg(r)}`);
  const stuck = r.data.run.id;
  await heartbeat(pc2);
  await post(pc2, { runId: stuck, key: 'top_processes', state: 'running' });
  await prisma.diagnosticRun.update({ where: { id: stuck }, data: { startedAt: new Date(Date.now() - 6 * 60_000) } });
  r = await req('GET', `/endpoints/${pc2.id}/diagnostics/runs/${stuck}`, { s: S.owen });
  check(r.data?.status === 'EXPIRED' && /no result arrived within 5 minutes/.test(r.data.error), 'a run that started and went quiet expires after its duration category allows', msg(r));
  r = await post(pc2, { runId: stuck, key: 'top_processes', state: 'completed', result: { processCount: 1, byCpu: [], byMemory: [] } });
  check(r.data?.accepted === false, 'a late result for an expired run is refused');

  section('Re-authorized at delivery');
  r = await ask(S.uma, pc1, 'reboot_status');
  const umaRun = r.data?.run?.id;
  check(r.status === 201 && !!umaRun, 'the view-only user requests reboot_status on her assigned computer', msg(r));
  await prisma.computerAccess.deleteMany({ where: { endpointId: pc1.id, userId: uma.id } });
  r = await heartbeat(pc1);
  const lost = await prisma.diagnosticRun.findUnique({ where: { id: umaRun } });
  check(!(r.data?.diagnostics ?? []).some((d) => d.id === umaRun) && lost.status === 'FAILED' && /no longer allowed/.test(lost.error), 'her access is removed before the beat: the run is not delivered, and says why', JSON.stringify({ status: lost.status, error: lost.error }));

  section('Rate limits');
  const filler = (endpointId, requestedById, n) => prisma.diagnosticRun.createMany({ data: Array.from({ length: n }, () => ({ endpointId, tenantId: tenant.id, customerId: acme.id, key: 'disk_space', status: 'COMPLETED', requestedById, expiresAt: new Date(), completedAt: new Date() })) });
  await filler(pc2.id, owen.id, 20);
  r = await ask(S.owen, pc2, 'reboot_status');
  check(r.status === 429 && code(r) === 'DIAGNOSTIC_RATE_LIMITED' && /^This computer has had/.test(r.body?.message), 'twenty runs on one computer in ten minutes: the next is refused (per device)', msg(r));
  await prisma.computerAccess.create({ data: { tenantId: tenant.id, endpointId: pc1.id, userId: uma.id } });
  await filler(mac.id, uma.id, 40);
  r = await ask(S.uma, pc1, 'top_processes');
  check(r.status === 429 && /^You have run/.test(r.body?.message), 'forty runs by one person in ten minutes: the next is refused (per user)', msg(r));
  r = await ask(S.owen, pc1, 'top_processes');
  check(r.status === 201, 'while someone else can still run one on the same computer', msg(r));
  await prisma.diagnosticRun.deleteMany({ where: { status: 'COMPLETED', requestedAt: { gte: new Date(Date.now() - 60 * 60_000) }, endpointId: { in: [pc2.id, mac.id] }, resultBytes: null } });
  check((await prisma.diagnosticRun.count({ where: { endpointId: pc2.id, status: 'COMPLETED' } })) === 0, 'cleanup of the filler rows');

  section('Database backstop');
  let refused = false;
  try { await prisma.diagnosticRun.create({ data: { endpointId: pc1.id, key: 'run_script', requestedById: owen.id, expiresAt: new Date() } }); } catch (e) { refused = /DiagnosticRun_key_catalog/.test(String(e.message)); }
  check(refused, 'the database refuses a row with a non-catalog key (CHECK constraint)');
  refused = false;
  try { await prisma.diagnosticRun.create({ data: { endpointId: pc1.id, key: 'disk_space', requestedById: owen.id, expiresAt: new Date(), result: { blob: 'x'.repeat(70_000) } } }); } catch (e) { refused = /DiagnosticRun_result_bounded/.test(String(e.message)); }
  check(refused, 'and a result over 64 KB');

  section('Audit');
  const audit = await prisma.activityLog.findMany({ where: { customerId: acme.id, action: { in: ['ENDPOINT_DIAGNOSTIC_REQUESTED', 'ENDPOINT_DIAGNOSTIC_COMPLETED'] } } });
  const reqd = audit.filter((a) => a.action === 'ENDPOINT_DIAGNOSTIC_REQUESTED');
  const outcomes = audit.filter((a) => a.action === 'ENDPOINT_DIAGNOSTIC_COMPLETED').map((a) => a.metadata.outcome);
  check(reqd.length === 14 && reqd.every((a) => a.actorId && a.metadata.key && a.metadata.runId && a.metadata.risk === 'read_only'), 'every request is audited once with who, which key and the run (deduplicated clicks are not)', `${reqd.length} requested`);
  check(outcomes.filter((o) => o === 'completed').length === 7 && outcomes.filter((o) => o === 'failed').length === 2 && outcomes.filter((o) => o === 'expired').length === 3, 'every completion, failure and expiry is audited', JSON.stringify(outcomes));
  const rej = await prisma.activityLog.findMany({ where: { action: 'ENDPOINT_HEARTBEAT_REJECTED', resourceId: pc1.id } });
  check(rej.some((a) => a.metadata?.reason === 'diagnostic_result_unauthenticated'), 'the wrong-secret result is audited as a rejected device');
  check(!audit.some((a) => JSON.stringify(a.metadata).includes('alice') || JSON.stringify(a.metadata).includes('USERPROFILE')), 'no result content in the audit trail');
}

async function cleanup() {
  await stopApi();
  try {
    const ids = created.businesses;
    const eps = await prisma.endpoint.findMany({ where: { customerId: { in: ids } }, select: { id: true } });
    await prisma.diagnosticRun.deleteMany({ where: { endpointId: { in: eps.map((e) => e.id) } } });
    await prisma.endpointInventory.deleteMany({ where: { endpointId: { in: eps.map((e) => e.id) } } });
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
