#!/usr/bin/env node
/**
 * 0.80 Tablet: the MDM model's pure parts (src/mdm/model.ts,
 * command-state.ts, schemas.ts) and their agreement with migration 0096.
 *
 *   - the command state machine: every legal and illegal move, provider
 *     acceptance and device completion as separate facts, a completion the
 *     provider never accepted refused, final states final, restated reports
 *     changing nothing, expiry only when due;
 *   - the provider record schemas: closed lists, the platform/scope rule,
 *     a BYOD serial dropped, the IMEI and other identifiers stripped, free
 *     text cleaned and capped, pages bounded;
 *   - every closed list is 0096's CHECK, word for word;
 *   - the stand-in is test-only and loopback-only;
 *   - mobile:view is a business capability, not a default for a Business
 *     User, and no preset produces it.
 *
 * No database, no network. Needs `nest build` (dist/). The behavioural proof
 * is e2e-mdm.mjs.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..', '..');
const dist = (f) => {
  for (const base of [path.join(here, '..', 'dist'), path.join(here, '..', 'dist', 'src')]) {
    try { return require(path.join(base, f)); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
  }
  throw new Error(`dist/${f} not found: run nest build first`);
};
const M = dist('mdm/model.js');
const S = dist('mdm/command-state.js');
const P = dist('mdm/schemas.js');
const CAPS = dist('rbac/capabilities.js');
const PRESETS = dist('security-controls/presets.js');

let pass = 0; const fails = [];
const check = (name, ok, detail = '') => { if (ok) pass++; else fails.push(name); console.log(`${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `\n    ${detail}`}`); };
const read = (p) => readFileSync(path.join(root, p), 'utf8');
const J = (x) => JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));

const t = (m) => new Date(Date.UTC(2026, 10, 21, 10, m));
const T0 = t(0), T1 = t(1), T2 = t(2), T3 = t(3), T9 = t(9);

// ── The state machine ─────────────────────────────────────────────────────
console.log('\nCommand state machine');
check('six states, three of them final', J(M.COMMAND_STATES) === J(['queued', 'sent', 'acknowledged', 'completed', 'failed', 'expired']) && J(S.TERMINAL_STATES) === J(['completed', 'failed', 'expired']));
const legal = [];
for (const a of M.COMMAND_STATES) for (const b of M.COMMAND_STATES) if (S.canMove(a, b)) legal.push(`${a}>${b}`);
check('exactly nine legal moves: forward one step, or to failed/expired from a live state',
  J(legal) === J(['queued>sent', 'queued>failed', 'queued>expired', 'sent>acknowledged', 'sent>failed', 'sent>expired', 'acknowledged>completed', 'acknowledged>failed', 'acknowledged>expired']), J(legal));
check('no move out of a final state, and none backwards', ['completed', 'failed', 'expired'].every((s) => M.COMMAND_STATES.every((b) => !S.canMove(s, b))) && !S.canMove('acknowledged', 'sent') && !S.canMove('sent', 'queued'));

const q = S.queuedCommand(T9);
let r = S.apply(q, { type: 'sent', at: T0 });
check('queued → sent stamps sentAt only', r.ok && r.next.state === 'sent' && +r.next.sentAt === +T0 && r.next.providerAcceptedAt === null && r.next.deviceCompletedAt === null);
const sent = r.next;
r = S.apply(q, { type: 'provider_accepted', at: T1 });
check('a queued command cannot be accepted (not_sent)', !r.ok && r.reason === 'not_sent');
r = S.apply(sent, { type: 'device_completed', at: T2 });
check('ACCEPTANCE ≠ COMPLETION: a device completion with no provider acceptance is refused (not_accepted), never back-filled', !r.ok && r.reason === 'not_accepted');
r = S.apply(sent, { type: 'provider_accepted', at: T1 });
check('sent → acknowledged stamps providerAcceptedAt and NOT deviceCompletedAt', r.ok && r.next.state === 'acknowledged' && +r.next.providerAcceptedAt === +T1 && r.next.deviceCompletedAt === null);
const ack = r.next;
const prog = S.commandProgress(ack);
check('an acknowledged command reads "accepted by the provider, waiting for the device"', prog.providerAccepted.done && !prog.deviceCompleted.done && prog.waitingFor === 'device', J(prog));
r = S.apply(ack, { type: 'provider_rejected', at: T2, code: 'nope' });
check('once accepted, the provider can no longer reject it (already_accepted)', !r.ok && r.reason === 'already_accepted');
r = S.apply(ack, { type: 'device_completed', at: T2 });
check('acknowledged → completed stamps deviceCompletedAt and keeps providerAcceptedAt', r.ok && r.next.state === 'completed' && +r.next.providerAcceptedAt === +T1 && +r.next.deviceCompletedAt === +T2);
const done = r.next;
const pd = S.commandProgress(done);
check('a completed command shows both facts, with their own times', pd.providerAccepted.done && pd.deviceCompleted.done && +pd.providerAccepted.at === +T1 && +pd.deviceCompleted.at === +T2 && pd.waitingFor === null);
r = S.apply(done, { type: 'device_completed', at: T3 });
check('a restated completion changes nothing (idempotent)', r.ok && !r.changed && +r.next.deviceCompletedAt === +T2);
for (const e of [{ type: 'device_failed', at: T3, code: 'x' }, { type: 'expired', at: T9 }, { type: 'provider_rejected', at: T3, code: 'x' }]) {
  r = S.apply(done, e);
  check(`completed is final: ${e.type} is refused`, !r.ok && r.reason === 'terminal', J(r));
}
r = S.apply(sent, { type: 'provider_rejected', at: T1, code: 'unsupported_kind' });
check('a provider rejection fails a sent command with provider_rejected:<code> and no acceptance', r.ok && r.next.state === 'failed' && r.next.failureCode === 'provider_rejected:unsupported_kind' && r.next.providerAcceptedAt === null && +r.next.failedAt === +T1);
r = S.apply(ack, { type: 'device_failed', at: T2, code: 'passcode_required' });
check('a device failure keeps the acceptance and records device:<code>', r.ok && r.next.state === 'failed' && r.next.failureCode === 'device:passcode_required' && +r.next.providerAcceptedAt === +T1 && r.next.deviceCompletedAt === null);
r = S.apply(sent, { type: 'device_failed', at: T2, code: 'x' });
check('a device cannot fail what the provider never accepted', !r.ok && r.reason === 'not_accepted');
r = S.apply(sent, { type: 'provider_rejected', at: T1, code: 'Bad Code!' });
check('failure codes are charset-checked', !r.ok && r.reason === 'bad_code');
r = S.apply(sent, { type: 'expired', at: T3 });
check('expiry before the deadline is refused (not_due)', !r.ok && r.reason === 'not_due');
r = S.apply(ack, { type: 'expired', at: T9 });
check('an accepted command the device never finished expires at its deadline, acceptance kept', r.ok && r.next.state === 'expired' && +r.next.expiredAt === +T9 && +r.next.providerAcceptedAt === +T1 && r.next.deviceCompletedAt === null);
r = S.apply(sent, { type: 'sent', at: T3 });
check('a restated send changes nothing', r.ok && !r.changed && +r.next.sentAt === +T0);
r = S.apply(sent, { type: 'provider_accepted', at: new Date('x') });
check('an invalid time is refused', !r.ok && r.reason === 'bad_time');

console.log('\nReconciling a provider report');
const obs = S.observedCommand(T0, T9);
check('a command first seen in a report starts as sent', obs.state === 'sent' && +obs.sentAt === +T0);
let rc = S.reconcile(obs, { acceptedAt: T1, rejected: null, completedAt: null, failed: null });
check('report: accepted only → acknowledged', rc.next.state === 'acknowledged' && rc.changed && rc.refused === null);
rc = S.reconcile(rc.next, { acceptedAt: T1, rejected: null, completedAt: null, failed: null });
check('the same report again changes nothing', !rc.changed && rc.next.state === 'acknowledged');
rc = S.reconcile(obs, { acceptedAt: T1, rejected: null, completedAt: T2, failed: null });
check('report: accepted and completed → completed, both stamped', rc.next.state === 'completed' && +rc.next.providerAcceptedAt === +T1 && +rc.next.deviceCompletedAt === +T2);
rc = S.reconcile(obs, { acceptedAt: null, rejected: null, completedAt: T2, failed: null });
check('report: completed WITHOUT accepted → refused (not_accepted), the command stays sent', rc.refused === 'not_accepted' && rc.next.state === 'sent' && rc.next.deviceCompletedAt === null);
const fin = S.reconcile(obs, { acceptedAt: T1, rejected: null, completedAt: T2, failed: null }).next;
rc = S.reconcile(fin, { acceptedAt: T1, rejected: null, completedAt: null, failed: { at: T3, code: 'x' } });
check('a final command is left as it is, whatever a later report says', !rc.changed && rc.next.state === 'completed' && rc.refused === null);
const ex = S.expireIfDue(S.observedCommand(T0, T2), T3);
check('expireIfDue expires an overdue sent command, and leaves a final one', ex.changed && ex.next.state === 'expired' && !S.expireIfDue(fin, T9).changed);
check('eventsFromReport orders rejection, acceptance, completion, failure',
  J(S.eventsFromReport({ acceptedAt: T1, rejected: { at: T0, code: 'a' }, completedAt: T2, failed: { at: T3, code: 'b' } }).map((e) => e.type)) === J(['provider_rejected', 'provider_accepted', 'device_completed', 'device_failed']));

// ── Provider records ──────────────────────────────────────────────────────
console.log('\nProvider record schemas');
const base = {
  id: 'dev-1', name: 'Front desk iPad', platform: 'ipados', ownership: 'corporate', managementScope: 'device', enrollmentState: 'enrolled',
  enrolledAt: '2026-01-02T03:04:05Z', complianceState: 'compliant', complianceReason: 'ignored when compliant', model: 'iPad (10th generation)', manufacturer: 'Apple',
  osVersion: '18.1', serialNumber: 'dmpxk12abcd', imei: '356938035643809', phoneNumber: '+15555550100', wifiMac: 'aa:bb:cc:dd:ee:ff', userPrincipalName: 'someone@example.com',
  storageTotalBytes: 64e9, storageFreeBytes: 20e9, lastCheckInAt: '2026-11-21T09:00:00Z',
};
let d = P.parseDevice(base);
check('a corporate device parses; its serial is kept (upper-cased)', d.ok && d.value.serialNumber === 'DMPXK12ABCD' && d.value.platform === 'ipados', J(d));
check('the IMEI, phone number, MAC and user are never in the record', d.ok && !/356938035643809|5555550100|aa:bb|someone@/.test(J(d.value)) && !('imei' in d.value), J(d.value));
check('a compliance reason is dropped when the device is compliant', d.ok && d.value.complianceReason === null);
check('storage arrives as BigInt', d.ok && typeof d.value.storageTotalBytes === 'bigint' && d.value.storageFreeBytes === 20000000000n);
d = P.parseDevice({ ...base, ownership: 'byod', platform: 'ios', managementScope: 'user_enrollment' });
check('a personal (BYOD) device\'s serial is dropped', d.ok && d.value.serialNumber === null && d.value.ownership === 'byod');
d = P.parseDevice({ ...base, platform: 'android', managementScope: 'user_enrollment' });
check('User Enrollment on Android is refused (scope_platform)', !d.ok && d.reason === 'scope_platform');
d = P.parseDevice({ ...base, platform: 'ios', managementScope: 'work_profile' });
check('a work profile on iOS is refused', !d.ok);
d = P.parseDevice({ ...base, platform: 'android', ownership: 'byod', managementScope: 'work_profile', complianceState: 'noncompliant', complianceReason: 'Screen lock\u0000 missing‮  \n now' });
check('an Android work profile parses, and the reason has control characters removed', d.ok && d.value.complianceReason === 'Screen lock missing now', J(d));
for (const [k, v] of [['platform', 'windows'], ['ownership', 'shared'], ['enrollmentState', 'not_reported'], ['complianceState', 'green'], ['id', 'has space'], ['osVersion', '18;rm -rf'], ['storageFreeBytes', -1], ['lastCheckInAt', 'yesterday']]) {
  d = P.parseDevice({ ...base, [k]: v });
  check(`refused: ${k}=${J(v)}`, !d.ok);
}
d = P.parseDevice({ ...base, storageTotalBytes: 10, storageFreeBytes: 11 });
check('more free storage than total is refused', !d.ok && d.reason === 'storage');
d = P.parseDevice({ ...base, name: 'x'.repeat(150), model: 'y'.repeat(300) });
check('long text is capped (name 100, model 100)', d.ok && d.value.name.length === 100 && d.value.model.length === 100);
d = P.parseDevice({ ...base, serialNumber: 'bad serial!' });
check('a serial outside the charset is dropped, not stored', d.ok && d.value.serialNumber === null);

const cmd = { id: 'cmd-1', deviceId: 'dev-1', kind: 'lock', requestedAt: '2026-11-21T10:00:00Z', acceptedAt: '2026-11-21T10:00:05Z', completedAt: null };
let c = P.parseCommand(cmd);
check('a command report parses into acceptance and completion separately', c.ok && c.value.acceptedAt instanceof Date && c.value.completedAt === null && c.value.rejected === null);
c = P.parseCommand({ ...cmd, kind: 'factory_reset' });
check('an unknown command kind is refused', !c.ok);
c = P.parseCommand({ ...cmd, failedAt: '2026-11-21T10:01:00Z' });
check('a failure time without its code is refused', !c.ok);
c = P.parseCommand({ ...cmd, rejectCode: 'x' });
check('a rejection code without its time is refused', !c.ok);
check('a page holds at most 100 records and a charset-checked cursor',
  P.PAGE_MAX === 100 && P.DevicePage.safeParse({ devices: new Array(101).fill({}), next: null }).success === false
  && P.DevicePage.safeParse({ devices: [], next: 'a b' }).success === false && P.CommandPage.safeParse({ commands: [], next: 'p2' }).success === true);

// ── 0096 agrees ───────────────────────────────────────────────────────────
console.log('\nMigration 0096 agrees with model.ts');
const sql = read('apps/api/prisma/migrations/0096_mobile_devices/migration.sql');
// 0.84: 0101 re-makes the two provider CHECKs with `apple`; 0.85: 0102 again with `android`. The newest definition is the one in force.
const sql101 = read('apps/api/prisma/migrations/0102_mdm_android/migration.sql');
const inList = (name, col) => {
  const m = (/_provider_check$/.test(name) ? sql101 : sql).match(new RegExp(`CONSTRAINT "${name}" CHECK \\("${col}" (?:IS NULL OR "${col}" )?IN \\(([^)]*)\\)`));
  return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : null;
};
for (const [name, col, list] of [
  ['MdmConnector_provider_check', 'provider', M.PROVIDERS], ['MobileDevice_provider_check', 'provider', M.PROVIDERS],
  ['MobileDevice_platform_check', 'platform', M.PLATFORMS], ['MobileDevice_ownership_check', 'ownership', M.OWNERSHIPS],
  ['MobileDevice_managementScope_check', 'managementScope', M.MANAGEMENT_SCOPES], ['MobileDevice_enrollmentState_check', 'enrollmentState', M.ENROLLMENT_STATES],
  ['MobileDevice_complianceState_check', 'complianceState', M.COMPLIANCE_STATES], ['MdmCommand_kind_check', 'kind', M.COMMAND_KINDS],
  ['MdmCommand_origin_check', 'origin', M.COMMAND_ORIGINS], ['MdmCommand_state_check', 'state', M.COMMAND_STATES],
  ['MdmConnector_lastSyncResult_check', 'lastSyncResult', M.SYNC_RESULTS],
]) {
  const got = inList(name, col);
  check(`${name} is ${list.length} values, model.ts's, in order`, J(got) === J([...list]), J(got));
}
check('0096 keeps a device completion only with a provider acceptance, on a completed command',
  /\("deviceCompletedAt" IS NULL OR \("providerAcceptedAt" IS NOT NULL AND "state" = 'completed'\)\)/.test(sql)
  && /\("state" <> 'acknowledged' OR \("providerAcceptedAt" IS NOT NULL AND "deviceCompletedAt" IS NULL\)\)/.test(sql)
  && /CREATE TRIGGER "MdmCommand_final_trg" BEFORE UPDATE/.test(sql));
check('0096 keeps a serial only for a corporate device', /"serialNumber" IS NULL OR \("ownership" = 'corporate'/.test(sql));
check('0096 holds one business through connector, device and command (three triggers)',
  ['MdmConnector_business_trg', 'MobileDevice_business_trg', 'MdmCommand_business_trg'].every((n) => new RegExp(`CREATE TRIGGER "${n}" BEFORE INSERT OR UPDATE`).test(sql)));
check('the destructive kinds are retire, remove_managed_data and wipe', J(M.DESTRUCTIVE_KINDS) === J(['retire', 'remove_managed_data', 'wipe']));

// ── The stand-in and the capability ───────────────────────────────────────
console.log('\nStand-in and capability');
const prev = { NODE_ENV: process.env.NODE_ENV, MDM_TEST_BASE_URL: process.env.MDM_TEST_BASE_URL };
const SI = dist('mdm/drivers/standin.js');
const row = { externalTenantId: 'tenant-a' };
process.env.NODE_ENV = 'test'; process.env.MDM_TEST_BASE_URL = 'http://127.0.0.1:4022';
check('stand-in: ready under NODE_ENV=test with a loopback URL', SI.standinDriver.ready(row).ok === true && SI.standinBase() === 'http://127.0.0.1:4022');
process.env.MDM_TEST_BASE_URL = 'https://mdm.example.com';
check('stand-in: a public https URL is refused even under test', SI.standinBase() === null && SI.standinDriver.ready(row).ok === false);
process.env.MDM_TEST_BASE_URL = 'http://localhost:4022';
check('stand-in: localhost by name is refused (127.0.0.1 only)', SI.standinBase() === null);
process.env.NODE_ENV = 'production'; process.env.MDM_TEST_BASE_URL = 'http://127.0.0.1:4022';
check('stand-in: not ready outside NODE_ENV=test, and a listing throws not_ready before any request', SI.standinBase() === null && !SI.standinDriver.ready(row).ok);
let threw = null;
try { await SI.standinDriver.listDevices(row, null); } catch (e) { threw = e.code; }
check('stand-in: listDevices outside test throws not_ready (no request is made)', threw === 'not_ready', String(threw));
process.env.NODE_ENV = 'test';
check('stand-in: an invalid tenant id is not ready', !SI.standinDriver.ready({ externalTenantId: '../x' }).ok);
for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }

check('mobile:view is a business capability (CAP), not platform-only', CAPS.CAP.MOBILE_VIEW === 'mobile:view' && CAPS.ALL_BUSINESS_CAPABILITIES.includes('mobile:view') && !CAPS.PLATFORM_ONLY_CAPABILITIES.includes('mobile:view'));
check('a Business Owner holds it; a new Business User does not', CAPS.effectiveCapabilities({ roleType: 'BUSINESS_OWNER' }).includes('mobile:view') && !CAPS.DEFAULT_BUSINESS_USER_CAPABILITIES.includes('mobile:view'));
check('no legacy role translates to it', Object.values(CAPS.LEGACY_ROLE_CAPABILITIES).every((l) => !l.includes('mobile:view')));
const all = { inventoryView: 'allowed', supportRequests: 'allowed', eventLogs: 'allowed' };
check('no technician preset produces it', !PRESETS.presetCapabilities(all).includes('mobile:view'));
check('a technician assignment may carry it (not users:manage)', CAPS.TECHNICIAN_ASSIGNABLE_CAPABILITIES.includes('mobile:view'));
check('the web knows the same key', /MOBILE_VIEW: 'mobile:view'/.test(read('apps/web/lib/auth.ts')));

console.log(`\nunit-mdm: ${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.error(`  ✗ ${f}`); process.exit(1); }
