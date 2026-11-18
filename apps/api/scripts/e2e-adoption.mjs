#!/usr/bin/env node
/**
 * End-to-end proof of device discovery and adoption (0.57,
 * check-security-invariants §70), through the real routes.
 *
 *   - the unassigned pool: a computer that checks in on its own, or through a
 *     deployment key in review mode, is pooled (no tenant, no business), with
 *     how it arrived and the address the server saw; its heartbeat is handed
 *     only the automatic inventory — no rotation, update, reinstall, action,
 *     diagnostic, patch scan, chat or tray — even with all of those queued;
 *   - every remote and action path refuses a pooled computer for a Platform
 *     Admin (ENDPOINT_UNASSIGNED): session, connect, Connect script, password
 *     reveal/set/rotate, reinstall, agent update, launcher (computer and
 *     ad-hoc), Quick Connect, chat, actions, diagnostics, services, processes,
 *     software install/remove, patch install, RustDesk update staging, tray
 *     pairing, tray self-help and tray support requests — and nothing was
 *     written for it;
 *   - tenant isolation: the pool is invisible to Business Owners of every
 *     business, a Business User, a technician and an API key (list, detail,
 *     search, the adoption routes); a computer adopted into A is never
 *     visible to B;
 *   - deployment keys: Platform Admin only, fresh sign-in, shown once and
 *     stored as a hash, at most 90 days and 10,000 uses, review by default;
 *     the install scripts accept one, the claim lands review keys in the pool
 *     tagged with the key and active keys in their business; uses are counted
 *     conditionally (parallel claims never exceed the ceiling); a re-run is a
 *     no-op that uses nothing; a key for A cannot take a computer of B;
 *     revoked and expired keys are refused; single-use claim tokens still work;
 *   - assignment rules: Platform Admin only, fresh sign-in; deployment key,
 *     domain, CIDR and hostname prefix suggest a business and site with the
 *     rule that matched; conflicts are flagged; no rule can read who is
 *     signed in; nothing is applied by itself;
 *   - adoption: fresh sign-in, business + site + static groups, conditional
 *     (only from the unassigned state), audited per computer with the
 *     approver, before/after, key and rule; the device edit route cannot move
 *     a pooled computer; forget deletes only pooled junk, audited.
 *
 *   cd apps/api && npx nest build
 *   DATABASE_URL=postgresql://…/<name containing scratch or test> node scripts/e2e-adoption.mjs
 *
 * Self-starting: its API runs from dist/ on ADOPTION_API_PORT (3831).
 * Installs are posted the way the installers post them; nothing here ran an
 * installer on Windows, Linux or macOS.
 */
import { PrismaClient } from '@prisma/client';
import { confirmEverythingAsks } from './lib/confirm-asks.mjs';
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
const PORT = Number(process.env.ADOPTION_API_PORT ?? 3831);
if ([3000, 3001, 3201, 3202, 4000, 4001, 443].includes(PORT)) { console.error(`Refusing port ${PORT}`); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
const prisma = new PrismaClient();
// 0.64: every confirmation defaults to off. This suite proves step-ups, so it
// asks for them all before its API reads the policy.
await confirmEverythingAsks(prisma);
const sfx = randomBytes(3).toString('hex');
const TAG = `adopt-${sfx}`;
const PW = 'adoption-e2e-password-123';

let pass = 0, fail = 0;
const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const rid = () => String(100000000 + ((Math.random() * 899999999) | 0));
const J = (x) => JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? String(v) : v));

