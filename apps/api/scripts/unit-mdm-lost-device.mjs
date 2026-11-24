#!/usr/bin/env node
/**
 * 0.86 Lighthouse: lost-device commands (docs/own-mdm.md M4, invariant §95),
 * the pure parts and both drivers' send(), and their agreement with
 * migration 0103.
 *
 *   - lost-device.ts: exactly three kinds, in order; the request's checks
 *     (a bounded printable message, a phone number in a small charset, lost
 *     mode needing one, stop taking none) refuse rather than trim; the
 *     device's refusals (enrolled, connector enabled, Apple lost mode only
 *     when supervised and never on a user enrollment, Android lost mode
 *     never on a personal device, no message where none is shown);
 *   - Apple (protocol.ts): the eight request types, the lost-device bodies
 *     carrying only a checked Message and PhoneNumber; no erase;
 *   - Android (shape.ts): devices.issueCommand bodies for LOCK,
 *     START_LOST_MODE and STOP_LOST_MODE only; the returned Operation as
 *     Rem0te's `<device>:<operation>` id and back;
 *   - the drivers' send(): the Apple queue's refusals as send codes, and
 *     the Android client against an in-process loopback stand-in;
 *   - the command state machine for a portal command: sent, accepted and
 *     completed as three facts;
 *   - 0103's CHECKs are the modules' lists, in order; mobile:act is no
 *     default; mdm.act defaults to off.
 *
 * No database. Never reaches Apple or Google. Needs `nest build` (dist/).
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createPrivateKey } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
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
const L = dist('mdm/lost-device.js');
const PR = dist('mdm/apple/protocol.js');
const S = dist('mdm/drivers/android/shape.js');
const A = dist('mdm/drivers/android/amapi.js');
const DA = dist('mdm/drivers/android/index.js');
const DP = dist('mdm/drivers/apple.js');
const DRV = dist('mdm/driver.js');
const CS = dist('mdm/command-state.js');
const MODEL = dist('mdm/model.js');
const CAPS = dist('rbac/capabilities.js');
const CONF = dist('security-controls/confirm-catalog.js');
const sql = readFileSync(path.join(root, 'apps/api/prisma/migrations/0103_mdm_lost_device/migration.sql'), 'utf8');

let pass = 0, fail = 0;
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${n}${d ? `\n      ${d}` : ''}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const J = JSON.stringify;

section('lost-device.ts: the kinds and the request');
check(J(L.LOST_DEVICE_KINDS) === J(['lock', 'lost_mode_start', 'lost_mode_stop']) && L.LOST_DEVICE_KINDS.every((k) => MODEL.COMMAND_KINDS.includes(k) && !MODEL.DESTRUCTIVE_KINDS.includes(k)),
  'exactly lock, start and stop lost mode: model kinds, none destructive');
check(L.LOST_COMMAND_TTL_MS === 7 * 24 * 3_600_000 && L.MESSAGE_MAX === 160, 'a command waits seven days; a message is at most 160 characters');
const P = (b) => L.parseLostDeviceRequest(b);
const codes = [
  [{ kind: 'wipe' }, 'MOBILE_COMMAND_INVALID'], [{ kind: 'erase' }, 'MOBILE_COMMAND_INVALID'], [null, 'MOBILE_COMMAND_INVALID'], [['lock'], 'MOBILE_COMMAND_INVALID'],
  [{ kind: 'lock', message: 5 }, 'MOBILE_COMMAND_INVALID'], [{ kind: 'lock', message: 'x'.repeat(161) }, 'MOBILE_MESSAGE_INVALID'],
  [{ kind: 'lock', message: 'a\u0007b' }, 'MOBILE_MESSAGE_INVALID'], [{ kind: 'lock', message: 'call \u202Eme' }, 'MOBILE_MESSAGE_INVALID'],
  [{ kind: 'lock', phoneNumber: 'ring me' }, 'MOBILE_PHONE_INVALID'], [{ kind: 'lock', phoneNumber: '12' }, 'MOBILE_PHONE_INVALID'], [{ kind: 'lock', phoneNumber: '-555' }, 'MOBILE_PHONE_INVALID'],
  [{ kind: 'lost_mode_stop', message: 'hi' }, 'MOBILE_MESSAGE_NOT_TAKEN'], [{ kind: 'lost_mode_start' }, 'MOBILE_MESSAGE_REQUIRED'], [{ kind: 'lost_mode_start', message: '   ' }, 'MOBILE_MESSAGE_REQUIRED'],
];
const out = codes.map(([b, c]) => { const r = P(b); return r.ok ? `${J(b)}:ok` : r.code === c ? 'ok' : `${J(b)}:${r.code}`; });
check(out.every((x) => x === 'ok'), 'unknown kinds, non-text, long, control and bidi messages, bad phone numbers, text on stop and lost mode without text are refused', out.join(' '));
const good = P({ kind: 'lost_mode_start', message: '  Found?\n Call  me ', phoneNumber: '+44 (20) 7946-0000' });
check(good.ok && good.value.message === 'Found? Call me' && good.value.phoneNumber === '+44 (20) 7946-0000', 'whitespace is collapsed, nothing else is changed', J(good));
check(P({ kind: 'lock', message: 'a\u2028b' }).value?.message === 'a b' && P({ kind: 'lock', message: '', phoneNumber: null }).ok && P({ kind: 'lock' }).value.message === null, 'blank is absent; a line separator is whitespace and collapses');
check(L.takesMessage('lock', 'apple') && !L.takesMessage('lock', 'android') && L.takesMessage('lost_mode_start', 'android') && !L.takesMessage('lost_mode_stop', 'apple'),
  'a message is shown for an Apple lock and lost mode, not an Android lock or stopping');

section('lost-device.ts: which device can take what');
const F = { provider: 'apple', platform: 'ios', ownership: 'corporate', managementScope: 'device', enrollmentState: 'enrolled', supervised: true, connectorEnabled: true };
const R = (k, f, req) => L.lostDeviceRefusal(k, { ...F, ...f }, req)?.code ?? null;
check(R('lock', {}) === null && R('lost_mode_start', {}) === null && R('lost_mode_stop', {}) === null, 'a supervised, enrolled iPhone takes all three');
check(R('lock', { supervised: false }) === null && R('lost_mode_start', { supervised: false }) === 'LOST_MODE_NEEDS_SUPERVISION' && R('lost_mode_stop', { supervised: null }) === 'LOST_MODE_NEEDS_SUPERVISION',
  'unsupervised or unknown: lock only; lost mode is refused, never sent to find out');
check(L.lostDeviceRefusal('lost_mode_start', { ...F, supervised: false }).message !== L.lostDeviceRefusal('lost_mode_start', { ...F, supervised: null }).message, 'not supervised and not reported say different things');
check(R('lost_mode_start', { managementScope: 'work_profile' }) === 'LOST_MODE_UNAVAILABLE', 'Apple lost mode is never offered outside device enrollment');
const An = { provider: 'android', platform: 'android', supervised: null };
check(R('lock', { ...An, ownership: 'byod', managementScope: 'work_profile' }) === null && R('lost_mode_start', { ...An, ownership: 'byod', managementScope: 'work_profile' }) === 'LOST_MODE_NOT_ON_PERSONAL'
  && R('lost_mode_start', { ...An, ownership: 'unknown' }) === 'LOST_MODE_NOT_ON_PERSONAL' && R('lost_mode_start', { ...An }) === null && R('lost_mode_start', { ...An, managementScope: 'work_profile' }) === null,
  'Android: lock everywhere; lost mode on company-owned devices only (fully managed or a company-owned work profile)');
check(R('lock', { ...An }, { message: 'x', phoneNumber: null }) === 'MOBILE_MESSAGE_NOT_TAKEN' && R('lock', {}, { message: 'x', phoneNumber: null }) === null, 'a message on an Android lock is refused, not dropped');
check(R('lock', { enrollmentState: 'unenrolled' }) === 'MOBILE_DEVICE_NOT_ENROLLED' && R('lock', { enrollmentState: 'not_reported' }) === 'MOBILE_DEVICE_NOT_ENROLLED'
  && R('lock', { connectorEnabled: false }) === 'MOBILE_CONNECTOR_DISABLED' && R('lock', { provider: 'standin' }) === 'MOBILE_COMMAND_UNSUPPORTED',
  'not enrolled, a disabled connector and the read-only stand-in are refused');
const opts = L.lostDeviceOptions({ ...F, supervised: false });
check(J(opts.map((o) => [o.kind, o.available, o.code])) === J([['lock', true, null], ['lost_mode_start', false, 'LOST_MODE_NEEDS_SUPERVISION'], ['lost_mode_stop', false, 'LOST_MODE_NEEDS_SUPERVISION']]) && opts.every((o) => o.label),
  'the options the console shows agree with the refusals');

section('Apple: the request types and bodies');
check(J(PR.REQUEST_TYPES) === J([...PR.INVENTORY_TYPES, ...PR.LOST_TYPES]) && J(PR.LOST_TYPES) === J(['DeviceLock', 'EnableLostMode', 'DisableLostMode'])
  && !PR.REQUEST_TYPES.some((t) => /Erase|Wipe|Clear|RemoveProfile|Restart|ShutDown/i.test(t)), 'the five inventory commands then the three lost-device ones; no erase');
check(J(Object.values(PR.LOST_TYPE_KIND)) === J(L.LOST_DEVICE_KINDS) && J(DP.APPLE_LOST_TYPE) === J({ lock: 'DeviceLock', lost_mode_start: 'EnableLostMode', lost_mode_stop: 'DisableLostMode' }), 'kind ↔ request type, both ways');
check(J(PR.commandFor('DeviceLock', { message: 'Hi', phoneNumber: '+1 555 0100' })) === J({ RequestType: 'DeviceLock', Message: 'Hi', PhoneNumber: '+1 555 0100' })
  && J(PR.commandFor('DeviceLock')) === J({ RequestType: 'DeviceLock' }) && J(PR.commandFor('EnableLostMode', { message: null, phoneNumber: '+1 555 0100' })) === J({ RequestType: 'EnableLostMode', PhoneNumber: '+1 555 0100' })
  && J(PR.commandFor('DisableLostMode', { message: 'ignored', phoneNumber: '+1 555 0100' })) === J({ RequestType: 'DisableLostMode' }),
  'DeviceLock and EnableLostMode carry only what was given; DisableLostMode carries nothing');
check(J(PR.commandFor('DeviceLock', { message: 'a\u0007', phoneNumber: 'evil' })) === J({ RequestType: 'DeviceLock' }) && J(PR.commandFor('DeviceLock', { message: 'x'.repeat(161), phoneNumber: null })) === J({ RequestType: 'DeviceLock' }),
  'the queue checks the text again: a control character, a bad number or a long message is never put on a device');
check(J(PR.inventoryFrom('DeviceLock', { QueryResponses: { DeviceName: 'x' } })) === '{}', 'a lost-device Acknowledged changes no inventory');

section('Android: devices.issueCommand bodies and the Operation id');
check(J(S.ANDROID_COMMAND_TYPES) === J({ lock: 'LOCK', lost_mode_start: 'START_LOST_MODE', lost_mode_stop: 'STOP_LOST_MODE' }), 'LOCK, START_LOST_MODE, STOP_LOST_MODE, and nothing else');
const nt = { message: null, phoneNumber: null };
check(J(S.commandBody('lock', nt, 604800)) === J({ type: 'LOCK', duration: '604800s' }) && J(S.commandBody('lost_mode_stop', nt, 600)) === J({ type: 'STOP_LOST_MODE', duration: '600s', stopLostModeParams: {} }),
  'lock and stop: the type and how long to wait');
check(J(S.commandBody('lost_mode_start', { message: 'Hi', phoneNumber: '+1 555 0100' }, 3600)) === J({ type: 'START_LOST_MODE', duration: '3600s', startLostModeParams: { lostMessage: { defaultMessage: 'Hi' }, lostPhoneNumber: { defaultMessage: '+1 555 0100' } } }),
  'start: the message and phone number as UserFacingMessages');
check(S.commandBody('lost_mode_start', nt, 3600) === null && S.commandBody('lost_mode_start', { message: 'a\u202E', phoneNumber: 'x' }, 3600) === null && S.commandBody('wipe', nt, 3600) === null
  && S.commandBody('WIPE', nt, 3600) === null && S.commandBody('lock', nt, 59) === null && S.commandBody('lock', nt, 31 * 86400) === null && S.commandBody('lock', nt, 1.5) === null,
  'no body (so nothing is sent) for text that fails the check, another kind, or a wait outside one minute to thirty days');
const op = { name: 'enterprises/LC00abc/devices/3f9a1b2c/operations/1700000000001', metadata: { type: 'LOCK', createTime: '2026-11-24T08:00:00Z' } };
check(J(S.issuedOperation(op, '3f9a1b2c')) === J({ providerCommandId: '3f9a1b2c:1700000000001', createdAt: '2026-11-24T08:00:00Z' }) && S.issuedOperation(op, 'other') === null
  && S.issuedOperation({ name: 'enterprises/LC00abc/devices/3f9a1b2c' }, '3f9a1b2c') === null && S.issuedOperation('x', '3f9a1b2c') === null,
  'the Operation becomes <device>:<operation> only when it is on that device');
check(J(S.operationIdsOf('3f9a1b2c:1700000000001')) === J({ deviceId: '3f9a1b2c', operationId: '1700000000001' }) && S.operationIdsOf('nocolon') === null && S.operationIdsOf(':1') === null
  && S.operationIdsOf('a/b:1') === null, 'and back, refusing anything that could leave the device path');

section('The drivers\' send()');
const dev = { providerDeviceId: 'apl1' };
const appleRow = { customerId: 'b1', externalTenantId: 'rem0te' };
const cmd = (kind, extra = {}) => ({ ref: 'mcabc', kind, message: null, phoneNumber: null, expiresAt: new Date(Date.now() + 7 * 86400_000), ...extra });
const seen = [];
const appleWith = (outcome) => DP.appleDriver({ queueLostDevice: async (q) => { seen.push(q); return outcome; } });
const sendCode = async (drv, row, d, c) => { try { await drv.send(row, d, c); return 'ok'; } catch (e) { return e instanceof DRV.MdmSendError ? e.code : `other:${e.message}`; } };
const okSend = await appleWith({ ok: true }).send(appleRow, dev, cmd('lost_mode_start', { message: 'Hi' }));
check(J(okSend) === J({ providerCommandId: 'mcabc', acceptedAt: null }) && seen[0].type === 'EnableLostMode' && seen[0].id === 'mcabc' && seen[0].appleDeviceId === 'apl1' && seen[0].text.message === 'Hi',
  'Apple: queued under Rem0te\'s own id; not accepted until the device fetches it', J(seen[0]));
check(await sendCode(appleWith({ ok: false, code: 'not_supervised' }), appleRow, dev, cmd('lost_mode_start')) === 'unsupported'
  && await sendCode(appleWith({ ok: false, code: 'not_enrolled' }), appleRow, dev, cmd('lock')) === 'refused' && await sendCode(appleWith({ ok: false, code: 'conflict' }), appleRow, dev, cmd('lock')) === 'conflict',
  'the queue\'s refusals: not supervised → unsupported, not enrolled → refused, a duplicate → conflict');
const standin = dist('mdm/drivers/standin.js');
const si = Object.values(standin).find((v) => typeof v === 'object' && v?.provider === 'standin') ?? (typeof standin.standinDriver === 'function' ? standin.standinDriver() : null);
check(!si || await sendCode(si, {}, dev, cmd('lock')) === 'unsupported', 'the read-only stand-in sends nothing');

const hits = [];
let failNext = 0;
const srv = http.createServer((req, res) => {
  let raw = ''; req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    hits.push({ method: req.method, path: u.pathname, body: raw });
    const send = (s, j) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(J(j)); };
    if (u.pathname === '/token') return send(200, { access_token: 'ya29.test-1', expires_in: 3599, token_type: 'Bearer' });
    const m = u.pathname.match(/^\/v1\/enterprises\/LC00abc\/devices\/([A-Za-z0-9]+):issueCommand$/);
    if (m && req.method === 'POST') {
      if (failNext) { const s = failNext; failNext = 0; return send(s, { error: { code: s, message: 'internal detail' } }); }
      if (m[1] === 'wrongdev') return send(200, { name: 'enterprises/LC00abc/devices/someoneelse/operations/1', metadata: {} });
      return send(200, { name: `enterprises/LC00abc/devices/${m[1]}/operations/1700000000009`, metadata: { type: JSON.parse(raw).type, createTime: '2026-11-24T09:00:00Z' } });
    }
    return send(404, { error: { code: 404 } });
  });
});
await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
try {
  process.env.AMAPI_TEST_BASE_URL = `http://127.0.0.1:${srv.address().port}`;
  const sa = JSON.parse(serviceAccountJson());
  const cred = { projectId: sa.project_id, clientEmail: sa.client_email, privateKeyId: sa.private_key_id, key: createPrivateKey(sa.private_key) };
  const drv = DA.androidDriver({ credential: async () => cred, openCommands: async () => [] });
  const row = { id: 'c1', externalTenantId: 'LC00abc' };
  const r = await drv.send(row, { providerDeviceId: 'and1' }, cmd('lock'));
  const issued = hits.find((h) => h.path.endsWith(':issueCommand'));
  check(J(r) === J({ providerCommandId: 'and1:1700000000009', acceptedAt: new Date('2026-11-24T09:00:00Z') }) && issued?.method === 'POST' && J(JSON.parse(issued.body)) === J({ type: 'LOCK', duration: `${JSON.parse(issued.body).duration.replace(/s$/, '')}s` })
    && Math.abs(Number(JSON.parse(issued.body).duration.replace(/s$/, '')) - 604800) <= 2, 'Android: one devices.issueCommand; the Operation is the id and Google\'s acceptance', J({ r, issued }));
  const codesA = [];
  for (const s of [400, 403, 404, 409, 429, 503]) { failNext = s; codesA.push(await sendCode(drv, row, { providerDeviceId: 'and1' }, cmd('lock'))); }
  check(J(codesA) === J(['refused', 'refused', 'refused', 'conflict', 'quota', 'unreachable']), 'Google\'s refusals as short codes, never its text', J(codesA));
  check(await sendCode(drv, row, { providerDeviceId: 'wrongdev' }, cmd('lock')) === 'bad_response', 'an Operation on another device is a bad answer, not a success');
  const before = hits.length;
  check(await sendCode(drv, row, { providerDeviceId: '../x' }, cmd('lock')) === 'bad_response' && await sendCode(drv, row, { providerDeviceId: 'and1' }, cmd('lost_mode_start')) === 'bad_response'
    && await sendCode(drv, row, { providerDeviceId: 'and1' }, cmd('wipe')) === 'bad_response' && hits.length === before,
    'a bad device id, lost mode without text and an unknown kind are refused before any request');
  const noKey = DA.androidDriver({ credential: async () => null, openCommands: async () => [] });
  check(await sendCode(noKey, row, { providerDeviceId: 'and1' }, cmd('lock')) === 'not_ready', 'no sealed key: not_ready');
} finally {
  srv.close();
  delete process.env.AMAPI_TEST_BASE_URL;
}

section('The state machine: a portal command');
const t0 = new Date('2026-11-24T10:00:00Z'), t1 = new Date('2026-11-24T10:00:01Z'), t2 = new Date('2026-11-24T10:05:00Z');
let f = CS.queuedCommand(new Date(t0.getTime() + L.LOST_COMMAND_TTL_MS));
const step = (ev) => { const s = CS.apply(f, ev); if (!s.ok) throw new Error(`${ev.type}: ${s.code ?? J(s)}`); f = s.next; return f; };
step({ type: 'sent', at: t1 });
check(f.state === 'sent' && !f.providerAcceptedAt, 'sent is not accepted');
step({ type: 'provider_accepted', at: t1 });
check(f.state === 'acknowledged' && f.providerAcceptedAt && !f.deviceCompletedAt && CS.commandProgress(f).waitingFor === 'device', 'accepted is not completed');
const early = CS.apply(CS.queuedCommand(new Date(t2.getTime() + 1000)), { type: 'device_completed', at: t2 });
check(!early.ok, 'a completion without an acceptance is refused (never back-filled)', J(early));

section('0103, the capability and the confirmation');
const inList = (re) => { const m = sql.match(re); return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : null; };
check(J(inList(/CONSTRAINT "AppleCommand_requestType_check" CHECK \("requestType" IN \(([^)]*)\)\)/)) === J(PR.REQUEST_TYPES), 'the Apple request-type CHECK is REQUEST_TYPES, in order');
check(J(inList(/"kind" IN \(([^)]*)\)\)\)/)) === J(L.LOST_DEVICE_KINDS), 'a portal command is one of LOST_DEVICE_KINDS, in order');
check(sql.includes(`"lockPhone" ~ '${L.PHONE_RE.source}'`) && sql.includes(`BETWEEN 1 AND ${L.MESSAGE_MAX}`) && /"requestType" IN \('DeviceLock', 'EnableLostMode'\) AND "state" IN \('queued', 'sent'\)/.test(sql),
  'the text rules agree: the phone pattern, 160 characters, only on an open DeviceLock or EnableLostMode');
check(/WHERE "origin" = 'portal' AND "state" IN \('queued', 'sent'\)/.test(sql) && /NEW\."lockMessage" := NULL;/.test(sql), 'one open portal command of a kind per device; final clears the text');
check(!/Erase|Wipe|RemoveProfile|'wipe'|'retire'/.test(sql.replace(/^--.*$/gm, '')), 'no erase, wipe or retire anywhere in 0103\'s statements');
check(CAPS.CAP.MOBILE_ACT === 'mobile:act' && !CAPS.DEFAULT_BUSINESS_USER_CAPABILITIES.includes('mobile:act'), 'mobile:act exists and is not a Business User default');
const ca = CONF.CONFIRM_CATALOG.find((c) => c.key === 'mdm.act');
check(ca?.default === 'off' && CONF.CONFIRM_KEYS.includes('mdm.act'), 'the confirmation key mdm.act exists and defaults to off (§62)');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
