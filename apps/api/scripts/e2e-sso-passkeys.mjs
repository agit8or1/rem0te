#!/usr/bin/env node
/**
 * End-to-end proof of SSO (OIDC) and passkeys (v0.20, F10), over HTTP
 * against a running API and a real Postgres.
 *
 * OIDC runs against a mock provider this script serves on 127.0.0.1 (signed
 * RS256 ID tokens, PKCE checked). The API must run with
 * OIDC_ALLOW_INSECURE_LOOPBACK=true, which only ever relaxes HTTPS for a
 * loopback issuer. Passkeys use a software authenticator (P-256, "none"
 * attestation) built here, against the API's configured RP ID and origin
 * (WEBAUTHN_RP_ID / WEBAUTHN_ORIGIN, default from FRONTEND_URL).
 *
 * This proves the protocol handling and the account rules. It does not prove
 * any particular provider (Entra ID, Google, Okta…) or a real browser.
 *
 *   API_BASE=http://127.0.0.1:3101/api/v1 FRONTEND_URL=… DATABASE_URL=… node scripts/e2e-sso-passkeys.mjs
 */
/* global URL, URLSearchParams */
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { createHash, createSign, generateKeyPairSync, randomBytes, sign as edSign } from 'crypto';

const API = process.env.API_BASE || 'http://127.0.0.1:3001/api/v1';
if (/:3001\b|:443\b|^https:/.test(API) && process.env.I_KNOW_THIS_IS_NOT_PRODUCTION !== '1') {
  console.error(`Refusing to run against ${API}: this suite writes fixtures. Use a scratch stack.`);
  process.exit(2);
}
const FRONT = new URL(process.env.WEBAUTHN_ORIGIN || process.env.FRONTEND_URL || 'http://localhost:3000');
const RP_ID = process.env.WEBAUTHN_RP_ID || FRONT.hostname;
const ORIGIN = FRONT.origin;

const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'test-password-123456';

