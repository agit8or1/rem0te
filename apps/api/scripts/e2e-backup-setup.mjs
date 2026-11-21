#!/usr/bin/env node
/**
 * End-to-end proof of Settings → Backups and the St0r push contract (0.82
 * Wharf), against the real built API and a scratch database only. No St0r is
 * called (Rem0te never connects to one), and every asset here is synthetic.
 *
 *   - Settings → Backups is a Platform Admin's: the push address comes from
 *     the public address, with headers and limits, and every capability is in
 *     one of the four states (Comet planned, failover unsupported);
 *   - create: fresh authentication on `ask`, the token shown once, never in
 *     a list;
 *   - the dry run (?dryRun=1): the same 401s, the same schema, writes no
 *     provider row and not the connection's last result — only its audit row;
 *     says how each asset would link and warns about a drill whose point is
 *     unknown and a simulated drill;
 *   - the push and idempotency: re-sending is safe in any order — a finished
 *     job is never put back to running, an integrity result never back to
 *     not_checked, a finished drill never back to running;
 *   - a refused push keeps its reason on the connection;
 *   - rotate: fresh authentication, a new token shown once, the old one
 *     refused at once, audited with last-four only;
 *   - link to computer: scoped (assetWhere, the asset's own business, a
 *     computer the caller can see), monitoring:configure, audited; a person's
 *     link outlives reports, "none" stays unlinked, "auto" gives it back;
 *   - another business refused everywhere; revoke ends push and dry run;
 *   - the documented limits: 413 over 1 MB, 429 past the rate limit;
 *   - nothing secret in an audit row or the API's output.
 *
 *   cd apps/api && npx nest build
 *   DATABASE_URL=postgresql://…/<name containing scratch or test> node scripts/e2e-backup-setup.mjs
 *
 * Ports 4061 (API) and 4062 (spare). Never 3001.
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { confirmEverythingAsks } from './lib/confirm-asks.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const DB = process.env.DATABASE_URL ?? '';
const dbName = DB.split('/').pop()?.split('?')[0] ?? '';
if (!/scratch|test/.test(dbName)) { console.error(`Refusing to run against database "${dbName}": name must contain "scratch" or "test".`); process.exit(2); }
const PORT = Number(process.env.BACKUP_SETUP_API_PORT ?? 4061);
if (PORT < 4061 || PORT > 4062) { console.error(`Refusing port ${PORT}: this suite uses 4061–4062.`); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
const PUBLIC = 'https://rmm.example.test';
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex').toUpperCase();
const PW = 'backup-setup-e2e-password-123';

let pass = 0, fail = 0;
const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;
const HOUR = 3_600_000;
const ago = (h) => new Date(Date.now() - h * HOUR).toISOString();

const JWT = randomBytes(32).toString('hex'), LTS = randomBytes(32).toString('hex'), ENC = randomBytes(32).toString('hex');
let api;
function startApi() {
  const p = spawn(process.execPath, [path.join(dist, 'main.js')], {
    env: {
      ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATABASE_URL: DB, JWT_SECRET: JWT, LAUNCHER_TOKEN_SECRET: LTS, ENCRYPTION_KEY: ENC,
      TRUSTED_PROXIES: 'loopback', HBBS_PRESENCE_HOST: '127.0.0.2', VERSION_FILE: path.resolve(here, '..', '..', '..', 'version.json'),
      FRONTEND_URL: PUBLIC, PUBLIC_API_URL: PUBLIC,
      GEOIP_DB_PATH: path.join(here, 'no-geoip.mmdb'),
      INTEGRATION_PEERS_FILE: '', REPORT_SCHEDULE_SWEEP: 'off', AUDIT_SEALER: 'off', STALE_SWEEP: 'off', MONITOR_SWEEP: 'off',
      CLIENT_UPDATE_SWEEP: 'off', PATCH_POLICY_SWEEP: 'off', METRIC_SWEEP: 'off', RETENTION_SWEEP: 'off', CHAT_RETENTION_SWEEP: 'off', TRAY_SWEEP: 'off',
      SCRIPT_OUTPUT_SWEEP: 'off', AUTO_MIGRATION_SWEEP: 'off', WINGET_INDEX_SWEEP: 'off', SNAPSHOT_SWEEP: 'off', AGENT_AUTO_UPDATE: 'off',
      WARRANTY_SWEEP: 'off', AUTOMATION_SWEEP: 'off', RESTART_WINDOW_SWEEP: 'off', SSO_SESSION_SWEEP: 'off', TERMINAL_SWEEP: 'off',
      BACKUP_SYNC_SWEEP: 'off', MDM_SWEEP: 'off',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.log = ''; p.stdout.on('data', (d) => { p.log += d; }); p.stderr.on('data', (d) => { p.log += d; });
  return p;
}
async function waitUp() {
  for (let i = 0; i < 120; i++) { try { const r = await fetch(`${API}/health`); if (r.status < 500) return; } catch { /* */ } await sleep(300); }
  throw new Error(`api did not come up:\n${api.log.slice(-3000)}`);
}
async function stopApi() { if (api && api.exitCode === null) await new Promise((r) => { api.once('exit', r); api.kill('SIGTERM'); }); }
async function req(method, p, { s, body, raw, auth, from } = {}) {
  await sleep(40);
  const h = { 'content-type': 'application/json', 'x-forwarded-for': from ?? ip() };
  if (s) h.cookie = s.cookie + (s.stepUp ? `; step_up=${s.stepUp}` : '');
  if (auth) h.authorization = auth;
  const r = await fetch(`${API}${p}`, { method, headers: h, body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j, data: j?.data, text, headers: r.headers, setCookie: r.headers.get('set-cookie') ?? '' };
}
async function login(email) {
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip() }, body: JSON.stringify({ email, password: PW }) });
  const mm = (r.headers.get('set-cookie') ?? '').match(/access_token=([^;]+)/);
  if (r.status !== 200 || !mm) throw new Error(`login ${email}: ${r.status} ${await r.text()}`);
  return { cookie: `access_token=${mm[1]}` };
}
async function stepUp(s) {
  const r = await req('POST', '/auth/step-up', { s, body: { password: PW } });
  const mm = r.setCookie.match(/step_up=([^;]+)/);
  if (r.status !== 200 || !mm) throw new Error(`step-up: ${r.status} ${JSON.stringify(r.body)}`);
  return { ...s, stepUp: mm[1] };
}
const code = (r) => r.body?.code ?? r.body?.message?.code ?? r.body?.error?.code;
const msg = (r) => `HTTP ${r.status} ${typeof r.body === 'string' ? r.body.slice(0, 300) : JSON.stringify(r.body).slice(0, 600)}`;
const created = { businesses: [], users: [] };

