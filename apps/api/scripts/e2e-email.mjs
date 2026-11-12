#!/usr/bin/env node
/**
 * End-to-end proof of outbound email (0.34): the SMTP relay, confirmed
 * recipients, email as an alert destination, scheduled reports, and the
 * `notifications` containment kind.
 *
 *   - a tiny SMTP server in this process (no dependency) is the relay; the
 *     API reaches it on loopback only because SMTP_ALLOW_LOCAL_RELAY=loopback
 *     is in its environment;
 *   - the relay settings: Platform Admin only, fresh authentication, the
 *     host rule, plaintext only to loopback, STARTTLS really required, the
 *     password encrypted, never in a response, an audit row or the API's
 *     output, and cleared when the relay is pointed somewhere else;
 *   - the test email, with the relay's credentials as the relay saw them;
 *   - recipients: a confirmation link that works once, a policy or schedule
 *     naming an unconfirmed (or another business's) address refused;
 *   - an alert email: title, severity, computer, business and a link — and
 *     none of the alert's detail, the hostname or the other business;
 *   - a scheduled report delivered exactly once per period: across repeated
 *     sweeps, across an API restart, and with two API processes sweeping the
 *     same database; a period more than a day late is recorded as missed;
 *   - the owner's access re-checked at send: a demoted owner's schedule
 *     sends nothing of the report, tells the recipients it did not come, and
 *     switches itself off;
 *   - a `notifications` pause stops alert mail, scheduled reports and the
 *     test email; a business pause stops only that business;
 *   - Ash (A) and Beech (B) see nothing of each other.
 *
 *   cd apps/api && npx nest build
 *   DATABASE_URL=postgresql://…/rem0te_email_test node scripts/e2e-email.mjs
 *
 * FIXTURE-TESTED: rows are written directly; the API under test is the real
 * built one, started by this script on port 3491 (EMAIL_API_PORT), with a
 * second one on 3492 for the two-process check and the SMTP sink on 3493.
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSmtpSink } from './lib/smtp-sink.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const DB = process.env.DATABASE_URL ?? '';
const dbName = DB.split('/').pop()?.split('?')[0] ?? '';
if (!/scratch|test/.test(dbName)) { console.error(`Refusing to run against database "${dbName}": name must contain "scratch" or "test".`); process.exit(2); }
const PORT = Number(process.env.EMAIL_API_PORT ?? 3491);
const PORT2 = PORT + 1;
const SINK_PORT = Number(process.env.EMAIL_SINK_PORT ?? PORT + 2);
for (const p of [PORT, PORT2, SINK_PORT]) if ([3000, 3001, 4000, 4001, 443, 25, 465, 587].includes(p)) { console.error(`Refusing port ${p}.`); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'email-e2e-password-123';
const RELAY_USER = `relay-${sfx}`;
const RELAY_PASS = `Relay-Secret-${randomBytes(6).toString('hex')}`;
const WEB = 'https://rmm.example.test';

let pass = 0, fail = 0;
const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;

// ── The SMTP sink (lib/smtp-sink.mjs) ──────────────────────────────────────
// It never offers STARTTLS, so a client that requires it must give up before
// MAIL — which is one of the things checked.
const { sink, server, mailTo, waitMail } = createSmtpSink();

// ── API processes ───────────────────────────────────────────────────────────
const apiEnv = (port) => ({
  ...process.env, NODE_ENV: 'test', PORT: String(port), DATABASE_URL: DB,
  JWT_SECRET: JWT, LAUNCHER_TOKEN_SECRET: LTS,
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? ENC, TRUSTED_PROXIES: 'loopback', HBBS_PRESENCE_HOST: '127.0.0.2',
  VERSION_FILE: path.resolve(here, '..', '..', '..', 'version.json'), FRONTEND_URL: WEB,
  // The relay is this script, on loopback: allowed only because of this.
  SMTP_ALLOW_LOCAL_RELAY: 'loopback',
  // On for this suite (run-e2e.sh turns both off for every other one).
  MONITOR_SWEEP: 'on', REPORT_SCHEDULE_SWEEP: 'on', MONITOR_SWEEP_SECONDS: '2', REPORT_SCHEDULE_SWEEP_SECONDS: '2', AUDIT_SEALER: 'off', ENDPOINT_STALE_SWEEP: 'off',
});
const JWT = randomBytes(32).toString('hex'), LTS = randomBytes(32).toString('hex'), ENC = randomBytes(32).toString('hex');
const procs = [];
function startApi(port = PORT, extra = {}) {
  const p = spawn(process.execPath, [path.join(dist, 'main.js')], { env: { ...apiEnv(port), ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.log = ''; p.stdout.on('data', (d) => { p.log += d; }); p.stderr.on('data', (d) => { p.log += d; });
  p.port = port; procs.push(p);
  return p;
}
async function stopApi(p) { if (!p || p.exitCode !== null || p.signalCode !== null) return; await new Promise((r) => { p.once('exit', r); p.kill('SIGTERM'); }); }
async function waitUp(p) {
  for (let i = 0; i < 120; i++) { try { const r = await fetch(`http://127.0.0.1:${p.port}/api/v1/health`); if (r.status < 500) return; } catch { /* not yet */ } await sleep(300); }
  throw new Error(`api did not come up:\n${p.log.slice(-3000)}`);
}
const allLogs = () => procs.map((p) => p.log).join('\n');

