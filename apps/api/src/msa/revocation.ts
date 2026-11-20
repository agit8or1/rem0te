/**
 * Managed Secure Access revocations (0.73, build step 5 of
 * docs/managed-secure-access.md, §3.4). Pure: node:crypto, zod and the grant
 * module only — no Nest, no Prisma, no environment.
 *
 * A revocation ends sessions on ONE computer. It is signed with the same
 * grant key as a grant, under its own prefix (domain separation: a grant
 * signature can never be read as a revocation, nor the reverse), in its own
 * envelope field (`revocation`, never `grant`). The agent's verifier
 * (tools/windows-installer/internal/msa/grant/revocation.go) implements the
 * same document, prefix and reason codes, and both are tested against one
 * fixture (internal/msa/testdata/msa-revocations.json, made by
 * scripts/gen-msa-grant-fixture.mjs from this module).
 *
 * A revocation only ever reduces: on the computer it ends the open session
 * when the session's grant is named, or — `all` — when the session's grant
 * started no later than the revocation was issued, and every grant it names
 * joins the agent's replay set, so a named grant still on its way is refused
 * when it arrives. Nothing in a revocation can grant, widen or extend.
 */
import { createPrivateKey, sign, verify } from 'node:crypto';
import { z } from 'zod';
import { CLOCK_SKEW_MS, ENTITY_ID_RE, GRANT_ID_RE, KEY_ID_RE, RUSTDESK_ID_RE, TIME_RE, isoSeconds, publicKeyFromRaw } from './grant';

/** Signing prefix. The Go verifier's RevocationPrefix is identical (§83). */
export const REVOCATION_PREFIX = 'rem0te-msa-revoke-v1\n';
export const REVOCATION_VERSION = 1;
/** How long a revocation is good for: longer than any grant can live (a 5-minute start window plus at most 480 minutes). */
export const REVOCATION_WINDOW_MS = 9 * 3_600_000;
/** At most this many grant ids in one revocation. */
export const REVOCATION_MAX_GRANTS = 20;
export const MAX_REVOCATION_BYTES = 2048;

const realInstant = (s: string) => { const t = Date.parse(s); return Number.isFinite(t) && isoSeconds(t) === s; };
const instant = z.string().regex(TIME_RE).refine(realInstant, 'not a real instant');

export const RevocationDoc = z.strictObject({
  v: z.literal(REVOCATION_VERSION),
  revocationId: z.string().regex(GRANT_ID_RE),
  endpointId: z.string().regex(ENTITY_ID_RE),
  rustdeskId: z.string().regex(RUSTDESK_ID_RE),
  all: z.boolean(),
  grantIds: z.array(z.string().regex(GRANT_ID_RE)).max(REVOCATION_MAX_GRANTS),
  issuedAt: instant,
  notAfter: instant,
});
export type Revocation = z.infer<typeof RevocationDoc>;

export interface RevocationEnvelope { keyId: string; revocation: string; sig: string }

/** Every refusal, in the order the verifier checks. The Go verifier's RevocationReasons is the same list in the same order. */
export const REVOCATION_REASONS = [
  'envelope_malformed', 'unknown_key', 'bad_signature', 'revocation_malformed', 'unsupported_version', 'bad_window',
  'wrong_endpoint', 'wrong_rustdesk_id', 'not_yet_valid', 'expired', 'replayed',
] as const;
export type RevocationReason = (typeof REVOCATION_REASONS)[number];

/** grantIds sorted, unique; at least one grant or `all`. */
export function shapeOk(r: Pick<Revocation, 'all' | 'grantIds'>): boolean {
  for (let i = 1; i < r.grantIds.length; i++) if (!(r.grantIds[i - 1] < r.grantIds[i])) return false;
  return r.all || r.grantIds.length > 0;
}

/** issuedAt < notAfter ≤ issuedAt + 9 h. */
export function revocationWindowOk(r: Pick<Revocation, 'issuedAt' | 'notAfter'>): boolean {
  const a = Date.parse(r.issuedAt), b = Date.parse(r.notAfter);
  return Number.isFinite(a) && Number.isFinite(b) && b > a && b - a <= REVOCATION_WINDOW_MS;
}