const job = (id, hoursAgo, o = {}) => ({ externalId: id, startedAt: ago(hoursAgo + 0.5), finishedAt: ago(hoursAgo), completion: 'succeeded', integrity: 'passed', ...o });

async function all() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  await confirmEverythingAsks(prisma);
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });
  const roleUser = await prisma.role.findFirst({ where: { type: 'BUSINESS_USER' } });

  section('Fixtures (synthetic): Acme (A) and Birch (B)');
  const A = await prisma.customer.create({ data: { tenantId: tenant.id, name: `Acme Wharf ${sfx}` } });
  const B = await prisma.customer.create({ data: { tenantId: tenant.id, name: `Birch Wharf ${sfx}` } });
  created.businesses.push(A.id, B.id);
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag, extra = {}) => { const u = await prisma.user.create({ data: { email: `wh-${tag}-${sfx.toLowerCase()}@test.invalid`, passwordHash: hash, firstName: 'WH', lastName: tag, status: 'ACTIVE', ...extra } }); created.users.push(u.id); return u; };
  const admin = await mkUser('admin', { isPlatformAdmin: true });
  const ownerA = await mkUser('owner-a'), ownerB = await mkUser('owner-b'), viewer = await mkUser('viewer-a'), configurer = await mkUser('config-a');
  await prisma.membership.create({ data: { userId: ownerA.id, tenantId: tenant.id, customerId: A.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: ownerB.id, tenantId: tenant.id, customerId: B.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: viewer.id, tenantId: tenant.id, customerId: A.id, roleId: roleUser.id, capabilities: ['computers:view', 'backups:view'] } });
  await prisma.membership.create({ data: { userId: configurer.id, tenantId: tenant.id, customerId: A.id, roleId: roleUser.id, capabilities: ['computers:view', 'backups:view', 'monitoring:configure'] } });
  const mk = (biz, name) => prisma.endpoint.create({ data: { tenantId: tenant.id, customerId: biz.id, name: `${name}-${sfx}`, hostname: `${name.toLowerCase()}-${sfx.toLowerCase()}.example.test`, platform: 'Windows', status: 'ACTIVE', isOnline: true, isManaged: true, lastSeenAt: new Date(), accessMode: 'COMPANY_WIDE' } });
  const fs1 = await mk(A, 'FS1'), sql1 = await mk(A, 'SQL1'), nas1 = await mk(A, 'NAS1'), birch1 = await mk(B, 'BIRCH1');

  api = startApi();
  await waitUp();
  const S = { admin: await login(admin.email), ownerA: await login(ownerA.email), ownerB: await login(ownerB.email), viewer: await login(viewer.email), configurer: await login(configurer.email) };

  section('Settings → Backups: Platform Admin; the push address, headers, limits and the four states');
  let r = await req('GET', `/backups/connections?businessId=${A.id}`, { s: S.ownerA });
  check(r.status === 403, 'a Business Owner cannot open Settings → Backups (connections are a Platform Admin\'s, as in 0.81)', msg(r));
  r = await req('GET', `/backups/connections?businessId=${A.id}`, { s: S.admin });
  const setup = r.data?.setup;
  check(r.status === 200 && setup?.url === `${PUBLIC}/api/v1/backups/push` && setup.dryRunUrl === `${PUBLIC}/api/v1/backups/push?dryRun=1` && setup.https === true && setup.warning === null && setup.contractVersion === 1,
    'the push address is built from the public address (https, no warning), with the dry-run address and contract version 1', JSON.stringify(setup));
  check(setup?.headers?.map((h) => h.name).join(',') === 'Authorization,Content-Type' && setup.limits.bytes === 1048576 && setup.limits.assets === 500 && setup.limits.perMinute === 30,
    'headers and limits: Authorization + Content-Type, 1 MB, 500 assets, 30 a minute', JSON.stringify(setup?.limits));
  const caps = Object.fromEntries((r.data?.capabilities ?? []).map((c) => [c.key, c.state]));
  check(caps['st0r.push'] === 'requires_setup' && caps['st0r.dryrun'] === 'requires_setup' && caps.comet === 'planned' && caps['drill.start'] === 'planned' && caps.failover === 'unsupported' && caps.alerts === 'requires_setup'
    && Object.values(caps).every((s) => ['available', 'requires_setup', 'unsupported', 'planned'].includes(s)),
    'before anything: push requires setup, Comet and drills planned, failover unsupported — four states only', JSON.stringify(caps));

  section('Create: fresh authentication on ask, a token shown once');
  r = await req('POST', '/backups/connections', { s: S.admin, body: { businessId: A.id, kind: 'st0r' } });
  check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED' && r.body.action === 'backup.connection', 'creating asks for fresh authentication (backup.connection)', msg(r));
  const adminUp = await stepUp(S.admin);
  r = await req('POST', '/backups/connections', { s: adminUp, body: { businessId: A.id, kind: 'comet' } });
  check(r.status === 400 && code(r) === 'BACKUP_PROVIDER_NOT_AVAILABLE', 'Comet is still refused (planned)', msg(r));
  r = await req('POST', '/backups/connections', { s: adminUp, body: { businessId: A.id, kind: 'st0r' } });
  let tok = r.data?.pushToken;
  const connA = r.data?.connection?.id;
  check(r.status === 201 && /^rbk_bkc[0-9a-f]{24}_[0-9a-f]{64}$/.test(tok ?? '') && r.data.shownOnce === true, 'St0r for Acme: the token, shown once', msg(r));
  r = await req('POST', '/backups/connections', { s: adminUp, body: { businessId: B.id, kind: 'st0r' } });
  const tokB = r.data?.pushToken;
  check(r.status === 201 && !!tokB, 'St0r for Birch', msg(r));
  r = await req('GET', `/backups/connections?businessId=${A.id}`, { s: adminUp });
  check(r.status === 200 && !r.text.includes(tok.split('_').pop()) && !/pushTokenHash|credentialEnc/.test(r.text) && r.data.connections[0].pushTokenLast4 === tok.slice(-4),
    'the list never carries the token or its hash, only the last four', msg(r));
  check(Object.fromEntries(r.data.capabilities.map((c) => [c.key, c.state]))['st0r.dryrun'] === 'available', 'with a connection, the dry run is available');

  section('The dry run: same auth, same schema, writes nothing but an audit row');
  const goodFeed = {
    v: 1,
    assets: [
      { externalId: 'fs1-c', name: 'FS1 C: volume', type: 'server', computer: { rem0teId: fs1.id }, jobs: [job('fs1-j1', 2)], recoveryPoints: [{ externalId: 'fs1-p1', pointAt: ago(2), location: 'offsite', jobExternalId: 'fs1-j1' }],
        drills: [{ externalId: 'fs1-d1', recoveryPointExternalId: 'fs1-p1', target: 'isolated_vm', scope: 'full_image', result: 'passed', simulated: true, validation: 'boot', startedAt: ago(1.5), finishedAt: ago(1), elapsedSeconds: 600 }] },
      { externalId: 'sql1-db', name: 'SQL1 Finance DB', type: 'database', computer: { hostname: `SQL1-${sfx}.example.test` }, jobs: [job('sql1-j1', 1)], recoveryPoints: [],
        drills: [{ externalId: 'sql1-d1', recoveryPointExternalId: 'p-nowhere', target: 'sandbox', scope: 'application', result: 'failed', simulated: false, validation: 'service_running', startedAt: ago(0.5), finishedAt: ago(0.4), failureCode: 'SERVICE_DID_NOT_START' }] },
      { externalId: 'nas-share', name: 'NAS share (old name)', type: 'files', computer: { hostname: 'nas-old-name.example.test' }, jobs: [job('nas-j1', 3)] },
      { externalId: 'stray', name: 'Stray volume', type: 'files', computer: { rem0teId: birch1.id }, jobs: [job('stray-j1', 2)] },
    ],
  };
  r = await req('POST', '/backups/push?dryRun=1', { body: goodFeed });
  check(r.status === 401 && code(r) === 'BACKUP_PUSH_UNAUTHORIZED', 'a dry run without a token: the same 401', msg(r));
  r = await req('POST', '/backups/push?dryRun=1', { body: goodFeed, auth: `Bearer ${tok.slice(0, -1)}${tok.endsWith('0') ? '1' : '0'}` });
  check(r.status === 401 && code(r) === 'BACKUP_PUSH_UNAUTHORIZED', 'a dry run with a wrong secret: the same 401', msg(r));
  r = await req('POST', '/backups/push?dryRun=maybe', { body: goodFeed, auth: `Bearer ${tok}` });
  check(r.status === 400, 'dryRun is 1 or 0, nothing else', msg(r));
  r = await req('POST', '/backups/push?dryRun=1', { body: goodFeed, auth: `Bearer ${tok}` });
  const links = Object.fromEntries((r.data?.assets ?? []).map((x) => [x.externalId, x.link]));
  check(r.status === 200 && r.data.dryRun === true && r.data.valid === true && r.data.contractVersion === 1 && r.data.wouldWrite?.assets === 4 && r.data.wouldWrite.jobs === 4 && r.data.wouldWrite.drills === 2,
    'a valid feed: 200, valid, what it would write', msg(r));
  check(links['fs1-c'] === 'rem0te_id' && links['sql1-db'] === 'hostname' && links['nas-share'] === 'none' && links.stray === 'none' && !r.text.includes(fs1.id) && !r.text.includes(sql1.id),
    'it says how each asset would link (by id, by hostname, not at all) and never which computer', JSON.stringify(links));
  const warn = (r.data?.warnings ?? []).join(' | ');
  check(/sql1-d1: recovery point p-nowhere is neither in this feed nor stored/.test(warn) && /fs1-d1: simulated/.test(warn) && /nas-share: names a computer/.test(warn) && /stray: names a computer/.test(warn),
    'warnings: a drill of an unknown point, a simulated drill, an asset naming no computer of this business', warn);
  check((await prisma.backupProtectedAsset.count({ where: { connectionId: connA } })) === 0, 'the dry run wrote no asset');
  let connRow = await prisma.backupConnection.findUnique({ where: { id: connA } });
  check(connRow.lastSyncAt === null && connRow.lastResult === null && connRow.lastError === null, 'nor the connection\'s last report or result');
  const badFeed = { v: 1, assets: [{ ...goodFeed.assets[0], drills: [{ ...goodFeed.assets[0].drills[0], recoveryPointExternalId: undefined }] }] };
  r = await req('POST', '/backups/push?dryRun=1', { body: badFeed, auth: `Bearer ${tok}` });
  check(r.status === 200 && r.data.valid === false && r.data.issues.some((i) => i.path === 'assets.0.drills.0.recoveryPointExternalId') && r.data.wouldWrite === null,
    'a drill that names no recovery point: valid false, with the issue\'s path', msg(r));
  connRow = await prisma.backupConnection.findUnique({ where: { id: connA } });
  check(connRow.lastResult === null && connRow.lastError === null, 'an invalid dry run does not mark the connection either');
  const dry = await prisma.activityLog.findMany({ where: { action: 'BACKUP_PUSH_DRY_RUN', resourceId: connA }, orderBy: { createdAt: 'asc' } });
  check(dry.length === 2 && dry[0].metadata.valid === true && dry[0].metadata.wouldWrite?.assets === 4 && dry[1].metadata.valid === false && dry[1].metadata.issues >= 1 && dry.every((d) => d.customerId === A.id)
    && !JSON.stringify(dry.map((d) => d.metadata)).includes('fs1-c'), 'one audit row per dry run: counts only, never the feed', JSON.stringify(dry.map((d) => d.metadata)));
  r = await req('GET', `/backups/connections?businessId=${A.id}`, { s: S.admin });
  check(r.data?.connections?.[0]?.lastDryRun?.valid === false && r.data.connections[0].lastDryRun.issues >= 1, 'Settings → Backups shows the last dry run', JSON.stringify(r.data?.connections?.[0]?.lastDryRun));

  section('The push, and re-sending in any order');
  r = await req('POST', '/backups/push', { body: badFeed, auth: `Bearer ${tok}` });
  check(r.status === 400 && code(r) === 'BAD_FEED' && /recoveryPointExternalId/.test(r.body.message), 'the same feed for real: 400 BAD_FEED, naming the field', msg(r));
  connRow = await prisma.backupConnection.findUnique({ where: { id: connA } });
  check(connRow.lastResult === 'BAD_FEED' && /recoveryPointExternalId/.test(connRow.lastError ?? '') && !!connRow.lastErrorAt, 'a refused push keeps its reason on the connection', JSON.stringify([connRow.lastResult, connRow.lastError]));
  r = await req('POST', '/backups/push', { body: goodFeed, auth: `Bearer ${tok}` });
  check(r.status === 200 && r.data.assets === 4 && r.data.kept === 0 && r.data.contractVersion === 1, 'the valid feed is accepted', msg(r));
  const assetsA = await prisma.backupProtectedAsset.findMany({ where: { connectionId: connA } });
  const byExt = Object.fromEntries(assetsA.map((x) => [x.externalId, x]));
  check(byExt['fs1-c'].endpointId === fs1.id && byExt['sql1-db'].endpointId === sql1.id && byExt['nas-share'].endpointId === null && byExt.stray.endpointId === null && assetsA.every((x) => x.linkSource === 'auto'),
    'linked as the dry run said');
  r = await req('POST', '/backups/push', { body: goodFeed, auth: `Bearer ${tok}` });
  const jobs1 = await prisma.backupJob.count({ where: { customerId: A.id } });
  check(r.status === 200 && jobs1 === 4 && (await prisma.backupProtectedAsset.count({ where: { connectionId: connA } })) === 4 && (await prisma.restoreDrill.count({ where: { customerId: A.id } })) === 2,
    'the identical push again: no new row (same ids, same rows)', `jobs=${jobs1}`);
  // An older report retried late: the job back to running, integrity back to not_checked, the drill back to running.
  const late = { v: 1, assets: [{ externalId: 'sql1-db', name: 'SQL1 Finance DB', type: 'database', computer: { hostname: `SQL1-${sfx}.example.test` },
    jobs: [{ externalId: 'sql1-j1', startedAt: ago(1.5), completion: 'running' }],
    drills: [{ externalId: 'sql1-d1', recoveryPointExternalId: 'p-nowhere', target: 'sandbox', scope: 'application', result: 'running', simulated: false, validation: 'none', startedAt: ago(0.5) }] }] };
  r = await req('POST', '/backups/push', { body: late, auth: `Bearer ${tok}` });
  const sj = await prisma.backupJob.findFirst({ where: { assetId: byExt['sql1-db'].id, externalId: 'sql1-j1' } });
  const sd = await prisma.restoreDrill.findFirst({ where: { assetId: byExt['sql1-db'].id, externalId: 'sql1-d1' } });
  check(r.status === 200 && r.data.kept === 2 && sj.completion === 'succeeded' && !!sj.finishedAt && sj.integrity === 'passed' && sd.result === 'failed' && sd.failureCode === 'SERVICE_DID_NOT_START',
    'a late, older report: the job stays succeeded with its integrity, the drill stays failed (kept: 2)', msg(r) + JSON.stringify([sj.completion, sj.integrity, sd.result]));
  r = await req('POST', '/backups/push', { body: { v: 1, assets: [{ ...goodFeed.assets[1], jobs: [job('sql1-j1', 1, { completion: 'failed', errorCode: 'CORRECTED' })] }] }, auth: `Bearer ${tok}` });
  check(r.status === 200 && (await prisma.backupJob.findFirst({ where: { id: sj.id } })).completion === 'failed', 'a finished job may still be corrected to another finished completion', msg(r));

  section('Rotate: fresh authentication, the old token stops at once');
  r = await req('POST', `/backups/connections/${connA}/rotate`, { s: S.ownerA });
  check(r.status === 403, 'a Business Owner cannot rotate', msg(r));
  r = await req('POST', `/backups/connections/${connA}/rotate`, { s: S.admin });
  check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED' && r.body.action === 'backup.connection', 'rotating asks for fresh authentication (backup.connection)', msg(r));
  r = await req('POST', `/backups/connections/${connA}/rotate`, { s: adminUp });
  const tok2 = r.data?.pushToken;
  check(r.status === 200 && /^rbk_/.test(tok2 ?? '') && tok2 !== tok && tok2.startsWith(`rbk_${connA}_`) && r.data.shownOnce === true && !!r.data.connection.tokenRotatedAt && r.data.connection.pushTokenLast4 === tok2.slice(-4),
    'a new token for the same connection, shown once', msg(r));
  r = await req('POST', '/backups/push', { body: goodFeed, auth: `Bearer ${tok}` });
  check(r.status === 401 && code(r) === 'BACKUP_PUSH_UNAUTHORIZED', 'the old token is refused at once (no overlap)', msg(r));
  r = await req('POST', '/backups/push?dryRun=1', { body: goodFeed, auth: `Bearer ${tok}` });
  check(r.status === 401, 'its dry run too', msg(r));
  r = await req('POST', '/backups/push', { body: goodFeed, auth: `Bearer ${tok2}` });
  check(r.status === 200, 'the new token pushes', msg(r));
  const rot = await prisma.activityLog.findFirst({ where: { action: 'BACKUP_CONNECTION_ROTATED', resourceId: connA } });
  check(rot?.metadata?.beforeLast4 === tok.slice(-4) && rot.metadata.afterLast4 === tok2.slice(-4) && rot.metadata.overlap === 'none' && rot.customerId === A.id, 'rotation is audited: last four before and after, no overlap', JSON.stringify(rot?.metadata));
  const oldTok = tok; tok = tok2;

  section('Link to computer: scoped, audited, and it outlives reports');
  const nas = byExt['nas-share'];
  const fsA = byExt['fs1-c'];
  r = await req('PUT', `/backups/assets/${fsA.id}/link`, { s: S.viewer, body: { link: 'manual', endpointId: fs1.id } });
  check(r.status === 403 && code(r) === 'NOT_ALLOWED', 'backups:view alone cannot link (needs monitoring:configure for the business)', msg(r));
  r = await req('PUT', `/backups/assets/${nas.id}/link`, { s: S.configurer, body: { link: 'manual', endpointId: nas1.id } });
  check(r.status === 404, 'a Business User never sees an unlinked asset (0.81\'s read rule), so cannot link one either', msg(r));
  r = await req('PUT', `/backups/assets/${fsA.id}/link`, { s: S.configurer, body: { link: 'manual', endpointId: fs1.id } });
  check(r.status === 200 && r.data.linkSource === 'manual', 'monitoring:configure for Acme pins a linked asset to its computer by hand', msg(r));
  r = await req('PUT', `/backups/assets/${fsA.id}/link`, { s: S.configurer, body: { link: 'auto' } });
  check(r.status === 200, '…and hands it back to the reports', msg(r));
  await req('POST', '/backups/push', { body: goodFeed, auth: `Bearer ${tok}` });
  r = await req('PUT', `/backups/assets/${nas.id}/link`, { s: S.ownerB, body: { link: 'manual', endpointId: birch1.id } });
  check(r.status === 404 || r.status === 403, 'Birch\'s owner cannot touch an Acme asset', msg(r));
  r = await req('PUT', `/backups/assets/${nas.id}/link`, { s: S.ownerA, body: { link: 'manual', endpointId: birch1.id } });
  check(r.status === 404 && code(r) === 'COMPUTER_NOT_FOUND', 'an Acme asset cannot be linked to a Birch computer', msg(r));
  r = await req('PUT', `/backups/assets/${nas.id}/link`, { s: S.ownerA, body: { link: 'manual', endpointId: nas1.id, businessId: B.id } });
  check(r.status === 400, 'the body is strict (no business field)', msg(r));
  r = await req('PUT', `/backups/assets/${nas.id}/link`, { s: S.ownerA, body: { link: 'manual', endpointId: nas1.id } });
  check(r.status === 200 && r.data.linkSource === 'manual' && r.data.endpointId === nas1.id, 'Acme\'s owner links the unlinked NAS share to NAS1', msg(r));
  let nasRow = await prisma.backupProtectedAsset.findUnique({ where: { id: nas.id } });
  check(nasRow.endpointId === nas1.id && nasRow.linkSource === 'manual' && nasRow.linkedById === ownerA.id && !!nasRow.linkedAt, 'stored with who and when');
  const la = await prisma.activityLog.findFirst({ where: { action: 'BACKUP_ASSET_LINKED', resourceId: nas.id }, orderBy: { createdAt: 'desc' } });
  check(la?.metadata?.before?.source === 'auto' && la.metadata.before.endpointId === null && la.metadata.after?.source === 'manual' && la.metadata.after.endpointId === nas1.id && la.customerId === A.id && la.actorId === ownerA.id,
    'audited with before and after', JSON.stringify(la?.metadata));
  r = await req('POST', '/backups/push', { body: goodFeed, auth: `Bearer ${tok}` });
  nasRow = await prisma.backupProtectedAsset.findUnique({ where: { id: nas.id } });
  check(r.status === 200 && nasRow.endpointId === nas1.id && nasRow.linkSource === 'manual', 'the next report (still naming the old hostname) keeps the person\'s link', JSON.stringify([nasRow.endpointId, nasRow.linkSource]));
  r = await req('POST', '/backups/push?dryRun=1', { body: goodFeed, auth: `Bearer ${tok}` });
  check(r.data?.assets?.find((x) => x.externalId === 'nas-share')?.link === 'manual', 'the dry run says it is linked by a person');
  r = await req('PUT', `/backups/assets/${byExt['sql1-db'].id}/link`, { s: S.ownerA, body: { link: 'none' } });
  check(r.status === 200, 'Acme\'s owner says the SQL asset is no computer', msg(r));
  await req('POST', '/backups/push', { body: goodFeed, auth: `Bearer ${tok}` });
  let sqlRow = await prisma.backupProtectedAsset.findUnique({ where: { id: byExt['sql1-db'].id } });
  check(sqlRow.endpointId === null && sqlRow.linkSource === 'none', 'a report whose hostname matches leaves it unlinked');
  r = await req('PUT', `/backups/assets/${byExt['sql1-db'].id}/link`, { s: S.ownerA, body: { link: 'auto' } });
  sqlRow = await prisma.backupProtectedAsset.findUnique({ where: { id: byExt['sql1-db'].id } });
  check(r.status === 200 && sqlRow.linkSource === 'auto' && sqlRow.linkedById === null && sqlRow.endpointId === null, 'back to automatic: unlinked until the next report', msg(r));
  await req('POST', '/backups/push', { body: goodFeed, auth: `Bearer ${tok}` });
  sqlRow = await prisma.backupProtectedAsset.findUnique({ where: { id: byExt['sql1-db'].id } });
  check(sqlRow.endpointId === sql1.id, 'the next report links it by hostname again');
  r = await req('GET', '/backups', { s: S.ownerA });
  const nasView = r.data?.assets?.find((x) => x.id === nas.id);
  check(r.status === 200 && nasView?.computer?.id === nas1.id && nasView.linkSource === 'manual', 'the Backups page shows the link and that a person made it', JSON.stringify(nasView && { c: nasView.computer, s: nasView.linkSource }));
  // A computer that moves business takes its manual links with it back to automatic (0099 trigger).
  await prisma.endpoint.update({ where: { id: nas1.id }, data: { customerId: B.id } });
  nasRow = await prisma.backupProtectedAsset.findUnique({ where: { id: nas.id } });
  check(nasRow.endpointId === null && nasRow.linkSource === 'auto' && nasRow.linkedById === null, 'a computer moved to another business unlinks the asset and drops the person\'s choice');
  await prisma.endpoint.update({ where: { id: nas1.id }, data: { customerId: A.id } });

  section('Another business, revoke');
  r = await req('POST', '/backups/push', { body: goodFeed, auth: `Bearer ${tokB}` });
  check(r.status === 200 && (await prisma.backupProtectedAsset.count({ where: { customerId: B.id, endpointId: { not: null } } })) === 1
    && (await prisma.backupProtectedAsset.findFirst({ where: { customerId: B.id, externalId: 'stray' } }))?.endpointId === birch1.id
    && (await prisma.backupProtectedAsset.findFirst({ where: { customerId: B.id, externalId: 'fs1-c' } }))?.endpointId === null,
    'Birch\'s token links only Birch\'s computer, never Acme\'s', msg(r));
  r = await req('POST', `/backups/connections/${connA}/revoke`, { s: S.admin });
  check(r.status === 200, 'revoking never asks', msg(r));
  r = await req('POST', '/backups/push?dryRun=1', { body: goodFeed, auth: `Bearer ${tok}` });
  check(r.status === 401, 'a revoked token: the dry run is refused', msg(r));
  r = await req('POST', `/backups/connections/${connA}/rotate`, { s: adminUp });
  check(r.status === 404, 'a revoked connection cannot be rotated', msg(r));

  section('The documented limits');
  const big = JSON.stringify({ v: 1, assets: [], pad: 'x'.repeat(1024 * 1024 + 10) });
  r = await req('POST', '/backups/push', { raw: big, auth: `Bearer ${tokB}` });
  check(r.status === 413 && code(r) === 'PAYLOAD_TOO_LARGE', 'a body over 1 MB: 413 PAYLOAD_TOO_LARGE (was a 500)', msg(r));
  r = await req('POST', '/backups/push', { raw: '{"v":1,"assets":[', auth: `Bearer ${tokB}` });
  check(r.status === 400 && code(r) === 'BAD_REQUEST', 'a body that is not JSON: 400 (was a 500)', msg(r));
  const fixed = ip();
  let limited = null;
  for (let i = 0; i < 34 && !limited; i++) {
    const x = await req('POST', '/backups/push?dryRun=1', { body: { v: 1, assets: [] }, auth: `Bearer ${tokB}`, from: fixed });
    if (x.status === 429) limited = x;
  }
  check(!!limited && limited.status === 429 && code(limited) === 'TOO_MANY_REQUESTS' && limited.headers.get('retry-after-main') === '60', 'past 30 a minute from one address: 429 TOO_MANY_REQUESTS with Retry-After-main', limited ? msg(limited) : 'never limited');
  console.log(`      (429 body: ${limited ? JSON.stringify(limited.body).slice(0, 200) : '-'}; retry headers: ${limited ? [...limited.headers].filter(([k]) => /retry/i.test(k)).map(([k, v]) => `${k}=${v}`).join(' ') : '-'})`);

  section('Nothing secret was kept or printed');
  const rows = await prisma.activityLog.findMany({ where: { customerId: { in: created.businesses }, action: { in: ['BACKUP_CONNECTION_CREATED', 'BACKUP_CONNECTION_ROTATED', 'BACKUP_CONNECTION_REVOKED', 'BACKUP_PUSH_DRY_RUN', 'BACKUP_ASSET_LINKED'] } } });
  const blob = JSON.stringify(rows.map((x) => x.metadata));
  const secrets = [oldTok, tok, tokB].map((t) => t.split('_').pop());
  check(rows.length >= 8 && !secrets.some((k) => blob.includes(k)), `no token in ${rows.length} audit rows`);
  check(!secrets.some((k) => api.log.includes(k)), 'no token in the API\'s output');
}

