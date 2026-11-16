/**
 * The decisions SSO sign-in, step-up and logout make from an identity
 * provider's claims (0.59, "Agit8or Identity P0"). Pure functions with no
 * imports, so `scripts/unit-sso-identity.mjs` runs them from dist without a
 * database and §72 can read them.
 *
 * The rule throughout: a claim from the provider is a GATE, never a grant.
 * An `organization` claim can refuse a sign-in but never gives access; an
 * `acr` can let Rem0te skip its own TOTP only when the provider is set to be
 * trusted for it AND `amr` corroborates it; nothing here ever makes anyone a
 * Platform Admin or adds a membership.
 */

/** What the provider proved, lowest to highest. */
export const LEVELS = ['none', 'password', 'mfa', 'passkey'] as const;
export type Level = (typeof LEVELS)[number];
export const rank = (l: Level): number => LEVELS.indexOf(l);

/**
 * `amr` values (RFC 8176) that corroborate each level. A provider saying
 * acr=mfa with amr=["pwd"] is believed at the password level only.
 *   mfa      a second factor, or the provider's own "mfa"
 *   passkey  proof of possession of a hardware-bound or WebAuthn key
 */
export const AMR_MFA: readonly string[] = ['mfa', 'otp', 'hwk', 'swk', 'sms', 'sc', 'pop', 'fpt', 'face', 'iris', 'retina', 'webauthn', 'passkey'];
export const AMR_PASSKEY: readonly string[] = ['hwk', 'pop', 'webauthn', 'passkey'];

/** The acr string configured for each level (OidcProvider.acrPassword / acrMfa / acrPasskey). */
export interface AcrLevels { password: string | null; mfa: string | null; passkey: string | null }

/** acr and level strings: printable ASCII, no spaces (acr_values is space-separated). */
export const ACR_RE = /^[\x21-\x7e]{1,128}$/;
/** A Keycloak Organization id (a UUID) or alias. */
export const ORG_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export function amrList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 64).slice(0, 16);
}

/** The level the provider's acr names, before corroboration. Unknown acr → none. */
export function acrLevel(levels: AcrLevels, acr: unknown): Level {
  if (typeof acr !== 'string' || !acr) return 'none';
  if (levels.passkey && acr === levels.passkey) return 'passkey';
  if (levels.mfa && acr === levels.mfa) return 'mfa';
  if (levels.password && acr === levels.password) return 'password';
  return 'none';
}

/**
 * The level Rem0te believes: the acr's level, lowered until `amr`
 * corroborates it. No amr at all corroborates nothing above password.
 */
export function assessLevel(levels: AcrLevels, acr: unknown, amr: unknown): Level {
  const claimed = acrLevel(levels, acr);
  const a = amrList(amr);
  const has = (set: readonly string[]) => a.some((x) => set.includes(x));
  if (claimed === 'passkey') {
    if (has(AMR_PASSKEY)) return 'passkey';
    if (has(AMR_MFA)) return 'mfa';
    return 'password';
  }
  if (claimed === 'mfa') return has(AMR_MFA) ? 'mfa' : 'password';
  return claimed;
}

/** Whether `got` meets `need`. */
export const meets = (got: Level, need: Level): boolean => rank(got) >= rank(need);

/**
 * Keycloak's `organization` claim, in any of the shapes it emits:
 *   ["alias", …]                          (default)
 *   { "alias": { "id": "<uuid>" }, … }    ("Add organization id")
 *   "alias"                               (single-valued mapper)
 * `bindOrgId` may be the alias or the id. No claim, or no match, refuses.
 */
export function orgClaimMatches(claim: unknown, bindOrgId: string): boolean {
  if (!bindOrgId) return true;
  if (typeof claim === 'string') return claim === bindOrgId;
  if (Array.isArray(claim)) return claim.some((x) => x === bindOrgId);
  if (claim && typeof claim === 'object') {
    for (const [k, v] of Object.entries(claim as Record<string, unknown>)) {
      if (k === bindOrgId) return true;
      if (v && typeof v === 'object' && (v as { id?: unknown }).id === bindOrgId) return true;
    }
  }
  return false;
}

