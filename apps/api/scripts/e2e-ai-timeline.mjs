#!/usr/bin/env node
/**
 * End-to-end proof of the device page's AI summary through ClientSt0r (0.34).
 *
 *   - rem0te asks only after the peer's own capabilities document lists
 *     `device_timeline_v1` (PROPOSED P12); until then the route refuses with
 *     PEER_UNSUPPORTED and the status says "Needs ClientSt0r support for
 *     device_timeline_v1", and nothing reaches the gateway;
 *   - the request is signed like every other rem0te → ClientSt0r request,
 *     names the organization the computer's business is mapped to and a
 *     profile both sides allow, and matches the proposed schema;
 *   - redaction: no secret, e-mail, address, RustDesk ID, profile path,
 *     computer name, hostname, business, site, tag or note author reaches
 *     the peer, and what the console previews is exactly what is sent;
 *   - capabilities: computers:edit AND integration:ticket_analysis; a
 *     refusal sends nothing and is audited;
 *   - containment: an `integration` pause (business or global) stops it;
 *   - audit: REQUESTED before sending, FINISHED after, REFUSED for refusals,
 *     never the text;
 *   - response integrity: a forged signature, a mismatched echo, a refusal or
 *     a malformed output saves nothing;
 *   - business A/B isolation, with the same request working for B as the
 *     negative control.
 *
 * This is a REFERENCE peer modelled on the proposal, not ClientSt0r: nothing
 * here shows that ClientSt0r implements P11/P12.
 *
 * Self-starting: generates every key, runs the reference peer on loopback,
 * runs its own API from dist/ on AITL_API_PORT (3471) against DATABASE_URL,
 * which must name a scratch/test database.
 *
 *   cd apps/api && npx nest build
 *   DATABASE_URL=…/rem0te_ai_timeline_test node scripts/e2e-ai-timeline.mjs
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const C = require(path.join(dist, 'integration/crypto.js'));
const K = require(path.join(dist, 'integration/contract.js'));

const DB = process.env.DATABASE_URL ?? '';
const dbName = DB.split('/').pop()?.split('?')[0] ?? '';
if (!/scratch|test/.test(dbName)) { console.error(`Refusing to run against database "${dbName}": name must contain "scratch" or "test".`); process.exit(2); }
const PORT = Number(process.env.AITL_API_PORT ?? 3471);
if ([3000, 3001, 443].includes(PORT)) { console.error(`Refusing port ${PORT}: that is a production port.`); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'ai-timeline-e2e-password-1';
const TAG = `AT${sfx}`;

let pass = 0, fail = 0; const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;

// ── Keys and the reference peer ─────────────────────────────────────────────
const tmp = mkdtempSync(path.join(tmpdir(), 'rem0te-aitl-'));
const pair = () => generateKeyPairSync('ed25519');
const pem = (k) => k.export({ type: 'spki', format: 'pem' }).toString();
const self = pair(), peerReq = pair(), peerDel = pair(), rogue = pair();
writeFileSync(path.join(tmp, 'self.pem'), self.privateKey.export({ type: 'pkcs8', format: 'pem' }));
const PEER_AUD = 'clientst0r:aitl', PEER = 'clientst0r-aitl';

const peer = {
  /** What the capabilities document advertises; null = 404 (the peer has no such endpoint). */
  tasks: [{ task: 'ticket_triage_v1', model_profiles: ['triage-fast'] }],
  capsSigner: 'peer', capsPeerId: PEER,
  /** Inference behaviour: ok | forged | wrong_org | refused | bad_output | evil | down */
  mode: 'ok',
  capsRequests: 0, badSignatures: 0, inference: [],
};
function readBody(req) { return new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); }); }
function verifyIncoming(req, body) {
  if (req.headers['rem0te-key-id'] !== 'rem0te/rem0te-aitl-1') return false;
  return C.verifyEd25519(self.publicKey, C.requestSigningString({
    audience: PEER_AUD, method: req.method, pathWithQuery: req.url, timestamp: req.headers['rem0te-timestamp'],
    nonce: req.headers['rem0te-nonce'], bodySha256: C.sha256Hex(body),
  }), req.headers['rem0te-signature']);
}
function reply(res, req, status, obj, signer = peerReq.privateKey) {
  const text = JSON.stringify(obj);
  const sig = C.signEd25519(signer, C.responseSigningString(req.headers['rem0te-nonce'], C.sha256Hex(Buffer.from(text))));
  res.writeHead(status, { 'content-type': 'application/json', 'rem0te-key-id': `${PEER}/req-1`, 'rem0te-response-signature': sig }).end(text);
}
const fake = createServer(async (req, res) => {
  const body = await readBody(req);
  if (!verifyIncoming(req, body)) { peer.badSignatures++; res.writeHead(401).end('bad sig'); return; }
  if (req.method === 'GET' && req.url === '/api/integration/v1/capabilities') {
    peer.capsRequests++;
    if (!peer.tasks) { res.writeHead(404).end(); return; }
    reply(res, req, 200, { contract: 'ticket-rmm-v1', peer_id: peer.capsPeerId, inference_tasks: peer.tasks, clientst0r_version: 'reference' },
      peer.capsSigner === 'rogue' ? rogue.privateKey : peerReq.privateKey);
    return;
  }
  if (req.method !== 'POST' || req.url !== '/api/integration/v1/inference') { res.writeHead(404).end(); return; }
  const r = JSON.parse(body.toString());
  peer.inference.push(r);
  if (peer.mode === 'down') { res.writeHead(503).end('{}'); return; }
  const out = {
    contract: 'ticket-rmm-v1', request_id: r.request_id, organization_id: r.organization_id, model_profile: r.model_profile,
    task: r.task, resolved_model: `ref-${r.model_profile}`, status: 'ok', usage: { input_tokens: 321, output_tokens: 54 },
    output: { summary: `Reference summary for ${r.organization_id}: ${r.input.untrusted_segments.length} segments.` },
  };
  if (peer.mode === 'wrong_org') out.organization_id = 'some-other-org';
  if (peer.mode === 'refused') { out.status = 'refused'; delete out.output; }
  if (peer.mode === 'bad_output') out.output = { text: 'not the schema' };
  if (peer.mode === 'evil') out.output = { summary: 'Fine.\u202e', approve_fix: true, run_command: 'format c:' };
  reply(res, req, 200, out, peer.mode === 'forged' ? rogue.privateKey : peerReq.privateKey);
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const FAKE = `http://127.0.0.1:${fake.address().port}`;

const PROFILES = ['triage-fast', 'summary-fast'];
function writePeers(file, { caps = true } = {}) {
  writeFileSync(file, JSON.stringify({
    self: { keyId: 'rem0te-aitl-1', privateKeyFile: path.join(tmp, 'self.pem') },
    peers: [{
      id: PEER, audience: 'rem0te:aitl', peerAudience: PEER_AUD,
      requestKeys: [{ kid: 'req-1', publicKeyPem: pem(peerReq.publicKey) }],
      delegationKeys: [{ kid: 'del-1', publicKeyPem: pem(peerDel.publicKey) }],
      inferenceUrl: `${FAKE}/api/integration/v1/inference`, eventsUrl: `${FAKE}/api/integration/v1/events`,
      ...(caps ? { capabilitiesUrl: `${FAKE}/api/integration/v1/capabilities` } : {}),
      modelProfiles: PROFILES,
    }],
  }));
  return file;
}
const peersFile = writePeers(path.join(tmp, 'peers.json'));
const peersNoCaps = writePeers(path.join(tmp, 'peers-nocaps.json'), { caps: false });

// ── API ─────────────────────────────────────────────────────────────────────
const baseEnv = {
  ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATABASE_URL: DB,
  JWT_SECRET: randomBytes(32).toString('hex'), LAUNCHER_TOKEN_SECRET: randomBytes(32).toString('hex'),
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? randomBytes(32).toString('hex'), TRUSTED_PROXIES: 'loopback',
  HBBS_PRESENCE_HOST: '127.0.0.2', MONITOR_SWEEP: 'off', AUDIT_SEALER: 'off', CLIENT_UPDATE_SWEEP: 'off',
  PATCH_POLICY_SWEEP: 'off', METRIC_SWEEP: 'off', INTEGRATION_CAPABILITIES_TTL_MS: '0',
  VERSION_FILE: path.resolve(here, '..', '..', '..', 'version.json'),
};
// A provider key in the environment must change nothing: rem0te never reads one.
baseEnv.ANTHROPIC_API_KEY = 'sk-ant-must-never-be-used';
let api;
function startApi(extra) {
  api = spawn(process.execPath, [path.join(dist, 'main.js')], { env: { ...baseEnv, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  api.log = ''; api.stdout.on('data', (d) => { api.log += d; }); api.stderr.on('data', (d) => { api.log += d; });
}
async function stopApi() { if (!api || api.exitCode !== null) return; await new Promise((r) => { api.once('exit', r); api.kill('SIGTERM'); }); }
async function waitUp() {
  for (let i = 0; i < 150; i++) { try { const r = await fetch(`${API}/health`); if (r.status < 500) return; } catch { /* not yet */ } await sleep(300); }
  throw new Error(`api did not come up:\n${api.log.slice(-3000)}`);
}
async function restart(extra) { await stopApi(); startApi(extra); await waitUp(); for (const u of Object.values(S)) Object.assign(u, await login(u.email)); }

async function req(method, p, s, body) {
  const h = { 'x-forwarded-for': ip() };
  if (s) h.cookie = s.cookie;
  if (body) h['content-type'] = 'application/json';
  await sleep(60); // pace under the 20 req/s burst throttler
  const r = await fetch(`${API}${p}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j, data: j?.data };
}
async function login(email) {
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip() }, body: JSON.stringify({ email, password: PW }) });
  const mm = (r.headers.get('set-cookie') ?? '').match(/access_token=([^;]+)/);
  if (r.status !== 200 || !mm) throw new Error(`login ${email}: ${r.status} ${await r.text()}`);
  return { email, cookie: `access_token=${mm[1]}` };
}
const status = (s, id) => req('GET', `/endpoints/${id}/timeline`, s);
const generate = (s, id) => req('POST', `/endpoints/${id}/timeline/generate`, s);
const msg = (r) => `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`;
const code = (r) => r.body?.code ?? r.body?.message?.code ?? r.data?.code;

const S = {};
const created = { businesses: [], users: [], endpoints: [] };

async function all() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });
  const roleUser = await prisma.role.findFirst({ where: { type: 'BUSINESS_USER' } });

  section('Fixtures (synthetic): Businesses A, B and an unmapped C; notes full of secrets');
  const A = await prisma.customer.create({ data: { tenantId: tenant.id, name: `${TAG} Acme Dental` } });
  const B = await prisma.customer.create({ data: { tenantId: tenant.id, name: `${TAG} Birch Legal` } });
  const Cb = await prisma.customer.create({ data: { tenantId: tenant.id, name: `${TAG} Cedar` } });
  created.businesses.push(A.id, B.id, Cb.id);
  const siteA = await prisma.site.create({ data: { tenantId: tenant.id, customerId: A.id, name: `${TAG} Reception Site` } });
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag, extra = {}) => { const u = await prisma.user.create({ data: { email: `at-${tag}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'AT', lastName: tag, status: 'ACTIVE', ...extra } }); created.users.push(u.id); return u; };
  const ownerA = await mkUser('owner-a'), ownerB = await mkUser('owner-b'), ownerC = await mkUser('owner-c');
  const viewA = await mkUser('view-a'), editA = await mkUser('edit-a'), techA = await mkUser('tech-a');
  await prisma.membership.create({ data: { userId: ownerA.id, tenantId: tenant.id, customerId: A.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: ownerB.id, tenantId: tenant.id, customerId: B.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: ownerC.id, tenantId: tenant.id, customerId: Cb.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: viewA.id, tenantId: tenant.id, customerId: A.id, roleId: roleUser.id, capabilities: ['computers:view'] } });
  await prisma.membership.create({ data: { userId: editA.id, tenantId: tenant.id, customerId: A.id, roleId: roleUser.id, capabilities: ['computers:view', 'computers:edit'] } });
  await prisma.technicianAssignment.create({ data: { tenantId: tenant.id, customerId: A.id, userId: techA.id, capabilities: ['computers:view', 'computers:edit', 'integration:ticket_analysis'] } });

  const mkEp = async (biz, name, extra = {}) => {
    const e = await prisma.endpoint.create({ data: {
      tenantId: tenant.id, customerId: biz.id, name, hostname: `${name.toLowerCase()}.corp.acme-dental.com`, platform: 'Windows', osVersion: 'Windows 11 Pro 23H2',
      status: 'ACTIVE', isOnline: true, isManaged: true, accessMode: 'COMPANY_WIDE', lastSeenAt: new Date(Date.now() - 120_000), agentVersion: '0.30.1',
      ipAddress: '203.0.113.77', ...extra,
    } });
    created.endpoints.push(e.id);
    await prisma.rustdeskNode.create({ data: { tenantId: tenant.id, endpointId: e.id, rustdeskId: String(100000000 + ((Math.random() * 899999999) | 0)) } });
    return e;
  };
  const epA = await mkEp(A, `${TAG}-FRONTDESK-JSMITH`, { siteId: siteA.id });
  const epB = await mkEp(B, `${TAG}-FRONTDESK-JSMITH`);
  const epC = await mkEp(Cb, `${TAG}-CEDAR-PC`);
  await prisma.endpointTag.create({ data: { endpointId: epA.id, tag: `${TAG}-vip-ceo` } }).catch(() => {});
  const rdA = (await prisma.rustdeskNode.findUnique({ where: { endpointId: epA.id } })).rustdeskId;
  const SECRETS = {
    password: 'Sunshine-Pa55!', email: 'dr.jane.doe@acme-dental.example', ip: '192.168.40.12', ip6: '2001:db8:40::12',
    mac: '3C:52:82:11:22:33', rustdesk: rdA, path: 'C:\\Users\\jsmith\\Documents', apiKey: `rk_live_${randomBytes(10).toString('hex')}`,
    bearer: `Bearer ${randomBytes(24).toString('base64url')}`,
  };
  const note = (endpointId, content, ago, isPinned = false, authorId = ownerA.id) => prisma.note.create({ data: { tenantId: tenant.id, authorId, endpointId, content, isPinned, createdAt: new Date(Date.now() - ago) } });
  await note(epA.id, `${TAG}-NOTE-1 Reset the admin password=${SECRETS.password} and mailed ${SECRETS.email}.`, 9 * 86400_000, true);
  await note(epA.id, `${TAG}-NOTE-2 Printer moved to ${SECRETS.ip} / ${SECRETS.ip6}; NIC ${SECRETS.mac}.`, 5 * 86400_000);
  await note(epA.id, `${TAG}-NOTE-3 RustDesk ${SECRETS.rustdesk}, files under ${SECRETS.path}, API key ${SECRETS.apiKey}, header ${SECRETS.bearer}.`, 2 * 86400_000);
  await note(epB.id, `${TAG}-B-ONLY-NOTE Birch's file server is flaky.`, 86400_000, false, ownerB.id);
  await prisma.supportSession.create({ data: { tenantId: tenant.id, customerId: A.id, technicianId: ownerA.id, endpointId: epA.id, status: 'SESSION_COMPLETED',
    contactName: `${TAG} Jane Contact`, contactEmail: `contact-${sfx}@acme-dental.example`, issueDescription: `${TAG}-ISSUE Outlook crashes; user ${SECRETS.email}`,
    disposition: `${TAG}-FIX Rebuilt profile at ${SECRETS.path}`, duration: 1500, notes: `${TAG}-SESSION-NOTES-NEVER-SENT`, createdAt: new Date(Date.now() - 3 * 86400_000) } });
  const ORG_A = `org-a-${sfx}`, ORG_B = `org-b-${sfx}`;
  await prisma.integrationOrgMapping.create({ data: { peerId: PEER, externalOrgId: ORG_A, customerId: A.id, tenantId: tenant.id, createdById: 'aitl' } });
  await prisma.integrationOrgMapping.create({ data: { peerId: PEER, externalOrgId: ORG_B, customerId: B.id, tenantId: tenant.id, createdById: 'aitl' } });
  check(true, `businesses ${A.id} / ${B.id} / ${Cb.id} (unmapped); computers ${epA.id} / ${epB.id} / ${epC.id}`);

  startApi({ INTEGRATION_PEERS_FILE: peersFile }); await waitUp();
  for (const [k, u] of Object.entries({ ownerA, ownerB, ownerC, viewA, editA, techA })) S[k] = await login(u.email);

  section('Capability off: ClientSt0r does not advertise device_timeline_v1');
  {
    const st = await status(S.ownerA, epA.id);
    check(st.status === 200 && st.data.available === false && st.data.code === 'PEER_UNSUPPORTED', 'status: not available, PEER_UNSUPPORTED', msg(st));
    check(/Needs ClientSt0r support for device_timeline_v1/.test(st.data?.message ?? ''), 'status message: "Needs ClientSt0r support for device_timeline_v1"', st.data?.message);
    check(peer.capsRequests >= 1, `rem0te asked the peer's capabilities document, signed (${peer.capsRequests} requests, ${peer.badSignatures} bad signatures)`, String(peer.capsRequests));
    const g = await generate(S.ownerA, epA.id);
    check(g.status === 409 && code(g) === 'PEER_UNSUPPORTED', 'generate → 409 PEER_UNSUPPORTED', msg(g));
    check(peer.inference.length === 0, 'nothing reached the gateway', String(peer.inference.length));
    const ref = await prisma.activityLog.findFirst({ where: { action: 'AI_TIMELINE_REFUSED', resourceId: epA.id }, orderBy: { createdAt: 'desc' } });
    check(ref?.metadata?.code === 'PEER_UNSUPPORTED' && ref.customerId === A.id, 'refusal audited as AI_TIMELINE_REFUSED against business A', JSON.stringify(ref?.metadata));

    peer.tasks = null;
    const st404 = await status(S.ownerA, epA.id);
    check(st404.data?.code === 'PEER_UNREACHABLE' && st404.data.available === false, 'a peer with no capabilities endpoint (404) → not available, PEER_UNREACHABLE', msg(st404));
    peer.tasks = [{ task: 'device_timeline_v1', model_profiles: ['summary-premium'] }];
    const stProf = await status(S.ownerA, epA.id);
    check(stProf.data?.code === 'PROFILE_NOT_ALLOWED', 'advertised only with a profile the peers file does not allow → PROFILE_NOT_ALLOWED', msg(stProf));
    peer.tasks = [{ task: 'device_timeline_v1', model_profiles: ['summary-fast'] }];
    peer.capsSigner = 'rogue';
    const stForged = await status(S.ownerA, epA.id);
    check(stForged.data?.code === 'PEER_UNREACHABLE' && /RESPONSE_SIGNATURE_INVALID/.test(stForged.data.message), 'capabilities signed by an unlisted key are not believed', msg(stForged));
    peer.capsSigner = 'peer'; peer.capsPeerId = 'someone-else';
    const stOther = await status(S.ownerA, epA.id);
    check(stOther.data?.code === 'PEER_UNREACHABLE' && /RESPONSE_MISMATCH/.test(stOther.data.message), 'a capabilities document naming another peer is not believed', msg(stOther));
    peer.capsPeerId = PEER;
    check(peer.inference.length === 0, 'still nothing reached the gateway', String(peer.inference.length));
  }

  section('Capability on: status, preview and the request itself');
  let sent, preview;
  {
    const st = await status(S.ownerA, epA.id);
    check(st.data?.available === true && st.data.code === 'READY' && st.data.organizationId === ORG_A && st.data.modelProfile === 'summary-fast' && st.data.canRequest === true,
      'status: READY, organization A, profile summary-fast, owner can request', msg(st));
    check(Array.isArray(st.data?.fields) && st.data.fields.length >= 6 && Array.isArray(st.data.notSent) && st.data.notSent.length >= 6, 'status lists the fields that leave and the ones that never do');
    preview = st.data?.preview;
    check(preview?.notes === 3 && preview.sessions === 1 && preview.redactions?.secret >= 2, `preview: 3 notes, 1 session, redaction counts ${JSON.stringify(preview?.redactions)}`);

    const g = await generate(S.ownerA, epA.id);
    check(g.status === 200 && g.data?.text === `Reference summary for ${ORG_A}: 5 segments.` && g.data.source?.organizationId === ORG_A && g.data.source.resolvedModel === 'ref-summary-fast',
      'generate → 200 with the peer\'s summary and its source', msg(g));
    const row = await prisma.endpoint.findUnique({ where: { id: epA.id }, select: { aiTimeline: true } });
    check(row.aiTimeline === g.data?.text, 'the summary is stored on the computer');
    check(peer.inference.length === 1 && peer.badSignatures === 0, 'exactly one signed request reached the gateway', `${peer.inference.length} requests, ${peer.badSignatures} bad signatures`);
    sent = peer.inference[0];
    check(K.TimelineInferenceRequest.safeParse(sent).success, 'the request matches the proposed timeline-inference-request schema');
    check(sent.task === 'device_timeline_v1' && sent.organization_id === ORG_A && sent.model_profile === 'summary-fast' && sent.input.rem0te_endpoint_id === epA.id,
      'task device_timeline_v1, organization A, profile summary-fast, computer named by its rem0te id', JSON.stringify({ t: sent.task, o: sent.organization_id, p: sent.model_profile }));
    check(!('job_id' in sent), 'no ticket job is invented for it');
  }

  section('Redaction: what reached the peer');
  {
    const text = JSON.stringify(sent);
    const leaks = Object.entries(SECRETS).filter(([, v]) => text.includes(v)).map(([k]) => k);
    check(leaks.length === 0, 'no password, e-mail, IPv4/IPv6, MAC, RustDesk ID, profile path, API key or bearer token', leaks.join(', '));
    const ctx = { name: `${TAG}-FRONTDESK-JSMITH`, hostname: 'corp.acme-dental.com', business: 'Acme Dental', site: 'Reception Site', tag: 'vip-ceo',
      author: `at-owner-a-${sfx}`, contactName: 'Jane Contact', contactEmail: `contact-${sfx}`, sessionNotes: 'SESSION-NOTES-NEVER-SENT', endpointIp: '203.0.113.77' };
    const ctxLeaks = Object.entries(ctx).filter(([, v]) => text.includes(v)).map(([k]) => k);
    check(ctxLeaks.length === 0, 'no computer name, hostname, business, site, tag, note author, session contact, session notes or computer address', ctxLeaks.join(', '));
    check(text.includes(`${TAG}-NOTE-1`) && text.includes(`${TAG}-NOTE-3`) && text.includes(`${TAG}-ISSUE`) && text.includes(`${TAG}-FIX`), 'the notes and the session issue/resolution themselves are sent (redacted)');
    check(text.includes('password=[redacted]') && text.includes('[email]') && text.includes('[ip]') && text.includes('[mac]') && text.includes('%USERPROFILE%'), 'redactions are visible as placeholders');
    check(JSON.stringify(sent.input.untrusted_segments) === JSON.stringify(preview.untrusted_segments) && JSON.stringify(sent.input.redactions) === JSON.stringify(preview.redactions),
      'the console\'s preview is exactly what was sent');
    check(!text.includes('sk-ant-'), 'the provider key in rem0te\'s environment was never used or sent');
  }

  section('Audit: counts and ids, never the text');
  {
    const rows = await prisma.activityLog.findMany({ where: { resourceId: epA.id, action: { in: ['AI_TIMELINE_REQUESTED', 'AI_TIMELINE_FINISHED'] } }, orderBy: { createdAt: 'asc' } });
    const reqRow = rows.find((r) => r.action === 'AI_TIMELINE_REQUESTED'), fin = rows.find((r) => r.action === 'AI_TIMELINE_FINISHED');
    check(reqRow?.metadata?.requestId === sent.request_id && reqRow.metadata.organizationId === ORG_A && reqRow.metadata.notes === 3 && reqRow.customerId === A.id,
      'AI_TIMELINE_REQUESTED: request id, organization, counts, business A', JSON.stringify(reqRow?.metadata).slice(0, 300));
    check(reqRow && fin && reqRow.createdAt <= fin.createdAt, 'REQUESTED is written before FINISHED');
    check(fin?.metadata?.status === 'succeeded' && fin.metadata.resolvedModel === 'ref-summary-fast' && fin.metadata.usage?.input_tokens === 321, 'AI_TIMELINE_FINISHED: succeeded, resolved model and usage', JSON.stringify(fin?.metadata));
    const auditText = JSON.stringify(await prisma.activityLog.findMany({ where: { resourceId: epA.id }, select: { metadata: true } }));
    const inAudit = [`${TAG}-NOTE`, `${TAG}-ISSUE`, 'Reference summary', ...Object.values(SECRETS)].filter((v) => auditText.includes(v));
    check(inAudit.length === 0, 'no note, session text, summary or secret in any audit row', inAudit.join(', '));
  }

  section('Capabilities: computers:edit and integration:ticket_analysis');
  {
    const before = peer.inference.length;
    const v = await generate(S.viewA, epA.id);
    check(v.status === 403, 'computers:view only → 403', msg(v));
    const vs = await status(S.viewA, epA.id);
    check(vs.status === 200 && vs.data.canRequest === false, 'a viewer sees the status with canRequest false', msg(vs));
    const e = await generate(S.editA, epA.id);
    check(e.status === 403 && code(e) === 'NO_CAPABILITY', 'computers:edit without integration:ticket_analysis → 403 NO_CAPABILITY', msg(e));
    const ref = await prisma.activityLog.findFirst({ where: { action: 'AI_TIMELINE_REFUSED', actorId: editA.id } });
    check(ref?.metadata?.code === 'NO_CAPABILITY', 'that refusal is audited');
    const t = await generate(S.techA, epA.id);
    check(t.status === 200, 'a technician assigned to A with both capabilities may request it', msg(t));
    check(peer.inference.length === before + 1, 'only the permitted request reached the gateway', `${peer.inference.length - before}`);
  }

  section('Business isolation (A/B), with B working as the negative control');
  {
    const before = peer.inference.length;
    for (const [who, s] of [['owner A', S.ownerA], ['technician A', S.techA]]) {
      const st = await status(s, epB.id), g = await generate(s, epB.id);
      check(st.status === 404 && g.status === 404, `${who} on B's computer: status 404, generate 404`, `${msg(st)} / ${msg(g)}`);
    }
    const sB = await status(S.ownerB, epA.id), gB = await generate(S.ownerB, epA.id);
    check(sB.status === 404 && gB.status === 404, "owner B on A's computer: 404, 404", `${msg(sB)} / ${msg(gB)}`);
    check(peer.inference.length === before, 'no cross-business request reached the gateway');
    const okB = await generate(S.ownerB, epB.id);
    const rB = peer.inference.at(-1);
    check(okB.status === 200 && rB?.organization_id === ORG_B && rB.input.rem0te_endpoint_id === epB.id, "owner B on B's own computer → 200, organization B", msg(okB));
    const tB = JSON.stringify(rB ?? {});
    check(tB.includes(`${TAG}-B-ONLY-NOTE`) && !tB.includes(`${TAG}-NOTE-1`) && !tB.includes(ORG_A), "B's request carries B's note and nothing of A's");
    check(!JSON.stringify(peer.inference.filter((x) => x.organization_id === ORG_A)).includes('B-ONLY-NOTE'), "no request for A ever carried B's note");
    const stC = await status(S.ownerC, epC.id), gC = await generate(S.ownerC, epC.id);
    check(stC.data?.code === 'NOT_MAPPED' && gC.status === 409 && code(gC) === 'NOT_MAPPED', 'an unmapped business → NOT_MAPPED, nothing sent', `${msg(stC)} / ${msg(gC)}`);
  }

  section('Containment: an integration pause stops it');
  {
    const before = peer.inference.length, capsBefore = peer.capsRequests;
    const pA = await prisma.containmentPause.create({ data: { scope: 'BUSINESS', customerId: A.id, kinds: ['integration'], reason: `${TAG} test pause`, setById: ownerA.id, setBy: 'msp' } });
    const st = await status(S.ownerA, epA.id), g = await generate(S.ownerA, epA.id);
    check(st.data?.code === 'CONTAINED' && g.status === 403 && code(g) === 'CONTAINED', 'business pause on A: status CONTAINED, generate 403 CONTAINED', `${msg(st)} / ${msg(g)}`);
    check(peer.inference.length === before && peer.capsRequests === capsBefore, 'under the pause rem0te contacted the peer for nothing, not even capabilities');
    const bOk = await status(S.ownerB, epB.id);
    check(bOk.data?.code === 'READY', "A's pause does not stop B", msg(bOk));
    const other = await prisma.containmentPause.create({ data: { scope: 'BUSINESS', customerId: A.id, kinds: ['actions', 'remote'], reason: `${TAG} other kinds`, setById: ownerA.id, setBy: 'msp' } });
    await prisma.containmentPause.update({ where: { id: pA.id }, data: { clearedAt: new Date(), clearedById: ownerA.id } });
    const st2 = await status(S.ownerA, epA.id);
    check(st2.data?.code === 'READY', 'a pause of other kinds (actions, remote) does not stop it', msg(st2));
    await prisma.containmentPause.update({ where: { id: other.id }, data: { clearedAt: new Date(), clearedById: ownerA.id } });
    const g2 = await prisma.containmentPause.create({ data: { scope: 'GLOBAL', kinds: ['integration'], reason: `${TAG} global`, setById: ownerA.id, setBy: 'msp' } });
    const gb = await generate(S.ownerB, epB.id);
    check(gb.status === 403 && code(gb) === 'CONTAINED', 'a global integration pause stops B too', msg(gb));
    await prisma.containmentPause.update({ where: { id: g2.id }, data: { clearedAt: new Date(), clearedById: ownerA.id } });
    const refused = await prisma.activityLog.count({ where: { action: 'AI_TIMELINE_REFUSED', customerId: { in: [A.id, B.id] }, metadata: { path: ['code'], equals: 'CONTAINED' } } });
    check(refused >= 2, `contained refusals are audited (${refused})`);
  }

  section('Response integrity: nothing is saved from a bad answer');
  {
    await prisma.endpoint.update({ where: { id: epA.id }, data: { aiTimeline: `${TAG} kept summary` } });
    for (const [mode, want] of [['forged', 'RESPONSE_SIGNATURE_INVALID'], ['wrong_org', 'RESPONSE_MISMATCH'], ['refused', 'MODEL_REFUSED'], ['bad_output', 'OUTPUT_SCHEMA_INVALID'], ['down', 'GATEWAY_UNAVAILABLE']]) {
      peer.mode = mode;
      const g = await generate(S.ownerA, epA.id);
      const row = await prisma.endpoint.findUnique({ where: { id: epA.id }, select: { aiTimeline: true } });
      check(g.status === 502 && code(g) === want && row.aiTimeline === `${TAG} kept summary`, `${mode} → 502 ${want}, stored summary unchanged`, msg(g));
    }
    const fails = await prisma.activityLog.count({ where: { action: 'AI_TIMELINE_FINISHED', resourceId: epA.id, metadata: { path: ['status'], equals: 'failed' } } });
    check(fails === 5, `each failure audited as AI_TIMELINE_FINISHED failed (${fails})`);
    peer.mode = 'evil';
    const g = await generate(S.ownerA, epA.id);
    const fin = await prisma.activityLog.findFirst({ where: { action: 'AI_TIMELINE_FINISHED', resourceId: epA.id }, orderBy: { createdAt: 'desc' } });
    check(g.status === 200 && g.data?.text === 'Fine.' && fin?.metadata?.droppedUnknownFields === 2, 'extra output fields (approve_fix, run_command) are dropped and counted; bidi stripped', `${msg(g)} ${JSON.stringify(fin?.metadata)}`);
    peer.mode = 'ok';
  }

  section('Server without capabilitiesUrl, and without the integration');
  {
    const capsBefore = peer.capsRequests;
    await restart({ INTEGRATION_PEERS_FILE: peersNoCaps });
    const st = await status(S.ownerA, epA.id);
    check(st.data?.code === 'PEER_UNSUPPORTED' && /Needs ClientSt0r support for device_timeline_v1/.test(st.data.message) && /capabilitiesUrl/.test(st.data.message),
      'no capabilitiesUrl in the peers file → "Needs ClientSt0r support for device_timeline_v1"', msg(st));
    check(peer.capsRequests === capsBefore, 'and rem0te asked nothing of the peer');
    await restart({ INTEGRATION_PEERS_FILE: '' });
    const st2 = await status(S.ownerA, epA.id), g2 = await generate(S.ownerA, epA.id);
    check(st2.data?.code === 'NOT_CONFIGURED' && g2.status === 409 && code(g2) === 'NOT_CONFIGURED', 'no peers file → NOT_CONFIGURED, even with a provider key in the environment', `${msg(st2)} / ${msg(g2)}`);
  }
}

async function cleanup() {
  await stopApi();
  fake.close();
  try {
    await prisma.containmentPause.deleteMany({ where: { reason: { startsWith: TAG } } });
    await prisma.integrationOrgMapping.deleteMany({ where: { customerId: { in: created.businesses } } });
    await prisma.note.deleteMany({ where: { endpointId: { in: created.endpoints } } });
    await prisma.supportSession.deleteMany({ where: { endpointId: { in: created.endpoints } } });
    await prisma.endpointTag.deleteMany({ where: { endpointId: { in: created.endpoints } } });
    await prisma.rustdeskNode.deleteMany({ where: { endpointId: { in: created.endpoints } } });
    await prisma.endpoint.deleteMany({ where: { id: { in: created.endpoints } } });
    await prisma.site.deleteMany({ where: { customerId: { in: created.businesses } } });
    await prisma.technicianAssignment.deleteMany({ where: { customerId: { in: created.businesses } } });
    await prisma.membership.deleteMany({ where: { userId: { in: created.users } } });
    await prisma.user.deleteMany({ where: { id: { in: created.users } } });
    await prisma.customer.deleteMany({ where: { id: { in: created.businesses } } });
  } catch (e) { console.error('cleanup failed:', e.message); }
  await prisma.$disconnect();
  rmSync(tmp, { recursive: true, force: true });
}

try {
  await all();
} catch (e) {
  check(false, 'suite crashed', e.stack ?? String(e));
  if (api) console.log('--- api log tail ---\n' + api.log.slice(-2500));
} finally {
  await cleanup();
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
