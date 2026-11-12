#!/usr/bin/env node
/**
 * End-to-end proof of within-business computer visibility (0.31.2).
 *
 * A Business User sees a computer only when it is granted to them
 * (ComputerAccess, inside its dates) or marked COMPANY_WIDE in their own
 * business — `AccessControlService.endpointVisibilityWhere`. Before 0.31.2
 * the list routes applied that rule but the per-computer routes did not:
 * `assertEndpointInScope` checked business scope and technician grants only,
 * and `GET /admin/search` filtered computers by business alone.
 *
 * This suite:
 *   - asks GET /admin/search, as a Business User and as a technician
 *     restricted to one computer, for computers they are not granted;
 *   - sweeps every per-computer route that goes through assertEndpointInScope
 *     (reads and writes) as a Business User holding EVERY business capability
 *     — so nothing but visibility can refuse them — against a computer in
 *     their own business that is granted only to someone else. Each route must
 *     answer 404 "Computer not found" (or the route's own not-found), exactly
 *     as for a foreign id, and change nothing;
 *   - runs the same route against a computer that IS granted to them, as the
 *     control: there it must not be refused as not found, so the 404 above is
 *     the visibility rule and not a route that is broken for everyone;
 *   - checks what must stay allowed: COMPANY_WIDE computers, a grant whose
 *     weekly schedule excludes now (seen, but not connected to — that split is
 *     canReachEndpoint's), owners, Platform Admins and technicians;
 *   - checks what must stay refused: an expired grant, a not-yet-started
 *     grant, a computer in another business.
 *
 * Self-starting: it runs its own API from dist/ on VISIBILITY_API_PORT (3341)
 * against DATABASE_URL, which must name a scratch/test database. Fixtures are
 * namespaced and removed at the end.
 *
 * Run:  DATABASE_URL=…/rem0te_visibility_test node scripts/e2e-endpoint-visibility.mjs
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const DB = process.env.DATABASE_URL ?? '';
const dbName = DB.split('/').pop()?.split('?')[0] ?? '';
if (!/scratch|test/.test(dbName)) { console.error(`Refusing to run against database "${dbName}": name must contain "scratch" or "test".`); process.exit(2); }
const PORT = Number(process.env.VISIBILITY_API_PORT ?? 3341);
if ([3000, 3001, 443].includes(PORT)) { console.error(`Refusing port ${PORT}: that is a production port.`); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'visibility-e2e-password-1';
const TAG = `VIS${sfx}`;

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
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? randomBytes(32).toString('hex'), TRUSTED_PROXIES: 'loopback',
  HBBS_PRESENCE_HOST: '127.0.0.2', MONITOR_SWEEP: 'off', AUDIT_SEALER: 'off',
  // Nothing here may call out: no INTEGRATION_PEERS_FILE, so the timeline
  // route (0.34, through ClientSt0r) has no peer to reach.
  INTEGRATION_PEERS_FILE: '',
  VERSION_FILE: path.resolve(here, '..', '..', '..', 'version.json'),
};
let api;
function startApi() {
  api = spawn(process.execPath, [path.join(dist, 'main.js')], { env: apiEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  api.log = ''; api.stdout.on('data', (d) => { api.log += d; }); api.stderr.on('data', (d) => { api.log += d; });
}
async function stopApi() { if (!api || api.exitCode !== null) return; await new Promise((r) => { api.once('exit', r); api.kill('SIGTERM'); }); }
async function waitUp() {
  for (let i = 0; i < 150; i++) { try { const r = await fetch(`${API}/health`); if (r.status < 500) return; } catch { /* not yet */ } await sleep(300); }
  throw new Error(`api did not come up:\n${api.log.slice(-3000)}`);
}

