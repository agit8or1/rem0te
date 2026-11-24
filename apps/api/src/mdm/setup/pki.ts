/**
 * Settings → Mobile devices (0.83 Beacon, docs/own-mdm.md M1): the
 * certificate work, pure. It imports only node:crypto: no database, no file,
 * no network, no clock (every check takes `now`). §92 holds it to that.
 *
 *   - the APNs push key and its CSR (PKCS#10, SHA256withRSA), built here
 *     with a small DER writer because node:crypto makes keys but not CSRs;
 *   - reading a certificate (PEM or base64 DER) and the facts Rem0te shows:
 *     subject, issuer, validity, serial, fingerprints, and the push topic
 *     (the subject's UID, `com.apple.mgmt.External.<uuid>`);
 *   - matching a certificate to a key (the SubjectPublicKeyInfo, byte for
 *     byte);
 *   - the vendor-signed `PushCertRequest` that Apple's push certificates portal takes: a
 *     plist holding the CSR, the vendor's SHA256withRSA signature over the
 *     DER CSR, and the chain (vendor, WWDR intermediate, Apple root) as PEM,
 *     the whole plist Base64-encoded (Apple: "Setting up push notifications
 *     for your device management customers");
 *   - the shape of a Google service-account key file.
 *
 * Nothing here can tell whether Apple will accept a request or whether APNs
 * will accept a certificate: only Apple can. The page says so.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, X509Certificate, type KeyObject } from 'node:crypto';

// ── A minimal DER writer and reader ───────────────────────────────────────

function derLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const b: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) b.unshift(v & 0xff);
  return Buffer.from([0x80 | b.length, ...b]);
}
export function tlv(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}
export const seq = (...p: Buffer[]) => tlv(0x30, ...p);
export const set = (...p: Buffer[]) => tlv(0x31, ...p);
export const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, 'utf8'));
export const derNull = () => Buffer.from([0x05, 0x00]);
export const bitString = (b: Buffer) => tlv(0x03, Buffer.from([0]), b);
export const octets = (b: Buffer) => tlv(0x04, b);
/** A context-specific tag: [n], constructed unless `primitive`. */
export const ctx = (n: number, primitive: boolean, ...p: Buffer[]) => tlv((primitive ? 0x80 : 0xa0) | n, ...p);
export function derInt(v: number | Buffer): Buffer {
  let b = typeof v === 'number' ? Buffer.from(v.toString(16).padStart(2, '0').replace(/^(.(..)*)$/, '0$1'), 'hex') : Buffer.from(v);
  while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.subarray(1);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}
export function oid(s: string): Buffer {
  const a = s.split('.').map(Number);
  const out: number[] = [40 * a[0] + a[1]];
  for (const n of a.slice(2)) {
    const enc: number[] = [n & 0x7f];
    for (let v = Math.floor(n / 128); v > 0; v = Math.floor(v / 128)) enc.unshift((v & 0x7f) | 0x80);
    out.push(...enc);
  }
  return tlv(0x06, Buffer.from(out));
}
/** UTCTime before 2050, GeneralizedTime from 2050 (RFC 5280 4.1.2.5). */
export function derTime(d: Date): Buffer {
  const iso = d.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return d.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(`${iso.slice(2)}Z`)) : tlv(0x18, Buffer.from(`${iso}Z`));
}

