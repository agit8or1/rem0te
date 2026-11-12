#!/usr/bin/env node
/**
 * End-to-end proof of automatic snapshots (0.35): the server asks a
 * checking-in computer for its process list, service list and network
 * adapters on its own, on the heartbeat that finds them stale.
 *
 *   - only stale keys are asked for, at the configured intervals; a key
 *     whose tab is open (its snapshot was read in the last 90 s) is asked for
 *     on the shorter watched interval; a failed automatic attempt is not
 *     retried for an hour;
 *   - the result is stored and shown exactly like a manual run's (sanitised,
 *     capped, `latest` on the snapshot), marked `automatic`, with
 *     `automatic.nextAt`; older automatic runs are pruned, people's are not;
 *   - silent, unsupported, too-old and unknown-agent computers are never
 *     asked, and the snapshot says why (`automatic.reason`);
 *   - nothing automatic is audited run by run; the schedule change is, and
 *     needs a Platform Admin (an owner gets 403 and writes nothing);
 *   - Refresh still works and is still audited; a Refresh while an automatic
 *     run is open returns that run;
 *   - business A/B isolation: B's device is never handed A's runs, cannot
 *     post into them, and B's owner cannot read A's snapshot or mark it
 *     watched;
 *   - SNAPSHOT_SWEEP=off: nothing is asked for (a second API), and
 *     SNAPSHOT_MAX_PER_MINUTE paces scheduled runs but not watched ones (a
 *     third API);
 *   - the database refuses an automatic run of a non-snapshot key, a second
 *     open automatic run of a key, and an out-of-range interval.
 *
 *   cd apps/api && npx nest build
 *   DATABASE_URL=postgresql://…/<name containing scratch or test> node scripts/e2e-auto-snapshots.mjs
 *
 * Self-starting: its APIs run from dist/ on AUTOSNAP_API_PORT (3571) and the
 * two ports after it. INTEGRATION, not Windows: heartbeats and results are
 * posted the way heartbeat.ps1 posts them. Nothing here ran on Windows.
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
const BASE_PORT = Number(process.env.AUTOSNAP_API_PORT ?? 3571);
for (const p of [BASE_PORT, BASE_PORT + 1, BASE_PORT + 2]) if ([3000, 3001, 4000, 4001, 443].includes(p)) { console.error(`Refusing port ${p}`); process.exit(2); }
let API = `http://127.0.0.1:${BASE_PORT}/api/v1`;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'autosnap-e2e-password-123';
const KEYS = ['process_list', 'service_list', 'network_adapters'];
const MIN = 60_000, H = 60 * MIN;

let pass = 0, fail = 0;
const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;
const sha = (b) => createHash('sha256').update(b).digest('hex');

const baseEnv = {
  ...process.env, NODE_ENV: 'test', DATABASE_URL: DB,
  JWT_SECRET: randomBytes(32).toString('hex'), LAUNCHER_TOKEN_SECRET: randomBytes(32).toString('hex'),
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? randomBytes(32).toString('hex'), TRUSTED_PROXIES: 'loopback', HBBS_PRESENCE_HOST: '127.0.0.2',
  VERSION_FILE: path.resolve(here, '..', '..', '..', 'version.json'), MONITOR_SWEEP: 'off', AUDIT_SEALER: 'off', CLIENT_UPDATE_SWEEP: 'off',
  // run-e2e.sh exports SNAPSHOT_SWEEP=off for every other suite; this one turns it on for its own API.
  SNAPSHOT_SWEEP: 'on', SNAPSHOT_MAX_PER_MINUTE: '10000',
};
let api;
async function startApi(port, extra = {}) {
  API = `http://127.0.0.1:${port}/api/v1`;
  api = spawn(process.execPath, [path.join(dist, 'main.js')], { env: { ...baseEnv, PORT: String(port), ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  api.log = ''; api.stdout.on('data', (d) => { api.log += d; }); api.stderr.on('data', (d) => { api.log += d; });
  for (let i = 0; i < 120; i++) { try { const r = await fetch(`${API}/health`); if (r.status < 500) return; } catch { /* not yet */ } await sleep(300); }
  throw new Error(`api did not come up:\n${api.log.slice(-3000)}`);
}
async function stopApi() { if (!api || api.exitCode !== null) return; await new Promise((r) => { api.once('exit', r); api.kill('SIGTERM'); }); }

