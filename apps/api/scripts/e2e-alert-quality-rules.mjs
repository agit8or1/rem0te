#!/usr/bin/env node
/**
 * End-to-end proof of 0.67's false-positive reports and alert quality rules,
 * against the real built API, its own monitoring sweep, a loopback webhook
 * (the PSA) and a loopback SMTP sink:
 *
 *   - reporting a false positive: who may, "other" needs a comment, once per
 *     person, audited without the comment, in the alert's history; it may
 *     resolve that alert; it never creates a rule or changes a monitor, however
 *     many people report it; it may count towards a recommendation;
 *   - recommendations: per business, a preview simulation, a draft to start
 *     from; another business sees none;
 *   - rules: who may propose (scope, platform rules Platform Admin only,
 *     allowBroad), too broad refused, a pending rule counted in the shadow
 *     and never applied, simulation required, fresh authentication to
 *     approve (`monitoring.qualityrule`), the open alerts it covers closed
 *     and audited, suppression at ingest with the event still recorded, an
 *     unrelated event still alerting, another business untouched;
 *   - conflicts: the same scope and conditions twice is 409 RULE_CONFLICT;
 *     precedence: a computer's rule beats the business's;
 *   - edits: only pending, with the revision read; a stale one is 409;
 *   - high risk: dangerous matches need acceptance, and a second, different
 *     approver; rollback needs no step-up and brings the alert back;
 *   - revisions: approving supersedes; rolling back restores the previous;
 *   - expiry at evaluation time, and the sweep marks it expired, audited,
 *     with mail to the business's confirmed owner; a review date passing
 *     mails once;
 *   - PSA tickets: a suppressed event opens no ticket; one event signature on
 *     one computer gets one ticket a day (a second alert is linked);
 *   - AI not configured: Ask AI on an alert is refused cleanly, reporting
 *     still works;
 *   - the dashboard: totals, reports, quality checks — each per business.
 *
 *   cd apps/api && npx nest build
 *   DATABASE_URL=postgresql://…/<scratch or test> node scripts/e2e-alert-quality-rules.mjs
 *
 * Ports 3931 (API), 3932 (webhook stub), 3933 (SMTP sink). The monitoring
 * sweep runs (every 2 s): the suite refuses a database that already has global
 * monitors, a platform ticket rule, a platform PSA connector or SMTP settings.
 */
import { PrismaClient } from '@prisma/client';
import { confirmEverythingAsks } from './lib/confirm-asks.mjs';
import { createSmtpSink } from './lib/smtp-sink.mjs';
import argon2 from 'argon2';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const DB = process.env.DATABASE_URL ?? '';
const dbName = DB.split('/').pop()?.split('?')[0] ?? '';
if (!/scratch|test/.test(dbName)) { console.error(`Refusing to run against database "${dbName}": name must contain "scratch" or "test".`); process.exit(2); }
const PORT = Number(process.env.ALERT_RULES_API_PORT ?? 3931);
const HOOK_PORT = PORT + 1, SMTP_PORT = PORT + 2;
for (const p of [PORT, HOOK_PORT, SMTP_PORT]) if (p < 3931 || p > 3933) { console.error(`Refusing port ${p}: this suite uses 3931–3933.`); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
const prisma = new PrismaClient();
await confirmEverythingAsks(prisma);
const sfx = randomBytes(3).toString('hex');
const PW = 'aqrules-e2e-password-123';
const DAY = 86_400_000;

let pass = 0, fail = 0;
const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const J = (x) => JSON.stringify(x);
async function until(fn, ms = 30_000, step = 500) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return v; await sleep(step); }
}

// ── Webhook stub (the PSA) and SMTP sink ────────────────────────────────────
const hookHits = [];
let ticketNo = 0;
const hookServer = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; });
  req.on('end', () => {
    let j = null; try { j = JSON.parse(b); } catch { /* */ }
    hookHits.push({ path: req.url, json: j });
    ticketNo++;
    res.setHeader('content-type', 'application/json');
    res.end(J({ ticket_id: `T-${sfx}-${ticketNo}`, url: `https://psa.example.com/tickets/${ticketNo}` }));
  });
});
const hitsFor = (alertId) => hookHits.filter((h) => h.json?.ticket?.alert?.id === alertId);
const { server: smtp, mailTo } = createSmtpSink();

// ── API ─────────────────────────────────────────────────────────────────────
let api;
function startApi() {
  const p = spawn(process.execPath, [path.join(dist, 'main.js')], {
    env: {
      ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATABASE_URL: DB,
      JWT_SECRET: randomBytes(32).toString('hex'), LAUNCHER_TOKEN_SECRET: randomBytes(32).toString('hex'), ENCRYPTION_KEY: randomBytes(32).toString('hex'),
      TRUSTED_PROXIES: 'loopback', HBBS_PRESENCE_HOST: '127.0.0.2', VERSION_FILE: path.resolve(here, '..', '..', '..', 'version.json'), INTEGRATION_PEERS_FILE: '',
      FRONTEND_URL: 'https://rmm.example.test', SMTP_ALLOW_LOCAL_RELAY: 'loopback',
      // The monitoring sweep runs: rule expiry, review reminders and tickets live in it.
      MONITOR_SWEEP: 'on', MONITOR_SWEEP_SECONDS: '2', MONITOR_INVENTORY_SECONDS: '1',
      REPORT_SCHEDULE_SWEEP: 'off', AUDIT_SEALER: 'off', STALE_SWEEP: 'off', SNAPSHOT_SWEEP: 'off', RETENTION_SWEEP: 'off',
      CHAT_RETENTION_SWEEP: 'off', TRAY_SWEEP: 'off', AGENT_AUTO_UPDATE: 'off', AUTO_MIGRATION_SWEEP: 'off', WINGET_INDEX_SWEEP: 'off', PATCH_POLICY_SWEEP: 'off',
      SCRIPT_OUTPUT_SWEEP: 'off', METRIC_SWEEP: 'off', CLIENT_UPDATE_SWEEP: 'off', WARRANTY_SWEEP: 'off', AUTOMATION_SWEEP: 'off', RESTART_WINDOW_SWEEP: 'off', SSO_SESSION_SWEEP: 'off',
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
async function req(method, p, { s, body, business } = {}) {
  await sleep(30);
  const h = { 'content-type': 'application/json', 'x-forwarded-for': ip() };
  if (s) h.cookie = s.cookie + (s.stepUp ? `; step_up=${s.stepUp}` : '');
  if (business) h['x-rem0te-business'] = business;
  const r = await fetch(`${API}${p}`, { method, headers: h, body: body ? J(body) : undefined });
  const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j, data: j?.data, setCookie: r.headers.get('set-cookie') ?? '' };
}
async function login(email) {
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip() }, body: J({ email, password: PW }) });
  const mm = (r.headers.get('set-cookie') ?? '').match(/access_token=([^;]+)/);
  if (r.status !== 200 || !mm) throw new Error(`login ${email}: ${r.status} ${await r.text()}`);
  return { cookie: `access_token=${mm[1]}` };
}
async function stepUp(s) {
  const r = await req('POST', '/auth/step-up', { s, body: { password: PW } });
  const mm = r.setCookie.match(/step_up=([^;]+)/);
  if (r.status !== 200 || !mm) throw new Error(`step-up: ${r.status} ${J(r.body)}`);
  return { ...s, stepUp: mm[1] };
}
const code = (r) => r.body?.code ?? r.body?.message?.code ?? r.body?.error?.code;
const msg = (r) => `HTTP ${r.status} ${typeof r.body === 'string' ? r.body.slice(0, 300) : J(r.body).slice(0, 500)}`;
const now = () => new Date().toISOString();
const report = (ep, key, samples, count = samples.length) => req('POST', '/enrollment/monitor-report', { body: { rustdeskId: ep.rid, agentSecret: ep.secret, services: [], events: [{ key, checkedAt: now(), count, newestAt: now(), sample: samples[0], samples }] } });
const openAlert = (endpointId, ruleKey = 'app-crash') => prisma.monitorAlert.findFirst({ where: { endpointId, ruleKey, state: { not: 'RESOLVED' } }, orderBy: { firstSeenAt: 'desc' } });