const env = {
  ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATABASE_URL: DB,
  JWT_SECRET: randomBytes(32).toString('hex'), LAUNCHER_TOKEN_SECRET: randomBytes(32).toString('hex'),
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? randomBytes(32).toString('hex'), TRUSTED_PROXIES: 'loopback', HBBS_PRESENCE_HOST: '127.0.0.2',
  VERSION_FILE: path.resolve(here, '..', '..', '..', 'version.json'),
  MONITOR_SWEEP: 'off', AUDIT_SEALER: 'off', CLIENT_UPDATE_SWEEP: 'off', SNAPSHOT_SWEEP: 'off', PATCH_POLICY_SWEEP: 'off', METRIC_SWEEP: 'off',
  AUTO_MIGRATION_SWEEP: 'off', TRAY_SWEEP: 'off', RETENTION_SWEEP: 'off', CHAT_RETENTION_SWEEP: 'off', STALE_SWEEP: 'off', AGENT_AUTO_UPDATE: 'off',
  REPORT_SCHEDULE_SWEEP: 'off', SCRIPT_OUTPUT_SWEEP: 'off', WINGET_INDEX_SWEEP: 'off',
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

// Paced under the 20 req/s burst throttler; a fresh address per request keeps
// the per-minute route limits per request. `from` pins the address (the
// source a CIDR rule matches).
let last = 0;
async function req(method, p, { s, body, bearer, from, raw = false } = {}) {
  const wait = last + 55 - Date.now(); if (wait > 0) await sleep(wait); last = Date.now();
  const h = { 'content-type': 'application/json', 'x-forwarded-for': from ?? ip() };
  if (s) h.cookie = s.cookie;
  if (bearer) h.authorization = `Bearer ${bearer}`;
  const r = await fetch(`${API}${p}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  if (raw) return { status: r.status, text };
  let j; try { j = JSON.parse(text); } catch { j = text; }
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
const unassignedRefusal = (r) => r.status === 403 && code(r) === 'ENDPOINT_UNASSIGNED';
const stepUpRefusal = (r) => r.status === 403 && code(r) === 'STEP_UP_REQUIRED';

const created = { businesses: [], users: [], endpoints: new Set(), keys: [], apiKeys: [] };
let originalPin = null, originalQc = null;

/** A heartbeat the way heartbeat.ps1 posts one (live state = a real heartbeat, not an installer's check-in). */
const beat = (c, extra = {}, from) => req('POST', '/enrollment/heartbeat', { from, body: {
  rustdeskId: c.rid, agentSecret: c.secret, hostname: c.hostname, platform: 'Windows', osVersion: 'Microsoft Windows NT 10.0.22631.0',
  agentVersion: '0.56.0', rustdeskVersion: '1.4.6', loggedOnUser: 'ACME\\bob', uptimeSeconds: 3600, cpuLoadPercent: 5, memoryTotalMb: 16000, memoryFreeMb: 8000,
  rustdeskSessions: 0, ...extra } });
/** The claim the installers post (install.ps1 Register, linux.sh, macos.sh). */
const claim = (c, token, from) => req('POST', '/enrollment/claim', { from, body: {
  token, rustdeskId: c.rid, hostname: c.hostname, platform: 'Windows', osVersion: 'Microsoft Windows NT 10.0.22631.0', password: 'Perm-Password-1', agentSecret: c.secret } });
const mkComputer = (hostname) => ({ rid: rid(), secret: randomBytes(24).toString('hex'), hostname });
const epOf = async (c) => {
  const n = await prisma.rustdeskNode.findUnique({ where: { rustdeskId: c.rid }, select: { endpointId: true, tenantId: true } });
  if (n?.endpointId) created.endpoints.add(n.endpointId);
  return n ? prisma.endpoint.findUnique({ where: { id: n.endpointId }, include: { rustdeskNode: true, groupMemberships: true } }) : null;
};

async function all() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });
  const roleUser = await prisma.role.findFirst({ where: { type: 'BUSINESS_USER' } });
  const ps = await prisma.platformSettings.findUnique({ where: { id: 'singleton' } });
  originalPin = ps?.rustdeskPinnedVersion ?? null; originalQc = ps?.quickConnectEnabled ?? null;
  await prisma.platformSettings.upsert({ where: { id: 'singleton' }, update: { rustdeskPinnedVersion: '9.9.9', quickConnectEnabled: true }, create: { id: 'singleton', rustdeskPinnedVersion: '9.9.9', quickConnectEnabled: true } });

  section('Fixtures (synthetic): businesses A and B, their owners, a Business User and a technician of A, a Platform Admin, an API key of A');
  const A = await prisma.customer.create({ data: { tenantId: tenant.id, name: `${TAG} Acme` } });
  const B = await prisma.customer.create({ data: { tenantId: tenant.id, name: `${TAG} Birch` } });
  created.businesses.push(A.id, B.id);
  const siteA = await prisma.site.create({ data: { tenantId: tenant.id, customerId: A.id, name: `${TAG} HQ` } });
  const siteB = await prisma.site.create({ data: { tenantId: tenant.id, customerId: B.id, name: `${TAG} Depot` } });
  const groupA = await prisma.endpointGroup.create({ data: { tenantId: tenant.id, customerId: A.id, name: `${TAG} Laptops` } });
  const groupB = await prisma.endpointGroup.create({ data: { tenantId: tenant.id, customerId: B.id, name: `${TAG} Tills` } });
  const ruleGroupA = await prisma.endpointGroup.create({ data: { tenantId: tenant.id, customerId: A.id, name: `${TAG} Rule`, kind: 'RULE', rule: { platform: 'windows' } } });
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag, extra = {}) => { const u = await prisma.user.create({ data: { email: `adopt-${tag}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'Adopt', lastName: tag, status: 'ACTIVE', ...extra } }); created.users.push(u.id); return u; };
  const admin = await mkUser('admin', { isPlatformAdmin: true });
  const ownerA = await mkUser('owner-a'), ownerB = await mkUser('owner-b'), userA = await mkUser('user-a'), techA = await mkUser('tech-a');
  await prisma.membership.create({ data: { userId: ownerA.id, tenantId: tenant.id, customerId: A.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: ownerB.id, tenantId: tenant.id, customerId: B.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: userA.id, tenantId: tenant.id, customerId: A.id, roleId: roleUser.id, capabilities: ['computers:view', 'computers:add', 'computers:edit', 'computers:connect'] } });
  await prisma.technicianAssignment.create({ data: { tenantId: tenant.id, customerId: A.id, userId: techA.id, capabilities: ['computers:view', 'computers:edit'], endpointIds: [] } });
  const rawApiKey = `rk_${randomBytes(24).toString('hex')}`;
  const apiKey = await prisma.apiKey.create({ data: { tenantId: tenant.id, customerId: A.id, createdById: ownerA.id, name: `${TAG} key`, keyHash: sha(rawApiKey), keyPrefix: rawApiKey.slice(0, 12), scopes: ['computers:read', 'enrollment:write'] } });
  created.apiKeys.push(apiKey.id);
  // One assigned computer in B, with a device secret, for the cross-business claims.
  const bComputer = mkComputer(`${TAG}-B-TILL1`);
  {
    const e = await prisma.endpoint.create({ data: { tenantId: tenant.id, customerId: B.id, siteId: siteB.id, name: bComputer.hostname, hostname: bComputer.hostname, platform: 'Windows', status: 'ACTIVE', isOnline: true, isManaged: true, accessMode: 'COMPANY_WIDE', lastSeenAt: new Date() } });
    await prisma.rustdeskNode.create({ data: { tenantId: tenant.id, endpointId: e.id, rustdeskId: bComputer.rid, agentSecretHash: sha(bComputer.secret) } });
    created.endpoints.add(e.id); bComputer.id = e.id;
  }

  await startApi();
  const S = { admin: await login(admin.email), ownerA: await login(ownerA.email), ownerB: await login(ownerB.email), userA: await login(userA.email), techA: await login(techA.email) };
  const F = { admin: await stepUp(S.admin), ownerA: await stepUp(S.ownerA) };

  // ── The pool ──────────────────────────────────────────────────────────────
  section('A computer that checks in on its own is pooled: no tenant, no business, how it arrived and from where');
  const stray = mkComputer(`${TAG}-STRAY1`);
  let r = await beat(stray, {}, '203.0.113.7');
  check(ok(r) && r.data.found === false, 'first heartbeat with a device secret creates a pooled computer', msg(r));
  let e = await epOf(stray);
  check(e && e.tenantId === null && e.customerId === null && e.status === 'PENDING_ENROLLMENT' && e.arrivedVia === 'heartbeat' && e.sourceIp === '203.0.113.7' && e.rustdeskNode.tenantId === null,
    'pooled: tenant and business null, PENDING_ENROLLMENT, arrivedVia heartbeat, sourceIp the address the server saw', J({ t: e?.tenantId, c: e?.customerId, s: e?.status, a: e?.arrivedVia, ip: e?.sourceIp }));
  stray.id = e.id;
  const installerOnly = mkComputer(`${TAG}-STRAY2`);
  r = await req('POST', '/enrollment/heartbeat', { from: '198.51.100.20', body: { rustdeskId: installerOnly.rid, agentSecret: installerOnly.secret, hostname: installerOnly.hostname, platform: 'Windows', password: 'x-Perm-1', agentVersion: '0.56.0' } });
  e = await epOf(installerOnly); installerOnly.id = e.id;
  check(ok(r) && e.arrivedVia === 'install_script', "an installer's own check-in (no live state) is recorded as install_script", J({ a: e?.arrivedVia }));
  r = await req('POST', '/enrollment/heartbeat', { body: { rustdeskId: rid(), hostname: 'nobody' } });
  check(r.status === 401, 'without a device secret nothing is created (unchanged)', msg(r));

  section('A pooled computer is handed nothing to do, whatever is queued for it');
  await prisma.rustdeskNode.update({ where: { endpointId: stray.id }, data: { pendingPassword: 'deadbeef:deadbeef:deadbeef', pendingPasswordAt: new Date(), reinstallRequestedAt: new Date(), updateRequestedAt: new Date(), updateTargetVersion: '9.9.9', updateRequestSource: 'MANUAL' } });
  r = await beat(stray, { updateChannel: 'signed', agentActions: ['windows.spooler.start@1'], agentChat: 2, agentTray: 1, trustRootVersion: 1, targetsVersion: 1, agentSha256: 'c'.repeat(64) });
  check(ok(r) && r.data.pending === true && r.data.rotate === null && r.data.reinstallAgent === null && r.data.updateRustdesk === null
    && (r.data.actions ?? []).length === 0 && r.data.patchScan === false && r.data.monitor === null && (r.data.diagnostics ?? []).length === 0 && r.data.chat === null && r.data.tray === null,
  'pending: no rotation, reinstall, RustDesk update, action, patch scan, monitor, diagnostic, chat or tray', msg(r));
  const cmdTypes = (r.data?.commands ?? []).map((c) => c.type);
  check(cmdTypes.every((t) => ['INVENTORY_REFRESH', 'UPDATE_SCAN'].includes(t)), `only the automatic read-only collections are handed out (${cmdTypes.join(', ') || 'none this beat'})`, J(cmdTypes));
  const cmds = await prisma.endpointCommand.findMany({ where: { endpointId: stray.id } });
  check(cmds.every((c) => c.requestedById === null), 'every command staged for it is automatic (no requester)', J(cmds.map((c) => c.type)));
  const live = await prisma.endpointInventory.findUnique({ where: { endpointId: stray.id } });
  check(!!live?.liveSampledAt, 'its live sample is recorded (inspection)', J(live));
  await prisma.rustdeskNode.update({ where: { endpointId: stray.id }, data: { pendingPassword: null, pendingPasswordAt: null, reinstallRequestedAt: null, updateRequestedAt: null, updateTargetVersion: null, updateRequestSource: null } });
  r = await beat(stray, {}, '203.0.113.9');
  e = await epOf(stray);
  check(e.sourceIp === '203.0.113.9', 'its source address follows its heartbeats while it is pooled', e.sourceIp);

  // ── Every remote and action path refuses a pooled computer ────────────────
  section('Every remote and action path refuses it, for a Platform Admin with a fresh sign-in (ENDPOINT_UNASSIGNED)');
  const P = stray.id;
  const fresh = { s: F.admin };
  const refusals = [
    ['POST /sessions', () => req('POST', '/sessions', { ...fresh, body: { endpointId: P } })],
    ['POST /endpoints/:id/connect', () => req('POST', `/endpoints/${P}/connect`, fresh)],
    ['GET /endpoints/:id/connect.cmd', () => req('GET', `/endpoints/${P}/connect.cmd`, fresh)],
    ['GET /endpoints/:id/password (reveal)', () => req('GET', `/endpoints/${P}/password`, fresh)],
    ['PATCH /endpoints/:id/password', () => req('PATCH', `/endpoints/${P}/password`, { ...fresh, body: { password: 'Something-1' } })],
    ['POST /endpoints/:id/rotate-credential', () => req('POST', `/endpoints/${P}/rotate-credential`, fresh)],
    ['POST /endpoints/:id/reinstall-agent', () => req('POST', `/endpoints/${P}/reinstall-agent`, fresh)],
    ['POST /endpoints/:id/agent/update', () => req('POST', `/endpoints/${P}/agent/update`, fresh)],
    ['POST /launcher/token (computer)', () => req('POST', '/launcher/token', { ...fresh, body: { endpointId: P } })],
    ['POST /launcher/token (ad hoc, its Remote ID)', () => req('POST', '/launcher/token', { ...fresh, body: { adHocRustdeskId: stray.rid } })],
    ['POST /quick-connect/connect (its Remote ID)', () => req('POST', '/quick-connect/connect', { ...fresh, body: { rustdeskId: stray.rid, password: 'shown-on-screen' } })],
    ['POST /endpoints/:id/actions', () => req('POST', `/endpoints/${P}/actions`, { ...fresh, body: { actionId: 'windows.service.start', version: 1, params: {}, reason: 'e2e: pooled computer' } })],
    ['POST /endpoints/:id/diagnostics/runs', () => req('POST', `/endpoints/${P}/diagnostics/runs`, { ...fresh, body: { key: 'disk_space' } })],
    ['POST /endpoints/:id/services/control', () => req('POST', `/endpoints/${P}/services/control`, { ...fresh, body: { service: 'Spooler', displayName: 'Print Spooler', op: 'restart', reason: 'e2e pooled' } })],
    ['POST /endpoints/:id/processes/stop', () => req('POST', `/endpoints/${P}/processes/stop`, { ...fresh, body: { pid: 4242, name: 'notepad.exe', startedAt: '2026-11-16T10:00:00.000Z', reason: 'e2e pooled' } })],
    ['POST /endpoints/:id/software/winget-install', () => req('POST', `/endpoints/${P}/software/winget-install`, { ...fresh, body: { packageId: '7zip.7zip' } })],
    ['POST /endpoints/:id/software/remove-program', () => req('POST', `/endpoints/${P}/software/remove-program`, { ...fresh, body: { key: '7-Zip', view: '64', displayName: '7-Zip 24.08 (x64)' } })],
    ['POST /endpoints/:id/patches/install', () => req('POST', `/endpoints/${P}/patches/install`, { ...fresh, body: { updates: [{ updateId: '12345678-1234-1234-1234-123456789abc', revision: 1 }], reason: 'e2e pooled' } })],
  ];
  for (const [name, call] of refusals) {
    const x = await call();
    check(unassignedRefusal(x), `${name}: refused`, msg(x));
  }
  r = await req('POST', `/endpoints/${P}/chat/conversations`, { ...fresh, body: {} });
  check(r.status === 409 && code(r) === 'CHAT_UNSUPPORTED', 'POST /endpoints/:id/chat/conversations: refused (CHAT_UNSUPPORTED: assign it to a business first)', msg(r));
  r = await req('POST', '/admin/update/rustdesk', { ...fresh, body: { endpointIds: [P] } });
  const staged = await prisma.rustdeskNode.findUnique({ where: { endpointId: P }, select: { updateRequestedAt: true } });
  check(r.status === 404 && !staged.updateRequestedAt, 'POST /admin/update/rustdesk naming it: nothing staged (No matching endpoints)', msg(r));
  r = await req('POST', '/endpoints/bulk', { ...fresh, body: { action: 'agent.update', endpointIds: [P] } });
  const bulkRow = (r.data?.results ?? []).find((x) => x.endpointId === P);
  check(r.status >= 400 || (bulkRow && bulkRow.result !== 'done' && bulkRow.status !== 'done' && bulkRow.ok !== true), 'POST /endpoints/bulk agent.update naming it: not done', msg(r));
  r = await req('PATCH', `/endpoints/${P}`, { ...fresh, body: { customerId: A.id } });
  e = await epOf(stray);
  check(r.status === 400 && code(r) === 'USE_ADOPTION' && e.customerId === null, 'PATCH /endpoints/:id { customerId }: refused (USE_ADOPTION), still pooled', msg(r));

  section('The tray on a pooled computer: no pairing, no self-help, no support request');
  r = await req('POST', '/tray/pair', { body: { rustdeskId: installerOnly.rid, agentSecret: installerOnly.secret } });
  check(unassignedRefusal(r), 'POST /tray/pair (standard): refused', msg(r));
  r = await req('POST', '/tray/self-help/begin', { body: { rustdeskId: stray.rid, agentSecret: stray.secret, tool: 'dns.check' } });
  check(unassignedRefusal(r), 'POST /tray/self-help/begin (signed): refused', msg(r));
  r = await req('POST', '/tray/support-requests', { body: { rustdeskId: stray.rid, agentSecret: stray.secret, description: 'help' } });
  check(unassignedRefusal(r), 'POST /tray/support-requests (signed): refused', msg(r));
  r = await req('POST', '/tray/status', { body: { rustdeskId: stray.rid, agentSecret: stray.secret } });
  check(ok(r) && r.data.hasBusiness === false, 'POST /tray/status still answers, with hasBusiness false', msg(r));

  const traces = await Promise.all([
    prisma.supportSession.count({ where: { endpointId: P } }), prisma.connectionGrant.count({ where: { endpointId: P } }),
    prisma.actionTarget.count({ where: { endpointId: P } }), prisma.diagnosticRun.count({ where: { endpointId: P } }),
    prisma.chatConversation.count({ where: { endpointId: P } }), prisma.agentMigration.count({ where: { endpointId: P } }),
    prisma.traySelfHelpRun.count({ where: { endpointId: P } }), prisma.endpoint.count({ where: { id: P, trayKeyId: { not: null } } }),
    prisma.endpoint.count({ where: { id: installerOnly.id, trayKeyId: { not: null } } }),
  ]);
  check(traces.every((n) => n === 0), 'nothing was written for it: no session, grant, action target, diagnostic run, chat, migration, self-help run or tray key', J(traces));
  const node = await prisma.rustdeskNode.findUnique({ where: { endpointId: P } });
  check(!node.pendingPassword && !node.reinstallRequestedAt && !node.updateRequestedAt, 'no rotation, reinstall or update was staged on its node');

  // ── Tenant isolation: the pool ────────────────────────────────────────────
  section('The pool is invisible to every role but Platform Admin, and to an API key');
  const pooledIds = [stray.id, installerOnly.id];
  for (const [who, s] of [['owner A', S.ownerA], ['owner B', S.ownerB], ['Business User A', S.userA], ['technician of A', S.techA]]) {
    for (const p of ['/adoption/devices', '/adoption/mappings', '/adoption/deployment-keys', '/admin/unassigned-devices']) {
      r = await req('GET', p, { s });
      check(r.status === 403 || r.status === 401, `${who}: GET ${p} is refused`, msg(r));
    }
    r = await req('GET', '/endpoints/list?pageSize=200', { s });
    check(r.status === 200 && !pooledIds.some((id) => r.text.includes(id)), `${who}: the device list does not include a pooled computer`, msg(r));
    r = await req('GET', '/endpoints/list?pageSize=200&businessId=null', { s });
    check(r.status !== 200 || !pooledIds.some((id) => r.text.includes(id)), `${who}: nor when it asks for businessId=null`, msg(r));
    r = await req('GET', `/endpoints/${stray.id}`, { s });
    check(r.status === 404 || r.status === 403, `${who}: GET /endpoints/:pooled is a 404`, msg(r));
    r = await req('GET', `/search?q=${encodeURIComponent(TAG + '-STRAY')}`, { s });
    check(!pooledIds.some((id) => r.text.includes(id)) && !r.text.includes(`${TAG}-STRAY1`), `${who}: search does not find it`, msg(r));
  }
  r = await req('GET', '/pub/v1/computers?limit=200', { bearer: rawApiKey });
  check(r.status === 200 && !pooledIds.some((id) => r.text.includes(id)), 'API key of A: /pub/v1/computers does not include a pooled computer', msg(r));
  r = await req('GET', `/pub/v1/computers/${stray.id}`, { bearer: rawApiKey });
  check(r.status === 404 || r.status === 403, 'API key of A: /pub/v1/computers/:pooled is refused', msg(r));
  r = await req('GET', '/adoption/devices', { bearer: rawApiKey });
  check(r.status === 401 || r.status === 403, 'API key of A: /adoption/devices is refused', msg(r));
  r = await req('GET', '/adoption/devices', { s: S.admin });
  check(ok(r) && pooledIds.every((id) => r.data.computers.some((c) => c.id === id)), 'Platform Admin: GET /adoption/devices lists both', msg(r));
  check(!/loggedOnUser|agentSecretHash|"bob"|ACME\\\\bob/.test(r.text), 'the list carries no signed-in user and no secret hash', r.text.slice(0, 200));

  // ── Deployment keys ───────────────────────────────────────────────────────
  section('Deployment keys: Platform Admin only, fresh sign-in, shown once, stored as a hash');
  const keyBody = (o = {}) => ({ businessId: A.id, name: `${TAG} GPO`, maxUses: 50, expiresInDays: 30, ...o });
  r = await req('POST', '/adoption/deployment-keys', { s: F.ownerA, body: keyBody() });
  check(r.status === 403 && code(r) !== 'STEP_UP_REQUIRED', "owner A (fresh): refused — a key is a Platform Admin's", msg(r));
  r = await req('POST', '/adoption/deployment-keys', { s: S.admin, body: keyBody() });
  check(stepUpRefusal(r) && r.body?.action === 'deployment.keys', 'Platform Admin without a fresh sign-in: STEP_UP_REQUIRED (deployment.keys)', msg(r));
  for (const [bad, why] of [
    [keyBody({ expiresInDays: 91 }), 'longer than 90 days'], [keyBody({ maxUses: 0 }), 'no uses'], [keyBody({ maxUses: 10001 }), 'more than 10,000 uses'],
    [keyBody({ siteId: siteB.id }), "another business's site"], [keyBody({ endpointGroupId: groupB.id }), "another business's group"],
    [keyBody({ endpointGroupId: ruleGroupA.id }), 'a rule group'], [keyBody({ mode: 'auto' }), 'an unknown mode'], [keyBody({ name: '<script>' }), 'markup in the name'],
    [{ ...keyBody(), customerId: B.id }, 'an extra field'],
  ]) {
    r = await req('POST', '/adoption/deployment-keys', { s: F.admin, body: bad });
    check(r.status === 400, `refused: ${why}`, msg(r));
  }
  check(await prisma.deploymentKey.count({ where: { customerId: { in: [A.id, B.id] } } }) === 0, 'nothing was stored by a refusal');
  r = await req('POST', '/adoption/deployment-keys', { s: F.admin, body: keyBody({ siteId: siteA.id }) });
  const reviewKey = r.data;
  check(r.status === 201 && /^[0-9a-f]{96}$/.test(reviewKey?.key ?? '') && reviewKey.mode === 'review' && reviewKey.keyHint === reviewKey.key.slice(-4) && !('keyHash' in reviewKey),
    'created: 96 hex characters, review by default, the last four as a hint, no hash in the answer', msg(r));
  created.keys.push(reviewKey.id);
  const row = await prisma.deploymentKey.findUnique({ where: { id: reviewKey.id } });
  check(row.keyHash === sha(reviewKey.key) && !J(row).includes(reviewKey.key), 'stored: only the SHA-256 (the key itself is nowhere in the row)', J(row));
  const aud = await prisma.activityLog.findFirst({ where: { action: 'DEPLOYMENT_KEY_CREATED', resourceId: reviewKey.id } });
  check(aud && aud.actorId === admin.id && !J(aud).includes(reviewKey.key) && aud.metadata?.stepUpMethod === 'password', 'audited (DEPLOYMENT_KEY_CREATED) with the step-up method and without the key', J(aud?.metadata));
  r = await req('GET', '/adoption/deployment-keys', { s: S.admin });
  check(ok(r) && r.data.some((k) => k.id === reviewKey.id && k.state === 'usable') && !r.text.includes(reviewKey.key) && !r.text.includes(row.keyHash), 'the list shows it as usable, with neither the key nor its hash', msg(r));
  r = await req('POST', '/adoption/deployment-keys', { s: F.admin, body: keyBody({ name: `${TAG} Intune`, mode: 'active', endpointGroupId: groupA.id, siteId: siteA.id, accessMode: 'COMPANY_WIDE' }) });
  const activeKey = r.data; created.keys.push(activeKey?.id);
  check(r.status === 201 && activeKey.mode === 'active', 'an active key (an explicit choice) for A, with a site and a static group', msg(r));
  r = await req('POST', '/adoption/deployment-keys', { s: F.admin, body: { businessId: B.id, name: `${TAG} B rollout`, maxUses: 2, expiresInDays: 7 } });
  const keyB = r.data; created.keys.push(keyB?.id);
  check(r.status === 201, 'a review key for B (two uses)', msg(r));

  section('The installers accept a deployment key exactly as they accept a claim token');
  r = await req('GET', `/public/install/linux/${reviewKey.key}`, { raw: true });
  check(r.status === 200 && r.text.includes(`CLAIM_TOKEN="${reviewKey.key}"`), 'linux.sh carries the key', `HTTP ${r.status}`);
  r = await req('GET', `/public/install/mac/${reviewKey.key}`, { raw: true });
  check(r.status === 200 && r.text.includes(`CLAIM_TOKEN="${reviewKey.key}"`), 'macos.sh carries the key', `HTTP ${r.status}`);
  r = await req('GET', `/public/install/win/${reviewKey.key}`, { raw: true });
  check(r.status === 200 && r.text.includes(reviewKey.key), 'windows.ps1 carries the key', `HTTP ${r.status}`);
  r = await req('GET', `/public/install/linux/${'ab'.repeat(48)}`, { raw: true });
  check(r.status === 200 && r.text.includes('CLAIM_TOKEN=""'), 'an unknown 96-hex value is not baked into a script', `HTTP ${r.status}`);

  section('Review key: the computer lands in the pool, tagged with the key; a re-run is a no-op');
  const gpo1 = mkComputer(`${TAG}-GPO1`);
  r = await claim(gpo1, reviewKey.key, '192.0.2.44');
  e = await epOf(gpo1); gpo1.id = e?.id;
  check(ok(r) && r.data.pending === true && !('endpoint' in r.data) && !r.text.includes(A.id), 'claim answers { pending: true } and says nothing about the business', msg(r));
  check(e && e.tenantId === null && e.customerId === null && e.deploymentKeyId === reviewKey.id && e.arrivedVia === 'deployment_key' && e.sourceIp === '192.0.2.44' && e.rustdeskNode.agentSecretHash === sha(gpo1.secret),
    'pooled, tagged with the key, arrivedVia deployment_key, its device secret bound', J({ t: e?.tenantId, c: e?.customerId, k: e?.deploymentKeyId, a: e?.arrivedVia }));
  let used = await prisma.deploymentKey.findUnique({ where: { id: reviewKey.id } });
  check(used.useCount === 1 && !!used.lastUsedAt, 'one use counted', J(used));
  const useAudit = await prisma.activityLog.findFirst({ where: { action: 'DEPLOYMENT_KEY_USED', resourceId: gpo1.id } });
  check(useAudit && useAudit.customerId === null && useAudit.tenantId === null && useAudit.metadata?.outcome === 'pending', 'audited DEPLOYMENT_KEY_USED, platform-level (not the business\'s yet)', J(useAudit));
  r = await claim(gpo1, reviewKey.key);
  used = await prisma.deploymentKey.findUnique({ where: { id: reviewKey.id } });
  check(ok(r) && r.data.pending === true && r.data.unchanged === true && used.useCount === 1, 'the GPO script re-running on the next boot: unchanged, no use counted', msg(r));
  r = await claim({ ...gpo1, secret: randomBytes(24).toString('hex') }, reviewKey.key);
  check(r.status === 400, 'the same Remote ID with another device secret: refused', msg(r));
  r = await beat(gpo1);
  check(ok(r) && r.data.pending === true, 'its heartbeat is pending like any pooled computer', msg(r));

  section('Active key: the computer lands ACTIVE in the key\'s business, site and group');
  const intune1 = mkComputer(`${TAG}-INTUNE1`);
  r = await claim(intune1, activeKey.key);
  e = await epOf(intune1); intune1.id = e?.id;
  check(ok(r) && r.data.enrolled === true, 'claim answers { enrolled: true }', msg(r));
  check(e && e.tenantId === tenant.id && e.customerId === A.id && e.siteId === siteA.id && e.status === 'ACTIVE' && e.accessMode === 'COMPANY_WIDE' && e.groupMemberships.some((m) => m.endpointGroupId === groupA.id) && e.rustdeskNode.tenantId === tenant.id,
    "in A, at the key's site, in its group, with its access mode", J({ c: e?.customerId, s: e?.siteId, st: e?.status, g: e?.groupMemberships }));
  r = await claim(intune1, activeKey.key);
  check(ok(r) && r.data.unchanged === true && (await prisma.deploymentKey.findUnique({ where: { id: activeKey.id } })).useCount === 1, 're-run: unchanged, no use counted', msg(r));
  r = await req('GET', '/endpoints/list?pageSize=200', { s: S.ownerA });
  check(r.text.includes(intune1.id), 'owner A sees it');
  r = await req('GET', '/endpoints/list?pageSize=200', { s: S.ownerB });
  check(!r.text.includes(intune1.id) && !r.text.includes(gpo1.id), 'owner B sees neither it nor the review-key computer');

  section("A key for A cannot take a computer of B, and B's key enrols nothing into A");
  r = await claim(bComputer, activeKey.key);
  e = await prisma.endpoint.findUnique({ where: { id: bComputer.id } });
  check(r.status === 400 && e.customerId === B.id && e.siteId === siteB.id, "A's active key on B's computer (with its real device secret): refused, it stays in B", msg(r));
  r = await claim(bComputer, reviewKey.key);
  e = await prisma.endpoint.findUnique({ where: { id: bComputer.id } });
  check(r.status === 400 && e.customerId === B.id && e.tenantId === tenant.id, "A's review key on B's computer: refused, not pulled into the pool", msg(r));
  r = await claim(intune1, keyB.key);
  e = await prisma.endpoint.findUnique({ where: { id: intune1.id } });
  check(r.status === 400 && e.customerId === A.id, "B's key on A's computer: refused, it stays in A", msg(r));

  section('Uses are counted conditionally: parallel claims never pass the ceiling');
  const racers = Array.from({ length: 5 }, (_, i) => mkComputer(`${TAG}-RACE${i}`));
  const results = await Promise.all(racers.map((c) => fetch(`${API}/enrollment/claim`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip() },
    body: JSON.stringify({ token: keyB.key, rustdeskId: c.rid, hostname: c.hostname, platform: 'Windows', agentSecret: c.secret }) }).then((x) => x.status)));
  for (const c of racers) await epOf(c);
  const kb = await prisma.deploymentKey.findUnique({ where: { id: keyB.id } });
  const pooledRacers = await prisma.rustdeskNode.count({ where: { rustdeskId: { in: racers.map((c) => c.rid) } } });
  check(results.filter((s) => s === 200).length === 2 && kb.useCount === 2 && pooledRacers === 2, 'five at once on a two-use key: exactly two enrolled, useCount 2', J({ results, useCount: kb.useCount, pooledRacers }));
  r = await claim(mkComputer(`${TAG}-LATE`), keyB.key);
  check(r.status === 400 && /no uses left/i.test(r.text), 'the next one: "no uses left"', msg(r));
  r = await req('GET', `/public/install/linux/${keyB.key}`, { raw: true });
  check(r.text.includes('CLAIM_TOKEN=""'), 'and the install script no longer carries the used-up key');

  section('Revoked and expired keys are refused; revoking never asks and is audited');
  r = await req('POST', `/adoption/deployment-keys/${reviewKey.id}/revoke`, { s: S.ownerA });
  check(r.status === 403, 'owner A cannot revoke', msg(r));
  r = await req('POST', `/adoption/deployment-keys/${reviewKey.id}/revoke`, { s: S.admin });
  check(ok(r) && r.data.revoked === true, 'Platform Admin revokes without a fresh sign-in', msg(r));
  r = await req('POST', `/adoption/deployment-keys/${reviewKey.id}/revoke`, { s: S.admin });
  check(r.status === 409, 'revoking twice: 409 (conditional)', msg(r));
  check(!!(await prisma.activityLog.findFirst({ where: { action: 'DEPLOYMENT_KEY_REVOKED', resourceId: reviewKey.id, actorId: admin.id } })), 'audited DEPLOYMENT_KEY_REVOKED');
  r = await claim(mkComputer(`${TAG}-REVOKED`), reviewKey.key);
  check(r.status === 400 && /revoked/i.test(r.text), 'a claim with it: "revoked"', msg(r));
  r = await req('GET', `/public/install/win/${reviewKey.key}`, { raw: true });
  check(r.status === 200 && !r.text.includes(reviewKey.key), 'the Windows script no longer carries it');
  const old = new Date(Date.now() - 40 * 24 * 3600_000);
  await prisma.deploymentKey.update({ where: { id: activeKey.id }, data: { createdAt: old, expiresAt: new Date(old.getTime() + 30 * 24 * 3600_000) } });
  r = await claim(mkComputer(`${TAG}-EXPIRED`), activeKey.key);
  check(r.status === 400 && /expired/i.test(r.text), 'a claim with an expired key: "expired"', msg(r));
  const ck = await prisma.$executeRawUnsafe(`UPDATE "DeploymentKey" SET "expiresAt" = "createdAt" + INTERVAL '91 days' WHERE id = $1`, activeKey.id).then(() => 'accepted').catch((x) => String(x.message));
  check(/expiry_check|violates check/i.test(ck), 'the database refuses an expiry past 90 days (CHECK)', ck);

  section('A single-use claim token still works exactly as before');
  r = await req('POST', '/enrollment/tokens', { s: F.ownerA, body: { businessId: A.id, accessMode: 'COMPANY_WIDE', description: `${TAG} single` } });
  const single = r.data?.token;
  check((r.status === 201 || r.status === 200) && /^[0-9a-f]{64}$/.test(single ?? ''), 'owner A mints a claim token (64 hex)', msg(r));
  const one = mkComputer(`${TAG}-SINGLE`);
  r = await claim(one, single);
  e = await epOf(one);
  check(ok(r) && e?.customerId === A.id && e.status === 'ACTIVE' && e.deploymentKeyId === null, 'claimed into A, as before (no deployment key involved)', msg(r));
  r = await claim(mkComputer(`${TAG}-SINGLE2`), single);
  check(r.status === 400, 'a second use is refused', msg(r));

  // ── Assignment rules ──────────────────────────────────────────────────────
  section('Assignment rules: Platform Admin only, fresh sign-in, explicit facts only');
  const rule = (o) => ({ businessId: A.id, kind: 'domain', value: `${sfx}.acme.local`, ...o });
  r = await req('POST', '/adoption/mappings', { s: F.ownerA, body: rule() });
  check(r.status === 403, 'owner A (fresh): refused', msg(r));
  r = await req('POST', '/adoption/mappings', { s: S.admin, body: rule() });
  check(stepUpRefusal(r) && r.body?.action === 'adoption.mappings', 'without a fresh sign-in: STEP_UP_REQUIRED (adoption.mappings)', msg(r));
  for (const [bad, why] of [
    [rule({ kind: 'username', value: 'bob' }), 'a rule on a user name'], [rule({ kind: 'email', value: 'bob@acme.example' }), 'a rule on an e-mail address'],
    [rule({ kind: 'logged_on_user', value: 'ACME\\bob' }), 'a rule on the signed-in user'], [rule({ value: 'WORKGROUP' }), 'WORKGROUP'],
    [rule({ kind: 'cidr', value: '0.0.0.0/0' }), 'the whole internet'], [rule({ kind: 'cidr', value: '10.0.0.0/7' }), 'wider than /8'],
    [rule({ kind: 'hostname_prefix', value: 'a' }), 'a one-character prefix'], [rule({ siteId: siteB.id }), "another business's site"],
    [rule({ kind: 'deployment_key', value: keyB.id }), "B's key pointed at A"], [rule({ businessId: B.id, kind: 'deployment_key', value: activeKey.id }), "A's key pointed at B"],
  ]) {
    r = await req('POST', '/adoption/mappings', { s: F.admin, body: bad });
    check(r.status === 400, `refused: ${why}`, msg(r));
  }
  r = await req('POST', '/adoption/mappings', { s: F.admin, body: rule({ siteId: siteA.id }) });
  const domainRule = r.data;
  check(r.status === 201 && domainRule.value === `${sfx}.acme.local`, 'domain rule → A / HQ', msg(r));
  r = await req('POST', '/adoption/mappings', { s: F.admin, body: { businessId: B.id, kind: 'cidr', value: '198.51.100.0/24', siteId: siteB.id } });
  const cidrRule = r.data;
  check(r.status === 201, 'address rule 198.51.100.0/24 → B / Depot', msg(r));
  r = await req('POST', '/adoption/mappings', { s: F.admin, body: { businessId: A.id, kind: 'hostname_prefix', value: `${TAG}-STRAY2` } });
  const prefixRule = r.data;
  check(r.status === 201 && prefixRule.value === `${TAG}-stray2`.toLowerCase(), 'hostname-prefix rule → A (stored lower-case)', msg(r));
  r = await req('POST', '/adoption/mappings', { s: F.admin, body: { businessId: B.id, kind: 'hostname_prefix', value: `${TAG}-STRAY2` } });
  check(r.status === 409, 'the same value twice: 409 (one rule per value)', msg(r));
  check(!!(await prisma.activityLog.findFirst({ where: { action: 'ADOPTION_MAPPING_CREATED', resourceId: domainRule.id, actorId: admin.id } })), 'audited ADOPTION_MAPPING_CREATED');

  section('Suggestions: the rule that matched, conflicts flagged, nothing applied');
  await prisma.endpointInventory.upsert({ where: { endpointId: stray.id }, update: { domain: `${sfx.toUpperCase()}.ACME.LOCAL`, manufacturer: 'Dell Inc.', model: 'Latitude 7440', loggedOnUser: 'BIRCH\\carol' }, create: { endpointId: stray.id, domain: `${sfx}.acme.local`, manufacturer: 'Dell Inc.', model: 'Latitude 7440' } });
  r = await req('GET', '/adoption/devices', { s: S.admin });
  const view = (id) => r.data.computers.find((c) => c.id === id);
  let v = view(stray.id);
  check(v?.suggestion?.source === 'domain' && v.suggestion.customerId === A.id && v.suggestion.siteId === siteA.id && v.suggestion.mappingId === domainRule.id && v.conflict === false,
    'STRAY1 (domain, case-insensitive): A / HQ, by the domain rule', J(v?.suggestion));
  check(v?.inventory?.manufacturer === 'Dell Inc.' && v.inventory.model === 'Latitude 7440' && !('loggedOnUser' in (v.inventory ?? {})), 'its hardware is shown; who is signed in is not', J(v?.inventory));
  v = view(installerOnly.id);
  check(v?.conflict === true && v.suggestion.source === 'hostname_prefix' && v.suggestion.customerId === A.id && v.matches.some((m) => m.source === 'cidr' && m.customerId === B.id),
    'STRAY2 (hostname → A, address → B): the conflict is flagged, the name rule first', J(v?.matches));
  v = view(gpo1.id);
  check(v?.suggestion?.source === 'key_binding' && v.suggestion.customerId === A.id && v.suggestion.siteId === siteA.id && v.deploymentKey?.name === `${TAG} GPO`,
    "GPO1: its deployment key's own business and site, and the key's name", J(v?.suggestion));
  check(r.data.businesses[A.id] === `${TAG} Acme` && r.data.businesses[B.id] === `${TAG} Birch`, 'business names come with it');
  e = await prisma.endpoint.findUnique({ where: { id: stray.id } });
  check(e.customerId === null && e.tenantId === null, 'nothing was applied: STRAY1 is still pooled');

  // ── Adoption ──────────────────────────────────────────────────────────────
  section('Adoption: Platform Admin, fresh sign-in, business + site + groups, conditional and audited');
  const adoptBody = (o = {}) => ({ endpointIds: [stray.id, gpo1.id], businessId: A.id, siteId: siteA.id, groupIds: [groupA.id], mappingId: domainRule.id, ...o });
  r = await req('POST', '/adoption/devices/assign', { s: F.ownerA, body: adoptBody() });
  check(r.status === 403 && code(r) !== 'STEP_UP_REQUIRED', 'owner A (fresh): refused', msg(r));
  r = await req('POST', '/adoption/devices/assign', { s: S.admin, body: adoptBody() });
  check(stepUpRefusal(r) && r.body?.action === 'devices.adopt', 'without a fresh sign-in: STEP_UP_REQUIRED (devices.adopt)', msg(r));
  for (const [bad, why] of [
    [adoptBody({ siteId: siteB.id }), "B's site"], [adoptBody({ groupIds: [groupB.id] }), "B's group"], [adoptBody({ groupIds: [ruleGroupA.id] }), 'a rule group'],
    [adoptBody({ mappingId: cidrRule.id }), 'a rule that suggests another business'], [adoptBody({ endpointIds: [] }), 'no computers'],
    [adoptBody({ endpointIds: [stray.id, stray.id] }), 'the same computer twice'], [adoptBody({ tenantId: tenant.id }), 'an extra field'],
  ]) {
    r = await req('POST', '/adoption/devices/assign', { s: F.admin, body: bad });
    check(r.status === 400, `refused: ${why}`, msg(r));
  }
  check((await prisma.endpoint.count({ where: { id: { in: [stray.id, gpo1.id] }, customerId: null } })) === 2, 'nothing moved on a refusal');
  r = await req('POST', '/adoption/devices/assign', { s: F.admin, body: adoptBody({ endpointIds: [stray.id, gpo1.id, bComputer.id] }) });
  const res = new Map((r.data?.results ?? []).map((x) => [x.endpointId, x.result]));
  check(ok(r) && res.get(stray.id) === 'adopted' && res.get(gpo1.id) === 'adopted' && res.get(bComputer.id) === 'not_unassigned', "two adopted; B's assigned computer is not_unassigned", msg(r));
  for (const id of [stray.id, gpo1.id]) {
    e = await prisma.endpoint.findUnique({ where: { id }, include: { rustdeskNode: true, groupMemberships: true } });
    check(e.tenantId === tenant.id && e.customerId === A.id && e.siteId === siteA.id && e.status === 'ACTIVE' && e.adoptedById === admin.id && !!e.adoptedAt && e.rustdeskNode.tenantId === tenant.id && e.groupMemberships.some((m) => m.endpointGroupId === groupA.id),
      `${e.name}: in A at HQ and in the group, ACTIVE, adoptedBy the admin, its node's tenant set`, J({ c: e.customerId, s: e.siteId, by: e.adoptedById }));
    const a = await prisma.activityLog.findFirst({ where: { action: 'ENDPOINT_ADOPTED', resourceId: id } });
    check(a && a.actorId === admin.id && a.customerId === A.id && a.metadata?.approvedBy === admin.id && a.metadata?.before?.customerId === null && a.metadata?.after?.customerId === A.id
      && a.metadata?.mappingId === domainRule.id && a.metadata?.stepUpMethod === 'password' && (id !== gpo1.id || a.metadata?.deploymentKeyId === reviewKey.id),
    `${e.name}: ENDPOINT_ADOPTED names the approver, before and after, the rule${id === gpo1.id ? ' and the deployment key' : ''}`, J(a?.metadata));
  }
  e = await prisma.endpoint.findUnique({ where: { id: bComputer.id } });
  check(e.customerId === B.id && e.siteId === siteB.id, "B's computer was not touched");
  r = await req('POST', '/adoption/devices/assign', { s: F.admin, body: adoptBody({ endpointIds: [stray.id], businessId: B.id, siteId: null, groupIds: [], mappingId: null }) });
  e = await prisma.endpoint.findUnique({ where: { id: stray.id } });
  check(ok(r) && r.data.results[0].result === 'not_unassigned' && e.customerId === A.id, 'adopting it again (into B): not_unassigned, it stays in A', msg(r));
  r = await req('GET', '/endpoints/list?pageSize=200', { s: S.ownerA });
  check(r.text.includes(stray.id) && r.text.includes(gpo1.id), 'owner A now sees both');
  r = await req('GET', '/endpoints/list?pageSize=200', { s: S.ownerB });
  check(!r.text.includes(stray.id) && !r.text.includes(gpo1.id), 'owner B sees neither');
  r = await req('GET', `/endpoints/${stray.id}`, { s: S.ownerB });
  check(r.status === 404, 'owner B: GET /endpoints/:adopted is a 404', msg(r));
  r = await req('GET', '/audit?limit=200', { s: S.ownerB });
  check(!r.text.includes(stray.id) && !r.text.includes(gpo1.id), "owner B's audit log shows nothing of A's adoption", msg(r));
  r = await beat(stray);
  check(ok(r) && r.data.pending === undefined, 'its next heartbeat is an ordinary one (not pending)', msg(r));
  r = await req('POST', `/endpoints/${stray.id}/rotate-credential`, { s: F.admin });
  check(code(r) !== 'ENDPOINT_UNASSIGNED', 'and the unassigned refusal no longer applies', msg(r));

  section('Forget: only pooled junk, fresh sign-in, audited');
  const junk = mkComputer(`${TAG}-JUNK`);
  await beat(junk); const junkEp = await epOf(junk);
  r = await req('POST', '/adoption/devices/forget', { s: S.admin, body: { endpointIds: [junkEp.id] } });
  check(stepUpRefusal(r), 'without a fresh sign-in: STEP_UP_REQUIRED', msg(r));
  r = await req('POST', '/adoption/devices/forget', { s: F.ownerA, body: { endpointIds: [junkEp.id] } });
  check(r.status === 403, 'owner A: refused', msg(r));
  r = await req('POST', '/adoption/devices/forget', { s: F.admin, body: { endpointIds: [junkEp.id, intune1.id] } });
  const fr = new Map((r.data?.results ?? []).map((x) => [x.endpointId, x.result]));
  check(ok(r) && fr.get(junkEp.id) === 'forgotten' && fr.get(intune1.id) === 'not_unassigned', 'the pooled one is forgotten; an assigned one is not_unassigned', msg(r));
  check(!(await prisma.endpoint.findUnique({ where: { id: junkEp.id } })) && !(await prisma.rustdeskNode.findUnique({ where: { rustdeskId: junk.rid } })) && !!(await prisma.endpoint.findUnique({ where: { id: intune1.id } })),
    'its endpoint and node are gone; the assigned computer is untouched');
  const fa = await prisma.activityLog.findFirst({ where: { action: 'ENDPOINT_FORGOTTEN', resourceId: junkEp.id } });
  check(fa && fa.actorId === admin.id && fa.metadata?.rustdeskId === junk.rid, 'audited ENDPOINT_FORGOTTEN with the Remote ID', J(fa?.metadata));

  section('Rules: removing one never asks, is audited');
  r = await req('DELETE', `/adoption/mappings/${prefixRule.id}`, { s: S.ownerA });
  check(r.status === 403, 'owner A cannot remove a rule', msg(r));
  r = await req('DELETE', `/adoption/mappings/${prefixRule.id}`, { s: S.admin });
  check(ok(r) && !(await prisma.adoptionMapping.findUnique({ where: { id: prefixRule.id } })) && !!(await prisma.activityLog.findFirst({ where: { action: 'ADOPTION_MAPPING_DELETED', resourceId: prefixRule.id } })),
    'Platform Admin removes it without a fresh sign-in; audited', msg(r));
}

