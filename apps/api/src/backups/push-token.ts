/**
 * The St0r push token (0.81). Pure: node:crypto only.
 *
 *   rbk_<connection id>_<64 hex characters>
 *
 * The connection id says WHICH connection (and so which business) the token
 * claims; the secret proves it. Rem0te stores only SHA-256(secret), the way
 * deployment keys are stored (0.57): the token is shown once at creation and
 * can never be read back, by anyone, from the database or the API. Sealing it
 * reversibly (common/secret-box.ts) would let anyone holding ENCRYPTION_KEY
 * and a database copy push as St0r; a hash lets nobody. Secret-box is for a
 * credential Rem0te must SEND (a pull driver's); this one is only checked.
 *
 * The check compares the two hashes with timingSafeEqual, and the push
 * route's scope comes from the connection the id names, never from the body.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const TOKEN = /^rbk_([A-Za-z0-9]{8,64})_([0-9a-f]{64})$/;

export function newPushToken(connectionId: string): { token: string; hash: string; last4: string } {
  const secret = randomBytes(32).toString('hex');
  return { token: `rbk_${connectionId}_${secret}`, hash: hashSecret(secret), last4: secret.slice(-4) };
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** The connection id and secret from an `Authorization: Bearer rbk_…` header, or null for anything else. */
export function parsePushAuth(header: unknown): { connectionId: string; secret: string } | null {
  if (typeof header !== 'string' || header.length > 200) return null;
  const m = /^Bearer (\S+)$/.exec(header);
  const t = m ? TOKEN.exec(m[1]) : null;
  return t ? { connectionId: t[1], secret: t[2] } : null;
}

/** Constant-time: SHA-256 of the presented secret against the stored hash. A missing hash never matches. */
export function secretMatches(secret: string, storedHash: string | null): boolean {
  if (!storedHash || !/^[0-9a-f]{64}$/.test(storedHash)) {
    // Spend the same work so a missing connection and a wrong secret look alike.
    timingSafeEqual(Buffer.from(hashSecret(secret), 'hex'), Buffer.alloc(32));
    return false;
  }
  return timingSafeEqual(Buffer.from(hashSecret(secret), 'hex'), Buffer.from(storedHash, 'hex'));
}