/** The canonical bytes: the fixed key order, no whitespace (every string is charset-checked, so nothing is escaped). */
export function canonicalRevocation(r: Revocation): Buffer {
  const ordered = {
    v: r.v, revocationId: r.revocationId, endpointId: r.endpointId, rustdeskId: r.rustdeskId,
    all: r.all, grantIds: [...r.grantIds], issuedAt: r.issuedAt, notAfter: r.notAfter,
  };
  return Buffer.from(JSON.stringify(ordered), 'utf8');
}

/** Sign a revocation. Refuses (throws) a document that does not pass its own rules. */
export function signRevocation(r: Revocation, privatePem: string, keyId: string): RevocationEnvelope {
  const p = RevocationDoc.safeParse(r);
  if (!p.success || !shapeOk(p.data) || !revocationWindowOk(p.data)) throw new Error('refusing to sign a malformed revocation');
  if (!KEY_ID_RE.test(keyId)) throw new Error('bad key id');
  const bytes = canonicalRevocation(p.data);
  const sig = sign(null, Buffer.concat([Buffer.from(REVOCATION_PREFIX, 'utf8'), bytes]), createPrivateKey(privatePem));
  return { keyId, revocation: bytes.toString('base64'), sig: sig.toString('base64') };
}

export interface RevocationContext {
  keys: ReadonlyMap<string, Buffer>;
  endpointId: string;
  rustdeskId: string;
  now: number;
  /** Revocation ids already acted on by this computer. */
  seen: ReadonlySet<string>;
}
export type RevocationResult = { ok: true; revocation: Revocation } | { ok: false; reason: RevocationReason };

const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
function b64(s: unknown, max: number): Buffer | null {
  if (typeof s !== 'string' || s.length === 0 || s.length > max || s.length % 4 !== 0 || !B64_RE.test(s)) return null;
  const b = Buffer.from(s, 'base64');
  return b.toString('base64') === s ? b : null;
}

/** The agent's checks, in the agent's order (REVOCATION_REASONS). */
export function verifyRevocation(raw: unknown, ctx: RevocationContext): RevocationResult {
  const no = (reason: RevocationReason): RevocationResult => ({ ok: false, reason });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return no('envelope_malformed');
  const e = raw as Record<string, unknown>;
  if (Object.keys(e).sort().join(',') !== 'keyId,revocation,sig' || typeof e.keyId !== 'string' || !KEY_ID_RE.test(e.keyId)) return no('envelope_malformed');
  const bytes = b64(e.revocation, Math.ceil(MAX_REVOCATION_BYTES / 3) * 4);
  const sig = b64(e.sig, 88);
  if (!bytes || !sig || sig.length !== 64) return no('envelope_malformed');
  const pub = ctx.keys.get(e.keyId);
  if (!pub || pub.length !== 32) return no('unknown_key');
  let good: boolean;
  try { good = verify(null, Buffer.concat([Buffer.from(REVOCATION_PREFIX, 'utf8'), bytes]), publicKeyFromRaw(pub), sig); } catch { good = false; }
  if (!good) return no('bad_signature');
  let doc: unknown;
  try { doc = JSON.parse(bytes.toString('utf8')); } catch { return no('revocation_malformed'); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return no('revocation_malformed');
  if ((doc as Record<string, unknown>).v !== REVOCATION_VERSION) return no('unsupported_version');
  const p = RevocationDoc.safeParse(doc);
  if (!p.success || !shapeOk(p.data) || !canonicalRevocation(p.data).equals(bytes)) return no('revocation_malformed');
  const r = p.data;
  if (!revocationWindowOk(r)) return no('bad_window');
  if (r.endpointId !== ctx.endpointId) return no('wrong_endpoint');
  if (r.rustdeskId !== ctx.rustdeskId) return no('wrong_rustdesk_id');
  if (ctx.now < Date.parse(r.issuedAt) - CLOCK_SKEW_MS) return no('not_yet_valid');
  if (ctx.now > Date.parse(r.notAfter) + CLOCK_SKEW_MS) return no('expired');
  if (ctx.seen.has(r.revocationId)) return no('replayed');
  return { ok: true, revocation: r };
}

/**
 * Whether a verified revocation ends the session open under `grant`: named,
 * or `all` and that grant started no later than the revocation was issued.
 * The Go side's Ends is the same rule.
 */
export function revocationEnds(r: Pick<Revocation, 'all' | 'grantIds' | 'issuedAt'>, grant: { grantId: string; notBefore: string }): boolean {
  if (r.grantIds.includes(grant.grantId)) return true;
  return r.all && Date.parse(grant.notBefore) <= Date.parse(r.issuedAt);
}