// Paced under the 20 req/s burst throttler.
const pace = () => new Promise((res) => setTimeout(res, 60));
async function req(method, p, { s, body } = {}) {
  await pace();
  const h = { 'content-type': 'application/json', 'x-forwarded-for': s?.ip ?? ip() };
  if (s) h.cookie = s.cookie;
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
const heartbeat = (ep) => req('POST', '/enrollment/heartbeat', { body: { rustdeskId: ep.rid, agentSecret: ep.secret, hostname: ep.hostname, platform: ep.platform, ...(ep.agentVersion ? { agentVersion: ep.agentVersion } : {}) } });
const post = (ep, body) => req('POST', '/enrollment/diagnostic-result', { body: { rustdeskId: ep.rid, agentSecret: ep.secret, ...body } });
const RESULTS = {
  process_list: { processCount: 2, userNamesRead: true, processes: [{ name: 'explorer', pid: 4100, cpuSeconds: 12.5, workingSetBytes: 9e7, user: 'CORP\\alice', startedAt: '2026-11-12T08:00:00Z', commandLine: 'explorer.exe /secret' }, { name: 'svchost', pid: 900, cpuSeconds: 3, workingSetBytes: 2e7, user: 'NT AUTHORITY\\SYSTEM', startedAt: '2026-11-12T07:59:00Z' }] },
  service_list: { serviceCount: 1, services: [{ name: 'Spooler', displayName: 'Print Spooler', state: 'Running', startMode: 'Automatic', account: 'LocalSystem', pathName: 'C:\\Windows\\spoolsv.exe' }] },
  network_adapters: { adapters: [{ name: 'Intel Ethernet', connectionId: 'Ethernet', status: 'Connected', up: true, mac: '00-11-22-aa-bb-cc', ipv4: ['10.0.0.5'], gateway: ['10.0.0.1'], dnsServers: ['10.0.0.1'] }] },
};
/** Answer every run handed out, as the agent would. Returns the keys answered. */
async function collect(ep, handed, { fail: failKeys = [] } = {}) {
  for (const d of handed) {
    await post(ep, { runId: d.id, key: d.key, state: 'running' });
    if (failKeys.includes(d.key)) await post(ep, { runId: d.id, key: d.key, state: 'failed', error: 'WMI repository is broken' });
    else await post(ep, { runId: d.id, key: d.key, state: 'completed', result: RESULTS[d.key] });
  }
  return handed.map((d) => d.key).sort().join(',');
}
const handed = (r) => (r.data?.diagnostics ?? []);
const keysOf = (r) => handed(r).map((d) => d.key).sort().join(',');
const autoRuns = (ep, extra = {}) => prisma.diagnosticRun.findMany({ where: { endpointId: ep.id, requestedById: null, ...extra }, orderBy: { requestedAt: 'asc' } });
/** Move a computer's runs of `key` back in time, as if they were taken `ms` ago. */
async function age(ep, key, ms) {
  const at = new Date(Date.now() - ms);
  await prisma.diagnosticRun.updateMany({ where: { endpointId: ep.id, key }, data: { requestedAt: at, deliveredAt: at, startedAt: at, completedAt: at } });
}
async function ageAll(ep, ms) { for (const k of KEYS) await age(ep, k, ms); }

const created = { businesses: [], users: [] };
let settingsBefore = null;

async function all() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });
  settingsBefore = await prisma.platformSettings.findUnique({ where: { id: 'singleton' } });

  section('Fixtures (synthetic): Acme — current, too-old, unknown-agent, Linux and silent computers; Birch — one current computer; a Platform Admin and two owners');
  const acme = await prisma.customer.create({ data: { tenantId: tenant.id, name: `ASNAP Acme ${sfx}` } });
  const birch = await prisma.customer.create({ data: { tenantId: tenant.id, name: `ASNAP Birch ${sfx}` } });
  created.businesses.push(acme.id, birch.id);
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag, extra = {}) => { const u = await prisma.user.create({ data: { email: `asnap-${tag}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'ASNAP', lastName: tag, status: 'ACTIVE', ...extra } }); created.users.push(u.id); return u; };
  const admin = await mkUser('admin', { isPlatformAdmin: true }), owen = await mkUser('owen-owner-acme'), bea = await mkUser('bea-owner-birch');
  await prisma.membership.create({ data: { userId: owen.id, tenantId: tenant.id, customerId: acme.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: bea.id, tenantId: tenant.id, customerId: birch.id, roleId: roleOwner.id } });
  const mkEp = async (biz, hostname, { platform = 'Windows', agentVersion = '0.35.0', lastSeenAgo = MIN } = {}) => {
    const e = await prisma.endpoint.create({ data: { tenantId: tenant.id, customerId: biz.id, name: hostname, hostname, platform, status: 'ACTIVE', isOnline: true, isManaged: true, accessMode: 'COMPANY_WIDE', lastSeenAt: new Date(Date.now() - lastSeenAgo), agentVersion, deviceClass: 'WORKSTATION' } });
    const rid = String(100000000 + ((Math.random() * 899999999) | 0));
    const secret = randomBytes(24).toString('hex');
    await prisma.rustdeskNode.create({ data: { tenantId: tenant.id, endpointId: e.id, rustdeskId: rid, agentSecretHash: sha(secret) } });
    return { id: e.id, rid, secret, hostname, platform, agentVersion };
  };
  const a1 = await mkEp(acme, 'FRONTDESK');
  const aOld = await mkEp(acme, 'OLD-AGENT', { agentVersion: '0.32.0' });
  const aUnknown = await mkEp(acme, 'NO-VERSION', { agentVersion: null });
  const aLin = await mkEp(acme, 'web01', { platform: 'Linux' });
  // isOnline (through RustDesk, 0.34) but its agent last checked in two hours ago.
  const aSilent = await mkEp(acme, 'SILENT', { lastSeenAgo: 2 * H });
  const b1 = await mkEp(birch, 'FRONTDESK');

  await startApi(BASE_PORT);
  const S = { admin: await login(admin.email), owen: await login(owen.email), bea: await login(bea.email) };
  const snap = (s, ep, key) => req('GET', `/endpoints/${ep.id}/diagnostics/snapshots/${key}`, { s });
  const audits = async (actions) => prisma.activityLog.findMany({ where: { action: { in: actions }, resourceId: { in: [a1.id, aOld.id, aUnknown.id, aLin.id, aSilent.id, b1.id] } } });

  section('The schedule: Platform Admin only, validated, audited');
  let r = await req('GET', '/admin/snapshot-schedule', { s: S.admin });
  check(r.status === 200 && r.data.enabled === true && KEYS.every((k) => r.data.minutes[k] === 360) && r.data.watchMinutes === 5 && r.data.processEnabled === true, 'defaults: on, every 6 h per key, 5 min while watched, this process scheduling', msg(r));
  r = await req('GET', '/admin/snapshot-schedule', { s: S.owen });
  check(r.status === 403, 'a Business Owner cannot read it (403)', msg(r));
  const auditBefore = await prisma.activityLog.count({ where: { action: 'SNAPSHOT_SCHEDULE_CHANGED' } });
  r = await req('PUT', '/admin/snapshot-schedule', { s: S.owen, body: { enabled: false } });
  check(r.status === 403, 'or change it (403)', msg(r));
  r = await req('PUT', '/admin/snapshot-schedule', { s: S.admin, body: { minutes: { process_list: 5 } } });
  check(r.status === 400 && code(r) === 'INVALID_SNAPSHOT_SCHEDULE', 'an interval under an hour is refused (400)', msg(r));
  r = await req('PUT', '/admin/snapshot-schedule', { s: S.admin, body: { minutes: { recent_system_errors: 60 } } });
  check(r.status === 400, 'a non-snapshot key is refused', msg(r));
  r = await req('PUT', '/admin/snapshot-schedule', { s: S.admin, body: { enabled: true, everySeconds: 1 } });
  check(r.status === 400, 'an unknown field is refused', msg(r));
  check((await prisma.activityLog.count({ where: { action: 'SNAPSHOT_SCHEDULE_CHANGED' } })) === auditBefore, 'none of the refusals was audited as a change');

  section('First check-in: every stale key is asked for, with no requester and no audit entry');
  r = await heartbeat(a1);
  check(r.status === 201 || r.status === 200, 'a1 heartbeats', msg(r));
  check(keysOf(r) === 'network_adapters,process_list,service_list' && handed(r).every((d) => Object.keys(d).sort().join() === 'id,key'), 'a1 is handed the three snapshot keys, as id and key only', JSON.stringify(handed(r)));
  let runs = await autoRuns(a1);
  check(runs.length === 3 && runs.every((x) => x.requestedById === null && x.status === 'DELIVERED' && x.customerId === acme.id), 'three automatic runs: no requester, delivered, in Acme', JSON.stringify(runs.map((x) => [x.key, x.status, x.requestedById])));
  check((await collect(a1, handed(r))) === 'network_adapters,process_list,service_list', 'the agent collects and posts all three');
  runs = await autoRuns(a1);
  check(runs.every((x) => x.status === 'COMPLETED' && x.resultBytes > 0), 'each is stored COMPLETED with its size', JSON.stringify(runs.map((x) => [x.key, x.status])));
  check(!JSON.stringify(runs.map((x) => x.result)).includes('/secret') && !JSON.stringify(runs.map((x) => x.result)).includes('spoolsv'), 'sanitised exactly as a manual run: command lines and binary paths dropped');
  check((await audits(['ENDPOINT_DIAGNOSTIC_REQUESTED', 'ENDPOINT_DIAGNOSTIC_COMPLETED'])).length === 0, 'nothing automatic was audited (no requested, no completed entries)');

  r = await snap(S.owen, a1, 'service_list');
  check(r.status === 200 && r.data.latest?.automatic === true && r.data.latest.requestedBy.id === null && !!r.data.takenAt && r.data.pending === null, 'the Services tab shows it as the latest snapshot, marked automatic', msg(r));
  check(r.data.latest?.result?.services?.[0]?.name === 'Spooler', 'with the stored result, as for a manual run');
  // The read just made this tab "watched": the next one is due on the 5-minute watched interval.
  const nextAt = Date.parse(r.data.automatic?.nextAt ?? '');
  check(r.data.automatic?.state === 'on' && r.data.automatic.basis === 'watch' && r.data.automatic.intervalMinutes === 5 && nextAt > Date.now() + 4 * MIN && nextAt < Date.now() + 6 * MIN, 'automatic: on, every 5 minutes while the tab is open, next ≈ 5 minutes from now', JSON.stringify(r.data.automatic));
  check(r.data.agentSilent === false && r.data.agentVersion === '0.35.0', 'agent checking in, version reported');

  section('Intervals: fresh keys are not asked for again; only the stale one is');
  r = await heartbeat(a1);
  check(handed(r).length === 0, 'an immediate second check-in is handed nothing (all fresh)', JSON.stringify(handed(r)));
  // network_adapters has not been read (not watched): 5 h old is inside its 6 h interval.
  // process_list has not been read either: 7 h old is past it. service_list was read: 6 min old is past its watched 5.
  await age(a1, 'network_adapters', 5 * H); await age(a1, 'process_list', 7 * H); await age(a1, 'service_list', 6 * MIN);
  r = await heartbeat(a1);
  check(keysOf(r) === 'process_list,service_list', 'handed exactly the stale keys: processes (7 h, schedule) and services (6 min, tab open) — not network (5 h)', keysOf(r));
  await collect(a1, handed(r));
  for (const k of KEYS) {
    const n = (await autoRuns(a1, { key: k })).length;
    check(n === 1, `${k}: one automatic run kept — the superseded one was pruned`, `${n} rows`);
  }

  section('Refresh still works, is audited, and shares an open automatic run');
  r = await req('POST', `/endpoints/${a1.id}/diagnostics/runs`, { s: S.owen, body: { key: 'network_adapters' } });
  const manualId = r.data?.run?.id;
  check(r.status === 201 && r.data.run.automatic === false && r.data.run.requestedBy.id === owen.id, 'a Refresh is a manual run, by the owner', msg(r));
  r = await heartbeat(a1);
  check(keysOf(r) === 'network_adapters' && handed(r)[0].id === manualId, 'the next check-in hands the Refresh, and no automatic run of the same key beside it', JSON.stringify(handed(r)));
  await collect(a1, handed(r));
  r = await snap(S.owen, a1, 'network_adapters');
  check(r.data?.latest?.id === manualId && r.data.latest.automatic === false && r.data.latest.requestedBy.name, 'the tab shows it, asked for by the owner', msg(r));
  const reqAudits = (await audits(['ENDPOINT_DIAGNOSTIC_REQUESTED'])).filter((a) => a.metadata?.runId === manualId);
  check(reqAudits.length === 1 && reqAudits[0].actorId === owen.id, 'the Refresh is audited once, with who asked');
  await age(a1, 'process_list', 7 * H);
  r = await heartbeat(a1);
  const openAuto = handed(r).find((d) => d.key === 'process_list');
  check(!!openAuto, 'process_list is due again and handed out automatically', keysOf(r));
  r = await req('POST', `/endpoints/${a1.id}/diagnostics/runs`, { s: S.owen, body: { key: 'process_list' } });
  check(r.data?.deduplicated === true && r.data.run.id === openAuto?.id && r.data.run.automatic === true, 'a Refresh while that run is open returns it (deduplicated) — the computer collects once', msg(r));
  await collect(a1, [openAuto]);

  section('A failed automatic attempt waits an hour, not a heartbeat');
  await age(a1, 'process_list', 7 * H);
  r = await heartbeat(a1);
  check(keysOf(r) === 'process_list', 'process_list is asked for', keysOf(r));
  await collect(a1, handed(r), { fail: ['process_list'] });
  r = await heartbeat(a1);
  check(handed(r).length === 0, 'the next check-in does not ask again straight after the failure');
  r = await snap(S.owen, a1, 'process_list');
  check(r.data?.lastFailure?.automatic === true && /WMI/.test(r.data.lastFailure.error ?? '') && r.data.latest?.status === 'COMPLETED', 'the tab shows the failure, and keeps the last good snapshot', msg(r));
  check((await audits(['ENDPOINT_DIAGNOSTIC_COMPLETED'])).filter((a) => a.metadata?.key === 'process_list').length === 0, 'the automatic failure is not audited either');
  // Not watched any more for this check: forget the read by waiting is too slow; age the failure past both the hour and the watched interval.
  const failed = (await autoRuns(a1, { key: 'process_list', status: 'FAILED' }))[0];
  await prisma.diagnosticRun.update({ where: { id: failed.id }, data: { requestedAt: new Date(Date.now() - 61 * MIN), completedAt: new Date(Date.now() - 61 * MIN) } });
  r = await heartbeat(a1);
  check(keysOf(r) === 'process_list', 'an hour later it is asked for again', keysOf(r));
  await collect(a1, handed(r));
  check((await autoRuns(a1, { key: 'process_list' })).length === 1, 'and the failure is pruned once a newer automatic run exists');

  section('An automatic run that expires is closed without an audit entry');
  await age(a1, 'service_list', 7 * H);
  r = await heartbeat(a1);
  const stuck = handed(r).find((d) => d.key === 'service_list');
  check(!!stuck, 'service_list handed out');
  await prisma.diagnosticRun.update({ where: { id: stuck.id }, data: { deliveredAt: new Date(Date.now() - 11 * MIN) } });
  r = await snap(S.owen, a1, 'service_list');
  check(r.data?.lastFailure?.status === 'EXPIRED' && r.data.lastFailure.automatic === true, 'expired (delivered, never started), shown on the tab', msg(r));
  check((await audits(['ENDPOINT_DIAGNOSTIC_COMPLETED'])).filter((a) => a.metadata?.runId === stuck.id).length === 0, 'and not audited');

  section('Computers that cannot be asked are not, and the tab says why');
  const none = async (ep, label, reason) => {
    r = await heartbeat(ep);
    check(handed(r).length === 0 && (await autoRuns(ep)).length === 0, `${label}: its check-in is handed nothing and no automatic run exists`, JSON.stringify(handed(r)));
    r = await snap(S.owen, ep, 'service_list');
    check(r.status === 200 && r.data.automatic?.state === 'blocked' && r.data.automatic.reason === reason && r.data.latest === null, `${label}: the tab says ${reason}, and shows no snapshot`, msg(r));
  };
  await none(aOld, 'agent 0.32.0', 'agent_too_old');
  await none(aUnknown, 'no agent version', 'agent_unknown');
  await none(aLin, 'Linux', 'unsupported_platform');
  check((await autoRuns(aSilent)).length === 0, 'silent (no check-in for 2 h, online through RustDesk): nothing staged for it — it is only ever asked on its own check-in');
  r = await snap(S.owen, aSilent, 'process_list');
  check(r.data?.automatic?.state === 'blocked' && r.data.automatic.reason === 'agent_silent' && r.data.agentSilent === true && r.data.isOnline === true && r.data.latest === null, 'and its tab says agent_silent (isOnline true, agent silent), with no snapshot', msg(r));

  section('Business A/B isolation');
  r = await heartbeat(b1);
  check(keysOf(r) === 'network_adapters,process_list,service_list', 'Birch\'s computer is asked for its own three', keysOf(r));
  const bHanded = handed(r);
  const bRuns = await autoRuns(b1);
  check(bRuns.length === 3 && bRuns.every((x) => x.customerId === birch.id && x.endpointId === b1.id), 'its runs belong to Birch');
  const aOpenIds = (await prisma.diagnosticRun.findMany({ where: { endpointId: a1.id }, select: { id: true } })).map((x) => x.id);
  check(!bHanded.some((d) => aOpenIds.includes(d.id)), 'none of Acme\'s runs are handed to Birch\'s computer');
  r = await post(b1, { runId: aOpenIds[0], key: 'process_list', state: 'completed', result: RESULTS.process_list });
  check(r.data?.accepted === false && r.data.reason === 'unknown_run', 'Birch\'s device cannot post into an Acme run', msg(r));
  await collect(b1, bHanded);
  r = await snap(S.bea, b1, 'process_list');
  check(r.status === 200 && r.data.latest?.automatic === true, 'Birch\'s owner reads Birch\'s automatic snapshot');
  r = await snap(S.bea, a1, 'process_list');
  check(r.status === 404, 'Birch\'s owner cannot read Acme\'s (404, as a missing computer)', msg(r));
  r = await snap(S.owen, b1, 'process_list');
  check(r.status === 404, 'nor Acme\'s owner Birch\'s', msg(r));
  // A refused read must not count as "someone is looking": Acme's owner
  // tries Birch's network tab (never read by anyone), which is 6 minutes old —
  // past the watched interval, well inside the 6 h one.
  r = await snap(S.owen, b1, 'network_adapters');
  check(r.status === 404, 'Acme\'s owner reads Birch\'s network tab: 404');
  await age(b1, 'network_adapters', 6 * MIN);
  r = await heartbeat(b1);
  check(handed(r).length === 0, 'and Birch\'s computer is not asked for it: a refused read does not mark the tab as watched', keysOf(r));

  section('Changing the schedule: audited with before and after, and applied');
  r = await req('PUT', '/admin/snapshot-schedule', { s: S.admin, body: { minutes: { service_list: 0 }, watchMinutes: 0 } });
  check(r.status === 200 && r.data.minutes.service_list === 0 && r.data.watchMinutes === 0, 'services off the schedule, and nothing while watched', msg(r));
  const changed = await prisma.activityLog.findMany({ where: { action: 'SNAPSHOT_SCHEDULE_CHANGED', actorId: admin.id }, orderBy: { createdAt: 'desc' }, take: 1 });
  check(changed.length === 1 && changed[0].metadata?.before?.minutes?.service_list === 360 && changed[0].metadata?.after?.minutes?.service_list === 0 && changed[0].metadata?.after?.watchMinutes === 0, 'audited as SNAPSHOT_SCHEDULE_CHANGED by the admin, before and after', JSON.stringify(changed[0]?.metadata));
  await ageAll(b1, 7 * H);
  r = await heartbeat(b1);
  check(keysOf(r) === 'network_adapters,process_list', 'Birch\'s computer: services no longer asked for; the others still are', keysOf(r));
  await collect(b1, handed(r));
  r = await snap(S.bea, b1, 'service_list');
  check(r.data?.automatic?.state === 'off' && r.data.automatic.reason === 'key_off', 'the Services tab says key_off', JSON.stringify(r.data?.automatic));
  r = await req('PUT', '/admin/snapshot-schedule', { s: S.admin, body: { enabled: false } });
  check(r.status === 200 && r.data.enabled === false, 'automatic snapshots switched off', msg(r));
  await ageAll(b1, 7 * H); await ageAll(a1, 7 * H);
  r = await heartbeat(b1);
  check(handed(r).length === 0, 'switched off: nothing asked of Birch\'s computer');
  r = await heartbeat(a1);
  check(handed(r).length === 0, 'or of Acme\'s');
  r = await snap(S.bea, b1, 'process_list');
  check(r.data?.automatic?.state === 'off' && r.data.automatic.reason === 'disabled', 'the tab says disabled', JSON.stringify(r.data?.automatic));
  r = await req('PUT', '/admin/snapshot-schedule', { s: S.admin, body: { enabled: true, minutes: { process_list: 360, service_list: 360, network_adapters: 360 }, watchMinutes: 5 } });
  check(r.status === 200 && r.data.enabled && r.data.minutes.service_list === 360, 'back to the defaults', msg(r));
  check((await prisma.activityLog.count({ where: { action: 'SNAPSHOT_SCHEDULE_CHANGED', actorId: admin.id } })) === 3, 'three changes, three audit entries');
  check((await audits(['ENDPOINT_DIAGNOSTIC_REQUESTED', 'ENDPOINT_DIAGNOSTIC_COMPLETED'])).filter((a) => a.metadata?.requestedById === null || (a.action === 'ENDPOINT_DIAGNOSTIC_REQUESTED' && !a.actorId)).length === 0, 'across all of it, no audit entry for any automatic run');

  section('The database backstops');
  const bad = async (name, fn) => { try { await fn(); check(false, name, 'was accepted'); } catch (e) { check(/check|constraint|unique|23514|23505/i.test(String(e.message ?? e)), name, String(e.message).slice(0, 200)); } };
  await bad('an automatic run of a non-snapshot key (recent_system_errors) is refused', () => prisma.diagnosticRun.create({ data: { endpointId: a1.id, key: 'recent_system_errors', requestedById: null, expiresAt: new Date(Date.now() + H) } }));
  const open1 = await prisma.diagnosticRun.create({ data: { endpointId: a1.id, key: 'process_list', requestedById: null, expiresAt: new Date(Date.now() + H) } });
  await bad('a second open automatic run of the same key is refused', () => prisma.diagnosticRun.create({ data: { endpointId: a1.id, key: 'process_list', requestedById: null, expiresAt: new Date(Date.now() + H) } }));
  await prisma.diagnosticRun.delete({ where: { id: open1.id } });
  await bad('a watched interval of 1 minute is refused', () => prisma.platformSettings.update({ where: { id: 'singleton' }, data: { snapshotWatchMinutes: 1 } }));
  await bad('an interval of 10 minutes is refused', () => prisma.platformSettings.update({ where: { id: 'singleton' }, data: { snapshotProcessMinutes: 10 } }));

  await stopApi();

  section('SNAPSHOT_SWEEP=off: nothing is asked for; Refresh still works');
  await startApi(BASE_PORT + 1, { SNAPSHOT_SWEEP: 'off' });
  S.owen = await login(owen.email); S.admin = await login(admin.email);
  await ageAll(a1, 7 * H);
  r = await heartbeat(a1);
  check(handed(r).length === 0, 'every key stale, and the check-in is handed nothing', keysOf(r));
  r = await snap(S.owen, a1, 'service_list');
  check(r.data?.automatic?.state === 'off' && r.data.automatic.reason === 'process_off', 'the tab says process_off', JSON.stringify(r.data?.automatic));
  r = await req('GET', '/admin/snapshot-schedule', { s: S.admin });
  check(r.data?.processEnabled === false, 'Settings says this process schedules nothing');
  r = await req('POST', `/endpoints/${a1.id}/diagnostics/runs`, { s: S.owen, body: { key: 'service_list' } });
  check(r.status === 201 && r.data.run.automatic === false, 'Refresh still asks', msg(r));
  r = await heartbeat(a1);
  check(keysOf(r) === 'service_list', 'and the computer is handed it', keysOf(r));
  await collect(a1, handed(r));
  await stopApi();

  section('SNAPSHOT_MAX_PER_MINUTE paces scheduled runs, not watched ones');
  await startApi(BASE_PORT + 2, { SNAPSHOT_MAX_PER_MINUTE: '2' });
  S.owen = await login(owen.email);
  await ageAll(a1, 7 * H); await ageAll(b1, 7 * H);
  r = await heartbeat(a1);
  check(handed(r).length === 2, 'a1 has three stale keys and is handed two (the per-minute budget)', keysOf(r));
  await collect(a1, handed(r));
  r = await heartbeat(b1);
  check(handed(r).length === 0, 'b1 is held back this minute (budget spent); its keys stay due', keysOf(r));
  const stillStale = [];
  for (const k of KEYS) if (!(await autoRuns(a1, { key: k, status: 'COMPLETED', completedAt: { gt: new Date(Date.now() - MIN) } })).length) stillStale.push(k);
  check(stillStale.length === 1, 'one of a1\'s keys is still stale', String(stillStale));
  r = await snap(S.owen, a1, stillStale[0]);
  r = await heartbeat(a1);
  check(keysOf(r) === stillStale[0], 'once someone opens its tab, it is asked for at once (watched runs are not paced)', keysOf(r));
  await collect(a1, handed(r));
}

async function cleanup() {
  await stopApi();
  try {
    const ids = created.businesses;
    const eps = await prisma.endpoint.findMany({ where: { customerId: { in: ids } }, select: { id: true } });
    await prisma.endpointCommand.deleteMany({ where: { endpointId: { in: eps.map((e) => e.id) } } });
    await prisma.diagnosticRun.deleteMany({ where: { endpointId: { in: eps.map((e) => e.id) } } });
    await prisma.rustdeskNode.deleteMany({ where: { endpointId: { in: eps.map((e) => e.id) } } });
    await prisma.endpoint.deleteMany({ where: { id: { in: eps.map((e) => e.id) } } }).catch(() => { /* rows other suites' sweeps hang off */ });
    await prisma.membership.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.customer.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    if (created.users.length) await prisma.user.deleteMany({ where: { id: { in: created.users } } }).catch(() => {});
    // Put the platform schedule back as it was.
    const keep = settingsBefore ?? { snapshotAutoEnabled: true, snapshotProcessMinutes: 360, snapshotServiceMinutes: 360, snapshotNetworkMinutes: 360, snapshotWatchMinutes: 5 };
    await prisma.platformSettings.updateMany({ where: { id: 'singleton' }, data: {
      snapshotAutoEnabled: keep.snapshotAutoEnabled, snapshotProcessMinutes: keep.snapshotProcessMinutes, snapshotServiceMinutes: keep.snapshotServiceMinutes,
      snapshotNetworkMinutes: keep.snapshotNetworkMinutes, snapshotWatchMinutes: keep.snapshotWatchMinutes,
    } });
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
