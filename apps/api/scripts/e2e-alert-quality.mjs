#!/usr/bin/env node
/**
 * End-to-end proof of 0.66's alert classification, against the real built API:
 *
 *   - on start, the stored pre-0.66 disk-errors monitor is corrected (global
 *     and business scope), audited with before and after, and a disk-errors
 *     monitor a person edited is left alone; a second start changes nothing;
 *   - open event alerts raised before 0.66 are reclassified from the evidence
 *     they stored: the DS-HOME1 alert (count 2, one harmless sample) drops
 *     from critical to warning, an alert whose only event was harmless is
 *     closed by the monitor, a real bad-block alert stays critical — each with
 *     an alert history entry and an audit row, none deleted;
 *   - the heartbeat asks the agent for levels 1–3 only;
 *   - the exact DS-HOME1 event, and the same with another shadow-copy number,
 *     raise nothing, and are recorded under one fingerprint; a disk bad block
 *     and a controller error (atapi 11) raise critical alerts, also when sent
 *     together with a harmless event; an informational event raises an info
 *     alert that a later disk error turns critical; a pre-0.66 agent (one
 *     sample, no `samples`) still works;
 *   - the alert detail carries the explanation, the monitor rule and similar
 *     alerts; `?fingerprint=` lists them; another business sees none of it.
 *
 *   cd apps/api && npx nest build
 *   DATABASE_URL=postgresql://…/<scratch or test> node scripts/e2e-alert-quality.mjs
 *
 * Port 3921. The monitoring sweep is off (the suite drives every report
 * itself), and the suite refuses a database that already has global monitors.
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
const PORT = Number(process.env.ALERT_QUALITY_API_PORT ?? 3921);
if (PORT < 3921 || PORT > 3923) { console.error(`Refusing port ${PORT}: this suite uses 3921–3923.`); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
const prisma = new PrismaClient();
await confirmEverythingAsks(prisma);
const sfx = randomBytes(3).toString('hex');
const PW = 'alertq-e2e-password-123';

let pass = 0, fail = 0;
const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const J = (x) => JSON.stringify(x);
// jsonb keeps keys in its own order: compare with keys sorted.
const canon = (x) => JSON.stringify(x, (_, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v));

let api;
function startApi() {
  api = spawn(process.execPath, [path.join(dist, 'main.js')], {
    env: {
      ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATABASE_URL: DB,
      JWT_SECRET: randomBytes(32).toString('hex'), LAUNCHER_TOKEN_SECRET: randomBytes(32).toString('hex'), ENCRYPTION_KEY: randomBytes(32).toString('hex'),
      TRUSTED_PROXIES: 'loopback', HBBS_PRESENCE_HOST: '127.0.0.2', VERSION_FILE: path.resolve(here, '..', '..', '..', 'version.json'), INTEGRATION_PEERS_FILE: '',
      MONITOR_SWEEP: 'off', REPORT_SCHEDULE_SWEEP: 'off', AUDIT_SEALER: 'off', STALE_SWEEP: 'off', SNAPSHOT_SWEEP: 'off', RETENTION_SWEEP: 'off',
      CHAT_RETENTION_SWEEP: 'off', TRAY_SWEEP: 'off', AGENT_AUTO_UPDATE: 'off', AUTO_MIGRATION_SWEEP: 'off', WINGET_INDEX_SWEEP: 'off', PATCH_POLICY_SWEEP: 'off',
      SCRIPT_OUTPUT_SWEEP: 'off', METRIC_SWEEP: 'off', CLIENT_UPDATE_SWEEP: 'off', WARRANTY_SWEEP: 'off', AUTOMATION_SWEEP: 'off', RESTART_WINDOW_SWEEP: 'off', SSO_SESSION_SWEEP: 'off',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  api.log = ''; api.stdout.on('data', (d) => { api.log += d; }); api.stderr.on('data', (d) => { api.log += d; });
}
async function stopApi() { if (!api || api.exitCode !== null) return; await new Promise((r) => { api.once('exit', r); api.kill('SIGTERM'); }); }
async function waitUp() {
  for (let i = 0; i < 120; i++) { try { const r = await fetch(`${API}/health`); if (r.status < 500) return; } catch { /* */ } await sleep(300); }
  throw new Error(`api did not come up:\n${api.log.slice(-3000)}`);
}
async function req(method, p, { s, body, business } = {}) {
  const h = { 'content-type': 'application/json', 'x-forwarded-for': ip() };
  if (s) h.cookie = s.cookie;
  if (business) h['x-rem0te-business'] = business;
  const r = await fetch(`${API}${p}`, { method, headers: h, body: body ? J(body) : undefined });
  const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j, data: j?.data };
}
async function login(email) {
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip() }, body: J({ email, password: PW }) });
  const mm = (r.headers.get('set-cookie') ?? '').match(/access_token=([^;]+)/);
  if (r.status !== 200 || !mm) throw new Error(`login ${email}: ${r.status} ${await r.text()}`);
  return { cookie: `access_token=${mm[1]}` };
}
const msg = (r) => `HTTP ${r.status} ${J(r.body).slice(0, 400)}`;
const heartbeat = (ep) => req('POST', '/enrollment/heartbeat', { body: { rustdeskId: ep.rid, agentSecret: ep.secret, hostname: ep.hostname, platform: 'Windows' } });
const report = (ep, events) => req('POST', '/enrollment/monitor-report', { body: { rustdeskId: ep.rid, agentSecret: ep.secret, services: [], events } });
const openAlert = (endpointId, ruleKey = 'disk-errors') => prisma.monitorAlert.findFirst({ where: { endpointId, ruleKey, state: { not: 'RESOLVED' } } });

