#!/usr/bin/env node
/**
 * End-to-end proof of technician presets and abuse prevention (v0.23).
 *
 * Self-contained: starts the compiled API (dist/main.js) on a scratch port
 * against a scratch database, seeds two lab businesses (the same hostname in
 * both), drives everything over HTTP as real signed-in users, runs a fake
 * alert webhook and a fake ClientSt0r signer on loopback, and removes its
 * fixtures at the end.
 *
 *   cd apps/api && npx nest build
 *   DATABASE_URL=postgresql://…/reboot_remote_it_scratch node scripts/e2e-presets.mjs
 *
 * RustDesk itself is not involved. Where a test needs an endpoint that can
 * enforce view-only or attended consent, it sets Endpoint.sessionEnforcement
 * in the database — SIMULATED: no shipped agent reports it. The report this
 * prints says which results are simulated.
 */
/* global structuredClone */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createCipheriv, createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const C = require(path.join(dist, 'integration/crypto.js'));

const DB = process.env.DATABASE_URL ?? '';
const dbName = DB.split('/').pop()?.split('?')[0] ?? '';
if (!/scratch|test/.test(dbName)) {
  console.error(`Refusing to run against database "${dbName}": name must contain "scratch" or "test".`);
  process.exit(2);
}
const PORT = Number(process.env.PRESETS_API_PORT ?? 3121);
const ROOT = `http://127.0.0.1:${PORT}`;
const API = `${ROOT}/api/v1`;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'presets-e2e-password-123';

let pass = 0, fail = 0; const failures = []; const report = [];
const ok = (n) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); };
const bad = (n, d) => { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); };
const check = (c, n, d = '') => (c ? ok(n) : bad(n, d));
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;

// ── Fake alert webhook ──────────────────────────────────────────────────────
const hooks = { a: [], b: [] };
const hookSrv = createServer((req, res) => {
  const c = []; req.on('data', (d) => c.push(d));
  req.on('end', () => { const which = req.url.includes('/old') ? 'a' : 'b'; try { hooks[which].push(JSON.parse(Buffer.concat(c).toString())); } catch { /* ignore */ } res.writeHead(204).end(); });
});
await new Promise((r) => hookSrv.listen(0, '127.0.0.1', r));
const HOOK = `http://127.0.0.1:${hookSrv.address().port}`;