let pass = 0, fail = 0;
const failures = [];
function check(cond, name, detail = '') {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; failures.push(`${name} — ${detail}`); console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${detail}`); }
}
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const pace = () => new Promise((r) => setTimeout(r, 60));
const j = (x) => JSON.stringify(x)?.slice(0, 300);
const b64u = (b) => Buffer.from(b).toString('base64url');
const sha256 = (b) => createHash('sha256').update(b).digest();

async function req(method, p, { body, cookie, headers = {} } = {}) {
  await pace();
  const r = await fetch(p.startsWith('http') ? p : `${API}${p}`, {
    method, redirect: 'manual',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed, location: r.headers.get('location') || '', setCookies: r.headers.getSetCookie?.() ?? [] };
}
const cookieVal = (setCookies, name) => {
  for (const c of setCookies) { const m = c.match(new RegExp(`^${name}=([^;]*)`)); if (m && m[1]) return m[1]; }
  return null;
};
async function login(email) {
  const r = await req('POST', '/auth/login', { body: { email, password: PW } });
  const t = cookieVal(r.setCookies, 'access_token');
  if (!t) throw new Error(`login ${email} failed: ${r.status} ${j(r.body)}`);
  return `access_token=${t}`;
}
async function stepUp(cookie) {
  const r = await req('POST', '/auth/step-up', { cookie, body: { password: PW } });
  const t = cookieVal(r.setCookies, 'step_up');
  if (r.status !== 200 || !t) throw new Error(`step-up failed: ${r.status} ${j(r.body)}`);
  return `${cookie}; step_up=${t}`;
}

// ── Mock OIDC provider ───────────────────────────────────────────────────────

const { privateKey: idpKey, publicKey: idpPub } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...idpPub.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' };
const codes = new Map();
const idp = { next: null, port: 0, issuer: '', tamper: null };
function jwt(claims) {
  const h = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'k1' }));
  const p = b64u(JSON.stringify(claims));
  const s = createSign('RSA-SHA256').update(`${h}.${p}`).sign(idpKey);
  return `${h}.${p}.${b64u(s)}`;
}
const server = http.createServer((rq, rs) => {
  const u = new URL(rq.url, idp.issuer);
  const json = (code, o) => { rs.writeHead(code, { 'content-type': 'application/json' }); rs.end(JSON.stringify(o)); };
  if (u.pathname === '/.well-known/openid-configuration') {
    return json(200, {
      issuer: idp.issuer, authorization_endpoint: `${idp.issuer}/authorize`, token_endpoint: `${idp.issuer}/token`,
      jwks_uri: `${idp.issuer}/jwks`, response_types_supported: ['code'], subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'], code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
    });
  }
  if (u.pathname === '/jwks') return json(200, { keys: [jwk] });
  if (u.pathname === '/authorize') {
    const who = idp.next;
    const code = randomBytes(16).toString('hex');
    codes.set(code, { who, nonce: u.searchParams.get('nonce'), challenge: u.searchParams.get('code_challenge'), clientId: u.searchParams.get('client_id'), redirect: u.searchParams.get('redirect_uri') });
    const back = new URL(u.searchParams.get('redirect_uri'));
    back.searchParams.set('code', code);
    back.searchParams.set('state', u.searchParams.get('state'));
    rs.writeHead(302, { location: back.href }); return rs.end();
  }
  if (u.pathname === '/token' && rq.method === 'POST') {
    let data = '';
    rq.on('data', (c) => { data += c; });
    rq.on('end', () => {
      const f = new URLSearchParams(data);
      const c = codes.get(f.get('code'));
      codes.delete(f.get('code'));
      if (!c) return json(400, { error: 'invalid_grant' });
      if (b64u(sha256(f.get('code_verifier') || '')) !== c.challenge) return json(400, { error: 'invalid_grant', error_description: 'pkce' });
      if (f.get('redirect_uri') !== c.redirect) return json(400, { error: 'invalid_grant', error_description: 'redirect' });
      const now = Math.floor(Date.now() / 1000);
      let claims = { iss: idp.issuer, aud: c.clientId, sub: c.who.sub, nonce: c.nonce, iat: now, exp: now + 300, ...c.who.claims };
      if (idp.tamper) claims = idp.tamper(claims);
      json(200, { access_token: randomBytes(12).toString('hex'), token_type: 'Bearer', expires_in: 300, id_token: jwt(claims) });
    });
    return;
  }
  json(404, { error: 'not_found' });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
idp.port = server.address().port;
idp.issuer = `http://127.0.0.1:${idp.port}`;

/** One whole browser round trip. Returns where the API finally sent the browser, and its cookies. */
async function ssoRoundTrip(startPath, who, { cookie = '', swapStateCookie = null, replay = false } = {}) {
  idp.next = who;
  let state, r;
  if (startPath.startsWith('LINK:')) {
    r = await req('POST', `/auth/sso/${startPath.slice(5)}/link`, { cookie, body: {} });
    if (r.status !== 200) return { error: r };
    state = cookieVal(r.setCookies, 'sso_state');
    r = { location: r.body.data.url };
  } else {
    r = await req('GET', startPath);
    state = cookieVal(r.setCookies, 'sso_state');
    if (!state) return { final: r.location, cookies: [] };
  }
  const a = await fetch(r.location, { redirect: 'manual' });
  const cb = a.headers.get('location');
  const sc = swapStateCookie ?? state;
  const res = await req('GET', cb, { cookie: `sso_state=${sc}` });
  const out = { final: res.location, cookies: res.setCookies, callback: cb, state };
  if (replay) out.replay = await req('GET', cb, { cookie: `sso_state=${sc}` });
  return out;
}

// ── Software authenticator ──────────────────────────────────────────────────

function cbor(v) {
  const head = (major, n) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    if (n < 65536) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
    const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
  };
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === 'string') { const b = Buffer.from(v, 'utf8'); return Buffer.concat([head(3, b.length), b]); }
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (v instanceof Map) {
    const parts = [head(5, v.size)];
    for (const [k, x] of v) parts.push(cbor(k), cbor(x));
    return Buffer.concat(parts);
  }
  throw new Error('cbor: unsupported');
}
class Authenticator {
  constructor(userId) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.key = privateKey;
    const k = publicKey.export({ format: 'jwk' });
    this.cose = new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(k.x, 'base64url')], [-3, Buffer.from(k.y, 'base64url')]]);
    this.credId = randomBytes(32);
    this.counter = 0;
    this.userId = userId;
  }
  get id() { return b64u(this.credId); }
  authData(flags, withCred) {
    const c = Buffer.alloc(4); c.writeUInt32BE(this.counter);
    const parts = [sha256(RP_ID), Buffer.from([flags]), c];
    if (withCred) {
      const len = Buffer.alloc(2); len.writeUInt16BE(this.credId.length);
      parts.push(Buffer.alloc(16), len, this.credId, cbor(this.cose));
    }
    return Buffer.concat(parts);
  }
  create(options, { origin = ORIGIN } = {}) {
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin, crossOrigin: false }));
    const att = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', this.authData(0x45, true)]]));
    return { id: this.id, rawId: this.id, type: 'public-key', clientExtensionResults: {}, authenticatorAttachment: 'platform',
      response: { clientDataJSON: b64u(clientData), attestationObject: b64u(att), transports: ['internal'] } };
  }
  get(options, { counter, key, userHandle = this.userId, flags = 0x05 } = {}) {
    this.counter = counter ?? this.counter + 1;
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: ORIGIN, crossOrigin: false }));
    const ad = this.authData(flags, false);
    const sig = edSign('sha256', Buffer.concat([ad, sha256(clientData)]), key ?? this.key);
    return { id: this.id, rawId: this.id, type: 'public-key', clientExtensionResults: {}, authenticatorAttachment: 'platform',
      response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(ad), signature: b64u(sig), userHandle: userHandle ? b64u(Buffer.from(userHandle)) : undefined } };
  }
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const created = { users: [], businesses: [], providers: [] };
async function makeUser(email, extra = {}) {
  const u = await prisma.user.create({ data: { email, passwordHash: await argon2.hash(PW, { type: argon2.argon2id }), firstName: email.split('-')[1], lastName: 'Test', status: 'ACTIVE', ...extra } });
  created.users.push(u.id);
  return u;
}
async function cleanup() {
  const prov = await prisma.user.findMany({ where: { email: { endsWith: `-${sfx}@idp.invalid` } }, select: { id: true } });
  created.users.push(...prov.map((u) => u.id));
  await prisma.externalIdentity.deleteMany({ where: { OR: [{ userId: { in: created.users } }, { providerId: { in: created.providers } }] } });
  await prisma.oidcLoginState.deleteMany({ where: { providerId: { in: created.providers } } });
  await prisma.oidcProvider.deleteMany({ where: { id: { in: created.providers } } });
  await prisma.webAuthnChallenge.deleteMany({ where: { OR: [{ userId: { in: created.users } }, { purpose: 'LOGIN', createdAt: { gt: new Date(Date.now() - 3600_000) } }] } });
  await prisma.userMfaMethod.deleteMany({ where: { userId: { in: created.users } } });
  await prisma.activityLog.deleteMany({ where: { OR: [{ actorId: { in: created.users } }, { resourceId: { in: [...created.users, ...created.providers] } }] } });
  await prisma.activityLog.updateMany({ where: { customerId: { in: created.businesses } }, data: { customerId: null } });
  await prisma.membership.deleteMany({ where: { userId: { in: created.users } } });
  await prisma.customer.deleteMany({ where: { id: { in: created.businesses } } });
  await prisma.user.deleteMany({ where: { id: { in: created.users } } });
}

