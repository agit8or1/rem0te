#!/usr/bin/env node
/**
 * 0.84 Harbor: Rem0te's own Apple MDM server, the pure parts (§93).
 *
 *   - plist: parse and build round trip; DOCTYPE/entity, depth, size and
 *     unknown-tag refusals; a BOM; binary plists refused;
 *   - cms: a detached Mdm-Signature made by openssl verifies under the device
 *     CA; refused when the body changed, the signer is not under the CA, the
 *     certificate is expired, a CA or not for client auth, the signature is
 *     attached, there are two signers, or it is not CMS; BER is accepted;
 *   - the signed profile: an attached SignedData that openssl verifies, with
 *     the MDM payload's fixed AccessRights (erase granted, decision 25), SignMessage and the
 *     production APNs; never a PKCS#12 payload; SCEP refused outside test;
 *   - the protocol: check-in messages read from named keys only (no
 *     UnlockToken, no user channel), reports, error codes, the inventory
 *     facts kept, the five command bodies, the platforms and OS floor;
 *   - APNs: the body is exactly {"mdm": magic}; status and reason mapped;
 *     the test stub only on https://127.0.0.1 under NODE_ENV=test;
 *   - the driver's records pass the sync's own parsers; Apple's states map
 *     onto accepted / completed / failed / rejected without collapsing them;
 *   - checkDeviceCa / checkProfileSigner; 0101's CHECKs are the lists.
 *
 * Every certificate is a TEST ONLY stand-in made here. Needs `nest build`
 * (dist/) and openssl on PATH. No database, no network.
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { generateKeyPairSync, X509Certificate } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { P, issue, rsaKey, testCa } from './lib/test-pki.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..', '..');
const dist = (f) => {
  for (const base of [path.join(here, '..', 'dist'), path.join(here, '..', 'dist', 'src')]) {
    try { return require(path.join(base, f)); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
  }
  throw new Error(`dist/${f} not found`);
};
const PL = dist('mdm/apple/plist.js');
const CMS = dist('mdm/apple/cms.js');
const PR = dist('mdm/apple/protocol.js');
const PF = dist('mdm/apple/profile.js');
const AP = dist('mdm/apple/apns.js');
const H2 = dist('common/safe-h2.js');
const DR = dist('mdm/drivers/apple.js');
const SC = dist('mdm/schemas.js');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); } };
const throws = (fn) => { try { fn(); return false; } catch { return true; } };
const DAY = 86_400_000;
const now = new Date();
const tmp = mkdtempSync(path.join(tmpdir(), 'unit-mdm-apple-'));
const f = (name, data) => { const p = path.join(tmp, name); writeFileSync(p, data); return p; };
const openssl = (...args) => execFileSync('openssl', args, { stdio: ['ignore', 'pipe', 'pipe'] });

try {
  // ── plist ──────────────────────────────────────────────────────────────
  console.log('\nplist');
  const tree = { S: 'a<b>&c', I: 42, B: true, F: false, D: new Uint8Array([1, 2, 3]), A: [1, 'x', { k: 'v' }], N: { deep: { er: 'ok' } } };
  const xml = PL.buildPlist(tree);
  const back = PL.parsePlist(xml);
  ok('build → parse round-trips strings (escaped), integers, booleans, data, arrays and dicts',
    back.S === 'a<b>&c' && Number(back.I) === 42 && back.B === true && back.F === false && Buffer.from(back.D).equals(Buffer.from([1, 2, 3]))
      && back.A.length === 3 && back.A[2].k === 'v' && back.N.deep.er === 'ok', xml.slice(0, 120));
  ok('the header is Apple\'s exact DTD identifier', xml.startsWith(PL.PLIST_HEADER));
  ok('a leading BOM is accepted', PL.parsePlist('﻿' + xml).S === 'a<b>&c');
  ok('an internal DTD subset or entity is refused (no XXE, no billion laughs)',
    throws(() => PL.parsePlist('<?xml version="1.0"?><!DOCTYPE plist [<!ENTITY x "y">]><plist><dict><key>a</key><string>&x;</string></dict></plist>')));
  ok('an unknown entity is refused', throws(() => PL.parsePlist('<plist><dict><key>a</key><string>&foo;</string></dict></plist>')));
  ok('an unknown tag is refused', throws(() => PL.parsePlist('<plist><dict><key>a</key><script>x</script></dict></plist>')));
  ok('a binary plist is refused (XML only)', throws(() => PL.parsePlist(Buffer.from('bplist00\x00\x01'))));
  let deep = '<string>x</string>'; for (let i = 0; i < PL.PLIST_MAX_DEPTH + 2; i++) deep = `<array>${deep}</array>`;
  ok('nesting beyond PLIST_MAX_DEPTH is refused', throws(() => PL.parsePlist(`<plist><dict><key>a</key>${deep}</dict></plist>`)));
  ok('a string beyond PLIST_MAX_STRING is refused', throws(() => PL.parsePlist(`<plist><dict><key>a</key><string>${'x'.repeat(PL.PLIST_MAX_STRING + 1)}</string></dict></plist>`)));
  ok('a root that is not a dict is refused by parsePlist', throws(() => PL.parsePlist('<plist><array/></plist>')));
  ok('a duplicate key is refused', throws(() => PL.parsePlist('<plist><dict><key>a</key><true/><key>a</key><false/></dict></plist>')));

  // ── stand-in device PKI (TEST ONLY) ─────────────────────────────────────
  const ca = testCa('TEST Rem0te device CA (stand-in)', now);
  const other = testCa('TEST Some other CA (stand-in)', now);
  const devKey = rsaKey();
  const devName = [{ type: 'CN', value: 'TEST device' }];
  const dev = issue({ issuer: ca, subject: devName, publicKey: devKey, notBefore: new Date(now.getTime() - DAY), notAfter: new Date(now.getTime() + 30 * DAY) });
  const stray = issue({ issuer: other, subject: devName, publicKey: devKey, notBefore: new Date(now.getTime() - DAY), notAfter: new Date(now.getTime() + 30 * DAY) });
  const old = issue({ issuer: ca, subject: devName, publicKey: devKey, notBefore: new Date(now.getTime() - 60 * DAY), notAfter: new Date(now.getTime() - DAY) });
  const caLeaf = issue({ issuer: ca, subject: devName, publicKey: devKey, notBefore: new Date(now.getTime() - DAY), notAfter: new Date(now.getTime() + 30 * DAY), ca: true });
  const keyP = f('dev.key', devKey.export({ type: 'pkcs8', format: 'pem' }));
  const trust = { roots: [ca.cert], intermediates: [] };
  const body = Buffer.from(PL.buildPlist({ MessageType: 'Authenticate', UDID: '0000FE00-1234567890ABCDEF', Topic: 'com.apple.mgmt.External.test' }));
  const bodyP = f('body.plist', body);
  const sigWith = (cert, extra = [], name = 'sig.der') => {
    const out = path.join(tmp, name);
    openssl('cms', '-sign', '-binary', '-noattr', '-in', bodyP, '-signer', f(`${name}.crt`, P.certPem(cert)), '-inkey', keyP, '-outform', 'DER', '-out', out, ...extra);
    return readFileSync(out);
  };

  console.log('\ncms (Mdm-Signature)');
  const good = sigWith(dev);
  const v = CMS.verifyDetachedCms(good, body, trust, now);
  ok('a detached signature over the exact body verifies under the device CA, naming the signer, its SHA-256 and the digest (recorded per device, decision 28)',
    v.ok && v.signer.raw.equals(dev.raw) && /^[0-9a-f]{64}$/.test(v.signerSha256) && PR.SIGNATURE_DIGESTS.includes(v.digest), JSON.stringify(v.ok ? v.signerSha256 : v));
  const withAttrs = path.join(tmp, 'attrs.der');
  openssl('cms', '-sign', '-binary', '-in', bodyP, '-signer', f('dev2.crt', P.certPem(dev)), '-inkey', keyP, '-outform', 'DER', '-out', withAttrs);
  ok('signed attributes (content type + message digest) are checked and accepted', CMS.verifyDetachedCms(readFileSync(withAttrs), body, trust, now).ok);
  const r = (sig, b = body, t = trust, at = now) => { const x = CMS.verifyDetachedCms(sig, b, t, at); return x.ok ? 'ok' : x.reason; };
  ok('a changed body is refused (bad_signature)', r(good, Buffer.concat([body, Buffer.from(' ')])) === 'bad_signature');
  ok('a changed body with signed attributes is refused (digest_mismatch)', r(readFileSync(withAttrs), Buffer.concat([body, Buffer.from(' ')])) === 'digest_mismatch');
  ok('a signer under another CA is refused (untrusted)', r(sigWith(stray, [], 'stray.der')) === 'untrusted');
  ok('an expired device certificate is refused', r(sigWith(old, [], 'old.der')) === 'certificate_expired');
  ok('a CA certificate as signer is refused', r(sigWith(caLeaf, [], 'caleaf.der')) === 'certificate_is_ca');
  ok('no trusted root at all is refused', r(good, body, { roots: [], intermediates: [] }) === 'untrusted');
  ok('a time before the certificate is refused', r(good, body, trust, new Date(now.getTime() - 3 * DAY)) === 'certificate_not_yet_valid');
  const attached = path.join(tmp, 'attached.der');
  openssl('cms', '-sign', '-binary', '-nodetach', '-noattr', '-in', bodyP, '-signer', f('dev3.crt', P.certPem(dev)), '-inkey', keyP, '-outform', 'DER', '-out', attached);
  ok('an attached signature is refused (not_detached)', r(readFileSync(attached)) === 'not_detached');
  ok('garbage, empty and oversized input are refused (malformed)', r(Buffer.from('not cms')) === 'malformed' && r(Buffer.alloc(0)) === 'malformed' && r(Buffer.alloc(CMS.MAX_CMS_BYTES + 1, 0x30)) === 'malformed');
  const two = path.join(tmp, 'two.der');
  openssl('cms', '-sign', '-binary', '-noattr', '-in', bodyP, '-signer', f('dev4.crt', P.certPem(dev)), '-inkey', keyP, '-signer', f('stray2.crt', P.certPem(stray)), '-inkey', keyP, '-outform', 'DER', '-out', two);
  ok('two signers are refused (signer_count)', r(readFileSync(two)) === 'signer_count');
  // BER: devices send indefinite lengths. Re-wrap the DER's ContentInfo, [0] and SignedData in indefinite form.
  const indef = (node, inner) => Buffer.concat([Buffer.from([node.tag, 0x80]), inner, Buffer.from([0, 0])]);
  const ciN = P.derRead(good);
  const [ctN, wrapN] = P.derChildren(ciN);
  const sdN = P.derChildren(wrapN)[0];
  const sdBer = indef(sdN, Buffer.concat(P.derChildren(sdN).map((n) => P.derRaw(n))));
  const berBuf = indef(ciN, Buffer.concat([P.derRaw(ctN), indef(wrapN, sdBer)]));
  ok('BER with indefinite lengths (as devices send) is converted to DER and verified', berBuf[1] === 0x80 && CMS.berToDer(berBuf).equals(good) && r(berBuf) === 'ok', r(berBuf));
  ok('unterminated BER is refused', r(berBuf.subarray(0, berBuf.length - 2)) === 'malformed');
  ok('berToDer leaves DER unchanged', CMS.berToDer(good).equals(good));

  // ── the profile ─────────────────────────────────────────────────────────
  console.log('\nprofile');
  const signerKey = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
  const signerCert = issue({ issuer: ca, subject: [{ type: 'CN', value: 'TEST profile signer' }], publicKey: signerKey, notBefore: new Date(now.getTime() - DAY), notAfter: new Date(now.getTime() + 300 * DAY) });
  const linkId = 'ael' + '0123456789abcdef012345';
  const acme = { kind: 'acme', directoryUrl: 'https://portal.example.com/acme/rem0te-mdm/directory', clientIdentifier: 'x'.repeat(43) };
  const built = PF.buildProfile({ linkId, base: 'https://portal.example.com', topic: 'com.apple.mgmt.External.test', identity: acme, organization: 'Example Business' });
  const prof = PL.parsePlist(built.plist);
  const [idp, mdmp] = prof.PayloadContent;
  ok('two payloads: an ACME identity (hardware-bound, attested, P-384) and com.apple.mdm', idp.PayloadType === 'com.apple.security.acme' && idp.HardwareBound === true && idp.Attest === true
    && idp.KeyType === 'ECSECPrimeRandom' && Number(idp.KeySize) === 384 && mdmp.PayloadType === 'com.apple.mdm');
  ok(`AccessRights is ${PR.ACCESS_RIGHTS} = 1+4+8+16+256+1024: erase granted (decision 25), no profile install (2), no app install (4096)`,
    Number(mdmp.AccessRights) === 1309 && PR.ACCESS_RIGHTS === 1309 && (1309 & 8) === 8 && (1309 & 2) === 0 && (1309 & 4096) === 0);
  ok('erase is granted but unsendable: no erase or wipe request type', !PR.REQUEST_TYPES.some((t) => /Erase|Wipe|Lock|Clear/i.test(t)) && !PR.isRequestType('EraseDevice'));
  ok('SignMessage, CheckOutWhenRemoved, production APNs, the identity named by UUID, the check-in URL carries the link id',
    mdmp.SignMessage === true && mdmp.CheckOutWhenRemoved === true && mdmp.UseDevelopmentAPNS === false && mdmp.IdentityCertificateUUID === idp.PayloadUUID
      && mdmp.CheckInURL === `https://portal.example.com/api/v1/mdm/apple/checkin?enroll=${linkId}` && mdmp.ServerURL === 'https://portal.example.com/api/v1/mdm/apple/server');
  ok('no PKCS#12 payload, no password, no key', !/pkcs12|Password|PRIVATE KEY/i.test(built.plist));
  ok('payload UUIDs are stable for one link and differ between links',
    PF.buildProfile({ linkId, base: 'https://p', topic: 'com.apple.mgmt.External.test', identity: acme, organization: 'x' }).plist.includes(idp.PayloadUUID)
      && !PF.buildProfile({ linkId: 'ael' + 'f'.repeat(22), base: 'https://p', topic: 'com.apple.mgmt.External.test', identity: acme, organization: 'x' }).plist.includes(idp.PayloadUUID));
  const signed = PF.signProfile(built.plist, { cert: signerCert, key: signerKey, chain: [ca.cert] }, now);
  const signedP = f('profile.der', signed);
  const caP = f('ca.pem', ca.pem);
  let verifiedOut = '';
  try { verifiedOut = openssl('cms', '-verify', '-inform', 'DER', '-in', signedP, '-CAfile', caP, '-purpose', 'any').toString('utf8'); } catch (e) { verifiedOut = `ERR ${e.stderr}`; }
  ok('the signed profile is an attached SignedData that openssl verifies under its chain, carrying the exact plist', verifiedOut === built.plist, verifiedOut.slice(0, 80));
  const prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  ok('a SCEP identity is refused outside NODE_ENV=test', throws(() => PF.scepTestIdentity('http://127.0.0.1:4064/scep/rem0te-mdm-test', 'challenge-123')));
  process.env.NODE_ENV = 'test';
  ok('under NODE_ENV=test, SCEP only on 127.0.0.1', !throws(() => PF.scepTestIdentity('http://127.0.0.1:4064/scep/rem0te-mdm-test', 'challenge-123'))
    && throws(() => PF.scepTestIdentity('http://10.0.0.1:4064/scep/x', 'challenge-123')) && throws(() => PF.scepTestIdentity('https://ca.example.com/scep/x', 'challenge-123')));
  process.env.NODE_ENV = prevEnv;

  // ── the protocol ────────────────────────────────────────────────────────
  console.log('\nprotocol');
  const UDID = '00008030-001A2B3C4D5E6F70';
  const TOPIC = 'com.apple.mgmt.External.0a1b2c3d';
  const auth = PR.readCheckin({ MessageType: 'Authenticate', UDID, Topic: TOPIC, ProductName: 'iPhone15,2', OSVersion: '17.5.1', BuildVersion: '21F90', SerialNumber: 'f2lxyz12abcd', DeviceName: 'Front desk', IMEI: '35 123456 789012 3', MEID: '351234567890123' });
  ok('Authenticate: the named facts only; serial normalised; IMEI and MEID never copied out',
    auth.type === 'Authenticate' && auth.facts.serialNumber === 'F2LXYZ12ABCD' && auth.facts.productName === 'iPhone15,2' && !JSON.stringify(auth).includes('35123') && !JSON.stringify(auth).includes('IMEI'), JSON.stringify(auth));
  const tu = PR.readCheckin({ MessageType: 'TokenUpdate', UDID, Topic: TOPIC, Token: new Uint8Array(32).fill(0xab), PushMagic: 'ABCDEF01-2345-6789-ABCD-EF0123456789', UnlockToken: new Uint8Array(64).fill(1) });
  ok('TokenUpdate: the token as hex and PushMagic; the UnlockToken is not read', tu.type === 'TokenUpdate' && tu.pushToken === 'ab'.repeat(32) && !('unlockToken' in tu) && !JSON.stringify(tu).includes('0101'), JSON.stringify(tu));
  ok('CheckOut', PR.readCheckin({ MessageType: 'CheckOut', UDID, Topic: TOPIC }).type === 'CheckOut');
  ok('User Enrollment (EnrollmentID / UserID) is refused: M8', PR.readCheckin({ MessageType: 'TokenUpdate', EnrollmentID: 'x', Topic: TOPIC }).why === 'user_channel'
    && PR.readCheckin({ MessageType: 'TokenUpdate', UDID, UserID: 'u', Topic: TOPIC, Token: new Uint8Array(32), PushMagic: 'm' }).why === 'user_channel');
  ok('other message types are unsupported, bad ones invalid', PR.readCheckin({ MessageType: 'DeclarativeManagement', UDID, Topic: TOPIC }).type === 'unsupported'
    && PR.readCheckin({ MessageType: 'Auth<x>', UDID, Topic: TOPIC }).type === 'invalid' && PR.readCheckin({ MessageType: 'Authenticate', UDID: 'nope', Topic: TOPIC }).why === 'udid'
    && PR.readCheckin({ MessageType: 'Authenticate', UDID, Topic: 'com.example.other' }).why === 'topic');
  ok('a TokenUpdate without a valid token or magic is invalid', PR.readCheckin({ MessageType: 'TokenUpdate', UDID, Topic: TOPIC, Token: 'abc', PushMagic: 'x' }).why === 'token'
    && PR.readCheckin({ MessageType: 'TokenUpdate', UDID, Topic: TOPIC, Token: new Uint8Array(32), PushMagic: 'a b' }).why === 'push_magic');
  const CU = 'A1B2C3D4-E5F6-4711-8899-AABBCCDDEEFF';
  ok('reports: Idle; Acknowledged with its UUID; Error keeps only domain:code, never the description',
    PR.readReport({ UDID, Status: 'Idle' }).status === 'Idle' && PR.readReport({ UDID, Status: 'Acknowledged', CommandUUID: CU }).commandUuid === CU
      && PR.readReport({ UDID, Status: 'Error', CommandUUID: CU, ErrorChain: [{ ErrorCode: 12021, ErrorDomain: 'MCMDMErrorDomain', LocalizedDescription: 'secret text' }] }).errorCode === 'apple:mcmdmerrordomain:12021'
      && PR.readReport({ UDID, Status: 'Bogus' }).status === 'invalid' && PR.readReport({ UDID, Status: 'Acknowledged' }).why === 'command_uuid');
  ok('the command bodies are fixed per type, in the closed order', JSON.stringify(PR.REQUEST_TYPES) === JSON.stringify(['DeviceInformation', 'SecurityInfo', 'InstalledApplicationList', 'ProfileList', 'CertificateList'])
    && PR.REQUEST_TYPES.every((t) => PR.commandFor(t).RequestType === t) && PR.commandFor('DeviceInformation').Queries.length === PR.DEVICE_INFO_QUERIES.length
    && !PR.DEVICE_INFO_QUERIES.some((q) => /IMEI|MEID|Phone|MAC|ICCID|UDID|EASDeviceIdentifier|Bluetooth/i.test(q)), JSON.stringify(PR.DEVICE_INFO_QUERIES));
  ok('isRequestType accepts exactly the five', PR.REQUEST_TYPES.every(PR.isRequestType) && !PR.isRequestType('EraseDevice') && !PR.isRequestType('DeviceLock'));
  const inv = PR.inventoryFrom('DeviceInformation', { QueryResponses: { DeviceName: 'Front desk', ModelName: 'iPhone', ProductName: 'iPhone15,2', OSVersion: '17.5.1', DeviceCapacity: 128, AvailableDeviceCapacity: '64.5', IsSupervised: false, IMEI: 'x' } });
  ok('DeviceInformation keeps the named facts; capacity in decimal GB; free above total is dropped',
    inv.deviceName === 'Front desk' && inv.storageTotalBytes === 128_000_000_000n && inv.storageFreeBytes === 64_500_000_000n && inv.supervised === false && !('imei' in inv)
      && PR.inventoryFrom('DeviceInformation', { QueryResponses: { DeviceCapacity: 10, AvailableDeviceCapacity: 20 } }).storageFreeBytes === null, JSON.stringify(inv, (k, x) => (typeof x === 'bigint' ? String(x) : x)));
  ok('the other four keep only counts and two passcode booleans',
    PR.inventoryFrom('SecurityInfo', { SecurityInfo: { PasscodePresent: true, PasscodeCompliant: false, HardwareEncryptionCaps: 3 } }).passcodeCompliant === false
      && PR.inventoryFrom('InstalledApplicationList', { InstalledApplicationList: [{}, {}, {}] }).appCount === 3
      && PR.inventoryFrom('ProfileList', { ProfileList: [{}] }).profileCount === 1 && PR.inventoryFrom('CertificateList', { CertificateList: [] }).certificateCount === 0);
  ok('platforms: iPhone/iPod → ios, iPad → ipados, a Mac or Watch → none', PR.platformOf('iPhone15,2') === 'ios' && PR.platformOf('iPad13,1') === 'ipados'
    && PR.platformOf('Mac14,2') === null && PR.platformOf('Watch6,1') === null);

  // ── APNs ────────────────────────────────────────────────────────────────
  console.log('\napns');
  ok('the body is exactly {"mdm": PushMagic}', AP.pushBody('ABC-123') === '{"mdm":"ABC-123"}');
  ok('the origin is Apple\'s production host, a constant', AP.APNS_ORIGIN === 'https://api.push.apple.com');
  const cls = (s, rr) => AP.classify(s, rr).result;
  ok('410 / Unregistered → unregistered; BadDeviceToken → bad_token; topic errors → topic_refused; 403 → certificate_refused; 429 / 5xx → retry',
    cls(410, null) === 'unregistered' && cls(400, 'BadDeviceToken') === 'bad_token' && cls(400, 'DeviceTokenNotForTopic') === 'bad_token' && cls(400, 'TopicDisallowed') === 'topic_refused'
      && cls(403, 'BadCertificate') === 'certificate_refused' && cls(429, 'TooManyRequests') === 'retry' && cls(503, null) === 'retry' && cls(400, 'PayloadEmpty') === 'refused');
  process.env.NODE_ENV = 'production';
  process.env.APNS_TEST_BASE_URL = 'https://127.0.0.1:4062';
  ok('outside NODE_ENV=test the stub is ignored and the origin is Apple\'s', AP.apnsTarget().origin === AP.APNS_ORIGIN && !H2.testLoopbackH2Allowed('https://127.0.0.1:4062'));
  process.env.NODE_ENV = 'test';
  ok('under NODE_ENV=test only https://127.0.0.1:<port>', AP.apnsTarget().origin === 'https://127.0.0.1:4062' && !H2.testLoopbackH2Allowed('http://127.0.0.1:4062')
    && !H2.testLoopbackH2Allowed('https://localhost:4062') && !H2.testLoopbackH2Allowed('https://10.0.0.1:4062'));
  delete process.env.APNS_TEST_BASE_URL;
  process.env.NODE_ENV = prevEnv;

  // ── the driver ──────────────────────────────────────────────────────────
  console.log('\ndriver');
  const t0 = new Date(now.getTime() - 3600_000);
  const deviceRow = { id: 'adv1', deviceName: 'Front desk', platform: 'ios', state: 'enrolled', enrolledAt: t0, modelName: 'iPhone', productName: 'iPhone15,2', osVersion: '17.5.1', serialNumber: 'F2LXYZ12ABCD', storageTotalBytes: 128_000_000_000n, storageFreeBytes: 64_000_000_000n, lastSeenAt: now };
  const pd = SC.parseDevice(DR.deviceRecord(deviceRow));
  ok('an enrolled device passes the sync\'s own parseDevice: corporate, device scope, Apple, serial kept', pd.ok && pd.value.ownership === 'corporate' && pd.value.enrollmentState === 'enrolled' && pd.value.serialNumber === 'F2LXYZ12ABCD', JSON.stringify(pd, (k, x) => (typeof x === 'bigint' ? String(x) : x)));
  ok('a checked-out device is unenrolled; an authenticated one pending', SC.parseDevice(DR.deviceRecord({ ...deviceRow, state: 'checked_out' })).value.enrollmentState === 'unenrolled'
    && SC.parseDevice(DR.deviceRecord({ ...deviceRow, state: 'authenticated', enrolledAt: null })).value.enrollmentState === 'pending');
  const cmd = (o) => SC.parseCommand(DR.commandRecord({ id: 'acm1', appleDeviceId: 'adv1', queuedAt: t0, expiresAt: new Date(t0.getTime() + 7 * DAY), sentAt: null, respondedAt: null, state: 'queued', errorCode: null, ...o }));
  const ack = cmd({ state: 'acknowledged', sentAt: new Date(t0.getTime() + 1000), respondedAt: new Date(t0.getTime() + 2000) });
  const err = cmd({ state: 'error', sentAt: new Date(t0.getTime() + 1000), respondedAt: new Date(t0.getTime() + 2000), errorCode: 'apple:mcmdmerrordomain:12021' });
  const sent = cmd({ state: 'sent', sentAt: new Date(t0.getTime() + 1000) });
  const cancelled = cmd({ state: 'cancelled' });
  ok('accepted is not completed: sent → accepted only; acknowledged → accepted and completed; error → failed with its code; cancelled before sending → rejected',
    sent.ok && sent.value.acceptedAt && !sent.value.completedAt && ack.ok && ack.value.acceptedAt && ack.value.completedAt
      && err.ok && err.value.failed?.code === 'apple:mcmdmerrordomain:12021' && !err.value.completedAt && cancelled.ok && cancelled.value.rejected?.code === 'cancelled' && !cancelled.value.acceptedAt,
    JSON.stringify({ sent, ack, err, cancelled }).slice(0, 400));
  ok('every Apple command is the sync kind', ack.value.kind === 'sync');

  // ── setup checks ────────────────────────────────────────────────────────
  console.log('\nsetup (step 6)');
  const mid = issue({ issuer: ca, subject: [{ type: 'CN', value: 'TEST intermediate' }], publicKey: rsaKey(), notBefore: new Date(now.getTime() - DAY), notAfter: new Date(now.getTime() + 300 * DAY), ca: true });
  ok('checkDeviceCa: a self-signed root with an intermediate it issued is accepted', P.checkDeviceCa({ root: ca.pem, intermediates: P.certPem(mid) }, now).ok);
  ok('checkDeviceCa: a leaf as root, garbage, a broken chain and four intermediates are refused',
    P.checkDeviceCa({ root: P.certPem(dev) }, now).code === 'CA_NOT_ROOT' && P.checkDeviceCa({ root: 'nope' }, now).code === 'CA_UNREADABLE'
      && P.checkDeviceCa({ root: ca.pem, intermediates: other.pem }, now).code === 'CA_CHAIN_BROKEN'
      && P.checkDeviceCa({ root: ca.pem, intermediates: P.certPem(mid).repeat(4) }, now).code === 'CA_TOO_LONG');
  const sp = P.checkProfileSigner({ certificate: P.certPem(signerCert), privateKey: signerKey.export({ type: 'sec1', format: 'pem' }), chain: ca.pem }, now);
  ok('checkProfileSigner: a matching EC key is accepted and handed back as PKCS#8', sp.ok && /BEGIN PRIVATE KEY/.test(sp.keyPem));
  const encPem = signerKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'test-pass' });
  ok('checkProfileSigner: an encrypted key needs its passphrase; a wrong key, a CA and an expired certificate are refused',
    P.checkProfileSigner({ certificate: P.certPem(signerCert), privateKey: encPem }, now).code === 'SIGNER_KEY_ENCRYPTED'
      && P.checkProfileSigner({ certificate: P.certPem(signerCert), privateKey: encPem, passphrase: 'test-pass' }, now).ok
      && P.checkProfileSigner({ certificate: P.certPem(signerCert), privateKey: devKey.export({ type: 'pkcs8', format: 'pem' }) }, now).code === 'SIGNER_KEY_MISMATCH'
      && P.checkProfileSigner({ certificate: P.certPem(caLeaf), privateKey: devKey.export({ type: 'pkcs8', format: 'pem' }) }, now).code === 'SIGNER_IS_CA'
      && P.checkProfileSigner({ certificate: P.certPem(old), privateKey: devKey.export({ type: 'pkcs8', format: 'pem' }) }, now).code === 'SIGNER_EXPIRED');

  // ── 0101 ────────────────────────────────────────────────────────────────
  console.log('\n0101');
  const sql = readFileSync(path.join(root, 'apps/api/prisma/migrations/0101_mdm_apple/migration.sql'), 'utf8');
  const chk = (c, col) => { const m = sql.match(new RegExp(`CONSTRAINT "${c}" CHECK \\("${col}" IN \\(([^)]*)\\)`)); return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : null; };
  ok('request types, command, device and link states are the module\'s lists, in order',
    JSON.stringify(chk('AppleCommand_requestType_check', 'requestType')) === JSON.stringify(PR.REQUEST_TYPES)
      && JSON.stringify(chk('AppleCommand_state_check', 'state')) === JSON.stringify(PR.APPLE_COMMAND_STATES)
      && JSON.stringify(chk('AppleDevice_state_check', 'state')) === JSON.stringify(PR.APPLE_DEVICE_STATES)
      && JSON.stringify(chk('AppleEnrollmentLink_state_check', 'state')) === JSON.stringify(PR.LINK_STATES));
  const dg = sql.match(/CONSTRAINT "AppleDevice_signatureDigest_check" CHECK \("signatureDigest" IN \(([^)]*)\)\)/);
  ok('the signature digest CHECK is SIGNATURE_DIGESTS, in order', !!dg && JSON.stringify([...dg[1].matchAll(/'([^']+)'/g)].map((x) => x[1])) === JSON.stringify(PR.SIGNATURE_DIGESTS));
  ok('the provider CHECKs name exactly standin and apple', (sql.match(/"provider" IN \('standin', 'apple'\)/g) ?? []).length === 2);
  const s = new X509Certificate(signerCert.raw);
  ok('(stand-ins are TEST ONLY)', /TEST/.test(s.subject) && /TEST/.test(ca.cert.subject));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