/**
 * Whether a Platform Admin may finish an SSO sign-in. Off by default
 * (`allowPlatformAdmin`); when on, only at the passkey level.
 */
export function platformAdminDecision(p: { allowPlatformAdmin: boolean }, level: Level): { ok: true } | { ok: false; code: 'admin_not_allowed' | 'admin_needs_passkey' } {
  if (!p.allowPlatformAdmin) return { ok: false, code: 'admin_not_allowed' };
  if (!meets(level, 'passkey')) return { ok: false, code: 'admin_needs_passkey' };
  return { ok: true };
}

/** Whether this SSO sign-in counts as Rem0te's second factor. */
export function idpMfaSatisfies(p: { trustIdpMfa: boolean }, level: Level): boolean {
  return p.trustIdpMfa === true && meets(level, 'mfa');
}

/**
 * The step-up method an SSO round trip earns. `sso-passkey` (which assertFresh
 * accepts as phishing-resistant) only when the provider is trusted for it;
 * otherwise a passkey-level answer is still only `sso-mfa`.
 */
export function stepUpMethod(p: { trustIdpPasskey: boolean }, level: Level): 'sso-mfa' | 'sso-passkey' | null {
  if (meets(level, 'passkey') && p.trustIdpPasskey) return 'sso-passkey';
  if (meets(level, 'mfa')) return 'sso-mfa';
  return null;
}

/**
 * The step-up callback's checks, in order. `startedAt` is when the round trip
 * began (ms); `authTime` the ID token's auth_time (s). A small tolerance only
 * for clock skew between the two hosts.
 */
export const STEP_UP_SKEW_S = 5;
export function stepUpDecision(x: {
  linkedUserId: string | null; expectedUserId: string; authTime: unknown; startedAt: number;
  level: Level; need: 'mfa' | 'passkey'; trustIdpPasskey: boolean;
}): { ok: true; method: 'sso-mfa' | 'sso-passkey' } | { ok: false; code: string } {
  if (!x.linkedUserId || x.linkedUserId !== x.expectedUserId) return { ok: false, code: 'step_up_wrong_identity' };
  if (typeof x.authTime !== 'number' || !Number.isFinite(x.authTime)) return { ok: false, code: 'step_up_no_auth_time' };
  if (x.authTime + STEP_UP_SKEW_S < Math.floor(x.startedAt / 1000)) return { ok: false, code: 'step_up_not_fresh' };
  if (!meets(x.level, x.need)) return { ok: false, code: 'step_up_too_weak' };
  const method = stepUpMethod({ trustIdpPasskey: x.trustIdpPasskey }, x.level);
  if (!method) return { ok: false, code: 'step_up_too_weak' };
  if (x.need === 'passkey' && method !== 'sso-passkey') return { ok: false, code: 'step_up_passkey_not_trusted' };
  return { ok: true, method };
}

// ── Back-channel logout (OpenID Connect Back-Channel Logout 1.0, §2.4/§2.6) ──

export const BACKCHANNEL_EVENT = 'http://schemas.openid.net/event/backchannel-logout';
/** How old a logout token's iat may be, and how far in the future. */
export const LOGOUT_IAT_MAX_AGE_S = 300;
export const LOGOUT_IAT_SKEW_S = 60;
/** Signing algorithms a logout token may use. Never none, never HMAC. */
export const LOGOUT_ALGS: readonly string[] = ['RS256', 'PS256', 'ES256', 'EdDSA'];

