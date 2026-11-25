#!/usr/bin/env node
/**
 * 0.85 Mooring: Rem0te as the EMM for Android, the pure parts and the client
 * (src/mdm/drivers/android/{shape,amapi}.ts, setup-model.ts) and their
 * agreement with migration 0102. Invariant §94.
 *
 *   - the default policy is exactly software and app reports, never network
 *     info; the enrollment token body is one-time, at most an hour, with the
 *     per-token personal-usage choice;
 *   - the service-account JWT is RS256, carries one scope and an hour, and
 *     verifies under the key;
 *   - a Google Device maps to the neutral record: states, ownership (only
 *     COMPANY_OWNED is corporate), scope, compliance; a personal device's
 *     serial never survives parseDevice; IMEI, network info and users are
 *     never read; an unknown state is skipped;
 *   - an Operation maps to a command: accepted is its creation, completed
 *     only `done` without an error, a WIPE on a work profile removes only
 *     the work data; unknown types skipped;
 *   - query escaping leaves only [A-Za-z0-9._~%=&-];
 *   - the client against an in-process loopback stand-in in AMAPI's shape
 *     (NODE_ENV=test, AMAPI_TEST_BASE_URL): the token exchange, caching
 *     keyed by the credential, a 401 retried once with a new token, the
 *     `fields` partial response, every error a short code; and with no
 *     stand-in under NODE_ENV=test, `not_ready` before any request;
 *   - 0102's CHECKs are the model's lists, in order.
 *
 * No database. Never reaches Google: every request goes to 127.0.0.1. Needs
 * `nest build` (dist/).
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createPrivateKey, createPublicKey, verify } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, URL, URLSearchParams } from 'node:url';
import { serviceAccountJson } from './lib/test-pki.mjs';

process.env.NODE_ENV = 'test';
delete process.env.AMAPI_TEST_BASE_URL;
const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..', '..');
const dist = (f) => {
  for (const base of [path.join(here, '..', 'dist'), path.join(here, '..', 'dist', 'src')]) {
    try { return require(path.join(base, f)); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
  }
  throw new Error(`dist/${f} not found`);
};
const S = dist('mdm/drivers/android/shape.js');
const A = dist('mdm/drivers/android/amapi.js');
const D = dist('mdm/drivers/android/index.js');
const SC = dist('mdm/schemas.js');
const MODEL = dist('mdm/model.js');
const SM = dist('mdm/setup/setup-model.js');
const sql = readFileSync(path.join(root, 'apps/api/prisma/migrations/0102_mdm_android/migration.sql'), 'utf8');

let pass = 0, fail = 0;
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${n}${d ? `\n      ${d}` : ''}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const J = JSON.stringify;

section('The default policy and the enrollment token');
check(J(S.DEFAULT_POLICY) === J({ statusReportingSettings: { softwareInfoEnabled: true, applicationReportsEnabled: true } }),
  'the default policy is exactly softwareInfoEnabled and applicationReportsEnabled', J(S.DEFAULT_POLICY));
check(!/networkInfo|memoryInfo|powerManagement|hardwareStatus|displayInfo|deviceSettings|commonCriteria|systemProperties/.test(J(S.DEFAULT_POLICY)), 'it never turns on network info (IMEI, MACs) or any other report');
check(S.POLICY_ID === 'rem0te-default' && /"policyId" = 'rem0te-default'/.test(sql), 'one policy id, rem0te-default, and 0102 holds it');
const tb = S.enrollmentTokenBody('LC00abc', 'allowed', 60);
check(tb.oneTimeOnly === true && tb.duration === '3600s' && tb.allowPersonalUsage === 'PERSONAL_USAGE_ALLOWED' && tb.policyName === 'enterprises/LC00abc/policies/rem0te-default' && Object.keys(tb).length === 4,
  'a work-profile token: one-time, an hour, personal usage allowed, the default policy, nothing else', J(tb));
check(S.enrollmentTokenBody('LC00abc', 'disallowed', 15).allowPersonalUsage === 'PERSONAL_USAGE_DISALLOWED' && S.enrollmentTokenBody('LC00abc', 'disallowed', 15).duration === '900s',
  'fully managed: personal usage disallowed; 15 minutes is 900s');
check(S.TOKEN_MIN_MINUTES === 15 && S.TOKEN_MAX_MINUTES === 60 && S.TOKEN_DEFAULT_MINUTES === 60 && S.SIGNUP_MINUTES <= 60, 'tokens 15–60 minutes, an hour by default; a sign-up at most an hour');

section('The service-account JWT');
const sa = JSON.parse(serviceAccountJson());
const cred = { projectId: sa.project_id, clientEmail: sa.client_email, privateKeyId: sa.private_key_id, key: createPrivateKey(sa.private_key) };
const jwt = S.signJwt(cred, 'https://oauth2.googleapis.com/token', A.AMAPI_SCOPE, 1_800_000_000);
const [h, b, sig] = jwt.split('.');
const head = JSON.parse(Buffer.from(h, 'base64url')), body = JSON.parse(Buffer.from(b, 'base64url'));
check(head.alg === 'RS256' && head.typ === 'JWT' && head.kid === sa.private_key_id, 'RS256 with the key id', J(head));
check(body.iss === sa.client_email && body.scope === 'https://www.googleapis.com/auth/androidmanagement' && body.aud === 'https://oauth2.googleapis.com/token'
  && body.exp - body.iat === 3600 && Object.keys(body).length === 5, 'one scope (androidmanagement), the token endpoint as audience, an hour', J(body));
check(verify('sha256', Buffer.from(`${h}.${b}`), createPublicKey(cred.key), Buffer.from(sig, 'base64url')), 'the signature verifies under the service-account key');
check(A.GOOGLE_TOKEN_URL === 'https://oauth2.googleapis.com/token' && A.AMAPI_ORIGIN === 'https://androidmanagement.googleapis.com', 'Google\'s two hosts are the client\'s constants');

section('A Google Device as the neutral record');
const dev = (o = {}) => ({
  name: 'enterprises/LC00abc/devices/3f9a1b2c', state: 'ACTIVE', ownership: 'COMPANY_OWNED', managementMode: 'DEVICE_OWNER',
  enrollmentTime: '2026-11-20T10:00:00Z', lastStatusReportTime: '2026-11-24T08:00:00.123Z', policyCompliant: true,
  hardwareInfo: { brand: 'google', model: 'Pixel 8', manufacturer: 'Google', serialNumber: 'SER123' }, softwareInfo: { androidVersion: '15' },
  // Never asked for (DEVICE_FIELDS) — and never read if a server sends them anyway.
  networkInfo: { imei: '490154203237518', meid: 'A0000000000001', wifiMacAddress: 'aa:bb:cc:dd:ee:ff', telephonyInfos: [{ phoneNumber: '+15555550100' }] },
  userName: 'enterprises/LC00abc/users/1', user: { accountIdentifier: 'alice' }, ...o,
});
let r = S.deviceRecord(dev());
let p = SC.parseDevice(r);
check(p.ok && p.value.providerDeviceId === '3f9a1b2c' && p.value.platform === 'android' && p.value.ownership === 'corporate' && p.value.managementScope === 'device'
  && p.value.enrollmentState === 'enrolled' && p.value.complianceState === 'compliant' && p.value.model === 'Pixel 8' && p.value.manufacturer === 'Google'
  && p.value.osVersion === 'Android 15' && p.value.serialNumber === 'SER123' && p.value.name === null,
  'a company-owned, fully managed device: enrolled, compliant, model, Android version and serial', J(p));
check(!/490154203237518|A0000000000001|aa:bb:cc|5555550100|alice|users\//.test(J(r)), 'no IMEI, MEID, MAC, phone number or user reaches the record', J(r));
r = S.deviceRecord(dev({ ownership: 'PERSONALLY_OWNED', managementMode: 'PROFILE_OWNER' }));
p = SC.parseDevice(r);
check(p.ok && p.value.ownership === 'byod' && p.value.managementScope === 'work_profile' && p.value.serialNumber === null, 'a work profile on a personal phone is byod, and its serial is dropped', J(p));
p = SC.parseDevice(S.deviceRecord(dev({ ownership: undefined })));
check(p.ok && p.value.ownership === 'byod' && p.value.serialNumber === null, 'ownership unspecified is byod too (the stricter keep-rule)');
check(['PROVISIONING', 'DISABLED', 'LOST', 'PREPARING_FOR_MIGRATION', 'DELETED'].map((s) => S.deviceRecord(dev({ state: s }))?.enrollmentState).join() === 'pending,enrolled,enrolled,enrolled,unenrolled',
  'device states: PROVISIONING pending; DISABLED, LOST and migration enrolled; DELETED unenrolled');
check(S.deviceRecord(dev({ state: 'DEVICE_STATE_UNSPECIFIED' })) === null && S.deviceRecord(dev({ state: 'SOMETHING_NEW' })) === null && S.deviceRecord(dev({ managementMode: 'X' })) === null
  && S.deviceRecord(dev({ name: 'enterprises/LC00abc/devices/../x' })) === null && S.deviceRecord(dev({ name: 'devices/1' })) === null && S.deviceRecord('x') === null,
  'an unknown state or mode, a bad name or a non-object is skipped');
r = S.deviceRecord(dev({ policyCompliant: false, nonComplianceDetails: [{ nonComplianceReason: 'API_LEVEL' }] }));
check(r.complianceState === 'noncompliant' && r.complianceReason === 'api level' && SC.parseDevice(r).ok, 'non-compliance carries Google\'s reason code, as words');
check(S.deviceRecord(dev({ policyCompliant: undefined })).complianceState === 'not_evaluated', 'no compliance answer is not evaluated, never compliant');
check(S.deviceRecord(dev({ softwareInfo: { androidVersion: '15; rm -rf' } })).osVersion === null, 'a version outside the charset is dropped');
check(!/networkInfo|imei|telephony|user|macAddress|memory|applicationReports|memoryEvents/i.test(S.DEVICE_FIELDS) && /hardwareInfo\(brand,model,manufacturer,serialNumber\)/.test(S.DEVICE_FIELDS),
  'the partial response asks only for the fields Rem0te keeps', S.DEVICE_FIELDS);

section('An Operation as a neutral command');
const seen = new Date('2026-11-24T09:00:00Z');
const op = (o = {}, m = {}) => ({ name: 'enterprises/LC00abc/devices/3f9a1b2c/operations/1700000000000', metadata: { type: 'LOCK', createTime: '2026-11-24T08:00:00Z', duration: '600s', ...m }, ...o });
let c = SC.parseCommand(S.operationRecord(op(), '3f9a1b2c', 'device', seen));
check(c.ok && c.value.kind === 'lock' && c.value.providerCommandId === '3f9a1b2c:1700000000000' && c.value.acceptedAt?.toISOString() === '2026-11-24T08:00:00.000Z'
  && c.value.expiresAt?.toISOString() === '2026-11-24T08:10:00.000Z' && c.value.completedAt === null && c.value.failed === null,
  'a pending LOCK: accepted at creation (Google has it), not completed, expiring after its duration', J(c));
c = SC.parseCommand(S.operationRecord(op({ done: true }), '3f9a1b2c', 'device', seen));
check(c.ok && c.value.completedAt?.getTime() === seen.getTime(), 'done without an error is completed, at the time Rem0te saw it (Google gives none)');
c = SC.parseCommand(S.operationRecord(op({ done: true, error: { code: 9, message: 'secret text' } }), '3f9a1b2c', 'device', seen));
check(c.ok && c.value.completedAt === null && c.value.failed?.code === 'android:grpc_9' && !/secret/.test(J(c)), 'an error is a failure with a code, never Google\'s message', J(c));
c = SC.parseCommand(S.operationRecord(op({ done: true }, { errorCode: 'USER_CANCELLED' }), '3f9a1b2c', 'device', seen));
check(c.ok && c.value.failed?.code === 'android:user_cancelled', 'a command error code is a failure too');
check(S.operationRecord(op({}, { type: 'WIPE' }), '3f9a1b2c', 'work_profile', seen).kind === 'remove_managed_data' && S.operationRecord(op({}, { type: 'WIPE' }), '3f9a1b2c', 'device', seen).kind === 'wipe',
  'a WIPE on a work profile removes only the work data; on a fully managed device it is a wipe');
check(['START_LOST_MODE', 'STOP_LOST_MODE', 'RELINQUISH_OWNERSHIP'].map((t) => S.operationRecord(op({}, { type: t }), 'd', 'device', seen).kind).join() === 'lost_mode_start,lost_mode_stop,retire',
  'lost mode and relinquish ownership map to 0096\'s kinds');
check(S.operationRecord(op({}, { type: 'REBOOT' }), 'd', 'device', seen) === null && S.operationRecord(op({}, { type: 'RESET_PASSWORD' }), 'd', 'device', seen) === null
  && S.operationRecord(op({ name: 'operations/x' }), 'd', 'device', seen) === null && S.operationRecord(op({}, { createTime: 'no' }), 'd', 'device', seen) === null,
  'other types, a bad name and a bad time are skipped');

section('Escaping');
const q = S.query({ callbackUrl: 'https://rmm.example.com/api/v1/mdm/android/signup/callback?state=abc_-', fields: S.DEVICE_FIELDS, x: "!'()*", none: null });
check(/^[A-Za-z0-9._~%=&-]+$/.test(q) && !q.includes('none') && q.includes('%21%27%28%29%2A'), 'every query value is fully percent-escaped (fits safe-https\'s test-query charset)', q);
check(S.enterpriseIdOf({ name: 'enterprises/LC00abc' }) === 'LC00abc' && S.enterpriseIdOf({ name: 'enterprises/../x' }) === null && S.enterpriseIdOf({}) === null, 'an enterprise name yields its id only when it fits the charset');
check(S.googleStatus({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'long text' } }) === 'PERMISSION_DENIED' && S.googleStatus({ error: 'invalid_grant', error_description: 'x' }) === 'invalid_grant'
  && S.googleStatus({ error: { status: 'not valid!' } }) === null, 'Google\'s error is kept as a short status, never its text');

section('0102 agrees with the model');
const list = (re) => (sql.match(re)?.[1] ?? '').split(',').map((s) => s.trim().replace(/'/g, ''));
check(J(list(/"AndroidSignup_state_check" CHECK \("state" IN \(([^)]*)\)\)/)) === J([...S.SIGNUP_STATES]), 'sign-up states, in order', J(list(/"AndroidSignup_state_check" CHECK \("state" IN \(([^)]*)\)\)/)));
check(J(list(/"androidTestResult" IN \(([^)]*)\)/)) === J([...SM.ANDROID_TEST_RESULTS]), 'test results, in order');
check(J(list(/"MdmConnector_provider_check" CHECK \("provider" IN \(([^)]*)\)\)/)) === J([...MODEL.PROVIDERS]) && J(list(/"MobileDevice_provider_check" CHECK \("provider" IN \(([^)]*)\)\)/)) === J([...MODEL.PROVIDERS]),
  'android in both provider CHECKs, the same list as PROVIDERS');
check(/"expiresAt" <= "createdAt" \+ interval '1 hour'/.test(sql) && /"stateSha256" ~ '\^\[0-9a-f\]\{64\}\$'/.test(sql), 'a sign-up lives at most an hour and is kept only as a SHA-256');
check(/BETWEEN 0 AND 1000000/.test(sql) && SM.ANDROID_QUOTA_MAX === 1000000, 'the quota bound agrees');

section('Capabilities');
const F0 = { pushKey: false, vendor: null, signingRoute: null, pushCert: null, appleAccount: null, androidKey: false, deviceCa: false, profileSigner: null, enrolledDevices: 0, pushProven: false };
const st = (cs) => Object.fromEntries(cs.map((x) => [x.key, x.state]));
const now = new Date();
let caps = st(SM.capabilities(F0, now));
check(['android.connection_test', 'android.quota', 'android.enterprise', 'android.enrollment'].every((k) => caps[k] === 'requires_setup'), 'nothing done: every Android step requires setup', J(caps));
caps = st(SM.capabilities({ ...F0, androidKey: true, androidTest: { result: 'permission_denied', at: now } }, now));
check(caps['android.connection_test'] === 'requires_setup', 'a failed test is not available');
const ok = SM.capabilities({ ...F0, androidKey: true, androidTest: { result: 'ok', at: now }, androidQuota: 100, androidEnterprises: 1, androidPolicies: 1, androidDevices: 0 }, now);
caps = st(ok);
check(caps['android.connection_test'] === 'available' && caps['android.quota'] === 'available' && caps['android.enterprise'] === 'available' && caps['android.enrollment'] === 'requires_setup'
  && /No device has enrolled/.test(ok.find((x) => x.key === 'android.enrollment').reason), 'tested, quota, bound, policy: enrollment is ready but requires a first device');
check(st(SM.capabilities({ ...F0, androidKey: false, androidTest: { result: 'ok', at: now } }, now))['android.connection_test'] === 'requires_setup', 'a test result without a key counts for nothing');
check(st(SM.capabilities({ ...F0, androidQuota: 0 }, now))['android.quota'] === 'requires_setup', 'a quota of zero is not available');

section('The client against a loopback stand-in');
const hits = [];
let tokenCalls = 0, expire = false;
const srv = http.createServer((req, res) => {
  let raw = ''; req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    hits.push({ method: req.method, path: u.pathname, q: Object.fromEntries(u.searchParams), auth: req.headers.authorization ?? null, body: raw });
    const send = (s, j) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(J(j)); };
    if (u.pathname === '/token') {
      tokenCalls++;
      const f = new URLSearchParams(raw);
      if (f.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:jwt-bearer' || !f.get('assertion')) return send(400, { error: 'invalid_grant' });
      return send(200, { access_token: `ya29.test-${tokenCalls}`, expires_in: 3599, token_type: 'Bearer' });
    }
    if (expire && req.headers.authorization === 'Bearer ya29.test-1') { expire = false; return send(401, { error: { code: 401, status: 'UNAUTHENTICATED' } }); }
    if (u.pathname === '/v1/enterprises' && req.method === 'GET') return send(200, { enterprises: [] });
    if (u.pathname === '/v1/enterprises/LC00abc/devices') return send(200, { devices: [dev()], nextPageToken: u.searchParams.get('pageToken') ? undefined : 'p2' });
    if (u.pathname === '/v1/enterprises/LC00abc/devices/3f9a1b2c/operations/42') return send(200, { name: 'enterprises/LC00abc/devices/3f9a1b2c/operations/42', metadata: { type: 'LOCK', createTime: '2026-11-24T08:00:00Z' }, done: true });
    if (u.pathname === '/v1/enterprises/LC00abc/devices/3f9a1b2c/operations/43') return send(200, { name: 'enterprises/LC00abc/devices/3f9a1b2c/operations/99', metadata: { type: 'LOCK', createTime: '2026-11-24T08:00:00Z' }, done: true });
    if (u.pathname === '/v1/enterprises/DENY/devices') return send(403, { error: { code: 403, status: 'PERMISSION_DENIED', message: 'Caller does not have permission' } });
    if (u.pathname === '/v1/enterprises/QUOTA/devices') return send(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED' } });
    if (u.pathname === '/v1/enterprises/BAD/devices') return send(200, { devices: 'nope' });
    return send(404, { error: { code: 404, status: 'NOT_FOUND' } });
  });
});
await new Promise((ok2) => srv.listen(0, '127.0.0.1', ok2));
const base = `http://127.0.0.1:${srv.address().port}`;
try {
  let code = null;
  try { await A.probe(cred); } catch (e) { code = e.code; }
  check(code === 'not_ready' && hits.length === 0, 'NODE_ENV=test with no stand-in: not_ready, and no request at all (Google is never the fallback)', String(code));
  process.env.AMAPI_TEST_BASE_URL = 'http://10.0.0.1:9';
  code = null; try { await A.probe(cred); } catch (e) { code = e.code; }
  check(code === 'not_ready' && hits.length === 0, 'a stand-in that is not 127.0.0.1 is refused the same way');
  process.env.AMAPI_TEST_BASE_URL = base;
  A.clearAmapiTokens();
  await A.probe(cred);
  const t = hits.find((x) => x.path === '/token'), g = hits.find((x) => x.path === '/v1/enterprises');
  const assertion = new URLSearchParams(t?.body ?? '').get('assertion') ?? '';
  const aud = JSON.parse(Buffer.from(assertion.split('.')[1] ?? '', 'base64url').toString() || '{}').aud;
  check(!!t && aud === `${base}/token` && g?.auth === 'Bearer ya29.test-1' && g.q.projectId === sa.project_id && g.q.pageSize === '1',
    'the connection test: a JWT-bearer exchange, then one enterprises.list with the access token', J(hits));
  hits.length = 0;
  const page = await A.listDevices(cred, 'LC00abc', null);
  check(tokenCalls === 1 && hits.length === 1 && hits[0].q.fields === S.DEVICE_FIELDS && hits[0].q.pageSize === '100' && page.next === 'p2' && page.devices.length === 1,
    'devices.list: the cached token (no second exchange), pageSize 100, the fields partial response, the next page token', J(hits));
  expire = true; hits.length = 0;
  await A.listDevices(cred, 'LC00abc', 'p2');
  check(tokenCalls === 2 && hits.filter((x) => x.path === '/token').length === 1 && hits.at(-1).auth === 'Bearer ya29.test-2' && hits.at(-1).q.pageToken === 'p2',
    'a 401 on a cached token drops it, exchanges once more and retries once');
  const other = JSON.parse(serviceAccountJson());
  hits.length = 0;
  await A.probe({ projectId: other.project_id, clientEmail: other.client_email, privateKeyId: other.private_key_id, key: createPrivateKey(other.private_key) });
  check(hits[0]?.path === '/token', 'another credential gets its own token (keyed by a hash of the credential)');
  const codeOf = async (f) => { try { await f(); return 'none'; } catch (e) { return `${e.code}:${e.message}`; } };
  check(await codeOf(() => A.listDevices(cred, 'DENY', null)) === 'permission_denied:permission_denied' && await codeOf(() => A.listDevices(cred, 'QUOTA', null)) === 'quota:quota'
    && await codeOf(() => A.listDevices(cred, 'BAD', null)) === 'bad_response:bad_response' && await codeOf(() => A.listDevices(cred, '../x', null)) === 'bad_response:bad_response',
    'errors are short codes: permission denied, quota, a bad answer, a bad enterprise id (refused before any request)');
  check(await A.getOperation(cred, 'LC00abc', '3f9a1b2c', '44') === null && !('listOperations' in A), 'operations.get of an Operation Google no longer has is null; there is no Operations listing (0.86, decision 30)');
  const drv = D.androidDriver({ credential: async () => cred, openCommands: async () => [{ providerCommandId: '3f9a1b2c:42', managementScope: 'device' }, { providerCommandId: '3f9a1b2c:43', managementScope: 'device' }] });
  const row = { id: 'c1', externalTenantId: 'LC00abc' };
  const dp = await drv.listDevices(row, null);
  check(drv.ready(row).ok && !drv.ready({ externalTenantId: 'rem0te.x/y' }).ok && dp.records.length === 1 && SC.parseDevice(dp.records[0]).ok && dp.next === 'p2', 'the driver: ready on an enterprise id, a page of parsable records');
  hits.length = 0;
  const cp = await drv.listCommands(row, null);
  check(cp.records.length === 1 && cp.records[0].id === '3f9a1b2c:42' && cp.next === null && hits.every((h) => h.method === 'GET' && /\/operations\/4[23]$/.test(h.path)),
    'listCommands reads each open command\'s Operation by name, and drops an answer naming another Operation', J(hits.map((h) => h.path)));
  const none = D.androidDriver({ credential: async () => null, openCommands: async () => [] });
  check((await codeOf(() => none.listDevices(row, null))).startsWith('not_ready'), 'no sealed key: the driver is not_ready before any request');
  check(!('deleteDevice' in drv) && Object.keys(A).every((k) => !/delete|wipe|cancel|relinquish|reset/i.test(k)) && J(Object.keys(A).filter((k) => /command/i.test(k))) === J(['issueCommand']),
    'no device deletion, wipe or cancel anywhere in the client; one command call, issueCommand (0.86)');
} finally {
  srv.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