async function req(method, p, { s, body } = {}) {
  await sleep(60); // under the 20 req/s burst throttler
  const h = { 'content-type': 'application/json', 'x-forwarded-for': s?.ip ?? ip() };
  if (s) h.cookie = s.cookie + (s.stepUp ? `; step_up=${s.stepUp}` : '');
  const r = await fetch(`${API}${p}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j, data: j?.data, text, setCookie: r.headers.get('set-cookie') ?? '' };
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
const msg = (r) => `HTTP ${r.status} ${typeof r.body === 'string' ? r.body.slice(0, 300) : JSON.stringify(r.body).slice(0, 400)}`;
const tokenOf = (m) => /verify-email\?token=([A-Za-z0-9_-]+)/.exec(m?.text ?? '')?.[1];

/** A weekly schedule whose last occurrence was `agoMs` ago, in UTC. */
const dueAgo = (agoMs) => { const t = new Date(Date.now() - agoMs); return { dayOfWeek: t.getUTCDay(), time: `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`, timeZone: 'UTC' }; };
async function makeDue(id) {
  await prisma.reportSchedule.update({ where: { id }, data: { createdAt: new Date(Date.now() - 3 * 86_400_000), nextRunAt: new Date(Date.now() - 30_000) } });
}
const deliveries = (id) => prisma.reportDelivery.findMany({ where: { scheduleId: id } });
async function waitDelivery(id, pred = (d) => d.status !== 'sending', ms = 20_000) {
  const t = Date.now();
  while (Date.now() - t < ms) { const d = (await deliveries(id)).find(pred); if (d) return d; await sleep(250); }
  return null;
}

const created = { businesses: [], users: [], pauses: [] };

async function all() {
  await new Promise((r, j) => { server.once('error', j); server.listen(SINK_PORT, '127.0.0.1', r); });
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  // The sweep and the policy cache act on everything in the database: refuse a shared one.
  if (await prisma.smtpSettings.findUnique({ where: { id: 'singleton' } })) await prisma.smtpSettings.delete({ where: { id: 'singleton' } });
  if (await prisma.monitorNotifyPolicy.findUnique({ where: { scopeKey: 'global' } })) throw new Error('This database has a global notification policy; use a fresh scratch database.');
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });
  const roleUser = await prisma.role.findFirst({ where: { type: 'BUSINESS_USER' } });

  section('Fixtures (synthetic): Ash (A) and Beech (B)');
  const A = await prisma.customer.create({ data: { tenantId: tenant.id, name: `EM Ash ${sfx}` } });
  const B = await prisma.customer.create({ data: { tenantId: tenant.id, name: `EM Beech ${sfx}` } });
  created.businesses.push(A.id, B.id);
  const hq = await prisma.site.create({ data: { tenantId: tenant.id, customerId: A.id, name: `Ash HQ ${sfx}` } });
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag, extra = {}) => { const u = await prisma.user.create({ data: { email: `em-${tag}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'EM', lastName: tag, status: 'ACTIVE', ...extra } }); created.users.push(u.id); return u; };
  const admin = await mkUser('admin', { isPlatformAdmin: true });
  const ownerA = await mkUser('owner-a'), ownerB = await mkUser('owner-b'), userA = await mkUser('user-a');
  const memA = await prisma.membership.create({ data: { userId: ownerA.id, tenantId: tenant.id, customerId: A.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: ownerB.id, tenantId: tenant.id, customerId: B.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: userA.id, tenantId: tenant.id, customerId: A.id, roleId: roleUser.id, capabilities: ['computers:view', 'monitoring:alerts'] } });
  const mkEp = (biz, name, site = null) => prisma.endpoint.create({ data: { tenantId: tenant.id, customerId: biz.id, siteId: site?.id ?? null, name: `${name}-${sfx}`, hostname: `${name.toLowerCase()}-host-${sfx}.corp.example`, platform: 'Windows', status: 'ACTIVE', isOnline: true, isManaged: true, lastSeenAt: new Date() } });
  const a1 = await mkEp(A, 'ASH-PC1', hq), b1 = await mkEp(B, 'BEECH-PC1');
  // A disk monitor for each business, so the sweep keeps the fixture alerts open (an alert whose monitor no longer applies is closed).
  for (const [biz, ep] of [[A, a1], [B, b1]]) await prisma.monitorRule.create({ data: { scopeKey: `b:${biz.id}`, customerId: biz.id, key: 'disk', kind: 'DISK_FREE', name: 'Disk space', severity: 'CRITICAL', params: { percent: 10 }, createdById: admin.id } });
  void b1;
  const SECRET_DETAIL = `SERIAL-${sfx}-XYZ`;
  const mkAlert = (biz, ep, title) => prisma.monitorAlert.create({ data: {
    tenantId: tenant.id, customerId: biz.id, siteId: ep.siteId, endpointId: ep.id, ruleKey: 'disk', kind: 'DISK_FREE', dedupKey: `disk:${ep.id}`,
    severity: 'CRITICAL', title, detail: { serial: SECRET_DETAIL, publicIp: '203.0.113.77', freePercent: 4 },
    firstSeenAt: new Date(), lastSeenAt: new Date(), notifyFrom: new Date(), nextCheckAt: new Date(Date.now() + 3_600_000),
  } });

  let api = startApi();
  await waitUp(api);
  const S = { admin: await login(admin.email), ownerA: await login(ownerA.email), ownerB: await login(ownerB.email), userA: await login(userA.email) };
  const up = { admin: await stepUp(S.admin), ownerA: await stepUp(S.ownerA), ownerB: await stepUp(S.ownerB) };

  // ── Off until configured ──────────────────────────────────────────────────
  section('Off until configured');
  let r = await req('GET', '/email/status', { s: S.userA });
  check(r.status === 200 && r.data?.enabled === false, 'outbound email is off on a fresh install', msg(r));
  r = await req('POST', '/email/settings/test', { s: S.admin, body: {} });
  check(r.status === 200 && r.data?.status === 'email_off' && sink.sessions === 0, 'a test email with nothing configured sends nothing and says so', msg(r));

  // ── The relay ─────────────────────────────────────────────────────────────
  section('The relay: Platform Admin, fresh authentication, the host rule');
  const relay = (o = {}) => ({ enabled: true, host: '127.0.0.1', port: SINK_PORT, tlsMode: 'none', username: RELAY_USER, password: RELAY_PASS, fromAddress: `alerts-${sfx}@example.test`, fromName: 'rem0te alerts', ...o });
  r = await req('GET', '/email/settings', { s: S.ownerA });
  check(r.status === 403, 'a Business Owner cannot read the relay settings', msg(r));
  r = await req('PUT', '/email/settings', { s: up.ownerA, body: relay() });
  check(r.status === 403, 'nor change them, even freshly authenticated', msg(r));
  r = await req('PUT', '/email/settings', { s: S.admin, body: relay() });
  check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED', 'a Platform Admin without fresh authentication is refused', msg(r));
  for (const [host, why] of [['169.254.169.254', 'the metadata address'], ['10.0.0.25', 'a private address (only loopback is allowed here)'], ['8.8.8.8', 'a public IP literal'], ['mailhost', 'a single-label name'], ['smtp.corp.internal', 'an internal suffix'], ['0.0.0.0', 'the unspecified address']]) {
    r = await req('PUT', '/email/settings', { s: up.admin, body: relay({ host, tlsMode: 'starttls' }) });
    check(r.status === 400 && code(r) === 'INVALID_HOST', `refused: ${why} (${host})`, msg(r));
  }
  r = await req('PUT', '/email/settings', { s: up.admin, body: relay({ host: 'smtp.example.com' }) });
  check(r.status === 400 && code(r) === 'PLAINTEXT_REFUSED', 'plaintext SMTP to a host that is not loopback is refused', msg(r));
  r = await req('PUT', '/email/settings', { s: up.admin, body: relay({ fromAddress: 'x@example.com\r\nBcc: y@example.com' }) });
  check(r.status === 400 && code(r) === 'INVALID_FROM', 'a from address with a header in it is refused', msg(r));
  r = await req('PUT', '/email/settings', { s: up.admin, body: relay() });
  check(r.status === 200 && r.data?.enabled && r.data?.passwordSet === true && r.data?.password === undefined && !r.text.includes(RELAY_PASS), 'saved: loopback relay, password set and not in the response', msg(r));
  r = await req('GET', '/email/settings', { s: S.admin });
  check(r.status === 200 && r.data?.host === '127.0.0.1' && r.data?.localRelay === 'loopback' && !r.text.includes(RELAY_PASS) && !/passwordEnc/.test(r.text), 'read back without the password (or its ciphertext)', msg(r));
  const row = await prisma.smtpSettings.findUnique({ where: { id: 'singleton' } });
  check(!!row?.passwordEnc && !row.passwordEnc.includes(RELAY_PASS) && /^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/.test(row.passwordEnc), 'stored encrypted (AES-GCM: iv:tag:ciphertext), not in the clear');
  r = await req('PUT', '/email/settings', { s: up.admin, body: relay({ port: SINK_PORT + 1, password: undefined }) });
  check(r.status === 400 && code(r) === 'PASSWORD_REQUIRED', 'pointing the relay at another port without re-entering the password is refused: the saved one is not sent somewhere new', msg(r));
  r = await req('PUT', '/email/settings', { s: up.admin, body: relay({ password: undefined }) });
  check(r.status === 200 && r.data?.passwordChange === 'kept', 'saving the same relay without a password keeps it', msg(r));
  r = await req('GET', '/email/status', { s: S.userA });
  check(r.data?.enabled === true, 'outbound email now reads as on (and nothing about the relay)', msg(r));
  check(JSON.stringify(r.data) === '{"enabled":true}', 'the status route says nothing else', JSON.stringify(r.data));

  section('The test email');
  r = await req('POST', '/email/settings/test', { s: S.admin, body: {} });
  let m = await waitMail((x) => x.to.includes(admin.email) && /Test email/.test(x.subject));
  check(r.status === 200 && r.data?.ok && r.data?.status === 'sent' && !!m, 'the test email reaches the relay, addressed to the admin\'s own account', msg(r));
  check(m?.auth?.user === RELAY_USER && m?.auth?.pass === RELAY_PASS, 'the relay was authenticated with the saved credentials (the password decrypts)');
  check(m?.from === `alerts-${sfx}@example.test` && m?.headers['auto-submitted'] === 'auto-generated', 'from the configured address, marked auto-generated');
  r = await req('POST', '/email/settings/test', { s: S.ownerA, body: {} });
  check(r.status === 403, 'a Business Owner cannot send a test email', msg(r));
  r = await req('POST', '/email/settings/test', { s: S.admin, body: { to: 'anyone@example.com' } });
  check(r.status === 400, 'the test email cannot be sent to a typed address', msg(r));

  section('STARTTLS is required, not attempted');
  r = await req('PUT', '/email/settings', { s: up.admin, body: relay({ tlsMode: 'starttls' }) });
  check(r.status === 200, 'STARTTLS to the loopback relay can be saved', msg(r));
  const before = sink.messages.length;
  r = await req('POST', '/email/settings/test', { s: S.admin, body: {} });
  await sleep(500);
  check(r.data?.ok === false && sink.messages.length === before, 'a relay that does not offer STARTTLS gets nothing: no fallback to plaintext', msg(r));
  r = await req('PUT', '/email/settings', { s: up.admin, body: relay() });
  check(r.status === 200 && r.data?.passwordChange === 'set', 'back to the plaintext loopback relay (password re-entered)', msg(r));

  // ── Recipients ────────────────────────────────────────────────────────────
  section('Recipients: confirmed by the mailbox, with fresh authentication');
  const nocA = `noc-a-${sfx}@example.test`, nocB = `noc-b-${sfx}@example.test`, stranger = `stranger-${sfx}@example.test`;
  r = await req('POST', '/email/recipients', { s: S.ownerA, body: { scope: 'business', address: nocA } });
  check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED', 'adding an address needs fresh authentication', msg(r));
  r = await req('POST', '/email/recipients', { s: up.ownerA, body: { scope: 'business', address: `${nocA.toUpperCase()}`, label: 'NOC' } });
  const recA = r.data;
  check(r.status === 201 && recA?.address === nocA && recA?.verified === false && recA?.confirmation?.status === 'sent', 'a Business Owner adds an address (normalised); a confirmation is sent', msg(r));
  let v = await waitMail((x) => x.to.includes(nocA) && /Confirm this address/.test(x.subject));
  const tokA = tokenOf(v);
  check(!!tokA && v.text.includes(`${WEB}/verify-email?token=`) && v.text.includes(A.name), 'the confirmation carries a link and names who asked');
  r = await req('POST', '/email/recipients', { s: (await stepUp(S.userA)), body: { scope: 'business', address: stranger } });
  check(r.status === 403, 'a Business User cannot add an address', msg(r));
  r = await req('GET', `/email/recipients?scope=business&businessId=${A.id}`, { s: S.ownerB });
  check(r.status === 404, 'B\'s owner asking for A\'s list gets a 404', msg(r));
  r = await req('POST', '/email/recipients', { s: up.ownerB, body: { scope: 'business', businessId: A.id, address: stranger } });
  check(r.status === 404, 'B\'s owner cannot add an address to A', msg(r));
  r = await req('POST', '/email/recipients', { s: up.ownerA, body: { scope: 'global', address: stranger } });
  check(r.status === 403, 'a Business Owner cannot add a global (MSP) address', msg(r));
  r = await req('PUT', '/monitoring/notify-policy', { s: up.ownerA, body: { scope: 'business', businessId: A.id, levels: [{ afterMinutes: 0, minSeverity: 'INFO', destinations: [{ label: 'NOC', recipientId: recA.id }] }] } });
  check(r.status === 400 && code(r) === 'RECIPIENT_NOT_CONFIRMED', 'a policy naming an address not yet confirmed is refused', msg(r));
  r = await req('POST', '/email/verify', { body: { token: tokA } });
  check(r.status === 200 && r.data?.confirmed === true && !r.text.includes(nocA), 'the link confirms it (with no session), and the answer does not repeat the address', msg(r));
  r = await req('POST', '/email/verify', { body: { token: tokA } });
  check(r.status === 400 && code(r) === 'INVALID_TOKEN', 'the link works once', msg(r));
  r = await req('POST', '/email/verify', { body: { token: randomBytes(32).toString('base64url') } });
  check(r.status === 400, 'a made-up token confirms nothing', msg(r));
  r = await req('POST', '/email/recipients', { s: up.ownerB, body: { scope: 'business', address: nocB } });
  const recB = r.data;
  v = await waitMail((x) => x.to.includes(nocB) && /Confirm/.test(x.subject));
  r = await req('POST', '/email/verify', { body: { token: tokenOf(v) } });
  check(r.status === 200, 'B confirms its own address', msg(r));
  r = await req('POST', '/email/recipients', { s: up.ownerA, body: { scope: 'business', address: stranger } });
  const recStranger = r.data;
  r = await req('POST', `/email/recipients/${recStranger.id}/resend`, { s: up.ownerA });
  check(r.status === 409 && code(r) === 'TOO_SOON', 'a confirmation cannot be re-sent within five minutes', msg(r));
  r = await req('GET', '/email/recipients?scope=business', { s: S.ownerA });
  check(r.status === 200 && r.data.recipients.length === 2 && r.data.recipients.find((x) => x.id === recA.id)?.verified === true && !r.text.includes(nocB), 'A\'s list: its two addresses, one confirmed, nothing of B', msg(r));
  r = await req('DELETE', `/email/recipients/${recA.id}`, { s: up.ownerB });
  check(r.status === 404, 'B\'s owner cannot remove A\'s address', msg(r));
  r = await req('DELETE', `/email/recipients/${recStranger.id}`, { s: S.ownerA });
  check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED', 'removing an address needs fresh authentication too', msg(r));

  // ── Alert email ───────────────────────────────────────────────────────────
  section('An alert email: minimal and redacted');
  r = await req('PUT', '/monitoring/notify-policy', { s: up.ownerB, body: { scope: 'business', businessId: B.id, levels: [{ afterMinutes: 0, minSeverity: 'INFO', destinations: [{ label: 'NOC', recipientId: recA.id }] }] } });
  check(r.status === 400 && code(r) === 'RECIPIENT_NOT_CONFIRMED', 'B cannot point its policy at A\'s confirmed address', msg(r));
  r = await req('PUT', '/monitoring/notify-policy', { s: S.ownerA, body: { scope: 'business', businessId: A.id, levels: [{ afterMinutes: 0, minSeverity: 'INFO', destinations: [{ label: 'NOC', recipientId: recA.id }] }] } });
  check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED', 'changing who is notified still needs fresh authentication', msg(r));
  r = await req('PUT', '/monitoring/notify-policy', { s: up.ownerA, body: { scope: 'business', businessId: A.id, levels: [{ afterMinutes: 0, minSeverity: 'INFO', destinations: [{ label: 'NOC', recipientId: recA.id }] }] } });
  check(r.status === 200 && r.data?.business?.levels?.[0]?.destinations?.[0]?.email === nocA && r.data.business.levels[0].destinations[0].confirmed === true, 'A\'s policy names the confirmed address; the view shows it', msg(r));
  r = await req('PUT', '/monitoring/notify-policy', { s: up.ownerB, body: { scope: 'business', businessId: B.id, levels: [{ afterMinutes: 0, minSeverity: 'INFO', destinations: [{ label: 'NOC', recipientId: recB.id }] }] } });
  check(r.status === 200, 'B\'s policy names B\'s address', msg(r));
  const al = await mkAlert(A, a1, `Disk C: 4% free on ${a1.name}`);
  const bl = await mkAlert(B, b1, `Disk C: 3% free on ${b1.name}`);
  await prisma.monitorAlert.updateMany({ where: { id: { in: [al.id, bl.id] } }, data: { nextCheckAt: new Date() } });
  m = await waitMail((x) => x.to.includes(nocA) && /CRITICAL/.test(x.subject));
  const mb = await waitMail((x) => x.to.includes(nocB) && /CRITICAL/.test(x.subject));
  check(!!m && m.subject === `[rem0te] CRITICAL: Disk C: 4% free on ${a1.name}`, 'A\'s address gets the alert: severity and title in the subject', m?.subject);
  check(!!m && m.text.includes(`Computer:  ${a1.name}`) && m.text.includes(`Business:  ${A.name}`) && m.text.includes(`${WEB}/alerts?alert=${al.id}`), 'the body: computer, business and a link to the alert');
  const redacted = [SECRET_DETAIL, '203.0.113.77', a1.hostname, 'freePercent', a1.id, hq.name, B.name, b1.name];
  check(!!m && redacted.every((x) => !m.raw.includes(x)), 'and none of the alert\'s detail, the hostname, the computer id, the site, or B', redacted.filter((x) => m?.raw.includes(x)).join(', '));
  check(!!mb && !mb.raw.includes(A.name) && !mb.raw.includes(a1.name) && mailTo(nocB).every((x) => !x.raw.includes(a1.name)), 'B\'s address gets B\'s alert and nothing of A');
  check(mailTo(nocA).every((x) => !x.raw.includes(b1.name)), 'A\'s address never gets B\'s alert');
  const ev = await prisma.monitorAlertEvent.findFirst({ where: { alertId: al.id, type: 'notified' } });
  check(ev?.detail?.results?.[0]?.status === 'email sent' && ev.detail.results[0].ok === true, 'the alert records the delivery', JSON.stringify(ev?.detail));

  // ── Containment ───────────────────────────────────────────────────────────
  section('A `notifications` pause stops mail');
  r = await req('POST', '/containment/pauses', { s: S.ownerA, body: { scope: 'business', businessId: A.id, kinds: ['notifications'], reason: 'Checking where our mail goes' } });
  check(r.status === 201 && r.data?.kinds?.join() === 'notifications', 'A\'s owner suspends outbound email for A (no step-up needed to stop)', msg(r));
  created.pauses.push(r.data?.id);
  await prisma.monitorAlert.update({ where: { id: al.id }, data: { state: 'RESOLVED', resolvedAt: new Date() } });
  await prisma.monitorAlert.update({ where: { id: bl.id }, data: { state: 'RESOLVED', resolvedAt: new Date() } });
  const al2 = await mkAlert(A, a1, `Disk D: 2% free on ${a1.name}`);
  const bl2 = await mkAlert(B, b1, `Disk D: 1% free on ${b1.name}`);
  await prisma.monitorAlert.updateMany({ where: { id: { in: [al2.id, bl2.id] } }, data: { nextCheckAt: new Date() } });
  const mb2 = await waitMail((x) => x.to.includes(nocB) && /Disk D/.test(x.subject));
  await sleep(3000);
  const ev2 = await prisma.monitorAlertEvent.findFirst({ where: { alertId: al2.id, type: 'notified' } });
  check(!mailTo(nocA).some((x) => /Disk D/.test(x.subject)) && ev2?.detail?.results?.[0]?.status === 'email contained', 'A\'s new alert is not mailed, and the alert records why', JSON.stringify(ev2?.detail));
  check(!!mb2, 'B is not suspended: B\'s alert is still mailed');
  r = await req('POST', '/email/settings/test', { s: S.admin, body: {} });
  check(r.data?.status === 'sent', 'a business pause does not stop the platform\'s own test email', msg(r));
  const g = await prisma.containmentPause.create({ data: { scope: 'GLOBAL', kinds: ['notifications'], reason: 'e2e global mail stop', setById: admin.id, setBy: 'msp' } });
  created.pauses.push(g.id);
  r = await req('POST', '/email/settings/test', { s: S.admin, body: {} });
  check(r.data?.ok === false && r.data?.status === 'contained', 'a global pause stops even the test email', msg(r));
  // Lifted out of band (lifting through the API needs a second person: e2e-containment proves that).
  await prisma.containmentPause.updateMany({ where: { id: { in: created.pauses } }, data: { clearedAt: new Date(), clearedById: admin.id, clearReason: 'e2e' } });

  // ── Scheduled reports ─────────────────────────────────────────────────────
  section('Scheduled reports: who, fresh authentication, recipients');
  const schedBody = (o = {}) => ({ report: 'patch-compliance', frequency: 'weekly', dayOfWeek: 1, time: '08:00', timeZone: 'Europe/London', attachCsv: true, recipientIds: [recA.id], ...o });
  r = await req('POST', '/reports/schedules', { s: S.ownerA, body: schedBody() });
  check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED', 'setting up a schedule needs fresh authentication', msg(r));
  r = await req('POST', '/reports/schedules', { s: up.ownerA, body: schedBody({ recipientIds: [recB.id] }) });
  check(r.status === 400 && code(r) === 'RECIPIENT_NOT_CONFIRMED', 'A cannot schedule a report to B\'s address', msg(r));
  r = await req('POST', '/reports/schedules', { s: up.ownerA, body: schedBody({ recipientIds: [recStranger.id] }) });
  check(r.status === 400 && code(r) === 'RECIPIENT_NOT_CONFIRMED', 'nor to an address that was never confirmed', msg(r));
  r = await req('POST', '/reports/schedules', { s: up.ownerA, body: schedBody({ businessId: B.id }) });
  check(r.status === 404, 'nor for B', msg(r));
  r = await req('POST', '/reports/schedules', { s: (await stepUp(S.userA)), body: schedBody() });
  check(r.status === 403, 'a Business User cannot set one up', msg(r));
  r = await req('POST', '/reports/schedules', { s: up.ownerA, body: schedBody({ frequency: 'monthly', dayOfWeek: undefined, dayOfMonth: 31 }) });
  check(r.status === 400 && code(r) === 'INVALID_SCHEDULE', 'monthly on the 31st is refused', msg(r));
  r = await req('POST', '/reports/schedules', { s: up.ownerA, body: schedBody() });
  const sA = r.data;
  check(r.status === 201 && sA?.describe === 'Every Monday at 08:00 (Europe/London)' && sA.recipients[0]?.address === nocA && new Date(sA.nextRunAt) > new Date(), 'A\'s owner schedules patch compliance, weekly, CSV attached', msg(r));
  r = await req('POST', '/reports/schedules', { s: up.ownerB, body: schedBody({ report: 'agent-coverage', recipientIds: [recB.id], ...dueAgo(4 * 60_000) }) });
  const sB = r.data;
  check(r.status === 201, 'B\'s owner schedules agent coverage to B\'s address', msg(r));
  r = await req('GET', '/reports/schedules', { s: S.ownerB });
  check(r.status === 200 && r.data.schedules.length === 1 && r.data.schedules[0].id === sB.id && !r.text.includes(nocA) && !r.text.includes(sA.id), 'B lists only B\'s schedule', msg(r));
  r = await req('GET', `/reports/schedules?businessId=${A.id}`, { s: S.ownerB });
  check(r.status === 404, 'B asking for A\'s schedules gets a 404', msg(r));
  r = await req('PATCH', `/reports/schedules/${sA.id}`, { s: up.ownerB, body: { enabled: false } });
  check(r.status === 404, 'B cannot change A\'s schedule', msg(r));
  r = await req('DELETE', `/reports/schedules/${sA.id}`, { s: S.ownerB });
  check(r.status === 404, 'or delete it', msg(r));

  section('Delivered once per period, with the audited CSV');
  r = await req('PATCH', `/reports/schedules/${sA.id}`, { s: up.ownerA, body: dueAgo(5 * 60_000) });
  check(r.status === 200, 'A\'s schedule moved to a few minutes ago (so it is due)', msg(r));
  await makeDue(sA.id); await makeDue(sB.id);
  let d = await waitDelivery(sA.id);
  m = await waitMail((x) => x.to.includes(nocA) && /Patch compliance report/.test(x.subject));
  check(d?.status === 'sent' && !!m, 'the report is mailed to A\'s address', JSON.stringify(d));
  const csvA = m?.attachments?.[0];
  check(!!csvA && /^patch-compliance-.*\.csv$/.test(csvA.filename) && csvA.content.includes(a1.hostname) && !csvA.content.includes(b1.hostname) && !csvA.content.includes(B.name), 'with the CSV attached: A\'s computer, nothing of B', JSON.stringify(csvA?.filename));
  check(!!m && m.text.includes(`${WEB}/reports/patch-compliance?businessId=${A.id}`) && !m.text.includes(a1.hostname), 'the body is a link; the computers are only in the CSV');
  const exp = await prisma.activityLog.findFirst({ where: { action: 'REPORT_EXPORTED', actorId: ownerA.id }, orderBy: { createdAt: 'desc' } });
  check(exp?.metadata?.via === 'schedule' && exp.metadata.scheduleId === sA.id && exp.metadata.rows === d?.rows && exp.customerId === A.id, 'the CSV is the audited export: REPORT_EXPORTED as the owner, naming the schedule', JSON.stringify(exp?.metadata));
  const sent = await prisma.activityLog.findFirst({ where: { action: 'REPORT_SCHEDULE_SENT', resourceId: sA.id } });
  check(!!sent && sent.metadata.sent === 1, 'and the delivery is audited as REPORT_SCHEDULE_SENT');
  const dB = await waitDelivery(sB.id);
  const mB = await waitMail((x) => x.to.includes(nocB) && /Agent coverage report/.test(x.subject));
  if (!mB || dB?.status !== 'sent') console.log('B delivery', JSON.stringify(dB), mB && { att: mB.attachments.map((a) => a.filename), hasB: mB.attachments[0]?.content.includes(b1.hostname), a: mB.raw.includes(a1.hostname) || mB.raw.includes(A.name) });
  check(dB?.status === 'sent' && !!mB && mB.attachments[0]?.content.includes(b1.hostname) && !mB.raw.includes(a1.hostname) && !mB.raw.includes(A.name), 'B\'s report reaches B with B\'s computers and nothing of A');
  const countA = () => mailTo(nocA).filter((x) => /Patch compliance report/.test(x.subject)).length;
  await makeDue(sA.id);
  await sleep(5000);
  check(countA() === 1 && (await deliveries(sA.id)).length === 1, 'due again in the same period: nothing more is sent (one delivery row)', `${countA()} mails`);

  section('…across an API restart, and with two API processes');
  await stopApi(api);
  await makeDue(sA.id);
  api = startApi();
  await waitUp(api);
  await sleep(5000);
  check(countA() === 1 && (await deliveries(sA.id)).length === 1, 'after a restart the same period is not sent again', `${countA()} mails`);
  const api2 = startApi(PORT2);
  await waitUp(api2);
  // A new period for B: both processes see it due at once.
  await prisma.reportDelivery.deleteMany({ where: { scheduleId: sB.id } });
  const countB = () => mailTo(nocB).filter((x) => /Agent coverage report/.test(x.subject)).length;
  const cb = countB();
  for (let i = 0; i < 3; i++) { await makeDue(sB.id); await sleep(2500); }
  check(countB() === cb + 1 && (await deliveries(sB.id)).length === 1, 'two API processes sweeping the same database send one report for the period', `${countB() - cb} mails`);
  await stopApi(api2);

  section('Late, contained, and the owner re-checked at send');
  r = await req('POST', '/reports/schedules', { s: up.ownerA, body: schedBody({ report: 'alert-frequency', ...dueAgo(2 * 86_400_000 + 60_000) }) });
  const sLate = r.data;
  await prisma.reportSchedule.update({ where: { id: sLate.id }, data: { createdAt: new Date(Date.now() - 9 * 86_400_000), nextRunAt: new Date(Date.now() - 30_000) } });
  d = await waitDelivery(sLate.id);
  check(d?.status === 'missed' && !mailTo(nocA).some((x) => /Alert frequency/.test(x.subject)), 'a period more than a day late is recorded as missed, not sent', JSON.stringify(d));
  r = await req('POST', '/containment/pauses', { s: S.ownerA, body: { scope: 'business', businessId: A.id, kinds: ['notifications'], reason: 'Stopping report mail' } });
  created.pauses.push(r.data?.id);
  r = await req('POST', '/reports/schedules', { s: up.ownerA, body: schedBody({ report: 'offline-time', ...dueAgo(3 * 60_000) }) });
  const sCont = r.data;
  await makeDue(sCont.id);
  d = await waitDelivery(sCont.id);
  check(d?.status === 'blocked' && d.detail?.reason === 'contained' && !mailTo(nocA).some((x) => /Offline time/.test(x.subject)), 'while A\'s mail is suspended, A\'s report is blocked (recorded, not sent)', JSON.stringify(d));
  await prisma.containmentPause.updateMany({ where: { id: { in: created.pauses } }, data: { clearedAt: new Date(), clearedById: admin.id, clearReason: 'e2e' } });
  r = await req('POST', '/reports/schedules', { s: up.ownerA, body: schedBody({ report: 'alert-frequency', ...dueAgo(3 * 60_000) }) });
  const sGone = r.data;
  // Demote A's owner to a Business User with no permissions.
  await prisma.membership.update({ where: { id: memA.id }, data: { roleId: roleUser.id, capabilities: [] } });
  await makeDue(sGone.id);
  d = await waitDelivery(sGone.id);
  const notice = await waitMail((x) => x.to.includes(nocA) && /could not be sent/.test(x.subject));
  const sg = await prisma.reportSchedule.findUnique({ where: { id: sGone.id } });
  check(d?.status === 'failed' && d.detail?.reason === 'owner_lost_access', 'the demoted owner\'s schedule fails closed', JSON.stringify(d));
  if (!notice) console.log('mail to A:', mailTo(nocA).map((x) => x.subject));
  check(!!notice && notice.attachments.length === 0 && !notice.raw.includes(a1.name) && !notice.raw.includes(a1.hostname) && /no longer has access/.test(notice.text), 'the recipient is told it did not come — no CSV, no computer');
  check(sg?.enabled === false && /no longer a Business Owner/.test(sg.disabledReason ?? ''), 'and the schedule switched itself off, saying why', sg?.disabledReason);
  check(!!(await prisma.activityLog.findFirst({ where: { action: 'REPORT_SCHEDULE_FAILED', resourceId: sGone.id } })), 'audited as REPORT_SCHEDULE_FAILED');
  check(!(await prisma.activityLog.findFirst({ where: { action: 'REPORT_EXPORTED', actorId: ownerA.id, createdAt: { gt: d?.createdAt ?? new Date() } } })), 'and no export was made for it');
  await prisma.membership.update({ where: { id: memA.id }, data: { roleId: roleOwner.id, capabilities: [] } });

  // ── Secrets ───────────────────────────────────────────────────────────────
  section('The relay password is nowhere');
  const rows = await prisma.activityLog.findMany({ where: { action: { in: ['SMTP_SETTINGS_CHANGED', 'EMAIL_TEST_SENT'] }, actorId: admin.id } });
  check(rows.length >= 5 && rows.every((x) => !JSON.stringify(x.metadata).includes(RELAY_PASS)), `not in any of the ${rows.length} relay audit rows`);
  const ch = rows.find((x) => x.action === 'SMTP_SETTINGS_CHANGED');
  check(!!ch && ['set', 'kept', 'cleared', 'cleared_relay_changed', 'none'].includes(ch.metadata.password), 'the audit row says only whether it changed', JSON.stringify(ch?.metadata));
  check(!allLogs().includes(RELAY_PASS), 'not in the API\'s output');
  const anyLog = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "ActivityLog" WHERE metadata::text LIKE $1`, `%${RELAY_PASS}%`);
  check(anyLog[0].n === 0, 'not in any audit row at all');
}

async function cleanup() {
  for (const p of procs) await stopApi(p);
  server.close();
  try {
    const ids = created.businesses;
    await prisma.reportSchedule.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.emailRecipient.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.monitorNotifyPolicy.deleteMany({ where: { customerId: { in: ids } } });
    const eps = (await prisma.endpoint.findMany({ where: { customerId: { in: ids } }, select: { id: true } })).map((e) => e.id);
    await prisma.monitorAlert.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.monitorRule.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.endpointMonitorState.deleteMany({ where: { endpointId: { in: eps } } });
    await prisma.endpoint.deleteMany({ where: { id: { in: eps } } });
    await prisma.containmentPause.deleteMany({ where: { id: { in: created.pauses.filter(Boolean) } } });
    await prisma.site.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.membership.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.customer.deleteMany({ where: { id: { in: ids } } });
    await prisma.smtpSettings.deleteMany({});
    await prisma.activityLog.updateMany({ where: { actorId: { in: created.users } }, data: { actorId: null } }).catch(() => undefined);
    if (created.users.length) await prisma.user.deleteMany({ where: { id: { in: created.users } } });
  } catch (e) { console.error('cleanup:', e.message); }
  await prisma.$disconnect();
}

all().catch((e) => { fail++; failures.push(`crashed: ${e.stack ?? e}`); console.error(e); })
  .finally(async () => {
    const logs = allLogs();
    await cleanup();
    console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
    if (failures.length) { for (const f of failures) console.log(`  - ${f}`); console.log(`\n── API output (last 4000 characters)\n${logs.slice(-4000)}`); process.exit(1); }
    process.exit(0);
  });
