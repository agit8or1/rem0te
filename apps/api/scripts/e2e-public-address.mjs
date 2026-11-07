#!/usr/bin/env node
/**
 * End-to-end proof of the public address setting (v0.21), over HTTP against a
 * running API and a real Postgres.
 *
 * Covers: only a Platform Admin can read or change it, and access is checked
 * before validation and step-up; bad addresses are refused; a save needs
 * step-up (platform.configure); the reachability check proves an address leads
 * back to THIS server (not merely to something that answers), and an
 * unverified address is refused unless saveUnverified; once saved, support
 * links, the SSO redirect URI, launcher deep links and CORS follow it without
 * a restart; clearing goes back to the environment; the recovery CLI clears
 * it from the database and the API picks that up within a minute.
 *
 * It writes rows and changes the platform's public address (restored at the
 * end), so point it at a scratch stack — never production:
 *
 *   API_BASE=http://127.0.0.1:3101/api/v1 DATABASE_URL=… node scripts/e2e-public-address.mjs
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'crypto';

/* global URL */
const API = process.env.API_BASE || 'http://127.0.0.1:3001/api/v1';
if (/:3001\b|:443\b|^https:/.test(API) && process.env.I_KNOW_THIS_IS_NOT_PRODUCTION !== '1') {
  console.error(`Refusing to run against ${API}: this suite writes fixtures. Use a scratch stack.`);
  process.exit(2);
}
const API_ORIGIN = new URL(API).origin;

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = (x) => JSON.stringify(x)?.slice(0, 400);

async function req(method, p, { body, cookie, headers = {} } = {}) {
  await pace();
  const r = await fetch(`${API}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed, headers: r.headers, setCookie: r.headers.get('set-cookie') || '' };
}
async function login(email) {
  await pace();
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }) });
  const m = (r.headers.get('set-cookie') || '').match(/access_token=([^;]+)/);
  if (!m) throw new Error(`login ${email} failed: ${r.status} ${await r.text()}`);
  return `access_token=${m[1]}`;
}
async function stepUp(cookie) {
  const r = await req('POST', '/auth/step-up', { cookie, body: { password: PW } });
  const m = r.setCookie.match(/step_up=([^;]+)/);
  if (r.status !== 200 || !m) throw new Error(`step-up failed: ${r.status} ${j(r.body)}`);
  return `${cookie}; step_up=${m[1]}`;
}

const created = { users: [], businesses: [], endpoints: [] };
async function makeUser(email, extra = {}) {
  const u = await prisma.user.create({
    data: { email, passwordHash: await argon2.hash(PW, { type: argon2.argon2id }), firstName: email.split('-')[1], lastName: 'Test', status: 'ACTIVE', ...extra },
  });
  created.users.push(u.id);
  return u;
}

// Two stand-in servers: one that answers like a web server that is not
// Rem0te, one that redirects.
const other = http.createServer((q, s) => { s.writeHead(404, { 'content-type': 'text/plain' }); s.end('not here'); });
const redirector = http.createServer((q, s) => { s.writeHead(301, { location: `${API_ORIGIN}${q.url}` }); s.end(); });
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${srv.address().port}`)));

