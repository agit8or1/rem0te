#!/usr/bin/env node
/**
 * 0.83 Beacon: Settings → Mobile devices, the pure parts
 * (src/mdm/setup/pki.ts and setup-model.ts) and their agreement with
 * migration 0100. Every key and certificate is made here, at run time, by
 * lib/test-pki.mjs (TEST ONLY stand-ins, never a real Apple or Google one).
 *
 *   - the push CSR: a valid PKCS#10, SHA256withRSA, verifying against its
 *     own key, carrying that key and no other;
 *   - a push certificate matched to the key; its topic extracted from the
 *     subject UID; refused when the key differs, when expired, when not yet
 *     valid, when it has no push topic, when it is not one certificate;
 *   - the vendor certificate: key match, expiry, a chain that connects,
 *     refused when broken, incomplete, mismatched, encrypted without a
 *     passphrase; the signed PushCertRequest verifies under the vendor key
 *     and carries the CSR and the chain in Apple's order;
 *   - the Google service-account key: the right shape accepted and rebuilt
 *     from known fields only; every wrong field refused;
 *   - reminders at 30, 14 and 3 days and on expiry, once each; the topic
 *     rule; the four states; 0100's CHECKs are the model's lists.
 *
 * No database, no network. Needs `nest build` (dist/).
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createPrivateKey, createPublicKey, verify } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { P, issue, pushCertFor, rsaKey, serviceAccountJson, testCa, testChain, testTopic } from './lib/test-pki.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..', '..');
const dist = (f) => {
  for (const base of [path.join(here, '..', 'dist'), path.join(here, '..', 'dist', 'src')]) {
    try { return require(path.join(base, f)); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
  }
  throw new Error(`dist/${f} not found`);
};
const M = dist('mdm/setup/setup-model.js');

let pass = 0, fail = 0;
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const DAY = 86_400_000;
const now = new Date();

section('The push key and its CSR');
const g = P.generatePushKey();
const key = createPrivateKey(g.keyPem);
const csr = P.readCsr(g.csrPem);
check(/^-----BEGIN PRIVATE KEY-----/.test(g.keyPem) && key.asymmetricKeyType === 'rsa' && key.asymmetricKeyDetails.modulusLength === 2048, 'an RSA 2048 key, PKCS#8');
check(/^-----BEGIN CERTIFICATE REQUEST-----\n[A-Za-z0-9+/=\n]+-----END CERTIFICATE REQUEST-----\n$/.test(g.csrPem), 'the CSR is PEM');
check(csr?.ok === true && csr.spkiSha256 === g.spkiSha256 && P.attr(csr.subject, 'CN') === 'Rem0te MDM push', 'the CSR verifies under its own signature and carries the key\'s public half', JSON.stringify(csr?.subject));
check(!g.csrPem.includes('PRIVATE'), 'the CSR carries no private key');
// A CSR whose signature was tampered with does not verify.
const der = Buffer.from(g.csrPem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
const bad = Buffer.from(der); bad[bad.length - 5] ^= 0xff;
check(P.readCsr(P.csrPem(bad))?.ok === false, 'a CSR with a broken signature does not verify');
check(P.readCsr('not a csr') === null, 'garbage is not a CSR');
// Two keys, two different requests.
const g2 = P.generatePushKey();
check(g2.spkiSha256 !== g.spkiSha256 && g2.keyPem !== g.keyPem, 'every key is new');
// OpenSSL agrees the CSR is well-formed, when it is installed.
try {
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync('openssl', ['req', '-noout', '-verify', '-subject'], { input: g.csrPem, stdio: ['pipe', 'pipe', 'pipe'] }).toString();
  check(/Rem0te MDM push/.test(out), 'openssl req -verify accepts the CSR', out);
} catch (e) { if (e.code === 'ENOENT') console.log('  (openssl not installed: skipped its cross-check)'); else check(false, 'openssl req -verify accepts the CSR', String(e.stderr ?? e)); }

section('The push certificate');
const topic = testTopic();
const good = pushCertFor({ csrPem: g.csrPem, topic, now });
let c = P.checkPushCertificate(good.pem, key, now);
check(c.ok && c.topic === topic && c.facts.notAfter > now, 'a certificate for the CSR\'s key, with a push topic, is accepted and its topic extracted from the subject UID', JSON.stringify(c.ok ? c.topic : c));
check(c.ok && c.appleIssued === false, 'a stand-in issuer is not called Apple-issued (shown, never decided on)');
const derB64 = good.cert.raw.toString('base64');
check(P.checkPushCertificate(derB64, key, now).ok, 'Base64 DER is read as well as PEM');
c = P.checkPushCertificate(pushCertFor({ publicKey: rsaKey(), now }).pem, key, now);
check(!c.ok && c.code === 'CERT_KEY_MISMATCH', 'a certificate for another key is refused (CERT_KEY_MISMATCH)', JSON.stringify(c));
c = P.checkPushCertificate(pushCertFor({ csrPem: g.csrPem, now, notBefore: new Date(now - 400 * DAY), notAfter: new Date(now - DAY) }).pem, key, now);
check(!c.ok && c.code === 'CERT_EXPIRED', 'an expired certificate is refused (CERT_EXPIRED)', JSON.stringify(c));
c = P.checkPushCertificate(pushCertFor({ csrPem: g.csrPem, now, notBefore: new Date(now.getTime() + DAY), notAfter: new Date(now.getTime() + 300 * DAY) }).pem, key, now);
check(!c.ok && c.code === 'CERT_NOT_YET_VALID', 'a certificate not yet valid is refused (CERT_NOT_YET_VALID)', JSON.stringify(c));
c = P.checkPushCertificate(pushCertFor({ csrPem: g.csrPem, now, topic: 'com.example.not-a-push-topic' }).pem, key, now);
check(!c.ok && c.code === 'CERT_NOT_PUSH', 'a certificate with no com.apple.mgmt.External. topic is refused (CERT_NOT_PUSH)', JSON.stringify(c));
c = P.checkPushCertificate(good.pem + good.pem, key, now);
check(!c.ok && c.code === 'CERT_UNREADABLE', 'two certificates in one upload are refused', JSON.stringify(c));
check(!P.checkPushCertificate('hello', key, now).ok && !P.checkPushCertificate('', key, now).ok, 'garbage is refused');
// The boundary: valid until the second it expires, refused at it.
const edge = pushCertFor({ csrPem: g.csrPem, now, notAfter: new Date(Math.floor(now.getTime() / 1000) * 1000 + 60_000) });
check(P.checkPushCertificate(edge.pem, key, now).ok && !P.checkPushCertificate(edge.pem, key, new Date(now.getTime() + 61_000)).ok, 'expiry is exact: accepted a minute before, refused after');
check(P.APNS_TOPIC_RE.test(topic) && !P.APNS_TOPIC_RE.test('com.apple.mgmt.External.') && !P.APNS_TOPIC_RE.test(`${topic}x`) && !P.APNS_TOPIC_RE.test(`com.apple.mgmt.${topic.slice(-36)}`), 'the topic pattern is exact');

section('The MDM vendor certificate and the signed push request');
const ch = testChain(now);
let v = P.checkVendor({ certificate: ch.vendor.pem, privateKey: ch.vendor.keyPem, chain: ch.chainPem }, now);
check(v.ok && v.rootSha256 === P.sha256Hex(ch.root.cert.raw), 'a vendor certificate, its key and a connecting chain are accepted; the root\'s SHA-256 is given for comparison', JSON.stringify(v.ok ? '' : v));
check(P.checkVendor({ certificate: ch.vendor.cert.raw.toString('base64'), privateKey: ch.vendor.keyPem, chain: ch.chainPem }, now).ok, 'the vendor certificate as Base64 DER (Apple\'s .cer) is read');
v = P.checkVendor({ certificate: ch.vendor.pem, privateKey: rsaKey().export({ type: 'pkcs8', format: 'pem' }), chain: ch.chainPem }, now);
check(!v.ok && v.code === 'VENDOR_KEY_MISMATCH', 'another key is refused (VENDOR_KEY_MISMATCH)', JSON.stringify(v));
const enc = ch.vendor.key.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'test-only-pass' });
v = P.checkVendor({ certificate: ch.vendor.pem, privateKey: enc, chain: ch.chainPem }, now);
check(!v.ok && v.code === 'VENDOR_KEY_ENCRYPTED', 'an encrypted key without its passphrase is refused (VENDOR_KEY_ENCRYPTED)', JSON.stringify(v));
check(P.checkVendor({ certificate: ch.vendor.pem, privateKey: enc, passphrase: 'test-only-pass', chain: ch.chainPem }, now).ok, 'with its passphrase it is read');
v = P.checkVendor({ certificate: ch.vendor.pem, privateKey: ch.vendor.keyPem, chain: ch.mid.pem }, now);
check(!v.ok && v.code === 'VENDOR_CHAIN_INCOMPLETE', 'a chain of one is refused (VENDOR_CHAIN_INCOMPLETE)', JSON.stringify(v));
const other = testChain(now);
v = P.checkVendor({ certificate: ch.vendor.pem, privateKey: ch.vendor.keyPem, chain: other.chainPem }, now);
check(!v.ok && v.code === 'VENDOR_CHAIN_BROKEN', 'another chain is refused (VENDOR_CHAIN_BROKEN)', JSON.stringify(v));
v = P.checkVendor({ certificate: ch.vendor.pem, privateKey: ch.vendor.keyPem, chain: ch.root.pem + ch.mid.pem }, now);
check(!v.ok && v.code === 'VENDOR_CHAIN_BROKEN', 'the chain in the wrong order is refused');
const old = testChain(now, { vendorNotAfter: new Date(now.getTime() - DAY) });
v = P.checkVendor({ certificate: old.vendor.pem, privateKey: old.vendor.keyPem, chain: old.chainPem }, now);
check(!v.ok && v.code === 'VENDOR_CERT_EXPIRED', 'an expired vendor certificate is refused', JSON.stringify(v));
const ec = (await import('node:crypto')).generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
v = P.checkVendor({ certificate: ch.vendor.pem, privateKey: ec, chain: ch.chainPem }, now);
check(!v.ok && v.code === 'VENDOR_KEY_NOT_RSA', 'an EC key is refused (Apple asks for SHA256withRSA)', JSON.stringify(v));

const req = P.buildPushCertRequest({ csrDer: der, vendorKey: ch.vendor.key, vendorCertPem: ch.vendor.pem, chainPem: ch.chainPem });
const back = P.readPushCertRequest(req.file);
check(/^[A-Za-z0-9+/=]+$/.test(req.file) && Buffer.from(req.file, 'base64').toString('utf8') === req.plist, 'the request file is the plist, Base64-encoded');
check(/<key>PushCertCertificateChain<\/key>[\s\S]*<key>PushCertRequestCSR<\/key>[\s\S]*<key>PushCertSignature<\/key>/.test(req.plist) && req.plist.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist'), 'the plist holds the chain, the CSR and the signature');
check(back && back.csrDer.equals(der), 'it carries the DER CSR');
check(back && verify('sha256', der, createPublicKey(ch.vendor.key), back.signature), 'the signature is SHA256withRSA over the DER CSR, by the vendor key');
const chainCerts = back ? P.readCertificates(back.chainPem) : [];
check(chainCerts?.length === 3 && chainCerts[0].raw.equals(ch.vendor.cert.raw) && chainCerts[1].raw.equals(ch.mid.cert.raw) && chainCerts[2].raw.equals(ch.root.cert.raw), 'the chain is vendor, intermediate, root — Apple\'s order');
check(!req.plist.includes('PRIVATE KEY'), 'no private key in the request');

section('The Google service-account key');
let s = P.checkServiceAccountKey(serviceAccountJson({ project_id: 'rem0te-test-proj' }));
check(s.ok && s.projectId === 'rem0te-test-proj' && s.clientEmail === 'amapi-test@rem0te-test-proj.iam.gserviceaccount.com' && /^[0-9a-f]{4}$/.test(s.keyIdLast4), 'a key file of the right shape is accepted', JSON.stringify(s.ok ? { p: s.projectId } : s));
check(s.ok && !JSON.parse(s.sealedJson).auth_uri && Object.keys(JSON.parse(s.sealedJson)).sort().join() === 'client_email,client_id,private_key,private_key_id,project_id,type', 'what is sealed is rebuilt from the known fields only');
const refuse = (o, field, n) => { const r = P.checkServiceAccountKey(typeof o === 'string' ? o : serviceAccountJson(o)); check(!r.ok && r.code === 'ANDROID_KEY_INVALID' && r.field === field, n, JSON.stringify(r)); };
refuse('not json', 'file', 'not JSON is refused');
refuse('[]', 'file', 'a JSON array is refused');
refuse({ type: 'authorized_user' }, 'type', 'type other than service_account is refused');
refuse({ project_id: 'X' }, 'project_id', 'a malformed project id is refused');
refuse({ client_email: 'someone@gmail.com' }, 'client_email', 'a person\'s address is refused');
refuse({ project_id: 'rem0te-proj-a', client_email: 'amapi-test@rem0te-proj-b.iam.gserviceaccount.com' }, 'client_email', 'an e-mail of another project is refused');
refuse({ private_key_id: 'abc' }, 'private_key_id', 'a malformed key id is refused');
refuse({ private_key: 'MIIB...' }, 'private_key', 'a private key that is not PEM is refused');
refuse({ private_key: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n' }, 'private_key', 'a PEM that does not load is refused');
refuse({ private_key: ec }, 'private_key', 'an EC key is refused');
refuse('x'.repeat(17_000), 'file', 'a file over 16 KB is refused');

section('Reminders, the topic rule and the states');
const at = (d) => new Date(now.getTime() + d * DAY - 60_000);
check(M.dueReminder(at(40), null, now) === null, '40 days out: no reminder');
check(M.dueReminder(at(30), null, now) === 30 && M.dueReminder(at(30), 30, now) === null, '30 days: the 30-day reminder, once');
check(M.dueReminder(at(14), 30, now) === 14 && M.dueReminder(at(10), 14, now) === null, '14 days: the 14-day reminder, once');
check(M.dueReminder(at(3), 14, now) === 3 && M.dueReminder(at(1), 3, now) === null, '3 days: the 3-day reminder, once');
check(M.dueReminder(new Date(now.getTime() - DAY), 3, now) === 0 && M.dueReminder(new Date(now.getTime() - DAY), 0, now) === null, 'expired: one more, then nothing');
check(M.dueReminder(at(10), null, now) === 14, 'installed 10 days before expiry: only the 14-day reminder, not 30 and 14');
check(JSON.stringify(M.REMINDER_DAYS) === '[30,14,3]', 'the thresholds are 30, 14 and 3 days');
const T = topicDecision();
function topicDecision() { return M.topicDecision; }
check(T(null, topic, null).op === 'install' && T(topic, topic, null).op === 'renew', 'a first certificate installs; the same topic renews');
check(T(topic, testTopic(), null).code === 'APNS_TOPIC_CHANGED', 'a different topic is refused on the ordinary upload');
const t2 = testTopic();
check(T(topic, t2, { currentTopic: topic }).op === 'replace' && T(topic, t2, { currentTopic: t2 }).code === 'APNS_REPLACE_STALE'
  && T(topic, topic, { currentTopic: topic }).code === 'APNS_TOPIC_SAME' && T(null, t2, { currentTopic: topic }).code === 'APNS_NOTHING_TO_REPLACE', 'replacing must name the current topic and bring a new one');
const F0 = { pushKey: false, vendor: null, signingRoute: null, pushCert: null, appleAccount: null, androidKey: false };
let caps = M.capabilities(F0, now);
const st = (cs) => Object.fromEntries(cs.map((x) => [x.key, x.state]));
check(caps.every((x) => M.STATES.includes(x.state)) && st(caps)['apple.push_request'] === 'requires_setup' && st(caps)['apple.enrollment'] === 'planned' && st(caps)['apple.abm'] === 'planned'
  && st(caps)['android.connection_test'] === 'planned' && st(caps)['android.enterprise'] === 'planned' && st(caps)['apple.ios15'] === 'unsupported', 'nothing done: requires setup, with enrollment, ABM and the Android calls planned and iOS 15 unsupported', JSON.stringify(st(caps)));
caps = M.capabilities({ ...F0, pushKey: true, vendor: { notAfter: new Date(now.getTime() + DAY) }, signingRoute: 'own_vendor', pushCert: { notAfter: new Date(now.getTime() + 200 * DAY) }, appleAccount: 'mdm@example.test', androidKey: true }, now);
check(['apple.push_request', 'apple.vendor_signing', 'apple.push_certificate', 'apple.renewal', 'android.service_account'].every((k) => st(caps)[k] === 'available')
  && M.platformState(caps, 'apple').state === 'planned' && M.platformState(caps, 'android').state === 'planned', 'every M1 step done: available, and each card\'s next step is planned (M2, M3)', JSON.stringify(st(caps)));
check(/Not yet proven/.test(caps.find((x) => x.key === 'apple.push_certificate').reason), 'an installed certificate says it is not yet proven');
caps = M.capabilities({ ...F0, pushKey: true, pushCert: { notAfter: new Date(now.getTime() - DAY) } }, now);
check(st(caps)['apple.push_certificate'] === 'requires_setup' && /expired/.test(caps.find((x) => x.key === 'apple.push_certificate').reason), 'an expired certificate is requires setup, with the reason');
check(M.APPLE_ACCOUNT_RE.test('mdm-push@example.co.uk') && !M.APPLE_ACCOUNT_RE.test('not an email') && !M.APPLE_ACCOUNT_RE.test('a@b'), 'the Apple Account is an e-mail address');

section('Migration 0100 agrees with the model');
const sql = readFileSync(path.join(root, 'apps/api/prisma/migrations/0100_mdm_setup/migration.sql'), 'utf8');
const arr = (name) => [...((sql.match(new RegExp(`"${name}" <@ ARRAY\\[([^\\]]*)\\]`)) ?? [])[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
check(JSON.stringify(arr('appleChecklist')) === JSON.stringify(M.APPLE_CHECKLIST) && JSON.stringify(arr('androidChecklist')) === JSON.stringify(M.ANDROID_CHECKLIST), 'the checklists are 0100\'s CHECKs, in order');
const routes = [...((sql.match(/"signingRoute" IN \(([^)]*)\)/) ?? [])[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
check(JSON.stringify(routes) === JSON.stringify(M.SIGNING_ROUTES), 'the signing routes are 0100\'s CHECK');
check(/"pushRemindedDays" IN \(30, 14, 3, 0\)/.test(sql) && JSON.stringify(M.REMINDER_VALUES) === '[30,14,3,0]', 'the reminder values are 0100\'s CHECK');
const topicSql = (sql.match(/"apnsTopic" ~ '([^']+)'/) ?? [])[1];
check(topicSql && new RegExp(topicSql).source === P.APNS_TOPIC_RE.source, 'the topic pattern is 0100\'s CHECK', `${topicSql} vs ${P.APNS_TOPIC_RE.source}`);
check(/CHECK \("id" = 'platform'\)/.test(sql) && /BEFORE DELETE ON "MdmPlatformSetup"/.test(sql), 'one row, never deleted (decision 23)');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
