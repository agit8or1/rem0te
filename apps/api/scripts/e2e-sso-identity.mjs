#!/usr/bin/env node
/**
 * End-to-end proof of 0.59 "Agit8or Identity P0" — the groundwork for
 * trusting a self-hosted Keycloak — against the real built API, a scratch
 * Postgres and a mock OpenID provider served here on loopback. No real
 * identity provider is ever called.
 *
 * The mock issues acr / amr / auth_time / sid / organization claims, refresh
 * tokens (and invalid_grant on demand), accepts private_key_jwt (verifying
 * the assertion against the key Rem0te publishes) and signs back-channel
 * logout tokens. It covers:
 *
 *   G-R1  a Platform Admin is refused through SSO by default, and allowed
 *         only at the passkey level when the provider allows it;
 *   G-R2  acr / amr / auth_time / sid are captured on an SsoSession;
 *         back-channel logout (signature, iss, aud, iat, events, nonce,
 *         jti replay, sub/sid) and RP-initiated logout;
 *   G-R3  an SSO-only account steps up through the provider (max_age=0,
 *         acr_values), with too-low acr, unproved amr, stale auth_time and
 *         another identity refused;
 *   G-R4  an SSO sign-in counts as MFA only when trusted and corroborated;
 *   G-R5  the login lockout survives an API restart (it is in the database);
 *   G-R6  ssoMode=required refuses password sign-in for linked accounts,
 *         needs every account linked and a fresh confirmation, and the
 *         recovery CLI lowers it; break-glass is exempt and alerted;
 *   and   the organization gate, private_key_jwt, the session safety-net
 *         (invalid_grant, fail-open, fail-closed), admin-confirmed linking,
 *         and the separation of session, integration and IdP tokens.
 *
 *   cd apps/api && npx nest build
 *   DATABASE_URL=postgresql://…/<scratch or test> node scripts/e2e-sso-identity.mjs
 *
 * Ports 3851 (API) and 3852 (mock provider). Fixtures are namespaced and removed.
 */