export interface DerNode { tag: number; start: number; header: number; length: number; buf: Buffer }
/** One TLV at `off`. Definite lengths only (DER); throws on anything out of bounds. */
export function derRead(buf: Buffer, off = 0): DerNode {
  if (off + 2 > buf.length) throw new Error('der: truncated');
  const tag = buf[off];
  if ((tag & 0x1f) === 0x1f) throw new Error('der: long tags are not used here');
  let len = buf[off + 1];
  let header = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4 || off + 2 + n > buf.length) throw new Error('der: bad length');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[off + 2 + i];
    header += n;
  }
  if (off + header + len > buf.length) throw new Error('der: truncated');
  return { tag, start: off, header, length: len, buf };
}
export const derContent = (n: DerNode) => n.buf.subarray(n.start + n.header, n.start + n.header + n.length);
export const derRaw = (n: DerNode) => n.buf.subarray(n.start, n.start + n.header + n.length);
export function derChildren(n: DerNode): DerNode[] {
  const out: DerNode[] = [];
  const end = n.start + n.header + n.length;
  for (let off = n.start + n.header; off < end;) {
    const c = derRead(n.buf, off);
    if (c.start + c.header + c.length > end) throw new Error('der: child overruns its parent');
    out.push(c);
    off = c.start + c.header + c.length;
  }
  return out;
}
export function oidString(b: Buffer): string {
  const out = [Math.floor(b[0] / 40), b[0] % 40];
  let v = 0;
  for (const x of b.subarray(1)) { v = v * 128 + (x & 0x7f); if (!(x & 0x80)) { out.push(v); v = 0; } }
  return out.join('.');
}

// ── Names ─────────────────────────────────────────────────────────────────

export const NAME_OIDS: Record<string, string> = {
  '2.5.4.3': 'CN', '2.5.4.6': 'C', '2.5.4.7': 'L', '2.5.4.8': 'ST', '2.5.4.10': 'O', '2.5.4.11': 'OU',
  '0.9.2342.19200300.100.1.1': 'UID', '1.2.840.113549.1.9.1': 'emailAddress',
};
const OID_OF: Record<string, string> = Object.fromEntries(Object.entries(NAME_OIDS).map(([k, v]) => [v, k]));

export type NameAttrs = { type: string; value: string }[];

/** A Name from attributes, one per RDN, in order. Country as PrintableString, the rest UTF8String. */
export function buildName(attrs: NameAttrs): Buffer {
  return seq(...attrs.map((a) => set(seq(oid(OID_OF[a.type] ?? a.type), a.type === 'C' ? tlv(0x13, Buffer.from(a.value, 'ascii')) : utf8(a.value)))));
}
function decodeString(n: DerNode): string {
  const c = derContent(n);
  if (n.tag === 0x1e) { let s = ''; for (let i = 0; i + 1 < c.length; i += 2) s += String.fromCharCode(c.readUInt16BE(i)); return s; }
  return n.tag === 0x0c ? c.toString('utf8') : c.toString('latin1');
}
export function readName(n: DerNode): NameAttrs {
  const out: NameAttrs = [];
  for (const rdn of derChildren(n)) for (const atv of derChildren(rdn)) {
    const [o, v] = derChildren(atv);
    const id = oidString(derContent(o));
    out.push({ type: NAME_OIDS[id] ?? id, value: decodeString(v) });
  }
  return out;
}
export const nameText = (a: NameAttrs) => a.map((x) => `${x.type}=${x.value}`).join(', ');
export const attr = (a: NameAttrs, type: string) => a.find((x) => x.type === type)?.value ?? null;

// ── Keys and CSRs ─────────────────────────────────────────────────────────

const SHA256_WITH_RSA = '1.2.840.113549.1.1.11';
export const sha256Hex = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const pem = (label: string, der: Buffer) => `-----BEGIN ${label}-----\n${der.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '')}\n-----END ${label}-----\n`;
export const spkiOf = (k: KeyObject) => (k.type === 'private' ? createPublicKey(k) : k).export({ type: 'spki', format: 'der' }) as Buffer;

/** The push CSR's subject. Apple reads nothing from it; it only has to be a valid request. */
export const PUSH_CSR_SUBJECT: NameAttrs = [{ type: 'CN', value: 'Rem0te MDM push' }, { type: 'O', value: 'Rem0te' }];