const CRASH = { eventId: 1000, level: 2, provider: 'Application Error', message: 'Faulting application name: vendortool.exe, version: 1.2.3.4, faulting module name: vendor.dll' };
const HANG = { eventId: 1002, level: 2, provider: 'Application Hang', message: 'The program othertool.exe version 2.0 stopped interacting with Windows.' };
const DISK7 = { eventId: 7, level: 2, provider: 'disk', message: 'The device, \\Device\\Harddisk0\\DR0, has a bad block.' };
const APP_PARAMS = { log: 'Application', ids: [1000, 1002], levels: [1, 2], threshold: 1, clearAfterMinutes: 1440 };

const created = { businesses: [], users: [] };

async function all() {
  await new Promise((r, j) => { hookServer.once('error', j); hookServer.listen(HOOK_PORT, '127.0.0.1', r); });
  await new Promise((r, j) => { smtp.once('error', j); smtp.listen(SMTP_PORT, '127.0.0.1', r); });
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  if (await prisma.monitorRule.count({ where: { scopeKey: 'global' } })) throw new Error('This database already has global monitors, which the sweep would act on; use a fresh scratch database.');
  if (await prisma.monitorTicketPolicy.findUnique({ where: { scopeKey: 'global' } })) throw new Error('This database already has a platform ticket rule; use a fresh scratch database.');
  if (await prisma.psaConnector.findUnique({ where: { scopeKey: 'global' } })) throw new Error('This database already has a platform PSA connector; use a fresh scratch database.');
  if (await prisma.smtpSettings.findUnique({ where: { id: 'singleton' } })) throw new Error('This database already has SMTP settings; use a fresh scratch database.');
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });
  const roleUser = await prisma.role.findFirst({ where: { type: 'BUSINESS_USER' } });

  section('Fixtures (synthetic): Acme (A) and Birch (B)');
  const mkBiz = async (n) => { const c = await prisma.customer.create({ data: { tenantId: tenant.id, name: `${n} ${sfx}` } }); created.businesses.push(c.id); return c; };
  const A = await mkBiz('AQR Acme'), B = await mkBiz('AQR Birch');
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag, extra = {}) => { const u = await prisma.user.create({ data: { email: `aqr-${tag}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'AQR', lastName: tag, status: 'ACTIVE', ...extra } }); created.users.push(u.id); return u; };
  const admin = await mkUser('admin', { isPlatformAdmin: true }), admin2 = await mkUser('admin2', { isPlatformAdmin: true });
  const ownerA = await mkUser('owner-a'), ownerB = await mkUser('owner-b'), userA = await mkUser('user-a'), viewerA = await mkUser('viewer-a');
  await prisma.membership.create({ data: { userId: ownerA.id, tenantId: tenant.id, customerId: A.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: ownerB.id, tenantId: tenant.id, customerId: B.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: userA.id, tenantId: tenant.id, customerId: A.id, roleId: roleUser.id, capabilities: ['computers:view', 'monitoring:alerts'] } });
  await prisma.membership.create({ data: { userId: viewerA.id, tenantId: tenant.id, customerId: A.id, roleId: roleUser.id, capabilities: ['computers:view'] } });
  const mkEp = async (biz, tag, inv = {}) => {
    const e = await prisma.endpoint.create({ data: { tenantId: tenant.id, customerId: biz.id, name: `${tag}-${sfx}`.toUpperCase(), hostname: `${tag}-${sfx}.example.test`, osVersion: 'Windows 11 Pro', platform: 'Windows', status: 'ACTIVE', isOnline: true, isManaged: true, lastSeenAt: new Date(), accessMode: 'COMPANY_WIDE' } });
    await prisma.endpointInventory.create({ data: { endpointId: e.id, collectedAt: new Date(Date.now() - 3_600_000), lastBootAt: new Date(Date.now() - 2 * DAY), liveSampledAt: new Date(), ...inv } });
    const rid = String(100000000 + ((Math.random() * 899999999) | 0));
    const secret = randomBytes(24).toString('hex');
    await prisma.rustdeskNode.create({ data: { tenantId: tenant.id, endpointId: e.id, rustdeskId: rid, agentSecretHash: sha(secret) } });
    return { id: e.id, rid, secret, name: e.name };
  };
  const a1 = await mkEp(A, 'aqr-a1'), a2 = await mkEp(A, 'aqr-a2'), a3 = await mkEp(A, 'aqr-a3'), a4 = await mkEp(A, 'aqr-a4', { lastBootAt: new Date(Date.now() - 40 * DAY) });
  const b1 = await mkEp(B, 'aqr-b1');
  // Confirmed recipients: the Platform Admin (global) and Birch's owner (Birch's list).
  await prisma.emailRecipient.create({ data: { scopeKey: 'global', address: admin.email, verifiedAt: new Date(), addedById: admin.id } });
  await prisma.emailRecipient.create({ data: { scopeKey: `b:${B.id}`, customerId: B.id, address: ownerB.email, verifiedAt: new Date(), addedById: ownerB.id } });

  api = startApi();
  await waitUp();
  const S = { admin: await login(admin.email), admin2: await login(admin2.email), ownerA: await login(ownerA.email), ownerB: await login(ownerB.email), userA: await login(userA.email), viewerA: await login(viewerA.email) };
  const up = { admin: await stepUp(S.admin), admin2: await stepUp(S.admin2), ownerA: await stepUp(S.ownerA), ownerB: await stepUp(S.ownerB) };

  let r = await req('PUT', '/email/settings', { s: up.admin, body: { enabled: true, host: '127.0.0.1', port: SMTP_PORT, tlsMode: 'none', username: null, fromAddress: `rem0te-${sfx}@example.test`, fromName: 'rem0te' } });
  if (r.status !== 200) throw new Error(`smtp: ${msg(r)}`);
  const mkMon = async (biz, key, kind, severity, params) => {
    const x = await req('POST', '/monitoring/rules', { s: S.admin, body: { scope: 'business', businessId: biz.id, key, kind, name: key, severity, params } });
    if (x.status !== 200 && x.status !== 201) throw new Error(`monitor ${key}: ${msg(x)}`);
    return x.data;
  };
  const appA = await mkMon(A, 'app-crash', 'EVENT_MATCH', 'WARNING', APP_PARAMS);
  await mkMon(B, 'app-crash', 'EVENT_MATCH', 'WARNING', APP_PARAMS);
  await mkMon(A, 'disk-errors', 'EVENT_MATCH', 'CRITICAL', { log: 'System', ids: [7, 11, 51, 52, 55, 153], levels: [1, 2, 3], threshold: 1, clearAfterMinutes: 1440 });
  await mkMon(A, 'uptime', 'UPTIME_LONG', 'WARNING', { days: 30 });
  const monitorBefore = await prisma.monitorRule.findUnique({ where: { id: appA.id } });

  // ── False-positive reports ───────────────────────────────────────────────
  section('Reporting a false positive');
  r = await report(a1, 'app-crash', [CRASH]);
  check(r.status < 300, 'a1 reports a vendor tool crash', msg(r));
  const x1 = await openAlert(a1.id);
  check(x1?.severity === 'WARNING' && /^[0-9a-f]{32}$/.test(x1.fingerprint ?? ''), 'a warning alert with a fingerprint', J(x1));
  const FP = x1.fingerprint;
  await report(b1, 'app-crash', [CRASH]);
  const xb = await openAlert(b1.id);
  check(!!xb && xb.fingerprint === FP, 'Birch has the same event (same fingerprint)');
  r = await req('GET', `/monitoring/alerts/${x1.id}/false-positive`, { s: S.userA, business: A.id });
  check(r.status === 200 && r.data?.rawEvent?.eventId === 1000 && r.data.monitor?.key === 'app-crash' && r.data.reasons?.length === 8 && !!r.data.proposedHandling?.caution && r.data.similar?.count >= 0, 'the dialog\'s context: the raw event, monitor, reasons, proposed handling', msg(r));
  check(!(r.data?.similar?.computers ?? []).some((c) => c.id === b1.id), 'its similar alerts are Acme\'s only');
  r = await req('GET', `/monitoring/alerts/${x1.id}/false-positive`, { s: S.viewerA, business: A.id });
  check(r.status === 403, 'without monitoring:alerts: refused', msg(r));
  r = await req('GET', `/monitoring/alerts/${x1.id}/false-positive`, { s: S.ownerB, business: B.id });
  check(r.status === 404, 'another business: not found', msg(r));
  r = await req('POST', `/monitoring/alerts/${x1.id}/false-positive`, { s: S.userA, business: A.id, body: { reason: 'other' } });
  check(r.status === 400, '"Other" without an explanation is refused', msg(r));
  r = await req('POST', `/monitoring/alerts/${x1.id}/false-positive`, { s: S.userA, business: A.id, body: { reason: 'known_harmless', comment: 'Vendor tool crashes on exit, known issue VT-221', recommendPrevent: true, disableMonitor: true } });
  check(r.status === 400, 'a report cannot ask to disable the monitor (strict input)', msg(r));
  r = await req('POST', `/monitoring/alerts/${x1.id}/false-positive`, { s: S.userA, business: A.id, body: { reason: 'known_harmless', comment: 'Vendor tool crashes on exit, known issue VT-221', recommendPrevent: true } });
  check(r.status === 200 && r.data?.monitorChanged === false && r.data.ruleChanged === false && !!r.data.recommendationId && r.data.resolved === false, 'a technician with alerts reports it, recommending prevention', msg(r));
  const recId = r.data?.recommendationId;
  r = await req('POST', `/monitoring/alerts/${x1.id}/false-positive`, { s: S.userA, business: A.id, body: { reason: 'duplicate' } });
  check(r.status === 409 && code(r) === 'ALREADY_REPORTED', 'once per person per alert', msg(r));
  const fpAudit = await prisma.activityLog.findFirst({ where: { action: 'ALERT_FALSE_POSITIVE_REPORTED', resourceId: x1.id } });
  check(!!fpAudit && fpAudit.metadata?.reason === 'known_harmless' && !J(fpAudit.metadata).includes('VT-221'), 'audited (ALERT_FALSE_POSITIVE_REPORTED) without the comment', J(fpAudit?.metadata));
  check(!!(await prisma.monitorAlertEvent.findFirst({ where: { alertId: x1.id, type: 'false_positive_reported' } })), 'in the alert\'s history');
  r = await req('POST', `/monitoring/alerts/${x1.id}/false-positive`, { s: S.ownerA, business: A.id, body: { reason: 'expected_activity', recommendPrevent: true, resolve: true } });
  check(r.status === 200 && r.data?.resolved === true && r.data.recommendationId === recId, 'the owner reports it too, resolving it; the same recommendation', msg(r));
  const x1r = await prisma.monitorAlert.findUnique({ where: { id: x1.id } });
  check(x1r.state === 'RESOLVED' && x1r.resolvedById === ownerA.id, 'that one alert is resolved, by the owner');
  r = await req('POST', `/monitoring/alerts/${xb.id}/false-positive`, { s: S.ownerB, business: B.id, body: { reason: 'known_harmless', recommendPrevent: true } });
  check(r.status === 200 && r.data.recommendationId !== recId, 'Birch\'s report goes to Birch\'s own recommendation', msg(r));
  const monitorAfter = await prisma.monitorRule.findUnique({ where: { id: appA.id } });
  check(J(monitorAfter.params) === J(monitorBefore.params) && monitorAfter.enabled && monitorAfter.severity === monitorBefore.severity, 'the monitor is unchanged');
  check((await prisma.alertQualityRule.count({ where: { customerId: { in: [A.id, B.id] } } })) === 0, 'and no rule exists: reports never authorise one');
  const rec = await prisma.alertRuleRecommendation.findUnique({ where: { id: recId } });
  check(rec?.reportCount === 2 && rec.status === 'open' && J(rec.reasons) !== '{}', 'the recommendation counts two reports', J(rec));

  section('Recommendations');
  r = await req('GET', '/monitoring/quality/recommendations', { s: S.ownerA, business: A.id });
  const recView = r.data?.recommendations?.find((x) => x.id === recId);
  check(r.status === 200 && r.data.recommendations.length === 1 && recView?.draft?.behaviour?.kind === 'suppress' && recView.draft.match.fingerprint === FP && /Not validated yet/.test(recView.caution), 'Acme sees its recommendation, a narrow draft, not validated', msg(r));
  r = await req('GET', '/monitoring/quality/recommendations', { s: S.ownerB, business: B.id });
  check(r.status === 200 && !r.data.recommendations.some((x) => x.id === recId), 'Birch does not see Acme\'s');
  r = await req('GET', `/monitoring/quality/recommendations/${recId}/preview`, { s: S.ownerA, business: A.id });
  check(r.status === 200 && r.data?.simulation?.matched >= 1 && r.data.simulation.businesses.every((b) => b.id === A.id), 'Preview: a simulation of the draft, in Acme only', msg(r));
  r = await req('GET', `/monitoring/quality/recommendations/${recId}/preview`, { s: S.ownerB, business: B.id });
  check(r.status === 404, 'Birch cannot preview Acme\'s', msg(r));

  // ── Rules: who may propose ───────────────────────────────────────────────
  section('Proposing a rule: who may, and what is too broad');
  const review = new Date(Date.now() + 180 * DAY).toISOString();
  const draft = (o = {}) => ({ name: 'Vendor tool crash on exit', description: 'Application Error 1000 from vendortool.exe when it exits', justification: 'Known vendor issue VT-221; harmless, reported by two technicians', scope: { kind: 'business', businessId: A.id }, match: { ruleKey: 'app-crash', fingerprint: FP }, behaviour: { kind: 'suppress' }, temporary: false, reviewAt: review, ...o });
  r = await req('POST', '/monitoring/quality/rules', { s: S.userA, business: A.id, body: draft() });
  check(r.status === 403, 'a technician without monitoring:configure cannot propose', msg(r));
  r = await req('POST', '/monitoring/quality/rules', { s: S.ownerA, business: A.id, body: draft({ scope: { kind: 'platform' } }) });
  check(r.status === 403 && code(r) === 'PLATFORM_ADMIN_ONLY', 'a Business Owner cannot propose a platform rule', msg(r));
  r = await req('POST', '/monitoring/quality/rules', { s: S.ownerA, business: A.id, body: draft({ scope: { kind: 'business', businessId: B.id } }) });
  check(r.status === 403 || r.status === 404, 'nor one for another business', msg(r));
  r = await req('POST', '/monitoring/quality/rules', { s: S.ownerA, business: A.id, body: draft({ scope: { kind: 'endpoint', endpointId: b1.id } }) });
  check(r.status === 403 || r.status === 404, 'nor one for another business\'s computer', msg(r));
  r = await req('POST', '/monitoring/quality/rules', { s: S.ownerA, business: A.id, body: draft({ match: { ruleKey: 'app-crash' } }) });
  check(r.status === 400 && code(r) === 'RULE_TOO_BROAD', 'a rule on the monitor\'s every event is too broad', msg(r));
  r = await req('POST', '/monitoring/quality/rules', { s: S.ownerA, business: A.id, body: draft({ match: { ruleKey: 'app-crash' }, allowBroad: true }) });
  check(r.status === 403, 'and only a Platform Admin may make the exception', msg(r));
  r = await req('POST', '/monitoring/quality/rules', { s: S.ownerA, business: A.id, body: draft({ temporary: true, reviewAt: undefined, expiresAt: new Date(Date.now() + 120 * DAY).toISOString() }) });
  check(r.status === 400 && code(r) === 'EXPIRY_TOO_FAR', 'a temporary rule lasts at most 90 days', msg(r));
  r = await req('POST', '/monitoring/quality/rules', { s: S.ownerA, business: A.id, body: draft({ recommendationId: recId }) });
  check(r.status === 201 && r.data?.status === 'pending' && r.data.risk === 'normal' && r.data.revision === 1 && r.data.history?.[0]?.type === 'proposed', 'the owner proposes it from the recommendation: pending, normal risk', msg(r));
  const R1 = r.data?.id;
  check((await prisma.alertRuleRecommendation.findUnique({ where: { id: recId } }))?.status === 'converted', 'the recommendation is converted');
  check(!!(await prisma.activityLog.findFirst({ where: { action: 'ALERT_QUALITY_RULE_PROPOSED', resourceId: R1 } })), 'audited (ALERT_QUALITY_RULE_PROPOSED)');

  section('Shadow evaluation: a pending rule is counted, never applied');
  r = await report(a2, 'app-crash', [CRASH]);
  const x2 = await openAlert(a2.id);
  check(r.status < 300 && x2?.severity === 'WARNING', 'a2: the alert is still raised while the rule is pending', J(x2));
  const shadow = await prisma.alertQualityRule.findUnique({ where: { id: R1 } });
  check(shadow.shadowMatchCount === 1 && shadow.matchCount === 0, 'the pending rule counted one shadow match', J({ s: shadow.shadowMatchCount, m: shadow.matchCount }));

  section('Approving: tested first, fresh authentication, then it applies');
  r = await req('POST', `/monitoring/quality/rules/${R1}/approve`, { s: up.ownerA, business: A.id, body: { revision: 1 } });
  check(r.status === 409 && code(r) === 'SIMULATION_REQUIRED', 'not before a simulation of this revision', msg(r));
  r = await req('POST', `/monitoring/quality/rules/${R1}/simulate`, { s: S.userA, business: A.id });
  check(r.status === 403, 'a technician cannot run a simulation', msg(r));
  r = await req('POST', `/monitoring/quality/rules/${R1}/simulate`, { s: S.ownerA, business: A.id });
  check(r.status === 200 && r.data?.simulation?.current === true && r.data.simulation.matched >= 2 && r.data.simulation.dangerous.length === 0 && r.data.simulation.businesses.every((b) => b.id === A.id), 'the simulation: matches in Acme only, none dangerous', msg(r));
  r = await req('POST', `/monitoring/quality/rules/${R1}/approve`, { s: S.ownerA, business: A.id, body: { revision: 1 } });
  check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED', 'approving needs fresh authentication (monitoring.qualityrule)', msg(r));
  check((await prisma.alertQualityRule.findUnique({ where: { id: R1 } })).status === 'pending', 'and nothing was written');
  r = await req('POST', `/monitoring/quality/rules/${R1}/approve`, { s: up.ownerA, business: A.id, body: { revision: 7 } });
  check(r.status === 409 && code(r) === 'STALE_REVISION', 'a stale revision is refused', msg(r));
  r = await req('POST', `/monitoring/quality/rules/${R1}/approve`, { s: up.ownerA, business: A.id, body: { revision: 1 } });
  check(r.status === 200 && r.data?.status === 'active' && r.data.approvedBy === ownerA.email, 'approved: active', msg(r));
  const x2r = await prisma.monitorAlert.findUnique({ where: { id: x2.id } });
  check(x2r.state === 'RESOLVED' && x2r.resolvedById === null && /approved alert quality rule/.test(x2r.resolveNote ?? ''), 'the open alert it covers is closed, with a note', J({ st: x2r.state, n: x2r.resolveNote }));
  check(!!(await prisma.activityLog.findFirst({ where: { action: 'MONITOR_ALERT_RECLASSIFIED', resourceId: x2.id } })) && !!(await prisma.activityLog.findFirst({ where: { action: 'ALERT_QUALITY_RULE_APPROVED', resourceId: R1 } })), 'the reclassification and the approval are audited');
  check(!!(await prisma.monitorAlert.findUnique({ where: { id: x2.id } })), 'nothing is deleted');
  const inForceMail = await until(() => mailTo(admin.email).find((m) => /now in force/.test(m.subject)), 10_000);
  check(!!inForceMail && inForceMail.text.includes(R1) && !inForceMail.text.includes('vendortool'), 'the Platform Admin is told by mail (ids and the rule\'s name, no event text)', J(inForceMail?.text ?? null));
  check(!(await prisma.alertQualityRule.findUnique({ where: { id: R1 } })).dangerousMatchCount, 'no dangerous matches');

  section('At ingest: suppressed, recorded, counted; others unaffected');
  const seenBefore = (await prisma.monitorEventFingerprint.findFirst({ where: { endpointId: a3.id, fingerprint: FP } }))?.seen ?? 0;
  r = await report(a3, 'app-crash', [CRASH]);
  check(r.status < 300 && !(await openAlert(a3.id)), 'a3: the same event raises nothing');
  const fpRow = await prisma.monitorEventFingerprint.findFirst({ where: { endpointId: a3.id, fingerprint: FP } });
  check(fpRow?.seen === seenBefore + 1, 'the event is still recorded', J(fpRow));
  check((await prisma.alertQualityRule.findUnique({ where: { id: R1 } })).matchCount >= 1, 'the rule counts the match');
  await report(a3, 'app-crash', [HANG]);
  check((await openAlert(a3.id))?.severity === 'WARNING', 'an unrelated event (Application Hang) still alerts');
  await report(a3, 'app-crash', [CRASH, HANG]);
  const both = await openAlert(a3.id);
  check(both?.severity === 'WARNING', 'a report with both still alerts for the unrelated one');
  await report(b1, 'app-crash', [CRASH]);
  check((await openAlert(b1.id))?.severity === 'WARNING', 'Birch: the same event still alerts (the rule is Acme\'s)');
  r = await req('GET', `/monitoring/alerts/${both.id}`, { s: S.ownerA, business: A.id });
  check(r.status === 200 && typeof r.data?.falsePositive?.reports === 'number', 'the alert view carries its false-positive count', msg(r));

  section('Conflicts and precedence');
  r = await req('POST', '/monitoring/quality/rules', { s: S.ownerA, business: A.id, body: draft({ name: 'Vendor tool crash: warning', behaviour: { kind: 'downgrade', severity: 'INFO' } }) });
  const R2 = r.data?.id;
  check(r.status === 201, 'a second rule with the same scope and conditions can be proposed', msg(r));
  await req('POST', `/monitoring/quality/rules/${R2}/simulate`, { s: S.ownerA, business: A.id });
  r = await req('POST', `/monitoring/quality/rules/${R2}/approve`, { s: up.ownerA, business: A.id, body: { revision: 1 } });
  check(r.status === 409 && code(r) === 'RULE_CONFLICT', '…but not approved alongside the first: 409 RULE_CONFLICT', msg(r));
  r = await req('POST', `/monitoring/quality/rules/${R2}/reject`, { s: S.ownerA, business: A.id, body: { note: 'duplicate of the active rule' } });
  check(r.status === 200 && r.data?.status === 'rejected' && !!(await prisma.activityLog.findFirst({ where: { action: 'ALERT_QUALITY_RULE_REJECTED', resourceId: R2 } })), 'rejected, audited, with no step-up', msg(r));
  r = await req('POST', '/monitoring/quality/rules', { s: S.ownerA, business: A.id, body: draft({ name: 'On a4: lower to info', scope: { kind: 'endpoint', endpointId: a4.id }, behaviour: { kind: 'downgrade', severity: 'INFO' } }) });
  const R3 = r.data?.id;
  await req('POST', `/monitoring/quality/rules/${R3}/simulate`, { s: S.ownerA, business: A.id });
  r = await req('POST', `/monitoring/quality/rules/${R3}/approve`, { s: up.ownerA, business: A.id, body: { revision: 1 } });
  check(r.status === 200 && r.data?.status === 'active', 'a computer rule for a4 is approved', msg(r));
  await report(a4, 'app-crash', [CRASH]);
  const x4 = await openAlert(a4.id);
  check(x4?.severity === 'INFO' && x4.classification?.basis === 'quality_rule' && J(x4.classification?.qualityRules) === J([R3]), 'on a4 the computer\'s rule wins over the business\'s: an info alert, explained', J(x4?.classification));
  r = await req('GET', `/monitoring/alerts/${x4.id}`, { s: S.ownerA, business: A.id });
  check(/approved alert quality rule/.test(J(r.data?.explanation)) && r.data?.qualityRules?.[0]?.id === R3, 'its explanation names the rule', J(r.data?.explanation));

  section('Editing: pending only, with the revision read');
  r = await req('POST', '/monitoring/quality/rules', { s: S.ownerA, business: A.id, body: draft({ name: 'Hang on a1', scope: { kind: 'endpoint', endpointId: a1.id }, match: { ruleKey: 'app-crash', provider: 'Application Hang', eventId: 1002 }, behaviour: { kind: 'require_count', minCount: 3 } }) });
  const R4 = r.data?.id;
  await req('POST', `/monitoring/quality/rules/${R4}/simulate`, { s: S.ownerA, business: A.id });
  r = await req('PATCH', `/monitoring/quality/rules/${R4}`, { s: S.ownerA, business: A.id, body: { revision: 3, name: 'Hang on a1 (x3)' } });
  check(r.status === 409 && code(r) === 'STALE_REVISION', 'a stale revision is refused', msg(r));
  r = await req('PATCH', `/monitoring/quality/rules/${R4}`, { s: S.ownerA, business: A.id, body: { revision: 1, name: 'Hang on a1 (x3)' } });
  check(r.status === 200 && r.data?.revision === 2 && r.data.simulation === null && r.data.history.some((h) => h.type === 'edited' && h.snapshot?.name === 'Hang on a1'), 'an edit is a new revision: the simulation is cleared and the previous text kept', msg(r));
  r = await req('PATCH', `/monitoring/quality/rules/${R1}`, { s: S.ownerA, business: A.id, body: { revision: 1, name: 'renamed' } });
  check(r.status === 409 && code(r) === 'NOT_PENDING', 'an active rule is never edited in place', msg(r));

  section('High risk: dangerous matches and a second approver; rollback');
  await report(a1, 'disk-errors', [DISK7]);
  const d1 = await openAlert(a1.id, 'disk-errors');
  check(d1?.severity === 'CRITICAL', 'a1: a genuine disk bad block is critical');
  r = await req('POST', '/monitoring/quality/rules', { s: S.ownerA, business: A.id, body: draft({ name: 'Disk 7 noise', match: { ruleKey: 'disk-errors', provider: 'disk', eventId: 7 } }) });
  const R5 = r.data?.id;
  check(r.status === 201 && r.data.risk === 'high' && r.data.riskReasons.includes('critical_monitor') && r.data.riskReasons.includes('storage_events'), 'a rule on critical disk events is high risk', msg(r));
  await until(() => mailTo(admin.email).find((m) => /high-risk/.test(m.subject) && m.text.includes(R5)), 10_000);
  check(!!mailTo(admin.email).find((m) => /high-risk/.test(m.subject) && m.text.includes(R5)), 'the Platform Admin is told a high-risk rule was proposed');
  r = await req('POST', `/monitoring/quality/rules/${R5}/simulate`, { s: S.ownerA, business: A.id });
  check(r.status === 200 && r.data?.simulation?.dangerous?.length >= 1 && r.data.riskReasons.includes('dangerous_matches'), 'the simulation finds the genuine failure as a dangerous match', msg(r));
  r = await req('POST', `/monitoring/quality/rules/${R5}/approve`, { s: up.ownerA, business: A.id, body: { revision: 1 } });
  check(r.status === 409 && code(r) === 'DANGEROUS_MATCHES', 'approval refuses until the dangerous matches are accepted', msg(r));
  r = await req('POST', `/monitoring/quality/rules/${R5}/approve`, { s: up.ownerA, business: A.id, body: { revision: 1, acceptDangerous: true } });
  check(r.status === 200 && r.data?.status === 'pending' && r.data.awaitingSecondApproval === true, 'the first approval is recorded; it waits for a second', msg(r));
  r = await req('POST', `/monitoring/quality/rules/${R5}/approve`, { s: up.ownerA, business: A.id, body: { revision: 1, acceptDangerous: true } });
  check(r.status === 409 && code(r) === 'SECOND_APPROVER_REQUIRED', 'the same person cannot approve twice', msg(r));
  check((await openAlert(a1.id, 'disk-errors'))?.severity === 'CRITICAL', 'until then the critical alert stands');
  r = await req('POST', `/monitoring/quality/rules/${R5}/approve`, { s: up.admin, body: { revision: 1, acceptDangerous: true } });
  check(r.status === 200 && r.data?.status === 'active' && r.data.secondApprovedBy === admin.email, 'a Platform Admin approves second: active', msg(r));
  check((await prisma.monitorAlert.findUnique({ where: { id: d1.id } })).state === 'RESOLVED', 'the critical alert it covers is closed (it was accepted)');
  r = await req('POST', `/monitoring/quality/rules/${R5}/rollback`, { s: S.ownerA, business: A.id, body: { note: 'too risky after all' } });
  check(r.status === 200 && r.data?.status === 'rolled_back', 'rolled back immediately, with no step-up', msg(r));
  check(!!(await prisma.activityLog.findFirst({ where: { action: 'ALERT_QUALITY_RULE_ROLLED_BACK', resourceId: R5 } })), 'audited (ALERT_QUALITY_RULE_ROLLED_BACK)');
  await report(a1, 'disk-errors', [DISK7]);
  check((await openAlert(a1.id, 'disk-errors'))?.severity === 'CRITICAL', 'the next bad block alerts again, critical');
  await until(() => mailTo(admin.email).find((m) => /rolled back/.test(m.subject) && m.text.includes(R5)), 10_000);
  check(!!mailTo(admin.email).find((m) => /rolled back/.test(m.subject) && m.text.includes(R5)), 'the rollback is mailed');
  r = await req('POST', `/monitoring/quality/rules/${R5}/rollback`, { s: S.ownerA, business: A.id, body: { note: 'again' } });
  check(r.status === 409, 'a rule is rolled back once', msg(r));

  section('Revisions: approving supersedes; rolling back restores the previous');
  r = await req('POST', '/monitoring/quality/rules', { s: S.ownerA, business: A.id, body: draft({ name: 'Vendor tool crash: info only', behaviour: { kind: 'downgrade', severity: 'INFO' }, supersedesId: R1 }) });
  const R6 = r.data?.id;
  check(r.status === 201, 'a revision of the active rule is proposed', msg(r));
  await req('POST', `/monitoring/quality/rules/${R6}/simulate`, { s: S.ownerA, business: A.id });
  r = await req('POST', `/monitoring/quality/rules/${R6}/approve`, { s: up.ownerA, business: A.id, body: { revision: 1 } });
  check(r.status === 200 && r.data?.status === 'active' && (await prisma.alertQualityRule.findUnique({ where: { id: R1 } })).status === 'superseded', 'approved: it replaces the previous version (superseded, kept)', msg(r));
  const a5 = await mkEp(A, 'aqr-a5');
  await report(a5, 'app-crash', [CRASH]);
  check((await openAlert(a5.id))?.severity === 'INFO', 'the event now raises an info alert');
  r = await req('POST', `/monitoring/quality/rules/${R6}/rollback`, { s: S.ownerA, business: A.id, body: { note: 'back to suppress' } });
  check(r.status === 200 && (await prisma.alertQualityRule.findUnique({ where: { id: R1 } })).status === 'active', 'rolling back the revision restores the previous version', msg(r));
  r = await req('GET', `/monitoring/quality/rules/${R1}`, { s: S.ownerA, business: A.id });
  const types = (r.data?.history ?? []).map((h) => h.type);
  check(['proposed', 'simulated', 'approved', 'superseded', 'restored'].every((t) => types.includes(t)) && r.data.versions.some((v) => v.id === R6), 'its history: proposed, simulated, approved, superseded, restored; the versions are linked', J(types));
  const a6 = await mkEp(A, 'aqr-a6');
  await report(a6, 'app-crash', [CRASH]);
  check(!(await openAlert(a6.id)), 'and the event is suppressed again');

  section('Platform rules');
  r = await req('POST', '/monitoring/quality/rules', { s: S.admin, body: draft({ name: 'Everywhere: vendor tool', scope: { kind: 'platform' } }) });
  const R7 = r.data?.id;
  check(r.status === 201 && r.data.risk === 'high' && r.data.riskReasons.includes('platform_wide'), 'a Platform Admin proposes a platform rule: high risk', msg(r));
  await req('POST', `/monitoring/quality/rules/${R7}/simulate`, { s: S.admin });
  r = await req('POST', `/monitoring/quality/rules/${R7}/approve`, { s: up.ownerA, business: A.id, body: { revision: 1 } });
  check(r.status === 403, 'a Business Owner cannot approve a platform rule', msg(r));
  r = await req('GET', '/monitoring/quality/rules', { s: S.ownerB, business: B.id });
  check(r.status === 200 && r.data.rules.some((x) => x.id === R7) && !r.data.rules.some((x) => x.id === R1), 'Birch sees the platform rule, never Acme\'s', msg(r));
  r = await req('GET', `/monitoring/quality/rules/${R1}`, { s: S.ownerB, business: B.id });
  check(r.status === 404, 'Acme\'s rule is a 404 for Birch', msg(r));
  r = await req('POST', `/monitoring/quality/rules/${R7}/reject`, { s: S.admin2, body: { note: 'not now' } });
  check(r.status === 200 && r.data?.status === 'rejected', 'another Platform Admin rejects it');

  section('Expiry and review');
  const ends = Date.now() + 25_000;
  r = await req('POST', '/monitoring/quality/rules', { s: S.ownerB, business: B.id, body: draft({ name: 'Birch: b1 briefly', scope: { kind: 'endpoint', endpointId: b1.id }, temporary: true, reviewAt: undefined, expiresAt: new Date(ends).toISOString() }) });
  const R8 = r.data?.id;
  check(r.status === 201 && r.data.temporary === true, 'Birch\'s owner proposes a temporary exception for b1', msg(r));
  await req('POST', `/monitoring/quality/rules/${R8}/simulate`, { s: S.ownerB, business: B.id });
  r = await req('POST', `/monitoring/quality/rules/${R8}/approve`, { s: up.ownerB, business: B.id, body: { revision: 1 } });
  check(r.status === 200 && r.data?.status === 'active', 'approved', msg(r));
  check(!(await openAlert(b1.id)), 'b1\'s open alert for that event is closed');
  await report(b1, 'app-crash', [CRASH]);
  check(!(await openAlert(b1.id)), 'while it lasts, b1\'s event raises nothing');
  await sleep(Math.max(0, ends - Date.now()) + 500);
  await report(b1, 'app-crash', [CRASH]);
  check((await openAlert(b1.id))?.severity === 'WARNING', 'once past its end it no longer applies');
  const exp = await until(async () => (await prisma.alertQualityRule.findUnique({ where: { id: R8 } })).status === 'expired', 20_000);
  check(exp, 'the sweep marks it expired');
  check(!!(await prisma.activityLog.findFirst({ where: { action: 'ALERT_QUALITY_RULE_EXPIRED', resourceId: R8 } })), 'audited (ALERT_QUALITY_RULE_EXPIRED)');
  const expMail = await until(() => mailTo(ownerB.email).find((m) => /expired/.test(m.subject) && m.text.includes(R8)), 15_000);
  check(!!expMail, 'Birch\'s confirmed owner is told by mail');
  await prisma.alertQualityRule.update({ where: { id: R3 }, data: { reviewAt: new Date(Date.now() - 1000) } });
  const rev = await until(async () => !!(await prisma.alertQualityRule.findUnique({ where: { id: R3 } })).reviewNotifiedAt, 20_000);
  check(rev && (await prisma.alertQualityRule.findUnique({ where: { id: R3 } })).status === 'active', 'a review date passing is noted once, and the rule still applies');
  await sleep(5000);
  check((await prisma.alertQualityRuleEvent.count({ where: { ruleId: R3, type: 'review_due' } })) === 1, 'once only');

  section('PSA tickets: nothing for a suppressed event; one per event signature a day');
  r = await req('PUT', '/psa/connectors', { s: up.ownerA, business: A.id, body: { scope: 'business', businessId: A.id, kind: 'webhook', enabled: true, label: 'Acme PSA', webhookUrl: `http://127.0.0.1:${HOOK_PORT}/acme-${sfx}` } });
  check(r.status === 200, 'Acme: a webhook connector', msg(r));
  r = await req('PUT', '/monitoring/ticket-policy', { s: up.ownerA, business: A.id, body: { scope: 'business', businessId: A.id, enabled: true, minSeverity: 'WARNING', kinds: [] } });
  check(r.status === 200, 'Acme: tickets for warning and above', msg(r));
  await sleep(1100);
  const a7 = await mkEp(A, 'aqr-a7');
  await report(a7, 'app-crash', [CRASH]);
  await report(a7, 'app-crash', [HANG]);
  const h1 = await openAlert(a7.id);
  const sent1 = await until(async () => (await prisma.monitorAlertTicket.findUnique({ where: { alertId: h1.id } }))?.status === 'sent', 30_000);
  check(sent1 && hitsFor(h1.id).length === 1, 'the Application Hang alert opens one ticket', J(hookHits.length));
  check(!hookHits.some((h) => h.json?.ticket?.alert?.title?.includes('vendortool')) && (await prisma.monitorAlert.count({ where: { endpointId: a7.id } })) === 1, 'the suppressed crash raised nothing, so nothing was ticketed');
  await req('POST', `/monitoring/alerts/${h1.id}/resolve`, { s: S.ownerA, business: A.id, body: { note: 'fixed' } });
  await report(a7, 'app-crash', [HANG]);
  const h2 = await openAlert(a7.id);
  check(!!h2 && h2.id !== h1.id && h2.fingerprint === h1.fingerprint, 'the same hang again: a new alert, same fingerprint');
  const dup = await until(async () => (await prisma.monitorAlertTicket.findUnique({ where: { alertId: h2.id } })), 30_000);
  check(dup?.status === 'gave_up' && dup.lastStatus === 'duplicate' && !!dup.ref && hitsFor(h2.id).length === 0, 'linked to the existing ticket, not sent again', J(dup));

  section('AI not configured: refused cleanly, reporting unaffected');
  r = await req('POST', `/endpoints/${a7.id}/ai/explain`, { s: up.ownerA, business: A.id, body: { source: 'alert', alertId: h2.id } });
  check(r.status === 409 && code(r) === 'AI_NOT_CONFIGURED', 'Ask AI on an alert: 409 AI_NOT_CONFIGURED', msg(r));
  r = await req('POST', `/monitoring/alerts/${h2.id}/false-positive`, { s: S.userA, business: A.id, body: { reason: 'incorrect_severity' } });
  check(r.status === 200, 'a false-positive report still works', msg(r));

  section('The dashboard, per business');
  r = await req('GET', '/monitoring/quality/summary', { s: S.ownerA, business: A.id });
  check(r.status === 200 && r.data.totals.reports >= 3 && r.data.totals.approvedRules >= 2 && r.data.totals.noisePrevented >= 2 && r.data.trend.length === 12 && r.data.top.monitors.some((m) => m.key === 'app-crash'), 'Acme: reports, approved rules, noise prevented, a 12-week trend', msg(r));
  r = await req('GET', '/monitoring/quality/summary', { s: S.ownerB, business: B.id });
  check(r.status === 200 && r.data.totals.reports === 1 && !r.data.top.computers.some((c) => c.id === a1.id), 'Birch: its own report only', msg(r));
  r = await req('GET', `/monitoring/quality/reports?monitor=app-crash`, { s: S.ownerA, business: A.id });
  check(r.status === 200 && r.data.reports.length >= 3 && r.data.reports.every((x) => x.monitor === 'app-crash') && r.data.reports.some((x) => x.comment?.includes('VT-221')), 'the reports list, filtered by monitor, with comments', msg(r));
  r = await req('GET', `/monitoring/quality/reports?reportedBy=${userA.id}`, { s: S.ownerA, business: A.id });
  check(r.status === 200 && r.data.reports.every((x) => x.reportedById === userA.id), 'filtered by technician', msg(r));
  r = await req('GET', '/monitoring/quality/reports', { s: S.ownerB, business: B.id });
  check(r.status === 200 && r.data.reports.every((x) => x.businessId === B.id), 'Birch lists only its own reports');
  r = await req('GET', '/monitoring/quality/checks', { s: S.ownerA, business: A.id });
  check(r.status === 200 && Array.isArray(r.data.checks) && r.data.monitorsChecked >= 3 && /Nothing here changes or disables a monitor/.test(r.data.note), 'quality checks: recommendations only', msg(r));
  r = await req('GET', '/monitoring/quality/summary', { s: S.viewerA, business: A.id });
  check(r.status === 403, 'without monitoring:alerts the dashboard is refused', msg(r));
  r = await req('POST', `/monitoring/quality/recommendations/${recId}/dismiss`, { s: S.userA, business: A.id, body: { note: 'not a real problem' } });
  check(r.status === 403 || r.status === 409, 'a technician cannot dismiss a recommendation', msg(r));
  const bRec = await prisma.alertRuleRecommendation.findFirst({ where: { customerId: B.id, status: 'open' } });
  r = await req('POST', `/monitoring/quality/recommendations/${bRec.id}/dismiss`, { s: S.ownerB, business: B.id, body: { note: 'handled by the vendor update' } });
  check(r.status === 200 && !!(await prisma.activityLog.findFirst({ where: { action: 'ALERT_RECOMMENDATION_DISMISSED', resourceId: bRec.id } })), 'Birch\'s owner dismisses its own, audited', msg(r));
  check((await prisma.alertFalsePositiveReport.count({ where: { customerId: B.id } })) === 1, 'and the report is kept');
}

async function cleanup() {
  if (api && api.exitCode === null) await new Promise((r) => { api.once('exit', r); api.kill('SIGTERM'); });
  hookServer.close(); smtp.close();
  try {
    const ids = created.businesses;
    const eps = (await prisma.endpoint.findMany({ where: { customerId: { in: ids } }, select: { id: true } })).map((e) => e.id);
    await prisma.alertQualityRule.deleteMany({ where: { OR: [{ customerId: { in: ids } }, { createdById: { in: created.users } }] } });
    await prisma.alertFalsePositiveReport.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.alertRuleRecommendation.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.monitorAlert.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.monitorEventFingerprint.deleteMany({ where: { endpointId: { in: eps } } });
    await prisma.monitorTicketPolicy.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.psaTicket.deleteMany({ where: { customerId: { in: ids } } }).catch(() => undefined);
    await prisma.psaConnector.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.monitorRule.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.endpointMonitorState.deleteMany({ where: { endpointId: { in: eps } } });
    await prisma.endpointInventory.deleteMany({ where: { endpointId: { in: eps } } });
    await prisma.rustdeskNode.deleteMany({ where: { endpointId: { in: eps } } });
    await prisma.endpoint.deleteMany({ where: { id: { in: eps } } });
    await prisma.emailRecipient.deleteMany({ where: { address: { contains: sfx } } });
    await prisma.smtpSettings.deleteMany({});
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
