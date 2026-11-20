#!/usr/bin/env node
// The Managed Secure Access grant fixture (0.71), shared by the portal and
// the agent's verifier:
//
//   cd apps/api && npx nest build && node scripts/gen-msa-grant-fixture.mjs
//
// writes tools/windows-installer/internal/msa/testdata/msa-grants.json from
// the compiled src/msa/grant.ts. The Go tests (internal/msa/grant) and
// scripts/unit-msa-grants.mjs both assert every case's expected result, and
// the unit test also rebuilds the fixture in memory and fails if the file on
// disk differs — so the file cannot drift from the module.
//
// THE KEYS IN IT ARE TEST-ONLY. They are derived from fixed, published seeds
// and sign nothing but this fixture. No server ever loads them: the portal's
// grant key is generated at random on first use and stored sealed.

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const G = require(join(here, '..', 'dist', 'msa', 'grant.js'));
export const FIXTURE_PATH = join(here, '..', '..', '..', 'tools', 'windows-installer', 'internal', 'msa', 'testdata', 'msa-grants.json');

const seed = (label) => createHash('sha256').update(`rem0te-msa-grant TEST-ONLY fixture key: ${label}`).digest();
const keyFromSeed = (s) => createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), s]), format: 'der', type: 'pkcs8' });

export function buildFixture() {
  const priv = keyFromSeed(seed('main'));
  const other = keyFromSeed(seed('other'));
  const pubMain = G.rawPublicKey(createPublicKey(priv));
  const pubOther = G.rawPublicKey(createPublicKey(other));
  const kidMain = G.keyIdOf(pubMain);
  const kidOther = G.keyIdOf(pubOther);
  const pem = priv.export({ format: 'pem', type: 'pkcs8' }).toString();

  const ENDPOINT = 'cmtestendpoint000000000001';
  const RID = '123456789';
  const NB = '2026-11-20T12:00:00Z';
  const NA = '2026-11-20T12:05:00Z';
  const base = (over = {}) => ({
    v: 1, grantId: '0123456789abcdef0123456789abcdef', endpointId: ENDPOINT, rustdeskId: RID,
    businessId: 'cmtestbusiness000000000001', technicianId: 'cmtesttechnician0000000001',
    mode: 'view', permissions: { clipboard: false, files: false, audio: false, tunnel: false, restart: false },
    consent: 'required', notBefore: NB, notAfter: NA, maxMinutes: 60, idleMinutes: 15, password: 'Abcdefghijklmnopqrstuv12', ...over,
  });
  const ctx = (over = {}) => ({
    endpointId: ENDPOINT, rustdeskId: RID, now: '2026-11-20T12:01:00Z', seen: [], remotePaused: false,
    ceiling: { mode: 'view', permissions: { clipboard: false, files: false, audio: false, tunnel: false, restart: false } }, ...over,
  });
  const allPerms = { clipboard: true, files: true, audio: true, tunnel: true, restart: true };
  const env = (g) => JSON.stringify(G.signGrant(g, pem, kidMain));
  // Signs any bytes (for documents signGrant itself refuses to sign).
  const raw = (bytes, { key = priv, kid = kidMain, prefix = G.GRANT_PREFIX } = {}) => {
    const b = Buffer.from(bytes, 'utf8');
    return JSON.stringify({ keyId: kid, grant: b.toString('base64'), sig: sign(null, Buffer.concat([Buffer.from(prefix, 'utf8'), b]), key).toString('base64') });
  };
  const canon = (g) => G.canonicalGrant(g).toString('utf8');
  const good = JSON.parse(env(base()));
  const tamper = (fn) => JSON.stringify(fn({ ...good }));

  const cases = [
    ['a view grant inside its window', env(base()), ctx(), 'ok'],
    ['a control grant with every permission, under a control ceiling', env(base({ mode: 'control', permissions: allPerms, consent: 'not_required', maxMinutes: 480, idleMinutes: 120 })),
      ctx({ ceiling: { mode: 'control', permissions: allPerms } }), 'ok'],
    ['20 s before notBefore (inside the skew)', env(base()), ctx({ now: '2026-11-20T11:59:40Z' }), 'ok'],
    ['20 s after notAfter (inside the skew)', env(base()), ctx({ now: '2026-11-20T12:05:20Z' }), 'ok'],
    ['a one-minute window', env(base({ notAfter: '2026-11-20T12:01:00Z' })), ctx({ now: '2026-11-20T12:00:30Z' }), 'ok'],

    ['the envelope is an array', JSON.stringify([good]), ctx(), 'envelope_malformed'],
    ['the envelope is null', 'null', ctx(), 'envelope_malformed'],
    ['the envelope is a string', JSON.stringify('x'), ctx(), 'envelope_malformed'],
    ['the envelope has an extra field', tamper((e) => ({ ...e, password: 'x' })), ctx(), 'envelope_malformed'],
    ['the envelope has no signature', tamper(({ sig, ...e }) => e), ctx(), 'envelope_malformed'],
    ['the key id is not 16 hex', tamper((e) => ({ ...e, keyId: e.keyId.toUpperCase() })), ctx(), 'envelope_malformed'],
    ['the key id is a number', tamper((e) => ({ ...e, keyId: 1234 })), ctx(), 'envelope_malformed'],
    ['the grant is unpadded base64', tamper((e) => ({ ...e, grant: e.grant.replace(/=+$/, '') + (e.grant.endsWith('=') ? '' : 'A') })), ctx(), 'envelope_malformed'],
    ['the grant is base64url', tamper((e) => ({ ...e, grant: e.grant.replace(/\+/g, '-').replace(/\//g, '_') + (/[+/]/.test(e.grant) ? '' : '-') })), ctx(), 'envelope_malformed'],
    ['the signature is 63 bytes', tamper((e) => ({ ...e, sig: Buffer.from(e.sig, 'base64').subarray(0, 63).toString('base64') })), ctx(), 'envelope_malformed'],
    ['something after the envelope', `${env(base())} {}`, ctx(), 'envelope_malformed'],
    ['the grant is empty', tamper((e) => ({ ...e, grant: '' })), ctx(), 'envelope_malformed'],

    ['signed by a key the computer does not have', raw(canon(base()), { key: other, kid: kidOther }), ctx(), 'unknown_key'],
    ['another key\'s signature under the known key id', raw(canon(base()), { key: other, kid: kidMain }), ctx(), 'bad_signature'],
    ['the grant changed after signing (view → control)', tamper((e) => ({ ...e, grant: Buffer.from(Buffer.from(e.grant, 'base64').toString().replace('"view"', '"ctrl"')).toString('base64') })),
      ctx(), 'bad_signature'],
    ['signed without the prefix', raw(canon(base()), { prefix: '' }), ctx(), 'bad_signature'],
    ['signed under another prefix', raw(canon(base()), { prefix: 'rem0te-revocations-v1\n' }), ctx(), 'bad_signature'],

    ['the grant is not JSON', raw('not json'), ctx(), 'grant_malformed'],
    ['the grant is an array', raw('[1]'), ctx(), 'grant_malformed'],
    ['the grant is null', raw('null'), ctx(), 'grant_malformed'],
    ['version 2', raw(canon(base()).replace('{"v":1,', '{"v":2,')), ctx(), 'unsupported_version'],
    ['no version', raw(canon(base()).replace('{"v":1,', '{')), ctx(), 'unsupported_version'],
    ['version as a string', raw(canon(base()).replace('{"v":1,', '{"v":"1",')), ctx(), 'unsupported_version'],
    ['version spelled 1.0', raw(canon(base()).replace('{"v":1,', '{"v":1.0,')), ctx(), 'grant_malformed'],
    ['an extra field', raw(canon(base()).replace(',"password"', ',"extra":true,"password"')), ctx(), 'grant_malformed'],
    ['an extra permission', raw(canon(base()).replace('"restart":false}', '"restart":false,"keyboard":true}')), ctx(), 'grant_malformed'],
    ['a permission missing', raw(canon(base()).replace(',"restart":false}', '}')), ctx(), 'grant_malformed'],
    ['pretty-printed (not canonical)', raw(JSON.stringify(JSON.parse(canon(base())), null, 1)), ctx(), 'grant_malformed'],
    ['keys out of order (not canonical)', raw(canon(base()).replace('"endpointId":"cmtestendpoint000000000001","rustdeskId":"123456789"', '"rustdeskId":"123456789","endpointId":"cmtestendpoint000000000001"')),
      ctx(), 'grant_malformed'],
    ['a duplicate field', raw(canon(base()).replace(',"password"', ',"mode":"control","password"')), ctx(), 'grant_malformed'],
    ['an upper-case field name', raw(canon(base()).replace('"mode":', '"Mode":')), ctx(), 'grant_malformed'],
    ['a password with a space', raw(canon(base({ password: 'Abcdefghijklmnopqrstuv1 ' }))), ctx(), 'grant_malformed'],
    ['a password too short', raw(canon(base({ password: 'Abc123' }))), ctx(), 'grant_malformed'],
    ['maxMinutes 481', raw(canon(base({ maxMinutes: 481 }))), ctx(), 'grant_malformed'],
    ['maxMinutes 0', raw(canon(base({ maxMinutes: 0 }))), ctx(), 'grant_malformed'],
    ['maxMinutes spelled 60.0', raw(canon(base()).replace('"maxMinutes":60', '"maxMinutes":60.0')), ctx(), 'grant_malformed'],
    ['idleMinutes over maxMinutes', raw(canon(base({ maxMinutes: 10, idleMinutes: 11 }))), ctx(), 'grant_malformed'],
    ['an unknown mode', raw(canon(base({ mode: 'admin' }))), ctx(), 'grant_malformed'],
    ['an unknown consent', raw(canon(base({ consent: 'maybe' }))), ctx(), 'grant_malformed'],
    ['a permission as a string', raw(canon(base()).replace('"files":false', '"files":"false"')), ctx(), 'grant_malformed'],
    ['notBefore with milliseconds', raw(canon(base({ notBefore: '2026-11-20T12:00:00.000Z' }))), ctx(), 'grant_malformed'],
    ['notBefore with an offset', raw(canon(base({ notBefore: '2026-11-20T13:00:00+01:00' }))), ctx(), 'grant_malformed'],
    ['notAfter on 30 February', raw(canon(base({ notAfter: '2026-02-30T12:00:00Z' }))), ctx(), 'grant_malformed'],
    ['an endpoint id with upper case', raw(canon(base({ endpointId: 'CMTESTENDPOINT000000000001' }))), ctx({ endpointId: 'CMTESTENDPOINT000000000001' }), 'grant_malformed'],
    ['a grant id that is not 32 hex', raw(canon(base({ grantId: 'abc' }))), ctx(), 'grant_malformed'],

    ['a six-minute window', raw(canon(base({ notAfter: '2026-11-20T12:06:00Z' }))), ctx(), 'bad_window'],
    ['notAfter equal to notBefore', raw(canon(base({ notAfter: NB }))), ctx({ now: NB }), 'bad_window'],
    ['notAfter before notBefore', raw(canon(base({ notBefore: NA, notAfter: NB }))), ctx(), 'bad_window'],

    ['another computer\'s grant', env(base()), ctx({ endpointId: 'cmtestendpoint000000000002' }), 'wrong_endpoint'],
    ['another RustDesk ID', env(base()), ctx({ rustdeskId: '987654321' }), 'wrong_rustdesk_id'],
    ['the signed pause says remote', env(base()), ctx({ remotePaused: true }), 'remote_paused'],
    ['31 s before notBefore', env(base()), ctx({ now: '2026-11-20T11:59:29Z' }), 'not_yet_valid'],
    ['31 s after notAfter', env(base()), ctx({ now: '2026-11-20T12:05:31Z' }), 'expired'],
    ['a day later', env(base()), ctx({ now: '2026-11-21T12:00:00Z' }), 'expired'],
    ['already used', env(base()), ctx({ seen: ['0123456789abcdef0123456789abcdef'] }), 'replayed'],
    ['control under a view ceiling', env(base({ mode: 'control' })), ctx(), 'mode_not_allowed'],
    ['files under a ceiling without files', env(base({ permissions: { ...base().permissions, files: true } })),
      ctx({ ceiling: { mode: 'control', permissions: { ...allPerms, files: false } } }), 'permission_not_allowed'],
    ['restart under a view ceiling with no permissions', env(base({ permissions: { ...base().permissions, restart: true } })), ctx(), 'permission_not_allowed'],
  ];

  return {
    _comment: 'TEST-ONLY keys and grants, generated by apps/api/scripts/gen-msa-grant-fixture.mjs from apps/api/src/msa/grant.ts. Never load these keys anywhere else.',
    prefix: G.GRANT_PREFIX,
    reasons: [...G.REASONS],
    keys: { [kidMain]: pubMain.toString('base64') },
    cases: cases.map(([name, envelope, context, expect]) => ({ name, envelope, context, expect })),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(FIXTURE_PATH, `${JSON.stringify(buildFixture(), null, 2)}\n`);
  console.log(`wrote ${FIXTURE_PATH}`);
}