// ── Integration peer (for the integration entry point) ──────────────────────
const tmp = mkdtempSync(path.join(tmpdir(), 'rem0te-presets-'));
const self = generateKeyPairSync('ed25519'), peerReq = generateKeyPairSync('ed25519'), peerDel = generateKeyPairSync('ed25519');
writeFileSync(path.join(tmp, 'self.pem'), self.privateKey.export({ type: 'pkcs8', format: 'pem' }));
const PEER = 'clientst0r-presets', AUD = 'rem0te:presets', PEER_AUD = 'clientst0r:presets';
const pem = (k) => k.export({ type: 'spki', format: 'pem' }).toString();
writeFileSync(path.join(tmp, 'peers.json'), JSON.stringify({
  self: { keyId: 'rem0te-presets-1', privateKeyFile: path.join(tmp, 'self.pem') },
  peers: [{ id: PEER, audience: AUD, peerAudience: PEER_AUD, requestKeys: [{ kid: 'req-1', publicKeyPem: pem(peerReq.publicKey) }], delegationKeys: [{ kid: 'del-1', publicKeyPem: pem(peerDel.publicKey) }], inferenceUrl: 'http://127.0.0.1:9/inference', eventsUrl: 'http://127.0.0.1:9/events', modelProfiles: ['triage-fast'] }],
}));
const JobRequest = require(path.join(dist, 'integration/contract.js')).JobRequest;
async function integrationJob(org, tech, endpointId) {
  const body = {
    contract: 'ticket-rmm-v1', idempotency_key: `idem-${randomBytes(6).toString('hex')}`, correlation_id: `c-${randomBytes(4).toString('hex')}`,
    organization_id: org, technician_id: tech,
    ticket: { id: `T-${randomBytes(3).toString('hex')}`, revision: 1, subject: 's', body: 'b', comments: [] },
    endpoint: endpointId ? { rem0te_endpoint_id: endpointId } : null, model_profiles: ['triage-fast'],
    evidence: { include_endpoint_inventory: false }, expires_at: new Date(Date.now() + 3600_000).toISOString(),
  };
  const parsed = JobRequest.parse(body);
  const now = Math.floor(Date.now() / 1000);
  const delegation = C.signJws(peerDel.privateKey, 'del-1', { iss: PEER, aud: AUD, sub: tech, org, scope: 'ticket_analysis:submit', iat: now, exp: now + 120, jti: randomBytes(16).toString('hex'), req_sha256: C.sha256Hex(C.canonicalJson(parsed)) });
  const text = JSON.stringify(body), p = '/api/integration/v1/jobs', ts = String(now), nonce = randomBytes(18).toString('base64url');
  const sig = C.signEd25519(peerReq.privateKey, C.requestSigningString({ audience: AUD, method: 'POST', pathWithQuery: p, timestamp: ts, nonce, bodySha256: C.sha256Hex(Buffer.from(text)) }));
  const r = await fetch(`${ROOT}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'rem0te-key-id': `${PEER}/req-1`, 'rem0te-timestamp': ts, 'rem0te-nonce': nonce, 'rem0te-signature': sig, 'rem0te-delegation': delegation }, body: text });
  return { status: r.status, body: await r.json().catch(() => null) };
}

// ── API process ─────────────────────────────────────────────────────────────
const ENC = randomBytes(32);
const env = {
  ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATABASE_URL: DB,
  JWT_SECRET: randomBytes(32).toString('hex'), LAUNCHER_TOKEN_SECRET: randomBytes(32).toString('hex'),
  ENCRYPTION_KEY: ENC.toString('hex'), TRUSTED_PROXIES: 'loopback', INTEGRATION_PEERS_FILE: path.join(tmp, 'peers.json'),
  VERSION_FILE: path.resolve(here, '..', '..', '..', 'version.json'),
};
let api;
function startApi() {
  api = spawn(process.execPath, [path.join(dist, 'main.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  api.log = ''; api.stdout.on('data', (d) => { api.log += d; }); api.stderr.on('data', (d) => { api.log += d; });
}
async function stopApi() { if (api && api.exitCode === null) await new Promise((r) => { api.once('exit', r); api.kill('SIGTERM'); }); }
async function waitUp() {
  for (let i = 0; i < 120; i++) { try { const r = await fetch(`${API}/health`); if (r.status < 500) return true; } catch { /* not yet */ } await sleep(300); }
  throw new Error(`API did not come up:\n${api.log.slice(-3000)}`);
}

// ── HTTP as a user ──────────────────────────────────────────────────────────
async function req(method, p, { s, body, business, xff, headers = {} } = {}) {
  const h = { 'content-type': 'application/json', 'x-forwarded-for': xff ?? s?.ip ?? ip(), ...headers };
  if (s) h.cookie = s.cookie + (s.stepUp ? `; step_up=${s.stepUp}` : '');
  if (business) h['x-rem0te-business'] = business;
  const r = await fetch(`${API}${p}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j, setCookie: r.headers.get('set-cookie') ?? '' };
}
async function login(email) {
  const s = { ip: ip() };
  const r = await req('POST', '/auth/login', { body: { email, password: PW }, xff: s.ip });
  const m = r.setCookie.match(/access_token=([^;]+)/);
  if (r.status !== 200 || !m) throw new Error(`login ${email}: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  s.cookie = `access_token=${m[1]}`;
  return s;
}
async function stepUp(s) {
  const r = await req('POST', '/auth/step-up', { s, body: { password: PW } });
  const m = r.setCookie.match(/step_up=([^;]+)/);
  if (r.status !== 200 || !m) throw new Error(`step-up: ${r.status} ${JSON.stringify(r.body)}`);
  return { ...s, stepUp: m[1] };
}
const code = (r) => r.body?.code ?? r.body?.message?.code ?? r.body?.error?.code ?? (typeof r.body?.message === 'object' ? r.body.message.code : undefined);
const msg = (r) => JSON.stringify(r.body).slice(0, 240);

const encrypt = (text) => {
  const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', ENC, iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return `${iv.toString('hex')}:${c.getAuthTag().toString('hex')}:${enc.toString('hex')}`;
};

const created = { businesses: [], users: [] };
const rustdeskId = () => String(100000000 + ((Math.random() * 899999999) | 0));

async function main() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  const roleUser = await prisma.role.findFirst({ where: { type: 'BUSINESS_USER' } });
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });

  section('Fixtures');
  const bizA = await prisma.customer.create({ data: { tenantId: tenant.id, name: `Presets Lab A ${sfx}` } });
  const bizB = await prisma.customer.create({ data: { tenantId: tenant.id, name: `Presets Lab B ${sfx}` } });
  created.businesses.push(bizA.id, bizB.id);
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag, extra = {}) => { const u = await prisma.user.create({ data: { email: `pr-${tag}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'PR', lastName: tag, status: 'ACTIVE', ...extra } }); created.users.push(u.id); return u; };
  const admin1 = await mkUser('admin1', { isPlatformAdmin: true });
  const admin2 = await mkUser('admin2', { isPlatformAdmin: true });
  const mgr = await mkUser('mgr', { platformPermissions: ['technicians:manage'] });
  const t1 = await mkUser('l1'), t2 = await mkUser('l2'), t3 = await mkUser('l3'), tg = await mkUser('groups'), tNew = await mkUser('new');
  const tCustom = await mkUser('custom'), burst = await mkUser('burst'), dual = await mkUser('dual');
  const ownerA = await mkUser('owner-a');
  await prisma.membership.create({ data: { userId: ownerA.id, tenantId: tenant.id, customerId: bizA.id, roleId: roleOwner.id, capabilities: [] } });
  // `dual` is a Business User of B with connect, and (below) an L1 technician in A.
  await prisma.membership.create({ data: { userId: dual.id, tenantId: tenant.id, customerId: bizB.id, roleId: roleUser.id, capabilities: ['computers:view', 'computers:connect'] } });

  const eps = {};
  const mkEp = async (biz, key, o = {}) => {
    const e = await prisma.endpoint.create({ data: { tenantId: tenant.id, customerId: biz.id, name: key, hostname: o.hostname ?? key, status: 'ACTIVE', isOnline: true, isManaged: true, accessMode: 'COMPANY_WIDE', lastSeenAt: new Date(), deviceClass: o.deviceClass ?? 'WORKSTATION' } });
    const secret = randomBytes(16).toString('hex');
    const node = await prisma.rustdeskNode.create({ data: { tenantId: tenant.id, endpointId: e.id, rustdeskId: rustdeskId(), permanentPassword: encrypt(`pw-${key}`), agentSecretHash: createHash('sha256').update(secret).digest('hex') } });
    eps[key] = { ...e, rid: node.rustdeskId, secret };
    return eps[key];
  };
  await mkEp(bizA, 'FRONTDESK-01'); await mkEp(bizB, 'FRONTDESK-01-B', { hostname: 'FRONTDESK-01' });
  for (let i = 1; i <= 8; i++) await mkEp(bizA, `WS-A${i}`);
  await mkEp(bizA, 'SRV-A1', { deviceClass: 'SERVER' });
  await mkEp(bizA, 'BACKUP-A1', { deviceClass: 'BACKUP_SERVER' });
  await mkEp(bizA, 'DC-A1', { deviceClass: 'DOMAIN_CONTROLLER' });
  const fleet = [];
  for (let i = 1; i <= 40; i++) fleet.push(await mkEp(bizA, `FLEET-${String(i).padStart(2, '0')}`));
  ok(`two businesses; ${Object.keys(eps).length} computers; FRONTDESK-01 is the hostname in both`);

  // Integration mapping for the burst identity.
  const ORG_A = `org-a-${sfx}`;
  await prisma.integrationOrgMapping.create({ data: { peerId: PEER, externalOrgId: ORG_A, customerId: bizA.id, tenantId: tenant.id, createdById: 'e2e' } });
  await prisma.integrationTechnicianMapping.create({ data: { peerId: PEER, externalOrgId: ORG_A, externalTechnicianId: 'cs-burst', userId: burst.id, createdById: 'e2e' } });

  startApi(); await waitUp();

  section('Seeding is idempotent and preserves edits');
  {
    const n1 = await prisma.technicianPreset.count({ where: { builtIn: true } });
    check(n1 === 3, `three built-in presets seeded (${n1})`);
    const l1 = await prisma.technicianPreset.findUnique({ where: { key: 'l1-help-desk' } });
    await prisma.technicianPreset.update({ where: { id: l1.id }, data: { description: `edited ${sfx}` } });
    await stopApi(); startApi(); await waitUp();
    const n2 = await prisma.technicianPreset.count({ where: { builtIn: true } });
    const again = await prisma.technicianPreset.findUnique({ where: { id: l1.id } });
    check(n2 === 3 && again.description === `edited ${sfx}`, 'restart: still three, and an admin edit survived the re-seed');
    const pol = await prisma.accessPolicy.findUnique({ where: { id: 'singleton' } });
    check(!!pol, 'platform access policy seeded');
  }
  const presets = Object.fromEntries((await prisma.technicianPreset.findMany({ where: { builtIn: true } })).map((p) => [p.tier, p]));

  // Sessions.
  const A1 = await login(admin1.email), A2 = await login(admin2.email), M = await login(mgr.email);
  const A1s = await stepUp(A1), A2s = await stepUp(A2), Ms = await stepUp(M);

  section('Assignments: presets, L1 default, no self-promotion');
  const assign = async (body) => req('POST', '/technicians/assignments', { s: Ms, body });
  {
    const r = await assign({ userId: tNew.id, businessId: bizA.id });
    check(r.status === 201 && r.body.data.presetId === presets.L1.id, 'no preset and no capabilities → L1 Help Desk', msg(r));
    check(JSON.stringify(r.body.data.capabilities.sort()) === JSON.stringify(['computers:view', 'support:requests']), 'L1 assignment carries view + support only');
    const mine = await req('POST', '/technicians/assignments', { s: Ms, body: { userId: mgr.id, businessId: bizA.id } });
    check(mine.status === 403 && code(mine) === 'SELF_ASSIGNMENT', 'a manager cannot assign themselves', msg(mine));
    const g = await req('POST', '/technicians/groups', { s: Ms, body: { name: `pr-group-${sfx}`, capabilities: ['computers:view'] } });
    const gid = g.body.data.id;
    const selfJoin = await req('POST', `/technicians/groups/${gid}/members`, { s: Ms, body: { userId: mgr.id } });
    check(selfJoin.status === 403, 'a manager cannot add themselves to a group', msg(selfJoin));
    // Conflicting groups: tg is in a group with an L2 assignment scoped to WS-A5, and has a direct L1 on all of A.
    await req('POST', `/technicians/groups/${gid}/members`, { s: Ms, body: { userId: tg.id } });
    const ga = await assign({ groupId: gid, businessId: bizA.id, presetId: presets.L2.id, endpointIds: [eps['WS-A5'].id] });
    check(ga.status === 201 && ga.body.data.presetId === presets.L2.id, 'group assignment from the L2 preset, scoped to one computer', msg(ga));
    await assign({ userId: tg.id, businessId: bizA.id, presetId: presets.L1.id });
    for (const [u, p] of [[t1, 'L1'], [t2, 'L2'], [t3, 'L3']]) {
      const x = await assign({ userId: u.id, businessId: bizA.id, presetId: presets[p].id });
      check(x.status === 201, `${p} assigned to ${p} technician in business A`, msg(x));
    }
    await assign({ userId: dual.id, businessId: bizA.id, presetId: presets.L1.id });
    const both = await assign({ userId: tCustom.id, businessId: bizA.id, presetId: presets.L1.id, capabilities: ['computers:view'] });
    check(both.status === 400, 'preset and explicit capabilities together → 400');
    const cust = await assign({ userId: tCustom.id, businessId: bizA.id, capabilities: ['computers:view', 'computers:connect', 'computers:edit'] });
    check(cust.status === 201 && cust.body.data.presetId === null, 'custom assignment still possible (pre-0.23 behaviour)', msg(cust));
    await assign({ userId: burst.id, businessId: bizA.id, capabilities: ['computers:view', 'computers:connect', 'computers:event_logs', 'integration:ticket_analysis'] });

    const prev = await req('GET', '/security-controls/upgrade-preview', { s: M });
    const row = prev.body.data?.find((x) => x.userId === tCustom.id);
    check(row && row.holdsLaunchOrCredential && /unchanged/.test(row.current), 'upgrade preview flags the custom connect/edit assignment and leaves it unchanged', msg(prev));
  }

  const T1 = await login(t1.email), T2 = await login(t2.email), T3 = await login(t3.email), TG = await login(tg.email);
  const TC = await login(tCustom.email), DU = await login(dual.email);
  const A = bizA.id, B = bizB.id;

  section('L1 Help Desk: grants and denials');
  {
    const list = await req('GET', '/endpoints', { s: T1, business: A });
    check(list.status === 200, 'sees assigned inventory', msg(list));
    const one = await req('GET', `/endpoints/${eps['WS-A1'].id}`, { s: T1, business: A });
    check(one.status === 200, 'reads one computer');
    const ev = await req('POST', `/endpoints/${eps['WS-A1'].id}/event-log`, { s: T1, business: A, body: { logName: 'System' } });
    check(ev.status === 403, 'no event logs', `HTTP ${ev.status}`);
    const vo = await req('POST', `/endpoints/${eps['WS-A1'].id}/connect?mode=view_only`, { s: T1, business: A });
    check(vo.status === 403 && /VIEW_ONLY_NOT_GRANTED/.test(msg(vo)), 'no view-only (not enabled for L1 by default)', msg(vo));
    const ctl = await req('POST', `/endpoints/${eps['WS-A1'].id}/connect`, { s: T1, business: A });
    check(ctl.status === 403 && /CONTROL_NOT_GRANTED/.test(msg(ctl)), 'no control — and told why', msg(ctl));
    const cmd = await req('GET', `/endpoints/${eps['WS-A1'].id}/connect.cmd`, { s: T1, business: A });
    check(cmd.status === 403, 'connect.cmd refused the same way', `HTTP ${cmd.status}`);
    const lt = await req('POST', '/launcher/token', { s: T1, business: A, body: { endpointId: eps['WS-A1'].id } });
    check(lt.status === 403, 'launcher token refused', msg(lt));
    const pw = await req('GET', `/endpoints/${eps['WS-A1'].id}/password`, { s: T1, business: A });
    check(pw.status === 403 || pw.status === 404, 'no credential reveal', `HTTP ${pw.status}`);
    const en = await req('POST', '/enrollment/tokens', { s: T1, business: A, body: {} });
    check(en.status === 403 || en.status === 400 || en.status === 404, 'no enrollment', `HTTP ${en.status}`);
    const qc = await req('POST', '/quick-connect/connect', { s: T1, business: A, body: { rustdeskId: '123456789', password: 'abcd' } });
    check(qc.status === 403, 'no Quick Connect', `HTTP ${qc.status}`);
    const appr = await req('GET', '/security-controls/temporary-access?status=PENDING', { s: T1, business: A });
    check(appr.status === 200 && appr.body.data.every((x) => x.userId === t1.id), 'cannot see (let alone approve) others\' requests');
    const otherBiz = await req('GET', `/endpoints/${eps['FRONTDESK-01-B'].id}`, { s: T1, business: A });
    check(otherBiz.status === 404 || otherBiz.status === 403, 'same hostname in business B: unreachable by direct URL', `HTTP ${otherBiz.status}`);
    const asB = await req('GET', `/endpoints/${eps['FRONTDESK-01-B'].id}`, { s: T1, business: B });
    check(asB.status === 403 || asB.status === 404, 'switching the business header to B gets nothing', `HTTP ${asB.status}`);
  }

  section('L2 Technician: diagnostics, view-only only where enforceable, control only by temporary grant');
  {
    const ev = await req('POST', `/endpoints/${eps['WS-A1'].id}/event-log`, { s: T2, business: A, body: { logName: 'System' } });
    check(ev.status === 200, 'bounded event-log read on a workstation', msg(ev));
    const vo = await req('POST', `/endpoints/${eps['WS-A1'].id}/connect?mode=view_only`, { s: T2, business: A });
    check(vo.status === 403 && /ENDPOINT_CANNOT_ENFORCE_VIEW_ONLY/.test(msg(vo)), 'older/unsupported client: view-only BLOCKED with a reason, not opened with control', msg(vo));
    report.push(`view-only on an endpoint with no enforcement report → ${vo.status} ${code(vo) ?? ''}`);
    await prisma.endpoint.update({ where: { id: eps['WS-A1'].id }, data: { sessionEnforcement: { viewOnly: true, attendedConsent: true, reportedAt: new Date().toISOString(), simulated: true } } });
    const vo2 = await req('POST', `/endpoints/${eps['WS-A1'].id}/connect?mode=view_only`, { s: T2, business: A });
    check(vo2.status === 200 && vo2.body.data.password === null && vo2.body.data.mode === 'view_only', '[simulated enforcement] view-only allowed, and NO permanent password released', msg(vo2));
    const srv = await req('POST', `/endpoints/${eps['SRV-A1'].id}/connect?mode=view_only`, { s: T2, business: A });
    check(srv.status === 403, 'view-only is for standard workstations only (server refused)', msg(srv));
    const ctl = await req('POST', `/endpoints/${eps['WS-A1'].id}/connect`, { s: T2, business: A });
    check(ctl.status === 403 && /TEMPORARY_GRANT_REQUIRED/.test(msg(ctl)), 'no standing control', msg(ctl));
    const el = await req('POST', `/endpoints/${eps['WS-A1'].id}/connect?mode=elevated`, { s: T2, business: A });
    check(el.status === 403 && /ELEVATION_UNAVAILABLE/.test(msg(el)), 'no elevation', msg(el));
    const un = await req('POST', `/endpoints/${eps['WS-A1'].id}/connect?mode=unattended`, { s: T2, business: A });
    check(un.status === 403 && /UNATTENDED_OFF/.test(msg(un)), 'no unattended', msg(un));
    const pw = await req('GET', `/endpoints/${eps['WS-A1'].id}/password`, { s: T2, business: A });
    check(pw.status === 403 || pw.status === 404, 'no credential reveal', `HTTP ${pw.status}`);

    // Temporary control: request → independent approval with fresh auth → activation with fresh auth.
    const rq = await req('POST', '/security-controls/temporary-access', { s: T2, business: A, body: { endpointId: eps['WS-A1'].id, mode: 'CONTROL', reason: 'customer on the phone, printer driver', durationMinutes: 30 } });
    check(rq.status === 201, 'L2 requests time-limited control', msg(rq));
    const rid = rq.body.data?.id;
    const selfApprove = await req('POST', `/security-controls/temporary-access/${rid}/decision`, { s: await stepUp(T2), business: A, body: { decision: 'APPROVE' } });
    check(selfApprove.status === 403, 'requester cannot approve their own request', msg(selfApprove));
    const noFresh = await req('POST', `/security-controls/temporary-access/${rid}/decision`, { s: A1, body: { decision: 'APPROVE' } });
    check(noFresh.status === 403 && /STEP_UP_REQUIRED/.test(msg(noFresh)), 'approval needs fresh authentication', msg(noFresh));
    const appr = await req('POST', `/security-controls/temporary-access/${rid}/decision`, { s: A1s, body: { decision: 'APPROVE' } });
    check(appr.status === 200 && appr.body.data.status === 'APPROVED', 'independent reviewer approves', msg(appr));
    const before = await req('POST', `/endpoints/${eps['WS-A1'].id}/connect`, { s: T2, business: A });
    check(before.status === 403, 'approved but not activated: still no control', msg(before));
    const actNoFresh = await req('POST', `/security-controls/temporary-access/${rid}/activate`, { s: T2, business: A });
    check(actNoFresh.status === 403, 'activation needs fresh authentication', msg(actNoFresh));
    const T2s = await stepUp(T2);
    const act = await req('POST', `/security-controls/temporary-access/${rid}/activate`, { s: T2s, business: A });
    check(act.status === 200 && act.body.data.activatedAt, 'activated with fresh authentication', msg(act));
    const now = await req('POST', `/endpoints/${eps['WS-A1'].id}/connect`, { s: T2, business: A });
    check(now.status === 200 && now.body.data.password === null && now.body.data.accessPath === 'preset', '[simulated consent] control allowed — and still no permanent password (no direct reconnect)', msg(now));
    const elsewhere = await req('POST', `/endpoints/${eps['WS-A2'].id}/connect`, { s: T2, business: A });
    check(elsewhere.status === 403, 'the grant covers that one computer only', msg(elsewhere));
    // Session expiry.
    await prisma.temporaryAccessRequest.update({ where: { id: rid }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await req('POST', `/endpoints/${eps['WS-A1'].id}/connect`, { s: T2, business: A });
    check(expired.status === 403 && /TEMPORARY_GRANT_REQUIRED/.test(msg(expired)), 'after expiry the same launch is refused', msg(expired));
  }

  section('L3 Senior: wider eligibility, still nothing standing');
  {
    await prisma.endpoint.update({ where: { id: eps['SRV-A1'].id }, data: { sessionEnforcement: { viewOnly: true, attendedConsent: true, simulated: true } } });
    const vo = await req('POST', `/endpoints/${eps['SRV-A1'].id}/connect?mode=view_only`, { s: T3, business: A });
    check(vo.status === 200 && vo.body.data.password === null, '[simulated] view-only on a server', msg(vo));
    const ctl = await req('POST', `/endpoints/${eps['SRV-A1'].id}/connect`, { s: T3, business: A });
    check(ctl.status === 403 && /TEMPORARY_GRANT_REQUIRED/.test(msg(ctl)), 'control only by temporary grant', msg(ctl));
    const el = await req('POST', '/security-controls/temporary-access', { s: T3, business: A, body: { endpointId: eps['SRV-A1'].id, mode: 'ELEVATION', reason: 'needs admin rights', durationMinutes: 15 } });
    check(el.status === 403 && /no privileged helper/.test(msg(el)), 'elevation: eligible to ask, but refused because nothing can enforce it', msg(el));
    const appr = await req('GET', '/security-controls/trust-changes', { s: T3, business: A });
    check(appr.status === 403, 'the tier grants no reviewing or administration', `HTTP ${appr.status}`);
    const enroll = await req('POST', '/enrollment/tokens', { s: T3, business: A, body: {} });
    check(enroll.status !== 201 && enroll.status !== 200, 'no enrollment', `HTTP ${enroll.status}`);
    const cross = await req('GET', `/endpoints/${eps['FRONTDESK-01-B'].id}`, { s: T3, business: B });
    check(cross.status === 403 || cross.status === 404, 'no cross-business access', `HTTP ${cross.status}`);
  }

  section('Conflicting groups and alternate membership');
  {
    const ok5 = await req('POST', `/endpoints/${eps['WS-A5'].id}/event-log`, { s: TG, business: A, body: { logName: 'System' } });
    check(ok5.status === 200, 'group L2 (scoped to WS-A5) allows event logs on WS-A5', msg(ok5));
    const no6 = await req('POST', `/endpoints/${eps['WS-A6'].id}/event-log`, { s: TG, business: A, body: { logName: 'System' } });
    check(no6.status === 403 || no6.status === 404, 'event logs from the group grant do not combine with the direct L1 grant\'s wider scope', `HTTP ${no6.status}`);
    const insp = await req('GET', `/security-controls/inspect?userId=${tg.id}&businessId=${A}&endpointId=${eps['WS-A6'].id}&action=event_logs`, { s: M });
    check(insp.status === 200 && insp.body.data.decision === 'denied', 'inspector agrees: event_logs on WS-A6 denied', msg(insp));
    const insp5 = await req('GET', `/security-controls/inspect?userId=${tg.id}&businessId=${A}&endpointId=${eps['WS-A5'].id}&action=event_logs`, { s: M });
    check(insp5.body.data?.decision === 'allowed', 'inspector: event_logs on WS-A5 allowed, naming the group grant', msg(insp5));
    const duA = await req('POST', `/endpoints/${eps['WS-A2'].id}/connect`, { s: DU, business: A });
    check(duA.status === 403, 'dual user acting in A as L1: no control, despite computers:connect in their own business', msg(duA));
    const duB = await req('POST', `/endpoints/${eps['FRONTDESK-01-B'].id}/connect`, { s: DU, business: B });
    check(duB.status === 200 && typeof duB.body.data.password === 'string', 'dual user in their own business B: unchanged member behaviour', msg(duB));
    const custom = await req('POST', `/endpoints/${eps['WS-A3'].id}/connect`, { s: TC, business: A });
    check(custom.status === 200 && custom.body.data.accessPath === 'legacy_assignment', 'custom pre-0.23 assignment with connect: unchanged', msg(custom));
    const insp2 = await req('GET', `/security-controls/inspect?userId=${t2.id}&businessId=${B}&endpointId=${eps['FRONTDESK-01-B'].id}&action=view_inventory`, { s: M });
    check(insp2.body.data?.decision === 'denied', 'inspector: L2 has no path into business B', msg(insp2));
  }

  section('API keys');
  {
    const raw = `rk_${randomBytes(24).toString('hex')}`;
    await prisma.apiKey.create({ data: { tenantId: tenant.id, customerId: A, createdById: ownerA.id, name: 'pr inventory', keyHash: createHash('sha256').update(raw).digest('hex'), keyPrefix: raw.slice(0, 12), scopes: ['computers:read', 'computers:write', 'enrollment:write'] } });
    for (const [m, p] of [['POST', `/endpoints/${eps['WS-A1'].id}/connect`], ['POST', '/launcher/token'], ['POST', '/security-controls/temporary-access'], ['PUT', '/security-controls/policy']]) {
      const r = await fetch(`${API}${p}`, { method: m, headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' }, body: '{}' });
      check(r.status === 401, `inventory API key cannot ${m} ${p.replace(/\/[a-z0-9]{20,}/, '/:id')}`, `HTTP ${r.status}`);
    }
  }

  section('Demotion mid-job');
  {
    // A grant minted while allowed, redeemed after demotion.
    const g = await req('POST', `/endpoints/${eps['WS-A1'].id}/connect?mode=view_only`, { s: T2, business: A });
    check(g.status === 200, 'L2 mints a view-only launch credential', msg(g));
    const asn = await prisma.technicianAssignment.findFirst({ where: { userId: t2.id, revokedAt: null } });
    const ev = await req('POST', `/endpoints/${eps['WS-A4'].id}/event-log`, { s: T2, business: A, body: { logName: 'System' } });
    check(ev.status === 200, 'L2 queues an event-log read on WS-A4');
    const rv = await req('POST', `/technicians/assignments/${asn.id}/revoke`, { s: M, body: { reason: 'demoted' } });
    check(rv.status === 200, 'assignment revoked (demotion)');
    await assign({ userId: t2.id, businessId: A, presetId: presets.L1.id });
    const red = await fetch(`${API}/endpoints/grants/redeem`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip() }, body: JSON.stringify({ token: g.body.data.grantToken }) });
    check(red.status === 404, 'redemption after demotion is refused', `HTTP ${red.status}`);
    const hb = await fetch(`${API}/enrollment/heartbeat`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip() }, body: JSON.stringify({ rustdeskId: eps['WS-A4'].rid, agentSecret: eps['WS-A4'].secret }) });
    const hbBody = await hb.json().catch(() => ({}));
    const cmds = hbBody?.data?.commands ?? [];
    const row = await prisma.endpointCommand.findFirst({ where: { endpointId: eps['WS-A4'].id, requestedById: t2.id }, orderBy: { createdAt: 'desc' } });
    check(hb.status === 200 && !cmds.some((c) => c.type === 'EVENT_LOG_QUERY') && row?.status === 'FAILED' && /no longer allowed/.test(row.error ?? ''), 'queued command re-checked at dispatch: not handed out, marked FAILED with the reason', `HTTP ${hb.status} ${row?.status} ${row?.error}`);
  }

  section('Trust changes: alert destinations, reviewer appointment, protected classes');
  {
    const cur = (await req('GET', '/security-controls/policy', { s: A1 })).body.data.platform;
    const withHook = { ...cur, alertDestinations: [{ kind: 'webhook', url: `${HOOK}/old/T0/SECRET`, label: 'soc-old' }] };
    delete withHook.alertDestinations[0].origin;
    const r1 = await req('PUT', '/security-controls/policy', { s: A1s, body: withHook });
    check(r1.status === 200 && r1.body.data.pendingReview === true, 'adding an alert destination is a widening → pending independent review', msg(r1));
    const tid = r1.body.data.request.id;
    const self = await req('POST', `/security-controls/trust-changes/${tid}/decision`, { s: A1s, body: { decision: 'APPROVE' } });
    check(self.status === 403 && /NOT_INDEPENDENT/.test(msg(self)), 'requester cannot approve it', msg(self));
    const ok2 = await req('POST', `/security-controls/trust-changes/${tid}/decision`, { s: A2s, body: { decision: 'APPROVE' } });
    check(ok2.status === 200 && ok2.body.data.status === 'APPLIED', 'a second admin applies it', msg(ok2));
    const shown = (await req('GET', '/security-controls/policy', { s: A1 })).body.data.platform;
    check(!JSON.stringify(shown).includes('SECRET') && shown.alertDestinations[0]?.ref, 'the webhook path (its secret) is never returned — label, origin and ref only');
    const listed = await req('GET', '/security-controls/trust-changes', { s: A1 });
    check(!JSON.stringify(listed.body).includes('SECRET'), 'nor recorded in the trust-change list');
    const audit = await prisma.activityLog.findMany({ where: { action: { in: ['TRUST_CHANGE_REQUESTED', 'TRUST_CHANGE_DECIDED', 'ACCESS_POLICY_CHANGED'] }, createdAt: { gt: new Date(Date.now() - 600_000) } } });
    check(audit.length >= 2 && !JSON.stringify(audit, (k, v) => (typeof v === 'bigint' ? v.toString() : v)).includes('SECRET'), 'before/after recorded in the audit log without the secret');
    // Replace the destination: the OLD contact must hear about it.
    const before = hooks.a.length;
    const replace = { ...shown, alertDestinations: [{ kind: 'webhook', url: `${HOOK}/new/T1/OTHER`, label: 'soc-new' }] };
    const r2 = await req('PUT', '/security-controls/policy', { s: A1s, body: replace });
    check(r2.body.data?.pendingReview === true, 'replacing it is reviewed too');
    await sleep(300);
    check(hooks.a.length > before && hooks.a.at(-1).kind === 'trust_change_requested', 'the previous contact is notified of the requested change', `old hook got ${hooks.a.length - before}`);
    await req('POST', `/security-controls/trust-changes/${r2.body.data.request.id}/decision`, { s: A2s, body: { decision: 'DENY' } });

    // Appointing an approver.
    const ap = await req('PATCH', `/technicians/people/${t3.id}/platform-permissions`, { s: A1s, body: { permissions: ['approvals:review'] } });
    check(ap.status === 200 && ap.body.data.pendingReview === true, 'designating an independent reviewer → pending review', msg(ap));
    const t3row = await prisma.user.findUnique({ where: { id: t3.id } });
    check(!t3row.platformPermissions.includes('approvals:review'), 'not applied until someone else approves');
    // Tightening applies at once; removing a mandatory class is refused.
    const tight = { ...shown, maxSessionMinutes: 45 };
    const r3 = await req('PUT', '/security-controls/policy', { s: A1s, body: tight });
    check(r3.status === 200 && r3.body.data.pendingReview === false, 'tightening applies immediately', msg(r3));
    const lock = { ...shown, protectedClasses: ['DOMAIN_CONTROLLER', 'HYPERVISOR', 'RMM_HOST'] };
    const r4 = await req('PUT', '/security-controls/policy', { s: A1s, body: lock });
    check(r4.status === 400 && /always protected/.test(msg(r4)), 'BACKUP_SERVER cannot be removed from the protected classes', msg(r4));
    const dc = await req('PATCH', `/security-controls/endpoints/${eps['BACKUP-A1'].id}/device-class`, { s: A1s, body: { deviceClass: 'WORKSTATION' } });
    check(dc.body.data?.pendingReview === true, 're-classing a backup server as a workstation is a reviewed trust change', msg(dc));
    const presetWiden = await req('PUT', `/security-controls/presets/${presets.L1.id}`, { s: Ms, body: { policy: { ...presets.L1.policy, remoteViewOnly: 'allowed' } } });
    check(presetWiden.status === 200 && presetWiden.body.data.pendingReview === true, 'enabling attended view-only for L1 is a reviewed preset change', msg(presetWiden));
    const presetBad = await req('PUT', `/security-controls/presets/${presets.L1.id}`, { s: Ms, body: { policy: { ...presets.L1.policy, clipboard: 'allowed' } } });
    check(presetBad.status === 400 && /CONTROL_UNAVAILABLE/.test(msg(presetBad)), 'clipboard cannot be enabled (unenforceable)', msg(presetBad));
    const ownerTighten = await req('PUT', `/security-controls/policy/business/${A}`, { s: await stepUp(await login(ownerA.email)), body: { maxSessionMinutes: 20 } });
    check(ownerTighten.status === 200 && ownerTighten.body.data.effective.maxSessionMinutes === 20, 'Business Owner tightens their own business', msg(ownerTighten));
    const ownerLoosen = await req('PUT', `/security-controls/policy/business/${A}`, { s: await stepUp(await login(ownerA.email)), body: { attendedConsent: 'not_required' } });
    check(ownerLoosen.status === 200 && ownerLoosen.body.data.effective.attendedConsent === 'required', 'a business setting can never loosen the platform policy');
  }

  section('Fleet abuse: 40 concurrent single-device jobs, 5-device cap, five entry points');
  {
    // Tighten the custom tier to 5 devices — a tightening, applied at once.
    const cur = (await req('GET', '/security-controls/policy', { s: A1 })).body.data.platform;
    const capped = structuredClone(cur);
    capped.thresholds.custom = { ...capped.thresholds.custom, devices: 5 };
    const r = await req('PUT', '/security-controls/policy', { s: A1s, body: capped });
    check(r.status === 200 && r.body.data.pendingReview === false, 'custom tier capped at 5 distinct devices', msg(r));
    const BU = await login(burst.email);
    const kinds = ['connect', 'cmd', 'launcher', 'eventlog', 'integration'];
    const jobs = fleet.map((e, i) => async () => {
      const k = kinds[i % kinds.length];
      const o = { s: { ...BU, ip: ip() }, business: A };
      if (k === 'connect') return [k, e.id, await req('POST', `/endpoints/${e.id}/connect`, o)];
      if (k === 'cmd') return [k, e.id, await req('GET', `/endpoints/${e.id}/connect.cmd`, o)];
      if (k === 'launcher') return [k, e.id, await req('POST', '/launcher/token', { ...o, body: { endpointId: e.id } })];
      if (k === 'eventlog') return [k, e.id, await req('POST', `/endpoints/${e.id}/event-log`, { ...o, body: { logName: 'System' } })];
      return [k, e.id, await integrationJob(ORG_A, 'cs-burst', e.id)];
    });
    const results = await Promise.all(jobs.map((f) => f()));
    const throttled = results.filter(([, , x]) => x.status === 429).length;
    const admitted = await prisma.privilegedActivity.findMany({ where: { identity: `user:${burst.id}` } });
    const distinct = new Set(admitted.map((a) => a.endpointId));
    // "Entered dispatch" = a launch credential minted, a command queued, a job accepted, a session recorded.
    const [grants, tokens, commands, ijobs, sessions] = await Promise.all([
      prisma.connectionGrant.findMany({ where: { userId: burst.id }, select: { endpointId: true } }),
      prisma.launcherToken.findMany({ where: { userId: burst.id }, select: { targetEndpointId: true } }),
      prisma.endpointCommand.findMany({ where: { requestedById: burst.id }, select: { endpointId: true } }),
      prisma.integrationJob.findMany({ where: { actorUserId: burst.id }, select: { endpointId: true } }),
      prisma.supportSession.findMany({ where: { technicianId: burst.id }, select: { endpointId: true } }),
    ]);
    const dispatched = new Set([...grants.map((x) => x.endpointId), ...tokens.map((x) => x.targetEndpointId), ...commands.map((x) => x.endpointId), ...ijobs.map((x) => x.endpointId), ...sessions.map((x) => x.endpointId)].filter(Boolean));
    check(throttled === 0, `no request was stopped by the per-IP throttler (${throttled} × 429) — the cap below is the abuse guard's`);
    check(distinct.size <= 5, `admitted distinct devices ≤ 5 (${distinct.size})`);
    check(dispatched.size <= 5, `distinct devices that entered dispatch ≤ 5 (${dispatched.size})`);
    const byKind = Object.fromEntries(kinds.map((k) => [k, results.filter(([kk]) => kk === k).map(([, , x]) => x.status).join(',')]));
    report.push(`40 concurrent: admitted ${distinct.size} distinct devices; entered dispatch ${dispatched.size}; statuses by entry point ${JSON.stringify(byKind)} (connect.cmd answers 503 after admission: the scratch stack has no relay host); statuses ${JSON.stringify(results.reduce((m, [, , x]) => ({ ...m, [x.status]: (m[x.status] ?? 0) + 1 }), {}))}`);
    const pause = await prisma.identityPause.findFirst({ where: { identity: `user:${burst.id}`, clearedAt: null } });
    check(!!pause, `identity paused (${pause?.reason})`);
    await sleep(500);
    const alert = await prisma.securityAlert.findFirst({ where: { identity: `user:${burst.id}`, kind: 'fleet_abuse_threshold' } });
    check(alert && alert.delivered, 'alert raised and delivered to the independent contact', JSON.stringify(alert));
    check(hooks.a.some((h) => h.kind === 'fleet_abuse_threshold' && h.identity === `user:${burst.id}`), 'the webhook received it');
    const after = await req('POST', `/endpoints/${eps['WS-A7'].id}/connect`, { s: BU, business: A });
    check(after.status === 403 && /IDENTITY_PAUSED/.test(msg(after)), 'paused: the next launch anywhere is refused with the reason', msg(after));
    // Suppression is not a pause-lift.
    const sup = await req('POST', '/security-controls/alert-suppressions', { s: A2s, body: { identity: `user:${burst.id}`, kind: 'fleet_abuse_threshold', reason: 'known maintenance noise', until: new Date(Date.now() + 3600_000).toISOString() } });
    check(sup.status === 201, 'alerts for this identity suppressed', msg(sup));
    const still = await req('POST', `/endpoints/${eps['WS-A7'].id}/connect`, { s: BU, business: A });
    check(still.status === 403, 'suppressing the alert does not lift the pause');
    const selfClear = await req('POST', `/security-controls/pauses/${pause.id}/clear`, { s: await stepUp(BU) });
    check(selfClear.status === 403, 'the paused identity cannot clear its own pause', `HTTP ${selfClear.status}`);
    // Maintenance exception: approved by someone else, named computers, expiry.
    const mx = await req('POST', '/security-controls/maintenance-exceptions', { s: A1s, body: { identity: `user:${burst.id}`, endpointIds: fleet.slice(10, 13).map((e) => e.id), kinds: ['LAUNCH'], reason: 'patch night', expiresAt: new Date(Date.now() + 3600_000).toISOString() } });
    const mxSelf = await req('POST', `/security-controls/maintenance-exceptions/${mx.body.data.id}/decision`, { s: A1s, body: { decision: 'APPROVE' } });
    check(mxSelf.status === 403, 'maintenance exception: requester cannot approve it');
    const mxOk = await req('POST', `/security-controls/maintenance-exceptions/${mx.body.data.id}/decision`, { s: A2s, body: { decision: 'APPROVE' } });
    check(mxOk.status === 200, 'second admin approves the exception');
    const clr = await req('POST', `/security-controls/pauses/${pause.id}/clear`, { s: A2s });
    check(clr.status === 200, 'an independent admin clears the pause');
    const inEx = await req('POST', `/endpoints/${fleet[10].id}/connect`, { s: BU, business: A });
    check(inEx.status === 200, 'a computer named in the exception: allowed past the cap', msg(inEx));
    const outEx = await req('POST', `/endpoints/${fleet[20].id}/connect`, { s: BU, business: A });
    check(outEx.status === 403, 'a computer not in the exception: trips the cap again', msg(outEx));
  }

  section('Stolen-session drill (attacker holds admin2\'s session cookie, not the password)');
  {
    const thief = { cookie: A2.cookie, ip: ip() };   // no step_up
    const drill = [];
    const enr = await req('POST', '/enrollment/tokens', { s: thief, body: { businessId: A, customerId: A } });
    drill.push(['enroll a machine', enr.status, code(enr) ?? (enr.body?.message ?? '').toString().slice(0, 60)]);
    const appoint = await req('PATCH', `/technicians/people/${t1.id}/platform-permissions`, { s: thief, body: { permissions: ['approvals:review'] } });
    check(appoint.status === 403 && /STEP_UP_REQUIRED/.test(msg(appoint)), 'appoint an approver: refused, fresh authentication required', msg(appoint));
    drill.push(['appoint an approver', appoint.status, code(appoint)]);
    const hook = await req('PUT', '/security-controls/policy', { s: thief, body: { ...(await req('GET', '/security-controls/policy', { s: thief })).body.data.platform, alertDestinations: [] } });
    check(hook.status === 403, 'silence the alerts: refused (fresh auth; and it would be a reviewed widening)', msg(hook));
    drill.push(['remove alert contacts', hook.status, code(hook)]);
    const bk = await req('POST', `/endpoints/${eps['BACKUP-A1'].id}/connect`, { s: thief });
    check(bk.status === 403 && /PROTECTED_DEVICE_CLASS/.test(msg(bk)), 'control the backup server: refused even for a Platform Admin session', msg(bk));
    drill.push(['control BACKUP-A1', bk.status, code(bk)]);
    const lt = await req('POST', '/launcher/token', { s: thief, body: { endpointId: eps['BACKUP-A1'].id } });
    check(lt.status === 403, 'via the launcher: refused', msg(lt));
    const bkGrants = await prisma.connectionGrant.count({ where: { endpointId: eps['BACKUP-A1'].id } });
    check(bkGrants === 0, 'endpoint outcome: no launch credential for BACKUP-A1 exists to replay');
    const pwBk = await req('GET', `/endpoints/${eps['BACKUP-A1'].id}/password`, { s: thief });
    check(pwBk.status === 403, 'reconnect directly: the permanent password cannot be revealed without fresh auth', msg(pwBk));
    drill.push(['reveal BACKUP-A1 password for a direct reconnect', pwBk.status, code(pwBk)]);
    // Split fleet action from the stolen session.
    const results = await Promise.all(fleet.slice(0, 40).map((e) => req('POST', `/endpoints/${e.id}/inventory/refresh`, { s: { ...thief, ip: ip() } })));
    const admitted = new Set((await prisma.privilegedActivity.findMany({ where: { identity: `user:${admin2.id}` } })).map((x) => x.endpointId));
    const paused = await prisma.identityPause.findFirst({ where: { identity: `user:${admin2.id}`, clearedAt: null } });
    check(admitted.size <= 60 && !!paused === (admitted.size >= 60), `split fleet action: ${admitted.size} distinct devices admitted under the Platform Admin cap (60); paused: ${!!paused}`);
    drill.push(['40 single-device inventory refreshes', results.filter((x) => x.status === 200).length + ' × 200', `${admitted.size} devices counted, cap 60, paused=${!!paused}`]);
    for (const d of drill) report.push(`drill: ${d[0]} → ${d[1]} ${d[2] ?? ''}`);
  }

  section('Protected device classes and the managed-workstation requirement');
  {
    const rq = await req('POST', '/security-controls/temporary-access', { s: A1, body: { endpointId: eps['DC-A1'].id, mode: 'PROTECTED_EXCEPTION', reason: 'DC repair', durationMinutes: 30 } });
    check(rq.status === 201, 'admin requests a protected-device exception', msg(rq));
    await req('POST', `/security-controls/temporary-access/${rq.body.data.id}/decision`, { s: A2s, body: { decision: 'APPROVE' } });
    const pwAct = await req('POST', `/security-controls/temporary-access/${rq.body.data.id}/activate`, { s: A1s });
    check(pwAct.status === 403 && /passkey/.test(msg(pwAct)), 'activation with a password step-up refused: a passkey is required', msg(pwAct));
    const still = await req('POST', `/endpoints/${eps['DC-A1'].id}/connect`, { s: A1 });
    check(still.status === 403, 'without activation (and without an attested managed workstation) the DC stays unreachable', msg(still));
    report.push('protected exception: approved, but activation needs a passkey and launch needs an attested managed workstation — no attestation exists, so unreachable (fail-closed)');
  }
}