/** A PKCS#10 request for `key`, SHA256withRSA, no attributes. */
export function buildCsr(key: KeyObject, subject: NameAttrs = PUSH_CSR_SUBJECT): Buffer {
  const info = seq(derInt(0), buildName(subject), spkiOf(key), ctx(0, false));
  const alg = seq(oid(SHA256_WITH_RSA), derNull());
  return seq(info, alg, bitString(sign('sha256', info, key)));
}
export const csrPem = (der: Buffer) => pem('CERTIFICATE REQUEST', der);

/**
 * A new push key (RSA 2048) and its CSR. The key comes back as PKCS#8 PEM
 * for the caller to seal at once; it is never written anywhere else.
 */
export function generatePushKey(): { keyPem: string; csrPem: string; spkiSha256: string } {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const csr = buildCsr(privateKey);
  return { keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, csrPem: csrPem(csr), spkiSha256: sha256Hex(spkiOf(privateKey)) };
}

function pemBody(text: string, label: string): Buffer | null {
  const m = text.match(new RegExp(`-----BEGIN ${label}-----([A-Za-z0-9+/=\\s]+)-----END ${label}-----`));
  return m ? Buffer.from(m[1].replace(/\s+/g, ''), 'base64') : null;
}

/** A CSR's subject, its public key's SHA-256, and whether its own signature verifies. */
export function readCsr(text: string): { ok: boolean; subject: NameAttrs; spkiSha256: string; der: Buffer } | null {
  try {
    const der = pemBody(text, 'CERTIFICATE REQUEST');
    if (!der) return null;
    const [info, alg, sig] = derChildren(derRead(der));
    const [, subject, spki] = derChildren(info);
    const algOid = oidString(derContent(derChildren(alg)[0]));
    const sigBytes = derContent(sig).subarray(1);
    const pub = createPublicKey({ key: derRaw(spki), format: 'der', type: 'spki' });
    return { ok: algOid === SHA256_WITH_RSA && verify('sha256', derRaw(info), pub, sigBytes), subject: readName(subject), spkiSha256: sha256Hex(derRaw(spki)), der };
  } catch { return null; }
}

/** A private key from PEM (PKCS#8 or PKCS#1, optionally encrypted with `passphrase`), or why not. */
export function readPrivateKey(text: string, passphrase?: string): { ok: true; key: KeyObject } | { ok: false; reason: 'unreadable' | 'encrypted' | 'not_rsa' } {
  if (typeof text !== 'string' || !/-----BEGIN (RSA |ENCRYPTED )?PRIVATE KEY-----/.test(text)) return { ok: false, reason: 'unreadable' };
  try {
    const key = createPrivateKey(passphrase ? { key: text, format: 'pem', passphrase } : { key: text, format: 'pem' });
    return key.asymmetricKeyType === 'rsa' ? { ok: true, key } : { ok: false, reason: 'not_rsa' };
  } catch {
    return { ok: false, reason: /ENCRYPTED/.test(text) && !passphrase ? 'encrypted' : 'unreadable' };
  }
}

// ── Certificates ──────────────────────────────────────────────────────────

/** Every certificate in `text`: PEM blocks, or else one Base64 DER blob. */
export function readCertificates(text: string): X509Certificate[] | null {
  if (typeof text !== 'string' || !text.trim()) return null;
  try {
    const blocks = [...text.matchAll(/-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----/g)].map((m) => m[0]);
    if (blocks.length) return blocks.map((b) => new X509Certificate(b));
    if (!/^[A-Za-z0-9+/=\s]+$/.test(text)) return null;
    return [new X509Certificate(Buffer.from(text.replace(/\s+/g, ''), 'base64'))];
  } catch { return null; }
}
export function readCertificate(text: string): X509Certificate | null {
  const all = readCertificates(text);
  return all && all.length === 1 ? all[0] : null;
}

