#!/usr/bin/env node
/**
 * End-to-end proof of data retention (0.34): the retention sweep, the
 * GET /admin/retention status route and the alert reports' coverage.
 *
 *   - aged rows go: finished commands and diagnostic runs past their window
 *     (but never the newest of a type, nor the newest that succeeded), old
 *     inventory changes, alerts resolved past the window with their events,
 *     unused tokens and grants long expired, old abuse-guard rows; old
 *     session events lose their detail and keep their rows;
 *   - open ones stay: PENDING / DISPATCHED commands, running diagnostics,
 *     OPEN and ACKNOWLEDGED alerts (and an outage alert with an open child),
 *     live sessions, used tokens and grants, anything inside its window;
 *   - the audit chain is untouched: every sealed row before the sweep is
 *     still there with the same hash, the verifier reports nothing it did not
 *     report before, and each pass that removed anything added exactly one
 *     RETENTION_PRUNED entry — an insert;
 *   - with RETENTION_SWEEP=off nothing is removed, however long it runs;
 *   - passes are bounded: with RETENTION_BATCH=2 and RETENTION_BATCHES=1 no
 *     pass removes more than 2 rows from a table, and the backlog takes
 *     several passes; once it is gone, further passes remove and log nothing;
 *   - the status route returns real counts and oldest rows, is Platform
 *     Admin only (Business A's and B's owners get 403), and the windows it
 *     reports are the clamped ones; the alert reports say how far back they
 *     can see.
 *
 * Self-starting: it runs its own API from dist/ on RETENTION_API_PORT (3411),
 * three times, against DATABASE_URL, which must name a scratch/test database.
 * The sweep is platform-wide: it also removes any other aged rows in the
 * database, which a scratch database is for. Fixtures are namespaced and
 * removed at the end, except the audit rows (the chain keeps them).
 *
 * Run:  DATABASE_URL=…/rem0te_retention_test node scripts/e2e-retention.mjs
 */
