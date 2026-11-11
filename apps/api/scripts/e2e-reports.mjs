#!/usr/bin/env node
/**
 * End-to-end proof of the Reports (0.32): GET /reports/patch-compliance,
 * /reports/agent-coverage, /reports/alert-frequency, /reports/offline-time
 * and each one's /export.csv.
 *
 *   - two businesses: Ash (A, two sites) and Beech (B), with computers on
 *     every agent type, bound and missing device secrets, fresh / stale /
 *     missing update scans, a Linux computer with no inventory, alerts of
 *     every kind (open, resolved by the monitor, resolved by a person, in a
 *     maintenance window, a site outage) inside and outside the period, and
 *     OFFLINE episodes that overlap, straddle the period start, are still
 *     open, or were closed without the computer coming back;
 *   - every number is checked against those fixtures exactly, and patch
 *     compliance is checked against the dashboard's own tile;
 *   - nothing of B appears anywhere in A's responses or exports (and the
 *     reverse), checked on the raw text;
 *   - a Business User sees only their granted computers;
 *   - each report needs its capability (computers:view or monitoring:alerts);
 *   - each export is a CSV with formula cells neutralised, and is audited as
 *     REPORT_EXPORTED with the report, row count and filters.
 *
 *   cd apps/api && npx nest build
 *   DATABASE_URL=postgresql://…/rem0te_reports_test node scripts/e2e-reports.mjs
 *
 * FIXTURE-TESTED: rows are written directly; the API under test is the real
 * built one, started by this script on port 3221 (REPORTS_API_PORT).
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, URLSearchParams } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const DB = process.env.DATABASE_URL ?? '';
const dbName = DB.split('/').pop()?.split('?')[0] ?? '';
if (!/scratch|test/.test(dbName)) { console.error(`Refusing to run against database "${dbName}": name must contain "scratch" or "test".`); process.exit(2); }
const PORT = Number(process.env.REPORTS_API_PORT ?? 3221);
if ([3000, 3001, 4000, 4001, 443].includes(PORT)) { console.error(`Refusing port ${PORT}.`); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'reports-e2e-password-123';

let pass = 0, fail = 0;
const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const eq = (got, want, n) => check(JSON.stringify(got) === JSON.stringify(want), n, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const near = (got, want, tol, n) => check(typeof got === 'number' && Math.abs(got - want) <= tol, n, `got ${got}, want ${want} ± ${tol}`);
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;
const hex32 = () => randomBytes(16).toString('hex');
const M = 60_000, H = 60 * M, D = 24 * H;
// Every fixture time is relative to one instant, so the differences the
// reports compute (time to resolve, episode lengths) are exact.
const T0 = Date.now();
const at = (ms) => new Date(T0 - ms);

const apiEnv = {
  ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATABASE_URL: DB,
  JWT_SECRET: randomBytes(32).toString('hex'), LAUNCHER_TOKEN_SECRET: randomBytes(32).toString('hex'),
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? randomBytes(32).toString('hex'), TRUSTED_PROXIES: 'loopback', HBBS_PRESENCE_HOST: '127.0.0.2',
  VERSION_FILE: path.resolve(here, '..', '..', '..', 'version.json'),
  // The sweep would resolve and regroup the fixture alerts (the A business has
  // an Offline monitor); the staleness sweep would flip computers offline.
  MONITOR_SWEEP: 'off', AUDIT_SEALER: 'off', ENDPOINT_STALE_SWEEP: 'off',
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
async function req(p, { s, business } = {}) {
  const h = { 'x-forwarded-for': s?.ip ?? ip() };
  if (s) h.cookie = s.cookie;
  if (business) h['x-rem0te-business'] = business;
  const r = await fetch(`${API}${p}`, { headers: h });
  const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j, data: j?.data, text, headers: r.headers };
}
async function login(email) {
  const s = { ip: ip() };
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': s.ip }, body: JSON.stringify({ email, password: PW }) });
  const mm = (r.headers.get('set-cookie') ?? '').match(/access_token=([^;]+)/);
  if (r.status !== 200 || !mm) throw new Error(`login ${email}: ${r.status} ${await r.text()}`);
  s.cookie = `access_token=${mm[1]}`;
  return s;
}
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString();
const msg = (r) => `HTTP ${r.status} ${typeof r.body === 'string' ? r.body.slice(0, 300) : JSON.stringify(r.body).slice(0, 300)}`;
const REPORTS = ['patch-compliance', 'agent-coverage', 'alert-frequency', 'offline-time'];

const created = { businesses: [], users: [] };

async function all() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });
  const roleUser = await prisma.role.findFirst({ where: { type: 'BUSINESS_USER' } });

  section('Fixtures (synthetic): Ash (A, sites HQ and Branch) and Beech (B)');
  const A = await prisma.customer.create({ data: { tenantId: tenant.id, name: `RP Ash ${sfx}` } });
  const B = await prisma.customer.create({ data: { tenantId: tenant.id, name: `RP Beech ${sfx}` } });
  created.businesses.push(A.id, B.id);
  const hq = await prisma.site.create({ data: { tenantId: tenant.id, customerId: A.id, name: `Ash HQ ${sfx}` } });
  const branch = await prisma.site.create({ data: { tenantId: tenant.id, customerId: A.id, name: `Ash Branch ${sfx}` } });
  const hqB = await prisma.site.create({ data: { tenantId: tenant.id, customerId: B.id, name: `Beech HQ ${sfx}` } });
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag, extra = {}) => { const u = await prisma.user.create({ data: { email: `rp-${tag}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'RP', lastName: tag, status: 'ACTIVE', ...extra } }); created.users.push(u.id); return u; };
  const admin = await mkUser('admin', { isPlatformAdmin: true });
  const ownerA = await mkUser('owner-a'), ownerB = await mkUser('owner-b');
  const userA = await mkUser('user-a'), viewOnly = await mkUser('view-a'), bare = await mkUser('bare-a'), tech = await mkUser('tech-a');
  await prisma.membership.create({ data: { userId: ownerA.id, tenantId: tenant.id, customerId: A.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: ownerB.id, tenantId: tenant.id, customerId: B.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: userA.id, tenantId: tenant.id, customerId: A.id, roleId: roleUser.id, capabilities: ['computers:view', 'monitoring:alerts'] } });
  await prisma.membership.create({ data: { userId: viewOnly.id, tenantId: tenant.id, customerId: A.id, roleId: roleUser.id, capabilities: ['computers:view'] } });
  await prisma.membership.create({ data: { userId: bare.id, tenantId: tenant.id, customerId: A.id, roleId: roleUser.id, capabilities: ['computers:connect'] } });
  await prisma.technicianAssignment.create({ data: { tenantId: tenant.id, customerId: A.id, userId: tech.id, capabilities: ['computers:view', 'monitoring:alerts'], endpointIds: [] } });

  const mkEp = async (biz, name, { site = null, platform = 'Windows', online = true, lastSeen = 0, channel = null, agentVersion = null, secret = 'bound', inv = null, status = 'ACTIVE', hostname } = {}) => {
    const e = await prisma.endpoint.create({ data: {
      tenantId: tenant.id, customerId: biz.id, siteId: site?.id ?? null, name: `${name}-${sfx}`, hostname: hostname === undefined ? `${name}-${sfx}` : hostname,
      platform, status, isOnline: online, isManaged: true, lastSeenAt: lastSeen === null ? null : at(lastSeen), updateChannel: channel, agentVersion,
    } });
    if (secret !== 'no_node') await prisma.rustdeskNode.create({ data: { tenantId: tenant.id, endpointId: e.id, rustdeskId: String(100000000 + ((Math.random() * 899999999) | 0)), ...(secret === 'bound' ? { agentSecretHash: hex32() + hex32() } : {}) } });
    if (inv) await prisma.endpointInventory.create({ data: { endpointId: e.id, ...inv } });
    return e;
  };
  const scan = (hoursOld, pending, reboot) => ({ updatesCheckedAt: at(hoursOld * H), pendingUpdates: pending, pendingUpdateCount: pending.length, rebootRequired: reboot, collectedAt: at(H) });
  const a1 = await mkEp(A, 'A-PC1', { site: hq, channel: 'signed', agentVersion: '0.31.0', inv: scan(1, [], false) });
  const a2 = await mkEp(A, 'A-PC2', { site: hq, agentVersion: '0.30.1', inv: scan(2, [{ title: 'Cumulative Update', kb: 'KB5000001', severity: 'Critical' }, { title: '.NET', kb: 'KB5000002', severity: 'Important' }], true) });
  const a3 = await mkEp(A, 'A-PC3', { site: branch, agentVersion: '0.30.1', secret: 'none', online: false, lastSeen: 10 * D, inv: scan(72, [], false) });
  const a4 = await mkEp(A, 'A-PC4', { site: branch, secret: 'no_node', online: false, lastSeen: null });
  const a5 = await mkEp(A, 'A-LNX1', { platform: 'Linux', agentVersion: '0.31.0', lastSeen: H });
  // A device-reported name a spreadsheet would read as a formula; no hostname, so the name is the label.
  const a6 = await mkEp(A, '=HYPERLINK("http://example.com")', { site: hq, secret: 'no_node', hostname: null });
  await mkEp(A, 'A-OLD', { status: 'ARCHIVED', agentVersion: '0.20.0' });
  await mkEp(A, 'A-NEW', { status: 'PENDING_ENROLLMENT', online: false, lastSeen: null });
  const b1 = await mkEp(B, 'B-PC1', { site: hqB, channel: 'signed', agentVersion: '0.31.0', inv: scan(1, [], false) });
  const b2 = await mkEp(B, 'B-PC2', { site: hqB, agentVersion: '0.29.0', online: false, lastSeen: 3 * H, inv: scan(1, [{ title: 'B update', kb: 'KB5999999', severity: 'Critical' }], false) });
  for (const e of [a1, a2, a4]) await prisma.computerAccess.create({ data: { tenantId: tenant.id, endpointId: e.id, userId: userA.id } });
  const a6name = a6.name;

  // An Offline monitor for all of A, switched off for A's formula-named computer. None for B.
  await prisma.monitorRule.create({ data: { scopeKey: `b:${A.id}`, customerId: A.id, key: 'offline', kind: 'OFFLINE', name: 'Computer offline', severity: 'WARNING', params: { minutes: 15 }, createdById: ownerA.id } });
  await prisma.monitorRule.create({ data: { scopeKey: `e:${a6.id}`, endpointId: a6.id, key: 'offline', kind: 'OFFLINE', name: 'Computer offline', enabled: false, severity: 'WARNING', params: { minutes: 15 }, createdById: ownerA.id } });

  // Alerts. `raised` and `resolvedAfter` are milliseconds; resolvedBy null = the monitor.
  const al = (biz, e, kind, severity, { raised, resolvedAfter = null, by = null, note = 'Cleared: the monitor reads normal again.', site, lastSeen, suppressed = false }) => prisma.monitorAlert.create({ data: {
    tenantId: tenant.id, customerId: biz.id, endpointId: e?.id ?? null, siteId: site === undefined ? e?.siteId ?? null : site?.id ?? null,
    ruleKey: kind === 'SITE_OUTAGE' ? 'site-outage' : kind.toLowerCase(), kind, dedupKey: `rp:${sfx}:${hex32()}`, severity, title: `${kind} on ${e?.name ?? 'site'} ${sfx}`,
    detail: kind === 'OFFLINE' ? { lastSeenAt: lastSeen === null ? null : at(lastSeen).toISOString(), minutes: 15 } : {},
    firstSeenAt: at(raised), lastSeenAt: at(raised), suppressed,
    ...(resolvedAfter !== null ? { state: 'RESOLVED', resolvedAt: at(raised - resolvedAfter), resolvedById: by, resolveNote: note } : {}),
  } });
  const x1 = await al(A, a1, 'CPU_HIGH', 'WARNING', { raised: 2 * D, resolvedAfter: 30 * M });
  const x2 = await al(A, a1, 'CPU_HIGH', 'WARNING', { raised: 1 * D, resolvedAfter: 90 * M, by: ownerA.id, note: 'fixed' });
  const x3 = await al(A, a2, 'DISK_FREE', 'CRITICAL', { raised: 3 * H });
  const x6 = await al(A, null, 'SITE_OUTAGE', 'CRITICAL', { raised: 1 * D, resolvedAfter: 60 * M, site: hq });
  const x7 = await al(A, a5, 'MEMORY_HIGH', 'INFO', { raised: 40 * D, resolvedAfter: 10 * M }); // outside 30 days
  const x8 = await al(A, a2, 'REBOOT_PENDING', 'INFO', { raised: 6 * H, suppressed: true });
  // Offline episodes.
  const o1 = await al(A, a3, 'OFFLINE', 'WARNING', { raised: 10 * D - 15 * M, lastSeen: 10 * D }); // still offline
  const o2 = await al(A, a2, 'OFFLINE', 'WARNING', { raised: 5 * D - 16 * M, lastSeen: 5 * D, resolvedAfter: 84 * M }); // 100 min, reconnected
  // A person resolved it while still offline; the monitor raised it again; it cleared at +60 min. One 60-minute episode.
  const o3 = await al(A, a2, 'OFFLINE', 'WARNING', { raised: 2 * D - 15 * M, lastSeen: 2 * D, resolvedAfter: 15 * M, by: ownerA.id, note: 'looking at it' });
  const o4 = await al(A, a2, 'OFFLINE', 'WARNING', { raised: 2 * D - 31 * M, lastSeen: 2 * D, resolvedAfter: 29 * M });
  const o5 = await al(A, a1, 'OFFLINE', 'WARNING', { raised: 40 * D - 15 * M, lastSeen: 40 * D, resolvedAfter: 30 * M }); // outside 30 days
  // Never seen: the start is when the monitor noticed. Closed because the monitor stopped applying, not because it came back.
  const o6 = await al(A, a4, 'OFFLINE', 'WARNING', { raised: 3 * D, lastSeen: null, resolvedAfter: 120 * M, note: 'Closed: the monitor no longer applies to this computer, or the computer was retired.' });
  // Straddles the 30-day period start: from 31 days ago to 29 days ago.
  const o7 = await al(A, a6, 'OFFLINE', 'WARNING', { raised: 31 * D - 15 * M, lastSeen: 31 * D, resolvedAfter: 2 * D - 15 * M });
  const y1 = await al(B, b1, 'CPU_HIGH', 'CRITICAL', { raised: 1 * D, resolvedAfter: 20 * M });
  const y2 = await al(B, b2, 'OFFLINE', 'WARNING', { raised: 3 * H - 15 * M, lastSeen: 3 * H });

  startApi();
  await waitUp();
  const S = {
    admin: await login(admin.email), ownerA: await login(ownerA.email), ownerB: await login(ownerB.email),
    userA: await login(userA.email), viewOnly: await login(viewOnly.email), bare: await login(bare.email), tech: await login(tech.email),
  };
  const get = (s, report, params = {}, opts = {}) => req(`/reports/${report}?${qs(params)}`, { s, ...opts });
  const csv = (s, report, params = {}, opts = {}) => req(`/reports/${report}/export.csv?${qs(params)}`, { s, ...opts });

  const bMarkers = [B.id, B.name, hqB.id, hqB.name, b1.id, b2.id, b1.name, b2.name, y1.id, y2.id, 'KB5999999'];
  const aMarkers = [A.id, A.name, hq.id, hq.name, branch.id, a1.id, a2.id, a3.id, a1.name, a2.name, a3.name, x1.id, o1.id];
  const leaks = (text, markers) => markers.filter((m) => text.includes(m));
  const ids = (l) => l.map((r) => r.device?.id ?? null).sort();

  // ── Patch compliance ──────────────────────────────────────────────────────
  section('Patch compliance — Business Owner of A');
  let r = await get(S.ownerA, 'patch-compliance');
  check(r.status === 200, 'loads', msg(r));
  let d = r.data;
  eq(leaks(r.text, bMarkers), [], 'nothing of Beech anywhere in the response');
  const pick = (t) => ({ total: t.total, fresh: t.fresh, upToDate: t.upToDate, needsUpdates: t.needsUpdates, stale: t.stale, noScan: t.noScan, compliancePercent: t.compliancePercent, coveragePercent: t.coveragePercent });
  eq({ ...pick(d.totals), noScanNotWindows: d.totals.noScanNotWindows, restartPending: d.totals.restartPending, pendingUpdates: d.totals.pendingUpdates },
    { total: 6, fresh: 2, upToDate: 1, needsUpdates: 1, stale: 1, noScan: 3, compliancePercent: 50, coveragePercent: 33, noScanNotWindows: 1, restartPending: 1, pendingUpdates: 2 },
    'totals: 6 active computers (archived and pending excluded); compliance only over fresh scans; stale and missing counted apart');
  check(typeof d.definition === 'string' && d.definition.includes('36 hours') && d.staleAfterHours === 36, 'states its definition (36-hour scans)', d.definition);
  const dash = await req('/dashboard/overview', { s: S.ownerA });
  eq(pick(dash.data.patch), pick(d.totals), 'the same numbers as the dashboard\'s patch compliance tile');
  check(dash.data.patch.definition === d.definition, 'and the same definition, word for word');
  eq(d.bySite.map((g) => [g.site?.id ?? null, g.total, g.fresh, g.upToDate, g.needsUpdates, g.stale, g.noScan]).sort(),
    [[branch.id, 2, 0, 0, 0, 1, 1], [hq.id, 3, 2, 1, 1, 0, 1], [null, 1, 0, 0, 0, 0, 1]].sort(), 'per site: HQ, Branch and no site, each counted');
  eq(d.byBusiness.map((g) => [g.business.id, g.total, g.compliancePercent]), [[A.id, 6, 50]], 'per business: A only');
  eq([d.devicesTotal, d.devices[0]?.device.id, d.devices[0]?.state, d.devices[1]?.device.id, d.devices[1]?.state], [5, a2.id, 'needs_updates', a3.id, 'stale_scan'], 'devices needing attention: needs updates first, then stale, then no scan (5; the up-to-date one is not listed)');
  check(d.devices.find((x) => x.device.id === a5.id)?.windows === false && d.devices.find((x) => x.device.id === a4.id)?.pendingCount === null, 'a computer with no scan has no pending count (not zero), and the Linux one is marked not Windows');
  r = await get(S.ownerA, 'patch-compliance', { siteId: hq.id });
  eq(pick(r.data.totals), { total: 3, fresh: 2, upToDate: 1, needsUpdates: 1, stale: 0, noScan: 1, compliancePercent: 50, coveragePercent: 67 }, 'site filter: HQ only');
  check(r.data.facets.sites.some((s) => s.id === branch.id) && !r.data.facets.sites.some((s) => s.id === hqB.id), 'the site menu offers A\'s sites, not B\'s');

  section('Patch compliance — Business User of A (granted A-PC1, A-PC2, A-PC4)');
  r = await get(S.userA, 'patch-compliance');
  d = r.data;
  eq(leaks(r.text, [...bMarkers, a3.id, a5.id, a6.id, a3.name]), [], 'nothing of Beech, nor A\'s computers they were not granted');
  eq(pick(d.totals), { total: 3, fresh: 2, upToDate: 1, needsUpdates: 1, stale: 0, noScan: 1, compliancePercent: 50, coveragePercent: 67 }, 'their three computers');
  r = await get(S.userA, 'patch-compliance', { businessId: B.id });
  check(r.status === 403, 'asking for Beech is refused (403), not answered empty', msg(r));

  // ── Agent coverage ────────────────────────────────────────────────────────
  section('Agent coverage — Business Owner of A');
  r = await get(S.ownerA, 'agent-coverage');
  check(r.status === 200, 'loads', msg(r));
  d = r.data;
  eq(leaks(r.text, bMarkers), [], 'nothing of Beech anywhere in the response');
  check(!/agentSecretHash/.test(r.text), 'no secret hash in the response, only whether one is bound');
  eq(d.totals, { total: 6, signed: 1, standard: 3, none: 2, noDeviceSecret: 3, silent: 2, nonWindowsNoInventory: 1 }, 'totals: 1 signed, 3 standard, 2 no agent; 3 without a device secret; 2 silent 7 days; 1 non-Windows without inventory');
  eq(d.versions.map((v) => [v.type, v.version, v.count]), [['signed', '0.31.0', 1], ['standard', '0.31.0', 1], ['standard', '0.30.1', 2], ['none', null, 2]], 'by agent type and version');
  eq(ids(d.noDeviceSecret.rows), [a3.id, a4.id, a6.id].sort(), 'no device secret: A-PC3 (none bound), A-PC4 and the formula one (no RustDesk record)');
  eq(d.noDeviceSecret.rows.map((x) => [x.device.id, x.secret]).sort(), [[a3.id, 'none'], [a4.id, 'no_rustdesk_record'], [a6.id, 'no_rustdesk_record']].sort(), 'and says which');
  eq(d.silent.rows.map((x) => x.device.id), [a4.id, a3.id], 'not heard from in 7 days: never first, then oldest');
  eq(ids(d.nonWindowsNoInventory.rows), [a5.id], 'non-Windows with no inventory: the Linux computer');
  eq(d.bySite.map((g) => [g.site?.id ?? null, g.total, g.noDeviceSecret, g.silent]).sort(), [[branch.id, 2, 2, 2], [hq.id, 3, 1, 0], [null, 1, 0, 0]].sort(), 'per site');
  r = await get(S.ownerA, 'agent-coverage', { silentDays: 30 });
  eq([r.data.silentDays, r.data.totals.silent, ids(r.data.silent.rows)], [30, 1, [a4.id]], 'silentDays=30: only the never-seen computer');
  r = await get(S.ownerA, 'agent-coverage', { silentDays: 5 });
  check(r.status === 400, 'silentDays outside the offered values is a 400, not a default', msg(r));

  section('Agent coverage — Business User of A');
  r = await get(S.userA, 'agent-coverage');
  eq(leaks(r.text, [...bMarkers, a3.id, a5.id, a6.id]), [], 'nothing of Beech, nor ungranted computers');
  eq(r.data.totals, { total: 3, signed: 1, standard: 1, none: 1, noDeviceSecret: 1, silent: 1, nonWindowsNoInventory: 0 }, 'their three');

  // ── Alert frequency ───────────────────────────────────────────────────────
  section('Alert frequency — Business Owner of A, 30 days');
  r = await get(S.ownerA, 'alert-frequency');
  check(r.status === 200 && r.data.days === 30, 'loads, 30 days by default', msg(r));
  d = r.data;
  eq(leaks(r.text, bMarkers), [], 'nothing of Beech anywhere in the response');
  eq(d.totals, {
    raised: 10, critical: 2, warning: 7, info: 1, inMaintenance: 1, open: 3, resolved: 7, resolvedByPerson: 2, resolvedByMonitor: 5,
    medianResolveMinutes: 60, meanResolveMinutes: 61.1, longestResolveMinutes: 120,
  }, 'totals: 10 raised in 30 days (not the 40- and 31-day-old ones); time to resolve over the 7 resolved only');
  eq(d.byMonitor.map((g) => [g.kind, g.raised]), [['OFFLINE', 5], ['CPU_HIGH', 2], ['DISK_FREE', 1], ['REBOOT_PENDING', 1], ['SITE_OUTAGE', 1]], 'per monitor type, most first');
  eq(d.byComputer.map((g) => [g.device?.id ?? `site:${g.site?.id}`, g.raised]), [[a2.id, 5], [a1.id, 2], [a3.id, 1], [a4.id, 1], [`site:${hq.id}`, 1]].sort((p, q) => q[1] - p[1]), 'per computer, most first; the site outage on its own row');
  check(d.byComputer.find((g) => g.device?.id === a1.id)?.medianResolveMinutes === 60 && d.byComputer.find((g) => g.device?.id === a1.id)?.resolvedByPerson === 1, 'A-PC1: median of 30 and 90 minutes is 60; one resolved by a person');
  eq(d.bySite.map((g) => [g.site?.id ?? null, g.raised]).sort(), [[branch.id, 2], [hq.id, 8]].sort(), 'per site');
  eq(d.byBusiness.map((g) => [g.business.id, g.raised]), [[A.id, 10]], 'per business');
  r = await get(S.ownerA, 'alert-frequency', { days: 90 });
  eq(r.data.totals.raised, 13, '90 days: the 31- and 40-day-old alerts join (13)');
  r = await get(S.ownerA, 'alert-frequency', { days: 7 });
  eq(r.data.totals.raised, 9, '7 days: the 10-day-old offline alert leaves (9)');
  r = await get(S.ownerA, 'alert-frequency', { siteId: branch.id });
  eq(r.data.totals.raised, 2, 'site filter: Branch only');
  r = await get(S.ownerA, 'alert-frequency', { days: 5 });
  check(r.status === 400, 'a period outside the offered values is a 400', msg(r));

  section('Alert frequency — Business User of A, technician of A');
  r = await get(S.userA, 'alert-frequency');
  eq(leaks(r.text, [...bMarkers, a3.id, x6.id, o1.id]), [], 'Business User: nothing of Beech, of ungranted computers, or the site outage');
  eq([r.data.totals.raised, r.data.totals.resolved], [8, 6], 'Business User: only alerts on their computers (8 raised, 6 resolved)');
  r = await get(S.tech, 'alert-frequency', {}, { business: A.id });
  check(r.status === 200 && r.data.totals.raised === 10 && !leaks(r.text, bMarkers).length, 'technician assigned to all of A: A\'s full count, nothing of Beech', msg(r));
  r = await get(S.tech, 'alert-frequency', { businessId: B.id }, { business: A.id });
  check(r.status === 403, 'technician asking for Beech is refused (403)', msg(r));

  // ── Offline time ──────────────────────────────────────────────────────────
  section('Offline time — Business Owner of A, 30 days');
  r = await get(S.ownerA, 'offline-time');
  check(r.status === 200, 'loads', msg(r));
  d = r.data;
  eq(leaks(r.text, bMarkers), [], 'nothing of Beech anywhere in the response');
  check(/no availability percentage/i.test(d.definition) && !('availabilityPercent' in d.totals), 'says why there is no availability percentage, and gives none', d.definition);
  const comp = (id) => d.computers.find((c) => c.device.id === id);
  eq(d.computers.map((c) => c.device.id), [a3.id, a6.id, a2.id, a4.id], 'computers with offline time, most first (A-PC1\'s 40-day-old episode is outside the period)');
  near(comp(a3.id)?.offlineMinutes, 10 * 24 * 60 + (Date.now() - T0) / M, 1, 'A-PC3: from its last heartbeat 10 days ago until now, still offline');
  check(comp(a3.id)?.stillOffline === true && comp(a3.id)?.episodes === 1, 'A-PC3 is still offline, one episode');
  eq([comp(a2.id)?.offlineMinutes, comp(a2.id)?.episodes, comp(a2.id)?.alerts, comp(a2.id)?.longestMinutes, comp(a2.id)?.endedByPerson], [160, 2, 3, 100, 1],
    'A-PC2: 100 + 60 minutes; the alert a person closed while it was still offline and the one raised after it are one episode');
  eq([comp(a4.id)?.offlineMinutes, comp(a4.id)?.closedWithoutReconnect], [120, 1], 'A-PC4: never seen, measured from when the monitor noticed; closed without reconnecting, and said so');
  near(comp(a6.id)?.offlineMinutes, 24 * 60 - (Date.now() - T0) / M, 1, 'the formula-named computer: only the part of its episode inside the period (about 1 day of 2)');
  eq([d.totals.computers, d.totals.episodes, d.totals.stillOffline], [4, 5, 1], 'totals: 4 computers, 5 episodes, 1 still offline');
  eq([d.coverage.computers, d.coverage.monitored, d.coverage.notMonitored.rows.map((x) => x.device.id)], [6, 5, [a6.id]], 'coverage now: 6 computers, 5 with an Offline monitor; the one switched off is named');
  eq(d.recordsBeginAt, o5.firstSeenAt.toISOString(), 'says when the records begin (the oldest offline alert)');
  r = await get(S.ownerA, 'offline-time', { days: 90 });
  eq([r.data.computersTotal, r.data.computers.find((c) => c.device.id === a1.id)?.offlineMinutes, r.data.computers.find((c) => c.device.id === a6.id)?.offlineMinutes], [5, 45, 2 * 24 * 60], '90 days: A-PC1 (45 min) joins, and the straddling episode counts in full (2 days)');
  r = await get(S.ownerA, 'offline-time', { days: 7 });
  near(r.data.computers.find((c) => c.device.id === a3.id)?.offlineMinutes, 7 * 24 * 60, 0.2, '7 days: A-PC3\'s episode is clipped to the period (7 days exactly)');

  section('Offline time — Business User of A; Business Owner of B');
  r = await get(S.userA, 'offline-time');
  eq(leaks(r.text, [...bMarkers, a3.id, a6.id, o1.id, o7.id]), [], 'Business User: nothing of Beech or of ungranted computers');
  eq(r.data.computers.map((c) => [c.device.id, c.offlineMinutes]), [[a2.id, 160], [a4.id, 120]], 'Business User: their two computers with offline time');
  eq([r.data.coverage.computers, r.data.coverage.monitored], [3, 3], 'Business User: coverage over their three');
  r = await get(S.ownerB, 'offline-time');
  eq(leaks(r.text, aMarkers), [], 'Owner of B: nothing of Ash anywhere in the response');
  eq([r.data.computers.map((c) => c.device.id), r.data.coverage.monitored, r.data.coverage.notMonitored.total], [[b2.id], 0, 2], 'Owner of B: B-PC2 offline; no Offline monitor in B, so both computers are listed as not monitored');
  near(r.data.computers[0]?.offlineMinutes, 180 + (Date.now() - T0) / M, 1, 'B-PC2: three hours and counting');

  section('Business Owner of B (every report)');
  for (const rep of REPORTS) {
    r = await get(S.ownerB, rep);
    check(r.status === 200 && !leaks(r.text, aMarkers).length, `${rep}: nothing of Ash`, `${msg(r)} leaks ${leaks(r.text, aMarkers)}`);
  }
  r = await get(S.ownerB, 'patch-compliance');
  eq(pick(r.data.totals), { total: 2, fresh: 2, upToDate: 1, needsUpdates: 1, stale: 0, noScan: 0, compliancePercent: 50, coveragePercent: 100 }, 'B\'s patch compliance');
  r = await get(S.ownerB, 'alert-frequency');
  eq([r.data.totals.raised, r.data.totals.medianResolveMinutes], [2, 20], 'B\'s alerts: 2 raised, the resolved one in 20 minutes');

  section('Platform Admin');
  r = await get(S.admin, 'patch-compliance');
  check(r.status === 200 && r.data.scope === 'platform' && r.data.byBusiness.some((g) => g.business?.id === A.id) && r.data.byBusiness.some((g) => g.business?.id === B.id), 'platform-wide: both businesses', msg(r));
  for (const rep of REPORTS) {
    const own = await get(S.ownerA, rep);
    const adm = await get(S.admin, rep, { businessId: A.id });
    const t = (x) => JSON.stringify(rep === 'offline-time' ? { computers: x.data.totals.computers, episodes: x.data.totals.episodes } : x.data.totals);
    // The filter menus (facets) still list every business for a Platform Admin, as the device list's do; the report itself must not.
    const body = JSON.stringify({ ...adm.data, facets: undefined });
    check(adm.status === 200 && t(adm) === t(own) && !leaks(body, bMarkers).length, `${rep}: narrowed to A, exactly the owner's totals and nothing of Beech`, `${t(adm)} vs ${t(own)}; leaks ${leaks(body, bMarkers)}`);
  }
  // Unfiltered, a Platform Admin's computer alerts must be there too. Until
  // 0.34 they were not: the visibility filter is {} for someone who sees
  // everything, and `{ endpoint: {} }` inside an OR matched no alert with a
  // computer — only site outages were counted.
  for (const rep of ['alert-frequency', 'offline-time']) {
    const a = await get(S.ownerA, rep), b = await get(S.ownerB, rep), all = await get(S.admin, rep);
    const n = (x) => rep === 'offline-time' ? x.data.totals.episodes : x.data.totals.raised;
    check(all.status === 200 && n(all) === n(a) + n(b), `${rep}: unfiltered, the Platform Admin counts A's and B's computer alerts (${n(a)} + ${n(b)})`, `got ${n(all)}`);
  }

  // ── Capabilities ──────────────────────────────────────────────────────────
  section('Each report needs the capability of what it summarises');
  for (const rep of ['patch-compliance', 'agent-coverage']) {
    r = await get(S.viewOnly, rep);
    check(r.status === 200, `computers:view alone: ${rep} loads`, msg(r));
  }
  for (const rep of ['alert-frequency', 'offline-time']) {
    r = await get(S.viewOnly, rep);
    check(r.status === 403, `computers:view alone: ${rep} is a 403 (needs monitoring:alerts)`, msg(r));
    r = await csv(S.viewOnly, rep);
    check(r.status === 403, `computers:view alone: ${rep} export is a 403`, msg(r));
  }
  for (const rep of REPORTS) {
    r = await get(S.bare, rep);
    check(r.status === 403, `no capability: ${rep} is a 403`, msg(r));
  }
  r = await req('/reports/patch-compliance');
  check(r.status === 401, 'signed out: 401', msg(r));

  // ── Export ────────────────────────────────────────────────────────────────
  section('CSV export: audited, formulas neutralised');
  const audits = (who) => prisma.activityLog.findMany({ where: { action: 'REPORT_EXPORTED', actorId: who.id }, orderBy: { createdAt: 'asc' } });
  r = await csv(S.bare, 'patch-compliance');
  check(r.status === 403 && (await audits(bare)).length === 0, 'refused without the capability, and nothing is recorded as exported');
  r = await csv(S.ownerA, 'patch-compliance');
  let lines = r.text.replace(/^\uFEFF/, '').trim().split('\r\n');
  check(r.status === 200 && /text\/csv/.test(r.headers.get('content-type') ?? '') && /attachment; filename="patch-compliance-/.test(r.headers.get('content-disposition') ?? ''), 'patch compliance export is a CSV attachment', msg(r));
  check(lines.length === 1 + 6 && lines[0].startsWith('"Business","Site","Device"'), 'one header and one line per computer (6)', `lines ${lines.length}`);
  check(lines.some((l) => l.includes(`"'${a6name.replace(/"/g, '""')}"`)) && !lines.some((l) => l.includes(`,"${a6name.replace(/"/g, '""')}"`)), 'a device name starting with "=" is prefixed with an apostrophe', lines.find((l) => l.includes('HYPERLINK')));
  eq(leaks(r.text, bMarkers), [], 'nothing of Beech in the export');
  r = await csv(S.ownerA, 'agent-coverage', { silentDays: 30 });
  lines = r.text.replace(/^\uFEFF/, '').trim().split('\r\n');
  check(r.status === 200 && lines.length === 7 && lines[0].includes('Not heard from in 30 days') && !/[0-9a-f]{64}/.test(r.text), 'agent coverage export: 6 computers, the chosen period in the header, no secret hashes', `lines ${lines.length}`);
  r = await csv(S.ownerA, 'alert-frequency');
  lines = r.text.replace(/^\uFEFF/, '').trim().split('\r\n');
  check(r.status === 200 && lines.length === 1 + 10 && !leaks(r.text, bMarkers).length, 'alert frequency export: one line per alert raised in the period (10)', `lines ${lines.length}`);
  check(lines.filter((l) => l.includes('"CPU_HIGH","cpu_high","WARNING"')).length === 2, 'each alert is a line with its monitor type, monitor and severity');
  r = await csv(S.ownerA, 'offline-time');
  lines = r.text.replace(/^\uFEFF/, '').trim().split('\r\n');
  check(r.status === 200 && lines.length === 1 + 4, 'offline time export: one line per computer with offline time (4)', `lines ${lines.length}`);
  const ownA = await audits(ownerA);
  eq(ownA.map((x) => [x.customerId, x.resource, x.resourceId, x.metadata?.report, x.metadata?.rows]),
    [[A.id, 'report', 'patch-compliance', 'patch-compliance', 6], [A.id, 'report', 'agent-coverage', 'agent-coverage', 6], [A.id, 'report', 'alert-frequency', 'alert-frequency', 10], [A.id, 'report', 'offline-time', 'offline-time', 4]],
    'every export is audited: business, report, row count');
  eq([ownA[1].metadata?.filters?.silentDays, ownA[2].metadata?.filters?.days, ownA[2].metadata?.viaTechnicianAssignment], [30, 30, false], 'with the filters it was made with');
  r = await csv(S.userA, 'alert-frequency');
  lines = r.text.replace(/^\uFEFF/, '').trim().split('\r\n');
  check(r.status === 200 && lines.length === 1 + 8 && !leaks(r.text, [...bMarkers, a3.name]).length, 'Business User export: only their computers\' alerts (8)', `lines ${lines.length}`);
  r = await csv(S.tech, 'patch-compliance', {}, { business: A.id });
  const ta = await audits(tech);
  check(r.status === 200 && ta[0]?.customerId === A.id && ta[0]?.metadata?.viaTechnicianAssignment === true, 'a technician export is audited against A, marked as via an assignment', JSON.stringify(ta[0]?.metadata));
  r = await csv(S.admin, 'alert-frequency', { businessId: B.id });
  const aa = await audits(admin);
  check(r.status === 200 && !leaks(r.text, aMarkers).length && aa[0]?.customerId === B.id && aa[0]?.metadata?.filters?.businessId === B.id, 'a Platform Admin export narrowed to B is audited against B and has nothing of Ash', JSON.stringify(aa[0]?.metadata));
  r = await csv(S.userA, 'patch-compliance', { businessId: B.id });
  check(r.status === 403, 'export naming a foreign business is a 403', msg(r));
  void x2; void x3; void x7; void x8; void o2; void o3; void o4; void o6;
}

async function cleanup() {
  await stopApi();
  try {
    const ids = created.businesses;
    const eps = (await prisma.endpoint.findMany({ where: { customerId: { in: ids } }, select: { id: true } })).map((e) => e.id);
    await prisma.monitorAlert.updateMany({ where: { customerId: { in: ids } }, data: { parentId: null } });
    await prisma.monitorAlert.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.monitorRule.deleteMany({ where: { OR: [{ customerId: { in: ids } }, { endpointId: { in: eps } }] } });
    await prisma.technicianAssignment.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.computerAccess.deleteMany({ where: { endpointId: { in: eps } } });
    await prisma.endpointInventory.deleteMany({ where: { endpointId: { in: eps } } });
    await prisma.endpoint.deleteMany({ where: { id: { in: eps } } });
    await prisma.site.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.membership.deleteMany({ where: { customerId: { in: ids } } });
    // Audit rows stay (they are append-only); deleting the business nulls their reference.
    await prisma.customer.deleteMany({ where: { id: { in: ids } } });
    await prisma.activityLog.updateMany({ where: { actorId: { in: created.users } }, data: { actorId: null } }).catch(() => undefined);
    if (created.users.length) await prisma.user.deleteMany({ where: { id: { in: created.users } } });
  } catch (e) { console.error('cleanup:', e.message); }
  await prisma.$disconnect();
}

all().catch((e) => { fail++; failures.push(`crashed: ${e.stack ?? e}`); console.error(e); if (api) console.error(api.log.slice(-3000)); })
  .finally(async () => {
    await cleanup();
    console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
    if (failures.length) { for (const f of failures) console.log(`  - ${f}`); if (api?.log) console.log(`\n── API output (last 4000 characters)\n${api.log.slice(-4000)}`); process.exit(1); }
    process.exit(0);
  });
