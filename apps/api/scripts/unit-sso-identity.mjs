#!/usr/bin/env node
/**
 * 0.59 "Agit8or Identity P0": the decisions SSO makes from an identity
 * provider's claims (sso/identity-policy.ts), assertFresh's phishing-
 * resistant rule, the two new confirm-catalog keys, and the separation of
 * session, integration and IdP tokens. No database, no network. Needs
 * `nest build` (dist/).
 *
 * The behavioural proof over HTTP, against a loopback mock provider, is
 * e2e-sso-identity.mjs.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = (f) => {
  for (const base of [path.join(here, '..', 'dist'), path.join(here, '..', 'dist', 'src')]) {
    try { return require(path.join(base, f)); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
  }
  throw new Error(`dist/${f} not found: run nest build first`);
};
const P = dist('sso/identity-policy.js');
const R = dist('security-controls/review.js');
const C = dist('security-controls/confirm-catalog.js');

let pass = 0; const fails = [];
const check = (name, ok, detail = '') => { if (ok) pass++; else fails.push(name); console.log(`${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `\n    ${detail}`}`); };
const code = (e) => e?.response?.code ?? e?.getResponse?.()?.code;
const throwsCode = (f, want) => { try { f(); return false; } catch (e) { return code(e) === want; } };

// ── Levels: acr, corroborated by amr ────────────────────────────────────────
const L = { password: '1', mfa: '2', passkey: '3' };
check('unknown or missing acr is level none', P.assessLevel(L, undefined, ['pwd']) === 'none' && P.assessLevel(L, 'gold', ['otp']) === 'none' && P.assessLevel(L, 7, ['otp']) === 'none');
check('acr password is password', P.assessLevel(L, '1', ['pwd']) === 'password');
check('acr mfa with a second factor in amr is mfa', P.assessLevel(L, '2', ['pwd', 'otp']) === 'mfa' && P.assessLevel(L, '2', ['mfa']) === 'mfa');
check('acr mfa with only pwd in amr is lowered to password', P.assessLevel(L, '2', ['pwd']) === 'password');
check('acr mfa with no amr at all is lowered to password', P.assessLevel(L, '2', undefined) === 'password' && P.assessLevel(L, '2', 'otp') === 'password');
check('acr passkey with hwk is passkey', P.assessLevel(L, '3', ['hwk']) === 'passkey' && P.assessLevel(L, '3', ['pop']) === 'passkey');
check('acr passkey with only otp is lowered to mfa', P.assessLevel(L, '3', ['pwd', 'otp']) === 'mfa');
check('acr passkey with only pwd is lowered to password', P.assessLevel(L, '3', ['pwd']) === 'password');
check('an unconfigured level is never recognised', P.assessLevel({ password: '1', mfa: null, passkey: null }, '2', ['otp']) === 'none');
check('amr is capped and only strings count', P.amrList(['a', 1, null, 'b', ...Array(40).fill('x')]).length === 16 && P.amrList('otp').length === 0);
check('meets() orders the levels', P.meets('passkey', 'mfa') && P.meets('mfa', 'mfa') && !P.meets('password', 'mfa') && !P.meets('none', 'password'));

// ── Organization gate ───────────────────────────────────────────────────────
check('organization: no claim refuses', !P.orgClaimMatches(undefined, 'org-a') && !P.orgClaimMatches(null, 'org-a'));
check('organization: array of aliases', P.orgClaimMatches(['org-b', 'org-a'], 'org-a') && !P.orgClaimMatches(['org-b'], 'org-a'));
check('organization: object keyed by alias, or carrying the id', P.orgClaimMatches({ acme: { id: 'org-a' } }, 'org-a') && P.orgClaimMatches({ 'org-a': {} }, 'org-a') && !P.orgClaimMatches({ acme: { id: 'org-b' } }, 'org-a'));
check('organization: a single string', P.orgClaimMatches('org-a', 'org-a') && !P.orgClaimMatches('org-ab', 'org-a'));
check('organization: a substring or prototype key does not match', !P.orgClaimMatches(['org-ab'], 'org-a') && !P.orgClaimMatches({}, 'constructor'));
check('organization: no binding admits anyone', P.orgClaimMatches(undefined, ''));

// ── Platform Admin, MFA trust ───────────────────────────────────────────────
check('Platform Admin: refused when the provider does not allow it, at any level', P.platformAdminDecision({ allowPlatformAdmin: false }, 'passkey').code === 'admin_not_allowed');
check('Platform Admin: allowed only at the passkey level', P.platformAdminDecision({ allowPlatformAdmin: true }, 'mfa').code === 'admin_needs_passkey' && P.platformAdminDecision({ allowPlatformAdmin: true }, 'passkey').ok === true);
check('IdP MFA counts only when trusted and at mfa or above', !P.idpMfaSatisfies({ trustIdpMfa: false }, 'passkey') && !P.idpMfaSatisfies({ trustIdpMfa: true }, 'password') && P.idpMfaSatisfies({ trustIdpMfa: true }, 'mfa'));

// ── Step-up ─────────────────────────────────────────────────────────────────
const t0 = Date.now();
const su = (o) => P.stepUpDecision({ linkedUserId: 'u1', expectedUserId: 'u1', authTime: Math.floor(t0 / 1000) + 2, startedAt: t0, level: 'mfa', need: 'mfa', trustIdpPasskey: false, ...o });
check('step-up: the linked account, authenticated after the start, at mfa → sso-mfa', su({}).ok === true && su({}).method === 'sso-mfa');
check('step-up: another account\'s identity is refused', su({ linkedUserId: 'u2' }).code === 'step_up_wrong_identity' && su({ linkedUserId: null }).code === 'step_up_wrong_identity');
check('step-up: no auth_time is refused', su({ authTime: undefined }).code === 'step_up_no_auth_time' && su({ authTime: '123' }).code === 'step_up_no_auth_time');
check('step-up: an auth_time before the round trip began is refused', su({ authTime: Math.floor(t0 / 1000) - 60 }).code === 'step_up_not_fresh');
check('step-up: within the 5 s skew is accepted', su({ authTime: Math.floor(t0 / 1000) - 4 }).ok === true);
check('step-up: acr too low is refused', su({ level: 'password' }).code === 'step_up_too_weak' && su({ level: 'none' }).code === 'step_up_too_weak');
check('step-up: passkey asked, mfa proved → refused', su({ need: 'passkey', level: 'mfa', trustIdpPasskey: true }).code === 'step_up_too_weak');
check('step-up: passkey proved but provider not trusted for it → sso-mfa only, and a passkey request is refused',
  su({ level: 'passkey' }).method === 'sso-mfa' && su({ need: 'passkey', level: 'passkey', trustIdpPasskey: false }).code === 'step_up_passkey_not_trusted');
check('step-up: passkey proved from a trusted provider → sso-passkey', su({ need: 'passkey', level: 'passkey', trustIdpPasskey: true }).method === 'sso-passkey');

// ── assertFresh and the phishing-resistant rule ─────────────────────────────
check('assertFresh: sso-mfa is a step-up', (() => { try { R.assertFresh('sso-mfa', { action: 'sso.enforce' }); return true; } catch { return false; } })());
check('assertFresh: sso-mfa is not phishing-resistant', throwsCode(() => R.assertFresh('sso-mfa', { action: 'temporary.access', phishingResistant: true }), 'STEP_UP_REQUIRED'));
check('assertFresh: sso-passkey and passkey are phishing-resistant, nothing else',
  (() => { try { R.assertFresh('sso-passkey', { action: 'temporary.access', phishingResistant: true }); R.assertFresh('passkey', { action: 'temporary.access', phishingResistant: true }); return true; } catch { return false; } })()
    && [...R.PHISHING_RESISTANT_METHODS].sort().join() === 'passkey,sso-passkey');
check('assertFresh: no method asks for sso.enforce and breakglass.manage', throwsCode(() => R.assertFresh(null, { action: 'sso.enforce' }), 'STEP_UP_REQUIRED') && throwsCode(() => R.assertFresh(null, { action: 'breakglass.manage' }), 'STEP_UP_REQUIRED'));

// ── The catalog ─────────────────────────────────────────────────────────────
const cat = (k) => C.CONFIRM_CATALOG.find((f) => f.key === k);
check('catalog: sso.enforce and breakglass.manage are configurable keys defaulting to off (0.64), under Security & access',
  ['sso.enforce', 'breakglass.manage'].every((k) => cat(k)?.default === 'off' && cat(k)?.group === 'Security & access' && !C.ALWAYS_ASK_KEYS.includes(k)));
check('catalog: no key was added for the SSO step-up itself (it is a method)', !C.CONFIRM_KEYS.some((k) => /^sso\.step|stepup/.test(k)));

// ── Back-channel logout claims ──────────────────────────────────────────────
const now = Math.floor(Date.now() / 1000);
const H = { alg: 'RS256', typ: 'logout+jwt', kid: 'k1' };
const base = { iss: 'https://idp.example/realms/r', aud: 'rem0te', iat: now, jti: 'j-1', events: { [P.BACKCHANNEL_EVENT]: {} }, sid: 's-1' };
const lc = (h, c) => P.logoutClaimsDecision(h, c, { issuer: base.iss, clientId: 'rem0te', now });
check('logout token: a good one passes with sid', lc(H, base).ok === true && lc(H, base).sid === 's-1');
check('logout token: sub alone is enough', lc(H, { ...base, sid: undefined, sub: 'u' }).ok === true);
check('logout token: alg none / HS256 refused', lc({ ...H, alg: 'none' }, base).reason === 'alg' && lc({ ...H, alg: 'HS256' }, base).reason === 'alg');
check('logout token: a wrong typ is refused', lc({ ...H, typ: 'at+jwt' }, base).reason === 'typ');
check('logout token: wrong issuer refused', lc(H, { ...base, iss: 'https://other' }).reason === 'iss');
check('logout token: wrong audience refused; an array containing ours passes', lc(H, { ...base, aud: 'x' }).reason === 'aud' && lc(H, { ...base, aud: ['x', 'rem0te'] }).ok === true);
check('logout token: iat too old or in the future refused', lc(H, { ...base, iat: now - 3600 }).reason === 'iat' && lc(H, { ...base, iat: now + 3600 }).reason === 'iat' && lc(H, { ...base, iat: 'x' }).reason === 'iat');
check('logout token: an expired exp refused', lc(H, { ...base, exp: now - 3600 }).reason === 'exp');
check('logout token: no events, or the wrong event, refused', lc(H, { ...base, events: undefined }).reason === 'events' && lc(H, { ...base, events: { 'urn:other': {} } }).reason === 'events' && lc(H, { ...base, events: { [P.BACKCHANNEL_EVENT]: 'x' } }).reason === 'events');
check('logout token: a nonce is refused (it is not an ID token)', lc(H, { ...base, nonce: 'n' }).reason === 'nonce');
check('logout token: no jti refused', lc(H, { ...base, jti: undefined }).reason === 'jti');
check('logout token: neither sub nor sid refused', lc(H, { ...base, sid: undefined }).reason === 'sub_sid');

// ── Enforcement ─────────────────────────────────────────────────────────────
check('required refuses a linked account', P.localSignInRefused({ mode: 'required', linked: true, breakGlass: false }));
check('required does not refuse an unlinked account (it has no other way in)', !P.localSignInRefused({ mode: 'required', linked: false, breakGlass: false }));
check('break-glass is exempt from required', !P.localSignInRefused({ mode: 'required', linked: true, breakGlass: true }));
check('off and optional refuse nothing', !P.localSignInRefused({ mode: 'off', linked: true, breakGlass: false }) && !P.localSignInRefused({ mode: 'optional', linked: true, breakGlass: false }));
check('modes are exactly off, optional, required', JSON.stringify(P.SSO_MODES) === '["off","optional","required"]' && !P.isSsoMode('REQUIRED') && !P.isSsoMode(undefined));
check('at most two break-glass accounts', P.MAX_BREAK_GLASS === 2);

// ── Separation from Agit8or Connect ─────────────────────────────────────────
const idToken = { header: { alg: 'RS256', typ: 'JWT', kid: 'k' }, payload: { iss: 'https://kc.example/realms/r', aud: 'rem0te', sub: 'x', nonce: 'n', acr: '2' } };
const delegation = { header: { alg: 'EdDSA', kid: 'k1', typ: 'rem0te-delegation+jwt' }, payload: { iss: 'clientst0r', aud: 'rem0te', sub: 't1', org: 'o1', scope: 'jobs:submit', iat: now, exp: now + 60, jti: 'abcdefghijklmnop' } };
check('an ID token is recognised as an IdP token', P.looksLikeIdpToken(idToken.header, idToken.payload));
check('an EdDSA token with OIDC claims or a URL issuer is recognised too',
  P.looksLikeIdpToken({ alg: 'EdDSA', typ: 'rem0te-delegation+jwt' }, { iss: 'https://kc', sub: 'x' })
    && P.looksLikeIdpToken({ alg: 'EdDSA', typ: 'rem0te-delegation+jwt' }, { iss: 'p', azp: 'x' })
    && P.looksLikeIdpToken({ alg: 'EdDSA', typ: 'logout+jwt' }, { iss: 'p' }));
check('a real delegation token is not', !P.looksLikeIdpToken(delegation.header, delegation.payload));
check('the session strategy refuses anything with iss, aud, jti or scope (integration JWS, IdP tokens)',
  P.foreignSessionPayload(delegation.payload) && P.foreignSessionPayload(idToken.payload) && P.foreignSessionPayload({ sub: 'u', jti: 'x' }) && P.foreignSessionPayload(null));
check('a Rem0te session payload passes', !P.foreignSessionPayload({ sub: 'u', email: 'e', tenantId: null, roleType: null, isPlatformAdmin: false, mfaVerified: false, businessId: null, customerId: null, capabilities: [], iat: now, exp: now + 1 }));

// ── Wiring (source) ─────────────────────────────────────────────────────────
const src = (f) => readFileSync(path.join(here, '..', 'src', f), 'utf8');
check('JwtStrategy accepts HS256 only and refuses foreign payloads', /algorithms: \['HS256'\]/.test(src('auth/strategies/jwt.strategy.ts')) && /foreignSessionPayload\(payload\)/.test(src('auth/strategies/jwt.strategy.ts')));
check('the delegation check refuses an IdP token before its own checks', /looksLikeIdpToken\(parsed\.header/.test(src('integration/delegation.service.ts')));
check('the integration guard refuses any bearer token', /req\.headers\.authorization !== undefined\) throw E\.unauthenticated/.test(src('integration/integration-auth.guard.ts')));

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log(`  - ${f}`); process.exit(1); }
