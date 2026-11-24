#!/usr/bin/env node
/**
 * End-to-end proof of Settings → Mobile devices (0.83 Beacon, docs/own-mdm.md
 * M1, invariant §92), against the real built API and a scratch database only.
 * No Apple or Google host is called: every certificate and key is a TEST ONLY
 * stand-in made at run time (lib/test-pki.mjs) and never written to disk.
 *
 *   - Platform Admin only: a Business Owner gets 403 on every route;
 *   - every write asks for fresh authentication on `ask` (mdm.setup); a
 *     delete never asks;
 *   - the push key: generated and sealed, the CSR downloadable and verifying
 *     against it, the key never returned; regenerating refused unless asked;
 *   - the vendor certificate: a broken chain and a mismatched key refused;
 *     the signed PushCertRequest verifies under the vendor key;
 *   - the push certificate: a matching one installed, its topic and expiry
 *     shown; a mismatched one, an expired one and a non-push one refused; a
 *     renewal with the same topic accepted; another topic refused, then
 *     accepted only by the replace action naming the current one;
 *   - the Google service-account key: validated, sealed, only the project
 *     and e-mail shown; a bad one refused;
 *   - renewal reminders through the MDM sweep: one security alert per
 *     threshold, held under a global notifications pause;
 *   - deletes audited; no sealed value, private key or certificate body in
 *     any response, audit row, or the API's output;
 *   - conditional writes: a stale revision is refused (0100's one row).
 *
 *   cd apps/api && npx nest build
 *   DATABASE_URL=postgresql://…/<name containing scratch or test> node scripts/e2e-mdm-setup.mjs
 *
 * Ports 4071 (API) and 4072 (the second API, with the MDM sweep on). Never 3001.
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { spawn } from 'node:child_process';
import { createPublicKey, randomBytes, verify } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { confirmEverythingAsks } from './lib/confirm-asks.mjs';
import { P, pushCertFor, rsaKey, serviceAccountJson, testChain, testTopic } from './lib/test-pki.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const DB = process.env.DATABASE_URL ?? '';
const dbName = DB.split('/').pop()?.split('?')[0] ?? '';
if (!/scratch|test/.test(dbName)) { console.error(`Refusing to run against database "${dbName}": name must contain "scratch" or "test".`); process.exit(2); }
const PORT = Number(process.env.MDM_SETUP_API_PORT ?? 4071);
if (PORT < 4071 || PORT > 4072) { console.error(`Refusing port ${PORT}: this suite uses 4071–4072.`); process.exit(2); }
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex').toUpperCase();
const PW = 'mdm-setup-e2e-password-123';
const DAY = 86_400_000;

let pass = 0, fail = 0;
const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;

const JWT = randomBytes(32).toString('hex'), LTS = randomBytes(32).toString('hex'), ENC = randomBytes(32).toString('hex');
const OFF = {
  INTEGRATION_PEERS_FILE: '', REPORT_SCHEDULE_SWEEP: 'off', AUDIT_SEALER: 'off', STALE_SWEEP: 'off', MONITOR_SWEEP: 'off',
  CLIENT_UPDATE_SWEEP: 'off', PATCH_POLICY_SWEEP: 'off', METRIC_SWEEP: 'off', RETENTION_SWEEP: 'off', CHAT_RETENTION_SWEEP: 'off', TRAY_SWEEP: 'off',
  SCRIPT_OUTPUT_SWEEP: 'off', AUTO_MIGRATION_SWEEP: 'off', WINGET_INDEX_SWEEP: 'off', SNAPSHOT_SWEEP: 'off', AGENT_AUTO_UPDATE: 'off',
  WARRANTY_SWEEP: 'off', AUTOMATION_SWEEP: 'off', RESTART_WINDOW_SWEEP: 'off', SSO_SESSION_SWEEP: 'off', TERMINAL_SWEEP: 'off',
  BACKUP_SYNC_SWEEP: 'off',
};
function startApi(port, extra = {}) {
  const p = spawn(process.execPath, [path.join(dist, 'main.js')], {
    env: {
      ...process.env, NODE_ENV: 'test', PORT: String(port), DATABASE_URL: DB, JWT_SECRET: JWT, LAUNCHER_TOKEN_SECRET: LTS, ENCRYPTION_KEY: ENC,
      TRUSTED_PROXIES: 'loopback', HBBS_PRESENCE_HOST: '127.0.0.2', VERSION_FILE: path.resolve(here, '..', '..', '..', 'version.json'),
      FRONTEND_URL: 'https://rmm.example.test', PUBLIC_API_URL: 'https://rmm.example.test', GEOIP_DB_PATH: path.join(here, 'no-geoip.mmdb'),
      ...OFF, MDM_SWEEP: 'off', ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.log = ''; p.stdout.on('data', (d) => { p.log += d; }); p.stderr.on('data', (d) => { p.log += d; });
  return p;
}
async function waitUp(port, p) {
  for (let i = 0; i < 120; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/api/v1/health`); if (r.status < 500) return; } catch { /* */ } await sleep(300); }
  throw new Error(`api did not come up:\n${p.log.slice(-3000)}`);
}
async function stop(p) { if (p && p.exitCode === null && p.signalCode === null) await new Promise((r) => { p.once('exit', r); p.kill('SIGTERM'); }); }