import { Prisma, PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const DB = process.env.DATABASE_URL ?? '';
const dbName = DB.split('/').pop()?.split('?')[0] ?? '';
if (!/scratch|test/.test(dbName)) { console.error(`Refusing to run against database "${dbName}": name must contain "scratch" or "test".`); process.exit(2); }
const PORT = Number(process.env.RETENTION_API_PORT ?? 3411);
if ([3000, 3001, 443].includes(PORT)) { console.error(`Refusing port ${PORT}: that is a production port.`); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'retention-e2e-password-1';
const TAG = `RT${sfx}`;
const DAY = 86_400_000;
const ago = (d) => new Date(Date.now() - d * DAY);

let pass = 0, fail = 0;
const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;

const baseEnv = {
  ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATABASE_URL: DB,
  JWT_SECRET: randomBytes(32).toString('hex'), LAUNCHER_TOKEN_SECRET: randomBytes(32).toString('hex'),
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? randomBytes(32).toString('hex'), TRUSTED_PROXIES: 'loopback',
  HBBS_PRESENCE_HOST: '127.0.0.2', MONITOR_SWEEP: 'off', METRIC_SWEEP: 'off', PATCH_POLICY_SWEEP: 'off', CLIENT_UPDATE_SWEEP: 'off',
  // The sealer stays on: the chain is verified before and after the sweep.
  AUDIT_SEALER: 'on',
  VERSION_FILE: path.resolve(here, '..', '..', '..', 'version.json'),
  RETENTION_SWEEP_SECONDS: '2',
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

const created = { businesses: [], users: [], endpoints: [] };
/** id lists per model: rows the sweep must remove, and rows it must leave. */
const gone = {}, kept = {};
const mark = (bag, model, id) => { (bag[model] ??= []).push(id); return id; };

async function waitSealed(admin) {
  for (let i = 0; i < 60; i++) {
    const r = await req('GET', '/audit/integrity', { s: admin });
    if (r.status === 200 && r.data.unsealed === 0) return true;
    await sleep(1000);
  }
  return false;
}
const present = async (model, ids) => (ids?.length ? prisma[model].count({ where: { id: { in: ids } } }) : 0);

async function all() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });
  const roleUser = await prisma.role.findFirst({ where: { type: 'BUSINESS_USER' } });

  section('Fixtures (synthetic): Business A and B, a computer each, aged and current rows in every swept table');
  const A = await prisma.customer.create({ data: { tenantId: tenant.id, name: `${TAG} Acme` } });
  const B = await prisma.customer.create({ data: { tenantId: tenant.id, name: `${TAG} Birch` } });
  created.businesses.push(A.id, B.id);
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag, extra = {}) => { const u = await prisma.user.create({ data: { email: `rt-${tag}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'RT', lastName: tag, status: 'ACTIVE', ...extra } }); created.users.push(u.id); return u; };
  const admin = await mkUser('admin', { isPlatformAdmin: true });
  const ownerA = await mkUser('owner-a'), ownerB = await mkUser('owner-b'), tech = await mkUser('tech');
  await prisma.membership.create({ data: { userId: ownerA.id, tenantId: tenant.id, customerId: A.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: ownerB.id, tenantId: tenant.id, customerId: B.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: tech.id, tenantId: tenant.id, customerId: A.id, roleId: roleUser.id, capabilities: ['computers:view', 'computers:connect'] } });
  const mkEp = async (biz, hostname) => {
    const e = await prisma.endpoint.create({ data: { tenantId: tenant.id, customerId: biz.id, name: `${TAG}-${hostname}`, hostname, platform: 'Windows', status: 'ACTIVE', isOnline: true, isManaged: true, accessMode: 'COMPANY_WIDE', lastSeenAt: new Date(), deviceClass: 'WORKSTATION', createdAt: ago(900) } });
    created.endpoints.push(e.id);
    return e;
  };
  const a1 = await mkEp(A, 'A1'), b1 = await mkEp(B, 'B1');

  // Commands (window 90 d). Per computer and type, the newest and the newest SUCCEEDED always stay.
  const cmd = async (ep, type, status, days, bag) => {
    const at = ago(days);
    const c = await prisma.endpointCommand.create({ data: {
      endpointId: ep.id, tenantId: tenant.id, customerId: ep.customerId, type, status, createdAt: at,
      completedAt: ['SUCCEEDED', 'FAILED', 'EXPIRED'].includes(status) ? at : null, expiresAt: new Date(at.getTime() + DAY),
    } });
    return mark(bag, 'endpointCommand', c.id);
  };
  await cmd(a1, 'INVENTORY_REFRESH', 'SUCCEEDED', 300, gone);
  await cmd(a1, 'INVENTORY_REFRESH', 'SUCCEEDED', 200, gone);
  await cmd(a1, 'INVENTORY_REFRESH', 'FAILED', 150, gone);
  await cmd(a1, 'INVENTORY_REFRESH', 'EXPIRED', 120, gone);
  const pendingOld = await cmd(a1, 'INVENTORY_REFRESH', 'PENDING', 250, kept);
  const dispatchedOld = await cmd(a1, 'INVENTORY_REFRESH', 'DISPATCHED', 240, kept);
  await cmd(a1, 'INVENTORY_REFRESH', 'SUCCEEDED', 30, kept); // inside the window
  await cmd(a1, 'INVENTORY_REFRESH', 'SUCCEEDED', 1, kept); // the newest
  const onlyScan = await cmd(a1, 'UPDATE_SCAN', 'SUCCEEDED', 300, kept); // the only (newest) update scan, however old
  const lastGoodLog = await cmd(a1, 'EVENT_LOG_QUERY', 'SUCCEEDED', 300, kept); // newest that succeeded
  await cmd(a1, 'EVENT_LOG_QUERY', 'FAILED', 200, kept); // newest of its type
  await cmd(b1, 'INVENTORY_REFRESH', 'SUCCEEDED', 200, gone); // Business B: the same rule
  await cmd(b1, 'INVENTORY_REFRESH', 'SUCCEEDED', 2, kept);

  // Diagnostic runs (window 90 d), the same rule per key.
  const diag = async (ep, key, status, days, bag) => {
    const at = ago(days);
    const r = await prisma.diagnosticRun.create({ data: {
      endpointId: ep.id, tenantId: tenant.id, customerId: ep.customerId, key, status, requestedById: tech.id, requestedAt: at,
      expiresAt: new Date(at.getTime() + DAY), completedAt: ['COMPLETED', 'FAILED'].includes(status) ? at : null,
      result: status === 'COMPLETED' ? { ok: true } : undefined,
    } });
    return mark(bag, 'diagnosticRun', r.id);
  };
  await diag(a1, 'disk_space', 'COMPLETED', 200, gone);
  await diag(a1, 'disk_space', 'FAILED', 150, gone);
  await diag(a1, 'disk_space', 'COMPLETED', 5, kept);
  await diag(a1, 'dns_resolution', 'RUNNING', 200, kept); // open, however old
  await diag(a1, 'dns_resolution', 'COMPLETED', 300, kept); // newest completed of its key
  await diag(b1, 'disk_space', 'EXPIRED', 200, gone);
  await diag(b1, 'disk_space', 'REQUESTED', 1, kept);

  // Inventory changes (window 400 d). Five old ones: more than one bounded pass.
  for (let i = 0; i < 5; i++) {
    const c = await prisma.endpointChange.create({ data: { endpointId: i % 2 ? b1.id : a1.id, customerId: i % 2 ? B.id : A.id, category: 'software', change: 'changed', subject: `${TAG} app ${i}`, before: '1', after: '2', detectedAt: ago(500 + i) } });
    mark(gone, 'endpointChange', c.id);
  }
  for (const d of [399, 10]) {
    const c = await prisma.endpointChange.create({ data: { endpointId: a1.id, customerId: A.id, category: 'software', change: 'added', subject: `${TAG} kept ${d}`, detectedAt: ago(d) } });
    mark(kept, 'endpointChange', c.id);
  }

  // Alerts (window 400 d after resolution).
  const alertIds = { gone: [], kept: [] };
  const alert = async (ep, state, firstDays, resolvedDays, bag, extra = {}) => {
    const a = await prisma.monitorAlert.create({ data: {
      tenantId: tenant.id, customerId: ep.customerId, endpointId: ep.id, ruleKey: 'offline', kind: 'OFFLINE',
      dedupKey: `${TAG}:${randomBytes(4).toString('hex')}`, severity: 'WARNING', state, title: `${TAG} alert`, detail: {},
      firstSeenAt: ago(firstDays), lastSeenAt: ago(resolvedDays ?? firstDays), resolvedAt: resolvedDays === null ? null : ago(resolvedDays), ...extra,
    } });
    for (const t of ['raised', 'notified', 'resolved']) await prisma.monitorAlertEvent.create({ data: { alertId: a.id, type: t, createdAt: ago(firstDays) } });
    (bag === gone ? alertIds.gone : alertIds.kept).push(a.id);
    return mark(bag, 'monitorAlert', a.id);
  };
  await alert(a1, 'RESOLVED', 520, 500, gone);
  await alert(a1, 'RESOLVED', 450, 410, gone);
  await alert(b1, 'RESOLVED', 600, 401, gone);
  await alert(a1, 'RESOLVED', 420, 300, kept); // raised long ago, resolved inside the window
  const openOld = await alert(a1, 'OPEN', 700, null, kept);
  const ackOld = await alert(b1, 'ACKNOWLEDGED', 700, null, kept);
  const parent = await alert(a1, 'RESOLVED', 600, 550, kept); // resolved outage…
  await alert(a1, 'OPEN', 600, null, kept, { parentId: parent }); // …with a child still open

  // Sessions: rows kept; detail trimmed on finished sessions only.
  const sess = async (ep, status) => prisma.supportSession.create({ data: { tenantId: tenant.id, customerId: ep.customerId, technicianId: tech.id, endpointId: ep.id, status, createdAt: ago(600) } });
  const done = await sess(a1, 'SESSION_COMPLETED'), live = await sess(b1, 'SESSION_STARTED');
  const sev = async (s, days, bag) => { const e = await prisma.supportSessionEvent.create({ data: { supportSessionId: s.id, event: 'state', source: 'server', metadata: { tag: TAG, note: 'x'.repeat(150) }, timestamp: ago(days) } }); return mark(bag, 'trim', e.id); };
  const trimMe = [await sev(done, 600, gone), await sev(done, 450, gone)];
  const keepDetail = [await sev(done, 100, kept), await sev(live, 600, kept)];

  // Tokens and grants (30 d after expiry, never used).
  const tok = async (expDays, used, bag) => {
    const t = await prisma.launcherToken.create({ data: { tenantId: tenant.id, userId: tech.id, token: `${TAG}-${randomBytes(12).toString('hex')}`, expiresAt: ago(expDays), usedAt: used ? ago(expDays + 0.01) : null, createdAt: ago(expDays + 0.02) } });
    return mark(bag, 'launcherToken', t.id);
  };
  await tok(60, false, gone); await tok(45, false, gone);
  await tok(60, true, kept); await tok(10, false, kept); await tok(-1, false, kept);
  const grant = async (ep, expDays, used, bag) => {
    const g = await prisma.connectionGrant.create({ data: { tokenHash: `${TAG}${randomBytes(16).toString('hex')}`, tenantId: tenant.id, userId: tech.id, endpointId: ep.id, expiresAt: ago(expDays), usedAt: used ? ago(expDays + 0.01) : null, createdAt: ago(expDays + 0.02) } });
    return mark(bag, 'connectionGrant', g.id);
  };
  await grant(a1, 90, false, gone); await grant(b1, 31, false, gone);
  await grant(a1, 90, true, kept); await grant(b1, 5, false, kept);

  // Abuse-guard rows (30 d).
  const priv = async (days, bag) => { const p = await prisma.privilegedActivity.create({ data: { identity: `user:${tech.id}`, kind: 'LAUNCH', endpointId: a1.id, customerId: A.id, entryPoint: 'ui', at: ago(days) } }); return mark(bag, 'privilegedActivity', p.id); };
  await priv(40, gone); await priv(35, gone); await priv(29, kept); await priv(0.01, kept);

  // Audit entries far older than any window. They are evidence: never touched.
  const oldAudit = [];
  for (const d of [3000, 1000, 500]) {
    const r = await prisma.activityLog.create({ data: { action: 'SETTINGS_UPDATED', resource: 'retention-e2e', resourceId: TAG, metadata: { tag: TAG, days: d }, createdAt: ago(d) } });
    oldAudit.push(r.id);
  }
  check(true, `seeded: ${Object.entries(gone).map(([k, v]) => `${k} ${v.length} due`).join(', ')}; ${Object.entries(kept).map(([k, v]) => `${k} ${v.length} kept`).join(', ')}`);

  const snapshotGone = async () => {
    const o = {};
    for (const [m, ids] of Object.entries(gone)) o[m] = m === 'trim' ? await prisma.supportSessionEvent.count({ where: { id: { in: ids }, metadata: { not: Prisma.DbNull } } }) : await present(m, ids);
    return o;
  };

  // ── Phase 1: sweep off ────────────────────────────────────────────────────
  section('RETENTION_SWEEP=off: nothing is removed, however long the process runs');
  startApi({ RETENTION_SWEEP: 'off' });
  await waitUp();
  const S = { admin: await login(admin.email), ownerA: await login(ownerA.email), ownerB: await login(ownerB.email), tech: await login(tech.email) };
  const before = await snapshotGone();
  await sleep(7000); // three and a half sweep intervals
  const after = await snapshotGone();
  check(JSON.stringify(before) === JSON.stringify(after) && Object.entries(gone).every(([m, ids]) => after[m] === ids.length),
    'every aged row is still there after 7 s with the sweep off', `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
  check(!/\[Retention\] pruned/.test(api.log), 'and the API logged no pass');

  section('GET /admin/retention: real counts, Platform Admin only');
  let r = await req('GET', '/admin/retention?fresh=1', { s: S.admin });
  check(r.status === 200 && r.data.sweep.enabled === false, 'the admin gets the status, which says the sweep is off', msg(r));
  const T = Object.fromEntries((r.data?.tables ?? []).map((t) => [t.key, t]));
  const [nCmd, nChg, nAudit, minCmd, minAudit] = await Promise.all([
    prisma.endpointCommand.count(), prisma.endpointChange.count(), prisma.activityLog.count(),
    prisma.endpointCommand.aggregate({ _min: { createdAt: true } }), prisma.activityLog.aggregate({ _min: { createdAt: true } }),
  ]);
  check(T.commands?.rows === nCmd && T.changes?.rows === nChg, 'row counts are the database\'s', `commands ${T.commands?.rows}/${nCmd}, changes ${T.changes?.rows}/${nChg}`);
  check(T.audit?.rows >= nAudit && T.audit?.class === 'evidence' && T.audit?.sweep === 'none', 'the audit log is listed as evidence, removed by nothing', JSON.stringify(T.audit));
  check(T.commands?.oldest === minCmd._min.createdAt?.toISOString() && T.audit?.oldest === minAudit._min.createdAt?.toISOString(), 'the oldest row is the database\'s', `${T.commands?.oldest} / ${minCmd._min.createdAt?.toISOString()}`);
  check(T.commands?.windowDays === 90 && T.alerts?.windowDays === 400 && T.changes?.windowDays === 400 && T.privileged?.windowDays === 30, 'the default windows', JSON.stringify(Object.fromEntries(Object.values(T).map((t) => [t.key, t.windowDays]))));
  check(T.metricRaw?.sweep === 'metrics' && T.metricRaw?.windowDays === 2, 'metric tables show the metric sweep\'s window (48 h)', JSON.stringify(T.metricRaw));
  for (const [who, s] of [['Business A\'s owner', S.ownerA], ['Business B\'s owner', S.ownerB], ['a Business A user', S.tech]]) {
    r = await req('GET', '/admin/retention', { s });
    check(r.status === 403, `${who} is refused (403)`, msg(r));
  }
  r = await req('GET', '/admin/retention');
  check(r.status === 401, 'without a session: 401', msg(r));

  section('Alert reports state the window they can cover');
  r = await req('GET', '/reports/alert-frequency?days=365', { s: S.admin });
  check(r.status === 200 && r.data.retention?.alertDays === 400 && r.data.retention.complete === true && r.data.retention.coversDays === 365, '365 days under 400-day retention: complete', msg(r));
  r = await req('GET', '/reports/offline-time?days=90', { s: S.ownerA });
  check(r.status === 200 && r.data.retention?.complete === true, 'offline time carries it too (Business A\'s owner)', msg(r));

  section('The audit chain before the sweep');
  check(await waitSealed(S.admin), 'every audit entry is sealed');
  const v0 = (await req('POST', '/audit/integrity/verify', { s: S.admin })).data;
  check(typeof v0?.checked === 'number', `verified: ok=${v0?.ok}, ${v0?.checked} checked, ${v0?.problems?.length ?? '?'} problem(s) already present`);
  const chain0 = await prisma.activityLog.findMany({ where: { chainHash: { not: null } }, select: { seq: true, chainHash: true }, orderBy: { seq: 'asc' } });
  const count0 = await prisma.activityLog.count();
  const checkpoints0 = await prisma.auditCheckpoint.findMany({ select: { id: true, hash: true } });
  await stopApi();

  // ── Phase 2: sweep on, two rows per table per pass ────────────────────────
  section('Sweep on, RETENTION_BATCH=2, RETENTION_BATCHES=1: aged rows go, open ones stay, every pass bounded');
  const t0 = new Date();
  startApi({ RETENTION_SWEEP: 'on', RETENTION_BATCH: '2', RETENTION_BATCHES: '1' });
  await waitUp();
  let left = null;
  for (let i = 0; i < 60; i++) {
    left = await snapshotGone();
    if (Object.values(left).every((n) => n === 0)) break;
    await sleep(1000);
  }
  check(Object.values(left).every((n) => n === 0), 'every aged row is gone (or trimmed)', JSON.stringify(left));
  const keptNow = {};
  for (const [m, ids] of Object.entries(kept)) keptNow[m] = m === 'trim' ? await prisma.supportSessionEvent.count({ where: { id: { in: ids }, metadata: { not: Prisma.DbNull } } }) : await present(m, ids);
  check(Object.entries(kept).every(([m, ids]) => keptNow[m] === ids.length), 'every row that is open, newest, used or inside its window is still there', `${JSON.stringify(keptNow)} of ${JSON.stringify(Object.fromEntries(Object.entries(kept).map(([k, v]) => [k, v.length])))}`);
  check(await present('endpointCommand', [pendingOld, dispatchedOld]) === 2, 'PENDING and DISPATCHED commands 240+ days old are untouched');
  check(await present('endpointCommand', [onlyScan, lastGoodLog]) === 2, 'the newest update scan and the newest successful event-log query stay at 300 days');
  check(await present('monitorAlert', [openOld, ackOld, parent]) === 3, 'OPEN and ACKNOWLEDGED alerts 700 days old, and a resolved outage with an open child, stay');
  check(await prisma.monitorAlertEvent.count({ where: { alertId: { in: alertIds.gone } } }) === 0
    && await prisma.monitorAlertEvent.count({ where: { alertId: { in: alertIds.kept } } }) === alertIds.kept.length * 3, 'deleted alerts took their events; kept alerts kept theirs');
  check(await prisma.supportSessionEvent.count({ where: { id: { in: trimMe } } }) === trimMe.length
    && await prisma.supportSession.count({ where: { id: { in: [done.id, live.id] } } }) === 2, 'trimmed session events keep their rows, and both sessions remain');
  check(await prisma.supportSessionEvent.count({ where: { id: { in: keepDetail }, metadata: { not: Prisma.DbNull } } }) === 2, 'a live session\'s 600-day-old event keeps its detail');

  const entries = async () => prisma.activityLog.findMany({ where: { action: 'RETENTION_PRUNED', createdAt: { gte: t0 } }, orderBy: { seq: 'asc' } });
  let E = await entries();
  check(E.length >= 3, `one RETENTION_PRUNED entry per pass that removed anything (${E.length})`);
  const tablesCounted = ['commands', 'diagnostics', 'changes', 'alerts', 'sessionEventsTrimmed', 'launcherTokens', 'connectionGrants', 'privileged'];
  check(E.every((e) => tablesCounted.every((k) => (e.metadata?.counts?.[k] ?? 0) <= 2)), 'no pass removed more than 2 rows from any table', JSON.stringify(E.map((e) => e.metadata?.counts)));
  check(E.filter((e) => e.metadata?.counts?.changes > 0).length >= 3, 'five old inventory changes took at least three passes');
  check(E[0]?.metadata?.capped?.length > 0 && E[0]?.metadata?.perPassCap === 2, 'the first pass reported which tables had more to do', JSON.stringify(E[0]?.metadata));
  const sum = (k) => E.reduce((n, e) => n + (e.metadata?.counts?.[k] ?? 0), 0);
  check(sum('changes') >= 5 && sum('alerts') >= 3 && sum('launcherTokens') >= 2 && sum('connectionGrants') >= 2 && sum('privileged') >= 2 && sum('sessionEventsTrimmed') >= 2,
    'the entries account for every row removed', JSON.stringify(Object.fromEntries(tablesCounted.map((k) => [k, sum(k)]))));
  check(E.every((e) => e.actorId === null && e.customerId === null && e.tenantId === null && e.resource === 'retention'), 'entries are platform-level, with no actor');

  section('Idempotent: once the backlog is gone, passes remove and log nothing');
  const n1 = E.length;
  await sleep(7000);
  E = await entries();
  check(E.length === n1, `no new entry in 7 s (${n1} → ${E.length})`);
  r = await req('GET', '/admin/retention?fresh=1', { s: S.admin });
  check(r.status === 200 && r.data.sweep.enabled === true && r.data.sweep.lastPass && r.data.sweep.lastPass.total === 0 && r.data.sweep.perPassCap === 2,
    'the status shows the sweep on and its last pass with nothing due', msg(r));

  section('The audit chain after the sweep');
  const S2admin = await login(admin.email);
  check(await waitSealed(S2admin), 'every audit entry is sealed, the new ones included');
  const v1 = (await req('POST', '/audit/integrity/verify', { s: S2admin })).data;
  const key = (p) => `${p.kind}@${p.seq}`;
  const p0 = new Set((v0?.problems ?? []).map(key));
  check(v1 && (v1.problems ?? []).every((p) => p0.has(key(p))) && (v1.ok || !v0.ok), 'the verifier reports nothing it did not report before', JSON.stringify(v1?.problems?.slice(0, 3)));
  check(v1.checked >= v0.checked + E.length, `it checked at least the old entries plus the ${E.length} new ones (${v0.checked} → ${v1.checked})`);
  const chain1 = new Map((await prisma.activityLog.findMany({ where: { seq: { in: chain0.map((c) => c.seq) } }, select: { seq: true, chainHash: true } })).map((c) => [c.seq, c.chainHash]));
  check(chain0.every((c) => chain1.get(c.seq) === c.chainHash), `every one of the ${chain0.length} sealed entries is still there with the same hash`);
  check(await prisma.activityLog.count() >= count0 + E.length, 'the audit log only grew');
  check(await prisma.activityLog.count({ where: { id: { in: oldAudit } } }) === 3, 'audit entries 500, 1,000 and 3,000 days old are untouched');
  const cp1 = new Map((await prisma.auditCheckpoint.findMany({ select: { id: true, hash: true } })).map((c) => [c.id, c.hash]));
  check(checkpoints0.every((c) => cp1.get(c.id) === c.hash), `every audit checkpoint is still there (${checkpoints0.length})`);
  await stopApi();

  // ── Phase 3: clamps, as the status route and the reports see them ─────────
  section('Clamped settings: RETENTION_ALERT_DAYS=5 is 30, and the reports say they cannot cover a year');
  startApi({ RETENTION_SWEEP: 'off', RETENTION_ALERT_DAYS: '5', RETENTION_COMMAND_DAYS: 'not-a-number', RETENTION_PRIVILEGED_ACTIVITY_DAYS: '0' });
  await waitUp();
  const S3 = await login(admin.email);
  r = await req('GET', '/admin/retention', { s: S3 });
  const T3 = Object.fromEntries((r.data?.tables ?? []).map((t) => [t.key, t]));
  check(T3.alerts?.windowDays === 30 && T3.commands?.windowDays === 90 && T3.privileged?.windowDays === 2, 'below the floor → the floor; unparsable → the default', JSON.stringify({ alerts: T3.alerts?.windowDays, commands: T3.commands?.windowDays, privileged: T3.privileged?.windowDays }));
  r = await req('GET', '/reports/alert-frequency?days=365', { s: S3 });
  check(r.status === 200 && r.data.retention?.complete === false && r.data.retention.coversDays === 30 && r.data.retention.alertDays === 30, 'a 365-day report under 30-day retention says it covers 30 days', msg(r));
  r = await req('GET', '/reports/alert-frequency?days=7', { s: S3 });
  check(r.status === 200 && r.data.retention?.complete === true, 'a 7-day report is still complete', msg(r));
}

async function cleanup() {
  await stopApi();
  try {
    const eps = created.endpoints, ids = created.businesses;
    await prisma.supportSession.deleteMany({ where: { endpointId: { in: eps } } }); // events cascade
    await prisma.launcherToken.deleteMany({ where: { userId: { in: created.users } } });
    await prisma.connectionGrant.deleteMany({ where: { endpointId: { in: eps } } });
    await prisma.privilegedActivity.deleteMany({ where: { endpointId: { in: eps } } });
    await prisma.monitorAlert.updateMany({ where: { endpointId: { in: eps } }, data: { parentId: null } });
    await prisma.monitorAlert.deleteMany({ where: { endpointId: { in: eps } } });
    await prisma.endpoint.deleteMany({ where: { id: { in: eps } } }); // commands, runs, changes cascade
    await prisma.membership.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.customer.deleteMany({ where: { id: { in: ids } } });
    // Users with audit entries (their logins) stay: the chain refers to them.
    for (const u of created.users) await prisma.user.delete({ where: { id: u } }).catch(() => {});
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
