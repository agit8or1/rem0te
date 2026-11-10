#!/usr/bin/env node
/**
 * End-to-end proof of the Security Features view and of the access claims
 * README "How rem0te protects customer access" and docs/security-model.md
 * make (v0.25).
 *
 * Self-contained: starts the compiled API (dist/main.js) on a scratch port
 * against a scratch database, seeds two synthetic businesses that both have a
 * PC named FRONTDESK, drives everything over HTTP as real signed-in users
 * (Platform Admin, technician manager, Business Owner, Business User, and an
 * L2 technician scoped to one business), and removes its fixtures.
 *
 *   cd apps/api && npx nest build
 *   DATABASE_URL=postgresql://…/reboot_remote_it_scratch node scripts/e2e-security-features.mjs
 *
 * RustDesk is not involved. Where a check needs an endpoint that reports
 * session enforcement it writes Endpoint.sessionEnforcement directly —
 * SIMULATED, exactly as e2e-presets does; no shipped agent reports it.
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { spawn } from 'node:child_process';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const DB = process.env.DATABASE_URL ?? '';
const dbName = DB.split('/').pop()?.split('?')[0] ?? '';
if (!/scratch|test/.test(dbName)) {
  console.error(`Refusing to run against database "${dbName}": name must contain "scratch" or "test".`);
  process.exit(2);
}
const PORT = Number(process.env.FEATURES_API_PORT ?? 3151);
const API = `http://127.0.0.1:${PORT}/api/v1`;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'features-e2e-password-123';

let pass = 0, fail = 0; const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;

const ENC = randomBytes(32);
const env = {
  ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATABASE_URL: DB,
  JWT_SECRET: randomBytes(32).toString('hex'), LAUNCHER_TOKEN_SECRET: randomBytes(32).toString('hex'),
  ENCRYPTION_KEY: ENC.toString('hex'), TRUSTED_PROXIES: 'loopback',
  VERSION_FILE: path.resolve(here, '..', '..', '..', 'version.json'),
};
delete env.INTEGRATION_PEERS_FILE; delete env.UPDATE_REPO_DIR;
let api;
function startApi() {
  api = spawn(process.execPath, [path.join(dist, 'main.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  api.log = ''; api.stdout.on('data', (d) => { api.log += d; }); api.stderr.on('data', (d) => { api.log += d; });
}
async function waitUp() {
  for (let i = 0; i < 120; i++) { try { const r = await fetch(`${API}/health`); if (r.status < 500) return; } catch { /* not yet */ } await sleep(300); }
  throw new Error(`API did not come up:\n${api.log.slice(-3000)}`);
}
async function req(method, p, { s, body, business } = {}) {
  const h = { 'content-type': 'application/json', 'x-forwarded-for': s?.ip ?? ip() };
  if (s) h.cookie = s.cookie + (s.stepUp ? `; step_up=${s.stepUp}` : '');
  if (business) h['x-rem0te-business'] = business;
  const r = await fetch(`${API}${p}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j, setCookie: r.headers.get('set-cookie') ?? '' };
}
async function login(email) {
  const s = { ip: ip() };
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': s.ip }, body: JSON.stringify({ email, password: PW }) });
  const m = (r.headers.get('set-cookie') ?? '').match(/access_token=([^;]+)/);
  if (r.status !== 200 || !m) throw new Error(`login ${email}: ${r.status}`);
  s.cookie = `access_token=${m[1]}`;
  return s;
}
async function stepUp(s) {
  const r = await req('POST', '/auth/step-up', { s, body: { password: PW } });
  const m = r.setCookie.match(/step_up=([^;]+)/);
  if (r.status !== 200 || !m) throw new Error(`step-up: ${r.status} ${JSON.stringify(r.body)}`);
  return { ...s, stepUp: m[1] };
}
const code = (r) => r.body?.code ?? r.body?.message?.code ?? r.body?.error?.code;
const msg = (r) => `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 240)}`;
const encrypt = (text) => {
  const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', ENC, iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return `${iv.toString('hex')}:${c.getAuthTag().toString('hex')}:${enc.toString('hex')}`;
};

const created = { businesses: [], users: [] };
const REQUIRED_IDS = [
  'business-isolation', 'enrollment-binding', 'computer-scope', 'presets', 'protected-classes', 'launch-authorization',
  'attended-consent', 'unattended', 'view-only', 'input-control', 'clipboard', 'file-transfer', 'elevation', 'session-length',
  'session-evidence', 'credential-audit', 'replay-protection', 'fleet-abuse', 'trust-review', 'release-signing', 'integration',
  'remote-shell', 'scripts-fixes', 'approved-actions', 'staged-patching', 'containment', 'audit-chain', 'monitoring', 'chat', 'mdm', 'backup-recovery',
];

async function main() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  const roleUser = await prisma.role.findFirst({ where: { type: 'BUSINESS_USER' } });
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });

  section('Fixtures (synthetic): Acme and Birch, each with a FRONTDESK');
  const acme = await prisma.customer.create({ data: { tenantId: tenant.id, name: `SF Acme ${sfx}` } });
  const birch = await prisma.customer.create({ data: { tenantId: tenant.id, name: `SF Birch ${sfx}` } });
  created.businesses.push(acme.id, birch.id);
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag, extra = {}) => { const u = await prisma.user.create({ data: { email: `sf-${tag}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'SF', lastName: tag, status: 'ACTIVE', ...extra } }); created.users.push(u.id); return u; };
  const admin = await mkUser('admin', { isPlatformAdmin: true });
  const mgr = await mkUser('mgr', { platformPermissions: ['technicians:manage'] });
  const owner = await mkUser('owner-acme');
  const pat = await mkUser('pat-acme');
  const dana = await mkUser('dana-l2');
  await prisma.membership.create({ data: { userId: owner.id, tenantId: tenant.id, customerId: acme.id, roleId: roleOwner.id, capabilities: [] } });
  await prisma.membership.create({ data: { userId: pat.id, tenantId: tenant.id, customerId: acme.id, roleId: roleUser.id, capabilities: ['computers:view', 'computers:connect'] } });
  const mkEp = async (biz) => {
    const e = await prisma.endpoint.create({ data: { tenantId: tenant.id, customerId: biz.id, name: 'FRONTDESK', hostname: 'FRONTDESK', status: 'ACTIVE', isOnline: true, isManaged: true, accessMode: 'ASSIGNED_USERS', lastSeenAt: new Date(), deviceClass: 'WORKSTATION' } });
    await prisma.rustdeskNode.create({ data: { tenantId: tenant.id, endpointId: e.id, rustdeskId: String(100000000 + ((Math.random() * 899999999) | 0)), permanentPassword: encrypt(`pw-${biz.name}`), agentSecretHash: createHash('sha256').update(randomBytes(16)).digest('hex') } });
    return e;
  };
  const fdA = await mkEp(acme), fdB = await mkEp(birch);
  await prisma.computerAccess.create({ data: { tenantId: tenant.id, endpointId: fdA.id, userId: pat.id, grantedBy: owner.id } });
  // Birch tightens its own policy: a value only an authorized viewer of Birch should see.
  await prisma.accessPolicy.upsert({ where: { customerId: birch.id }, create: { id: `business:${birch.id}`, customerId: birch.id, controls: { maxSessionMinutes: 15 } }, update: { controls: { maxSessionMinutes: 15 } } });
  check(true, 'two businesses, one FRONTDESK each (same name and hostname); Pat granted Acme\'s; Birch policy 15 min');

  startApi(); await waitUp();
  const S = { admin: await login(admin.email), mgr: await login(mgr.email), owner: await login(owner.email), pat: await login(pat.email) };
  const Ms = await stepUp(S.mgr);
  const l2 = await prisma.technicianPreset.findUnique({ where: { key: 'l2-technician' } });
  const asg = await req('POST', '/technicians/assignments', { s: Ms, body: { userId: dana.id, businessId: acme.id, presetId: l2.id } });
  check(asg.status === 201, 'Dana: L2 assignment in Acme only', msg(asg));
  S.dana = await login(dana.email);

  section('Catalog: who may see it');
  const cat = (s, q = '', business) => req('GET', `/security-controls/catalog${q}`, { s, business });
  {
    const r = await req('GET', '/security-controls/catalog');
    check(r.status === 401, 'signed out → 401', msg(r));
    const a = await cat(S.admin);
    check(a.status === 200 && a.body.data.scope.kind === 'platform', 'Platform Admin → platform scope', msg(a));
    const ids = new Set((a.body.data?.features ?? []).map((f) => f.id));
    const missing = REQUIRED_IDS.filter((i) => !ids.has(i));
    check(!missing.length, 'every documented control is in the catalog', missing.join(', '));
    const malformed = (a.body.data?.features ?? []).filter((f) => !f.protects || !Array.isArray(f.enforcedAt) || !f.enforcedAt.length || !f.default || !Array.isArray(f.prerequisites) || !f.link?.href || !['enforced', 'partial', 'advisory', 'unavailable'].includes(f.status));
    check(!malformed.length, 'each row has protects, enforcedAt, default, prerequisites, link and a known status', malformed.map((f) => f.id).join(', '));
    const roadmap = (a.body.data?.features ?? []).filter((f) => f.group === 'roadmap');
    check(roadmap.length >= 5 && roadmap.every((f) => f.status === 'unavailable'), 'roadmap rows (terminal, actions, chat, MDM, backup) are all Unavailable');

    const ab = await cat(S.admin, `?businessId=${birch.id}`);
    const len = ab.body.data?.features?.find((f) => f.id === 'session-length');
    check(ab.status === 200 && ab.body.data.scope.business?.id === birch.id && /15 min/.test(len?.effective?.detail ?? ''), 'Platform Admin can scope to Birch and sees Birch\'s own policy', msg(ab));
    const mb = await cat(S.mgr, `?businessId=${birch.id}`);
    check(mb.status === 200 && mb.body.data.scope.business?.id === birch.id, 'technicians:manage can read a business scope (as GET /security-controls/policy already allows)', msg(mb));
    const nf = await cat(S.admin, '?businessId=does-not-exist');
    check(nf.status === 404, 'unknown business → 404', msg(nf));

    const o = await cat(S.owner);
    const oLen = o.body.data?.features?.find((f) => f.id === 'session-length');
    check(o.status === 200 && o.body.data.scope.business?.id === acme.id && !/15 min/.test(oLen?.effective?.detail ?? ''), 'Business Owner → their own business only, without Birch\'s values', msg(o));
    const ob = await cat(S.owner, `?businessId=${birch.id}`);
    check(ob.status === 403, 'Business Owner asking for Birch → 403', msg(ob));
    const p = await cat(S.pat);
    check(p.status === 403, 'Business User (non-admin) → 403', msg(p));
    const d = await cat(S.dana, '', acme.id);
    check(d.status === 403, 'L2 technician acting in Acme → 403', msg(d));
    const d2 = await cat(S.dana, `?businessId=${acme.id}`, acme.id);
    check(d2.status === 403, 'L2 technician naming Acme explicitly → still 403', msg(d2));
  }

  section('Effective state: only what the server can observe');
  {
    const a = await cat(S.admin, `?businessId=${acme.id}`);
    const f = Object.fromEntries((a.body.data?.features ?? []).map((x) => [x.id, x]));
    check(f.clipboard?.effective === null && f['file-transfer']?.effective === null, 'clipboard and file transfer: no effective state (rendered Unknown)', JSON.stringify([f.clipboard?.effective, f['file-transfer']?.effective]));
    check(/No computer reports it \(0 of 1\)/.test(f['view-only']?.effective?.state ?? '') && f['view-only'].effective.source === 'endpoint-reports', 'view-only: "no computer reports it", counted from endpoint reports', JSON.stringify(f['view-only']?.effective));
    check(f['session-length']?.effective?.state === 'Not enforced', 'session length: Not enforced');
    check(/Not configured/.test(f.integration?.effective?.state ?? ''), 'integration: Not configured (no peers file on this API)', JSON.stringify(f.integration?.effective));
    check(/Legacy allowed|Signed only/.test(f['release-signing']?.effective?.state ?? '') && /No signed repository/.test(f['release-signing']?.effective?.detail ?? ''), 'signed updates: mode plus "no signed repository is served"', JSON.stringify(f['release-signing']?.effective));
    check(/0 of 0 launches|No launches/.test(f['session-evidence']?.effective?.state ?? ''), 'session evidence: counted from session rows', JSON.stringify(f['session-evidence']?.effective));

    await prisma.endpoint.update({ where: { id: fdA.id }, data: { sessionEnforcement: { viewOnly: true } } });
    const a2 = await cat(S.admin, `?businessId=${acme.id}`);
    const v2 = a2.body.data.features.find((x) => x.id === 'view-only');
    check(/1 of 1/.test(v2.effective.state), 'SIMULATED report on Acme\'s FRONTDESK → "1 of 1 computers report it"', v2.effective.state);
    const b2 = await cat(S.admin, `?businessId=${birch.id}`);
    check(/0 of 1/.test(b2.body.data.features.find((x) => x.id === 'view-only').effective.state), '…and Birch is still 0 of 1 (counted per business)');
    await prisma.endpoint.update({ where: { id: fdA.id }, data: { sessionEnforcement: null } });
  }

  section('FRONTDESK: the right machine, and what happens without access');
  {
    const list = await req('GET', '/endpoints', { s: S.dana, business: acme.id });
    const rows = list.body.data?.endpoints ?? [];
    const fds = rows.filter((e) => e.name === 'FRONTDESK');
    check(list.status === 200 && fds.length === 1 && fds[0].id === fdA.id, 'Dana\'s Acme list shows exactly one FRONTDESK — Acme\'s', msg(list));
    const sw = await req('GET', '/endpoints', { s: S.dana, business: birch.id });
    check(sw.status === 403 || sw.status === 404 || !(sw.body.data?.endpoints ?? []).some((e) => e.id === fdB.id), 'Dana cannot switch into Birch', msg(sw));

    const before = new Date();
    const xb = await req('POST', `/endpoints/${fdB.id}/connect`, { s: S.dana, business: acme.id });
    check(xb.status === 404, 'Dana → Birch\'s FRONTDESK by id: 404, as for an id that does not exist', msg(xb));
    const xg = await req('GET', `/endpoints/${fdB.id}`, { s: S.dana, business: acme.id });
    check(xg.status === 404, 'Dana → GET Birch\'s FRONTDESK: 404', msg(xg));
    await sleep(300);
    const denied = await prisma.activityLog.findFirst({ where: { actorId: dana.id, action: 'CONNECTION_GRANT_DENIED', resourceId: fdB.id, createdAt: { gte: before } } });
    check(!!denied, 'the cross-business attempt is audited (CONNECTION_GRANT_DENIED)');

    const ctl = await req('POST', `/endpoints/${fdA.id}/connect`, { s: S.dana, business: acme.id });
    check(ctl.status === 403 && /TEMPORARY_GRANT_REQUIRED/.test(JSON.stringify(ctl.body)), 'Dana → Acme\'s FRONTDESK: 403 TEMPORARY_GRANT_REQUIRED', msg(ctl));
    const vo = await req('POST', `/endpoints/${fdA.id}/connect?mode=view_only`, { s: S.dana, business: acme.id });
    check(vo.status === 403 && /ENDPOINT_CANNOT_ENFORCE_VIEW_ONLY/.test(JSON.stringify(vo.body)), 'Dana view-only: 403 ENDPOINT_CANNOT_ENFORCE_VIEW_ONLY', msg(vo));
    const pw = await req('GET', `/endpoints/${fdA.id}/password`, { s: S.dana, business: acme.id });
    check(pw.status === 403 || pw.status === 404, 'Dana cannot read the password', msg(pw));
    const dpw = await prisma.activityLog.findFirst({ where: { actorId: dana.id, action: 'PRIVILEGED_WORK_DENIED', resourceId: fdA.id, createdAt: { gte: before } } });
    check(!!dpw, 'the refused launch is audited (PRIVILEGED_WORK_DENIED)');

    const pc = await req('POST', `/endpoints/${fdA.id}/connect`, { s: S.pat });
    check(pc.status === 200 && !!pc.body.data?.password && !!pc.body.data?.grantToken, 'Pat → Acme\'s FRONTDESK: password and a single-use grant released', msg(pc));
    const pb = await req('POST', `/endpoints/${fdB.id}/connect`, { s: S.pat });
    check(pb.status === 404, 'Pat → Birch\'s FRONTDESK: 404', msg(pb));
    await sleep(300);
    const rev = await prisma.activityLog.findFirst({ where: { actorId: pat.id, action: 'ENDPOINT_PASSWORD_REVEALED', resourceId: fdA.id, createdAt: { gte: before } } });
    check(!!rev && !rev.metadata?.denied, 'Pat\'s release is audited as ENDPOINT_PASSWORD_REVEALED');
    const grants = await prisma.activityLog.findMany({ where: { actorId: pat.id, action: 'CONNECTION_GRANT_CREATED', createdAt: { gte: before } } });
    check(grants.some((g) => g.metadata?.endpointId === fdA.id && g.metadata?.credentialReleased === true), '…and CONNECTION_GRANT_CREATED for that computer, recording that the credential was released');

    // Documented as NOT applied for members: pin that, so the docs cannot drift from it.
    const pv = await req('POST', `/endpoints/${fdA.id}/connect?mode=view_only`, { s: S.pat });
    check(pv.status === 200 && !!pv.body.data?.password, 'DOCUMENTED LIMITATION: a Business User\'s view-only request is approved with the full password (not applied)', msg(pv));
  }
}