// The exact DS-HOME1 sample, and realistic storage events.
const TXR = (n, hive = 'DRIVERS') => `TxR init phase for hive \\??\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy${n}\\Windows\\System32\\config\\${hive} (TM: {00000000-0000-4000-8000-0000000000a5}, RM: {00000000-0000-4000-8000-0000000000a4}) finished with result=0xC00000A2 (Internal code=7).`;
const DS_HOME1 = { eventId: 11, level: 4, provider: 'Microsoft-Windows-Kernel-General', message: TXR(59) };
const DISK7 = { eventId: 7, level: 2, provider: 'disk', message: 'The device, \\Device\\Harddisk0\\DR0, has a bad block.' };
const ATAPI11 = { eventId: 11, level: 2, provider: 'atapi', message: 'The driver detected a controller error on \\Device\\Ide\\IdePort0.' };
const INFO_EV = { eventId: 11, level: 4, provider: 'Microsoft-Windows-Kernel-Boot', message: 'Boot configuration data was read from \\Device\\HarddiskVolume1.' };
const OLD = { log: 'System', ids: [7, 11, 51, 153], levels: [], threshold: 1, clearAfterMinutes: 1440 };

const created = { businesses: [], users: [], rules: [] };

async function all() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  if (await prisma.monitorRule.count({ where: { scopeKey: 'global' } })) throw new Error('This database already has global monitors; use a fresh scratch database.');
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });

  section('Fixtures (synthetic): Acme (A), Birch (B), Cedar (C); a pre-0.66 disk-errors monitor and its alerts');
  const mkBiz = async (n) => { const c = await prisma.customer.create({ data: { tenantId: tenant.id, name: `${n} ${sfx}` } }); created.businesses.push(c.id); return c; };
  const A = await mkBiz('AQ Acme'), B = await mkBiz('AQ Birch'), C = await mkBiz('AQ Cedar');
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag, extra = {}) => { const u = await prisma.user.create({ data: { email: `aq-${tag}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'AQ', lastName: tag, status: 'ACTIVE', ...extra } }); created.users.push(u.id); return u; };
  const admin = await mkUser('admin', { isPlatformAdmin: true });
  const ownerA = await mkUser('owner-a'), ownerB = await mkUser('owner-b');
  await prisma.membership.create({ data: { userId: ownerA.id, tenantId: tenant.id, customerId: A.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: ownerB.id, tenantId: tenant.id, customerId: B.id, roleId: roleOwner.id } });
  const mkEp = async (biz, name) => {
    const e = await prisma.endpoint.create({ data: { tenantId: tenant.id, customerId: biz.id, name, hostname: `${name.toLowerCase()}.example.test`, platform: 'Windows', status: 'ACTIVE', isOnline: true, isManaged: true, lastSeenAt: new Date(), accessMode: 'COMPANY_WIDE' } });
    const rid = String(100000000 + ((Math.random() * 899999999) | 0));
    const secret = randomBytes(24).toString('hex');
    await prisma.rustdeskNode.create({ data: { tenantId: tenant.id, endpointId: e.id, rustdeskId: rid, agentSecretHash: sha(secret) } });
    return { id: e.id, rid, secret, hostname: e.hostname, name };
  };
  const ds = await mkEp(A, `DS-HOME1-${sfx}`.toUpperCase());
  const a2 = await mkEp(A, `AQ-PC2-${sfx}`.toUpperCase());
  const a3 = await mkEp(A, `AQ-PC3-${sfx}`.toUpperCase());
  const a4 = await mkEp(A, `AQ-PC4-${sfx}`.toUpperCase());
  const b1 = await mkEp(B, `AQ-BIRCH1-${sfx}`.toUpperCase());
  const c1 = await mkEp(C, `AQ-CEDAR1-${sfx}`.toUpperCase());

  const g = await prisma.monitorRule.create({ data: { scopeKey: 'global', key: 'disk-errors', kind: 'EVENT_MATCH', name: 'Disk errors in the System log', severity: 'CRITICAL', params: OLD, createdById: admin.id } });
  created.rules.push(g.id);
  const edited = await prisma.monitorRule.create({ data: { scopeKey: `b:${B.id}`, customerId: B.id, key: 'disk-errors', kind: 'EVENT_MATCH', name: 'Disk errors (ours)', severity: 'CRITICAL', params: { ...OLD, threshold: 2 }, createdById: ownerB.id } });
  const cRule = await prisma.monitorRule.create({ data: { scopeKey: `b:${C.id}`, customerId: C.id, key: 'disk-errors', kind: 'EVENT_MATCH', name: 'Disk errors in the System log', severity: 'CRITICAL', params: OLD, createdById: admin.id } });
  const mkOld = (ep, biz, detail) => prisma.monitorAlert.create({ data: {
    tenantId: tenant.id, customerId: biz.id, endpointId: ep.id, ruleId: g.id, ruleKey: 'disk-errors', kind: 'EVENT_MATCH', dedupKey: `disk-errors:${ep.id}`,
    severity: 'CRITICAL', title: `${ep.name}: ${detail.count} matching events in System`, detail, events: { create: { type: 'raised', detail: { rule: 'disk-errors', inheritedFrom: 'global' } } },
  } });
  const T = '2026-11-18T22:27:13.431Z';
  const dsAlert = await mkOld(ds, A, { log: 'System', count: 2, sample: DS_HOME1, newestAt: T, threshold: 1 });
  const benignOnly = await mkOld(a2, A, { log: 'System', count: 1, sample: { ...DS_HOME1, message: TXR(12) }, newestAt: T, threshold: 1 });
  const realOld = await mkOld(a3, A, { log: 'System', count: 1, sample: DISK7, newestAt: T, threshold: 1 });

  startApi();
  await waitUp();
  await sleep(1500);

  section('On start: the pre-0.66 disk-errors monitor is corrected, and only that');
  const gNow = await prisma.monitorRule.findUnique({ where: { id: g.id } });
  check(J(gNow.params.levels) === '[1,2,3]' && gNow.params.ids.includes(52) && gNow.params.ids.includes(55) && gNow.params.ids.includes(11), 'the global monitor now asks for levels 1–3 (and 52, 55)', J(gNow.params));
  const cNow = await prisma.monitorRule.findUnique({ where: { id: cRule.id } });
  check(J(cNow.params.levels) === '[1,2,3]', 'a business monitor with the exact old parameters is corrected too', J(cNow.params));
  const eNow = await prisma.monitorRule.findUnique({ where: { id: edited.id } });
  check(canon(eNow.params) === canon({ ...OLD, threshold: 2 }), 'a disk-errors monitor a person edited is left exactly as it was', J(eNow.params));
  const ruleAudits = await prisma.activityLog.findMany({ where: { action: 'MONITOR_RULE_CHANGED', resourceId: { in: [g.id, cRule.id, edited.id] } } });
  check(ruleAudits.length === 2 && ruleAudits.every((x) => x.metadata?.op === 'corrected' && canon(x.metadata.before) === canon(OLD) && J(x.metadata.after?.levels) === '[1,2,3]' && x.actorId === null), 'each correction is audited, with before and after, by no person', J(ruleAudits.map((x) => x.metadata)));
  check(ruleAudits.some((x) => x.customerId === C.id), 'the business correction is audited in that business');

  section('On start: open alerts raised before 0.66 are reclassified, not hidden');
  const ds2 = await prisma.monitorAlert.findUnique({ where: { id: dsAlert.id } });
  check(ds2.severity === 'WARNING' && ds2.state === 'OPEN' && ds2.classifierVersion === 1, 'DS-HOME1 (count 2, one harmless sample): critical → warning, still open', J({ severity: ds2.severity, state: ds2.state, v: ds2.classifierVersion }));
  check(ds2.classification?.basis === 'partial' && ds2.classification?.matched === 'kernel-general-11-txr-shadow-copy' && ds2.classification?.unseen === 1, 'its classification says the newest event is the known pattern and one was not seen', J(ds2.classification));
  check(/^[0-9a-f]{32}$/.test(ds2.fingerprint ?? ''), 'it carries the event fingerprint');
  const dsEv = await prisma.monitorAlertEvent.findMany({ where: { alertId: dsAlert.id }, orderBy: { createdAt: 'asc' } });
  check(dsEv.some((e) => e.type === 'raised') && dsEv.some((e) => e.type === 'reclassified' && e.detail.from === 'CRITICAL' && e.detail.to === 'WARNING'), 'its history keeps "raised" and adds "reclassified" critical → warning', J(dsEv.map((e) => e.type)));
  const b2 = await prisma.monitorAlert.findUnique({ where: { id: benignOnly.id } });
  check(b2.state === 'RESOLVED' && b2.resolvedById === null && /known harmless pattern/.test(b2.resolveNote ?? ''), 'an alert whose only event was the harmless pattern is closed by the monitor, with a note', J({ state: b2.state, note: b2.resolveNote }));
  check(!!(await prisma.monitorAlert.findUnique({ where: { id: benignOnly.id } })), '…and kept, not deleted');
  const r2 = await prisma.monitorAlert.findUnique({ where: { id: realOld.id } });
  check(r2.severity === 'CRITICAL' && r2.state === 'OPEN' && r2.classifierVersion === 1 && r2.classification?.matched === 'disk-7-bad-block', 'a real bad-block alert stays critical and open (stamped)', J({ s: r2.severity, c: r2.classification?.matched }));
  check(!(await prisma.monitorAlertEvent.findFirst({ where: { alertId: realOld.id, type: 'reclassified' } })), '…with no history entry, since nothing changed');
  const reAudits = await prisma.activityLog.findMany({ where: { action: 'MONITOR_ALERT_RECLASSIFIED', resourceId: { in: [dsAlert.id, benignOnly.id, realOld.id] } } });
  check(reAudits.length === 2 && reAudits.some((x) => x.resourceId === benignOnly.id && x.metadata?.closed === true) && reAudits.every((x) => x.customerId === A.id && !('message' in (x.metadata ?? {}))), 'two reclassifications audited (ids and classes, no event text)', J(reAudits.map((x) => x.metadata)));

  section('A second start changes nothing');
  await stopApi();
  startApi();
  await waitUp();
  await sleep(1500);
  const again = await prisma.activityLog.count({ where: { action: { in: ['MONITOR_RULE_CHANGED', 'MONITOR_ALERT_RECLASSIFIED'] }, resourceId: { in: [g.id, cRule.id, edited.id, dsAlert.id, benignOnly.id, realOld.id] } } });
  check(again === 4, 'no new correction or reclassification', String(again));

  const S = { admin: await login(admin.email), ownerA: await login(ownerA.email), ownerB: await login(ownerB.email) };

  section('The heartbeat asks for levels 1–3 only');
  let r = await heartbeat(ds);
  const q = r.data?.monitor?.events?.find((e) => e.key === 'disk-errors');
  check(r.status === 200 && J(q?.levels) === '[1,2,3]' && q?.provider === null, 'the agent is asked for Critical, Error and Warning events, any provider', msg(r));

  section('The exact DS-HOME1 event raises nothing, and is recorded');
  const now = () => new Date().toISOString();
  r = await report(a4, [{ key: 'disk-errors', checkedAt: now(), count: 1, newestAt: now(), sample: DS_HOME1, samples: [{ ...DS_HOME1, at: now() }] }]);
  check(r.status < 300, 'report accepted', msg(r));
  check(!(await openAlert(a4.id)), 'no alert for the exact DS-HOME1 event');
  let fps = await prisma.monitorEventFingerprint.findMany({ where: { endpointId: a4.id } });
  check(fps.length === 1 && fps[0].class === 'BENIGN' && fps[0].matched === 'kernel-general-11-txr-shadow-copy' && fps[0].statusCode === '0xC00000A2' && fps[0].component === 'volume-shadow-copy' && fps[0].sample?.message === DS_HOME1.message, 'recorded as BENIGN with its structured fields and raw event', J(fps));
  r = await report(a4, [{ key: 'disk-errors', checkedAt: now(), count: 2, newestAt: now(), sample: { ...DS_HOME1, message: TXR(60) }, samples: [{ ...DS_HOME1, message: TXR(60) }, { ...DS_HOME1, message: TXR(60) }] }]);
  check(r.status < 300, 'report accepted', msg(r));
  check(!(await openAlert(a4.id)), 'another shadow-copy number, twice: still no alert');
  fps = await prisma.monitorEventFingerprint.findMany({ where: { endpointId: a4.id } });
  check(fps.length === 1 && fps[0].seen === 2, 'the same fingerprint, counted again', J(fps.map((f) => ({ seen: f.seen, fp: f.fingerprint }))));

  section('Genuine disk and controller errors still alert');
  r = await report(a4, [{ key: 'disk-errors', checkedAt: now(), count: 1, newestAt: now(), sample: DISK7, samples: [DISK7] }]);
  check(r.status < 300, 'report accepted', msg(r));
  let al = await openAlert(a4.id);
  check(al?.severity === 'CRITICAL' && al.classification?.matched === 'disk-7-bad-block' && al.classification?.basis === 'known_event', 'disk 7 (bad block): a critical alert, recognised', J(al));
  const pc2 = await mkEp(A, `AQ-PC5-${sfx}`.toUpperCase());
  r = await report(pc2, [{ key: 'disk-errors', checkedAt: now(), count: 2, newestAt: now(), sample: DS_HOME1, samples: [DS_HOME1, ATAPI11] }]);
  check(r.status < 300, 'report accepted', msg(r));
  al = await openAlert(pc2.id);
  check(al?.severity === 'CRITICAL' && al.classification?.matched === 'controller-11-error' && al.title.includes('1 matching event'), 'atapi 11 sent with a harmless event: critical, and only the real one counted', J({ s: al?.severity, m: al?.classification?.matched, t: al?.title }));
  check(al?.detail?.count === 2 && al?.detail?.counted === 1 && al?.detail?.samples?.length === 2, 'the alert keeps both raw events and the raw count', J(al?.detail));
  const pc6 = await mkEp(A, `AQ-PC6-${sfx}`.toUpperCase());
  r = await report(pc6, [{ key: 'disk-errors', checkedAt: now(), count: 1, newestAt: now(), sample: DISK7 }]);
  check(r.status < 300, 'report accepted', msg(r));
  al = await openAlert(pc6.id);
  check(al?.severity === 'CRITICAL' && al.classification?.seen === 1, 'a pre-0.66 agent (one sample, no samples list) still works', J(al?.classification));

  section('An informational event under a monitor that named no level, then a disk error');
  r = await report(b1, [{ key: 'disk-errors', checkedAt: now(), count: 2, newestAt: now(), sample: INFO_EV, samples: [INFO_EV, { ...INFO_EV }] }]);
  check(r.status < 300, 'report accepted', msg(r));
  al = await openAlert(b1.id);
  check(al?.severity === 'INFO' && al.classification?.class === 'INFORMATIONAL', 'Birch (edited monitor, no levels): an info alert, not critical', J({ s: al?.severity, c: al?.classification?.class }));
  r = await report(b1, [{ key: 'disk-errors', checkedAt: now(), count: 2, newestAt: now(), sample: DISK7, samples: [DISK7, DISK7] }]);
  check(r.status < 300, 'report accepted', msg(r));
  al = await openAlert(b1.id);
  check(al?.severity === 'CRITICAL' && al.classification?.matched === 'disk-7-bad-block' && al.occurrences === 2, 'a disk error on the same alert makes it critical (one alert, two occurrences)', J({ s: al?.severity, o: al?.occurrences }));
  r = await report(b1, [{ key: 'disk-errors', checkedAt: now(), count: 2, newestAt: now(), sample: INFO_EV, samples: [INFO_EV, INFO_EV] }]);
  check(r.status < 300, 'report accepted', msg(r));
  al = await openAlert(b1.id);
  check(al?.severity === 'CRITICAL' && al.classification?.matched === 'disk-7-bad-block', 'a later informational event does not lower it', J(al?.severity));

  section('The alert explains itself: explanation, monitor rule, similar alerts');
  const a4Alert = await openAlert(a4.id);
  r = await req('GET', `/monitoring/alerts/${a4Alert.id}`, { s: S.ownerA, business: A.id });
  const d = r.data;
  check(r.status === 200 && ['whatHappened', 'whyGenerated', 'howSerious', 'recommendedAction', 'certainty'].every((k) => typeof d?.explanation?.[k] === 'string' && d.explanation[k].length > 10), 'the explanation has every section', msg(r));
  check(/does not prove/.test(d?.explanation?.howSerious ?? '') && d?.explanation?.classification?.class === 'CRITICAL', 'it does not claim the disk is failing from one event', d?.explanation?.howSerious);
  check(d?.rule?.key === 'disk-errors' && J(d.rule.params.levels) === '[1,2,3]', 'it names the monitor rule that matched, with its parameters', J(d?.rule));
  check(d?.similar?.total === 2 && [pc6.id, a3.id].every((id) => d.similar.recent.some((x) => x.computer?.id === id)), 'similar alerts: the other two bad blocks on Acme (same fingerprint), the reclassified one included', J(d?.similar));
  check(d?.similar?.onThisComputer?.seen >= 1, 'and how often this computer reported the event', J(d?.similar?.onThisComputer));
  check(d?.classification?.matched === 'disk-7-bad-block' && d?.fingerprint === a4Alert.fingerprint, 'the list view carries the class and fingerprint', J(d?.classification));
  r = await req('GET', `/monitoring/alerts?state=all&fingerprint=${a4Alert.fingerprint}`, { s: S.ownerA, business: A.id });
  check(r.status === 200 && r.data.alerts.length === 3 && r.data.alerts.every((x) => x.fingerprint === a4Alert.fingerprint), '?fingerprint= lists the alerts with that fingerprint', msg(r));
  r = await req('GET', '/monitoring/alerts?fingerprint=not-a-fingerprint', { s: S.ownerA, business: A.id });
  check(r.status === 400, 'a malformed fingerprint is refused', msg(r));
  r = await req('GET', `/monitoring/alerts/${dsAlert.id}`, { s: S.ownerA, business: A.id });
  check(/cannot be ruled out/.test(r.data?.explanation?.howSerious ?? '') && /shadow copy/i.test(r.data?.explanation?.whatHappened ?? ''), 'DS-HOME1\'s explanation: the harmless pattern, and honest about the unseen event', J(r.data?.explanation));

  section('Another business sees none of it');
  r = await req('GET', `/monitoring/alerts/${a4Alert.id}`, { s: S.ownerB, business: B.id });
  check(r.status === 404, 'Birch\'s owner cannot open an Acme alert', msg(r));
  r = await req('GET', `/monitoring/alerts?state=all&fingerprint=${a4Alert.fingerprint}`, { s: S.ownerB, business: B.id });
  check(r.status === 200 && r.data.alerts.every((x) => x.business?.id === B.id), 'the fingerprint filter lists only Birch\'s own', msg(r));
  const bAlert = await openAlert(b1.id);
  r = await req('GET', `/monitoring/alerts/${bAlert.id}`, { s: S.ownerB, business: B.id });
  check(r.status === 200 && (r.data.similar.recent ?? []).every((x) => x.business?.id === B.id), 'Birch\'s similar alerts are Birch\'s only (Acme has the same bad block)', J(r.data?.similar));
  void c1;
}

async function cleanup() {
  await stopApi();
  try {
    const ids = created.businesses;
    const eps = (await prisma.endpoint.findMany({ where: { customerId: { in: ids } }, select: { id: true } })).map((e) => e.id);
    await prisma.monitorAlert.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.monitorEventFingerprint.deleteMany({ where: { endpointId: { in: eps } } });
    await prisma.monitorRule.deleteMany({ where: { OR: [{ customerId: { in: ids } }, { id: { in: created.rules } }] } });
    await prisma.endpointMonitorState.deleteMany({ where: { endpointId: { in: eps } } });
    await prisma.endpointInventory.deleteMany({ where: { endpointId: { in: eps } } });
    await prisma.rustdeskNode.deleteMany({ where: { endpointId: { in: eps } } });
    await prisma.endpoint.deleteMany({ where: { id: { in: eps } } });
    await prisma.membership.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.customer.deleteMany({ where: { id: { in: ids } } });
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
