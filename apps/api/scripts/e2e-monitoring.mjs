#!/usr/bin/env node
/**
 * End-to-end proof of monitoring and alerts (v0.29):
 *   - monitors at global / business / site / computer scope, inheritance and
 *     overrides, and who may set each;
 *   - the heartbeat handing the agent its service and event queries, and the
 *     authenticated monitor report raising and clearing alerts;
 *   - resource alerts from the live sample, deduplication, hysteresis;
 *   - two businesses with the same hostname, a business user, and a
 *     technician limited to one computer: who sees which alert;
 *   - a site going dark grouped into one outage alert;
 *   - notification and escalation to a webhook, acknowledgement stopping it,
 *     a business policy overriding the global one, destination rules and
 *     fresh authentication;
 *   - a maintenance window silencing (not hiding) alerts, independent of a
 *     containment pause;
 *   - ClientSt0r: signed, sequenced alert events, pushed and polled, and a
 *     ticket linked back, scoped to the mapped organization;
 *   - software inventory and change history.
 *
 *   cd apps/api && npx nest build
 *   DATABASE_URL=postgresql://…/reboot_remote_it_scratch node scripts/e2e-monitoring.mjs
 *
 * FIXTURE-TESTED: no Windows, no real agent — heartbeats and reports are
 * posted the way the generated heartbeat.ps1 posts them (the PowerShell side
 * is exercised by unit-monitoring.mjs with PWSH set).
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const C = require(path.join(dist, 'integration/crypto.js'));
const { AlertEvent, Alert } = require(path.join(dist, 'integration/contract.js'));

const DB = process.env.DATABASE_URL ?? '';
const dbName = DB.split('/').pop()?.split('?')[0] ?? '';
if (!/scratch|test/.test(dbName)) { console.error(`Refusing to run against database "${dbName}": name must contain "scratch" or "test".`); process.exit(2); }
const PORT = Number(process.env.MON_API_PORT ?? 3191);
const HOOK_PORT = Number(process.env.MON_HOOK_PORT ?? 3291);
const PEER_PORT = Number(process.env.MON_PEER_PORT ?? 3292);
const ROOT = `http://127.0.0.1:${PORT}`;
const API = `${ROOT}/api/v1`;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'monitor-e2e-password-123';

let pass = 0, fail = 0;
const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const work = mkdtempSync(path.join(tmpdir(), 'rem0te-mon-'));

// ── Webhook receiver and a stand-in ClientSt0r events endpoint ──────────────
const hooks = [];
const peerEvents = [];
const listen = (port, sink) => new Promise((resolve) => {
  const s = createServer((rq, rs) => {
    let b = ''; rq.on('data', (d) => { b += d; }); rq.on('end', () => { try { sink.push({ path: rq.url, body: JSON.parse(b), at: Date.now() }); } catch { sink.push({ path: rq.url, raw: b }); } rs.writeHead(200, { 'content-type': 'application/json' }); rs.end('{}'); });
  }).listen(port, '127.0.0.1', () => resolve(s));
});

const pair = () => generateKeyPairSync('ed25519');
const pem = (k) => k.export({ type: 'spki', format: 'pem' }).toString();
const self = pair(), peerReq = pair(), peerDel = pair();
writeFileSync(path.join(work, 'self.pem'), self.privateKey.export({ type: 'pkcs8', format: 'pem' }));
const AUD = 'rem0te:mon-lab', PEER = `clientst0r-mon-${sfx}`;
const peersFile = path.join(work, 'peers.json');
writeFileSync(peersFile, JSON.stringify({
  self: { keyId: 'rem0te-mon-1', privateKeyFile: path.join(work, 'self.pem') },
  peers: [{ id: PEER, audience: AUD, peerAudience: 'clientst0r:mon-lab', requestKeys: [{ kid: 'req-1', publicKeyPem: pem(peerReq.publicKey) }], delegationKeys: [{ kid: 'del-1', publicKeyPem: pem(peerDel.publicKey) }], inferenceUrl: `http://127.0.0.1:${PEER_PORT}/api/integration/v1/inference`, eventsUrl: `http://127.0.0.1:${PEER_PORT}/api/integration/v1/events`, modelProfiles: ['triage-fast'] }],
}));
const apiEnv = {
  ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATABASE_URL: DB, INTEGRATION_PEERS_FILE: peersFile, INTEGRATION_WORKER_INLINE: 'true',
  JWT_SECRET: randomBytes(32).toString('hex'), LAUNCHER_TOKEN_SECRET: randomBytes(32).toString('hex'),
  ENCRYPTION_KEY: randomBytes(32).toString('hex'), TRUSTED_PROXIES: 'loopback', HBBS_PRESENCE_HOST: '127.0.0.2',
  VERSION_FILE: path.resolve(here, '..', '..', '..', 'version.json'),
  MONITOR_SWEEP_SECONDS: '2', MONITOR_OFFLINE_HOLD_SECONDS: '4', AUDIT_SEALER: 'off',
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

// ── HTTP ────────────────────────────────────────────────────────────────────
async function req(method, p, { s, body, business } = {}) {
  const h = { 'content-type': 'application/json', 'x-forwarded-for': s?.ip ?? ip() };
  if (s) h.cookie = s.cookie + (s.stepUp ? `; step_up=${s.stepUp}` : '');
  if (business) h['x-rem0te-business'] = business;
  const r = await fetch(`${API}${p}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j, data: j?.data, setCookie: r.headers.get('set-cookie') ?? '' };
}
async function login(email) {
  const s = { ip: ip() };
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': s.ip }, body: JSON.stringify({ email, password: PW }) });
  const mm = (r.headers.get('set-cookie') ?? '').match(/access_token=([^;]+)/);
  if (r.status !== 200 || !mm) throw new Error(`login ${email}: ${r.status} ${await r.text()}`);
  s.cookie = `access_token=${mm[1]}`;
  return s;
}
async function stepUp(s) {
  const r = await req('POST', '/auth/step-up', { s, body: { password: PW } });
  const mm = r.setCookie.match(/step_up=([^;]+)/);
  if (r.status !== 200 || !mm) throw new Error(`step-up: ${r.status} ${JSON.stringify(r.body)}`);
  return { ...s, stepUp: mm[1] };
}
const code = (r) => r.body?.code ?? r.body?.message?.code ?? r.body?.error?.code;
const msg = (r) => `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 400)}`;

// The agent.
const heartbeat = (ep, extra = {}) => req('POST', '/enrollment/heartbeat', { body: { rustdeskId: ep.rid, agentSecret: ep.secret, hostname: ep.hostname, platform: 'Windows', ...extra } });
const report = (ep, body, secret = ep.secret) => req('POST', '/enrollment/monitor-report', { body: { rustdeskId: ep.rid, agentSecret: secret, ...body } });
const live = (free, total = 100_000, extra = {}) => ({ systemDiskTotalMb: total, systemDiskFreeMb: free, cpuLoadPercent: 10, memoryTotalMb: 8192, memoryFreeMb: 4096, ...extra });

// ClientSt0r.
async function call(method, p, { body } = {}) {
  const text = body ? JSON.stringify(body) : '';
  const t = String(Math.floor(Date.now() / 1000)), n = randomBytes(18).toString('base64url');
  const sig = C.signEd25519(peerReq.privateKey, C.requestSigningString({ audience: AUD, method, pathWithQuery: p, timestamp: t, nonce: n, bodySha256: C.sha256Hex(Buffer.from(text)) }));
  const headers = { 'content-type': 'application/json', 'rem0te-key-id': `${PEER}/req-1`, 'rem0te-timestamp': t, 'rem0te-nonce': n, 'rem0te-signature': sig };
  const r = await fetch(`${ROOT}${p}`, { method, headers, body: text || undefined });
  const out = await r.text(); let j; try { j = JSON.parse(out); } catch { j = out; }
  return { status: r.status, body: j };
}

const until = async (fn, ms = 15_000, step = 500) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(step); } return v; };
const alertsOf = (where) => prisma.monitorAlert.findMany({ where, orderBy: { firstSeenAt: 'asc' } });
const openAlert = (endpointId, ruleKey) => prisma.monitorAlert.findFirst({ where: { endpointId, ruleKey, state: { not: 'RESOLVED' } } });

const created = { businesses: [], users: [], globalRules: [], globalPolicy: false, globalSuppressions: [] };

async function all() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  const preexisting = await prisma.monitorRule.count({ where: { scopeKey: 'global' } }) + await prisma.monitorNotifyPolicy.count({ where: { scopeKey: 'global' } });
  if (preexisting) throw new Error('the scratch database already has global monitors or a global notification policy — this suite owns those while it runs; remove them first');
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });
  const roleUser = await prisma.role.findFirst({ where: { type: 'BUSINESS_USER' } });

  section('Fixtures (synthetic): Acme (site HQ, four PCs) and Birch, each with a FRONTDESK');
  const acme = await prisma.customer.create({ data: { tenantId: tenant.id, name: `MO Acme ${sfx}` } });
  const birch = await prisma.customer.create({ data: { tenantId: tenant.id, name: `MO Birch ${sfx}` } });
  created.businesses.push(acme.id, birch.id);
  const hq = await prisma.site.create({ data: { tenantId: tenant.id, customerId: acme.id, name: `HQ ${sfx}` } });
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag, extra = {}) => { const u = await prisma.user.create({ data: { email: `mo-${tag}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'MO', lastName: tag, status: 'ACTIVE', ...extra } }); created.users.push(u.id); return u; };
  const mgr = await mkUser('mgr', { platformPermissions: ['technicians:manage'] });
  const owen = await mkUser('owen-owner-acme'), bea = await mkUser('bea-owner-birch');
  const uma = await mkUser('uma-user-acme'), cora = await mkUser('cora-config-acme'), tom = await mkUser('tom-l1');
  await prisma.membership.create({ data: { userId: owen.id, tenantId: tenant.id, customerId: acme.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: bea.id, tenantId: tenant.id, customerId: birch.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: uma.id, tenantId: tenant.id, customerId: acme.id, roleId: roleUser.id, capabilities: ['computers:view', 'monitoring:alerts'] } });
  await prisma.membership.create({ data: { userId: cora.id, tenantId: tenant.id, customerId: acme.id, roleId: roleUser.id, capabilities: ['computers:view', 'monitoring:configure', 'monitoring:alerts'] } });
  const ORG_A = `org-a-${sfx}`;
  await prisma.integrationOrgMapping.create({ data: { peerId: PEER, externalOrgId: ORG_A, customerId: acme.id, tenantId: tenant.id, createdById: 'mo' } });
  const mkEp = async (biz, hostname, extra = {}) => {
    const e = await prisma.endpoint.create({ data: { tenantId: tenant.id, customerId: biz.id, name: hostname, hostname, status: 'ACTIVE', isOnline: true, isManaged: true, accessMode: 'ASSIGNED_USERS', lastSeenAt: new Date(), deviceClass: 'WORKSTATION', ...extra } });
    const rid = String(100000000 + ((Math.random() * 899999999) | 0));
    const secret = randomBytes(24).toString('hex');
    await prisma.rustdeskNode.create({ data: { tenantId: tenant.id, endpointId: e.id, rustdeskId: rid, agentSecretHash: sha(secret) } });
    return { id: e.id, rid, secret, hostname };
  };
  const fdA = await mkEp(acme, 'FRONTDESK'), fdB = await mkEp(birch, 'FRONTDESK');
  const pcs = [];
  for (let i = 1; i <= 4; i++) pcs.push(await mkEp(acme, `HQ-PC${i}`, { siteId: hq.id }));
  await prisma.computerAccess.create({ data: { tenantId: tenant.id, endpointId: fdA.id, userId: uma.id } });
  const l1 = await prisma.technicianPreset.findUnique({ where: { key: 'l1-help-desk' } });
  await prisma.technicianAssignment.create({ data: { tenantId: tenant.id, customerId: acme.id, userId: tom.id, presetId: l1.id, capabilities: [], endpointIds: [pcs[0].id] } });

  await Promise.all([listen(HOOK_PORT, hooks), listen(PEER_PORT, peerEvents)]);
  startApi();
  await waitUp();
  const S = { mgr: await login(mgr.email), owen: await login(owen.email), bea: await login(bea.email), uma: await login(uma.email), cora: await login(cora.email), tom: await login(tom.email) };

  section('Monitors: who may set what');
  let r = await req('POST', '/monitoring/rules', { s: S.owen, business: acme.id, body: { scope: 'global', key: 'offline', kind: 'OFFLINE', name: 'Offline', params: { minutes: 5 } } });
  check(r.status === 403, 'a Business Owner cannot set a global monitor', msg(r));
  r = await req('POST', '/monitoring/rules', { s: S.mgr, body: { scope: 'global', key: 'offline', kind: 'OFFLINE', name: 'Offline', params: { minutes: 5 } } });
  check(r.status === 201 && r.data?.scopeKey === 'global', 'the MSP sets a global offline monitor', msg(r));
  created.globalRules.push(r.data?.id);
  r = await req('POST', '/monitoring/rules', { s: S.mgr, body: { scope: 'global', key: 'disk-free', kind: 'DISK_FREE', name: 'Disk', params: { minFreePercent: 10 } } });
  created.globalRules.push(r.data?.id);
  check(r.status === 201, 'and a global disk-free monitor at 10%', msg(r));
  r = await req('POST', '/monitoring/rules', { s: S.owen, business: acme.id, body: { scope: 'business', businessId: acme.id, key: 'disk-free', kind: 'DISK_FREE', name: 'Disk (Acme)', severity: 'CRITICAL', params: { minFreePercent: 30 } } });
  check(r.status === 201 && r.data?.scopeKey === `b:${acme.id}`, 'Acme\'s owner overrides disk-free at 30% for Acme', msg(r));
  const acmeDiskRule = r.data;
  r = await req('POST', '/monitoring/rules', { s: S.bea, business: birch.id, body: { scope: 'business', businessId: acme.id, key: 'x', kind: 'OFFLINE', name: 'x' } });
  check(r.status === 403 || r.status === 404, 'Birch\'s owner cannot add a monitor to Acme', msg(r));
  r = await req('POST', '/monitoring/rules', { s: S.uma, business: acme.id, body: { scope: 'business', businessId: acme.id, key: 'x', kind: 'OFFLINE', name: 'x' } });
  check(r.status === 403, 'a Business User without monitoring:configure cannot', msg(r));
  r = await req('POST', '/monitoring/rules', { s: S.cora, business: acme.id, body: { scope: 'business', businessId: acme.id, key: 'spooler', kind: 'SERVICE_STOPPED', name: 'Print Spooler', params: { service: 'Spooler' } } });
  check(r.status === 201, 'a Business User with monitoring:configure adds a service monitor', msg(r));
  r = await req('POST', '/monitoring/rules', { s: S.cora, business: acme.id, body: { scope: 'business', businessId: acme.id, key: 'bad', kind: 'SERVICE_STOPPED', name: 'x', params: { service: 'Spool*; rm' } } });
  check(r.status === 400 && code(r) === 'INVALID_PARAMS', 'a service name that is not a plain name is refused', msg(r));
  r = await req('POST', '/monitoring/rules', { s: S.cora, business: acme.id, body: { scope: 'business', businessId: acme.id, key: 'spooler', kind: 'SERVICE_STOPPED', name: 'again', params: { service: 'Spooler' } } });
  check(r.status === 409 && code(r) === 'KEY_EXISTS', 'the same key twice at one scope is a conflict', msg(r));
  r = await req('POST', '/monitoring/rules', { s: S.cora, business: acme.id, body: { scope: 'business', businessId: acme.id, key: 'z', kind: 'OFFLINE', name: 'z', params: {}, command: 'whoami' } });
  check(r.status === 400, 'an unknown field (a "command") is refused', msg(r));
  r = await req('POST', '/monitoring/rules', { s: S.owen, business: acme.id, body: { scope: 'endpoint', endpointId: fdA.id, key: 'offline', kind: 'OFFLINE', name: 'Offline (off here)', enabled: false, params: {} } });
  check(r.status === 201, 'Acme\'s owner switches the inherited offline monitor off for FRONTDESK', msg(r));
  r = await req('POST', '/monitoring/rules', { s: S.owen, business: acme.id, body: { scope: 'endpoint', endpointId: fdB.id, key: 'offline', kind: 'OFFLINE', name: 'x', enabled: false } });
  check(r.status === 404, 'but not for Birch\'s FRONTDESK (same hostname, 404)', msg(r));
  r = await req('GET', `/monitoring/endpoints/${fdA.id}`, { s: S.owen, business: acme.id });
  const effA = Object.fromEntries((r.data?.rules ?? []).map((x) => [x.key, x]));
  check(effA['disk-free']?.inheritedFrom === `b:${acme.id}` && effA['disk-free'].overrides.includes('global'), 'FRONTDESK (Acme) gets disk-free from Acme, overriding global', msg(r));
  check(!effA.offline && !!effA.spooler, 'offline is off for it, spooler applies', JSON.stringify(Object.keys(effA)));
  r = await req('GET', '/monitoring/rules', { s: S.bea, business: birch.id });
  check(r.status === 200 && r.data.rules.every((x) => x.scopeKey === 'global' || x.businessId === birch.id), 'Birch\'s owner sees the global monitors and none of Acme\'s', msg(r));

  section('The heartbeat asks; the report answers');
  r = await heartbeat(fdA, live(20_000));
  check(r.status < 300 && JSON.stringify(r.data?.monitor?.services) === '["Spooler"]', 'Acme FRONTDESK is asked about the Spooler', msg(r));
  const rB = await heartbeat(fdB, live(20_000));
  check(rB.status < 300 && rB.data?.monitor === null, 'Birch FRONTDESK is asked about nothing (no service or event monitors there)', msg(rB));
  let a = await openAlert(fdA.id, 'disk-free');
  check(a && a.severity === 'CRITICAL' && a.customerId === acme.id && /20\.0% free/.test(a.title), 'Acme FRONTDESK at 20% free → a CRITICAL disk alert (Acme\'s 30% rule)', JSON.stringify(a));
  check(!(await openAlert(fdB.id, 'disk-free')), 'Birch FRONTDESK at 20% free → nothing (global 10% rule)');
  await heartbeat(fdA, live(19_000));
  const a2 = await openAlert(fdA.id, 'disk-free');
  check(a2?.id === a.id && a2.occurrences === 2, 'a repeat is the same alert, counted, not a new one', JSON.stringify(a2));
  const anon = await req('POST', '/enrollment/heartbeat', { body: { rustdeskId: fdA.rid, hostname: 'FRONTDESK', platform: 'Windows' } });
  check(anon.data?.monitor === undefined, 'an unauthenticated heartbeat is asked nothing', msg(anon));
  r = await report(fdA, { services: [{ name: 'Spooler', status: 'Stopped', startType: 'Automatic' }] }, randomBytes(24).toString('hex'));
  check(r.status === 401, 'a monitor report with the wrong device secret is refused', msg(r));
  r = await report(fdA, { services: [{ name: 'Spooler', status: 'Stopped', startType: 'Automatic' }, { name: 'Evil', status: 'Running' }] });
  check(r.status === 200 && r.data?.services === 1, 'the report is accepted, and only the service that was asked about is kept', msg(r));
  const spool = await openAlert(fdA.id, 'spooler');
  check(!!spool && /Spooler is stopped/.test(spool.title), 'a stopped Spooler raises an alert', JSON.stringify(spool));
  const inv = await prisma.endpointInventory.findUnique({ where: { endpointId: fdA.id } });
  check(JSON.stringify(inv.monitorReport.services.map((s) => s.name)) === '["Spooler"]', 'and "Evil" never reached the database');
  await report(fdB, { services: [{ name: 'Spooler', status: 'Stopped' }] });
  check(!(await openAlert(fdB.id, 'spooler')), 'Birch reporting a stopped Spooler raises nothing — Birch has no such monitor');
  await report(fdA, { services: [{ name: 'Spooler', status: 'Running', startType: 'Automatic' }] });
  const sp2 = await prisma.monitorAlert.findUnique({ where: { id: spool.id } });
  check(sp2.state === 'RESOLVED' && sp2.resolvedById === null, 'running again → resolved by the monitor itself', JSON.stringify(sp2));

  section('Event monitors');
  r = await req('POST', '/monitoring/rules', { s: S.cora, business: acme.id, body: { scope: 'business', businessId: acme.id, key: 'disk-errors', kind: 'EVENT_MATCH', name: 'Disk errors', severity: 'CRITICAL', params: { log: 'System', ids: [7, 11], clearAfterMinutes: 15 } } });
  check(r.status === 201, 'an event monitor on the System log', msg(r));
  r = await req('POST', '/monitoring/rules', { s: S.cora, business: acme.id, body: { scope: 'business', businessId: acme.id, key: 'all', kind: 'EVENT_MATCH', name: 'Everything', params: { log: 'System' } } });
  check(r.status === 400, 'a monitor on every event in a log is refused', msg(r));
  r = await heartbeat(fdA, live(50_000));
  const evq = r.data?.monitor?.events?.find((e) => e.key === 'disk-errors');
  check(evq && evq.log === 'System' && JSON.stringify(evq.ids) === '[7,11]' && evq.since === null, 'the heartbeat hands the event query, with no "since" yet', msg(r));
  const T = '2026-11-10T17:36:30.8936938Z';
  r = await report(fdA, { services: [{ name: 'Spooler', status: 'Running' }], events: [{ key: 'disk-errors', checkedAt: T, count: 2, newestAt: T, sample: { eventId: 7, level: 2, provider: 'disk', message: 'The device has a bad block.' } }, { key: 'made-up', checkedAt: T, count: 99 }] });
  check(r.data?.events === 1, 'an event key nobody configured is dropped', msg(r));
  const ea = await openAlert(fdA.id, 'disk-errors');
  check(ea && ea.detail.count === 2 && ea.detail.sample.eventId === 7, 'two matching events raise the alert, with the sample', JSON.stringify(ea));
  r = await heartbeat(fdA, live(50_000));
  check(r.data?.monitor?.events?.[0]?.since === '2026-11-10T17:36:30.893Z', 'the next query starts from the agent\'s own clock, echoed back', msg(r));
  check(!(await openAlert(fdA.id, 'disk-free')), 'disk at 50% free: two good samples later the disk alert has cleared (hysteresis)');

  section('Who sees which alert');
  const lst = async (s, business) => (await req('GET', '/monitoring/alerts?state=all', { s, business })).data?.alerts ?? [];
  const umaSees = await lst(S.uma, acme.id);
  check(umaSees.length > 0 && umaSees.every((x) => x.computer?.id === fdA.id), 'Uma (Business User, FRONTDESK only) sees FRONTDESK alerts and nothing else', JSON.stringify(umaSees.map((x) => x.computer?.name)));
  r = await req('GET', `/monitoring/alerts/${ea.id}`, { s: S.bea, business: birch.id });
  check(r.status === 404, 'Birch\'s owner gets 404 for an Acme alert id', msg(r));
  r = await req('POST', `/monitoring/alerts/${ea.id}/acknowledge`, { s: S.bea, business: birch.id, body: {} });
  check(r.status === 404, 'and cannot acknowledge it', msg(r));
  r = await req('GET', `/monitoring/alerts/${ea.id}`, { s: S.tom, business: acme.id });
  check(r.status === 404, 'Tom (L1, HQ-PC1 only) cannot see a FRONTDESK alert', msg(r));
  r = await req('GET', '/monitoring/summary', { s: S.tom, business: acme.id });
  check(r.status === 200 && r.data.visible === true, 'but Tom\'s preset does carry monitoring:alerts', msg(r));

  section('Notification: the global policy, fresh authentication and destination rules');
  const hookUrl = `http://127.0.0.1:${HOOK_PORT}/hook`;
  const policy = { scope: 'global', levels: [{ afterMinutes: 0, minSeverity: 'WARNING', destinations: [{ label: 'on-call', url: `${hookUrl}/l0` }] }, { afterMinutes: 30, minSeverity: 'CRITICAL', destinations: [{ label: 'lead', url: `${hookUrl}/l1` }] }], ticketing: { enabled: true, minSeverity: 'WARNING' } };
  r = await req('PUT', '/monitoring/notify-policy', { s: S.mgr, body: policy });
  check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED', 'changing who is notified needs fresh authentication', msg(r));
  const mgrUp = await stepUp(S.mgr);
  r = await req('PUT', '/monitoring/notify-policy', { s: mgrUp, body: policy });
  check(r.status === 200 && r.data.effective === 'global', 'the MSP sets the global policy (loopback http allowed there)', msg(r));
  created.globalPolicy = true;
  const owenUp = await stepUp(S.owen);
  r = await req('PUT', '/monitoring/notify-policy', { s: owenUp, business: acme.id, body: { scope: 'business', businessId: acme.id, levels: [{ afterMinutes: 0, destinations: [{ label: 'x', url: 'http://127.0.0.1:9/x' }] }] } });
  check(r.status === 400 && code(r) === 'INVALID_DESTINATION', 'a business destination on loopback is refused', msg(r));
  r = await req('PUT', '/monitoring/notify-policy', { s: owenUp, business: acme.id, body: { scope: 'business', businessId: acme.id, levels: [{ afterMinutes: 0, destinations: [{ label: 'x', url: 'https://10.0.0.5/x' }] }] } });
  check(r.status === 400 && code(r) === 'INVALID_DESTINATION', 'so is a private IP literal', msg(r));
  const coraUp = await stepUp(S.cora);
  r = await req('PUT', '/monitoring/notify-policy', { s: coraUp, business: acme.id, body: { scope: 'business', businessId: acme.id, levels: [] } });
  check(r.status === 403, 'monitoring:configure is not enough to change who is notified', msg(r));
  const beaUp = await stepUp(S.bea);
  r = await req('PUT', '/monitoring/notify-policy', { s: beaUp, business: birch.id, body: { scope: 'business', businessId: birch.id, levels: [], ticketing: { enabled: false } } });
  check(r.status === 200 && r.data.effective === 'business', 'Birch\'s owner sets an empty policy for Birch (overrides the global one)', msg(r));
  r = await req('GET', '/monitoring/notify-policy', { s: S.cora, business: acme.id });
  check(r.status === 200 && /…$/.test(r.data.global.levels[0].destinations[0].url), 'someone who cannot set the policy sees destination hosts, not full URLs', msg(r));
  const hookFor = (id) => hooks.filter((h) => h.body?.alert?.id === id);
  const got = await until(async () => hookFor(ea.id).length > 0);
  check(got && hookFor(ea.id)[0].path === '/hook/l0' && hookFor(ea.id)[0].body.type === 'alert.notify', 'the open CRITICAL event alert is delivered to level 0', JSON.stringify(hooks.slice(-3)));
  // Birch: a disk alert under Birch's own (empty) policy.
  await heartbeat(fdB, live(5_000));
  const bAlert = await openAlert(fdB.id, 'disk-free');
  check(!!bAlert, 'Birch FRONTDESK at 5% free raises its alert', '');
  await sleep(5000);
  check(hookFor(bAlert?.id).length === 0, 'and nobody is told — Birch\'s own policy, with no levels, replaces the global one');
  // Escalation: 31 minutes later, nobody acknowledged.
  await prisma.monitorAlert.update({ where: { id: ea.id }, data: { notifyFrom: new Date(Date.now() - 31 * 60_000), nextCheckAt: new Date() } });
  const esc = await until(async () => hookFor(ea.id).some((h) => h.path === '/hook/l1'));
  check(esc, 'unacknowledged after 30 minutes → escalated to level 1', JSON.stringify(hookFor(ea.id).map((h) => h.path)));
  const evs = await prisma.monitorAlertEvent.findMany({ where: { alertId: ea.id }, orderBy: { createdAt: 'asc' } });
  check(evs.some((e) => e.type === 'notified') && evs.some((e) => e.type === 'escalated'), 'both deliveries are in the alert\'s history', JSON.stringify(evs.map((e) => e.type)));

  section('Acknowledge and resolve');
  r = await req('POST', `/monitoring/alerts/${ea.id}/acknowledge`, { s: S.uma, business: acme.id, body: { note: 'Looking at it' } });
  check(r.status === 200 && r.data.state === 'ACKNOWLEDGED', 'Uma acknowledges the alert on her computer', msg(r));
  r = await req('POST', `/monitoring/alerts/${ea.id}/acknowledge`, { s: S.uma, business: acme.id, body: {} });
  check(r.status === 409, 'twice is a conflict', msg(r));
  r = await req('POST', `/monitoring/alerts/${ea.id}/resolve`, { s: S.uma, business: acme.id, body: { note: 'x' } });
  check(r.status === 400, 'resolving needs a note of 3+ characters', msg(r));
  const before = hookFor(ea.id).length;
  r = await req('POST', `/monitoring/alerts/${ea.id}/resolve`, { s: S.uma, business: acme.id, body: { note: 'Replaced the disk' } });
  check(r.status === 200 && r.data.state === 'RESOLVED' && r.data.resolvedBy === 'person', 'and resolves it, by hand', msg(r));
  const resolvedHook = await until(async () => hookFor(ea.id).length > before);
  check(resolvedHook && hookFor(ea.id).at(-1).body.type === 'alert.resolved', 'everyone who was told hears it is resolved', JSON.stringify(hookFor(ea.id).at(-1)?.body?.type));

  section('Maintenance windows: silenced, not hidden — and not a pause');
  r = await req('POST', '/monitoring/suppressions', { s: S.owen, business: acme.id, body: { scope: 'global', reason: 'try', endsAt: new Date(Date.now() + 3600_000).toISOString() } });
  check(r.status === 403, 'a Business Owner cannot open a global window', msg(r));
  r = await req('POST', '/monitoring/suppressions', { s: S.owen, business: acme.id, body: { scope: 'business', businessId: acme.id, reason: 'forever', endsAt: new Date(Date.now() + 30 * 86_400_000).toISOString() } });
  check(r.status === 400 && code(r) === 'INVALID_WINDOW', 'a window longer than 14 days is refused', msg(r));
  r = await req('POST', '/monitoring/suppressions', { s: S.owen, business: acme.id, body: { scope: 'business', businessId: acme.id, reason: 'Printer vendor on site', endsAt: new Date(Date.now() + 3600_000).toISOString() } });
  check(r.status === 201, 'Acme\'s owner opens a one-hour window for Acme', msg(r));
  const win = r.data;
  const ban = await req('GET', '/containment/banner', { s: S.owen, business: acme.id });
  check(Array.isArray(ban.body?.data) && ban.body.data.length === 0, 'it is not a containment pause — nothing is paused', msg(ban));
  await report(fdA, { services: [{ name: 'Spooler', status: 'Stopped' }] });
  const quiet = await openAlert(fdA.id, 'spooler');
  check(!!quiet, 'a new Spooler alert is still raised during the window', '');
  const sup = await until(async () => (await prisma.monitorAlert.findUnique({ where: { id: quiet.id } }))?.suppressed);
  check(sup, 'and marked suppressed', '');
  r = await req('GET', '/monitoring/alerts', { s: S.owen, business: acme.id });
  check(r.data?.alerts?.some((x) => x.id === quiet.id && x.suppressed), 'it is shown in the list, flagged — not hidden', msg(r));
  await sleep(4000);
  check(hookFor(quiet.id).length === 0, 'nobody is told while the window is open');
  r = await req('POST', `/monitoring/suppressions/${win.id}/revoke`, { s: S.bea, business: birch.id });
  check(r.status === 404, 'Birch cannot end Acme\'s window', msg(r));
  r = await req('POST', `/monitoring/suppressions/${win.id}/revoke`, { s: S.owen, business: acme.id });
  check(r.status === 200, 'Acme ends it early', msg(r));
  const told = await until(async () => hookFor(quiet.id).length > 0);
  check(told, 'and the held alert is delivered now', '');

  section('Containment does not stop monitoring');
  const mgrPause = await req('POST', '/containment/pauses', { s: S.mgr, body: { scope: 'business', businessId: acme.id, reason: 'Incident drill' } });
  check(mgrPause.status === 201, 'the MSP suspends Acme', msg(mgrPause));
  await heartbeat(pcs[3], live(1_000));
  check(!!(await openAlert(pcs[3].id, 'disk-free')), 'an alert is still raised while Acme is suspended', '');

  section('A site goes dark: one outage alert, not three');
  await req('POST', `/monitoring/alerts/${(await openAlert(pcs[3].id, 'disk-free')).id}/resolve`, { s: S.owen, business: acme.id, body: { note: 'drill over' } });
  for (const p of pcs.slice(0, 3)) await prisma.endpoint.update({ where: { id: p.id }, data: { isOnline: false, lastSeenAt: new Date(Date.now() - 10 * 60_000) } });
  const outage = await until(async () => prisma.monitorAlert.findFirst({ where: { siteId: hq.id, kind: 'SITE_OUTAGE', state: 'OPEN' } }), 20_000);
  check(!!outage && /3 of 4 computers offline/.test(outage.title), 'three of four HQ computers offline → a site outage alert', JSON.stringify(outage));
  const kids = await alertsOf({ siteId: hq.id, kind: 'OFFLINE', state: { not: 'RESOLVED' } });
  check(kids.length === 3 && kids.every((k) => k.parentId === outage?.id), 'the three offline alerts are grouped under it', JSON.stringify(kids.map((k) => k.parentId)));
  await until(async () => hooks.some((h) => h.body?.alert?.id === outage?.id), 10_000);
  await sleep(5000);
  check(hookFor(outage?.id).length === 1 && kids.every((k) => hookFor(k.id).length === 0), 'one notification for the outage, none for each computer', JSON.stringify({ outage: hookFor(outage?.id).length, kids: kids.map((k) => hookFor(k.id).length) }));
  r = await req('GET', `/monitoring/alerts/${outage?.id}`, { s: S.uma, business: acme.id });
  check(r.status === 404, 'a Business User limited to one computer does not see the site-wide alert', msg(r));
  r = await req('GET', `/monitoring/alerts/${outage?.id}`, { s: S.owen, business: acme.id });
  check(r.status === 200 && r.data.children.length === 3, 'Acme\'s owner sees it, with its three computers', msg(r));
  for (const p of pcs.slice(0, 3)) await prisma.endpoint.update({ where: { id: p.id }, data: { isOnline: true, lastSeenAt: new Date() } });
  const cleared = await until(async () => (await prisma.monitorAlert.findUnique({ where: { id: outage.id } }))?.state === 'RESOLVED', 15_000);
  check(cleared, 'back online → the computers\' alerts clear, then the outage', '');
  check((await alertsOf({ siteId: hq.id, kind: 'OFFLINE', state: { not: 'RESOLVED' } })).length === 0, 'no offline alert left open');

  section('ClientSt0r: signed alert events, pushed and polled, and a ticket linked back');
  r = await call('GET', '/api/integration/v1/capabilities');
  check(r.status === 200 && r.body.features.alerts === true, 'capabilities advertise alerts', JSON.stringify(r.body).slice(0, 200));
  const poll = await call('GET', `/api/integration/v1/alerts/events?organization_id=${ORG_A}&after=0`);
  check(poll.status === 200 && poll.body.events.length > 0, 'Acme\'s organization can poll its alert events', JSON.stringify(poll.body).slice(0, 300));
  const evsA = poll.body.events ?? [];
  const seqs = evsA.map((e) => e.alert_event.sequence);
  check(seqs.every((s, i) => s === i + 1), 'sequences run 1..n with no gaps', JSON.stringify(seqs));
  check(evsA.every((e) => AlertEvent.safeParse(e.alert_event).success), 'every event matches the contract schema');
  const selfPub = C.ed25519PublicKey(pem(self.publicKey));
  check(evsA.every((e) => C.verifyEd25519(selfPub, C.alertEventSigningString(e.alert_event), e.signature.sig)), 'every event verifies against rem0te\'s key under the alert-event prefix');
  check(evsA.every((e) => !C.verifyEd25519(selfPub, C.eventSigningString(e.alert_event), e.signature.sig)), 'and none would verify as a job event (no cross-type replay)');
  check(evsA.every((e) => e.alert_event.alert.alert_id !== bAlert?.id), 'nothing about Birch is sent to Acme\'s organization');
  const pushed = await until(async () => peerEvents.filter((p) => p.body?.alert_event).length >= Math.min(evsA.length, 3), 20_000);
  check(pushed, 'the worker pushes them to ClientSt0r\'s events URL', `${peerEvents.length} received`);
  r = await call('GET', `/api/integration/v1/alerts/events?organization_id=org-nobody-${sfx}&after=0`);
  check(r.status === 403, 'an unmapped organization is refused', JSON.stringify(r.body));
  const un = await fetch(`${ROOT}/api/integration/v1/alerts/events?organization_id=${ORG_A}`);
  check(un.status === 401, 'an unsigned request is refused', String(un.status));
  const target = evsA.find((e) => e.alert_event.type === 'alert.raised')?.alert_event.alert.alert_id;
  r = await call('POST', `/api/integration/v1/alerts/${target}/ticket`, { body: { contract: 'ticket-rmm-v1', organization_id: ORG_A, ticket_id: `T-${sfx}`, ticket_url: 'http://tickets.example/1' } });
  check(r.status === 400, 'a ticket URL that is not https is refused', JSON.stringify(r.body));
  r = await call('POST', `/api/integration/v1/alerts/${target}/ticket`, { body: { contract: 'ticket-rmm-v1', organization_id: ORG_A, ticket_id: `T-${sfx}`, ticket_url: `https://tickets.example/T-${sfx}` } });
  check(r.status === 201 && r.body.ticket?.id === `T-${sfx}` && Alert.safeParse(r.body).success, 'ClientSt0r links its ticket', JSON.stringify(r.body).slice(0, 300));
  r = await call('POST', `/api/integration/v1/alerts/${target}/ticket`, { body: { contract: 'ticket-rmm-v1', organization_id: ORG_A, ticket_id: `T-${sfx}`, ticket_url: `https://tickets.example/T-${sfx}` } });
  check(r.status === 200, 'the same link again is idempotent', JSON.stringify(r.body).slice(0, 200));
  r = await call('POST', `/api/integration/v1/alerts/${target}/ticket`, { body: { contract: 'ticket-rmm-v1', organization_id: ORG_A, ticket_id: `T-other-${sfx}` } });
  check(r.status === 409 && r.body.error?.code === 'TICKET_ALREADY_LINKED', 'a different ticket is a conflict', JSON.stringify(r.body));
  r = await call('POST', `/api/integration/v1/alerts/${bAlert?.id}/ticket`, { body: { contract: 'ticket-rmm-v1', organization_id: ORG_A, ticket_id: `T-b-${sfx}` } });
  check(r.status === 404, 'Birch\'s alert id is 404 to Acme\'s organization', JSON.stringify(r.body));
  r = await req('GET', `/monitoring/alerts/${target}`, { s: S.owen, business: acme.id });
  check(r.data?.ticket?.id === `T-${sfx}`, 'Acme\'s owner sees the linked ticket on the alert', msg(r));
  const st = (await prisma.monitorAlert.findUnique({ where: { id: target } }))?.state;
  check(st !== 'ACKNOWLEDGED' || (await prisma.monitorAlertEvent.count({ where: { alertId: target, type: 'acknowledged', actorId: null } })) === 0, 'linking a ticket does not acknowledge or resolve anything');
  const after = await call('GET', `/api/integration/v1/alerts/events?organization_id=${ORG_A}&after=${seqs.at(-1)}`);
  check(after.body.events.some((e) => e.alert_event.type === 'alert.updated' && e.alert_event.alert.ticket?.id === `T-${sfx}`), 'and ClientSt0r gets an alert.updated carrying it', JSON.stringify(after.body).slice(0, 300));

  section('Software inventory and change history');
  const invCmd = async (ep, inventory) => {
    await prisma.endpointCommand.deleteMany({ where: { endpointId: ep.id } });
    const hb = await heartbeat(ep, live(50_000));
    const c = hb.data?.commands?.find((x) => x.type === 'INVENTORY_REFRESH');
    if (!c) return { status: 0, body: hb.body };
    return req('POST', '/enrollment/command-result', { body: { rustdeskId: ep.rid, agentSecret: ep.secret, commandId: c.id, ok: true, inventory } });
  };
  const base = { manufacturer: 'Dell', model: 'OptiPlex 7090', memoryTotalMb: 16384, osBuild: '19045', disks: [{ drive: 'C:', totalBytes: 512e9, freeBytes: 100e9 }], networks: [{ name: 'Ethernet', mac: 'AA-BB' }], software: [{ name: '7-Zip 23.01', version: '23.01', publisher: 'Igor Pavlov' }, { name: 'Google Chrome', version: '120.0', publisher: 'Google LLC' }] };
  r = await invCmd(pcs[0], base);
  check(r.status === 200, 'the first inventory pass (with software) is accepted', msg(r));
  check((await prisma.endpointChange.count({ where: { endpointId: pcs[0].id } })) === 0, 'the first pass is the baseline: no history');
  await prisma.endpointInventory.update({ where: { endpointId: pcs[0].id }, data: { collectedAt: new Date(Date.now() - 7 * 3600_000) } });
  await invCmd(pcs[0], { ...base, memoryTotalMb: 32768, software: [{ name: '7-Zip 23.01', version: '24.08', publisher: 'Igor Pavlov' }, { name: 'AnyDesk', version: '8.0', publisher: 'AnyDesk Software GmbH' }] });
  const changes = await prisma.endpointChange.findMany({ where: { endpointId: pcs[0].id } });
  const has = (cat, ch, subj) => changes.some((c) => c.category === cat && c.change === ch && c.subject.includes(subj));
  check(has('software', 'added', 'AnyDesk') && has('software', 'removed', 'Chrome') && has('software', 'changed', '7-Zip'), 'installed, removed and updated software are recorded', JSON.stringify(changes.map((c) => `${c.category}:${c.change}:${c.subject}`)));
  check(has('hardware', 'changed', 'memory'), 'and the memory upgrade');
  r = await req('GET', `/monitoring/endpoints/${pcs[0].id}`, { s: S.tom, business: acme.id });
  check(r.status === 200 && r.data.softwareCount === 2 && r.data.changes.length >= 4, 'Tom (assigned HQ-PC1) sees its software and history', msg(r));
  r = await req('GET', `/monitoring/endpoints/${pcs[1].id}`, { s: S.tom, business: acme.id });
  check(r.status === 404, 'but not HQ-PC2\'s', msg(r));

  section('Removing a monitor closes its alerts');
  await report(fdA, { services: [{ name: 'Spooler', status: 'Stopped' }] });
  const before2 = await openAlert(fdA.id, 'spooler');
  const sRule = await prisma.monitorRule.findFirst({ where: { scopeKey: `b:${acme.id}`, key: 'spooler' } });
  r = await req('DELETE', `/monitoring/rules/${sRule.id}`, { s: S.cora, business: acme.id });
  check(r.status === 200, 'the service monitor is removed', msg(r));
  const closed = await until(async () => (await prisma.monitorAlert.findUnique({ where: { id: before2.id } }))?.state === 'RESOLVED');
  check(closed, 'its open alert is closed by the sweep, saying why', '');
  r = await req('DELETE', `/monitoring/rules/${created.globalRules[0]}`, { s: S.owen, business: acme.id });
  check(r.status === 403, 'a Business Owner cannot remove a global monitor', msg(r));
  r = await req('PATCH', `/monitoring/rules/${acmeDiskRule.id}`, { s: S.cora, business: acme.id, body: { params: { minFreePercent: 95 } } });
  check(r.status === 400, 'a patch with out-of-range params is refused', msg(r));

  section('Audit');
  const audit = await prisma.activityLog.groupBy({ by: ['action'], where: { customerId: { in: [acme.id, birch.id] }, action: { in: ['MONITOR_RULE_CHANGED', 'MONITOR_SUPPRESSION_CHANGED', 'MONITOR_NOTIFY_POLICY_CHANGED', 'MONITOR_ALERT_ACKNOWLEDGED', 'MONITOR_ALERT_RESOLVED', 'MONITOR_ALERT_TICKET_LINKED'] } }, _count: true });
  const A = Object.fromEntries(audit.map((x) => [x.action, x._count]));
  check(A.MONITOR_RULE_CHANGED >= 4 && A.MONITOR_SUPPRESSION_CHANGED >= 2 && A.MONITOR_NOTIFY_POLICY_CHANGED >= 1 && A.MONITOR_ALERT_ACKNOWLEDGED >= 1 && A.MONITOR_ALERT_RESOLVED >= 1 && A.MONITOR_ALERT_TICKET_LINKED >= 1, 'rule, window, policy, acknowledge, resolve and ticket-link are all audited', JSON.stringify(A));
  const pol = await prisma.activityLog.findFirst({ where: { action: 'MONITOR_NOTIFY_POLICY_CHANGED', customerId: birch.id } });
  check(!!pol, 'Birch\'s policy change is audited under Birch');
  const gpol = await prisma.activityLog.findFirst({ where: { action: 'MONITOR_NOTIFY_POLICY_CHANGED', actorId: mgr.id }, orderBy: { createdAt: 'desc' } });
  check(gpol && !JSON.stringify(gpol.metadata).includes('/hook/l0'), 'audit records destination hosts, never a webhook URL\'s path', JSON.stringify(gpol?.metadata));
}

async function cleanup() {
  await stopApi();
  try {
    const ids = created.businesses;
    await prisma.containmentPause.updateMany({ where: { clearedAt: null, customerId: { in: ids } }, data: { clearedAt: new Date(), clearReason: 'e2e cleanup' } });
    await prisma.integrationAlertEvent.deleteMany({ where: { peerId: PEER } });
    await prisma.integrationOrgMapping.deleteMany({ where: { peerId: PEER } });
    // Global monitors also raised alerts on any other computer in the scratch database; take those with them.
    await prisma.monitorAlert.deleteMany({ where: { OR: [{ ruleId: { in: created.globalRules.filter(Boolean) } }, { customerId: { in: ids } }] } });
    await prisma.endpointMonitorState.deleteMany({ where: { ruleKey: { in: ['offline', 'disk-free'] } } });
    await prisma.monitorRule.deleteMany({ where: { id: { in: created.globalRules.filter(Boolean) } } });
    if (created.globalPolicy) await prisma.monitorNotifyPolicy.deleteMany({ where: { scopeKey: 'global' } });
    await prisma.monitorNotifyPolicy.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.technicianAssignment.deleteMany({ where: { customerId: { in: ids } } });
    const eps = await prisma.endpoint.findMany({ where: { customerId: { in: ids } }, select: { id: true } });
    await prisma.monitorAlert.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.rustdeskNode.deleteMany({ where: { endpointId: { in: eps.map((e) => e.id) } } });
    await prisma.endpoint.deleteMany({ where: { id: { in: eps.map((e) => e.id) } } });
    await prisma.site.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.membership.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.customer.deleteMany({ where: { id: { in: ids } } });
    if (created.users.length) await prisma.user.deleteMany({ where: { id: { in: created.users } } });
  } catch (e) { console.error('cleanup:', e.message); }
  await prisma.$disconnect();
  rmSync(work, { recursive: true, force: true });
}

all().catch((e) => { fail++; failures.push(`crashed: ${e.stack ?? e}`); console.error(e); if (api) console.error(api.log.slice(-3000)); })
  .finally(async () => {
    await cleanup();
    console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
    if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
    process.exit(0);
  });