// Paced under the 20 req/s burst throttler, which is keyed per address and a
// session keeps one address.
const pace = () => sleep(60);
async function req(method, p, { s, body } = {}) {
  await pace();
  const h = { 'content-type': 'application/json', 'x-forwarded-for': s?.ip ?? ip() };
  if (s) h.cookie = s.cookie;
  const r = await fetch(`${API}${p}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j, data: j?.data, text };
}
async function login(email) {
  const s = { ip: ip() };
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': s.ip }, body: JSON.stringify({ email, password: PW }) });
  const mm = (r.headers.get('set-cookie') ?? '').match(/access_token=([^;]+)/);
  if (r.status !== 200 || !mm) throw new Error(`login ${email}: ${r.status} ${await r.text()}`);
  s.cookie = `access_token=${mm[1]}`;
  return s;
}
const message = (r) => { const m = r.body?.message; return typeof m === 'string' ? m : (m?.message ?? ''); };
const msg = (r) => `HTTP ${r.status} ${String(typeof r.body === 'string' ? r.body : JSON.stringify(r.body)).slice(0, 300)}`;
const notFound = (r) => r.status === 404 && /not found/i.test(message(r));
const computerNotFound = (r) => r.status === 404 && message(r) === 'Computer not found';

const EVERY_CAP = [
  'computers:view', 'computers:connect', 'computers:add', 'computers:remove', 'computers:edit', 'computers:event_logs',
  'support:quick_connect', 'support:sessions_view', 'support:history_view', 'support:requests',
  'users:view', 'users:manage', 'audit:view', 'integration:ticket_analysis', 'actions:request',
  'monitoring:alerts', 'monitoring:configure',
];

const created = { businesses: [], users: [] };

/** Everything a write could leave behind on one computer. */
async function fingerprint(id) {
  const e = await prisma.endpoint.findUnique({
    where: { id },
    select: {
      name: true, description: true, status: true, accessMode: true, deviceClass: true, aiTimeline: true, patchScanRequestedAt: true,
      rustdeskNode: { select: { permanentPassword: true, pendingPassword: true, agentSecretHash: true, reinstallRequestedAt: true } },
      _count: { select: { aliases: true, tags: true, noteRels: true, supportSessions: true, computerAccess: true, connectionGrants: true, actionTargets: true, commands: true, diagnosticRuns: true, deviceClaimTokens: true, monitorRules: true } },
    },
  });
  const extra = {
    suppressions: await prisma.monitorSuppression.count({ where: { endpointId: id } }),
    temporary: await prisma.temporaryAccessRequest.count({ where: { endpointId: id } }),
    launcher: await prisma.launcherToken.count({ where: { targetEndpointId: id } }),
  };
  return JSON.stringify({ e, extra });
}

async function all() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });
  const roleUser = await prisma.role.findFirst({ where: { type: 'BUSINESS_USER' } });

  section('Fixtures (synthetic): Acme (seven computers) and Birch (one), one restricted user with every capability');
  const A = await prisma.customer.create({ data: { tenantId: tenant.id, name: `${TAG} Acme` } });
  const B = await prisma.customer.create({ data: { tenantId: tenant.id, name: `${TAG} Birch` } });
  created.businesses.push(A.id, B.id);
  const site = await prisma.site.create({ data: { tenantId: tenant.id, customerId: A.id, name: `${TAG} HQ` } });
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (t, extra = {}) => { const u = await prisma.user.create({ data: { email: `vis-${t}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'VIS', lastName: t, status: 'ACTIVE', ...extra } }); created.users.push(u.id); return u; };
  const admin = await mkUser('admin', { isPlatformAdmin: true });
  const owner = await mkUser('owner-a');
  const rita = await mkUser('rita-restricted-a');   // every capability, two grants
  const otto = await mkUser('otto-other-a');        // holds the grant rita lacks
  const tess = await mkUser('tess-tech-one');       // technician on one computer
  await prisma.membership.create({ data: { userId: owner.id, tenantId: tenant.id, customerId: A.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: rita.id, tenantId: tenant.id, customerId: A.id, roleId: roleUser.id, capabilities: EVERY_CAP } });
  await prisma.membership.create({ data: { userId: otto.id, tenantId: tenant.id, customerId: A.id, roleId: roleUser.id, capabilities: ['computers:view'] } });

  const mkEp = async (biz, label, { mode = 'ASSIGNED_USERS' } = {}) => {
    const name = `${TAG}-${label}`;
    const e = await prisma.endpoint.create({ data: {
      tenantId: tenant.id, customerId: biz.id, siteId: biz.id === A.id ? site.id : null, name, hostname: name.toLowerCase(), platform: 'Windows',
      osVersion: 'Windows 11 Pro', ipAddress: `10.77.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`,
      status: 'ACTIVE', isOnline: true, isManaged: true, accessMode: mode, lastSeenAt: new Date(), deviceClass: 'WORKSTATION', agentVersion: '0.31.1',
    } });
    const rid = String(100000000 + ((Math.random() * 899999999) | 0));
    await prisma.rustdeskNode.create({ data: { tenantId: tenant.id, endpointId: e.id, rustdeskId: rid, agentSecretHash: sha(randomBytes(24).toString('hex')), lastSeenAt: new Date() } });
    return { ...e, rid };
  };
  const granted = await mkEp(A, 'GRANTED');
  const hidden = await mkEp(A, 'GRANTED-TO-OTTO-ONLY');
  const companyWide = await mkEp(A, 'COMPANY-WIDE', { mode: 'COMPANY_WIDE' });
  const scheduled = await mkEp(A, 'SCHEDULED-NOT-NOW');
  const expired = await mkEp(A, 'GRANT-EXPIRED');
  const future = await mkEp(A, 'GRANT-NOT-STARTED');
  const techPc = await mkEp(A, 'TECH-ONE');
  const foreign = await mkEp(B, 'BIRCH', { mode: 'COMPANY_WIDE' });
  const grant = (ep, user, extra = {}) => prisma.computerAccess.create({ data: { tenantId: tenant.id, endpointId: ep.id, userId: user.id, ...extra } });
  await grant(granted, rita);
  await grant(hidden, otto);
  // A weekly window three days from today, one minute long: never now.
  const notToday = (new Date().getUTCDay() + 3) % 7;
  await grant(scheduled, rita, { schedule: { timeZone: 'UTC', windows: [{ days: [notToday], start: '00:00', end: '00:01' }] } });
  await grant(expired, rita, { expiresAt: new Date(Date.now() - 3600_000) });
  await grant(future, rita, { startsAt: new Date(Date.now() + 86400_000) });
  await prisma.technicianAssignment.create({ data: { tenantId: tenant.id, customerId: A.id, userId: tess.id, capabilities: ['computers:view', 'computers:connect', 'users:view'], endpointIds: [techPc.id] } });
  // Content on the hidden computer, so a leaking read has something to show.
  const hiddenNote = await prisma.note.create({ data: { tenantId: tenant.id, customerId: A.id, endpointId: hidden.id, authorId: owner.id, content: `${TAG} hidden note body` } });
  await prisma.endpointInventory.create({ data: { endpointId: hidden.id, loggedOnUser: `ACME\\${TAG}-otto`, cpuLoadPercent: 12, liveSampledAt: new Date() } });
  const hiddenRun = await prisma.diagnosticRun.create({ data: { tenantId: tenant.id, customerId: A.id, endpointId: hidden.id, key: 'disk_space', status: 'REQUESTED', requestedById: owner.id, expiresAt: new Date(Date.now() + 3600_000) } }).catch((e) => { console.log(`  (no diagnostic run fixture: ${e.message.split('\n').pop()})`); return null; });
  check(true, 'created Acme (7) and Birch (1), five users, five grants, one technician assignment');

  startApi();
  await waitUp();
  const S = { admin: await login(admin.email), owner: await login(owner.email), rita: await login(rita.email), tess: await login(tess.email) };

  // ── 1. GET /admin/search ───────────────────────────────────────────────────
  section('GET /admin/search returns no computer the caller cannot see');
  {
    const r = await req('GET', `/admin/search?q=${encodeURIComponent(TAG)}`, { s: S.rita });
    const found = r.data?.computers ?? [];
    const leaked = found.filter((c) => ![granted.id, companyWide.id].includes(c.id));
    if (leaked.length) console.log(`      leaked to the Business User: ${leaked.map((c) => `${c.name} / ${c.hostname} / ${c.ipAddress} / RustDesk ${c.rustdeskNode?.rustdeskId}`).join('; ')}`);
    check(r.status === 404 || (r.status === 200 && leaked.length === 0), 'a Business User finds only computers granted to them or COMPANY_WIDE (or the route is gone)', `HTTP ${r.status}, ${found.length} computers, ${leaked.length} not visible to them`);
    const hit = found.find((c) => c.id === hidden.id);
    check(!hit, 'in particular not the computer granted only to someone else, with its hostname, IP and RustDesk ID',
      hit ? `${hit.hostname} ${hit.ipAddress} ${hit.rustdeskNode?.rustdeskId}` : '');
  }
  {
    const r = await req('GET', `/admin/search?q=${encodeURIComponent(TAG)}`, { s: S.tess });
    const found = r.data?.computers ?? [];
    check(r.status === 404 || (r.status === 200 && found.every((c) => c.id === techPc.id)), 'a technician assigned one computer finds only that one (or the route is gone)', `HTTP ${r.status}, ${found.length} computers`);
  }

  // ── 2. The list routes agree (they already applied the rule) ──────────────
  section('The device list (already correct) — the baseline the per-computer routes must match');
  const listed = new Set(((await req('GET', `/endpoints?search=${TAG}&limit=100`, { s: S.rita })).data?.endpoints ?? []).map((e) => e.id));
  check(listed.has(granted.id) && listed.has(companyWide.id) && listed.has(scheduled.id), 'lists the granted, COMPANY_WIDE and out-of-hours scheduled computers', JSON.stringify([...listed]));
  check(!listed.has(hidden.id) && !listed.has(expired.id) && !listed.has(future.id) && !listed.has(techPc.id) && !listed.has(foreign.id), 'does not list the ungranted, expired, not-started or other-business ones');

  // ── 3. Every per-computer route, as rita, on the hidden computer ───────────
  section('Per-computer routes as a Business User with every capability, on a computer granted only to someone else');
  const cmdId = 'c' + randomBytes(12).toString('hex');
  const routes = (ep) => [
    // reads
    ['GET', `/endpoints/${ep.id}`],
    ['GET', `/endpoints/${ep.id}/inventory`],
    ['GET', `/endpoints/${ep.id}/timeline`],
    ['GET', `/endpoints/${ep.id}/event-log/latest`],
    ['GET', `/endpoints/${ep.id}/commands/${cmdId}`],
    ['GET', `/endpoints/${ep.id}/access`],
    ['GET', `/endpoints/${ep.id}/access-review`],
    ['GET', `/endpoints/${ep.id}/patches`],
    ['GET', `/endpoints/${ep.id}/actions`],
    ['GET', `/monitoring/endpoints/${ep.id}`],
    ['GET', `/endpoints/${ep.id}/diagnostics`],
    ['GET', `/endpoints/${ep.id}/diagnostics/report`],
    ['GET', `/endpoints/${ep.id}/diagnostics/catalog`],
    ['GET', `/endpoints/${ep.id}/diagnostics/runs`],
    ...(ep === hidden && hiddenRun ? [['GET', `/endpoints/${ep.id}/diagnostics/runs/${hiddenRun.id}`]] : []),
    ['GET', `/notes?endpointId=${ep.id}`],
    ['GET', `/endpoints/${ep.id}/password`],
    ['GET', `/endpoints/${ep.id}/connect.cmd`],
    // writes
    ['PATCH', `/endpoints/${ep.id}`, { description: `${TAG} changed` }],
    ['POST', `/endpoints/${ep.id}/tags`, { tag: `${TAG.toLowerCase()}-tag` }],
    ['DELETE', `/endpoints/${ep.id}/tags/${TAG.toLowerCase()}-tag`],
    ['POST', `/endpoints/${ep.id}/aliases`, { alias: `${TAG}-ALIAS-${ep.id.slice(-4)}` }],
    ['PATCH', `/endpoints/${ep.id}/password`, { password: 'Visibility-e2e-Pw-1' }],
    ['POST', `/endpoints/${ep.id}/rotate-credential`],
    ['POST', `/endpoints/${ep.id}/access`, { userId: rita.id }],
    ['DELETE', `/endpoints/${ep.id}/access/${otto.id}`],
    ['PATCH', `/endpoints/${ep.id}/access-mode`, { accessMode: 'COMPANY_WIDE' }],
    ['POST', `/endpoints/${ep.id}/inventory/refresh`],
    ['POST', `/endpoints/${ep.id}/event-log`, { log: 'System', maxEvents: 10 }],
    ['POST', `/endpoints/${ep.id}/reinstall-agent`],
    ['POST', `/endpoints/${ep.id}/accept-device-secret`],
    ['POST', `/endpoints/${ep.id}/timeline/generate`],
    ['POST', `/endpoints/${ep.id}/diagnostics/runs`, { key: 'disk_space' }],
    ['POST', `/endpoints/${ep.id}/actions`, { actionId: 'windows.service.start', version: 1, params: { service: 'Spooler' }, reason: 'visibility e2e' }],
    ['POST', `/endpoints/${ep.id}/actions`, { actionId: 'not.in.catalog', version: 1, params: {}, reason: 'visibility e2e' }],
    ['POST', '/notes', { endpointId: ep.id, content: `${TAG} note` }],
    ['POST', '/sessions', { endpointId: ep.id }],
    ['POST', '/launcher/token', { endpointId: ep.id }],
    ['POST', `/endpoints/${ep.id}/connect`],
    ['POST', '/endpoints/trmm/link', { endpointId: ep.id, agentId: `${TAG}agent${ep.id.slice(-4)}` }],
    ['POST', '/monitoring/suppressions', { scope: 'endpoint', endpointId: ep.id, reason: 'visibility e2e', endsAt: new Date(Date.now() + 3600_000).toISOString() }],
    ['POST', '/security-controls/temporary-access', { endpointId: ep.id, mode: 'CONTROL', reason: 'visibility e2e', durationMinutes: 30 }],
    ['POST', '/enrollment/tokens', { endpointId: ep.id, businessId: A.id }],
    ['PATCH', `/endpoints/${ep.id}/archive`],
    ['PATCH', `/endpoints/${ep.id}/restore`],
  ];

  const before = await fingerprint(hidden.id);
  const leaks = [];
  const hiddenResults = [];
  // Each probe starts from the same state: an earlier write that got through
  // (granting herself access, making it COMPANY_WIDE, archiving it) must not
  // make a later probe look legitimately allowed.
  const resetHidden = async () => {
    await prisma.endpoint.update({ where: { id: hidden.id }, data: { accessMode: 'ASSIGNED_USERS', status: 'ACTIVE' } });
    await prisma.computerAccess.deleteMany({ where: { endpointId: hidden.id, userId: { not: otto.id } } });
    await prisma.computerAccess.upsert({ where: { userId_endpointId: { userId: otto.id, endpointId: hidden.id } }, update: {}, create: { tenantId: tenant.id, endpointId: hidden.id, userId: otto.id } });
  };
  for (const [method, p, body] of routes(hidden)) {
    await resetHidden();
    const r = await req(method, p, { s: S.rita, body });
    hiddenResults.push(r);
    const label = `${method} ${p.replace(hidden.id, ':id').replace(cmdId, ':commandId').replace(hiddenRun?.id ?? '\0', ':runId')}`;
    // The not-found must be the visibility check's, not a later one that ran
    // after the computer had already been treated as in scope.
    const refused = computerNotFound(r) || (notFound(r) && /Deployment|Action/.test(message(r)));
    if (!refused) leaks.push(`${label} → ${r.status}${r.status < 300 ? ` ${(r.text ?? '').slice(0, 160).replace(/\s+/g, ' ')}` : ` ${message(r).slice(0, 120)}`}`);
    check(refused, `${label} → 404 Computer not found`, msg(r));
  }
  await resetHidden();
  const after = await fingerprint(hidden.id);
  check(before === after, 'and none of them changed the hidden computer', `before ${before}\n      after  ${after}`);
  const noteStill = await prisma.note.findUnique({ where: { id: hiddenNote.id } });
  check(!!noteStill && noteStill.content === hiddenNote.content, 'its existing note is untouched');
  if (leaks.length) { console.log('\n  Routes that did not refuse:'); for (const l of leaks) console.log(`    - ${l}`); }

  // ── 4. Control: the same routes on a computer granted to rita ──────────────
  section('Control: the same routes on a computer granted to her are not refused as not found');
  for (const [method, p, body] of routes(granted)) {
    const r = await req(method, p, { s: S.rita, body });
    const label = `${method} ${p.replace(granted.id, ':id').replace(cmdId, ':commandId')}`;
    check(!computerNotFound(r), `${label} reaches the route (${r.status})`, msg(r));
  }

  // ── 5. What must stay allowed ──────────────────────────────────────────────
  section('Still allowed');
  let r = await req('GET', `/endpoints/${companyWide.id}`, { s: S.rita });
  check(r.status === 200 && r.data?.id === companyWide.id, 'a Business User reads a COMPANY_WIDE computer in their business', msg(r));
  r = await req('GET', `/endpoints/${scheduled.id}`, { s: S.rita });
  check(r.status === 200 && r.data?.id === scheduled.id, 'a grant whose weekly schedule excludes now still SEES the computer', msg(r));
  r = await req('POST', '/sessions', { s: S.rita, body: { endpointId: scheduled.id } });
  check(r.status === 403, '…but cannot open a session to it outside its hours (canReachEndpoint)', msg(r));
  r = await req('POST', `/endpoints/${scheduled.id}/connect`, { s: S.rita });
  check(r.status === 403 || r.status === 404, '…nor connect', msg(r));
  r = await req('GET', `/endpoints/${hidden.id}`, { s: S.owner });
  check(r.status === 200 && r.data?.id === hidden.id, 'the Business Owner reads the computer granted only to otto', msg(r));
  r = await req('GET', `/endpoints/${hidden.id}`, { s: S.admin });
  check(r.status === 200, 'the Platform Admin reads it', msg(r));
  r = await req('GET', `/endpoints/${foreign.id}`, { s: S.admin });
  check(r.status === 200, 'the Platform Admin reads a computer in another business', msg(r));
  r = await req('GET', `/endpoints/${techPc.id}`, { s: S.tess });
  check(r.status === 200, 'a technician reads the computer they are assigned', msg(r));

  // ── 6. What must stay refused ──────────────────────────────────────────────
  section('Still refused');
  for (const [ep, why] of [[expired, 'an expired grant'], [future, 'a grant that has not started'], [foreign, 'another business (even COMPANY_WIDE)']]) {
    r = await req('GET', `/endpoints/${ep.id}`, { s: S.rita });
    check(computerNotFound(r), `${why}: 404 Computer not found`, msg(r));
    r = await req('GET', `/endpoints/${ep.id}/diagnostics/catalog`, { s: S.rita });
    check(computerNotFound(r), `${why}: diagnostics catalog 404`, msg(r));
  }
  r = await req('GET', `/endpoints/${hidden.id}`, { s: S.tess });
  check(computerNotFound(r), 'a technician assigned another computer: 404', msg(r));
  r = await req('GET', `/endpoints/c${randomBytes(12).toString('hex')}`, { s: S.rita });
  check(computerNotFound(r), 'a nonexistent id: the same 404', msg(r));
  r = await req('GET', `/endpoints/${hidden.id}`, { s: S.rita });
  const nonexistent = await req('GET', `/endpoints/c${randomBytes(12).toString('hex')}`, { s: S.rita });
  check(r.status === nonexistent.status && JSON.stringify(r.body?.message) === JSON.stringify(nonexistent.body?.message), 'the hidden computer answers exactly as a nonexistent one', `${msg(r)} vs ${msg(nonexistent)}`);
}

