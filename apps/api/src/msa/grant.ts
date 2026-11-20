/**
 * Managed Secure Access session grants (0.71, build step 3 of
 * docs/managed-secure-access.md, §3.2). Pure: node:crypto and zod only, no
 * Nest, no Prisma, no environment. The agent's verifier
 * (tools/windows-installer/internal/msa/grant) implements the same document,
 * the same prefix and the same reason codes, and both are tested against one
 * fixture (internal/msa/testdata/msa-grants.json, made by
 * scripts/gen-msa-grant-fixture.mjs from this module).
 *
 * A grant is one small JSON document, serialised in ONE canonical form — the
 * fixed key order below, no whitespace, every string inside a strict charset
 * so nothing is ever escaped — and signed with Ed25519 over
 * GRANT_PREFIX + those bytes. A verifier re-serialises what it parsed and
 * refuses anything that is not byte-for-byte canonical, so two documents
 * can never mean the same thing.
 *
 * In 0.71 nothing delivers a grant to an agent that acts on it: the agent
 * build carries no poller and does not import the Go verifier (§81).
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from 'node:crypto';
import { z } from 'zod';

/** Signing prefix: domain separation from every other signature in Rem0te. The Go verifier's constant is identical (§81). */
export const GRANT_PREFIX = 'rem0te-msa-grant-v1\n';
export const GRANT_VERSION = 1;

export const MODES = ['view', 'control'] as const;
export type GrantMode = (typeof MODES)[number];
export const CONSENTS = ['required', 'not_required'] as const;
export type GrantConsent = (typeof CONSENTS)[number];
/** In canonical order. */
export const PERMISSION_KEYS = ['clipboard', 'files', 'audio', 'tunnel', 'restart'] as const;
export type GrantPermissions = Record<(typeof PERMISSION_KEYS)[number], boolean>;

/** notAfter is at most this long after notBefore: the window to START a session. */
export const MAX_START_WINDOW_MS = 5 * 60_000;
export const MAX_MINUTES_MIN = 1;
export const MAX_MINUTES_MAX = 480;
export const IDLE_MINUTES_MIN = 1;
export const IDLE_MINUTES_MAX = 120;
/** How far a computer's clock may disagree with the portal's, on either edge of the window. */
export const CLOCK_SKEW_MS = 30_000;

/** A grant id: 32 lowercase hex characters (16 random bytes). */
export const GRANT_ID_RE = /^[0-9a-f]{32}$/;
/** Endpoint, business and user ids (cuid). */
export const ENTITY_ID_RE = /^[a-z0-9]{20,40}$/;
export const RUSTDESK_ID_RE = /^[0-9]{6,15}$/;
/** RFC 3339, UTC, whole seconds: one spelling per instant. */
export const TIME_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;
/** The one-time password: 24 characters from a 62-letter alphabet (~143 bits), nothing RustDesk or a shell could read specially. */
export const PASSWORD_RE = /^[A-Za-z0-9]{24}$/;
export const PASSWORD_LENGTH = 24;
const PASSWORD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
/** A key id: the first 16 hex characters of the SHA-256 of the raw 32-byte public key. */
export const KEY_ID_RE = /^[0-9a-f]{16}$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
/** An envelope's grant is a few hundred bytes; anything far larger is refused before it is decoded. */
export const MAX_GRANT_BYTES = 2048;

const realInstant = (s: string) => { const t = Date.parse(s); return Number.isFinite(t) && isoSeconds(t) === s; };
const instant = z.string().regex(TIME_RE).refine(realInstant, 'not a real instant');

export const GrantDoc = z.strictObject({
  v: z.literal(GRANT_VERSION),
  grantId: z.string().regex(GRANT_ID_RE),
  endpointId: z.string().regex(ENTITY_ID_RE),
  rustdeskId: z.string().regex(RUSTDESK_ID_RE),
  businessId: z.string().regex(ENTITY_ID_RE),
  technicianId: z.string().regex(ENTITY_ID_RE),
  mode: z.enum(MODES),
  permissions: z.strictObject({ clipboard: z.boolean(), files: z.boolean(), audio: z.boolean(), tunnel: z.boolean(), restart: z.boolean() }),
  consent: z.enum(CONSENTS),
  notBefore: instant,
  notAfter: instant,
  maxMinutes: z.number().int().min(MAX_MINUTES_MIN).max(MAX_MINUTES_MAX),
  idleMinutes: z.number().int().min(IDLE_MINUTES_MIN).max(IDLE_MINUTES_MAX),
  password: z.string().regex(PASSWORD_RE),
});
export type Grant = z.infer<typeof GrantDoc>;