export interface CertFacts {
  subject: NameAttrs;
  issuer: NameAttrs;
  notBefore: Date;
  notAfter: Date;
  serial: string;
  sha256: string;
  spkiSha256: string;
  keyType: string | undefined;
  selfSigned: boolean;
}
export function certFacts(c: X509Certificate): CertFacts {
  const tbs = derChildren(derRead(c.raw))[0];
  const parts = derChildren(tbs);
  const i = parts[0].tag === 0xa0 ? 1 : 0;
  const issuer = readName(parts[i + 2]);
  const subject = readName(parts[i + 4]);
  return {
    subject, issuer,
    notBefore: new Date(c.validFrom), notAfter: new Date(c.validTo),
    serial: c.serialNumber.toUpperCase(),
    sha256: sha256Hex(c.raw),
    spkiSha256: sha256Hex(derRaw(parts[i + 5])),
    keyType: c.publicKey.asymmetricKeyType,
    selfSigned: c.checkIssued(c) && c.verify(c.publicKey),
  };
}
export const certPem = (c: X509Certificate) => pem('CERTIFICATE', c.raw);
export const keyMatches = (c: X509Certificate, key: KeyObject) => spkiOf(c.publicKey).equals(spkiOf(key));
export const issuedBy = (child: X509Certificate, parent: X509Certificate) => { try { return child.checkIssued(parent) && child.verify(parent.publicKey); } catch { return false; } };