async function cleanup() {
  try {
    const users = created.users, biz = created.businesses;
    const eps = (await prisma.endpoint.findMany({ where: { customerId: { in: biz } }, select: { id: true } })).map((e) => e.id);
    await prisma.privilegedActivity.deleteMany({ where: { OR: [{ identity: { in: users.map((u) => `user:${u}`) } }, { identity: `peer:${PEER}` }] } });
    await prisma.identityPause.deleteMany({ where: { identity: { in: [...users.map((u) => `user:${u}`), `peer:${PEER}`] } } });
    await prisma.maintenanceException.deleteMany({ where: { identity: { in: users.map((u) => `user:${u}`) } } });
    await prisma.alertSuppression.deleteMany({ where: { createdById: { in: users } } });
    await prisma.securityAlert.deleteMany({ where: { OR: [{ identity: { in: users.map((u) => `user:${u}`) } }, { customerId: { in: biz } }] } });
    await prisma.temporaryAccessRequest.deleteMany({ where: { userId: { in: users } } });
    await prisma.trustChangeRequest.deleteMany({ where: { requestedById: { in: users } } });
    await prisma.accessPolicy.deleteMany({ where: { customerId: { in: biz } } });
    // Restore the shipped platform policy so the next suite starts clean.
    const { DEFAULT_CONTROLS } = require(path.join(dist, 'security-controls/presets.js'));
    await prisma.accessPolicy.update({ where: { id: 'singleton' }, data: { controls: DEFAULT_CONTROLS } }).catch(() => {});
    const l1 = await prisma.technicianPreset.findUnique({ where: { key: 'l1-help-desk' } });
    if (l1?.description?.startsWith('edited ')) {
      const { BUILT_IN_PRESETS } = require(path.join(dist, 'security-controls/presets.js'));
      await prisma.technicianPreset.update({ where: { id: l1.id }, data: { description: BUILT_IN_PRESETS[0].description } });
    }
    await prisma.integrationJob.deleteMany({ where: { customerId: { in: biz } } }).catch(() => {});
    await prisma.integrationTechnicianMapping.deleteMany({ where: { peerId: PEER } });
    await prisma.integrationOrgMapping.deleteMany({ where: { peerId: PEER } });
    await prisma.endpointCommand.deleteMany({ where: { endpointId: { in: eps } } });
    await prisma.supportSession.deleteMany({ where: { customerId: { in: biz } } }).catch(() => {});
    await prisma.launcherToken.deleteMany({ where: { userId: { in: users } } });
    await prisma.connectionGrant.deleteMany({ where: { userId: { in: users } } });
    await prisma.apiKey.deleteMany({ where: { customerId: { in: biz } } });
    await prisma.technicianAssignment.deleteMany({ where: { customerId: { in: biz } } });
    await prisma.technicianGroup.deleteMany({ where: { name: `pr-group-${sfx}` } });
    await prisma.endpoint.deleteMany({ where: { id: { in: eps } } });
    await prisma.membership.deleteMany({ where: { userId: { in: users } } });
    await prisma.customer.deleteMany({ where: { id: { in: biz } } }).catch((e) => console.log(`  (cleanup: businesses kept — ${e.code ?? e.message})`));
    await prisma.user.deleteMany({ where: { id: { in: users } } }).catch((e) => console.log(`  (cleanup: users kept — ${e.code ?? e.message})`));
  } catch (e) { console.log(`  cleanup incomplete: ${e.message}`); }
}

try {
  await main();
} catch (e) {
  bad('suite crashed', e.stack ?? String(e));
  if (api?.log) console.log(api.log.slice(-2500));
} finally {
  await stopApi();
  await cleanup();
  hookSrv.close();
  await prisma.$disconnect();
}
console.log('\n\x1b[1mReport\x1b[0m');
for (const r of report) console.log(`  • ${r}`);
console.log('  • RustDesk restrictions: NONE live-verified. View-only and attended consent were simulated by setting Endpoint.sessionEnforcement; no shipped agent reports it.');
console.log(`\n${fail === 0 ? '\x1b[32m✓' : '\x1b[31m✗'} ${pass} passed, ${fail} failed\x1b[0m`);
if (fail) { for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1); }