let original;
try {
  const OTHER = await listen(other);
  const REDIRECT = await listen(redirector);
  original = (await prisma.platformSettings.findUnique({ where: { id: 'singleton' } }))?.publicUrl ?? null;
  await prisma.platformSettings.upsert({ where: { id: 'singleton' }, create: { id: 'singleton', publicUrl: null }, update: { publicUrl: null } });

  const tenant = await prisma.tenant.findFirst({ where: { isActive: true }, orderBy: { createdAt: 'asc' } });
  const biz = await prisma.customer.create({
    data: { tenantId: tenant.id, name: `Addr Biz ${sfx}`, isActive: true, supportIntakeEnabled: true, supportIntakeSlug: randomBytes(12).toString('base64url') },
  });
  created.businesses.push(biz.id);
  const admin = await makeUser(`pa-adam-${sfx}@test.invalid`, { isPlatformAdmin: true });
  const owner = await makeUser(`pa-olga-${sfx}@test.invalid`);
  const ownerRole = await prisma.role.findFirst({ where: { tenantId: tenant.id, type: 'BUSINESS_OWNER' } });
  await prisma.membership.create({ data: { userId: owner.id, tenantId: tenant.id, customerId: biz.id, roleId: ownerRole.id, isActive: true } });

  const ep = await prisma.endpoint.create({
    data: {
      tenantId: tenant.id, customerId: biz.id, name: `addr-pc-${sfx}`, hostname: `addr-pc-${sfx}`, status: 'ACTIVE', isOnline: true, isManaged: true,
      rustdeskNode: { create: { tenantId: tenant.id, rustdeskId: String(100000000 + Math.floor(Math.random() * 800000000)) } },
    },
  });
  created.endpoints.push(ep.id);

  const cAdmin = await login(admin.email);
  const cOwner = await login(owner.email);

  section('Who can see and change it');
  let r = await req('GET', '/admin/public-address');
  check(r.status === 401, 'signed out: 401', `${r.status}`);
  r = await req('GET', '/admin/public-address', { cookie: cOwner });
  check(r.status === 403, 'a Business Owner cannot read it', `${r.status}`);
  r = await req('PUT', '/admin/public-address', { cookie: cOwner, body: { url: 'not a url' } });
  check(r.status === 403 && r.body.code !== 'STEP_UP_REQUIRED', 'a Business Owner is refused before validation or step-up', `${r.status} ${j(r.body)}`);
  r = await req('POST', '/admin/public-address/check', { cookie: cOwner, body: { url: API_ORIGIN } });
  check(r.status === 403, 'a Business Owner cannot run the check (no SSRF from non-admins)', `${r.status}`);

  section('Before anything is saved');
  // Wait out the API's cached copy if a previous run left a value behind.
  for (let i = 0; i < 70; i++) {
    r = await req('GET', '/admin/public-address', { cookie: cAdmin });
    if (r.body?.data?.source !== 'setting') break;
    await sleep(1000);
  }
  const envWeb = r.body.data?.environment?.FRONTEND_URL;
  check(r.status === 200 && r.body.data.source === 'environment' && r.body.data.effective === envWeb, 'falls back to FRONTEND_URL from the environment', j(r.body.data));
  check(typeof r.body.data.passkeys === 'number' && typeof r.body.data.webauthnRpIdPinned === 'boolean', 'reports the passkeys a change would affect', j(r.body.data));

  section('Validation');
  for (const [bad, why] of [
    ['not a url', 'not a URL'], ['ftp://remote.example.com', 'not http(s)'], ['https://remote.example.com/app', 'has a path'],
    ['https://remote.example.com/?x=1', 'has a query'], ['https://u:p@remote.example.com', 'has credentials'],
    ['https://re mote.example.com', 'bad host'], [`https://${'a'.repeat(200)}.com`, 'too long'], ['', 'empty'],
  ]) {
    r = await req('PUT', '/admin/public-address', { cookie: cAdmin, body: { url: bad } });
    check(r.status === 400, `refused: ${why}`, `${r.status} ${j(r.body)}`);
  }
  r = await req('PUT', '/admin/public-address', { cookie: cAdmin, body: { url: 42 } });
  check(r.status === 400, 'refused: not a string', `${r.status}`);

  section('Step-up');
  r = await req('PUT', '/admin/public-address', { cookie: cAdmin, body: { url: API_ORIGIN } });
  check(r.status === 403 && r.body.code === 'STEP_UP_REQUIRED', 'saving needs step-up', `${r.status} ${j(r.body)}`);
  check(r.body.action === 'platform.configure', 'the step-up response names the action (platform.configure)', j(r.body));
  const settings = await prisma.platformSettings.findUnique({ where: { id: 'singleton' } });
  check(settings.stepUpActions.includes('platform.configure'), 'the migration turned platform.configure on for the existing settings row', j(settings.stepUpActions));
  const sAdmin = await stepUp(cAdmin);

  section('Reachability check');
  r = await req('POST', '/admin/public-address/check', { cookie: cAdmin, body: { url: `${API_ORIGIN}/` } });
  check(r.status === 200 && r.body.data.sameServer === true && r.body.data.address === API_ORIGIN, 'this server\'s own address: confirmed, and normalised to an origin', j(r.body));
  r = await req('POST', '/admin/public-address/check', { cookie: cAdmin, body: { url: OTHER } });
  check(r.status === 200 && r.body.data.reachable === true && r.body.data.sameServer === false, 'a different server that answers: reachable, but not this server', j(r.body));
  r = await req('POST', '/admin/public-address/check', { cookie: cAdmin, body: { url: REDIRECT } });
  check(r.status === 200 && r.body.data.sameServer === false && /redirects/.test(r.body.data.detail), 'a redirect is reported, not followed', j(r.body));
  r = await req('POST', '/admin/public-address/check', { cookie: cAdmin, body: { url: 'http://127.0.0.1:9' } });
  check(r.status === 200 && r.body.data.reachable === false, 'nothing listening: unreachable, with the reason', j(r.body));
  r = await req('GET', `/public/address-probe/${randomBytes(18).toString('base64url')}`);
  check(r.status === 200 && r.body.data.ok === false, 'the public probe says no to a nonce it did not issue', j(r.body));
  r = await req('GET', '/public/address-probe/short');
  check(r.status === 200 && r.body.data.ok === false, 'the public probe says no to a malformed nonce', j(r.body));

  section('Saving');
  r = await req('PUT', '/admin/public-address', { cookie: sAdmin, body: { url: OTHER } });
  check(r.status === 409 && r.body.code === 'ADDRESS_UNVERIFIED', 'an address that does not lead back here is refused (409)', `${r.status} ${j(r.body)}`);
  check((await prisma.platformSettings.findUnique({ where: { id: 'singleton' } })).publicUrl === null, '…and nothing is saved');
  r = await req('PUT', '/admin/public-address', { cookie: sAdmin, body: { url: OTHER, saveUnverified: true } });
  check(r.status === 200 && r.body.data.setting === OTHER && r.body.data.check?.sameServer === false, '…unless saveUnverified, which saves it and says it was not verified', j(r.body));
  r = await req('PUT', '/admin/public-address', { cookie: sAdmin, body: { url: `${API_ORIGIN}/` } });
  check(r.status === 200 && r.body.data.source === 'setting' && r.body.data.effective === API_ORIGIN && r.body.data.effectiveApi === API_ORIGIN, 'a verified address saves, as an origin, for both web and API', j(r.body));
  const audit = await prisma.activityLog.findFirst({ where: { actorId: admin.id, action: 'PLATFORM_SETTINGS_UPDATED' }, orderBy: { createdAt: 'desc' } });
  check(audit?.metadata?.field === 'publicUrl' && audit.metadata.from === OTHER && audit.metadata.to === API_ORIGIN && audit.metadata.verified === true, 'the change is audited with before, after and whether it was verified', j(audit?.metadata));

  section('Everything follows it, without a restart');
  r = await req('GET', '/support-requests/intake', { cookie: cOwner });
  check(r.status === 200 && r.body.data.url === `${API_ORIGIN}/support/${biz.supportIntakeSlug}`, 'the customer support link', j(r.body));
  r = await req('GET', '/sso/providers', { cookie: cAdmin });
  check(r.status === 200 && r.body.data.suggestedRedirectUri === `${API_ORIGIN}/api/v1/auth/sso/callback`, 'the SSO redirect URI shown to the admin', j(r.body?.data?.suggestedRedirectUri));
  r = await req('POST', '/launcher/token', { cookie: cAdmin, body: { endpointId: ep.id } });
  const link = r.body?.data?.deepLink ?? '';
  const linkApi = link ? new URL(link.replace('reboot-remote://launch#', 'http://x/?')).searchParams.get('api') : null;
  check((r.status === 201 || r.status === 200) && linkApi === API_ORIGIN, 'the API address in launcher deep links', `${r.status} ${link.replace(/token=[^&]+/, 'token=…') || j(r.body)}`);
  let o = await req('OPTIONS', '/auth/login', { headers: { origin: API_ORIGIN, 'access-control-request-method': 'POST' } });
  check(o.headers.get('access-control-allow-origin') === API_ORIGIN, 'CORS allows the new address', `${o.headers.get('access-control-allow-origin')}`);
  o = await req('OPTIONS', '/auth/login', { headers: { origin: envWeb, 'access-control-request-method': 'POST' } });
  check(o.headers.get('access-control-allow-origin') === envWeb, 'CORS still allows FRONTEND_URL from the environment', `${o.headers.get('access-control-allow-origin')}`);
  o = await req('OPTIONS', '/auth/login', { headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
  check(!o.headers.get('access-control-allow-origin'), 'CORS refuses any other origin', `${o.headers.get('access-control-allow-origin')}`);
  r = await req('POST', '/auth/passkeys/login/options', { body: {} });
  const pinned = (await req('GET', '/admin/public-address', { cookie: cAdmin })).body.data.webauthnRpIdPinned;
  check(r.status === 200 && (pinned || r.body.data.rpId === new URL(API_ORIGIN).hostname), pinned ? 'passkeys: RP ID pinned by WEBAUTHN_RP_ID, unchanged' : 'passkeys: the RP ID follows the address', j(r.body?.data?.rpId));

  section('Clearing');
  r = await req('PUT', '/admin/public-address', { cookie: cAdmin, body: { url: null } });
  check(r.status === 403 && r.body.code === 'STEP_UP_REQUIRED', 'clearing needs step-up too', `${r.status}`);
  r = await req('PUT', '/admin/public-address', { cookie: sAdmin, body: { url: null } });
  check(r.status === 200 && r.body.data.source === 'environment' && r.body.data.effective === envWeb, 'clearing goes back to the environment', j(r.body));
  r = await req('GET', '/support-requests/intake', { cookie: cOwner });
  check(r.body.data.url === `${envWeb}/support/${biz.supportIntakeSlug}`, 'and the links follow', j(r.body?.data?.url));

  section('Recovery from the server');
  await req('PUT', '/admin/public-address', { cookie: sAdmin, body: { url: OTHER, saveUnverified: true } });
  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli', 'auth-recovery.js');
  const status = execFileSync(process.execPath, [cli, '--status'], { env: process.env, encoding: 'utf8' });
  check(status.includes(`Public address: ${OTHER} (setting)`), '--status shows the address', status);
  const dry = execFileSync(process.execPath, [cli, '--clear-public-url'], { env: process.env, encoding: 'utf8' });
  check(/Would clear/.test(dry) && (await prisma.platformSettings.findUnique({ where: { id: 'singleton' } })).publicUrl === OTHER, 'a dry run changes nothing', dry);
  const wet = execFileSync(process.execPath, [cli, '--clear-public-url', '--yes'], { env: process.env, encoding: 'utf8' });
  check(/Clearing/.test(wet) && (await prisma.platformSettings.findUnique({ where: { id: 'singleton' } })).publicUrl === null, '--clear-public-url --yes clears it', wet);
  const t0 = Date.now();
  let seen = false;
  while (Date.now() - t0 < 70_000) {
    r = await req('GET', '/admin/public-address', { cookie: cAdmin });
    if (r.body?.data?.source === 'environment') { seen = true; break; }
    await sleep(2000);
  }
  check(seen, `the running API picks it up without a restart (${Math.round((Date.now() - t0) / 1000)}s)`, j(r.body?.data));
} catch (e) {
  fail++; failures.push(String(e?.stack || e)); console.error(e);
} finally {
  await prisma.platformSettings.update({ where: { id: 'singleton' }, data: { publicUrl: original ?? null } }).catch(() => {});
  await prisma.activityLog.deleteMany({ where: { OR: [{ actorId: { in: created.users } }, { resourceId: { in: created.users } }, { actorAgent: 'auth-recovery', metadata: { path: ['field'], equals: 'publicUrl' } }] } }).catch((e) => console.error('audit cleanup:', e.message));
  await prisma.launcherToken.deleteMany({ where: { userId: { in: created.users } } }).catch(() => {});
  await prisma.sessionEvent?.deleteMany?.({ where: { session: { technicianId: { in: created.users } } } }).catch(() => {});
  await prisma.supportSession.deleteMany({ where: { technicianId: { in: created.users } } }).catch((e) => console.error('session cleanup:', e.message));
  await prisma.launcherToken.deleteMany({ where: { targetEndpointId: { in: created.endpoints } } }).catch(() => {});
  await prisma.supportSession.deleteMany({ where: { endpointId: { in: created.endpoints } } }).catch(() => {});
  await prisma.rustdeskNode.deleteMany({ where: { endpointId: { in: created.endpoints } } }).catch(() => {});
  await prisma.activityLog.deleteMany({ where: { resourceId: { in: created.endpoints } } }).catch(() => {});
  await prisma.activityLog.updateMany({ where: { customerId: { in: created.businesses } }, data: { customerId: null } }).catch(() => {});
  await prisma.endpoint.deleteMany({ where: { id: { in: created.endpoints } } }).catch((e) => console.error('endpoint cleanup:', e.message));
  await prisma.membership.deleteMany({ where: { userId: { in: created.users } } });
  await prisma.customer.deleteMany({ where: { id: { in: created.businesses } } }).catch((e) => console.error('biz cleanup:', e.message));
  await prisma.user.deleteMany({ where: { id: { in: created.users } } }).catch((e) => console.error('user cleanup:', e.message));
  await prisma.$disconnect();
  other.close(); redirector.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
