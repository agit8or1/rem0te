/**
 * CMS (PKCS#7) SignedData, the two ways the own MDM needs it (0.84 Harbor,
 * docs/own-mdm.md M2, §93). Pure: node:crypto and pki.ts's DER helpers only,
 * no clock (every check takes `now`), no file, no network.
 *
 *   verifyDetachedCms   the `Mdm-Signature` header: a detached SignedData
 *                       over the exact bytes of a device's message, signed
 *                       with the device's identity certificate (Apple:
 *                       "Managing certificates for device management
 *                       services and devices", SignMessage). Verified here
 *                       BEFORE the body is parsed.
 *   signAttachedCms     the enrollment profile: an attached SignedData over
 *                       the .mobileconfig, signed with the profile-signing
 *                       certificate the owner uploaded.
 *
 * What a verification decides, in order, refusing at the first failure:
 *   1. the bytes are one ContentInfo holding SignedData (BER indefinite
 *      lengths are normalised first, bounded);
 *   2. it is detached (no encapsulated content) and has exactly one signer;
 *   3. the signer's certificate is in the message, found by issuer and serial;
 *   4. the digest is SHA-1, SHA-256, SHA-384 or SHA-512 and the signature
 *      RSA PKCS#1 v1.5 or ECDSA, matching the key;
 *   5. with signed attributes: content-type is `data` and message-digest is
 *      the digest of the body (constant time); the signature covers the
 *      attributes' DER SET. Without them: the signature covers the body;
 *   6. the certificate is unexpired, already valid, not a CA, allowed client
 *      authentication if it names extended key usages, and chains — through
 *      CA certificates that are themselves valid at `now` — to one of the
 *      trusted roots (Rem0te's device CA), in at most four steps.
 *
 * SHA-1 is accepted because the device simulator signs with it (smallstep
 * pkcs7's default) and whether every Apple device signs with SHA-256 is not
 * confirmed. The signature's authority is the device's own key and the
 * certificate chain: the device signs its own message, so a collision would
 * have to be one the device itself chose.
 */
import { createHash, sign, timingSafeEqual, verify, X509Certificate, type KeyObject } from 'node:crypto';
import { ctx, derChildren, derContent, derInt, derNull, derRaw, derRead, derTime, oid, oidString, octets, seq, set, sha256Hex, tlv, type DerNode } from '../setup/pki';

export const OID = {
  data: '1.2.840.113549.1.7.1',
  signedData: '1.2.840.113549.1.7.2',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingTime: '1.2.840.113549.1.9.5',
  rsaEncryption: '1.2.840.113549.1.1.1',
  ecPublicKey: '1.2.840.10045.2.1',
  clientAuth: '1.3.6.1.5.5.7.3.2',
  anyEku: '2.5.29.37.0',
} as const;

const DIGESTS: Record<string, 'sha1' | 'sha256' | 'sha384' | 'sha512'> = {
  '1.3.14.3.2.26': 'sha1', '2.16.840.1.101.3.4.2.1': 'sha256', '2.16.840.1.101.3.4.2.2': 'sha384', '2.16.840.1.101.3.4.2.3': 'sha512',
};
const RSA_SIGS = new Set([OID.rsaEncryption, '1.2.840.113549.1.1.5', '1.2.840.113549.1.1.11', '1.2.840.113549.1.1.12', '1.2.840.113549.1.1.13']);
const EC_SIGS = new Set([OID.ecPublicKey, '1.2.840.10045.4.1', '1.2.840.10045.4.3.2', '1.2.840.10045.4.3.3', '1.2.840.10045.4.3.4']);

/** The largest signature accepted (Apple: about 2 KB per message; a chain fits well within this). */
export const MAX_CMS_BYTES = 16_384;
const MAX_CHAIN = 4;

// ── BER → DER (definite lengths only) ─────────────────────────────────────