export interface Envelope { keyId: string; grant: string; sig: string }

/**
 * Every refusal a verifier gives, in the order it checks. The Go verifier
 * has the same list in the same order (unit-msa-grants.mjs compares them).
 */
export const REASONS = [
  'envelope_malformed', 'unknown_key', 'bad_signature', 'grant_malformed', 'unsupported_version', 'bad_window',
  'wrong_endpoint', 'wrong_rustdesk_id', 'remote_paused', 'not_yet_valid', 'expired', 'replayed',
  'mode_not_allowed', 'permission_not_allowed',
] as const;
export type Reason = (typeof REASONS)[number];

/** The canonical bytes: the fixed key order, no whitespace. Every string is charset-checked, so JSON.stringify escapes nothing. */
export function canonicalGrant(g: Grant): Buffer {
  const ordered = {
    v: g.v, grantId: g.grantId, endpointId: g.endpointId, rustdeskId: g.rustdeskId, businessId: g.businessId, technicianId: g.technicianId,
    mode: g.mode,
    permissions: { clipboard: g.permissions.clipboard, files: g.permissions.files, audio: g.permissions.audio, tunnel: g.permissions.tunnel, restart: g.permissions.restart },
    consent: g.consent, notBefore: g.notBefore, notAfter: g.notAfter, maxMinutes: g.maxMinutes, idleMinutes: g.idleMinutes, password: g.password,
  };
  return Buffer.from(JSON.stringify(ordered), 'utf8');
}

/** Window rule, shared by issuance and verification: notBefore < notAfter ≤ notBefore + 5 min. */
export function windowOk(g: Pick<Grant, 'notBefore' | 'notAfter'>): boolean {
  const nb = Date.parse(g.notBefore), na = Date.parse(g.notAfter);
  return Number.isFinite(nb) && Number.isFinite(na) && na > nb && na - nb <= MAX_START_WINDOW_MS;
}

/** idleMinutes never exceeds maxMinutes. */
export function limitsOk(g: Pick<Grant, 'maxMinutes' | 'idleMinutes'>): boolean {
  return g.idleMinutes <= g.maxMinutes;
}

export function rawPublicKey(pub: KeyObject): Buffer {
  const der = pub.export({ format: 'der', type: 'spki' });
  // Ed25519 SPKI is a fixed 12-byte header followed by the 32-byte key.
  return Buffer.from(der.subarray(der.length - 32));
}

export function keyIdOf(raw32: Buffer): string {
  return createHash('sha256').update(raw32).digest('hex').slice(0, 16);
}

export function publicKeyFromRaw(raw32: Buffer): KeyObject {
  if (raw32.length !== 32) throw new Error('an Ed25519 public key is 32 bytes');
  return createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw32]), format: 'der', type: 'spki' });
}

/** A fresh grant key pair: PKCS#8 PEM (to be sealed), the raw public key (base64) and its key id. */
export function newGrantKey(): { privatePem: string; publicKey: string; keyId: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = rawPublicKey(publicKey);
  return { privatePem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), publicKey: raw.toString('base64'), keyId: keyIdOf(raw) };
}

export function newGrantId(): string { return randomBytes(16).toString('hex'); }

/** A one-time password, uniformly from the alphabet (rejection sampling, no modulo bias). */
export function newGrantPassword(): string {
  let out = '';
  while (out.length < PASSWORD_LENGTH) {
    for (const b of randomBytes(32)) {
      if (b < 248 && out.length < PASSWORD_LENGTH) out += PASSWORD_ALPHABET[b % 62];
    }
  }
  return out;
}

/** Seconds precision, UTC, the one spelling TIME_RE accepts. */
export function isoSeconds(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.000Z$/, 'Z');
}