/* global URL, URLSearchParams */
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { createCipheriv, createHash, createHmac, createPublicKey, createSign, generateKeyPairSync, randomBytes, sign as csign, verify as cverify } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { authenticator } from 'otplib';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const DB = process.env.DATABASE_URL ?? '';
const dbName = DB.split('/').pop()?.split('?')[0] ?? '';
if (!/scratch|test/.test(dbName)) { console.error(`Refusing to run against database "${dbName}": name must contain "scratch" or "test".`); process.exit(2); }
const PORT = Number(process.env.SSO_ID_API_PORT ?? 3851);
const IDP_PORT = Number(process.env.SSO_ID_IDP_PORT ?? 3852);
for (const p of [PORT, IDP_PORT]) if (p < 3851 || p > 3853) { console.error(`Refusing port ${p}: this suite uses 3851–3853.`); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
const WEB = 'https://rmm.example.test';
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'sso-identity-e2e-password-1';

let pass = 0, fail = 0;
const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;
const j = (x) => (typeof x === 'string' ? x : JSON.stringify(x))?.slice(0, 300);
const b64u = (b) => Buffer.from(b).toString('base64url');
const sha256 = (b) => createHash('sha256').update(b).digest();
const nowS = () => Math.floor(Date.now() / 1000);

// ── The API ─────────────────────────────────────────────────────────────────

const JWT = randomBytes(32).toString('hex'), LTS = randomBytes(32).toString('hex'), ENC = randomBytes(32).toString('hex');
const env = {
  ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATABASE_URL: DB, JWT_SECRET: JWT, LAUNCHER_TOKEN_SECRET: LTS, ENCRYPTION_KEY: ENC,
  TRUSTED_PROXIES: 'loopback', HBBS_PRESENCE_HOST: '127.0.0.2', VERSION_FILE: path.resolve(here, '..', '..', '..', 'version.json'), FRONTEND_URL: WEB,
  OIDC_ALLOW_INSECURE_LOOPBACK: 'true', INTEGRATION_PEERS_FILE: '',
  MONITOR_SWEEP: 'off', CLIENT_UPDATE_SWEEP: 'off', PATCH_POLICY_SWEEP: 'off', METRIC_SWEEP: 'off', RETENTION_SWEEP: 'off',
  REPORT_SCHEDULE_SWEEP: 'off', CHAT_RETENTION_SWEEP: 'off', TRAY_SWEEP: 'off', SCRIPT_OUTPUT_SWEEP: 'off', AUTO_MIGRATION_SWEEP: 'off',
  GEOIP_DB_PATH: path.join(here, 'no-geoip.mmdb'), WINGET_INDEX_SWEEP: 'off', SNAPSHOT_SWEEP: 'off', AGENT_AUTO_UPDATE: 'off', AUDIT_SEALER: 'off', STALE_SWEEP: 'off',
  // The one sweep this suite needs, fast: every second, each session checked every second.
  SSO_SESSION_SWEEP: 'on', SSO_SESSION_SWEEP_SECONDS: '1', SSO_SESSION_CHECK_SECONDS: '1',
};
let api;
function startApi() {
  const p = spawn(process.execPath, [path.join(dist, 'main.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  p.log = ''; p.stdout.on('data', (d) => { p.log += d; }); p.stderr.on('data', (d) => { p.log += d; });
  return p;
}
async function waitUp() {
  for (let i = 0; i < 150; i++) { try { const r = await fetch(`${API}/health`); if (r.status < 500) return; } catch { /* */ } await sleep(300); }
  throw new Error(`api did not come up:\n${api.log.slice(-3000)}`);
}
async function stopApi() {
  if (api && api.exitCode === null) await new Promise((r) => { api.once('exit', r); api.kill('SIGTERM'); });
}

async function req(method, p, { cookie, body, headers = {}, form } = {}) {
  await sleep(40);
  const h = { 'x-forwarded-for': ip(), ...headers };
  if (cookie) h.cookie = cookie;
  let payload;
  if (form) { h['content-type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(form).toString(); }
  else if (body !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(p.startsWith('http') ? p : `${API}${p}`, { method, redirect: 'manual', headers: h, body: payload });
  const text = await r.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed, data: parsed?.data, location: r.headers.get('location') || '', setCookies: r.headers.getSetCookie?.() ?? [] };
}
const cookieVal = (setCookies, name) => { for (const c of setCookies) { const m = c.match(new RegExp(`^${name}=([^;]*)`)); if (m && m[1]) return m[1]; } return null; };
const errCode = (r) => r.body?.code ?? r.body?.message?.code ?? r.body?.error?.code;
const errAction = (r) => r.body?.action ?? r.body?.message?.action;
async function login(email, password = PW) {
  const r = await req('POST', '/auth/login', { body: { email, password } });
  const t = cookieVal(r.setCookies, 'access_token');
  if (!t) throw new Error(`login ${email}: ${r.status} ${j(r.body)}`);
  return `access_token=${t}`;
}
async function stepUp(cookie) {
  const r = await req('POST', '/auth/step-up', { cookie, body: { password: PW } });
  const t = cookieVal(r.setCookies, 'step_up');
  if (r.status !== 200 || !t) throw new Error(`step-up: ${r.status} ${j(r.body)}`);
  return `${cookie}; step_up=${t}`;
}
const claimsOf = (cookie) => JSON.parse(Buffer.from(cookie.replace(/^access_token=/, '').split(';')[0].split('.')[1], 'base64url').toString());

// ── Mock OpenID provider ────────────────────────────────────────────────────

const { privateKey: idpKey, publicKey: idpPub } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...idpPub.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' };
const idp = {
  issuer: `http://127.0.0.1:${IDP_PORT}`, next: null, codes: new Map(), refresh: new Map(), lastAuth: null, lastAuthorize: null,
  requireAuth: null, clientJwksUrl: null, down: false, refreshCalls: 0,
};
function sign(header, claims, key = idpKey) {
  const h = b64u(JSON.stringify(header));
  const p = b64u(JSON.stringify(claims));
  const s = createSign('RSA-SHA256').update(`${h}.${p}`).sign(key);
  return `${h}.${p}.${b64u(s)}`;
}
const jwt = (claims) => sign({ alg: 'RS256', typ: 'JWT', kid: 'k1' }, claims);
async function verifyClientAssertion(assertion, clientId) {
  try {
    const [h, p, s] = assertion.split('.');
    const header = JSON.parse(Buffer.from(h, 'base64url'));
    const claims = JSON.parse(Buffer.from(p, 'base64url'));
    if (header.alg !== 'ES256') return 'alg';
    // Cached like a real provider does, refetched only for an unknown kid.
    let k = idp.clientKeys?.find((x) => x.kid === header.kid);
    if (!k) { idp.clientKeys = (await (await fetch(idp.clientJwksUrl)).json()).keys; k = idp.clientKeys.find((x) => x.kid === header.kid); }
    if (!k) return 'kid';
    const ok = cverify('sha256', Buffer.from(`${h}.${p}`), { key: createPublicKey({ key: k, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
    if (!ok) return 'signature';
    if (claims.iss !== clientId || claims.sub !== clientId) return 'iss';
    if (claims.exp < nowS()) return 'exp';
    return null;
  } catch (e) { return `error ${e.message}`; }
}
const server = http.createServer((rq, rs) => {
  const u = new URL(rq.url, idp.issuer);
  const json = (code, o) => { rs.writeHead(code, { 'content-type': 'application/json' }); rs.end(JSON.stringify(o)); };
  if (u.pathname === '/.well-known/openid-configuration') {
    return json(200, {
      issuer: idp.issuer, authorization_endpoint: `${idp.issuer}/authorize`, token_endpoint: `${idp.issuer}/token`,
      jwks_uri: `${idp.issuer}/jwks`, end_session_endpoint: `${idp.issuer}/logout`, response_types_supported: ['code'], subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'], code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'private_key_jwt', 'none'],
      backchannel_logout_supported: true, backchannel_logout_session_supported: true, acr_values_supported: ['1', '2', '3'],
    });
  }
  if (u.pathname === '/jwks') return json(200, { keys: [jwk] });
  if (u.pathname === '/authorize') {
    const who = idp.next;
    const code = randomBytes(16).toString('hex');
    idp.lastAuthorize = Object.fromEntries(u.searchParams);
    idp.codes.set(code, { who, nonce: u.searchParams.get('nonce'), challenge: u.searchParams.get('code_challenge'), clientId: u.searchParams.get('client_id'), redirect: u.searchParams.get('redirect_uri') });
    const back = new URL(u.searchParams.get('redirect_uri'));
    back.searchParams.set('code', code);
    back.searchParams.set('state', u.searchParams.get('state'));
    rs.writeHead(302, { location: back.href }); return rs.end();
  }
  if (u.pathname === '/token' && rq.method === 'POST') {
    let data = '';
    rq.on('data', (c) => { data += c; });
    rq.on('end', async () => {
      const f = new URLSearchParams(data);
      if (idp.down) { rs.socket.destroy(); return; }
      const assertion = f.get('client_assertion');
      const auth = assertion ? 'private_key_jwt' : f.get('client_secret') ? 'client_secret_post' : 'none';
      idp.lastAuth = auth;
      if (assertion) {
        if (f.get('client_assertion_type') !== 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer') return json(401, { error: 'invalid_client' });
        const bad = await verifyClientAssertion(assertion, f.get('client_id'));
        if (bad) { idp.lastAuth = `private_key_jwt:${bad}`; return json(401, { error: 'invalid_client' }); }
      }
      if (idp.requireAuth && auth !== idp.requireAuth) return json(401, { error: 'invalid_client' });
      if (f.get('grant_type') === 'refresh_token') {
        idp.refreshCalls++;
        const rt = f.get('refresh_token');
        const st = idp.refresh.get(rt);
        if (!st || !st.valid) return json(400, { error: 'invalid_grant' });
        st.valid = false;
        const next = randomBytes(16).toString('hex');
        idp.refresh.set(next, { sub: st.sub, valid: true });
        return json(200, { access_token: randomBytes(12).toString('hex'), token_type: 'Bearer', expires_in: 300, refresh_token: next });
      }
      const c = idp.codes.get(f.get('code'));
      idp.codes.delete(f.get('code'));
      if (!c) return json(400, { error: 'invalid_grant' });
      if (b64u(sha256(f.get('code_verifier') || '')) !== c.challenge) return json(400, { error: 'invalid_grant', error_description: 'pkce' });
      if (f.get('redirect_uri') !== c.redirect) return json(400, { error: 'invalid_grant', error_description: 'redirect' });
      const t = nowS();
      const claims = { iss: idp.issuer, aud: c.clientId, sub: c.who.sub, nonce: c.nonce, iat: t, exp: t + 300, auth_time: t, ...c.who.claims };
      const refresh = randomBytes(16).toString('hex');
      idp.refresh.set(refresh, { sub: c.who.sub, valid: true });
      json(200, { access_token: randomBytes(12).toString('hex'), token_type: 'Bearer', expires_in: 300, id_token: jwt(claims), refresh_token: refresh });
    });
    return;
  }
  json(404, { error: 'not_found' });
});
await new Promise((r) => server.listen(IDP_PORT, '127.0.0.1', r));

/** One browser round trip to the callback. Returns the final redirect and cookies. */
async function roundTrip(startUrlOrPath, who, { cookie = '', post = false, body = {} } = {}) {
  idp.next = who;
  let r, state;
  if (post) {
    r = await req('POST', startUrlOrPath, { cookie, body });
    if (r.status !== 200) return { error: r, final: '', cookies: [] };
    state = cookieVal(r.setCookies, 'sso_state');
    r = { location: r.data.url };
  } else {
    r = await req('GET', startUrlOrPath);
    state = cookieVal(r.setCookies, 'sso_state');
    if (!state) return { final: r.location, cookies: [] };
  }
  const a = await fetch(r.location, { redirect: 'manual' });
  const cb = a.headers.get('location');
  const res = await req('GET', cb, { cookie: `sso_state=${state}` });
  return { final: res.location, cookies: res.setCookies, authorize: idp.lastAuthorize };
}
const ssoLogin = (pid, who) => roundTrip(`/auth/sso/${pid}/start`, who);
const sessionOf = (rt) => { const t = cookieVal(rt.cookies, 'access_token'); return t ? `access_token=${t}` : null; };
function logoutToken(claims = {}, header = {}, key = idpKey) {
  return sign({ alg: 'RS256', typ: 'logout+jwt', kid: 'k1', ...header }, {
    iss: idp.issuer, aud: CLIENT_ID, iat: nowS(), jti: randomBytes(12).toString('hex'),
    events: { 'http://schemas.openid.net/event/backchannel-logout': {} }, ...claims,
  }, key);
}
async function waitFor(fn, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(300); } return false; }

// ── Fixtures ────────────────────────────────────────────────────────────────

const CLIENT_ID = `rem0te-${sfx}`;
const created = { users: [], businesses: [], providers: [] };
const hash = await argon2.hash(PW, { type: argon2.argon2id });
async function mkUser(tag, extra = {}) {
  const u = await prisma.user.create({ data: { email: `si-${tag}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'SI', lastName: tag, status: 'ACTIVE', ...extra } });
  created.users.push(u.id);
  return u;
}
function sealTotp(secret) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', Buffer.from(ENC, 'hex'), iv);
  const e = Buffer.concat([c.update(secret, 'utf8'), c.final()]);
  return `${iv.toString('hex')}:${c.getAuthTag().toString('hex')}:${e.toString('hex')}`;
}
async function cleanup() {
  const prov = await prisma.user.findMany({ where: { email: { endsWith: `-${sfx}@test.invalid` } }, select: { id: true } });
  const ids = [...new Set([...created.users, ...prov.map((u) => u.id)])];
  await prisma.user.updateMany({ where: { id: { in: ids } }, data: { breakGlass: false } });
  await prisma.ssoSession.deleteMany({ where: { OR: [{ userId: { in: ids } }, { providerId: { in: created.providers } }] } });
  await prisma.ssoLinkSuggestion.deleteMany({ where: { OR: [{ userId: { in: ids } }, { providerId: { in: created.providers } }] } });
  await prisma.externalIdentity.deleteMany({ where: { OR: [{ userId: { in: ids } }, { providerId: { in: created.providers } }] } });
  await prisma.oidcLoginState.deleteMany({ where: { providerId: { in: created.providers } } });
  await prisma.oidcProvider.deleteMany({ where: { id: { in: created.providers } } });
  await prisma.loginLockout.deleteMany({ where: { userId: { in: ids } } });
  await prisma.userMfaMethod.deleteMany({ where: { userId: { in: ids } } });
  await prisma.securityAlert.deleteMany({ where: { OR: [{ identity: { in: ids.map((i) => `user:${i}`) } }, { identity: { in: created.providers.map((i) => `provider:${i}`) } }] } });
  await prisma.activityLog.updateMany({ where: { customerId: { in: created.businesses } }, data: { customerId: null } }).catch(() => undefined);
  await prisma.membership.deleteMany({ where: { userId: { in: ids } } });
  await prisma.customer.deleteMany({ where: { id: { in: created.businesses } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } }).catch((e) => console.error('cleanup users:', e.message));
}

try {
  api = startApi();
  await waitUp();
  const tenant = await prisma.tenant.findFirst({ where: { isActive: true }, orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  const biz = await prisma.customer.create({ data: { tenantId: tenant.id, name: `SSO Identity ${sfx}` } });
  created.businesses.push(biz.id);
  const userRole = await prisma.role.findFirst({ where: { tenantId: tenant.id, type: 'BUSINESS_USER' } });
  const ownerRole = await prisma.role.findFirst({ where: { tenantId: tenant.id, type: 'BUSINESS_OWNER' } });
  const admin = await mkUser('adam', { isPlatformAdmin: true });
  const admin2 = await mkUser('bree', { isPlatformAdmin: true });
  const admin3 = await mkUser('cato', { isPlatformAdmin: true });
  const admin4 = await mkUser('dax', { isPlatformAdmin: true });
  const owner = await mkUser('olive');
  const uma = await mkUser('uma');
  const vic = await mkUser('vic');
  const ssoOnly = await mkUser('sol', { passwordHash: `!sso-only:${randomBytes(8).toString('hex')}` });
  await prisma.membership.create({ data: { userId: owner.id, tenantId: tenant.id, customerId: biz.id, roleId: ownerRole.id, isActive: true } });
  for (const u of [uma, vic, ssoOnly]) await prisma.membership.create({ data: { userId: u.id, tenantId: tenant.id, customerId: biz.id, roleId: userRole.id, capabilities: ['computers:view'], isActive: true } });
  const cAdminUp = await stepUp(await login(admin.email));
  const cAdmin = cAdminUp.split('; step_up=')[0];

  // ─────────────────────────────────────────────────────────────────────────
  section('Provider settings: secure by default, Platform Admin + sso.configure');
  const redirectUri = `http://127.0.0.1:${PORT}/api/v1/auth/sso/callback`;
  let r = await req('POST', '/sso/providers', { cookie: cAdminUp, body: { name: `KC ${sfx}`, issuer: idp.issuer, clientId: CLIENT_ID, clientSecret: 'kc-secret', redirectUri } });
  check(r.status === 201, 'provider created', `${r.status} ${j(r.body)}`);
  const pid = r.data.id; created.providers.push(pid);
  const v0 = r.data;
  check(v0.tokenAuth === 'client_secret_post' && v0.trustIdpMfa === false && v0.trustIdpPasskey === false && v0.allowPlatformAdmin === false
    && v0.bindOrgId === null && v0.sessionCheckFailMode === 'open' && v0.hasClientKey === false && v0.acrLevels.mfa === null,
    'every new setting starts off (client_secret_post, nothing trusted, no admins, fail open)', j(v0));
  check(/\/api\/v1\/auth\/sso\/backchannel-logout$/.test(v0.backchannelLogoutUri) && v0.jwksUri.endsWith(`/auth/sso/${pid}/jwks.json`), 'the view names the back-channel logout and JWKS URLs to register', j(v0));
  r = await req('PATCH', `/sso/providers/${pid}`, { cookie: cAdmin, body: { trustIdpMfa: true } });
  check(r.status === 403 && errCode(r) === 'STEP_UP_REQUIRED' && errAction(r) === 'sso.configure', 'changing a setting needs sso.configure', `${r.status} ${j(r.body)}`);
  r = await req('PATCH', `/sso/providers/${pid}`, { cookie: cAdminUp, body: { trustIdpMfa: true } });
  check(r.status === 400, 'trusting IdP MFA without naming its acr value is refused', `${r.status} ${j(r.body)}`);
  r = await req('PATCH', `/sso/providers/${pid}`, { cookie: cAdminUp, body: { allowPlatformAdmin: true } });
  check(r.status === 400, 'allowing Platform Admins without a passkey acr value is refused', `${r.status} ${j(r.body)}`);
  r = await req('PATCH', `/sso/providers/${pid}`, { cookie: cAdminUp, body: { tokenAuth: 'private_key_jwt' } });
  check(r.status === 400, 'private_key_jwt without a generated key is refused', `${r.status} ${j(r.body)}`);
  r = await req('PATCH', `/sso/providers/${pid}`, { cookie: cAdminUp, body: { acrPassword: '1', acrMfa: '1' } });
  check(r.status === 400, 'two levels with the same acr value are refused', `${r.status}`);
  r = await req('PATCH', `/sso/providers/${pid}`, { cookie: cAdminUp, body: { acrPassword: '1', acrMfa: '2', acrPasskey: '3', enabled: true } });
  check(r.status === 200 && r.data.acrLevels.mfa === '2' && r.data.enabled, 'acr levels named, provider enabled', j(r.body));
  r = await req('GET', '/sso/providers', { cookie: await login(owner.email) });
  check(r.status === 403, 'a Business Owner cannot read provider settings', `${r.status}`);

  section('private_key_jwt: a key generated here, only its public half shown');
  r = await req('POST', `/sso/providers/${pid}/client-key`, { cookie: cAdmin });
  check(r.status === 403 && errCode(r) === 'STEP_UP_REQUIRED', 'generating a client key needs a fresh confirmation', `${r.status}`);
  r = await req('POST', `/sso/providers/${pid}/client-key`, { cookie: cAdminUp });
  const pub = r.data?.clientPublicJwk;
  check(r.status === 201 && pub?.kty === 'EC' && pub?.crv === 'P-256' && pub?.alg === 'ES256' && !('d' in pub) && r.data.clientKeyKid === pub.kid, 'a P-256 key: the public JWK and kid are returned', j(r.body));
  check(!/PRIVATE KEY|"d":/.test(JSON.stringify(r.body)), 'no private key material in the response');
  const stored = await prisma.oidcProvider.findUnique({ where: { id: pid } });
  check(stored.clientKeyEnc && !/BEGIN|PRIVATE/.test(stored.clientKeyEnc) && stored.clientKeyEnc.split(':').length === 3, 'the private key is stored sealed');
  r = await req('GET', `/auth/sso/${pid}/jwks.json`);
  check(r.status === 200 && r.body.keys?.length === 1 && r.body.keys[0].kid === pub.kid && !('d' in r.body.keys[0]), 'the public JWKS is served for the provider to fetch', j(r.body));
  idp.clientJwksUrl = `${API}/auth/sso/${pid}/jwks.json`;
  r = await req('PATCH', `/sso/providers/${pid}`, { cookie: cAdminUp, body: { tokenAuth: 'private_key_jwt' } });
  check(r.status === 200 && r.data.tokenAuth === 'private_key_jwt', 'switched to private_key_jwt', j(r.body));
  idp.requireAuth = 'private_key_jwt';

  // Link Uma directly (linking itself is 0.20's, proven by e2e-sso-passkeys).
  const link = (u, sub) => prisma.externalIdentity.create({ data: { userId: u.id, providerId: pid, issuer: idp.issuer, subject: sub, email: u.email } });
  await link(uma, `sub-uma-${sfx}`);
  let rt = await ssoLogin(pid, { sub: `sub-uma-${sfx}`, claims: { acr: '1', amr: ['pwd'], sid: `sid-uma-${sfx}` } });
  let cUma = sessionOf(rt);
  check(!!cUma && idp.lastAuth === 'private_key_jwt', 'signs in, the token request authenticated with a verified private_key_jwt assertion', `${rt.final} auth=${idp.lastAuth}`);

  section('G-R2: acr, amr, auth_time and sid captured on an SsoSession');
  const ss = await prisma.ssoSession.findFirst({ where: { userId: uma.id }, orderBy: { createdAt: 'desc' } });
  check(ss && ss.sid === `sid-uma-${sfx}` && ss.acr === '1' && j(ss.amr) === '["pwd"]' && ss.level === 'password' && ss.authTime instanceof Date && ss.sessionIat === claimsOf(cUma).iat,
    'the session row holds sid, acr, amr, auth_time, the level and the session iat', j(ss));
  check(ss.refreshTokenEnc && ss.refreshTokenEnc.split(':').length === 3 && ![...idp.refresh.keys()].some((k) => ss.refreshTokenEnc.includes(k)) && ss.idTokenEnc && !ss.idTokenEnc.includes('.'), 'refresh and ID tokens are stored sealed');

  section('Organization gate (a gate, never a grant)');
  r = await req('PATCH', `/sso/providers/${pid}`, { cookie: cAdminUp, body: { bindOrgId: 'org-a' } });
  check(r.status === 200 && r.data.bindOrgId === 'org-a', 'bound to organization org-a');
  rt = await ssoLogin(pid, { sub: `sub-uma-${sfx}`, claims: { organization: ['org-b'] } });
  check(/sso_error=org_mismatch/.test(rt.final) && !sessionOf(rt), 'the wrong organization is refused', rt.final);
  rt = await ssoLogin(pid, { sub: `sub-uma-${sfx}`, claims: {} });
  check(/sso_error=org_mismatch/.test(rt.final), 'no organization claim is refused', rt.final);
  rt = await ssoLogin(pid, { sub: `sub-uma-${sfx}`, claims: { organization: { acme: { id: 'org-a' } } } });
  check(!!sessionOf(rt), 'the bound organization (by id) signs in', rt.final);
  const meUma = await req('GET', '/auth/me', { cookie: sessionOf(rt) });
  check(meUma.data?.businessId === biz.id && meUma.data?.isPlatformAdmin === false, 'and grants nothing beyond the account\'s own access', j(meUma.data));

  section('G-R1: a Platform Admin through SSO');
  await link(admin, `sub-adam-${sfx}`);
  rt = await ssoLogin(pid, { sub: `sub-adam-${sfx}`, claims: { organization: ['org-a'], acr: '3', amr: ['hwk'] } });
  check(/sso_error=admin_not_allowed/.test(rt.final) && !sessionOf(rt), 'refused by default, even at the passkey level', rt.final);
  r = await req('PATCH', `/sso/providers/${pid}`, { cookie: cAdminUp, body: { allowPlatformAdmin: true } });
  check(r.status === 200 && r.data.allowPlatformAdmin === true, 'the provider allows Platform Admins');
  rt = await ssoLogin(pid, { sub: `sub-adam-${sfx}`, claims: { organization: ['org-a'], acr: '2', amr: ['pwd', 'otp'] } });
  check(/sso_error=admin_needs_passkey/.test(rt.final), 'then only at the passkey level: MFA is refused', rt.final);
  rt = await ssoLogin(pid, { sub: `sub-adam-${sfx}`, claims: { organization: ['org-a'], acr: '3', amr: ['pwd'] } });
  check(/sso_error=admin_needs_passkey/.test(rt.final), 'a passkey acr that amr does not corroborate is refused', rt.final);
  rt = await ssoLogin(pid, { sub: `sub-adam-${sfx}`, claims: { organization: ['org-a'], acr: '3', amr: ['hwk'] } });
  check(!!sessionOf(rt), 'a corroborated passkey sign-in is admitted', rt.final);
  r = await req('PATCH', `/sso/providers/${pid}`, { cookie: cAdminUp, body: { allowPlatformAdmin: false, bindOrgId: null } });

  section('G-R4: the provider\'s MFA counts only when trusted and corroborated');
  const totpSecret = authenticator.generateSecret();
  await prisma.userMfaMethod.create({ data: { userId: uma.id, type: 'TOTP', isActive: true, totpSecret: sealTotp(totpSecret) } });
  rt = await ssoLogin(pid, { sub: `sub-uma-${sfx}`, claims: { acr: '2', amr: ['pwd', 'otp'] } });
  check(rt.final.endsWith('/mfa') && !!cookieVal(rt.cookies, 'partial_token'), 'not trusted: Rem0te\'s own TOTP is still asked', rt.final);
  const partial = cookieVal(rt.cookies, 'partial_token');
  r = await req('POST', '/auth/mfa/verify', { cookie: `partial_token=${partial}`, body: { code: authenticator.generate(totpSecret) } });
  const afterTotp = cookieVal(r.setCookies, 'access_token');
  const bound = await prisma.ssoSession.findFirst({ where: { userId: uma.id }, orderBy: { createdAt: 'desc' } });
  check(r.status === 200 && afterTotp && bound.sessionIat === claimsOf(`access_token=${afterTotp}`).iat, 'after the TOTP code the SSO session is bound to the new session', `${r.status} ${j(bound)}`);
  await req('PATCH', `/sso/providers/${pid}`, { cookie: cAdminUp, body: { trustIdpMfa: true } });
  rt = await ssoLogin(pid, { sub: `sub-uma-${sfx}`, claims: { acr: '2', amr: ['pwd'] } });
  check(rt.final.endsWith('/mfa'), 'trusted, but amr does not corroborate MFA: TOTP still asked', rt.final);
  rt = await ssoLogin(pid, { sub: `sub-uma-${sfx}`, claims: { acr: '2', amr: ['pwd', 'otp'] } });
  cUma = sessionOf(rt);
  check(!!cUma && claimsOf(cUma).mfaVerified === true, 'trusted and corroborated: a full session with mfaVerified', rt.final);
  await prisma.userMfaMethod.deleteMany({ where: { userId: uma.id } });

  // ─────────────────────────────────────────────────────────────────────────
  section('G-R3: step-up through the provider');
  await link(ssoOnly, `sub-sol-${sfx}`);
  rt = await ssoLogin(pid, { sub: `sub-sol-${sfx}`, claims: { acr: '1', amr: ['pwd'] } });
  const cSol = sessionOf(rt);
  r = await req('POST', '/auth/step-up', { cookie: cSol, body: { password: 'anything-at-all' } });
  check(r.status === 401, 'an SSO-only account cannot step up with a password', `${r.status}`);
  r = await req('GET', '/auth/sso/step-up', { cookie: cSol });
  check(r.status === 200 && r.data.ssoOnly === true && r.data.providers.some((p) => p.id === pid && p.mfa && !p.passkey), 'it is offered the provider (MFA; passkey not trusted yet)', j(r.data));
  const suStart = (claims, body = {}, sub = `sub-sol-${sfx}`) => roundTrip('/auth/sso/step-up', { sub, claims }, { cookie: cSol, post: true, body: { returnTo: '/settings', ...body } });
  rt = await suStart({ acr: '2', amr: ['pwd', 'otp'] });
  const su = cookieVal(rt.cookies, 'step_up');
  check(/\/settings\?sso_step_up=ok$/.test(rt.final) && !!su, 'a fresh MFA-level answer issues the step-up cookie', rt.final);
  check(rt.authorize?.max_age === '0' && rt.authorize?.acr_values === '2' && rt.authorize?.prompt === 'login', 'the request asked for max_age=0, prompt=login and the MFA acr', j(rt.authorize));
  r = await req('GET', '/auth/step-up', { cookie: `${cSol}; step_up=${su}` });
  check(r.data?.active === true, 'the step-up is live for that session');
  r = await req('POST', `/auth/sso/${pid}/link`, { cookie: `${cSol}; step_up=${su}`, body: {} });
  check(r.status === 200, 'and satisfies an action asking sso.configure', `${r.status} ${j(r.body)}`);
  const lastSu = await prisma.activityLog.findFirst({ where: { actorId: ssoOnly.id, action: 'STEP_UP_VERIFIED' }, orderBy: { createdAt: 'desc' } });
  check(lastSu?.metadata?.method === 'sso-mfa', 'audited as sso-mfa', j(lastSu?.metadata));
  rt = await suStart({ acr: '1', amr: ['pwd'] });
  check(/sso_step_up_error=step_up_too_weak/.test(rt.final) && !cookieVal(rt.cookies, 'step_up'), 'acr too low is refused', rt.final);
  rt = await suStart({ acr: '2', amr: ['pwd'] });
  check(/sso_step_up_error=step_up_too_weak/.test(rt.final), 'an MFA acr that amr does not corroborate is refused', rt.final);
  rt = await suStart({ acr: '2', amr: ['otp'], auth_time: nowS() - 900 });
  check(/sso_step_up_error=step_up_not_fresh/.test(rt.final), 'an auth_time before the round trip began is refused', rt.final);
  rt = await suStart({ acr: '2', amr: ['otp'] }, {}, `sub-uma-${sfx}`);
  check(/sso_step_up_error=step_up_wrong_identity/.test(rt.final), 'another person\'s identity is refused', rt.final);
  r = await req('POST', '/auth/sso/step-up', { cookie: cSol, body: { phishingResistant: true } });
  check(r.status === 409 && errCode(r) === 'SSO_STEP_UP_UNAVAILABLE', 'a passkey step-up is not offered until the provider is trusted for passkeys', `${r.status} ${j(r.body)}`);
  await req('PATCH', `/sso/providers/${pid}`, { cookie: cAdminUp, body: { trustIdpPasskey: true } });
  rt = await suStart({ acr: '2', amr: ['otp'] }, { phishingResistant: true });
  check(/sso_step_up_error=step_up_too_weak/.test(rt.final), 'a passkey step-up answered at MFA is refused', rt.final);
  rt = await suStart({ acr: '3', amr: ['hwk'] }, { phishingResistant: true });
  check(!!cookieVal(rt.cookies, 'step_up') && rt.authorize?.acr_values === '3', 'a passkey-level answer from a trusted provider passes', rt.final);
  const lastPk = await prisma.activityLog.findFirst({ where: { actorId: ssoOnly.id, action: 'STEP_UP_VERIFIED' }, orderBy: { createdAt: 'desc' } });
  check(lastPk?.metadata?.method === 'sso-passkey', 'issued as sso-passkey (phishing-resistant)', j(lastPk?.metadata));

  // ─────────────────────────────────────────────────────────────────────────
  section('RP-initiated logout');
  rt = await ssoLogin(pid, { sub: `sub-uma-${sfx}`, claims: { acr: '2', amr: ['otp'], sid: `sid-out-${sfx}` } });
  let cOut = sessionOf(rt);
  r = await req('POST', '/auth/logout', { cookie: cOut });
  const rd = r.data?.redirectTo ? new URL(r.data.redirectTo) : null;
  check(r.status === 200 && rd && rd.origin + rd.pathname === `${idp.issuer}/logout` && rd.searchParams.get('id_token_hint')?.split('.').length === 3
    && rd.searchParams.get('post_logout_redirect_uri') === `${WEB}/login?signed_out=1` && rd.searchParams.get('client_id') === CLIENT_ID,
  'sign-out of an SSO session returns the provider\'s end-session URL with id_token_hint and the post-logout redirect', j(r.body));
  r = await req('GET', '/auth/me', { cookie: cOut });
  check(r.status === 401, 'and the session is ended here');
  r = await req('POST', '/auth/logout', { cookie: await login(vic.email) });
  check(r.status === 200 && r.data?.redirectTo === null, 'a password session signs out with no redirect');

  section('Back-channel logout');
  rt = await ssoLogin(pid, { sub: `sub-uma-${sfx}`, claims: { acr: '2', amr: ['otp'], sid: `sid-bc-${sfx}` } });
  cOut = sessionOf(rt);
  const bc = (token) => req('POST', '/auth/sso/backchannel-logout', { form: { logout_token: token } });
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  r = await bc(logoutToken({ sid: `sid-bc-${sfx}` }, {}, other));
  check(r.status === 400, 'a token signed by another key is refused', `${r.status}`);
  r = await bc(logoutToken({ sid: `sid-bc-${sfx}`, aud: 'someone-else' }));
  check(r.status === 400, 'a token for another client is refused', `${r.status}`);
  r = await bc(logoutToken({ sid: `sid-bc-${sfx}`, nonce: 'n' }));
  check(r.status === 400, 'a token carrying a nonce is refused', `${r.status}`);
  r = await bc(logoutToken({ sid: `sid-bc-${sfx}`, events: {} }));
  check(r.status === 400, 'a token without the back-channel event is refused', `${r.status}`);
  r = await bc(logoutToken({ sid: `sid-bc-${sfx}`, iat: nowS() - 3600 }));
  check(r.status === 400, 'a stale iat is refused', `${r.status}`);
  r = await bc(logoutToken({ sid: `sid-bc-${sfx}`, iss: 'http://127.0.0.1:1' }));
  check(r.status === 400, 'an unknown issuer is refused', `${r.status}`);
  const hs = `${b64u(JSON.stringify({ alg: 'HS256', typ: 'logout+jwt' }))}.${b64u(JSON.stringify({ iss: idp.issuer, aud: CLIENT_ID, iat: nowS(), jti: 'x', sid: `sid-bc-${sfx}`, events: { 'http://schemas.openid.net/event/backchannel-logout': {} } }))}`;
  r = await bc(`${hs}.${b64u(createHmac('sha256', CLIENT_ID).update(hs).digest())}`);
  check(r.status === 400, 'an HMAC-signed token is refused', `${r.status}`);
  r = await bc(`${b64u(JSON.stringify({ alg: 'none' }))}.${b64u(JSON.stringify({ iss: idp.issuer }))}.`);
  check(r.status === 400, 'alg none is refused', `${r.status}`);
  r = await req('GET', '/auth/me', { cookie: cOut });
  check(r.status === 200, 'the session survived every refused token');
  const good = logoutToken({ sid: `sid-bc-${sfx}` });
  r = await bc(good);
  check(r.status === 200, 'a valid logout_token (sid) is accepted', `${r.status} ${j(r.body)}`);
  r = await req('GET', '/auth/me', { cookie: cOut });
  check(r.status === 401, 'and the account\'s sessions are revoked', `${r.status}`);
  const bcAudit = await prisma.activityLog.findFirst({ where: { action: 'SSO_BACKCHANNEL_LOGOUT', resourceId: pid, actorId: uma.id }, orderBy: { createdAt: 'desc' } });
  check(bcAudit?.metadata?.outcome === 'ok' && bcAudit.metadata.users === 1 && bcAudit.metadata.bySid === true, 'audited SSO_BACKCHANNEL_LOGOUT', j(bcAudit?.metadata));
  r = await bc(good);
  check(r.status === 400, 'the same logout_token replayed is refused (jti used once)', `${r.status}`);
  const replayAudit = await prisma.activityLog.findFirst({ where: { action: 'SSO_BACKCHANNEL_LOGOUT', resourceId: pid }, orderBy: { createdAt: 'desc' } });
  check(replayAudit?.metadata?.reason === 'replay', 'the replay is audited as refused', j(replayAudit?.metadata));
  rt = await ssoLogin(pid, { sub: `sub-uma-${sfx}`, claims: { acr: '2', amr: ['otp'] } });
  cOut = sessionOf(rt);
  r = await bc(logoutToken({ sub: `sub-uma-${sfx}` }));
  check(r.status === 200 && (await req('GET', '/auth/me', { cookie: cOut })).status === 401, 'a sub-only logout_token ends the account\'s sessions too');

  // ─────────────────────────────────────────────────────────────────────────
  section('Session safety-net (SSO_SESSION_SWEEP)');
  // Failing closed ends the account's sessions, so only Uma's are left for the sweep to judge:
  // the admin who drives the rest of this suite signed in through SSO in G-R1.
  await prisma.ssoSession.updateMany({ where: { userId: { not: uma.id }, endedAt: null }, data: { endedAt: new Date(), endReason: 'test' } });
  rt = await ssoLogin(pid, { sub: `sub-uma-${sfx}`, claims: { acr: '2', amr: ['otp'] } });
  const cNet = sessionOf(rt);
  const before = idp.refreshCalls;
  check(await waitFor(() => idp.refreshCalls > before), 'the sweep tries the session\'s refresh token at the provider', `calls ${idp.refreshCalls}`);
  check((await req('GET', '/auth/me', { cookie: cNet })).status === 200, 'a good refresh keeps the session');
  idp.down = true;
  check(await waitFor(async () => (await prisma.securityAlert.count({ where: { kind: 'sso_session_check_failed', identity: `provider:${pid}` } })) > 0),
    'provider unreachable, failing open: a security alert is raised');
  check((await req('GET', '/auth/me', { cookie: cNet })).status === 200, 'and the session is kept (fail open, the default)');
  await req('PATCH', `/sso/providers/${pid}`, { cookie: cAdminUp, body: { sessionCheckFailMode: 'closed' } });
  check(await waitFor(async () => (await req('GET', '/auth/me', { cookie: cNet })).status === 401), 'set to fail closed: the session is ended');
  // The 401 can be seen a moment before the audit row lands, and two rows can
  // share a createdAt: wait for the newest row by the chain's seq.
  let closedAudit = null;
  await waitFor(async () => { closedAudit = await prisma.activityLog.findFirst({ where: { action: 'SSO_SESSION_REVOKED', actorId: uma.id }, orderBy: { seq: 'desc' } }); return closedAudit?.metadata?.reason === 'check_failed'; });
  check(closedAudit?.metadata?.reason === 'check_failed', 'audited SSO_SESSION_REVOKED (check_failed)', j(closedAudit?.metadata));
  idp.down = false;
  await req('PATCH', `/sso/providers/${pid}`, { cookie: cAdminUp, body: { sessionCheckFailMode: 'open' } });
  rt = await ssoLogin(pid, { sub: `sub-uma-${sfx}`, claims: { acr: '2', amr: ['otp'] } });
  const cGrant = sessionOf(rt);
  await sleep(1500);
  for (const st of idp.refresh.values()) if (st.sub === `sub-uma-${sfx}`) st.valid = false;
  check(await waitFor(async () => (await req('GET', '/auth/me', { cookie: cGrant })).status === 401), 'invalid_grant at the provider ends the session');
  // The 401 can be seen a moment before the audit row lands, and two rows can
  // share a createdAt: wait for the newest row by the chain's seq.
  let grantAudit = null;
  await waitFor(async () => { grantAudit = await prisma.activityLog.findFirst({ where: { action: 'SSO_SESSION_REVOKED', actorId: uma.id }, orderBy: { seq: 'desc' } }); return grantAudit?.metadata?.reason === 'invalid_grant'; });
  check(grantAudit?.metadata?.reason === 'invalid_grant', 'audited SSO_SESSION_REVOKED (invalid_grant)', j(grantAudit?.metadata));

  // ─────────────────────────────────────────────────────────────────────────
  section('Admin-confirmed linking (never automatic)');
  idp.requireAuth = null;
  rt = await ssoLogin(pid, { sub: `sub-vic-${sfx}`, claims: { email: vic.email, email_verified: true } });
  check(/sso_error=not_linked/.test(rt.final), 'an unlinked identity naming Vic\'s verified email is still refused', rt.final);
  const sug = await prisma.ssoLinkSuggestion.findFirst({ where: { userId: vic.id, providerId: pid } });
  check(sug?.status === 'PENDING' && (await prisma.externalIdentity.count({ where: { userId: vic.id } })) === 0, 'a pending suggestion is recorded, nothing is linked');
  rt = await ssoLogin(pid, { sub: `sub-unv-${sfx}`, claims: { email: owner.email, email_verified: false } });
  check(!(await prisma.ssoLinkSuggestion.findFirst({ where: { userId: owner.id } })), 'an unverified email suggests nothing');
  rt = await ssoLogin(pid, { sub: `sub-adm-${sfx}`, claims: { email: admin2.email, email_verified: true } });
  check(!(await prisma.ssoLinkSuggestion.findFirst({ where: { userId: admin2.id } })), 'a Platform Admin\'s email suggests nothing');
  r = await req('GET', '/sso/link-suggestions', { cookie: await login(owner.email) });
  check(r.status === 403, 'a Business Owner cannot list suggestions', `${r.status}`);
  r = await req('GET', '/sso/link-suggestions', { cookie: cAdmin });
  check(r.status === 200 && r.data.some((s) => s.id === sug.id && s.user.id === vic.id), 'a Platform Admin sees it', j(r.data));
  r = await req('POST', `/sso/link-suggestions/${sug.id}/confirm`, { cookie: cAdmin });
  check(r.status === 403 && errCode(r) === 'STEP_UP_REQUIRED' && errAction(r) === 'sso.configure', 'confirming needs a fresh confirmation (sso.configure)', `${r.status} ${j(r.body)}`);
  r = await req('POST', `/sso/link-suggestions/${sug.id}/confirm`, { cookie: cAdminUp });
  check(r.status === 200 && r.data.linked === true && r.data.notified === false, 'confirmed (no mail relay here, so nobody is emailed)', j(r.body));
  const linkAudit = await prisma.activityLog.findFirst({ where: { action: 'SSO_LINKED', actorId: admin.id }, orderBy: { createdAt: 'desc' } });
  check(linkAudit?.metadata?.by === 'admin' && linkAudit.metadata.userId === vic.id, 'audited SSO_LINKED {by: admin}', j(linkAudit?.metadata));
  r = await req('POST', `/sso/link-suggestions/${sug.id}/confirm`, { cookie: cAdminUp });
  check(r.status === 404, 'a suggestion is confirmed once', `${r.status}`);
  rt = await ssoLogin(pid, { sub: `sub-vic-${sfx}`, claims: {} });
  check(!!sessionOf(rt), 'Vic now signs in through the provider');

  // ─────────────────────────────────────────────────────────────────────────
  section('G-R6: ssoMode=required for a business');
  r = await req('GET', '/sso/enforcement', { cookie: cAdmin });
  const row = r.data?.businesses?.find((b) => b.id === biz.id);
  check(r.status === 200 && row?.mode === 'off' && row.unlinked === 1 && row.total === 4, 'the enforcement view counts the business\'s unlinked accounts', j(row));
  r = await req('PUT', `/sso/enforcement/${biz.id}`, { cookie: cAdmin, body: { mode: 'required' } });
  check(r.status === 403 && errCode(r) === 'STEP_UP_REQUIRED' && errAction(r) === 'sso.enforce', 'requiring SSO needs a fresh confirmation (sso.enforce)', `${r.status} ${j(r.body)}`);
  r = await req('PUT', `/sso/enforcement/${biz.id}`, { cookie: cAdminUp, body: { mode: 'required' } });
  check(r.status === 409 && errCode(r) === 'SSO_ENFORCE_UNLINKED', 'refused while an active account is unlinked', `${r.status} ${j(r.body)}`);
  await link(owner, `sub-olive-${sfx}`);
  r = await req('PUT', `/sso/enforcement/${biz.id}`, { cookie: cAdminUp, body: { mode: 'required' } });
  check(r.status === 200 && r.data.mode === 'required', 'set once every account is linked', `${r.status} ${j(r.body)}`);
  const modeAudit = await prisma.activityLog.findFirst({ where: { action: 'SSO_MODE_CHANGED', resourceId: biz.id }, orderBy: { createdAt: 'desc' } });
  check(modeAudit?.metadata?.before === 'off' && modeAudit.metadata.after === 'required', 'audited SSO_MODE_CHANGED', j(modeAudit?.metadata));
  r = await req('POST', '/auth/login', { body: { email: uma.email, password: PW } });
  check(r.status === 403 && errCode(r) === 'SSO_REQUIRED' && !cookieVal(r.setCookies, 'access_token'), 'a linked account\'s password sign-in is refused', `${r.status} ${j(r.body)}`);
  r = await req('POST', '/auth/login', { body: { email: uma.email, password: 'wrong-password-123' } });
  check(r.status === 401, 'a wrong password still says only "invalid credentials" (nothing about SSO)', `${r.status}`);
  await prisma.loginLockout.deleteMany({ where: { userId: uma.id } });
  rt = await ssoLogin(pid, { sub: `sub-uma-${sfx}`, claims: {} });
  const cUmaReq = sessionOf(rt);
  check(!!cUmaReq, 'the same account signs in through SSO');
  const ident = (await req('GET', '/auth/sso/identities', { cookie: cUmaReq })).data[0];
  rt = await roundTrip('/auth/sso/step-up', { sub: `sub-uma-${sfx}`, claims: { acr: '2', amr: ['otp'] } }, { cookie: cUmaReq, post: true, body: {} });
  r = await req('DELETE', `/auth/sso/identities/${ident.id}`, { cookie: `${cUmaReq}; step_up=${cookieVal(rt.cookies, 'step_up')}` });
  check(r.status === 409 && errCode(r) === 'SSO_REQUIRED_KEEP_LINK', 'the last linked identity cannot be removed under required', `${r.status} ${j(r.body)}`);
  r = await req('PUT', `/sso/enforcement/${biz.id}`, { cookie: cAdmin, body: { mode: 'optional' } });
  check(r.status === 200 && r.data.mode === 'optional', 'lowering never asks for a fresh confirmation', `${r.status} ${j(r.body)}`);
  r = await req('POST', '/auth/login', { body: { email: uma.email, password: PW } });
  check(r.status === 200, 'under optional, password sign-in works again', `${r.status}`);
  await req('PUT', `/sso/enforcement/${biz.id}`, { cookie: cAdminUp, body: { mode: 'required' } });
  const cli = path.join(dist, 'cli', 'auth-recovery.js');
  const dry = execFileSync(process.execPath, [cli, '--sso-mode', 'optional', biz.id], { env: { ...process.env, DATABASE_URL: DB }, encoding: 'utf8' });
  check(/Would set/.test(dry) && (await prisma.customer.findUnique({ where: { id: biz.id } })).ssoMode === 'required', 'the recovery CLI dry run changes nothing', dry);
  let refused = false;
  try { execFileSync(process.execPath, [cli, '--sso-mode', 'required', biz.id, '--yes'], { env: { ...process.env, DATABASE_URL: DB }, encoding: 'utf8', stdio: 'pipe' }); } catch { refused = true; }
  check(refused && (await prisma.customer.findUnique({ where: { id: biz.id } })).ssoMode === 'required', 'the recovery CLI never sets required');
  const wet = execFileSync(process.execPath, [cli, '--sso-mode', 'optional', biz.id, '--yes'], { env: { ...process.env, DATABASE_URL: DB }, encoding: 'utf8' });
  check(/Setting/.test(wet) && (await prisma.customer.findUnique({ where: { id: biz.id } })).ssoMode === 'optional', 'the recovery CLI lowers required to optional', wet);
  r = await req('PUT', '/sso/enforcement/staff', { cookie: cAdminUp, body: { mode: 'required' } });
  check(r.status === 409 && ['SSO_ENFORCE_UNLINKED', 'SSO_ENFORCE_NO_BREAK_GLASS'].includes(errCode(r)), 'staff cannot be required while staff are unlinked', `${r.status} ${j(r.body)}`);

  // ─────────────────────────────────────────────────────────────────────────
  section('Break-glass');
  r = await req('PUT', `/sso/break-glass/${admin2.id}`, { cookie: cAdminUp, body: { breakGlass: true } });
  check(r.status === 409 && errCode(r) === 'BREAK_GLASS_NEEDS_FACTORS', 'needs TOTP and a passkey enrolled', `${r.status} ${j(r.body)}`);
  r = await req('PUT', `/sso/break-glass/${uma.id}`, { cookie: cAdminUp, body: { breakGlass: true } });
  check(r.status === 409 && errCode(r) === 'BREAK_GLASS_NOT_ADMIN', 'only a Platform Admin can be break-glass', `${r.status}`);
  const bgSecret = authenticator.generateSecret();
  for (const a of [admin2, admin3, admin4]) {
    await prisma.userMfaMethod.create({ data: { userId: a.id, type: 'TOTP', isActive: true, totpSecret: sealTotp(a.id === admin2.id ? bgSecret : authenticator.generateSecret()) } });
    await prisma.userMfaMethod.create({ data: { userId: a.id, type: 'WEBAUTHN', isActive: true, credentialId: randomBytes(16).toString('base64url'), publicKey: randomBytes(65), signCount: 0, name: 'test key' } });
  }
  r = await req('PUT', `/sso/break-glass/${admin2.id}`, { cookie: cAdmin, body: { breakGlass: true } });
  check(r.status === 403 && errCode(r) === 'STEP_UP_REQUIRED' && errAction(r) === 'breakglass.manage', 'changing the flag needs a fresh confirmation (breakglass.manage)', `${r.status} ${j(r.body)}`);
  r = await req('PUT', `/sso/break-glass/${admin2.id}`, { cookie: cAdminUp, body: { breakGlass: true } });
  check(r.status === 200 && r.data.breakGlass === true, 'set for an admin with both factors', `${r.status} ${j(r.body)}`);
  r = await req('PUT', `/sso/break-glass/${admin3.id}`, { cookie: cAdminUp, body: { breakGlass: true } });
  const othersBg = await prisma.user.count({ where: { breakGlass: true, NOT: { id: { in: [admin2.id, admin3.id] } } } });
  if (othersBg === 0) {
    check(r.status === 200, 'a second one is allowed', `${r.status}`);
    r = await req('PUT', `/sso/break-glass/${admin4.id}`, { cookie: cAdminUp, body: { breakGlass: true } });
    check(r.status === 409 && errCode(r) === 'BREAK_GLASS_LIMIT', 'a third is refused', `${r.status} ${j(r.body)}`);
    let trig = false;
    try { await prisma.user.update({ where: { id: admin4.id }, data: { breakGlass: true } }); } catch { trig = true; }
    check(trig, 'and 0080\'s trigger refuses a third written directly');
  }
  let chk = false;
  try { await prisma.user.update({ where: { id: uma.id }, data: { breakGlass: true } }); } catch { chk = true; }
  check(chk, '0080\'s CHECK refuses break-glass on a non-admin');
  r = await req('GET', '/users/platform-admins', { cookie: cAdmin });
  check(r.status === 200 && r.data.find((u) => u.id === admin2.id)?.breakGlass === true, 'the Users UI\'s admin list shows it', j(r.data?.find?.((u) => u.id === admin2.id)));
  r = await req('PATCH', `/users/${admin2.id}/platform-admin`, { cookie: cAdminUp, body: { enabled: false } });
  check(r.status === 400 || r.status === 404, 'a break-glass account cannot be demoted until the flag is cleared', `${r.status} ${j(r.body)}`);
  // Exempt from required: give admin2 a membership in the business, link it, require SSO.
  await prisma.membership.create({ data: { userId: admin2.id, tenantId: tenant.id, customerId: biz.id, roleId: userRole.id, isActive: true } });
  await link(admin2, `sub-bree-${sfx}`);
  await req('PUT', `/sso/enforcement/${biz.id}`, { cookie: cAdminUp, body: { mode: 'required' } });
  check((await prisma.customer.findUnique({ where: { id: biz.id } })).ssoMode === 'required', 'business back under required');
  r = await req('POST', '/auth/login', { body: { email: uma.email, password: PW } });
  check(r.status === 403 && errCode(r) === 'SSO_REQUIRED', 'an ordinary linked account is still refused');
  r = await req('POST', '/auth/login', { body: { email: admin2.email, password: PW } });
  const bgPartial = cookieVal(r.setCookies, 'partial_token');
  check(r.status === 200 && r.data?.requiresMfa === true && !!bgPartial, 'the break-glass account is exempt (and still asked for its TOTP)', `${r.status} ${j(r.body)}`);
  r = await req('POST', '/auth/mfa/verify', { cookie: `partial_token=${bgPartial}`, body: { code: authenticator.generate(bgSecret) } });
  check(r.status === 200 && !!cookieVal(r.setCookies, 'access_token'), 'signs in with the TOTP code', `${r.status} ${j(r.body)}`);
  const bgAudit = await prisma.activityLog.findFirst({ where: { action: 'BREAK_GLASS_LOGIN', actorId: admin2.id } });
  check(bgAudit?.metadata?.method === 'totp', 'audited BREAK_GLASS_LOGIN', j(bgAudit?.metadata));
  check(await waitFor(async () => (await prisma.securityAlert.count({ where: { kind: 'break_glass_login', identity: `user:${admin2.id}` } })) === 1, 5000), 'and a security alert is raised');
  await req('PUT', `/sso/enforcement/${biz.id}`, { cookie: cAdmin, body: { mode: 'off' } });
  r = await req('PUT', `/sso/break-glass/${admin2.id}`, { cookie: cAdminUp, body: { breakGlass: false } });
  check(r.status === 200 && r.data.breakGlass === false, 'cleared');
  const bgChange = await prisma.activityLog.findFirst({ where: { action: 'BREAK_GLASS_CHANGED', resourceId: admin2.id }, orderBy: { createdAt: 'desc' } });
  check(bgChange?.metadata?.before === true && bgChange.metadata.after === false, 'every change audited BREAK_GLASS_CHANGED', j(bgChange?.metadata));

  // ─────────────────────────────────────────────────────────────────────────
  section('Separation: session, integration and IdP tokens');
  const idTok = jwt({ iss: idp.issuer, aud: CLIENT_ID, sub: `sub-uma-${sfx}`, iat: nowS(), exp: nowS() + 300, nonce: 'n' });
  r = await req('GET', '/auth/me', { headers: { authorization: `Bearer ${idTok}` } });
  check(r.status === 401, 'an IdP ID token is not a session', `${r.status}`);
  const forged = (payload) => {
    const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const p = b64u(JSON.stringify(payload));
    return `${h}.${p}.${b64u(createHmac('sha256', JWT).update(`${h}.${p}`).digest())}`;
  };
  const base = { sub: uma.id, email: uma.email, tenantId: null, roleType: null, isPlatformAdmin: false, mfaVerified: true, iat: nowS(), exp: nowS() + 600 };
  r = await req('GET', '/auth/me', { headers: { authorization: `Bearer ${forged(base)}` } });
  check(r.status === 200, '(control) a session-shaped HS256 token under the session key is accepted', `${r.status} ${j(r.body)}`);
  r = await req('GET', '/auth/me', { headers: { authorization: `Bearer ${forged({ ...base, iss: 'clientst0r', aud: 'rem0te', jti: 'abcdefghijklmnop', scope: 'jobs:submit' })}` } });
  check(r.status === 401, 'the same key carrying integration claims (iss/aud/jti/scope) is refused', `${r.status}`);
  const { privateKey: edKey } = generateKeyPairSync('ed25519');
  const eh = b64u(JSON.stringify({ alg: 'EdDSA', kid: 'k1', typ: 'rem0te-delegation+jwt' }));
  const ep = b64u(JSON.stringify({ ...base, iss: 'clientst0r', aud: 'rem0te' }));
  const ej = `${eh}.${ep}.${b64u(csign(null, Buffer.from(`${eh}.${ep}`), edKey))}`;
  r = await req('GET', '/auth/me', { headers: { authorization: `Bearer ${ej}` } });
  check(r.status === 401, 'an integration JWS (EdDSA) is not a session', `${r.status}`);
  r = await fetch(`http://127.0.0.1:${PORT}/api/integration/v1/capabilities`, { headers: { authorization: `Bearer ${idTok}`, 'x-forwarded-for': ip() } });
  check(r.status === 401, 'the integration API refuses an IdP token outright', `${r.status}`);

  // ─────────────────────────────────────────────────────────────────────────
  section('G-R5: the login lockout is in the database and survives a restart');
  const cfg = await prisma.platformSecurityConfig.findFirst({ select: { maxLoginAttempts: true } });
  const max = cfg?.maxLoginAttempts ?? 5;
  for (let i = 0; i < max; i++) await req('POST', '/auth/login', { body: { email: vic.email, password: `wrong-${i}-password` } });
  const lock = await prisma.loginLockout.findUnique({ where: { userId: vic.id } });
  check(lock && lock.count >= max && lock.lockedUntil.getTime() > Date.now(), 'failures are counted in LoginLockout', j(lock));
  r = await req('POST', '/auth/login', { body: { email: vic.email, password: PW } });
  check(r.status === 401 && /Too many failed/.test(j(r.body)), 'the right password is refused while locked', `${r.status} ${j(r.body)}`);
  await stopApi();
  api = startApi();
  await waitUp();
  r = await req('POST', '/auth/login', { body: { email: vic.email, password: PW } });
  check(r.status === 401 && /Too many failed/.test(j(r.body)), 'still locked after the API restarted', `${r.status} ${j(r.body)}`);
  await prisma.loginLockout.deleteMany({ where: { userId: vic.id } });
  r = await req('POST', '/auth/login', { body: { email: vic.email, password: PW } });
  check(r.status === 200, 'and unlocked once the row is gone');
} catch (e) {
  fail++; failures.push(String(e?.stack || e)); console.error(e);
  if (api?.log) console.error(api.log.slice(-3000));
} finally {
  await stopApi().catch(() => undefined);
  await cleanup().catch((e) => console.error('cleanup:', e));
  await prisma.$disconnect();
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