let crashed = null;
try { await main(); } catch (e) { crashed = e; console.error(e); }
finally {
  try {
    const eps = await prisma.endpoint.findMany({ where: { customerId: { in: created.businesses } }, select: { id: true } });
    const ids = eps.map((e) => e.id);
    await prisma.computerAccess.deleteMany({ where: { endpointId: { in: ids } } });
    await prisma.connectionGrant?.deleteMany?.({ where: { endpointId: { in: ids } } }).catch(() => {});
    await prisma.supportSession.deleteMany({ where: { endpointId: { in: ids } } }).catch(() => {});
    await prisma.rustdeskNode.deleteMany({ where: { endpointId: { in: ids } } });
    await prisma.endpoint.deleteMany({ where: { id: { in: ids } } }).catch((e) => console.error('cleanup endpoints:', e.message));
    await prisma.technicianAssignment.deleteMany({ where: { userId: { in: created.users } } }).catch(() => {});
    await prisma.accessPolicy.deleteMany({ where: { customerId: { in: created.businesses } } });
    await prisma.membership.deleteMany({ where: { userId: { in: created.users } } });
    await prisma.user.deleteMany({ where: { id: { in: created.users } } }).catch((e) => console.error('cleanup users:', e.message));
    await prisma.customer.deleteMany({ where: { id: { in: created.businesses } } }).catch((e) => console.error('cleanup businesses:', e.message));
  } catch (e) { console.error('cleanup:', e.message); }
  if (api) api.kill('SIGTERM');
  await prisma.$disconnect();
}
console.log(`\n${fail ? '\x1b[31m✗' : '\x1b[32m✓'} ${pass} passed, ${fail} failed\x1b[0m`);
if (failures.length) for (const f of failures) console.log('  - ' + f);
process.exit(fail || crashed ? 1 : 0);