/**
 * Sign a grant. Refuses (throws) a document that does not pass its own
 * schema, window and limit rules: the portal can never sign something the
 * agent would refuse as malformed.
 */
export function signGrant(g: Grant, privatePem: string, keyId: string): Envelope {
  const p = GrantDoc.safeParse(g);
  if (!p.success || !windowOk(p.data) || !limitsOk(p.data)) throw new Error('refusing to sign a malformed grant');
  if (!KEY_ID_RE.test(keyId)) throw new Error('bad key id');
  const bytes = canonicalGrant(p.data);
  const sig = sign(null, Buffer.concat([Buffer.from(GRANT_PREFIX, 'utf8'), bytes]), createPrivateKey(privatePem));
  return { keyId, grant: bytes.toString('base64'), sig: sig.toString('base64') };
}

export interface VerifyContext {
  /** keyId → raw 32-byte public key. */
  keys: ReadonlyMap<string, Buffer>;
  endpointId: string;
  rustdeskId: string;
  now: number;
  /** Grant ids already used on this computer. */
  seen: ReadonlySet<string>;
  /** The most this computer allows. */
  ceiling: { mode: GrantMode; permissions: GrantPermissions };
  /** The signed `remote` containment pause is in force. */
  remotePaused: boolean;
}
export type VerifyResult = { ok: true; grant: Grant } | { ok: false; reason: Reason };

function b64(s: unknown, max: number): Buffer | null {
  if (typeof s !== 'string' || s.length === 0 || s.length > max || s.length % 4 !== 0 || !B64_RE.test(s)) return null;
  const b = Buffer.from(s, 'base64');
  return b.toString('base64') === s ? b : null;
}

/**
 * The agent's checks, in the agent's order (REASONS). The portal uses it to
 * prove what it issues; the Go verifier is the one that will matter.
 */
export function verifyEnvelope(raw: unknown, ctx: VerifyContext): VerifyResult {
  const no = (reason: Reason): VerifyResult => ({ ok: false, reason });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return no('envelope_malformed');
  const e = raw as Record<string, unknown>;
  const fields = Object.keys(e).sort().join(',');
  if (fields !== 'grant,keyId,sig' || typeof e.keyId !== 'string' || !KEY_ID_RE.test(e.keyId)) return no('envelope_malformed');
  const bytes = b64(e.grant, Math.ceil(MAX_GRANT_BYTES / 3) * 4);
  const sig = b64(e.sig, 88);
  if (!bytes || !sig || sig.length !== 64) return no('envelope_malformed');
  const pub = ctx.keys.get(e.keyId);
  if (!pub || pub.length !== 32) return no('unknown_key');
  let good: boolean;
  try { good = verify(null, Buffer.concat([Buffer.from(GRANT_PREFIX, 'utf8'), bytes]), publicKeyFromRaw(pub), sig); } catch { good = false; }
  if (!good) return no('bad_signature');

  let doc: unknown;
  try { doc = JSON.parse(bytes.toString('utf8')); } catch { return no('grant_malformed'); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return no('grant_malformed');
  if ((doc as Record<string, unknown>).v !== GRANT_VERSION) return no('unsupported_version');
  const p = GrantDoc.safeParse(doc);
  if (!p.success || !limitsOk(p.data) || !canonicalGrant(p.data).equals(bytes)) return no('grant_malformed');
  const g = p.data;
  if (!windowOk(g)) return no('bad_window');
  if (g.endpointId !== ctx.endpointId) return no('wrong_endpoint');
  if (g.rustdeskId !== ctx.rustdeskId) return no('wrong_rustdesk_id');
  if (ctx.remotePaused) return no('remote_paused');
  if (ctx.now < Date.parse(g.notBefore) - CLOCK_SKEW_MS) return no('not_yet_valid');
  if (ctx.now > Date.parse(g.notAfter) + CLOCK_SKEW_MS) return no('expired');
  if (ctx.seen.has(g.grantId)) return no('replayed');
  if (g.mode === 'control' && ctx.ceiling.mode !== 'control') return no('mode_not_allowed');
  if (PERMISSION_KEYS.some((k) => g.permissions[k] && !ctx.ceiling.permissions[k])) return no('permission_not_allowed');
  return { ok: true, grant: g };
}