/** A push topic: the push certificate's subject UID. */
export const APNS_TOPIC_RE = /^com\.apple\.mgmt\.External\.[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
/** Clock skew tolerated on notBefore, nothing on notAfter. */
export const NOT_BEFORE_SKEW_MS = 5 * 60_000;

export type PushCertRefusal = 'CERT_UNREADABLE' | 'CERT_NOT_PUSH' | 'CERT_KEY_MISMATCH' | 'CERT_EXPIRED' | 'CERT_NOT_YET_VALID';
export type PushCertCheck =
  | { ok: true; facts: CertFacts; topic: string; pem: string; appleIssued: boolean }
  | { ok: false; code: PushCertRefusal; message: string };

/**
 * An uploaded APNs push certificate against the sealed push key, at `now`.
 * Refused: not one certificate; no `com.apple.mgmt.External.` topic; a
 * public key that is not the push key's; expired; not yet valid.
 * `appleIssued` (the issuer's O is Apple Inc.) is shown, never decided on:
 * only APNs accepting the certificate proves Apple issued it.
 */
export function checkPushCertificate(text: string, key: KeyObject, now: Date): PushCertCheck {
  const c = readCertificate(text);
  if (!c) return { ok: false, code: 'CERT_UNREADABLE', message: 'That is not one certificate (PEM, or Base64 DER).' };
  let facts: CertFacts;
  try { facts = certFacts(c); } catch { return { ok: false, code: 'CERT_UNREADABLE', message: 'The certificate could not be read.' }; }
  const topic = attr(facts.subject, 'UID');
  if (!topic || !APNS_TOPIC_RE.test(topic)) return { ok: false, code: 'CERT_NOT_PUSH', message: 'This is not an MDM push certificate: its subject has no com.apple.mgmt.External.<uuid> topic.' };
  if (!keyMatches(c, key)) return { ok: false, code: 'CERT_KEY_MISMATCH', message: "This certificate was not issued for Rem0te's push request: its public key is not the sealed push key's." };
  if (facts.notAfter.getTime() <= now.getTime()) return { ok: false, code: 'CERT_EXPIRED', message: `This certificate expired on ${facts.notAfter.toISOString().slice(0, 10)}. Renew it at Apple with the same account and upload the new one.` };
  if (facts.notBefore.getTime() > now.getTime() + NOT_BEFORE_SKEW_MS) return { ok: false, code: 'CERT_NOT_YET_VALID', message: `This certificate is not valid until ${facts.notBefore.toISOString()}.` };
  return { ok: true, facts, topic, pem: certPem(c), appleIssued: attr(facts.issuer, 'O') === 'Apple Inc.' };
}

export type VendorRefusal = 'VENDOR_CERT_UNREADABLE' | 'VENDOR_KEY_UNREADABLE' | 'VENDOR_KEY_ENCRYPTED' | 'VENDOR_KEY_NOT_RSA' | 'VENDOR_KEY_MISMATCH'
  | 'VENDOR_CERT_EXPIRED' | 'VENDOR_CHAIN_INCOMPLETE' | 'VENDOR_CHAIN_BROKEN';
export type VendorCheck =
  | { ok: true; cert: X509Certificate; facts: CertFacts; keyPem: string; chainPem: string; rootSha256: string; intermediate: CertFacts; root: CertFacts }
  | { ok: false; code: VendorRefusal; message: string };

/**
 * The MDM vendor signing certificate from the owner's developer account,
 * its private key, and the chain (Apple WWDR intermediate, then the Apple
 * root, both public downloads from Apple). Checked: one certificate; an
 * RSA key that is the certificate's; unexpired; the certificate issued and
 * signed by the intermediate, the intermediate by the root, the root by
 * itself. The root's SHA-256 is shown so a person can compare it with
 * Apple's published one; Rem0te does not pin it, and cannot tell from
 * here that the root is Apple's.
 */
export function checkVendor(input: { certificate: string; privateKey: string; passphrase?: string; chain: string }, now: Date): VendorCheck {
  const cert = readCertificate(input.certificate);
  if (!cert) return { ok: false, code: 'VENDOR_CERT_UNREADABLE', message: 'The vendor certificate is not one certificate (PEM, or Base64 DER as Apple downloads it).' };
  const k = readPrivateKey(input.privateKey, input.passphrase);
  if (!k.ok) {
    return k.reason === 'encrypted' ? { ok: false, code: 'VENDOR_KEY_ENCRYPTED', message: 'The private key is encrypted: give its passphrase too (it is used once and not kept).' }
      : k.reason === 'not_rsa' ? { ok: false, code: 'VENDOR_KEY_NOT_RSA', message: 'The vendor key must be RSA: Apple asks for a SHA256withRSA signature.' }
        : { ok: false, code: 'VENDOR_KEY_UNREADABLE', message: 'The private key is not a PEM private key (or the passphrase is wrong).' };
  }
  if (!keyMatches(cert, k.key)) return { ok: false, code: 'VENDOR_KEY_MISMATCH', message: 'That private key is not the vendor certificate\'s.' };
  const facts = certFacts(cert);
  if (facts.notAfter.getTime() <= now.getTime()) return { ok: false, code: 'VENDOR_CERT_EXPIRED', message: `The vendor certificate expired on ${facts.notAfter.toISOString().slice(0, 10)}. Make a new one in your developer account.` };
  const chain = readCertificates(input.chain);
  if (!chain || chain.length !== 2) return { ok: false, code: 'VENDOR_CHAIN_INCOMPLETE', message: 'Give the chain as two certificates: the Apple WWDR intermediate, then the Apple root.' };
  const [mid, root] = chain;
  if (!issuedBy(cert, mid) || !issuedBy(mid, root) || !issuedBy(root, root)) {
    return { ok: false, code: 'VENDOR_CHAIN_BROKEN', message: 'The chain does not connect: the vendor certificate must be signed by the intermediate, the intermediate by the root, and the root by itself.' };
  }
  return {
    ok: true, cert, facts, keyPem: k.key.export({ type: 'pkcs8', format: 'pem' }) as string,
    chainPem: certPem(mid) + certPem(root), rootSha256: sha256Hex(root.raw), intermediate: certFacts(mid), root: certFacts(root),
  };
}

// ── The signed push request ───────────────────────────────────────────────

/** The plist DTD's public identifier. Never fetched: a plist names it. */
export const PLIST_DOCTYPE = '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">';
const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The file a person uploads at Apple's push certificates portal: Base64 of a plist with
 * PushCertRequestCSR (Base64 DER CSR), PushCertCertificateChain (the
 * vendor certificate, the intermediate and the root as PEM, in that order)
 * and PushCertSignature (Base64 SHA256withRSA over the DER CSR, by the
 * vendor key). Returns the file and the plist inside it.
 */
export function buildPushCertRequest(p: { csrDer: Buffer; vendorKey: KeyObject; vendorCertPem: string; chainPem: string }): { file: string; plist: string } {
  const signature = sign('sha256', p.csrDer, p.vendorKey).toString('base64');
  const plist = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    PLIST_DOCTYPE,
    '<plist version="1.0">',
    '<dict>',
    '<key>PushCertCertificateChain</key>',
    `<string>${xmlEscape(p.vendorCertPem + p.chainPem)}</string>`,
    '<key>PushCertRequestCSR</key>',
    `<string>${p.csrDer.toString('base64')}</string>`,
    '<key>PushCertSignature</key>',
    `<string>${signature}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
  return { file: Buffer.from(plist, 'utf8').toString('base64'), plist };
}

/** Reads a request back (tests and the page's own check): the three values, or null. */
export function readPushCertRequest(file: string): { csrDer: Buffer; chainPem: string; signature: Buffer } | null {
  try {
    const plist = Buffer.from(file.replace(/\s+/g, ''), 'base64').toString('utf8');
    const val = (k: string) => (plist.match(new RegExp(`<key>${k}</key>\\s*<string>([\\s\\S]*?)</string>`)) ?? [])[1];
    const csr = val('PushCertRequestCSR'), chain = val('PushCertCertificateChain'), sig = val('PushCertSignature');
    if (!csr || !chain || !sig) return null;
    return { csrDer: Buffer.from(csr, 'base64'), chainPem: chain.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'), signature: Buffer.from(sig, 'base64') };
  } catch { return null; }
}

// ── Google service-account key ────────────────────────────────────────────

export const GCP_PROJECT_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
export const SA_EMAIL_RE = /^[a-z0-9][a-z0-9-]{4,29}@([a-z][a-z0-9-]{4,28}[a-z0-9])\.iam\.gserviceaccount\.com$/;
export const SA_KEY_ID_RE = /^[0-9a-f]{40}$/;
export const SA_CLIENT_ID_RE = /^[0-9]{10,30}$/;
export const MAX_KEY_FILE = 16_384;

export type ServiceAccountCheck =
  | { ok: true; projectId: string; clientEmail: string; privateKeyId: string; keyIdLast4: string; sealedJson: string }
  | { ok: false; code: 'ANDROID_KEY_INVALID'; field: string; message: string };

/**
 * A Google Cloud service-account key file (JSON), checked offline: type
 * `service_account`, a project id, a client e-mail of that project's
 * `iam.gserviceaccount.com` form, a 40-hex key id, and a private key PEM
 * that loads as RSA. What is sealed is rebuilt from those fields only, so
 * nothing else in the uploaded file is kept. Whether the account has the
 * Android Management User role, or the project has quota, cannot be told
 * without calling Google (M3).
 */
export function checkServiceAccountKey(text: string): ServiceAccountCheck {
  const bad = (field: string, message: string): ServiceAccountCheck => ({ ok: false, code: 'ANDROID_KEY_INVALID', field, message });
  if (typeof text !== 'string' || text.length > MAX_KEY_FILE) return bad('file', `The key file must be JSON of at most ${MAX_KEY_FILE} bytes.`);
  let j: Record<string, unknown>;
  try { j = JSON.parse(text) as Record<string, unknown>; } catch { return bad('file', 'The key file is not JSON.'); }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return bad('file', 'The key file is not a JSON object.');
  if (j.type !== 'service_account') return bad('type', 'This is not a service-account key: "type" must be "service_account".');
  const projectId = j.project_id, email = j.client_email, keyId = j.private_key_id, pk = j.private_key, clientId = j.client_id;
  if (typeof projectId !== 'string' || !GCP_PROJECT_RE.test(projectId)) return bad('project_id', '"project_id" is missing or is not a Google Cloud project id.');
  const em = typeof email === 'string' ? email.match(SA_EMAIL_RE) : null;
  if (!em) return bad('client_email', '"client_email" is missing or is not a service account\'s address (name@project.iam.gserviceaccount.com).');
  if (em[1] !== projectId) return bad('client_email', '"client_email" belongs to another project than "project_id".');
  if (typeof keyId !== 'string' || !SA_KEY_ID_RE.test(keyId)) return bad('private_key_id', '"private_key_id" is missing or malformed.');
  if (clientId !== undefined && (typeof clientId !== 'string' || !SA_CLIENT_ID_RE.test(clientId))) return bad('client_id', '"client_id" is malformed.');
  if (typeof pk !== 'string' || !/^-----BEGIN PRIVATE KEY-----/.test(pk)) return bad('private_key', '"private_key" is missing or is not a PEM private key.');
  const k = readPrivateKey(pk);
  if (!k.ok) return bad('private_key', k.reason === 'not_rsa' ? '"private_key" is not an RSA key.' : '"private_key" does not load.');
  const sealedJson = JSON.stringify({ type: 'service_account', project_id: projectId, private_key_id: keyId, private_key: pk, client_email: email, ...(clientId ? { client_id: clientId } : {}) });
  return { ok: true, projectId, clientEmail: email as string, privateKeyId: keyId, keyIdLast4: keyId.slice(-4), sealedJson };
}

// ── 0.84 (M2, step 6): the device CA and the profile signer ───────────────

export type DeviceCaRefusal = 'CA_UNREADABLE' | 'CA_NOT_ROOT' | 'CA_EXPIRED' | 'CA_CHAIN_BROKEN' | 'CA_TOO_LONG';
export type DeviceCaCheck =
  | { ok: true; root: X509Certificate; rootFacts: CertFacts; intermediates: X509Certificate[]; rootPem: string; chainPem: string | null; notAfter: Date }
  | { ok: false; code: DeviceCaRefusal; message: string };

/**
 * The device CA's public certificates (rem0te-mdm-ca: step-ca's root and
 * intermediate, from `rem0te-mdm-ca-setup.sh`). The root must be a
 * self-signed CA; every intermediate a CA issued by the root or by another
 * listed intermediate; all valid now. Only public certificates: the CA's key
 * never reaches the portal.
 */
export function checkDeviceCa(input: { root: string; intermediates?: string }, now: Date): DeviceCaCheck {
  const root = readCertificate(input.root);
  if (!root) return { ok: false, code: 'CA_UNREADABLE', message: 'The root is not one certificate (PEM).' };
  const rootFacts = certFacts(root);
  if (!root.ca || !rootFacts.selfSigned) return { ok: false, code: 'CA_NOT_ROOT', message: 'The root must be a self-signed CA certificate (the device CA\'s root_ca.crt).' };
  const valid = (c: X509Certificate) => new Date(c.validFrom).getTime() <= now.getTime() + NOT_BEFORE_SKEW_MS && now.getTime() < new Date(c.validTo).getTime();
  if (!valid(root)) return { ok: false, code: 'CA_EXPIRED', message: 'The root is expired or not yet valid.' };
  const mids = input.intermediates?.trim() ? readCertificates(input.intermediates) : [];
  if (!mids) return { ok: false, code: 'CA_UNREADABLE', message: 'The intermediates are not PEM certificates.' };
  if (mids.length > 3) return { ok: false, code: 'CA_TOO_LONG', message: 'At most three intermediates.' };
  for (const m of mids) {
    if (!m.ca || !valid(m)) return { ok: false, code: 'CA_CHAIN_BROKEN', message: 'Every intermediate must be a valid CA certificate.' };
    if (!issuedBy(m, root) && !mids.some((o) => o !== m && issuedBy(m, o))) return { ok: false, code: 'CA_CHAIN_BROKEN', message: 'An intermediate was not issued by the root (or by another intermediate given).' };
  }
  const notAfter = [root, ...mids].map((c) => new Date(c.validTo)).sort((a, b) => a.getTime() - b.getTime())[0];
  return { ok: true, root, rootFacts, intermediates: mids, rootPem: certPem(root), chainPem: mids.length ? mids.map(certPem).join('') : null, notAfter };
}

export type SignerRefusal = 'SIGNER_CERT_UNREADABLE' | 'SIGNER_KEY_UNREADABLE' | 'SIGNER_KEY_ENCRYPTED' | 'SIGNER_KEY_TYPE' | 'SIGNER_KEY_MISMATCH' | 'SIGNER_EXPIRED' | 'SIGNER_IS_CA' | 'SIGNER_CHAIN';
export type SignerCheck =
  | { ok: true; cert: X509Certificate; facts: CertFacts; keyPem: string; chain: X509Certificate[]; chainPem: string | null }
  | { ok: false; code: SignerRefusal; message: string };

/**
 * The profile-signing certificate and key (`rem0te-mdm-ca-setup.sh` issues
 * one from the device CA). RSA or EC; the key the certificate's; valid now;
 * not a CA. The optional chain is public and goes in the signed profile.
 */
export function checkProfileSigner(input: { certificate: string; privateKey: string; passphrase?: string; chain?: string }, now: Date): SignerCheck {
  const cert = readCertificate(input.certificate);
  if (!cert) return { ok: false, code: 'SIGNER_CERT_UNREADABLE', message: 'The signing certificate is not one certificate (PEM).' };
  if (typeof input.privateKey !== 'string' || !/-----BEGIN (RSA |EC |ENCRYPTED )?PRIVATE KEY-----/.test(input.privateKey)) return { ok: false, code: 'SIGNER_KEY_UNREADABLE', message: 'The key is not a PEM private key.' };
  let key: KeyObject;
  try { key = createPrivateKey(input.passphrase ? { key: input.privateKey, format: 'pem', passphrase: input.passphrase } : { key: input.privateKey, format: 'pem' }); }
  catch { return /ENCRYPTED/.test(input.privateKey) && !input.passphrase ? { ok: false, code: 'SIGNER_KEY_ENCRYPTED', message: 'The key is encrypted: give its passphrase too (used once, not kept).' } : { ok: false, code: 'SIGNER_KEY_UNREADABLE', message: 'The key could not be read (or the passphrase is wrong).' }; }
  if (key.asymmetricKeyType !== 'rsa' && key.asymmetricKeyType !== 'ec') return { ok: false, code: 'SIGNER_KEY_TYPE', message: 'The signing key must be RSA or EC.' };
  if (!keyMatches(cert, key)) return { ok: false, code: 'SIGNER_KEY_MISMATCH', message: 'That key is not the signing certificate\'s.' };
  const facts = certFacts(cert);
  if (facts.notAfter.getTime() <= now.getTime() || facts.notBefore.getTime() > now.getTime() + NOT_BEFORE_SKEW_MS) return { ok: false, code: 'SIGNER_EXPIRED', message: 'The signing certificate is expired or not yet valid.' };
  if (cert.ca) return { ok: false, code: 'SIGNER_IS_CA', message: 'Use a signing certificate, not a CA certificate: the CA\'s key stays with the CA.' };
  const chain = input.chain?.trim() ? readCertificates(input.chain) : [];
  if (!chain || chain.length > 3 || chain.some((c) => !c.ca)) return { ok: false, code: 'SIGNER_CHAIN', message: 'The chain must be up to three CA certificates (PEM).' };
  return { ok: true, cert, facts, keyPem: key.export({ type: 'pkcs8', format: 'pem' }) as string, chain, chainPem: chain.length ? chain.map(certPem).join('') : null };
}