try {
  const tenant = await prisma.tenant.findFirst({ where: { isActive: true }, orderBy: { createdAt: 'asc' } });
  const biz = await prisma.customer.create({ data: { tenantId: tenant.id, name: `SSO Biz ${sfx}`, isActive: true } });
  created.businesses.push(biz.id);
  const admin = await makeUser(`sp-adam-${sfx}@test.invalid`, { isPlatformAdmin: true });
  const owner = await makeUser(`sp-olive-${sfx}@test.invalid`);
  const uma = await makeUser(`sp-uma-${sfx}@test.invalid`);
  const vic = await makeUser(`sp-vic-${sfx}@test.invalid`);
  const ownerRole = await prisma.role.findFirst({ where: { tenantId: tenant.id, type: 'BUSINESS_OWNER' } });
  const userRole = await prisma.role.findFirst({ where: { tenantId: tenant.id, type: 'BUSINESS_USER' } });
  await prisma.membership.create({ data: { userId: owner.id, tenantId: tenant.id, customerId: biz.id, roleId: ownerRole.id, isActive: true } });
  for (const u of [uma, vic]) await prisma.membership.create({ data: { userId: u.id, tenantId: tenant.id, customerId: biz.id, roleId: userRole.id, capabilities: ['computers:view'], isActive: true } });

  const cAdmin = await login(admin.email);
  const cOwner = await login(owner.email);

  // ───────────────────────────────────────────────────────────────────────
  section('Provider configuration');
  const API_ORIGIN = new URL(API).origin;
  const redirectUri = `${API_ORIGIN}/api/v1/auth/sso/callback`;
  const pbody = { name: `Mock IdP ${sfx}`, issuer: idp.issuer, clientId: `rem0te-${sfx}`, clientSecret: 'shh-secret', redirectUri, groupsClaim: 'groups' };
  let r = await req('POST', '/sso/providers', { cookie: cOwner, body: pbody });
  check(r.status === 403 && r.body?.code !== 'STEP_UP_REQUIRED', 'a business owner cannot configure SSO (refused before step-up)', `${r.status} ${j(r.body)}`);
  r = await req('POST', '/sso/providers', { cookie: cAdmin, body: pbody });
  check(r.status === 403 && r.body?.code === 'STEP_UP_REQUIRED', 'admin needs step-up', `${r.status}`);
  const cAdminUp = await stepUp(cAdmin);
  r = await req('POST', '/sso/providers', { cookie: cAdminUp, body: { ...pbody, issuer: 'http://idp.example.com' } });
  check(r.status === 400, 'a non-loopback http issuer is refused', `${r.status} ${j(r.body)}`);
  r = await req('POST', '/sso/providers', { cookie: cAdminUp, body: pbody });
  check(r.status === 201 && r.body.data.enabled === false && r.body.data.hasClientSecret === true, 'created disabled', `${r.status} ${j(r.body)}`);
  check(!JSON.stringify(r.body).includes('shh-secret'), 'client secret never returned');
  const pid = r.body.data.id; created.providers.push(pid);
  const stored = await prisma.oidcProvider.findUnique({ where: { id: pid } });
  check(stored.clientSecretEnc && !stored.clientSecretEnc.includes('shh-secret'), 'client secret stored encrypted');
  r = await req('POST', `/sso/providers/${pid}/test`, { cookie: cAdmin });
  check(r.status === 200 && r.body.data.ok === true && r.body.data.pkce === true, 'discovery test passes', j(r.body));
  r = await req('GET', '/auth/sso/providers');
  check(r.status === 200 && !r.body.data.some((p) => p.id === pid), 'a disabled provider is not offered on the sign-in page');
  let rt = await ssoRoundTrip(`/auth/sso/${pid}/start`, { sub: 'x', claims: {} });
  check(/sso_error=unavailable/.test(rt.final), 'starting a disabled provider is refused', rt.final);
  r = await req('PATCH', `/sso/providers/${pid}`, { cookie: cAdminUp, body: { issuer: 'http://127.0.0.1:1' } });
  check(r.status === 400, 'issuer cannot be changed', `${r.status}`);
  r = await req('PATCH', `/sso/providers/${pid}`, { cookie: cAdminUp, body: { enabled: true } });
  check(r.status === 200 && r.body.data.enabled === true, 'enabled');
  r = await req('GET', '/auth/sso/providers');
  check(r.body.data.some((p) => p.id === pid) && Object.keys(r.body.data[0]).sort().join() === 'id,name', 'offered publicly with id and name only', j(r.body.data));

  // ───────────────────────────────────────────────────────────────────────
  section('Sign-in needs a linked identity');
  rt = await ssoRoundTrip(`/auth/sso/${pid}/start`, { sub: `sub-uma-${sfx}`, claims: { email: uma.email, email_verified: true } });
  check(/sso_error=not_linked/.test(rt.final), 'an unlinked identity is refused even with a matching verified email', rt.final);
  check(!cookieVal(rt.cookies, 'access_token'), 'no session issued');

  section('Linking');
  const cUma = await login(uma.email);
  r = await req('POST', `/auth/sso/${pid}/link`, { cookie: cUma, body: {} });
  check(r.status === 403 && r.body?.code === 'STEP_UP_REQUIRED', 'linking needs step-up', `${r.status}`);
  const cUmaUp = await stepUp(cUma);
  rt = await ssoRoundTrip(`LINK:${pid}`, { sub: `sub-uma-${sfx}`, claims: { email: 'whatever@idp.invalid' } }, { cookie: cUmaUp });
  check(/sso=linked/.test(rt.final || ''), 'identity linked', j(rt));
  check(await prisma.externalIdentity.count({ where: { userId: uma.id, subject: `sub-uma-${sfx}` } }) === 1, 'stored by issuer+subject');
  const cVicUp = await stepUp(await login(vic.email));
  rt = await ssoRoundTrip(`LINK:${pid}`, { sub: `sub-uma-${sfx}`, claims: {} }, { cookie: cVicUp });
  check(/\/account\?sso_error=linked_elsewhere/.test(rt.final), 'the same identity cannot be linked to a second account (back to the account page)', rt.final);

  section('Signing in');
  rt = await ssoRoundTrip(`/auth/sso/${pid}/start?returnTo=/endpoints`, { sub: `sub-uma-${sfx}`, claims: { email: 'changed@idp.invalid' } }, { replay: true });
  const tok = cookieVal(rt.cookies, 'access_token');
  check(!!tok && rt.final.endsWith('/endpoints'), 'signs in and returns to the requested page', rt.final);
  r = await req('GET', '/auth/me', { cookie: `access_token=${tok}` });
  check(r.status === 200 && r.body.data.email === uma.email && r.body.data.businessId === biz.id, 'session is Uma\'s, with her business', j(r.body?.data));
  check(rt.replay && /sso_error=(expired|state_mismatch)/.test(rt.replay.location) && !cookieVal(rt.replay.setCookies, 'access_token'), 'a replayed callback is refused', j(rt.replay?.location));
  rt = await ssoRoundTrip(`/auth/sso/${pid}/start?returnTo=//evil.example`, { sub: `sub-uma-${sfx}`, claims: {} });
  check(rt.final.endsWith('/dashboard'), 'an off-site returnTo is ignored', rt.final);
  rt = await ssoRoundTrip(`/auth/sso/${pid}/start`, { sub: `sub-uma-${sfx}`, claims: {} }, { swapStateCookie: randomBytes(16).toString('base64url') });
  check(/sso_error=state_mismatch/.test(rt.final), 'a callback in a different browser (state cookie mismatch) is refused', rt.final);
  idp.tamper = (c) => ({ ...c, nonce: 'wrong' });
  rt = await ssoRoundTrip(`/auth/sso/${pid}/start`, { sub: `sub-uma-${sfx}`, claims: {} });
  check(/sso_error=exchange_failed/.test(rt.final), 'a wrong nonce is refused', rt.final);
  idp.tamper = (c) => ({ ...c, aud: 'someone-else' });
  rt = await ssoRoundTrip(`/auth/sso/${pid}/start`, { sub: `sub-uma-${sfx}`, claims: {} });
  check(/sso_error=exchange_failed/.test(rt.final), 'a token for another client is refused', rt.final);
  idp.tamper = (c) => ({ ...c, exp: Math.floor(Date.now() / 1000) - 600 });
  rt = await ssoRoundTrip(`/auth/sso/${pid}/start`, { sub: `sub-uma-${sfx}`, claims: {} });
  check(/sso_error=exchange_failed/.test(rt.final), 'an expired ID token is refused', rt.final);
  idp.tamper = null;
  await prisma.user.update({ where: { id: uma.id }, data: { status: 'SUSPENDED' } });
  rt = await ssoRoundTrip(`/auth/sso/${pid}/start`, { sub: `sub-uma-${sfx}`, claims: {} });
  check(/sso_error=account/.test(rt.final) && !cookieVal(rt.cookies, 'access_token'), 'a suspended account cannot sign in through SSO', rt.final);
  await prisma.user.update({ where: { id: uma.id }, data: { status: 'ACTIVE' } });
  // An account with TOTP still needs its code after SSO.
  const totp = await prisma.userMfaMethod.create({ data: { userId: uma.id, type: 'TOTP', isActive: true, totpSecret: 'unused-by-this-test' } });
  rt = await ssoRoundTrip(`/auth/sso/${pid}/start`, { sub: `sub-uma-${sfx}`, claims: {} });
  check(rt.final.endsWith('/mfa') && !!cookieVal(rt.cookies, 'partial_token') && !cookieVal(rt.cookies, 'access_token'), 'SSO does not bypass the account\'s TOTP', rt.final);
  await prisma.userMfaMethod.delete({ where: { id: totp.id } });

  section('Provisioning');
  r = await req('PATCH', `/sso/providers/${pid}`, { cookie: cAdminUp, body: { allowProvisioning: true } });
  rt = await ssoRoundTrip(`/auth/sso/${pid}/start`, { sub: `sub-take-${sfx}`, claims: { email: owner.email, email_verified: true } });
  check(/sso_error=email_in_use/.test(rt.final), 'a new identity naming an existing account\'s email is refused, not linked', rt.final);
  check(await prisma.externalIdentity.count({ where: { userId: owner.id } }) === 0, 'the owner\'s account was not touched');
  rt = await ssoRoundTrip(`/auth/sso/${pid}/start`, { sub: `sub-unv-${sfx}`, claims: { email: `unv-${sfx}@idp.invalid`, email_verified: false } });
  check(/sso_error=email_unverified/.test(rt.final), 'an unverified email is not provisioned', rt.final);
  rt = await ssoRoundTrip(`/auth/sso/${pid}/start`, { sub: `sub-none-${sfx}`, claims: { email: `none-${sfx}@idp.invalid`, email_verified: true, groups: ['unmapped'] } });
  check(/sso_error=provisioned_no_access/.test(rt.final) && !cookieVal(rt.cookies, 'access_token'), 'a provisioned account with no mapped group gets no session', rt.final);
  const noneUser = await prisma.user.findUnique({ where: { email: `none-${sfx}@idp.invalid` }, include: { memberships: true } });
  check(noneUser && noneUser.memberships.length === 0 && !noneUser.isPlatformAdmin, 'and has no business and no permissions');
  r = await req('POST', '/auth/login', { body: { email: `none-${sfx}@idp.invalid`, password: PW } });
  check(r.status === 401, 'a provisioned account has no usable password', `${r.status}`);
  r = await req('POST', `/sso/providers/${pid}/mappings`, { cookie: cAdminUp, body: { groupValue: `grp-${sfx}`, businessId: biz.id, capabilities: ['computers:view', 'not:a:capability'] } });
  check(r.status === 201 && j(r.body.data.capabilities) === '["computers:view"]', 'group mapping created; unknown capabilities dropped', j(r.body));
  rt = await ssoRoundTrip(`/auth/sso/${pid}/start`, { sub: `sub-new-${sfx}`, claims: { email: `new-${sfx}@idp.invalid`, email_verified: true, given_name: 'Nia', groups: ['other', `grp-${sfx}`] } });
  const newTok = cookieVal(rt.cookies, 'access_token');
  check(!!newTok, 'a mapped group provisions and signs in', rt.final);
  r = await req('GET', '/auth/me', { cookie: `access_token=${newTok}` });
  check(r.body?.data?.businessId === biz.id && r.body?.data?.roleType === 'BUSINESS_USER' && j(r.body.data.capabilities) === '["computers:view"]', 'exactly the mapped business and capabilities', j(r.body?.data));
  check(r.body?.data?.isPlatformAdmin === false, 'never a Platform Admin');

  section('Unlinking');
  const ident = (await req('GET', '/auth/sso/identities', { cookie: cUma })).body.data[0];
  r = await req('DELETE', `/auth/sso/identities/${ident.id}`, { cookie: cUma });
  check(r.status === 403 && r.body?.code === 'STEP_UP_REQUIRED', 'unlink needs step-up');
  r = await req('DELETE', `/auth/sso/identities/${ident.id}`, { cookie: cVicUp });
  check(r.status === 404, 'cannot unlink someone else\'s identity', `${r.status}`);
  r = await req('DELETE', `/auth/sso/identities/${ident.id}`, { cookie: cUmaUp });
  check(r.status === 200, 'unlinked');

  // ───────────────────────────────────────────────────────────────────────
  section('Passkeys: registration');
  const authr = new Authenticator(vic.id);
  const cVic = cVicUp.split('; step_up=')[0];
  r = await req('POST', '/auth/passkeys/register/options', { cookie: cVic });
  check(r.status === 403 && r.body?.code === 'STEP_UP_REQUIRED', 'adding a passkey needs step-up');
  r = await req('POST', '/auth/passkeys/register/options', { cookie: cVicUp });
  check(r.status === 200 && r.body.data.rp.id === RP_ID && r.body.data.authenticatorSelection.userVerification === 'required', 'registration options (UV required)', j(r.body?.data?.rp));
  let opts = r.body.data;
  const bad = new Authenticator(vic.id);
  r = await req('POST', '/auth/passkeys/register', { cookie: cVicUp, body: { response: bad.create(opts, { origin: 'https://evil.example' }) } });
  check(r.status === 400, 'a response from another origin is refused', `${r.status} ${j(r.body)}`);
  r = await req('POST', '/auth/passkeys/register/options', { cookie: cVicUp });
  opts = r.body.data;
  const regResp = authr.create(opts);
  r = await req('POST', '/auth/passkeys/register', { cookie: cVicUp, body: { response: regResp, name: 'Test key' } });
  check(r.status === 201 && r.body.data.name === 'Test key', 'passkey registered', `${r.status} ${j(r.body)}`);
  r = await req('POST', '/auth/passkeys/register', { cookie: cVicUp, body: { response: regResp, name: 'again' } });
  check(r.status === 401, 'a registration response cannot be replayed', `${r.status}`);
  r = await req('GET', '/auth/passkeys', { cookie: cVic });
  // Since 0.26 each passkey carries approvalExport — its PUBLIC key, for the
  // approval-signer roster ceremony. Nothing else may carry key material.
  check(r.body.data.length === 1 && !JSON.stringify(r.body.data.map(({ approvalExport, ...rest }) => rest)).includes('publicKey'), 'listed without key material (outside the public-key approval export)');
  const pkId = r.body.data[0].id;

  section('Passkeys: sign-in');
  r = await req('POST', '/auth/passkeys/login/options', {});
  check(r.status === 200 && !r.body.data.allowCredentials?.length, 'login options reveal no credentials', j(r.body?.data));
  let login1 = authr.get(r.body.data);
  r = await req('POST', '/auth/passkeys/login', { body: { response: login1 } });
  const pkTok = cookieVal(r.setCookies, 'access_token');
  check(r.status === 200 && !!pkTok && r.body.data.requiresMfa === false, 'signs in with a passkey, MFA satisfied', `${r.status} ${j(r.body)}`);
  r = await req('GET', '/auth/me', { cookie: `access_token=${pkTok}` });
  check(r.body?.data?.email === vic.email, 'session is Vic\'s');
  r = await req('POST', '/auth/passkeys/login', { body: { response: login1 } });
  check(r.status === 401, 'an assertion cannot be replayed', `${r.status}`);
  r = await req('POST', '/auth/passkeys/login/options', {});
  r = await req('POST', '/auth/passkeys/login', { body: { response: authr.get(r.body.data, { counter: 1 }) } });
  check(r.status === 401, 'a non-increasing signature counter (cloned key) is refused', `${r.status}`);
  r = await req('POST', '/auth/passkeys/login/options', {});
  r = await req('POST', '/auth/passkeys/login', { body: { response: authr.get(r.body.data, { key: generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey }) } });
  check(r.status === 401, 'a wrong signature is refused', `${r.status}`);
  r = await req('POST', '/auth/passkeys/login/options', {});
  r = await req('POST', '/auth/passkeys/login', { body: { response: authr.get(r.body.data, { flags: 0x01 }) } });
  check(r.status === 401, 'an assertion without user verification is refused', `${r.status}`);
  r = await req('POST', '/auth/passkeys/login/options', {});
  r = await req('POST', '/auth/passkeys/login', { body: { response: new Authenticator(vic.id).get(r.body.data) } });
  check(r.status === 401, 'an unknown credential is refused', `${r.status}`);
  r = await req('POST', '/auth/passkeys/login/options', {});
  r = await req('POST', '/auth/passkeys/login', { body: { response: authr.get(r.body.data, { userHandle: uma.id }) } });
  check(r.status === 401, 'a user handle naming another account is refused', `${r.status}`);
  await prisma.user.update({ where: { id: vic.id }, data: { status: 'SUSPENDED' } });
  r = await req('POST', '/auth/passkeys/login/options', {});
  r = await req('POST', '/auth/passkeys/login', { body: { response: authr.get(r.body.data) } });
  check(r.status === 401 && !cookieVal(r.setCookies, 'access_token'), 'a suspended account cannot sign in with a passkey', `${r.status}`);
  await prisma.user.update({ where: { id: vic.id }, data: { status: 'ACTIVE' } });

  section('Passkeys: step-up');
  const cVic2 = `access_token=${pkTok}`;
  r = await req('POST', '/auth/step-up/passkey/options', { cookie: cVic2 });
  check(r.status === 200 && r.body.data.allowCredentials?.length === 1, 'step-up options list only Vic\'s passkey', j(r.body?.data?.allowCredentials));
  r = await req('POST', '/auth/step-up/passkey', { cookie: cVic2, body: { response: authr.get(r.body.data) } });
  const su = cookieVal(r.setCookies, 'step_up');
  check(r.status === 200 && r.body.data.method === 'passkey' && !!su, 'step-up by passkey', `${r.status} ${j(r.body)}`);
  r = await req('GET', '/auth/step-up', { cookie: `${cVic2}; step_up=${su}` });
  check(r.body?.data?.active === true, 'the step-up is live for that session');
  const umaAuth = new Authenticator(uma.id);
  r = await req('POST', '/auth/step-up/passkey/options', { cookie: cUma });
  check(r.status === 400, 'no step-up options for an account without passkeys', `${r.status}`);
  r = await req('POST', '/auth/step-up/passkey/options', { cookie: cVic2 });
  r = await req('POST', '/auth/step-up/passkey', { cookie: cUma, body: { response: umaAuth.get(r.body.data) } });
  check(r.status === 401, 'one account\'s challenge cannot be answered by another', `${r.status}`);

  section('Passkeys: removal');
  r = await req('DELETE', `/auth/passkeys/${pkId}`, { cookie: cVic2 });
  check(r.status === 403 && r.body?.code === 'STEP_UP_REQUIRED', 'removal needs step-up');
  r = await req('DELETE', `/auth/passkeys/${pkId}`, { cookie: cUmaUp });
  check(r.status === 404, 'cannot remove someone else\'s passkey', `${r.status}`);
  r = await req('DELETE', `/auth/passkeys/${pkId}`, { cookie: `${cVic2}; step_up=${su}` });
  check(r.status === 200, 'removed');
  r = await req('POST', '/auth/passkeys/login/options', {});
  r = await req('POST', '/auth/passkeys/login', { body: { response: authr.get(r.body.data) } });
  check(r.status === 401, 'a removed passkey no longer signs in', `${r.status}`);

  // ───────────────────────────────────────────────────────────────────────
  section('Recovery script');
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli', 'auth-recovery.js');
  const dry = execFileSync(process.execPath, [script, '--disable-sso'], { env: process.env, encoding: 'utf8' });
  check(/Would disable/.test(dry) && (await prisma.oidcProvider.findUnique({ where: { id: pid } })).enabled === true, 'dry run changes nothing', dry);
  const wet = execFileSync(process.execPath, [script, '--disable-sso', '--yes'], { env: process.env, encoding: 'utf8' });
  check(/Disabling/.test(wet) && (await prisma.oidcProvider.findUnique({ where: { id: pid } })).enabled === false, 'disables every provider', wet);
  rt = await ssoRoundTrip(`/auth/sso/${pid}/start`, { sub: `sub-new-${sfx}`, claims: {} });
  check(/sso_error=unavailable/.test(rt.final), 'SSO sign-in is then refused');
  r = await req('POST', '/auth/login', { body: { email: uma.email, password: PW } });
  check(r.status === 200, 'password sign-in still works');
} catch (e) {
  fail++; failures.push(String(e?.stack || e)); console.error(e);
} finally {
  await cleanup().catch((e) => console.error('cleanup:', e));
  await prisma.$disconnect();
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