/** Validate a logout token's header and claims (signature checked separately). */
export function logoutClaimsDecision(
  header: Record<string, unknown>, claims: Record<string, unknown>,
  expect: { issuer: string; clientId: string; now: number },
): { ok: true; sub: string | null; sid: string | null; jti: string; exp: number } | { ok: false; reason: string } {
  if (typeof header.alg !== 'string' || !LOGOUT_ALGS.includes(header.alg)) return { ok: false, reason: 'alg' };
  if (header.typ !== undefined && header.typ !== 'logout+jwt' && header.typ !== 'JWT') return { ok: false, reason: 'typ' };
  if (claims.iss !== expect.issuer) return { ok: false, reason: 'iss' };
  const aud = claims.aud;
  if (!(aud === expect.clientId || (Array.isArray(aud) && aud.includes(expect.clientId)))) return { ok: false, reason: 'aud' };
  const iat = claims.iat;
  if (typeof iat !== 'number' || iat > expect.now + LOGOUT_IAT_SKEW_S || iat < expect.now - LOGOUT_IAT_MAX_AGE_S) return { ok: false, reason: 'iat' };
  if (claims.exp !== undefined && (typeof claims.exp !== 'number' || claims.exp < expect.now - LOGOUT_IAT_SKEW_S)) return { ok: false, reason: 'exp' };
  const ev = claims.events;
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return { ok: false, reason: 'events' };
  const e = (ev as Record<string, unknown>)[BACKCHANNEL_EVENT];
  if (!e || typeof e !== 'object' || Array.isArray(e)) return { ok: false, reason: 'events' };
  // A logout token is not an ID token: it must never carry a nonce.
  if ('nonce' in claims) return { ok: false, reason: 'nonce' };
  if (typeof claims.jti !== 'string' || !claims.jti || claims.jti.length > 256) return { ok: false, reason: 'jti' };
  const sub = typeof claims.sub === 'string' && claims.sub ? claims.sub : null;
  const sid = typeof claims.sid === 'string' && claims.sid ? claims.sid : null;
  if (!sub && !sid) return { ok: false, reason: 'sub_sid' };
  const exp = typeof claims.exp === 'number' ? claims.exp : iat + LOGOUT_IAT_MAX_AGE_S;
  return { ok: true, sub, sid, jti: claims.jti, exp };
}

// ── Enforcement ─────────────────────────────────────────────────────────────

export const SSO_MODES = ['off', 'optional', 'required'] as const;
export type SsoMode = (typeof SSO_MODES)[number];
export const isSsoMode = (v: unknown): v is SsoMode => typeof v === 'string' && (SSO_MODES as readonly string[]).includes(v);

/**
 * Whether a local sign-in (password, Rem0te passkey) is refused. Only under
 * `required`, only for an account linked to an enabled provider, and never
 * for a break-glass account.
 */
export function localSignInRefused(x: { mode: SsoMode; linked: boolean; breakGlass: boolean }): boolean {
  return x.mode === 'required' && x.linked && !x.breakGlass;
}

/** At most this many break-glass accounts (0080's trigger says the same). */
export const MAX_BREAK_GLASS = 2;

// ── Separation from Agit8or Connect ─────────────────────────────────────────

/**
 * Whether a compact JWS looks like something an identity provider issued (an
 * ID, access or logout token): not EdDSA, a generic or OIDC `typ`, an issuer
 * that is a URL, or an OIDC-only claim. The integration's delegation tokens
 * are EdDSA, `typ: rem0te-delegation+jwt`, with a peer id as issuer.
 */
export const IDP_ONLY_CLAIMS: readonly string[] = ['nonce', 'azp', 'acr', 'amr', 'auth_time', 'sid', 'events', 'at_hash', 'c_hash', 'session_state', 'preferred_username', 'typ'];
export function looksLikeIdpToken(header: Record<string, unknown>, payload: unknown): boolean {
  if (header.alg !== 'EdDSA') return true;
  if (typeof header.typ === 'string' && /^(jwt|at\+jwt|logout\+jwt|id_token\+jwt|application\/at\+jwt)$/i.test(header.typ)) return true;
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as Record<string, unknown>;
  if (typeof p.iss === 'string' && /^https?:\/\//i.test(p.iss)) return true;
  return IDP_ONLY_CLAIMS.some((k) => k in p);
}

/**
 * Whether a payload the session strategy verified could be anything but a
 * Rem0te session token. Session tokens carry no iss, aud, jti or scope;
 * integration JWS and IdP tokens do.
 */
export const FOREIGN_SESSION_CLAIMS: readonly string[] = ['iss', 'aud', 'jti', 'scope', 'nonce', 'azp', 'events', 'req_sha256', 'org'];
export function foreignSessionPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return true;
  return FOREIGN_SESSION_CLAIMS.some((k) => k in (payload as Record<string, unknown>));
}