let API = `http://127.0.0.1:${PORT}/api/v1`;
async function req(method, p, { s, body } = {}) {
  await sleep(30);
  const h = { 'content-type': 'application/json', 'x-forwarded-for': ip() };
  if (s) h.cookie = s.cookie + (s.stepUp ? `; step_up=${s.stepUp}` : '');
  const r = await fetch(`${API}${p}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j, data: j?.data, text };
}
async function login(email) {
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip() }, body: JSON.stringify({ email, password: PW }) });
  const mm = (r.headers.get('set-cookie') ?? '').match(/access_token=([^;]+)/);
  if (r.status !== 200 || !mm) throw new Error(`login ${email}: ${r.status} ${await r.text()}`);
  return { cookie: `access_token=${mm[1]}` };
}
async function stepUp(s) {
  const r = await fetch(`${API}/auth/step-up`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip(), cookie: s.cookie }, body: JSON.stringify({ password: PW }) });
  const mm = (r.headers.get('set-cookie') ?? '').match(/step_up=([^;]+)/);
  if (r.status !== 200 || !mm) throw new Error(`step-up: ${r.status}`);
  return { ...s, stepUp: mm[1] };
}
const code = (r) => r.body?.code ?? r.body?.message?.code ?? r.body?.error?.code;
const msg = (r) => `HTTP ${r.status} ${typeof r.body === 'string' ? r.body.slice(0, 300) : JSON.stringify(r.body).slice(0, 600)}`;
const created = { businesses: [], users: [] };
const SECRET_RE = /PRIVATE KEY|BEGIN CERTIFICATE-----|[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]{40,}/;
const resetRow = () => prisma.$executeRawUnsafe(`UPDATE "MdmPlatformSetup" SET "appleChecklist" = '{}', "androidChecklist" = '{}', "signingRoute" = NULL,
  "pushKeyEnc" = NULL, "pushCsrPem" = NULL, "pushKeySpkiSha256" = NULL, "pushKeyCreatedAt" = NULL,
  "vendorKeyEnc" = NULL, "vendorCertPem" = NULL, "vendorChainPem" = NULL, "vendorNotAfter" = NULL, "vendorSetAt" = NULL,
  "pushCertEnc" = NULL, "pushCertSerial" = NULL, "pushCertSha256" = NULL, "pushCertIssuer" = NULL, "pushCertNotBefore" = NULL, "pushCertNotAfter" = NULL,
  "pushCertInstalledAt" = NULL, "pushCertRenewedAt" = NULL, "apnsTopic" = NULL, "appleAccount" = NULL, "pushRemindedDays" = NULL,
  "androidKeyEnc" = NULL, "androidProjectId" = NULL, "androidClientEmail" = NULL, "androidKeyIdLast4" = NULL, "androidKeySetAt" = NULL, "androidTestedAt" = NULL, "androidTestResult" = NULL, "androidQuotaDevices" = NULL, "androidQuotaSetAt" = NULL, "updatedAt" = now()
  WHERE id = 'platform'`);

let api, api2;
async function all() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  if (!(await prisma.mdmPlatformSetup.findUnique({ where: { id: 'platform' } }))) throw new Error('migration 0100 has not run');
  await confirmEverythingAsks(prisma);
  await resetRow();
  const started = new Date();
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });

  section('Fixtures (synthetic): a Platform Admin and a Business Owner');
  const A = await prisma.customer.create({ data: { tenantId: tenant.id, name: `Beacon ${sfx}` } });
  created.businesses.push(A.id);
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag, extra = {}) => { const u = await prisma.user.create({ data: { email: `bc-${tag}-${sfx.toLowerCase()}@test.invalid`, passwordHash: hash, firstName: 'BC', lastName: tag, status: 'ACTIVE', ...extra } }); created.users.push(u.id); return u; };
  const admin = await mkUser('admin', { isPlatformAdmin: true });
  const owner = await mkUser('owner');
  await prisma.membership.create({ data: { userId: owner.id, tenantId: tenant.id, customerId: A.id, roleId: roleOwner.id } });

  api = startApi(PORT);
  await waitUp(PORT, api);
  const S = { admin: await login(admin.email), owner: await login(owner.email) };

  section('Platform Admin only');
  const routes = [['GET', '/mdm/setup'], ['GET', '/mdm/setup/apple/push-csr'], ['PUT', '/mdm/setup/checklist', { platform: 'apple', items: [] }], ['POST', '/mdm/setup/apple/push-key', {}],
    ['PUT', '/mdm/setup/apple/vendor', {}], ['POST', '/mdm/setup/apple/push-request'], ['PUT', '/mdm/setup/apple/push-certificate', {}], ['DELETE', '/mdm/setup/apple/push-certificate'],
    ['PUT', '/mdm/setup/android/service-account', {}], ['DELETE', '/mdm/setup/android/service-account'], ['DELETE', '/mdm/setup/apple/push-key'], ['DELETE', '/mdm/setup/apple/vendor']];
  const ownerCodes = [];
  for (const [m, p, b] of routes) ownerCodes.push((await req(m, p, { s: await stepUp(S.owner), body: b })).status);
  check(ownerCodes.every((c) => c === 403), 'a Business Owner (even with a fresh confirmation) gets 403 on every route', JSON.stringify(ownerCodes));
  let r = await req('GET', '/mdm/setup', { s: S.admin });
  const st = (v) => Object.fromEntries((v?.capabilities ?? []).map((c) => [c.key, c.state]));
  check(r.status === 200 && r.data.apple.state.state === 'requires_setup' && r.data.android.state.state === 'requires_setup' && st(r.data)['apple.enrollment'] === 'requires_setup'
    && st(r.data)['android.connection_test'] === 'requires_setup' && st(r.data)['apple.abm'] === 'planned' && r.data.outboundCalls?.setup === false,
  'a fresh install: both cards require setup (enrollment too, from 0.84; the Google connection test from 0.85); ABM is planned; the setup service calls out to nothing', msg(r));

  section('Fresh authentication on `ask` (mdm.setup)');
  r = await req('POST', '/mdm/setup/apple/push-key', { s: S.admin, body: {} });
  check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED' && r.body?.action === 'mdm.setup', 'generating the push key without a fresh confirmation: 403 STEP_UP_REQUIRED naming mdm.setup', msg(r));
  r = await req('PUT', '/mdm/setup/checklist', { s: S.admin, body: { platform: 'apple', items: ['duns'] } });
  check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED', 'ticking a checklist item asks too', msg(r));
  const F = await stepUp(S.admin);
  r = await req('PUT', '/mdm/setup/checklist', { s: F, body: { platform: 'apple', items: ['duns', 'developer_org'] } });
  check(r.status === 200 && r.data.apple.checklist.join() === 'duns,developer_org' && r.data.apple.state.state === 'requires_setup', 'ticks are stored, and never count as verification', msg(r));
  r = await req('PUT', '/mdm/setup/checklist', { s: F, body: { platform: 'apple', items: ['duns', 'made_up'] } });
  check(r.status === 400 && code(r) === 'UNKNOWN_CHECKLIST_ITEM', 'an unknown item is refused', msg(r));

  section('Step 2: the push key and CSR');
  r = await req('GET', '/mdm/setup/apple/push-csr', { s: S.admin });
  check(r.status === 404 && code(r) === 'NO_PUSH_KEY', 'no CSR before the key exists', msg(r));
  r = await req('POST', '/mdm/setup/apple/push-key', { s: F, body: {} });
  check(r.status === 200 && r.data.apple.pushKey.present && /^[0-9a-f]{64}$/.test(r.data.apple.pushKey.publicKeySha256) && !SECRET_RE.test(r.text), 'generated: the view shows its public key\'s SHA-256 and nothing secret', msg(r));
  const row1 = await prisma.mdmPlatformSetup.findUnique({ where: { id: 'platform' } });
  check(/^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/.test(row1.pushKeyEnc) && !/PRIVATE/.test(JSON.stringify(row1)), 'the key is sealed at rest (iv:tag:ciphertext), no PEM key in the row');
  r = await req('GET', '/mdm/setup/apple/push-csr', { s: S.admin });
  const csrPem = r.data?.csr;
  const parsed = csrPem ? P.readCsr(csrPem) : null;
  check(r.status === 200 && parsed?.ok && parsed.spkiSha256 === row1.pushKeySpkiSha256 && !/PRIVATE/.test(r.text), 'the CSR downloads, verifies, and carries the sealed key\'s public half (and no private key)', msg(r));
  r = await req('POST', '/mdm/setup/apple/push-key', { s: F, body: {} });
  check(r.status === 409 && code(r) === 'PUSH_KEY_EXISTS', 'a second key is refused unless replace is asked for', msg(r));

  section('Step 3: the MDM vendor certificate (stand-ins) and the signed request');
  const now = new Date();
  const ch = testChain(now);
  const other = testChain(now);
  r = await req('PUT', '/mdm/setup/apple/vendor', { s: F, body: { certificate: ch.vendor.pem, privateKey: ch.vendor.keyPem, chain: other.chainPem } });
  check(r.status === 400 && code(r) === 'VENDOR_CHAIN_BROKEN', 'a chain that does not connect is refused', msg(r));
  r = await req('PUT', '/mdm/setup/apple/vendor', { s: F, body: { certificate: ch.vendor.pem, privateKey: other.vendor.keyPem, chain: ch.chainPem } });
  check(r.status === 400 && code(r) === 'VENDOR_KEY_MISMATCH', 'another key is refused', msg(r));
  r = await req('POST', '/mdm/setup/apple/push-request', { s: F });
  check(r.status === 409 && code(r) === 'NO_VENDOR', 'no signed request without a vendor certificate', msg(r));
  r = await req('PUT', '/mdm/setup/apple/vendor', { s: F, body: { certificate: ch.vendor.cert.raw.toString('base64'), privateKey: ch.vendor.keyPem, chain: ch.chainPem } });
  check(r.status === 200 && r.data.apple.vendor.present && /TEST MDM Vendor/.test(r.data.apple.vendor.subject) && r.data.vendorCheck.rootSha256 === P.sha256Hex(ch.root.cert.raw) && !SECRET_RE.test(r.text),
    'the vendor certificate (as Apple\'s DER .cer) is accepted; the root\'s SHA-256 is shown; nothing secret returned', msg(r));
  r = await req('POST', '/mdm/setup/apple/push-request', { s: S.admin });
  check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED', 'signing the request asks', msg(r));
  r = await req('POST', '/mdm/setup/apple/push-request', { s: F });
  const signed = r.data?.request ? P.readPushCertRequest(r.data.request) : null;
  const csrDer = Buffer.from(csrPem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
  check(r.status === 200 && signed && signed.csrDer.equals(csrDer) && verify('sha256', csrDer, createPublicKey(ch.vendor.key), signed.signature) && P.readCertificates(signed.chainPem)?.length === 3 && !/PRIVATE/.test(Buffer.from(r.data.request, 'base64').toString()),
    'the signed PushCertRequest carries Rem0te\'s CSR, verifies under the vendor key, holds the three-certificate chain, and no private key', msg(r));

  section('Step 4–5: the push certificate (stand-ins)');
  const topic = testTopic();
  const good = pushCertFor({ csrPem, topic, now });
  r = await req('PUT', '/mdm/setup/apple/push-certificate', { s: F, body: { certificate: pushCertFor({ publicKey: rsaKey(), topic, now }).pem, appleAccount: 'mdm-push@example.test' } });
  check(r.status === 400 && code(r) === 'CERT_KEY_MISMATCH', 'a certificate for another key is refused (CERT_KEY_MISMATCH)', msg(r));
  r = await req('PUT', '/mdm/setup/apple/push-certificate', { s: F, body: { certificate: pushCertFor({ csrPem, topic, now, notBefore: new Date(now - 400 * DAY), notAfter: new Date(now - DAY) }).pem, appleAccount: 'mdm-push@example.test' } });
  check(r.status === 400 && code(r) === 'CERT_EXPIRED', 'an expired certificate is refused (CERT_EXPIRED)', msg(r));
  r = await req('PUT', '/mdm/setup/apple/push-certificate', { s: F, body: { certificate: pushCertFor({ csrPem, topic: 'com.example.not.push', now }).pem, appleAccount: 'mdm-push@example.test' } });
  check(r.status === 400 && code(r) === 'CERT_NOT_PUSH', 'a certificate with no push topic is refused', msg(r));
  r = await req('PUT', '/mdm/setup/apple/push-certificate', { s: F, body: { certificate: good.pem, appleAccount: 'not an account' } });
  check(r.status === 400, 'the Apple Account must be an e-mail address', msg(r));
  r = await req('PUT', '/mdm/setup/apple/push-certificate', { s: S.admin, body: { certificate: good.pem, appleAccount: 'mdm-push@example.test' } });
  check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED', 'installing asks', msg(r));
  r = await req('PUT', '/mdm/setup/apple/push-certificate', { s: F, body: { certificate: good.pem, appleAccount: 'mdm-push@example.test' } });
  const pc = r.data?.apple?.pushCertificate;
  check(r.status === 200 && r.data.installed.op === 'install' && pc?.topic === topic && pc.daysLeft >= 364 && pc.proven === false && r.data.apple.appleAccount === 'mdm-push@example.test' && st(r.data)['apple.push_certificate'] === 'available' && !SECRET_RE.test(r.text),
    'a matching certificate is installed: topic and expiry shown, "not yet proven", the account recorded, nothing secret returned', msg(r));
  const row2 = await prisma.mdmPlatformSetup.findUnique({ where: { id: 'platform' } });
  check(row2.apnsTopic === topic && /^[0-9a-f]{24}:/.test(row2.pushCertEnc) && !/BEGIN CERTIFICATE/.test(row2.pushCertEnc), 'the topic is plain, the certificate sealed');
  r = await req('POST', '/mdm/setup/apple/push-key', { s: F, body: { replace: true } });
  check(r.status === 409 && code(r) === 'APNS_CERT_INSTALLED', 'a new push key is refused while a certificate is installed (renewal keeps the key)', msg(r));
  r = await req('DELETE', '/mdm/setup/apple/push-key', { s: S.admin });
  check(r.status === 409 && code(r) === 'APNS_CERT_INSTALLED', 'the push key cannot be deleted under its certificate', msg(r));

  section('Step 7: renewal keeps the topic');
  const renewed = pushCertFor({ csrPem, topic, now, notAfter: new Date(now.getTime() + 730 * DAY) });
  r = await req('PUT', '/mdm/setup/apple/push-certificate', { s: F, body: { certificate: renewed.pem, appleAccount: 'mdm-push@example.test' } });
  check(r.status === 200 && r.data.installed.op === 'renew' && r.data.apple.pushCertificate.renewedAt && r.data.apple.pushCertificate.daysLeft > 700, 'a certificate with the same topic is a renewal', msg(r));
  const otherTopic = testTopic();
  const moved = pushCertFor({ csrPem, topic: otherTopic, now });
  r = await req('PUT', '/mdm/setup/apple/push-certificate', { s: F, body: { certificate: moved.pem, appleAccount: 'someone-else@example.test' } });
  check(r.status === 409 && code(r) === 'APNS_TOPIC_CHANGED' && /every enrolled device \(0 now\) must enroll again/.test(r.body?.message ?? ''), 'a different topic is refused on the ordinary upload, saying every enrolled device would have to enroll again', msg(r));
  r = await req('POST', '/mdm/setup/apple/push-certificate/replace', { s: F, body: { certificate: moved.pem, appleAccount: 'someone-else@example.test', currentTopic: otherTopic, acknowledgeReenroll: true } });
  check(r.status === 409 && code(r) === 'APNS_REPLACE_STALE', 'replacing must name the current topic', msg(r));
  r = await req('POST', '/mdm/setup/apple/push-certificate/replace', { s: F, body: { certificate: moved.pem, appleAccount: 'someone-else@example.test', currentTopic: topic } });
  check(r.status === 400, 'replacing must acknowledge re-enrollment', msg(r));
  r = await req('POST', '/mdm/setup/apple/push-certificate/replace', { s: S.admin, body: { certificate: moved.pem, appleAccount: 'someone-else@example.test', currentTopic: topic, acknowledgeReenroll: true } });
  check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED', 'replacing asks', msg(r));
  r = await req('POST', '/mdm/setup/apple/push-certificate/replace', { s: F, body: { certificate: moved.pem, appleAccount: 'someone-else@example.test', currentTopic: topic, acknowledgeReenroll: true } });
  check(r.status === 200 && r.data.installed.op === 'replace' && r.data.apple.topic === otherTopic, 'the replace action, naming the current topic, installs the new topic', msg(r));
  // Back to the first topic for the rest (another replace).
  r = await req('POST', '/mdm/setup/apple/push-certificate/replace', { s: F, body: { certificate: renewed.pem, appleAccount: 'mdm-push@example.test', currentTopic: otherTopic, acknowledgeReenroll: true } });
  check(r.status === 200 && r.data.apple.topic === topic, '(and back)', msg(r));

  section('Conditional writes');
  const before = await prisma.mdmPlatformSetup.findUnique({ where: { id: 'platform' } });
  const stale = await prisma.mdmPlatformSetup.updateMany({ where: { id: 'platform', revision: before.revision - 1 }, data: { signingRoute: 'mdmcert' } });
  check(stale.count === 0, 'a write conditional on an old revision changes nothing');
  let refused = false;
  try { await prisma.$executeRawUnsafe(`DELETE FROM "MdmPlatformSetup" WHERE id = 'platform'`); } catch { refused = true; }
  check(refused, '0100 refuses deleting the setup row');
  refused = false;
  try { await prisma.$executeRawUnsafe(`UPDATE "MdmPlatformSetup" SET "pushKeyEnc" = '-----BEGIN PRIVATE KEY-----' WHERE id = 'platform'`); } catch { refused = true; }
  check(refused, '0100 refuses a PEM where a sealed value belongs');

  section('Android: the service-account key (stand-in)');
  r = await req('PUT', '/mdm/setup/android/service-account', { s: F, body: { keyFile: serviceAccountJson({ type: 'authorized_user' }) } });
  check(r.status === 400 && code(r) === 'ANDROID_KEY_INVALID' && /"type"/.test(r.body?.message ?? ''), 'a key of the wrong type is refused, naming the field', msg(r));
  r = await req('PUT', '/mdm/setup/android/service-account', { s: S.admin, body: { keyFile: serviceAccountJson() } });
  check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED', 'uploading asks', msg(r));
  const sa = serviceAccountJson({ project_id: 'rem0te-beacon-test' });
  r = await req('PUT', '/mdm/setup/android/service-account', { s: F, body: { keyFile: sa } });
  const sv = r.data?.android?.serviceAccount;
  check(r.status === 200 && sv?.projectId === 'rem0te-beacon-test' && sv.clientEmail === 'amapi-test@rem0te-beacon-test.iam.gserviceaccount.com' && sv.keyIdLast4 === JSON.parse(sa).private_key_id.slice(-4)
    && st(r.data)['android.service_account'] === 'available' && st(r.data)['android.enterprise'] === 'requires_setup' && st(r.data)['android.connection_test'] === 'requires_setup' && !SECRET_RE.test(r.text) && !r.text.includes(JSON.parse(sa).private_key_id),
  'accepted and sealed: only the project, the e-mail and the key id\'s last four are shown; the connection test and sign-up still need setup (0.85)', msg(r));

  section('Deletes never ask, and are audited');
  r = await req('DELETE', '/mdm/setup/android/service-account', { s: S.admin });
  check(r.status === 200 && r.data.android.serviceAccount.present === false, 'the Google key is deleted without a fresh confirmation', msg(r));
  r = await req('DELETE', '/mdm/setup/apple/vendor', { s: S.admin });
  check(r.status === 200 && r.data.apple.vendor.present === false, 'the vendor certificate is deleted without a fresh confirmation', msg(r));

  section('Renewal reminders through the MDM sweep (a second API, sweep on)');
  await stop(api);
  // Expiring in 10 days: the 14-day reminder, once.
  const soon = pushCertFor({ csrPem, topic, now: new Date(), notAfter: new Date(Date.now() + 10 * DAY) });
  api = startApi(PORT); await waitUp(PORT, api);
  const F2 = await stepUp(await login(admin.email));
  r = await req('PUT', '/mdm/setup/apple/push-certificate', { s: F2, body: { certificate: soon.pem, appleAccount: 'mdm-push@example.test' } });
  check(r.status === 200 && r.data.apple.pushCertificate.daysLeft === 10, 'a certificate ten days from expiry is installed (renewal)', msg(r));
  await stop(api);
  const pause = await prisma.containmentPause.create({ data: { scope: 'GLOBAL', kinds: ['notifications'], reason: `e2e-mdm-setup ${sfx}`, setBy: 'msp', setById: admin.id } }).catch((e) => { throw new Error(`pause: ${e.message}`); });
  api2 = startApi(PORT + 1, { MDM_SWEEP: 'on', MDM_SWEEP_SECONDS: '2' });
  await waitUp(PORT + 1, api2);
  await sleep(6000);
  let alerts = await prisma.securityAlert.findMany({ where: { kind: { startsWith: 'mdm_push_cert' }, identity: topic, createdAt: { gte: started } } });
  const held = (await prisma.mdmPlatformSetup.findUnique({ where: { id: 'platform' } })).pushRemindedDays;
  check(alerts.length === 0 && held === null, 'under a global notifications pause the reminder is held (nothing raised, nothing claimed)', JSON.stringify({ alerts: alerts.length, held }));
  await prisma.containmentPause.update({ where: { id: pause.id }, data: { clearedAt: new Date() } });
  for (let i = 0; i < 20 && alerts.length === 0; i++) { await sleep(1000); alerts = await prisma.securityAlert.findMany({ where: { kind: { startsWith: 'mdm_push_cert' }, identity: topic, createdAt: { gte: started } } }); }
  await sleep(5000);
  alerts = await prisma.securityAlert.findMany({ where: { kind: { startsWith: 'mdm_push_cert' }, identity: topic, createdAt: { gte: started } } });
  const after = (await prisma.mdmPlatformSetup.findUnique({ where: { id: 'platform' } })).pushRemindedDays;
  check(alerts.length === 1 && alerts[0].kind === 'mdm_push_cert_expiring' && alerts[0].details.reminder === 14 && alerts[0].details.daysLeft === 10 && after === 14 && !SECRET_RE.test(JSON.stringify(alerts[0])),
    'once lifted: one security alert (the 14-day reminder, not 30 and 14), claimed once across sweeps, with no secret', JSON.stringify({ alerts: alerts.map((a) => [a.kind, a.details]), after }));
  await stop(api2);
  api = startApi(PORT); await waitUp(PORT, api);
  const S3 = await login(admin.email);

  section('Deleting the push certificate warns and never asks');
  r = await req('DELETE', '/mdm/setup/apple/push-certificate', { s: S3 });
  check(r.status === 200 && r.data.apple.pushCertificate.present === false && r.data.apple.topic === topic, 'deleted without a fresh confirmation; the topic is kept so the next certificate must match it', msg(r));
  const F3 = await stepUp(S3);
  r = await req('PUT', '/mdm/setup/apple/push-certificate', { s: F3, body: { certificate: moved.pem, appleAccount: 'mdm-push@example.test' } });
  check(r.status === 409 && code(r) === 'APNS_TOPIC_CHANGED', 'after a delete, a certificate of another topic is still refused', msg(r));
  r = await req('DELETE', '/mdm/setup/apple/push-key', { s: S3 });
  check(r.status === 200 && r.data.apple.pushKey.present === false, 'then the push key can be deleted', msg(r));

  section('Nothing secret in any audit row or in the API\'s output');
  const audits = await prisma.activityLog.findMany({ where: { resource: 'mdm_setup', createdAt: { gte: started } }, orderBy: { createdAt: 'asc' } });
  const actions = new Set(audits.map((x) => x.action));
  check(['MDM_SETUP_CHANGED', 'MDM_SETUP_CREDENTIAL_SET', 'MDM_SETUP_CREDENTIAL_DELETED', 'MDM_PUSH_REQUEST_SIGNED', 'MDM_PUSH_CERT_INSTALLED', 'MDM_PUSH_CERT_DELETED'].every((a) => actions.has(a)),
    'every kind of change is audited', [...actions].join(','));
  const ops = audits.filter((x) => x.action === 'MDM_PUSH_CERT_INSTALLED').map((x) => x.metadata.op);
  check(ops.includes('install') && ops.includes('renew') && ops.includes('replace') && audits.some((x) => x.action === 'MDM_PUSH_CERT_DELETED' && 'devicesOrphaned' in x.metadata), 'install, renew and replace are told apart; the delete records the devices it orphans', ops.join(','));
  const auditText = JSON.stringify(audits.map((x) => ({ action: x.action, metadata: x.metadata })));
  check(!SECRET_RE.test(auditText) && !auditText.includes(JSON.parse(sa).private_key_id) && !auditText.includes(ch.vendor.keyPem.slice(40, 80)), 'no key, certificate body, sealed value or Google key id in any audit row');
  const logs = api.log + (api2?.log ?? '');
  check(!/PRIVATE KEY|BEGIN CERTIFICATE/.test(logs), 'no key or certificate in the API\'s output');
  check(!/api\.push\.apple|identity\.apple|googleapis|mdmcert\.download/.test(logs), 'the API logged no call to Apple, Google or mdmcert.download');
}

try {
  await all();
} catch (e) {
  fail++; failures.push(String(e?.stack ?? e)); console.error(e);
} finally {
  await stop(api); await stop(api2);
  await resetRow().catch(() => {});
  await prisma.containmentPause.updateMany({ where: { reason: `e2e-mdm-setup ${sfx}`, clearedAt: null }, data: { clearedAt: new Date() } }).catch(() => {});
  await prisma.membership.deleteMany({ where: { userId: { in: created.users } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: created.users } } }).catch(() => {});
  await prisma.customer.deleteMany({ where: { id: { in: created.businesses } } }).catch(() => {});
  await prisma.$disconnect();
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