/** Re-encode indefinite lengths as definite ones; refuse anything deeper or larger than a signature can be. */
export function berToDer(buf: Buffer): Buffer {
  let nodes = 0;
  const one = (off: number, depth: number): { der: Buffer; next: number } => {
    if (depth > 32 || ++nodes > 4096) throw new Error('ber: too complex');
    if (off + 2 > buf.length) throw new Error('ber: truncated');
    const tag = buf[off];
    if ((tag & 0x1f) === 0x1f) throw new Error('ber: long tags are not used here');
    const l = buf[off + 1];
    if (l === 0x80) {
      if (!(tag & 0x20)) throw new Error('ber: indefinite primitive');
      const parts: Buffer[] = [];
      let p = off + 2;
      for (;;) {
        if (p + 2 > buf.length) throw new Error('ber: unterminated');
        if (buf[p] === 0 && buf[p + 1] === 0) { p += 2; break; }
        const c = one(p, depth + 1);
        parts.push(c.der);
        p = c.next;
      }
      return { der: tlv(tag, ...parts), next: p };
    }
    const n = derRead(buf, off);
    const end = n.start + n.header + n.length;
    if (!(tag & 0x20)) return { der: derRaw(n), next: end };
    const parts: Buffer[] = [];
    for (let p = n.start + n.header; p < end;) { const c = one(p, depth + 1); if (c.next > end) throw new Error('ber: overrun'); parts.push(c.der); p = c.next; }
    return { der: tlv(tag, ...parts), next: end };
  };
  const r = one(0, 0);
  if (r.next !== buf.length) throw new Error('ber: trailing bytes');
  return r.der;
}

// ── Verification ──────────────────────────────────────────────────────────

export interface Trust { roots: X509Certificate[]; intermediates: X509Certificate[] }
export type CmsRefusal =
  | 'malformed' | 'not_signed_data' | 'not_detached' | 'signer_count' | 'signer_not_found' | 'digest_unsupported' | 'signature_unsupported'
  | 'content_type_mismatch' | 'digest_mismatch' | 'bad_signature' | 'certificate_expired' | 'certificate_not_yet_valid' | 'certificate_is_ca'
  | 'certificate_usage' | 'untrusted';
export type CmsVerdict = { ok: true; signer: X509Certificate; signerSha256: string; digest: string } | { ok: false; reason: CmsRefusal };

const oidOf = (n: DerNode) => { if (n.tag !== 0x06) throw new Error('der: not an OID'); return oidString(derContent(n)); };
/** A DER INTEGER's magnitude, without a sign byte: comparable with X509Certificate.serialNumber. */
const serialHex = (n: DerNode) => { let b = derContent(n); while (b.length > 1 && b[0] === 0) b = b.subarray(1); return b.toString('hex').toUpperCase(); };

/** The issuer Name's DER and the serial of a certificate, from its TBSCertificate. */
function issuerAndSerial(c: X509Certificate): { issuer: Buffer; serial: DerNode } {
  const tbs = derChildren(derRead(c.raw))[0];
  const p = derChildren(tbs);
  const i = p[0].tag === 0xa0 ? 1 : 0;
  return { serial: p[i], issuer: derRaw(p[i + 2]) };
}

const issuedBy = (child: X509Certificate, parent: X509Certificate) => { try { return child.checkIssued(parent) && child.verify(parent.publicKey); } catch { return false; } };
const validAt = (c: X509Certificate, now: Date) => new Date(c.validFrom).getTime() <= now.getTime() && now.getTime() < new Date(c.validTo).getTime();