async function cleanup() {
  await stopApi();
  try {
    const ids = created.businesses;
    const nodes = await prisma.rustdeskNode.findMany({ where: { OR: [{ endpoint: { name: { startsWith: TAG } } }, { hostname: { startsWith: TAG } }] }, select: { endpointId: true } });
    for (const n of nodes) created.endpoints.add(n.endpointId);
    const eps = [...created.endpoints, ...(await prisma.endpoint.findMany({ where: { OR: [{ customerId: { in: ids } }, { name: { startsWith: TAG } }] }, select: { id: true } })).map((x) => x.id)];
    const idents = created.users.map((u) => `user:${u}`);
    await prisma.privilegedActivity.deleteMany({ where: { identity: { in: idents } } }).catch(() => undefined);
    await prisma.identityPause.deleteMany({ where: { identity: { in: idents } } }).catch(() => undefined);
    await prisma.adoptionMapping.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.endpointCommand.deleteMany({ where: { endpointId: { in: eps } } });
    await prisma.endpointInventory.deleteMany({ where: { endpointId: { in: eps } } });
    await prisma.endpointGroupMember.deleteMany({ where: { endpointId: { in: eps } } });
    await prisma.deviceClaimToken.deleteMany({ where: { OR: [{ customerId: { in: ids } }, { endpointId: { in: eps } }] } });
    await prisma.technicianAssignment.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.rustdeskNode.deleteMany({ where: { endpointId: { in: eps } } });
    await prisma.endpoint.deleteMany({ where: { id: { in: eps } } });
    await prisma.deploymentKey.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.apiKey.deleteMany({ where: { id: { in: created.apiKeys } } });
    await prisma.endpointGroup.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.site.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.membership.deleteMany({ where: { userId: { in: created.users } } });
    await prisma.customer.deleteMany({ where: { id: { in: ids } } }).catch((x) => console.error('cleanup businesses:', x.message));
    await prisma.user.deleteMany({ where: { id: { in: created.users } } }).catch((x) => console.error('cleanup users:', x.message));
    await prisma.platformSettings.update({ where: { id: 'singleton' }, data: { rustdeskPinnedVersion: originalPin, ...(originalQc !== null ? { quickConnectEnabled: originalQc } : {}) } }).catch(() => undefined);
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
