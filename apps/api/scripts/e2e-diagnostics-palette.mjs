#!/usr/bin/env node
/**
 * End-to-end proof of the read-only diagnostics palette (v0.76):
 *   - the catalog's groups, minimum agent and lab-evidence label, and the
 *     server-side OS support finding from the stored inventory;
 *   - typed parameters for dns_lookup and tcp_port only: refused before
 *     anything is written (INVALID_DIAGNOSTIC_PARAMS), refused by 0092's CHECK
 *     on a direct insert, audited, deduplicated per target and delivered by the
 *     heartbeat with the run — every other key still id and key only;
 *   - computers:connect for the two keys that reach a host the requester names;
 *   - a 0.75 agent refused a palette key (DIAGNOSTIC_NEEDS_NEWER_AGENT), and an
 *     agent that does not know a key failing its run at once;
 *   - results sanitised (no recovery password, product key or task action
 *     stored) and interpreted, with the evidence time, and never Healthy
 *     from nothing.
 *
 *   cd apps/api && npx nest build
 *   DATABASE_URL=postgresql://…/<name containing scratch or test> DIAG_API_PORT=4011 node scripts/e2e-diagnostics-palette.mjs
 *
 * INTEGRATION, not Windows: the real API and database, with heartbeats and
 * results posted the way heartbeat.ps1 posts them. The PowerShell runs against
 * stubs in unit-diagnostics-palette.mjs and for real in the Windows lab.
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
const PORT = Number(process.env.DIAG_API_PORT ?? 4011);
if ([3000, 3001, 4000, 4001, 443].includes(PORT)) { console.error(`Refusing port ${PORT}`); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'palette-e2e-password-123';

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

const PALETTE = ['defender_status', 'firewall_status', 'bitlocker_status', 'secure_boot_tpm', 'local_admins', 'dns_lookup', 'tcp_port', 'route_table', 'time_sync', 'windows_activation', 'unexpected_shutdowns', 'scheduled_tasks', 'signed_in_sessions'];

async function all() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });
  const roleUser = await prisma.role.findFirst({ where: { type: 'BUSINESS_USER' } });

  section('Fixtures (synthetic): one business, an owner and a view-only user; a 0.76 computer, a 0.75 one, one with no version');
  const acme = await prisma.customer.create({ data: { tenantId: tenant.id, name: `DP Acme ${sfx}` } });
  created.businesses.push(acme.id);
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag) => { const u = await prisma.user.create({ data: { email: `dp-${tag}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'DP', lastName: tag, status: 'ACTIVE' } }); created.users.push(u.id); return u; };
  const owen = await mkUser('owen-owner'), uma = await mkUser('uma-viewer');
  await prisma.membership.create({ data: { userId: owen.id, tenantId: tenant.id, customerId: acme.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: uma.id, tenantId: tenant.id, customerId: acme.id, roleId: roleUser.id, capabilities: ['computers:view'] } });
  const mkEp = async (hostname, agentVersion) => {
    const e = await prisma.endpoint.create({ data: { tenantId: tenant.id, customerId: acme.id, name: hostname, hostname, platform: 'Windows', status: 'ACTIVE', isOnline: true, isManaged: true, accessMode: 'ASSIGNED_USERS', lastSeenAt: new Date(), deviceClass: 'WORKSTATION', agentVersion } });
    const rid = String(100000000 + ((Math.random() * 899999999) | 0));
    const secret = randomBytes(24).toString('hex');
    await prisma.rustdeskNode.create({ data: { tenantId: tenant.id, endpointId: e.id, rustdeskId: rid, agentSecretHash: sha(secret) } });
    return { id: e.id, rid, secret, hostname };
  };
  const pc = await mkEp('PAL-NEW', '0.76.0'), oldpc = await mkEp('PAL-OLD', '0.75.0'), anon = await mkEp('PAL-NOVER', null);
  await prisma.computerAccess.create({ data: { tenantId: tenant.id, endpointId: pc.id, userId: uma.id } });
  await prisma.endpointInventory.create({ data: { endpointId: pc.id, osCaption: 'Microsoft Windows 10 Pro', osBuild: '19045', collectedAt: new Date() } });
  await prisma.endpointInventory.create({ data: { endpointId: oldpc.id, osCaption: 'Microsoft Windows 11 Enterprise', osBuild: '26100', collectedAt: new Date() } });

  startApi();
  await waitUp();
  const S = { owen: await login(owen.email), uma: await login(uma.email) };
  const ask = (s, ep, key, params) => req('POST', `/endpoints/${ep.id}/diagnostics/runs`, { s, body: params === undefined ? { key } : { key, params } });

  section('The catalog: groups, agent version, OS support from the inventory');
  let r = await req('GET', `/endpoints/${pc.id}/diagnostics/catalog`, { s: S.owen });
  const items = Object.fromEntries((r.data?.items ?? []).map((i) => [i.key, i]));
  check(r.status === 200 && Object.keys(items).length === 25 && r.data.agentVersion === '0.76.0', 'twenty-five entries, and the computer\'s agent version', msg(r));
  check(PALETTE.every((k) => items[k] && items[k].minAgent === '0.76.0' && items[k].evidence === 'lab_windows_server' && items[k].needsNewerAgent === false && ['security', 'networking', 'maintenance'].includes(items[k].group)), 'every palette entry: a group, agent 0.76.0, lab-only evidence, runnable on a 0.76 agent');
  check(items.dns_lookup?.params === 'dns_lookup' && items.tcp_port?.params === 'tcp_port' && items.dns_lookup.capability === 'computers:connect' && Object.values(items).filter((i) => i.params).length === 2, 'only dns_lookup and tcp_port take parameters, and they need computers:connect');
  check(r.data.osSupport?.state === 'critical' && r.data.osSupport.build === '19045' && r.data.osSupport.endsOn === '2025-10-14' && r.data.osSupport.tableReviewed === '2026-11-20', 'Windows 10 22H2 Pro, from the stored inventory: Critical, ended 2025-10-14', JSON.stringify(r.data.osSupport));
  r = await req('GET', `/endpoints/${oldpc.id}/diagnostics/catalog`, { s: S.owen });
  const oldItems = Object.fromEntries((r.data?.items ?? []).map((i) => [i.key, i]));
  check(PALETTE.every((k) => oldItems[k]?.needsNewerAgent === true) && oldItems.disk_space?.needsNewerAgent === false && r.data.osSupport?.state === 'healthy', 'a 0.75 agent: every palette key needs a newer agent, the older keys do not; Windows 11 24H2 Enterprise is supported', JSON.stringify(r.data?.osSupport));
  r = await req('GET', `/endpoints/${anon.id}/diagnostics/catalog`, { s: S.owen });
  check(r.data?.osSupport?.state === 'unknown' && r.data.items.every((i) => i.needsNewerAgent === false), 'no inventory: OS support is Unknown; no version: nothing is refused for it', JSON.stringify(r.data?.osSupport));
  r = await req('GET', `/endpoints/${pc.id}/diagnostics/catalog`, { s: S.uma });
  const umaAllowed = Object.fromEntries((r.data?.items ?? []).map((i) => [i.key, i.allowed]));
  check(umaAllowed.dns_lookup === false && umaAllowed.tcp_port === false && umaAllowed.defender_status === true && umaAllowed.local_admins === true, 'a view-only user may run the read-only checks but not the two that reach a host they name', JSON.stringify(umaAllowed));

  section('Refusals before anything is written');
  const before = await prisma.diagnosticRun.count();
  const bad = [
    ['dns_lookup', undefined, 'no parameters'], ['dns_lookup', {}, 'no name'], ['dns_lookup', { name: 'evil.com; whoami' }, 'a shell character'],
    ['dns_lookup', { name: 'x.com', type: 'TXT' }, 'an extra field'], ['dns_lookup', { name: 'a'.repeat(64) }, 'a 64-character label'], ['dns_lookup', { name: 'x.com\n' }, 'a trailing newline'],
    ['dns_lookup', { name: ['x.com'] }, 'an array name'], ['dns_lookup', ['x.com'], 'an array'], ['dns_lookup', 'x.com', 'a string'],
    ['tcp_port', { host: 'x.com', port: 0 }, 'port 0'], ['tcp_port', { host: 'x.com', port: 65536 }, 'port 65536'], ['tcp_port', { host: 'x.com', port: '443' }, 'a string port'],
    ['tcp_port', { host: 'x.com', port: 443, timeoutSeconds: 30 }, 'a 30-second timeout'], ['tcp_port', { host: 'x.com', port: 443, timeoutSeconds: 4 }, 'a timeout not on the list'],
    ['tcp_port', { host: 'https://x.com', port: 443 }, 'a URL'], ['tcp_port', { host: 'x.com', port: 443, payload: 'GET /' }, 'a payload'],
    ['defender_status', { verbose: true }, 'parameters on a key without a schema'], ['disk_space', {}, 'an empty object on a key without a schema'],
  ];
  for (const [k, p, why] of bad) {
    r = await ask(S.owen, pc, k, p);
    check(r.status === 400, `${k}: ${why} is refused (400${code(r) ? ` ${code(r)}` : ''})`, msg(r));
  }
  r = await ask(S.owen, pc, 'tcp_port', { host: 'x.com', port: 443, timeoutSeconds: 30 });
  check(code(r) === 'INVALID_DIAGNOSTIC_PARAMS', 'with the code INVALID_DIAGNOSTIC_PARAMS', msg(r));
  r = await ask(S.uma, pc, 'tcp_port', { host: 'x.com', port: 443 });
  check(r.status === 403, 'a view-only user cannot run a TCP test (computers:connect)', msg(r));
  r = await ask(S.uma, pc, 'dns_lookup', { name: 'x.com' });
  check(r.status === 403, 'nor a DNS lookup', msg(r));
  r = await ask(S.owen, oldpc, 'defender_status');
  check(r.status === 409 && code(r) === 'DIAGNOSTIC_NEEDS_NEWER_AGENT' && /0\.76\.0/.test(JSON.stringify(r.body)), 'a 0.75 agent is refused a palette key (409 DIAGNOSTIC_NEEDS_NEWER_AGENT), with the version', msg(r));
  check((await prisma.diagnosticRun.count()) === before, 'none of those wrote a run');
  r = await ask(S.owen, oldpc, 'disk_space');
  check(r.status === 201, 'the 0.75 agent can still run an older key', msg(r));
  const oldDisk = r.data?.run?.id;

  section('The database refuses parameters outside the schema (0092 CHECK)');
  const raw = async (key, params) => {
    try { await prisma.diagnosticRun.create({ data: { tenantId: tenant.id, endpointId: pc.id, key, status: 'REQUESTED', params, expiresAt: new Date(Date.now() + 3600_000) } }); return 'inserted'; } catch (e) { return /DiagnosticRun_params_closed|check constraint/i.test(String(e.message)) ? 'refused' : `error: ${String(e.message).slice(0, 200)}`; }
  };
  for (const [k, p, why] of [['dns_lookup', { name: 'x.com; rm' }, 'a bad name'], ['tcp_port', { host: 'x.com', port: 70000, timeoutSeconds: 5 }, 'port 70000'], ['tcp_port', { host: 'x.com', port: 443, timeoutSeconds: 4 }, 'timeout 4'],
    ['tcp_port', { host: 'x.com', port: 443 }, 'no timeout'], ['dns_lookup', { name: 'x.com', extra: 1 }, 'an extra field'], ['disk_space', { a: 1 }, 'parameters on disk_space'], ['dns_lookup', null, 'dns_lookup without parameters']]) {
    const got = await raw(k, p === null ? undefined : p);
    check(got === 'refused', `a direct insert with ${why} is refused`, got);
  }
  await prisma.diagnosticRun.deleteMany({ where: { endpointId: pc.id, status: 'REQUESTED' } });

  section('Requested, deduplicated by parameters, delivered with them');
  // The route allows 30 requests a minute per address; the refusals above used most of them.
  S.owen = await login(owen.email);
  r = await ask(S.owen, pc, 'tcp_port', { host: 'db.corp.example', port: 5432 });
  const tcp1 = r.data?.run;
  check(r.status === 201 && JSON.stringify(tcp1?.params) === '{"host":"db.corp.example","port":5432,"timeoutSeconds":5}', 'tcp_port is requested with its canonical parameters (timeout defaulted)', msg(r));
  r = await ask(S.owen, pc, 'tcp_port', { host: 'db.corp.example', port: 5432, timeoutSeconds: 5 });
  check(r.data?.deduplicated === true && r.data.run.id === tcp1.id, 'the same target again returns the open run');
  r = await ask(S.owen, pc, 'tcp_port', { host: '127.0.0.1', port: 1, timeoutSeconds: 2 });
  const tcp2 = r.data?.run;
  check(r.status === 201 && tcp2?.id !== tcp1.id, 'another target is another run');
  r = await ask(S.owen, pc, 'dns_lookup', { name: 'portal.example.com' });
  const dns = r.data?.run;
  const ids = { tcp1: tcp1.id, tcp2: tcp2.id, dns: dns?.id };
  for (const k of ['defender_status', 'bitlocker_status', 'windows_activation', 'scheduled_tasks', 'time_sync', 'unexpected_shutdowns', 'firewall_status', 'secure_boot_tpm', 'local_admins', 'route_table', 'signed_in_sessions', 'reboot_status']) {
    r = await ask(S.owen, pc, k);
    ids[k] = r.data?.run?.id;
    if (!ids[k]) console.log(`      ${k}: ${msg(r)}`);
  }
  check(Object.values(ids).every(Boolean), 'every palette key is requested', JSON.stringify(ids));
  const audReq = await prisma.activityLog.findFirst({ where: { resourceId: pc.id, action: 'ENDPOINT_DIAGNOSTIC_REQUESTED', metadata: { path: ['runId'], equals: tcp1.id } } });
  check(JSON.stringify(audReq?.metadata?.params) === '{"host":"db.corp.example","port":5432,"timeoutSeconds":5}', 'the request\'s audit entry records the parameters', JSON.stringify(audReq?.metadata));
  r = await heartbeat(pc);
  const d1 = r.data?.diagnostics ?? [];
  check(d1.length === 3 && d1[0].id === tcp1.id && JSON.stringify(d1[0].params) === '{"host":"db.corp.example","port":5432,"timeoutSeconds":5}' && d1[2].id === dns.id && JSON.stringify(d1[2].params) === '{"name":"portal.example.com"}', 'the heartbeat hands parameters with the two keys that have them', JSON.stringify(d1));
  r = await heartbeat(pc);
  const d2 = r.data?.diagnostics ?? [];
  check(d2.length === 3 && d2.every((d) => Object.keys(d).sort().join() === 'id,key'), 'and id and key only to every other key', JSON.stringify(d2));
  // Deliver the rest, so every run below can report.
  for (let i = 0; i < 4; i++) await heartbeat(pc);

  section('Results: sanitised, redacted, interpreted');
  const complete = async (id, key, result) => { await post(pc, { runId: id, key, state: 'running' }); return post(pc, { runId: id, key, state: 'completed', result }); };
  const get = async (id) => (await req('GET', `/endpoints/${pc.id}/diagnostics/runs/${id}`, { s: S.owen })).data?.run ?? (await req('GET', `/endpoints/${pc.id}/diagnostics/runs/${id}`, { s: S.owen })).data;
  r = await complete(ids.tcp1, 'tcp_port', { host: 'db.corp.example', port: 5432, timeoutSeconds: 5, outcome: 'timeout', latencyMs: 5001, banner: 'x' });
  let run = await get(ids.tcp1);
  check(r.data?.accepted === true && run?.interpretation?.overall === 'critical' && /did not answer|timed out|no answer/i.test(run.interpretation.findings[0].detail) && !('banner' in (run.result ?? {})), 'a TCP timeout: stored without anything read from the socket, interpreted Critical', JSON.stringify(run?.interpretation));
  check(run.interpretation.findings.every((f) => f.evidenceAt === run.completedAt), 'every finding carries the evidence time (the run\'s completion)', JSON.stringify(run.interpretation.findings.map((f) => f.evidenceAt)) + ' ' + run.completedAt);
  await complete(ids.bitlocker_status, 'bitlocker_status', { supported: true, volumes: [{ mountPoint: 'C:', volumeType: 'OperatingSystem', protectionStatus: 'Off', volumeStatus: 'FullyEncrypted', encryptionPercentage: 100, protectorTypes: ['Tpm'], recoveryPassword: '111111-222222-333333-444444-555555-666666-777777-888888', keyProtectorId: '{SECRET}' }] });
  const blRow = await prisma.diagnosticRun.findUnique({ where: { id: ids.bitlocker_status } });
  run = await get(ids.bitlocker_status);
  check(!/111111-222222|SECRET|recoveryPassword|keyProtectorId/.test(JSON.stringify(blRow.result)) && run.interpretation.overall === 'warning', 'BitLocker: no recovery password or protector id is stored; protection suspended is a Warning', JSON.stringify(blRow.result));
  await complete(ids.windows_activation, 'windows_activation', { products: [{ name: 'Windows(R), Professional edition', channel: 'Retail', licenseStatus: 1, graceMinutes: 0, partialProductKey: 'ABCDE', productKey: 'XXXXX-XXXXX-XXXXX-XXXXX-ABCDE' }] });
  check(!/ABCDE|XXXXX/.test(JSON.stringify((await prisma.diagnosticRun.findUnique({ where: { id: ids.windows_activation } })).result)) && (await get(ids.windows_activation)).interpretation.overall === 'healthy', 'activation: no product key stored; licensed is Healthy');
  await complete(ids.scheduled_tasks, 'scheduled_tasks', { taskCount: 1, microsoftTasks: 0, tasks: [{ path: '\\', name: 'Backup', state: 'Ready', lastResult: 1, actions: [{ execute: 'C:\\evil.exe', arguments: '--password hunter2' }] }] });
  check(!/evil|hunter2/.test(JSON.stringify((await prisma.diagnosticRun.findUnique({ where: { id: ids.scheduled_tasks } })).result)) && (await get(ids.scheduled_tasks)).interpretation.overall === 'warning', 'tasks: no action or argument stored; a failed last run is a Warning');
  const old = new Date(Date.now() - 5 * 86_400_000).toISOString();
  await complete(ids.defender_status, 'defender_status', { supported: true, realTimeProtectionEnabled: true, isTamperProtected: true, runningMode: 'Normal', signatureLastUpdated: old, quickScanEndAt: new Date().toISOString() });
  run = await get(ids.defender_status);
  check(run.interpretation?.findings?.find((f) => f.id === 'signatures')?.state === 'warning' && run.interpretation.overall === 'warning', 'Defender: signatures five days old are a Warning', JSON.stringify(run.interpretation));
  await complete(ids.time_sync, 'time_sync', {});
  run = await get(ids.time_sync);
  check(run.interpretation?.overall !== 'healthy' && run.interpretation.findings.every((f) => f.state !== 'healthy'), 'an empty time-sync result is never Healthy', JSON.stringify(run.interpretation));
  await complete(ids.unexpected_shutdowns, 'unexpected_shutdowns', {});
  run = await get(ids.unexpected_shutdowns);
  check(run.interpretation?.overall === 'unknown', 'a shutdown report with no event list is Unknown, not "none"', JSON.stringify(run.interpretation));
  r = await req('GET', `/endpoints/${pc.id}/diagnostics/runs`, { s: S.owen });
  const hist = (r.data?.runs ?? r.data ?? []);
  const h1 = Array.isArray(hist) ? hist.find((x) => x.id === ids.tcp1) : null;
  check(!!h1 && JSON.stringify(h1.params) === '{"host":"db.corp.example","port":5432,"timeoutSeconds":5}', 'the run history shows the parameters', JSON.stringify(h1).slice(0, 300));

  section('An agent older than a key refuses it: the run fails at once, with a reason');
  // Simulate a pre-0.76 agent: the heartbeat's own list does not have the key, so it reports key 'unknown'.
  const before2 = await prisma.diagnosticRun.findUnique({ where: { id: ids.firewall_status } });
  check(before2.status === 'DELIVERED', 'firewall_status was delivered', before2.status);
  r = await post(pc, { runId: ids.firewall_status, key: 'unknown', state: 'failed', error: 'This agent does not know that diagnostic.' });
  const after2 = await prisma.diagnosticRun.findUnique({ where: { id: ids.firewall_status } });
  check(r.data?.accepted === true && after2.status === 'FAILED' && /Update the agent/.test(after2.error), 'it is FAILED with "update the agent"', JSON.stringify({ r: r.data, s: after2.status, e: after2.error }));
  r = await post(pc, { runId: ids.firewall_status, key: 'unknown', state: 'failed' });
  check(r.data?.accepted === false, 'only once');
  r = await post(pc, { runId: ids.secure_boot_tpm, key: 'unknown', state: 'completed', result: {} });
  check(r.data?.accepted === false && (await prisma.diagnosticRun.findUnique({ where: { id: ids.secure_boot_tpm } })).status !== 'FAILED', '"unknown" with any state but failed changes nothing');
  r = await req('POST', '/enrollment/diagnostic-result', { body: { rustdeskId: oldpc.rid, agentSecret: oldpc.secret, runId: ids.secure_boot_tpm, key: 'unknown', state: 'failed' } });
  check(r.data?.accepted === false && (await prisma.diagnosticRun.findUnique({ where: { id: ids.secure_boot_tpm } })).status !== 'FAILED', 'another computer cannot fail this computer\'s run that way');
  const audFail = await prisma.activityLog.findFirst({ where: { resourceId: pc.id, action: 'ENDPOINT_DIAGNOSTIC_COMPLETED', metadata: { path: ['reason'], equals: 'agent_unknown_key' } } });
  check(!!audFail, 'the refusal is audited (agent_unknown_key)');

  section('An older agent still gets the older keys, unchanged');
  check(!!oldDisk, 'the 0.75 computer\'s disk_space run exists');
  r = await heartbeat(oldpc);
  check((r.data?.diagnostics ?? []).some((d) => d.id === oldDisk && Object.keys(d).sort().join() === 'id,key'), 'and is delivered as before, with no parameters', JSON.stringify(r.data?.diagnostics));
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