export function verifyDetachedCms(sigDer: Buffer, content: Buffer, trust: Trust, now: Date): CmsVerdict {
  if (!sigDer.length || sigDer.length > MAX_CMS_BYTES) return { ok: false, reason: 'malformed' };
  let signer: X509Certificate | undefined;
  let digest: (typeof DIGESTS)[string];
  try {
    const der = berToDer(sigDer);
    const ci = derRead(der);
    if (ci.tag !== 0x30 || ci.start + ci.header + ci.length !== der.length) return { ok: false, reason: 'malformed' };
    const [ctype, wrapped] = derChildren(ci);
    if (!ctype || oidOf(ctype) !== OID.signedData || !wrapped || wrapped.tag !== 0xa0) return { ok: false, reason: 'not_signed_data' };
    const sd = derChildren(wrapped)[0];
    if (!sd || sd.tag !== 0x30) return { ok: false, reason: 'malformed' };
    const parts = derChildren(sd);
    // version, digestAlgorithms, encapContentInfo, [0] certificates?, [1] crls?, signerInfos
    const encap = parts[2];
    if (!encap || encap.tag !== 0x30) return { ok: false, reason: 'malformed' };
    const ec = derChildren(encap);
    if (oidOf(ec[0]) !== OID.data) return { ok: false, reason: 'content_type_mismatch' };
    if (ec.length > 1) return { ok: false, reason: 'not_detached' };
    const certNode = parts.slice(3).find((p) => p.tag === 0xa0);
    const signerInfos = parts[parts.length - 1];
    if (!signerInfos || signerInfos.tag !== 0x31) return { ok: false, reason: 'malformed' };
    const infos = derChildren(signerInfos);
    if (infos.length !== 1) return { ok: false, reason: 'signer_count' };
    const certs = certNode ? derChildren(certNode).filter((c) => c.tag === 0x30).map((c) => new X509Certificate(derRaw(c))) : [];
    if (certs.length > 8) return { ok: false, reason: 'malformed' };

    const si = derChildren(infos[0]);
    // version, sid, digestAlgorithm, [0] signedAttrs?, signatureAlgorithm, signature, [1] unsignedAttrs?
    const sid = si[1];
    if (!sid || sid.tag !== 0x30) return { ok: false, reason: 'signer_not_found' }; // a SubjectKeyIdentifier sid is not used here
    const [sidIssuer, sidSerial] = derChildren(sid);
    const wantSerial = serialHex(sidSerial);
    const wantIssuer = derRaw(sidIssuer);
    signer = certs.find((c) => { const x = issuerAndSerial(c); return serialHex(x.serial) === wantSerial && x.issuer.equals(wantIssuer); });
    if (!signer) return { ok: false, reason: 'signer_not_found' };

    digest = DIGESTS[oidOf(derChildren(si[2])[0])];
    if (!digest) return { ok: false, reason: 'digest_unsupported' };
    let idx = 3;
    const attrs = si[idx].tag === 0xa0 ? si[idx++] : null;
    const sigAlg = oidOf(derChildren(si[idx++])[0]);
    const sigNode = si[idx];
    if (!sigNode || sigNode.tag !== 0x04) return { ok: false, reason: 'malformed' };
    const keyType = signer.publicKey.asymmetricKeyType;
    if (!((keyType === 'rsa' && RSA_SIGS.has(sigAlg as never)) || (keyType === 'ec' && EC_SIGS.has(sigAlg as never)))) return { ok: false, reason: 'signature_unsupported' };

    const bodyDigest = createHash(digest).update(content).digest();
    let signed: Buffer;
    if (attrs) {
      let md: Buffer | null = null, ct: string | null = null, mdCount = 0, ctCount = 0;
      for (const a of derChildren(attrs)) {
        const [t, vals] = derChildren(a);
        const type = oidOf(t);
        const v = derChildren(vals);
        if (type === OID.messageDigest) { mdCount++; if (v.length === 1 && v[0].tag === 0x04) md = derContent(v[0]); }
        if (type === OID.contentType) { ctCount++; if (v.length === 1) ct = oidOf(v[0]); }
      }
      if (mdCount !== 1 || ctCount !== 1 || ct !== OID.data) return { ok: false, reason: 'content_type_mismatch' };
      if (!md || md.length !== bodyDigest.length || !timingSafeEqual(md, bodyDigest)) return { ok: false, reason: 'digest_mismatch' };
      signed = Buffer.concat([Buffer.from([0x31]), derRaw(attrs).subarray(1)]);
    } else {
      signed = content;
    }
    if (!verify(digest, signed, signer.publicKey, derContent(sigNode))) return { ok: false, reason: 'bad_signature' };

    // The certificate and its chain.
    if (now.getTime() < new Date(signer.validFrom).getTime()) return { ok: false, reason: 'certificate_not_yet_valid' };
    if (now.getTime() >= new Date(signer.validTo).getTime()) return { ok: false, reason: 'certificate_expired' };
    if (signer.ca) return { ok: false, reason: 'certificate_is_ca' };
    const eku = signer.keyUsage; // node: the extended key usages, or undefined when the extension is absent
    if (eku && !eku.includes(OID.clientAuth) && !eku.includes(OID.anyEku)) return { ok: false, reason: 'certificate_usage' };
    const pool = [...trust.intermediates, ...certs.filter((c) => c.ca)].filter((c) => validAt(c, now));
    let cur = signer;
    for (let step = 0; step < MAX_CHAIN; step++) {
      const root = trust.roots.find((r) => r.ca && validAt(r, now) && issuedBy(cur, r));
      if (root) return { ok: true, signer, signerSha256: sha256Hex(signer.raw), digest };
      const up = pool.find((c) => c !== cur && !c.raw.equals(cur.raw) && issuedBy(cur, c));
      if (!up) break;
      cur = up;
    }
    return { ok: false, reason: 'untrusted' };
  } catch {
    return { ok: false, reason: 'malformed' };
  }
}

