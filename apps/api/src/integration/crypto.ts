/**
 * Signing primitives for contract ticket-rmm-v1.
 *
 * Ed25519 only, through node:crypto — no algorithm negotiation, so there is
 * no `alg: none`, no RSA/HMAC confusion and no key-type downgrade to get
 * wrong. Every signature covers a domain-separated string, so a signature
 * made for one purpose (an HTTP request, an inference response, an event)
 * can never be replayed as another.
 */
import { createHash, createPublicKey, sign, verify, type KeyObject, timingSafeEqual } from 'crypto';

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Canonical JSON: object keys sorted by code unit, no whitespace, arrays in
 * order, `undefined` members dropped. Enough of RFC 8785 for the values this
 * contract carries (strings, safe integers, booleans, null, nested objects).
 * Non-finite or unsafe numbers are refused rather than silently rounded.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string': return JSON.stringify(value);
    case 'boolean': return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
        throw new Error('canonicalJson: number out of range');
      }
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`;
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
    }
    default:
      throw new Error(`canonicalJson: unsupported type ${typeof value}`);
  }
}

export function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}
export function fromB64url(s: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('not base64url');
  return Buffer.from(s, 'base64url');
}

export function ed25519PublicKey(pem: string): KeyObject {
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('key is not Ed25519');
  return key;
}

export function signEd25519(privateKey: KeyObject, message: string | Buffer): string {
  return b64url(sign(null, Buffer.isBuffer(message) ? message : Buffer.from(message, 'utf8'), privateKey));
}

export function verifyEd25519(publicKey: KeyObject, message: string | Buffer, signature: string): boolean {
  try {
    const sig = fromB64url(signature);
    if (sig.length !== 64) return false;
    return verify(null, Buffer.isBuffer(message) ? message : Buffer.from(message, 'utf8'), publicKey, sig);
  } catch {
    return false;
  }
}

// ── HTTP request signatures (both directions) ──────────────────────────────

export const HDR = {
  keyId: 'rem0te-key-id',
  timestamp: 'rem0te-timestamp',
  nonce: 'rem0te-nonce',
  signature: 'rem0te-signature',
  responseSignature: 'rem0te-response-signature',
} as const;

/**
 * The string an HTTP request signature covers. `audience` names the receiver,
 * so a request signed for one rem0te (or one ClientSt0r) is refused by every
 * other; the path includes the query string.
 */
export function requestSigningString(p: {
  audience: string; method: string; pathWithQuery: string; timestamp: string; nonce: string; bodySha256: string;
}): string {
  return ['rem0te-http-req-v1', p.audience, p.method.toUpperCase(), p.pathWithQuery, p.timestamp, p.nonce, p.bodySha256].join('\n');
}

/** A response signature binds the body to the nonce of the request it answers. */
export function responseSigningString(requestNonce: string, bodySha256: string): string {
  return ['rem0te-http-resp-v1', requestNonce, bodySha256].join('\n');
}

export function eventSigningString(event: unknown): string {
  return `rem0te-event-v1\n${canonicalJson(event)}`;
}

// ── JWS compact, EdDSA only ─────────────────────────────────────────────────

export interface ParsedJws { header: { alg: string; kid?: string; typ?: string }; payload: unknown; signingInput: string; signature: string }

export function parseJws(token: string): ParsedJws {
  if (typeof token !== 'string' || token.length > 4096) throw new Error('token too long');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('not a compact JWS');
  const header = JSON.parse(fromB64url(parts[0]).toString('utf8')) as ParsedJws['header'];
  const payload = JSON.parse(fromB64url(parts[1]).toString('utf8')) as unknown;
  return { header, payload, signingInput: `${parts[0]}.${parts[1]}`, signature: parts[2] };
}

export function signJws(privateKey: KeyObject, kid: string, payload: unknown, typ = 'rem0te-delegation+jwt'): string {
  const h = b64url(Buffer.from(JSON.stringify({ alg: 'EdDSA', kid, typ })));
  const p = b64url(Buffer.from(JSON.stringify(payload)));
  return `${h}.${p}.${signEd25519(privateKey, `${h}.${p}`)}`;
}

export function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** Alert events (v0.29) sign under their own prefix, so one can never be replayed as a job event or the reverse. */
export function alertEventSigningString(event: unknown): string {
  return `rem0te-alert-event-v1\n${canonicalJson(event)}`;
}
