/**
 * TEST ONLY (0.83 Beacon): stand-in certificates for the Settings → Mobile
 * devices suites, made at run time with node:crypto and the API's own DER
 * writer (dist/mdm/setup/pki.js). Nothing here is, or imitates, a real Apple
 * or Google credential: every name says "TEST", every key is generated fresh
 * and thrown away, and nothing is written to disk or committed.
 *
 *   testCa(name)                        a self-signed stand-in root
 *   issue({ issuer, subject, publicKey, notBefore, notAfter })   a certificate
 *   testChain(now)                      root → "WWDR" intermediate → vendor cert, with keys
 *   pushCertFor(csrPem, { topic, notBefore, notAfter, issuer })  a stand-in push certificate for Rem0te's CSR
 *   serviceAccountJson(o)               a stand-in Google key file
 */
import { createRequire } from 'node:module';
import { generateKeyPairSync, randomBytes, randomUUID, sign, createPublicKey, X509Certificate } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const load = (f) => {
  for (const base of [path.join(here, '..', '..', 'dist'), path.join(here, '..', '..', 'dist', 'src')]) {
    try { return require(path.join(base, f)); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
  }
  throw new Error(`dist/${f} not found: run nest build first`);
};
export const P = load('mdm/setup/pki.js');

const DAY = 86_400_000;
const SHA256_RSA = '1.2.840.113549.1.1.11';

export function rsaKey() { return generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey; }

/** A certificate for `publicKey`, signed by `issuer.key`, with basic constraints when `ca`. */
export function issue({ issuer, subject, publicKey, notBefore, notAfter, ca = false }) {
  const spki = (publicKey.type === 'public' ? publicKey : createPublicKey(publicKey)).export({ type: 'spki', format: 'der' });
  const exts = ca ? [P.ctx(3, false, P.seq(P.seq(P.oid('2.5.29.19'), P.tlv(0x01, Buffer.from([0xff])), P.octets(P.seq(P.tlv(0x01, Buffer.from([0xff])))))))] : [];
  const alg = P.seq(P.oid(SHA256_RSA), P.derNull());
  const tbs = P.seq(
    P.ctx(0, false, P.derInt(2)), P.derInt(Buffer.concat([Buffer.from([0x01]), randomBytes(8)])), alg,
    P.buildName(issuer.name), P.seq(P.derTime(notBefore), P.derTime(notAfter)), P.buildName(subject), spki, ...exts,
  );
  const der = P.seq(tbs, alg, P.bitString(sign('sha256', tbs, issuer.key)));
  return new X509Certificate(der);
}

export function testCa(cn, now = new Date()) {
  const key = rsaKey();
  const name = [{ type: 'CN', value: cn }, { type: 'O', value: 'TEST ONLY, not Apple' }, { type: 'C', value: 'US' }];
  const cert = issue({ issuer: { name, key }, subject: name, publicKey: key, notBefore: new Date(now.getTime() - 365 * DAY), notAfter: new Date(now.getTime() + 3650 * DAY), ca: true });
  return { key, name, cert, pem: P.certPem(cert) };
}

/** A stand-in root, intermediate and "MDM vendor" certificate with its key (all TEST ONLY). */
export function testChain(now = new Date(), { vendorNotAfter } = {}) {
  const root = testCa('TEST Root CA (stand-in)', now);
  const midKey = rsaKey();
  const midName = [{ type: 'CN', value: 'TEST WWDR Intermediate (stand-in)' }, { type: 'OU', value: 'G3' }, { type: 'O', value: 'TEST ONLY, not Apple' }, { type: 'C', value: 'US' }];
  const mid = issue({ issuer: root, subject: midName, publicKey: midKey, notBefore: new Date(now.getTime() - 300 * DAY), notAfter: new Date(now.getTime() + 3000 * DAY), ca: true });
  const vendorKey = rsaKey();
  const vendor = issue({
    issuer: { name: midName, key: midKey },
    subject: [{ type: 'UID', value: 'TEST.VENDOR' }, { type: 'CN', value: 'TEST MDM Vendor: Example Test Org' }, { type: 'OU', value: 'TESTTEAM01' }, { type: 'O', value: 'Example Test Org' }, { type: 'C', value: 'US' }],
    publicKey: vendorKey, notBefore: new Date(now.getTime() - DAY), notAfter: vendorNotAfter ?? new Date(now.getTime() + 365 * DAY),
  });
  return {
    root, mid: { key: midKey, name: midName, cert: mid, pem: P.certPem(mid) },
    vendor: { key: vendorKey, cert: vendor, pem: P.certPem(vendor), keyPem: vendorKey.export({ type: 'pkcs8', format: 'pem' }) },
    chainPem: P.certPem(mid) + root.pem,
  };
}

export const testTopic = () => `com.apple.mgmt.External.${randomUUID()}`;

/** A stand-in push certificate for the public key in `csrPem` (or `publicKey`), with a push topic in the subject UID. */
export function pushCertFor({ csrPem, publicKey, topic = testTopic(), notBefore, notAfter, issuer, now = new Date() }) {
  const ca = issuer ?? testCa('TEST Push Issuer (stand-in)', now);
  let pub = publicKey;
  if (!pub) {
    const der = Buffer.from(csrPem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
    const info = P.derChildren(P.derRead(der))[0];
    pub = createPublicKey({ key: P.derRaw(P.derChildren(info)[2]), format: 'der', type: 'spki' });
  }
  const cert = issue({
    issuer: ca, publicKey: pub,
    subject: [{ type: 'UID', value: topic }, { type: 'CN', value: `APSP:TEST-${topic.slice(-12)}` }, { type: 'C', value: 'US' }],
    notBefore: notBefore ?? new Date(now.getTime() - DAY), notAfter: notAfter ?? new Date(now.getTime() + 365 * DAY),
  });
  return { cert, pem: P.certPem(cert), topic };
}

/** A stand-in Google service-account key file (TEST ONLY: a fresh key, an example project). */
export function serviceAccountJson(o = {}) {
  const key = rsaKey();
  const project = o.project_id ?? `rem0te-test-${randomBytes(3).toString('hex')}`;
  return JSON.stringify({
    type: 'service_account', project_id: project, private_key_id: randomBytes(20).toString('hex'),
    private_key: key.export({ type: 'pkcs8', format: 'pem' }), client_email: `amapi-test@${project}.iam.gserviceaccount.com`,
    client_id: '1234567890123456789', auth_uri: 'about:blank', ...o,
  });
}