// ── Signing (the enrollment profile) ──────────────────────────────────────

const SHA256 = '2.16.840.1.101.3.4.2.1';
const ECDSA_SHA256 = '1.2.840.10045.4.3.2';

/**
 * An attached SignedData over `content` (SHA-256, signed attributes:
 * content-type, signing-time, message-digest), with the signer's certificate
 * and `chain` in the certificate set. RSA (PKCS#1 v1.5) or EC keys.
 */
export function signAttachedCms(content: Buffer, s: { cert: X509Certificate; key: KeyObject; chain: X509Certificate[] }, now: Date): Buffer {
  const keyType = s.key.asymmetricKeyType;
  if (keyType !== 'rsa' && keyType !== 'ec') throw new Error('cms: RSA or EC keys only');
  const digestAlg = seq(oid(SHA256));
  const attr = (type: string, value: Buffer) => seq(oid(type), set(value));
  const encoded = [
    attr(OID.contentType, oid(OID.data)),
    attr(OID.signingTime, derTime(now)),
    attr(OID.messageDigest, octets(createHash('sha256').update(content).digest())),
  ].sort(Buffer.compare); // DER: a SET OF is sorted by encoding
  const signedAttrsSet = set(...encoded);
  const signature = sign('sha256', signedAttrsSet, s.key);
  const { issuer, serial } = issuerAndSerial(s.cert);
  const signerInfo = seq(
    derInt(1),
    seq(issuer, derRaw(serial)),
    digestAlg,
    Buffer.concat([Buffer.from([0xa0]), signedAttrsSet.subarray(1)]),
    keyType === 'rsa' ? seq(oid(OID.rsaEncryption), derNull()) : seq(oid(ECDSA_SHA256)),
    octets(signature),
  );
  const certs = [s.cert, ...s.chain.filter((c) => !c.raw.equals(s.cert.raw))].map((c) => Buffer.from(c.raw));
  const signedData = seq(
    derInt(1),
    set(digestAlg),
    seq(oid(OID.data), ctx(0, false, octets(content))),
    ctx(0, false, ...certs),
    set(signerInfo),
  );
  return seq(oid(OID.signedData), ctx(0, false, signedData));
}