async function cleanup() {
  await stopApi();
  try {
    const ids = created.businesses;
    const eps = (await prisma.endpoint.findMany({ where: { customerId: { in: ids } }, select: { id: true } })).map((e) => e.id);
    const uids = created.users;
    const tryDel = async (f) => { try { await f(); } catch (e) { console.error('cleanup:', e.message.split('\n').pop()); } };
    await tryDel(() => prisma.technicianAssignment.deleteMany({ where: { customerId: { in: ids } } }));
    await tryDel(() => prisma.noteComment.deleteMany({ where: { note: { endpointId: { in: eps } } } }));
    await tryDel(() => prisma.note.deleteMany({ where: { OR: [{ endpointId: { in: eps } }, { customerId: { in: ids } }] } }));
    await tryDel(() => prisma.diagnosticRun.deleteMany({ where: { endpointId: { in: eps } } }));
    await tryDel(() => prisma.endpointCommand.deleteMany({ where: { endpointId: { in: eps } } }));
    await tryDel(() => prisma.actionTarget.deleteMany({ where: { endpointId: { in: eps } } }));
    await tryDel(() => prisma.actionJob.deleteMany({ where: { endpointId: { in: eps } } }));
    await tryDel(() => prisma.monitorSuppression.deleteMany({ where: { OR: [{ endpointId: { in: eps } }, { customerId: { in: ids } }] } }));
    await tryDel(() => prisma.temporaryAccessRequest.deleteMany({ where: { endpointId: { in: eps } } }));
    await tryDel(() => prisma.launcherToken.deleteMany({ where: { OR: [{ targetEndpointId: { in: eps } }, { userId: { in: uids } }] } }));
    await tryDel(() => prisma.connectionGrant.deleteMany({ where: { endpointId: { in: eps } } }));
    await tryDel(() => prisma.supportSessionEvent.deleteMany({ where: { supportSession: { endpointId: { in: eps } } } }));
    await tryDel(() => prisma.supportSession.deleteMany({ where: { endpointId: { in: eps } } }));
    await tryDel(() => prisma.deviceClaimToken.deleteMany({ where: { endpointId: { in: eps } } }));
    await tryDel(() => prisma.endpointEnrollment.deleteMany({ where: { endpointId: { in: eps } } }));
    await tryDel(() => prisma.endpointInventory.deleteMany({ where: { endpointId: { in: eps } } }));
    await tryDel(() => prisma.computerAccess.deleteMany({ where: { endpointId: { in: eps } } }));
    await tryDel(() => prisma.endpointAlias.deleteMany({ where: { endpointId: { in: eps } } }));
    await tryDel(() => prisma.endpointTag.deleteMany({ where: { endpointId: { in: eps } } }));
    await tryDel(() => prisma.rustdeskNode.deleteMany({ where: { endpointId: { in: eps } } }));
    await tryDel(() => prisma.endpoint.deleteMany({ where: { id: { in: eps } } }));
    await tryDel(() => prisma.site.deleteMany({ where: { customerId: { in: ids } } }));
    await tryDel(() => prisma.membership.deleteMany({ where: { OR: [{ customerId: { in: ids } }, { userId: { in: uids } }] } }));
    await tryDel(() => prisma.customer.deleteMany({ where: { id: { in: ids } } }));
    if (uids.length) await tryDel(() => prisma.user.deleteMany({ where: { id: { in: uids } } }));
  } catch (e) { console.error('cleanup:', e.message); }
  await prisma.$disconnect();
}

all()
  .catch((e) => { fail++; failures.push(`fatal: ${e.stack ?? e.message}`); console.error(e); })
  .finally(async () => {
    await cleanup();
    console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
    if (failures.length) { for (const f of failures) console.log(`  - ${f}`); if (api?.log) console.log(`\n── API output (last 3000 characters)\n${api.log.slice(-3000)}`); process.exit(1); }
    process.exit(0);
  });