async function cleanup() {
  await stopApi();
  try {
    const ids = created.businesses;
    const eps = (await prisma.endpoint.findMany({ where: { customerId: { in: ids } }, select: { id: true } })).map((e) => e.id);
    await prisma.backupJob.updateMany({ where: { customerId: { in: ids } }, data: { restoreTest: 'not_tested', restoreDrillId: null } }).catch(() => undefined);
    await prisma.backupProtectedAsset.deleteMany({ where: { customerId: { in: ids } } }).catch((e) => console.error('assets:', e.message.slice(0, 200)));
    await prisma.backupConnection.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.endpoint.deleteMany({ where: { id: { in: eps } } });
    await prisma.membership.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.customer.deleteMany({ where: { id: { in: ids } } }).catch((e) => console.error('businesses:', e.message.slice(0, 200)));
    await prisma.activityLog.updateMany({ where: { actorId: { in: created.users } }, data: { actorId: null } }).catch(() => undefined);
    if (created.users.length) await prisma.user.deleteMany({ where: { id: { in: created.users } } }).catch((e) => console.error('users:', e.message.slice(0, 200)));
  } catch (e) { console.error('cleanup:', e.message); }
  await prisma.$disconnect();
}

all().catch((e) => { fail++; failures.push(`crashed: ${e.stack ?? e}`); console.error(e); })
  .finally(async () => {
    const logs = api?.log ?? '';
    await cleanup();
    console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
    if (failures.length) { for (const f of failures) console.log(`  - ${f}`); console.log(`\n── API output (last 4000 characters)\n${logs.slice(-4000)}`); process.exit(1); }
    process.exit(0);
  });
