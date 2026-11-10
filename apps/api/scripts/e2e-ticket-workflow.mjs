#!/usr/bin/env node
/**
 * The ticket ↔ RMM workflow, end to end (0.30): the real rem0te API, the real
 * integration worker and the real approval signer, against a REFERENCE
 * ClientSt0r — a loopback peer that implements contract ticket-rmm-v1 exactly
 * as docs/contracts/ticket-rmm-v1 specifies it (Ed25519 request signatures,
 * delegation tokens, signed responses, signed events).
 *
 * It is not ClientSt0r. ClientSt0r at the commit recorded in
 * docs/contracts/ticket-rmm-v1/CLIENTST0R.md speaks a different protocol
 * (HMAC-SHA256, its own headers and routes); that gap is measured by
 * apps/api/scripts/interop-clientst0r.mjs, not hidden here. The section "ClientSt0r's
 * own signing" below records what rem0te does with a request signed the
 * ClientSt0r way.
 *
 * Scenarios: pairing (capabilities, with the organization → business binding
 * and pause state), one ticket analysed and returned, one alert → one ticket
 * → that same ticket resolved, delivery retried across a restart with no
 * duplicate, two customers with identically named PCs, a revoked technician,
 * an offline endpoint, a paused business, and an AI suggestion / ticket
 * referral that cannot authorize anything.
 *
 * With --write-examples it writes docs/contracts/ticket-rmm-v1/examples/*.json
 * from the exchanges it makes, signed with the TEST-ONLY keys in
 * examples/keys/ (derived from fixed seeds, so they never change).
 * scripts/gen-integration-contracts.mjs --check verifies those signatures and
 * schemas in CI.
 *
 *   cd apps/api && npx nest build
 *   RELEASE_BIN=… DATABASE_URL=postgresql://…/<scratch|test> node scripts/e2e-ticket-workflow.mjs [--write-examples]
 *
 * RELEASE_BIN (rem0te-release, built from tools/windows-installer) builds the
 * update repository the signed agent channel and the approval signer need.
 * Refuses a database whose name lacks "scratch" or "test", and production ports.
 */
import { PrismaClient } from '@prisma/client';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash, createPrivateKey, createPublicKey, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import argon2 from 'argon2';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const C = require(path.join(dist, 'integration/crypto.js'));
const K = require(path.join(dist, 'integration/contract.js'));
const EXAMPLES = path.resolve(here, '..', '..', '..', 'docs/contracts/ticket-rmm-v1/examples');
const WRITE = process.argv.includes('--write-examples');

const DB = process.env.DATABASE_URL ?? '';
const dbName = DB.split('/').pop()?.split('?')[0] ?? '';
if (!/scratch|test/.test(dbName)) { console.error(`Refusing to run against database "${dbName}": name must contain "scratch" or "test".`); process.exit(2); }
const BIN = process.env.RELEASE_BIN;
if (!BIN) { console.error('RELEASE_BIN (rem0te-release) is required'); process.exit(2); }
const PORT = Number(process.env.TW_API_PORT ?? 3131), PEER_PORT = Number(process.env.TW_PEER_PORT ?? 3132);
const SIGNER_PUBLIC = Number(process.env.TW_SIGNER_PUBLIC_PORT ?? 3133), SIGNER_INTERNAL = Number(process.env.TW_SIGNER_INTERNAL_PORT ?? 3134);
if ([PORT, PEER_PORT, SIGNER_PUBLIC, SIGNER_INTERNAL].some((p) => [3000, 3001, 443, 3201, 3202].includes(p))) { console.error('refusing a production port'); process.exit(2); }
const ROOT = `http://127.0.0.1:${PORT}`, API = `${ROOT}/api/v1`;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'ticket-workflow-e2e-password-1';

let pass = 0, fail = 0; const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const until = async (fn, ms = 30_000, step = 300) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(step); } return v; };
const j = (x) => JSON.stringify(x).slice(0, 400);

// ── TEST-ONLY keys, derived from fixed seeds ────────────────────────────────
// Published in examples/keys/ so anyone can reproduce or check the examples.
// They protect nothing; never configure them on a real server.
const seeded = (name) => createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), createHash('sha256').update(`rem0te-contract-example:${name}`).digest()]), format: 'der', type: 'pkcs8' });
const KEYS = { 'rem0te-self': seeded('rem0te-self'), 'clientst0r-request': seeded('clientst0r-request'), 'clientst0r-delegation': seeded('clientst0r-delegation') };
const pub = (k) => createPublicKey(k).export({ type: 'spki', format: 'pem' }).toString();
const self = KEYS['rem0te-self'], peerReq = KEYS['clientst0r-request'], peerDel = KEYS['clientst0r-delegation'];
const selfPub = C.ed25519PublicKey(pub(self));

// ── Examples ────────────────────────────────────────────────────────────────
const examples = [];
const HDR_KEEP = /^(content-type|rem0te-[a-z-]+|idempotent-replayed)$/;
const keepHeaders = (h) => Object.fromEntries(Object.entries(h).filter(([k]) => HDR_KEEP.test(k.toLowerCase())).map(([k, v]) => [k.toLowerCase(), v]));
const parse = (t) => { try { return JSON.parse(t); } catch { return t || null; } };
function example(name, description, ex) { examples.push({ name, description, ...ex }); }

// ── Reference ClientSt0r ────────────────────────────────────────────────────
const AUD = 'rem0te:example', PEER_AUD = 'clientst0r:example', PEER = 'clientst0r-example';
const peer = {
  inference: [], events: [], seen: new Set(), duplicates: 0, failNext: 0, badSignatures: 0,
  tickets: new Map(), // ticket id → { alertId, state, summary }
  nextTicket: 1,
};
const readBody = (rq) => new Promise((r) => { const c = []; rq.on('data', (d) => c.push(d)); rq.on('end', () => r(Buffer.concat(c))); });
const signedByRem0te = (rq, body) => rq.headers['rem0te-key-id'] === 'rem0te/rem0te-example-1' && C.verifyEd25519(selfPub, C.requestSigningString({
  audience: PEER_AUD, method: rq.method, pathWithQuery: rq.url, timestamp: rq.headers['rem0te-timestamp'], nonce: rq.headers['rem0te-nonce'], bodySha256: C.sha256Hex(body),
}), rq.headers['rem0te-signature']);
function analysisOutput(r) {
  const bodyRef = r.input.evidence_refs.find((x) => x.endsWith('#body'));
  return {
    category: 'printing',
    summary: 'Nothing prints from the front desk; the Print Spooler has probably stopped.',
    facts: [{ statement: 'The customer reports that nothing has printed since this morning.', evidence_refs: bodyRef ? [bodyRef] : [] }],
    hypotheses: [{ statement: 'The Print Spooler service has stopped on the workstation', confidence: 'medium', evidence_refs: bodyRef ? [bodyRef] : [] }],
    draft_reply: 'Thanks — we are looking at the print queue on your front desk PC now.',
    next_steps: ['Restart the Print Spooler service', 'Run net stop spooler && net start spooler as administrator'],
    // What a model might add on its own. The contract has no such fields:
    // rem0te drops and counts them, and nothing here can approve anything.
    approve_fix: true, run_command: 'sc start spooler',
  };
}
const peerServer = createServer(async (rq, rs) => {
  const body = await readBody(rq);
  if (!signedByRem0te(rq, body)) { peer.badSignatures++; rs.writeHead(401).end('{"error":"bad signature"}'); return; }
  const headers = keepHeaders(rq.headers);
  if (rq.url === '/api/integration/v1/inference') {
    const r = JSON.parse(body.toString());
    peer.inference.push({ r, headers });
    const out = {
      contract: 'ticket-rmm-v1', request_id: r.request_id, job_id: r.job_id, organization_id: r.organization_id, model_profile: r.model_profile,
      resolved_model: 'reference-model-1', status: 'ok', usage: { input_tokens: 812, output_tokens: 214 }, output: analysisOutput(r),
    };
    const text = JSON.stringify(out);
    const sig = C.signEd25519(peerReq, C.responseSigningString(rq.headers['rem0te-nonce'], C.sha256Hex(Buffer.from(text))));
    const rh = { 'content-type': 'application/json', 'rem0te-key-id': `${PEER}/req-1`, 'rem0te-response-signature': sig };
    if (peer.inference.length === 1) example('inference', 'rem0te → ClientSt0r: one model run for a job. ClientSt0r holds the provider key and calls the model; rem0te never does. The response is signed over the request nonce and the body hash.', { direction: 'rem0te_to_clientst0r', request: { method: 'POST', path: rq.url, headers, body: r }, response: { status: 200, headers: rh, body: out }, request_schema: 'inference-request', response_schema: 'inference-response' });
    rs.writeHead(200, rh).end(text);
    return;
  }
  if (rq.url === '/api/integration/v1/events') {
    if (peer.failNext > 0) { peer.failNext--; rs.writeHead(503).end(); return; } // the acknowledgement is lost
    const msg = JSON.parse(body.toString());
    const ev = msg.event ?? msg.alert_event;
    const ok = msg.event ? C.verifyEd25519(selfPub, C.eventSigningString(msg.event), msg.signature.sig) : C.verifyEd25519(selfPub, C.alertEventSigningString(msg.alert_event), msg.signature.sig);
    if (!ok) { peer.badSignatures++; rs.writeHead(400).end(); return; }
    if (peer.seen.has(ev.event_id)) { peer.duplicates++; rs.writeHead(204).end(); return; } // delivered again: acknowledged, not applied twice
    peer.seen.add(ev.event_id);
    peer.events.push({ ev, kind: msg.event ? 'job' : 'alert', headers, raw: msg });
    // The ticket system: one ticket per alert, closed by that alert's resolution.
    if (msg.alert_event?.type === 'alert.raised') {
      const id = `CS-${sfx}-${peer.nextTicket++}`;
      peer.tickets.set(id, { alertId: ev.alert.alert_id, state: 'open', patch: ev.alert.patch_summary });
    }
    if (msg.alert_event?.type === 'alert.resolved' && ev.alert.ticket) {
      const t = peer.tickets.get(ev.alert.ticket.id);
      if (t && t.alertId === ev.alert.alert_id) t.state = 'resolved';
    }
    rs.writeHead(204).end();
    return;
  }
  rs.writeHead(404).end();
});

// ── The peer's client ───────────────────────────────────────────────────────
function token({ sub, org, scope, req_sha256, ttl = 120 }) {
  const now = Math.floor(Date.now() / 1000);
  return C.signJws(peerDel, 'del-1', { iss: PEER, aud: AUD, sub, org, scope, iat: now, exp: now + ttl, jti: randomBytes(16).toString('hex'), ...(req_sha256 ? { req_sha256 } : {}) });
}
async function call(method, p, { body, delegation, record } = {}) {
  const text = body ? JSON.stringify(body) : '';
  const t = String(Math.floor(Date.now() / 1000)), n = randomBytes(18).toString('base64url');
  const sig = C.signEd25519(peerReq, C.requestSigningString({ audience: AUD, method, pathWithQuery: p, timestamp: t, nonce: n, bodySha256: C.sha256Hex(Buffer.from(text)) }));
  const headers = { 'content-type': 'application/json', 'rem0te-key-id': `${PEER}/req-1`, 'rem0te-timestamp': t, 'rem0te-nonce': n, 'rem0te-signature': sig, ...(delegation ? { 'rem0te-delegation': delegation } : {}) };
  const r = await fetch(`${ROOT}${p}`, { method, headers, body: text || undefined });
  const out = parse(await r.text());
  if (record) example(record.name, record.description, { direction: 'clientst0r_to_rem0te', request: { method, path: p, headers, body: body ?? null }, response: { status: r.status, headers: keepHeaders(Object.fromEntries(r.headers)), body: out }, request_schema: record.request_schema ?? null, response_schema: record.response_schema ?? null });
  return { status: r.status, body: out, headers: r.headers };
}
const hashOf = (schema, b) => { const r = schema.safeParse(b); return C.sha256Hex(C.canonicalJson(r.success ? r.data : b)); };
const jobBody = ({ org, tech, endpoint = null, key = `cs-ticket-${randomBytes(5).toString('hex')}`, inventory = true }) => ({
  contract: 'ticket-rmm-v1', idempotency_key: key, correlation_id: `cs-corr-${randomBytes(4).toString('hex')}`, organization_id: org, technician_id: tech,
  ticket: { id: `T-${sfx}-42`, revision: 1, subject: 'Front desk cannot print', body: 'Nothing has printed from the front desk PC since this morning.', comments: [{ id: 'c1', author_role: 'customer', created_at: new Date().toISOString(), body: 'Still nothing.' }] },
  endpoint: endpoint ? { rem0te_endpoint_id: endpoint } : null, model_profiles: ['triage-fast'], evidence: { include_endpoint_inventory: inventory },
  expires_at: new Date(Date.now() + 3600_000).toISOString(),
});
const submit = (b, record) => call('POST', '/api/integration/v1/jobs', { body: b, delegation: token({ sub: b.technician_id, org: b.organization_id, scope: 'ticket_analysis:submit', req_sha256: hashOf(K.JobRequest, b) }), record });
const getJob = (id, sub, org, record) => call('GET', `/api/integration/v1/jobs/${id}`, { delegation: token({ sub, org, scope: 'ticket_analysis:read' }), record });
const settle = (id, sub, org) => until(async () => { const r = await getJob(id, sub, org); return r.status === 200 && ['succeeded', 'partial', 'failed', 'expired'].includes(r.body.status) ? r.body : null; }, 40_000, 400);
const propose = (b, record) => call('POST', '/api/integration/v1/action-proposals', { body: b, delegation: token({ sub: b.technician_id, org: b.organization_id, scope: 'actions:propose', req_sha256: hashOf(K.ActionProposalRequest, b) }), record });

// ── rem0te users and the agent ──────────────────────────────────────────────
async function req(method, p, { s, body, business } = {}) {
  const h = { 'content-type': 'application/json', 'x-forwarded-for': `10.9.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}` };
  if (s) h.cookie = s.cookie;
  if (business) h['x-rem0te-business'] = business;
  const r = await fetch(`${API}${p}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: parse(await r.text()) };
}
async function login(email) {
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.8.0.1' }, body: JSON.stringify({ email, password: PW }) });
  const m = (r.headers.get('set-cookie') ?? '').match(/access_token=([^;]+)/);
  if (r.status !== 200 || !m) throw new Error(`login ${email}: ${r.status}`);
  return { cookie: `access_token=${m[1]}` };
}
const ACTIONS = ['windows.service.start@1', 'windows.update.install@1'];
const CU = { updateId: '5a1b2c3d-0000-4000-8000-000000000001', revision: 201, kb: 'KB5044284', title: '2026-11 Cumulative Update for Windows 11 (KB5044284)', classification: '0fa1201d-4330-4fa8-8ae9-b877473b6441', className: 'Security Updates', severity: 'Critical', downloaded: true, rebootBehavior: 1, userInput: false, eulaAccepted: true, browseOnly: false, sizeBytes: 600 << 20 };
const posture = (pending, updates = []) => ({ schema: 'rem0te-patch-posture/1', scannedAt: new Date().toISOString(), updates, history: [], reboot: { pending, sources: pending ? ['windows_update'] : [] }, managers: [], autoUpdate: 'enabled' });

// ── Release machine, processes ──────────────────────────────────────────────
const work = mkdtempSync(path.join(tmpdir(), 'rem0te-tw-'));
const keysDir = path.join(work, 'keys'); mkdirSync(keysDir);
const repo = path.join(work, 'repo'), files = path.join(work, 'files'); mkdirSync(files);
const signerDir = path.join(work, 'signer'); mkdirSync(signerDir, { mode: 0o700 });
const rel = (...a) => execFileSync(BIN, a, { encoding: 'utf8' });
const signerCli = (args) => spawnSync(process.execPath, [path.join(dist, 'approval-signer', 'main.js'), ...args], { encoding: 'utf8', env: { ...process.env, APPROVAL_SIGNER_DIR: signerDir } });
for (const k of ['r1', 'targets', 'snapshot', 'timestamp']) rel('keygen', '-out', path.join(keysDir, `${k}.pem`));
const T = ['-targets-key', path.join(keysDir, 'targets.pem'), '-snapshot-key', path.join(keysDir, 'snapshot.pem'), '-timestamp-key', path.join(keysDir, 'timestamp.pem')];
rel('init', '-repo', repo, '-root-key', path.join(keysDir, 'r1.pem'), '-root-threshold', '1', ...T);
const agentBin = Buffer.concat([Buffer.from('MZ stand-in signed agent 0.30 '), randomBytes(64), Buffer.from('REM0TE_INST_URL:'), Buffer.alloc(240)]);
writeFileSync(path.join(files, 'agent.exe'), agentBin);
const AGENT_SHA = sha(agentBin);
const kg = signerCli(['keygen']);
if (kg.status !== 0) throw new Error(`signer keygen: ${kg.stderr}`);
writeFileSync(path.join(files, 'approval-keys.json'), kg.stdout);
rel('release', '-repo', repo, ...T, '-add', `windows/rem0te-agent.exe=${path.join(files, 'agent.exe')}`, '-add', `approval/keys.json=${path.join(files, 'approval-keys.json')}`);

writeFileSync(path.join(work, 'self.pem'), self.export({ type: 'pkcs8', format: 'pem' }));
const peersFile = path.join(work, 'peers.json');
writeFileSync(peersFile, JSON.stringify({
  self: { keyId: 'rem0te-example-1', privateKeyFile: path.join(work, 'self.pem') },
  peers: [{
    id: PEER, audience: AUD, peerAudience: PEER_AUD,
    requestKeys: [{ kid: 'req-1', publicKeyPem: pub(peerReq) }], delegationKeys: [{ kid: 'del-1', publicKeyPem: pub(peerDel) }],
    inferenceUrl: `http://127.0.0.1:${PEER_PORT}/api/integration/v1/inference`, eventsUrl: `http://127.0.0.1:${PEER_PORT}/api/integration/v1/events`,
    modelProfiles: ['triage-fast'],
  }],
}));
const kids = {};
function start(name, script, env, args = []) {
  const p = spawn(process.execPath, [script, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  p.log = ''; p.stdout.on('data', (d) => { p.log += d; }); p.stderr.on('data', (d) => { p.log += d; });
  kids[name] = p; return p;
}
async function stop(name) { const p = kids[name]; if (!p || p.exitCode !== null) return; await new Promise((r) => { p.once('exit', r); p.kill('SIGTERM'); }); }
const signerEnv = { ...process.env, APPROVAL_SIGNER_DIR: signerDir, APPROVAL_ORIGIN: `http://127.0.0.1:${SIGNER_PUBLIC}`, APPROVAL_RP_ID: '127.0.0.1', APPROVAL_PUBLIC_PORT: String(SIGNER_PUBLIC), APPROVAL_INTERNAL_PORT: String(SIGNER_INTERNAL) };
delete signerEnv.DATABASE_URL;
const apiEnv = {
  ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATABASE_URL: DB, UPDATE_REPO_DIR: repo, INTEGRATION_PEERS_FILE: peersFile,
  APPROVAL_SIGNER_INTERNAL_URL: `http://127.0.0.1:${SIGNER_INTERNAL}`, INTEGRATION_LEASE_MS: '4000', INTEGRATION_WORKER_INTERVAL_MS: '200',
  JWT_SECRET: randomBytes(32).toString('hex'), LAUNCHER_TOKEN_SECRET: randomBytes(32).toString('hex'), ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  TRUSTED_PROXIES: 'loopback', HBBS_PRESENCE_HOST: '127.0.0.2', MONITOR_SWEEP_SECONDS: '2', AUDIT_SEALER: 'off',
  VERSION_FILE: path.resolve(here, '..', '..', '..', 'version.json'),
};
// No model provider is configured on rem0te, by construction: provider keys live in ClientSt0r.
for (const k of Object.keys(apiEnv)) if (/^(ANTHROPIC|OPENAI|AZURE_OPENAI|GEMINI|MISTRAL)_/.test(k)) delete apiEnv[k];
const startApi = () => start('api', path.join(dist, 'main.js'), apiEnv);
const startWorker = () => start('worker', path.join(dist, 'integration/worker.main.js'), apiEnv);
async function waitUp(url, name) {
  for (let i = 0; i < 150; i++) { try { const r = await fetch(url); if (r.status < 500) return; } catch { /* not yet */ } await sleep(300); }
  throw new Error(`${name} did not come up:\n${kids[name]?.log.slice(-3000)}`);
}

const created = { businesses: [], users: [], endpoints: [] };
async function main() {
  const tenant = await prisma.tenant.findFirst();
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });
  const hash = await argon2.hash(PW, { type: argon2.argon2id });

  section('Fixtures: Acme and Birch each have a PC named FRONTDESK; Cedar is paused');
  const mkBiz = async (n) => { const b = await prisma.customer.create({ data: { tenantId: tenant.id, name: `TW ${n} ${sfx}` } }); created.businesses.push(b.id); return b; };
  const acme = await mkBiz('Acme'), birch = await mkBiz('Birch'), cedar = await mkBiz('Cedar');
  const mkUser = async (tag) => { const u = await prisma.user.create({ data: { email: `tw-${tag}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'TW', lastName: tag, status: 'ACTIVE' } }); created.users.push(u.id); return u; };
  const owen = await mkUser('owen-owner-acme'), tina = await mkUser('tina-tech'), rex = await mkUser('rex-revoked');
  await prisma.membership.create({ data: { userId: owen.id, tenantId: tenant.id, customerId: acme.id, roleId: roleOwner.id, capabilities: [] } });
  const caps = ['computers:view', 'integration:ticket_analysis', 'actions:request'];
  for (const b of [acme, birch, cedar]) await prisma.technicianAssignment.create({ data: { tenantId: tenant.id, customerId: b.id, userId: tina.id, capabilities: caps } });
  await prisma.technicianAssignment.create({ data: { tenantId: tenant.id, customerId: acme.id, userId: rex.id, capabilities: caps } });
  const ORG = { acme: `org-acme-${sfx}`, birch: `org-birch-${sfx}`, cedar: `org-cedar-${sfx}` };
  for (const [k, b] of [['acme', acme], ['birch', birch], ['cedar', cedar]]) {
    await prisma.integrationOrgMapping.create({ data: { peerId: PEER, externalOrgId: ORG[k], customerId: b.id, tenantId: tenant.id, createdById: 'tw' } });
    await prisma.integrationTechnicianMapping.create({ data: { peerId: PEER, externalOrgId: ORG[k], externalTechnicianId: 'cs-tina', userId: tina.id, createdById: 'tw' } });
  }
  await prisma.integrationTechnicianMapping.create({ data: { peerId: PEER, externalOrgId: ORG.acme, externalTechnicianId: 'cs-rex', userId: rex.id, createdById: 'tw', revokedAt: new Date() } });
  const mkPc = async (biz, name, extra = {}) => {
    const e = await prisma.endpoint.create({ data: { tenantId: tenant.id, customerId: biz.id, name, hostname: name, platform: 'Windows', status: 'ACTIVE', isOnline: true, isManaged: true, accessMode: 'COMPANY_WIDE', lastSeenAt: new Date(), deviceClass: 'WORKSTATION', ...extra } });
    created.endpoints.push(e.id);
    const rid = String(100000000 + ((Math.random() * 899999999) | 0)), secret = randomBytes(24).toString('hex');
    await prisma.rustdeskNode.create({ data: { tenantId: tenant.id, endpointId: e.id, rustdeskId: rid, agentSecretHash: sha(secret) } });
    return { id: e.id, rid, secret, hostname: name };
  };
  const fdA = await mkPc(acme, 'FRONTDESK'), fdB = await mkPc(birch, 'FRONTDESK');
  const offA = await mkPc(acme, 'BACKOFFICE', { isOnline: false, lastSeenAt: new Date(Date.now() - 3 * 86400_000) });
  const fdC = await mkPc(cedar, 'FRONTDESK');
  const recA = await mkPc(acme, 'RECEPTION');
  await prisma.containmentPause.create({ data: { scope: 'BUSINESS', customerId: cedar.id, kinds: ['integration', 'actions'], reason: 'TW: suspected compromise, under review', setById: owen.id, setBy: 'msp' } });
  // Acme opens tickets for alerts; Birch does not. A restart pending an hour raises one.
  await prisma.monitorNotifyPolicy.create({ data: { scopeKey: `b:${acme.id}`, customerId: acme.id, levels: [], ticketing: { enabled: true, minSeverity: 'INFO' }, updatedById: owen.id } });
  await prisma.monitorRule.create({ data: { scopeKey: `b:${acme.id}`, customerId: acme.id, key: 'reboot-pending', kind: 'REBOOT_PENDING', name: 'Restart pending (TW)', severity: 'WARNING', params: { hours: 1 }, createdById: owen.id } });
  check(true, 'Acme: FRONTDESK, RECEPTION, BACKOFFICE (offline 3 days); Birch: FRONTDESK; Cedar: FRONTDESK, paused (integration, actions); technician tina mapped in all three, rex revoked');

  await new Promise((r) => peerServer.listen(PEER_PORT, '127.0.0.1', r));
  start('signer', path.join(dist, 'approval-signer', 'main.js'), signerEnv, ['serve']);
  startApi(); startWorker();
  await waitUp(`http://127.0.0.1:${SIGNER_INTERNAL}/internal/v1/keys`, 'signer');
  await waitUp(`${API}/health`, 'api');
  const beat = (pc, extra = {}) => req('POST', '/enrollment/heartbeat', { body: { rustdeskId: pc.rid, agentSecret: pc.secret, hostname: pc.hostname, platform: 'Windows', updateChannel: 'signed', agentActions: ACTIONS, agentSha256: AGENT_SHA, ...extra } });
  for (const pc of [fdA, fdB, fdC, recA]) await beat(pc, { patchPosture: posture(false, [CU]) });

  // ─────────────────────────────────────────────────────────────────────────
  section('Pairing: capabilities name every organization and the business it is bound to');
  let r = await call('GET', '/api/integration/v1/capabilities', { record: { name: 'capabilities', description: 'ClientSt0r → rem0te: discovery. `organizations` is the explicit binding (contract revision 2): one organization per business, each request names its organization, and `paused` lists the containment kinds in force.', response_schema: 'capabilities' } });
  const orgs = Object.fromEntries((r.body?.organizations ?? []).map((o) => [o.organization_id, o]));
  check(r.status === 200 && r.body.contract_revision === 2 && K.Capabilities.safeParse(r.body).success, 'capabilities: contract ticket-rmm-v1 revision 2, valid against the schema', j(r.body));
  check(orgs[ORG.acme]?.business_id === acme.id && orgs[ORG.birch]?.business_id === birch.id && orgs[ORG.cedar]?.business_id === cedar.id, 'each organization is bound to exactly one business, by id', j(r.body.organizations));
  check(orgs[ORG.cedar]?.paused.includes('integration') && orgs[ORG.acme]?.paused.length === 0, 'Cedar is reported paused (integration, actions); Acme is not', j(orgs[ORG.cedar]));
  check(!JSON.stringify(r.body).includes('suspected compromise'), 'the pause reason is not disclosed to the peer');
  const unsigned = await fetch(`${ROOT}/api/integration/v1/capabilities`);
  check(unsigned.status === 401, 'an unsigned request is refused');

  section('ClientSt0r\'s own signing (HMAC-SHA256, X-Integration-* headers) is not accepted');
  {
    // Exactly what ClientSt0r's integrations/rmm_signing.py sends at the recorded commit.
    const ts = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString('hex'), secret = randomBytes(32).toString('hex');
    const canon = ['GET', '/api/integration/v1/capabilities', ts, nonce, sha('')].join('\n');
    const mac = createHash('sha256'); void mac;
    const { createHmac } = await import('node:crypto');
    const sig = createHmac('sha256', secret).update(canon).digest('hex');
    const headers = { 'X-Integration-Key-Id': 'clientst0r-example', 'X-Integration-Timestamp': ts, 'X-Integration-Nonce': nonce, 'X-Integration-Signature': sig };
    const hr = await fetch(`${ROOT}/api/integration/v1/capabilities`, { headers });
    const hb = parse(await hr.text());
    check(hr.status === 401 && hb?.error?.code === 'UNAUTHENTICATED', 'an HMAC-signed request, as ClientSt0r sends it, gets 401 UNAUTHENTICATED: the two protocols do not interoperate yet', j(hb));
    example('error.clientst0r-hmac-request', 'ClientSt0r → rem0te, signed the way ClientSt0r signs today (HMAC-SHA256, X-Integration-* headers). Refused: ticket-rmm-v1 is Ed25519 with rem0te-* headers. See CLIENTST0R.md.', { direction: 'clientst0r_to_rem0te', request: { method: 'GET', path: '/api/integration/v1/capabilities', headers: { ...headers, 'X-Integration-Signature': '<hmac-sha256 hex, secret not published>' }, body: null }, response: { status: hr.status, headers: {}, body: hb }, request_schema: null, response_schema: 'error' });
  }

  // ─────────────────────────────────────────────────────────────────────────
  section('One ticket analysed and the result returned');
  const jb = jobBody({ org: ORG.acme, tech: 'cs-tina', endpoint: fdA.id, key: `cs-ticket-42-${sfx}` });
  r = await submit(jb, { name: 'job-submit', description: 'ClientSt0r → rem0te: analyse one ticket, with rem0te\'s evidence about the bound computer. Signed request plus a delegation token bound to the body hash (req_sha256).', request_schema: 'job-request', response_schema: 'job' });
  check(r.status === 202 && r.body.status === 'queued' && r.body.organization_id === ORG.acme, 'submitted: 202, queued, under Acme\'s organization', j(r.body));
  const job1 = r.body.job_id;
  const done1 = await settle(job1, 'cs-tina', ORG.acme);
  check(done1?.status === 'succeeded' && done1.result, 'the worker ran it through ClientSt0r\'s inference endpoint and it succeeded', j(done1));
  await getJob(job1, 'cs-tina', ORG.acme, { name: 'job-result', description: 'ClientSt0r → rem0te: poll the job. `result` is staff-facing analysis; every next step is `executable: false`.', response_schema: 'job' });
  const inf = peer.inference.find((x) => x.r.job_id === job1)?.r;
  const evText = JSON.stringify(inf?.input ?? {});
  check(!!inf && evText.includes(`endpoint:${fdA.id}`) && !evText.includes(fdB.id), 'the evidence sent is Acme\'s FRONTDESK, by id — never Birch\'s FRONTDESK', evText.slice(0, 300));
  const evDone = await until(() => peer.events.find((e) => e.kind === 'job' && e.ev.job_id === job1 && e.ev.type === 'job.succeeded'));
  check(!!evDone, 'job.succeeded was pushed to ClientSt0r, signed by rem0te');
  if (evDone) example('event.job-succeeded', 'rem0te → ClientSt0r: a signed job event, pushed to the events URL. Verify `signature` over "rem0te-event-v1\\n" + canonical JSON of `event`.', { direction: 'rem0te_to_clientst0r', request: { method: 'POST', path: '/api/integration/v1/events', headers: evDone.headers, body: evDone.raw }, response: { status: 204, headers: {}, body: null }, request_schema: 'signed-event', response_schema: null });
  const steps = done1?.result?.next_steps ?? [];
  check(steps.length > 0 && steps.every((s) => s.executable === false), 'every suggested next step comes back executable: false', j(steps));
  check(done1?.result?.per_model?.[0]?.dropped_unknown_fields === 2, 'the model\'s own approve_fix / run_command fields were dropped and counted', j(done1?.result?.per_model));

  section('Two customers, identically named PCs');
  r = await submit(jobBody({ org: ORG.acme, tech: 'cs-tina', endpoint: fdB.id }));
  check(r.status === 400 && r.body?.error?.code === 'INVALID_REQUEST', 'Birch\'s FRONTDESK named under Acme\'s organization: refused ("Endpoint not found") — names are never matched', j(r.body));
  r = await submit(jobBody({ org: ORG.birch, tech: 'cs-tina', endpoint: fdB.id }));
  check(r.status === 202, 'the same technician, under Birch\'s organization, may use Birch\'s FRONTDESK', j(r.body));
  const jobB = r.body.job_id;
  r = await getJob(jobB, 'cs-tina', ORG.acme);
  check(r.status === 404, 'Birch\'s job is 404 when polled as Acme', j(r.body));

  section('A revoked technician');
  r = await submit(jobBody({ org: ORG.acme, tech: 'cs-rex', endpoint: fdA.id }));
  check(r.status === 403, 'a technician whose mapping was revoked is refused', j(r.body));

  section('An offline endpoint');
  r = await submit(jobBody({ org: ORG.acme, tech: 'cs-tina', endpoint: offA.id }));
  const offJob = r.body?.job_id;
  const offDone = offJob ? await settle(offJob, 'cs-tina', ORG.acme) : null;
  const offInf = JSON.stringify(peer.inference.find((x) => x.r.job_id === offJob)?.r?.input ?? {});
  check(offDone?.status === 'succeeded' && offInf.includes('online=false') && /heartbeat_age_minutes=4[0-9]{3}/.test(offInf), 'analysed, with the evidence saying offline and how stale (about 4,320 minutes)', offInf.slice(0, 400));

  section('A paused business');
  r = await submit(jobBody({ org: ORG.cedar, tech: 'cs-tina', endpoint: fdC.id }), { name: 'error.paused-business', description: 'ClientSt0r → rem0te: a job for a business under a containment pause. 423 CONTAINED; nothing is queued.', request_schema: 'job-request', response_schema: 'error' });
  check(r.status === 423 && r.body?.error?.code === 'CONTAINED', 'Cedar is paused: 423 CONTAINED, and no job exists', j(r.body));
  check((await prisma.integrationJob.count({ where: { customerId: cedar.id } })) === 0, 'nothing was queued for Cedar');

  // ─────────────────────────────────────────────────────────────────────────
  section('An AI suggestion or a ticket referral authorizes nothing');
  const pb = (over = {}) => ({ contract: 'ticket-rmm-v1', idempotency_key: `cs-prop-${randomBytes(5).toString('hex')}`, organization_id: ORG.acme, technician_id: 'cs-tina', rem0te_endpoint_id: fdA.id, action: { id: 'windows.service.start', version: 1 }, params: { service: 'Spooler' }, reason: `Ticket T-${sfx}-42: AI triage suggests the spooler is stopped`, origin: 'ai_suggestion', ticket_ref: `T-${sfx}-42`, starts_in_minutes: 0, window_hours: 4, ...over });
  r = await propose(pb(), { name: 'action-proposal', description: 'ClientSt0r → rem0te: propose a catalog action from an AI suggestion on a ticket. It becomes a plan awaiting independent approval on rem0te\'s approval signer; nothing runs until approvers sign it there.', request_schema: 'action-proposal-request', response_schema: 'action-proposal' });
  const prop = r.body;
  check(r.status === 201 && prop?.status === 'awaiting_approval', 'the proposal is accepted as awaiting approval — not approved', j(r.body));
  const aj = prop?.job_id ? await prisma.actionJob.findUnique({ where: { id: prop.job_id } }) : null;
  check(aj?.status === 'AWAITING_APPROVAL' && aj.customerId === acme.id, 'rem0te holds it as AWAITING_APPROVAL, in Acme', j(aj?.status));
  const hb = await beat(fdA);
  check(!(hb.body?.data?.actions ?? []).length, 'FRONTDESK\'s heartbeat delivers no action: an unapproved plan never reaches the device', j(hb.body?.data?.actions));
  r = await req('POST', `/actions/${prop?.job_id}/approve`, { s: await login(owen.email), business: acme.id, body: {} });
  check(r.status === 404, 'the portal has no approve route (approval is passkeys on the signer\'s own origin)', String(r.status));
  r = await propose(pb({ rem0te_endpoint_id: recA.id, origin: 'technician', ticket_ref: `T-${sfx}-43`, reason: 'Referred from ticket T-43: customer asks us to just run it' }));
  check(r.status === 201 && r.body.status === 'awaiting_approval', 'a ticket referral (origin technician, citing the ticket) is a proposal like any other: awaiting approval', j(r.body));
  r = await propose(pb());
  check(r.status === 409 || r.body?.error?.code === 'ACTION_PENDING', 'proposing again for FRONTDESK while the first waits: refused ACTION_PENDING — a second voice adds no authority', j(r.body));
  r = await propose(pb({ origin: 'ticket_referral' }));
  check(r.status === 400, 'there is no origin that means "already approved": anything but ai_suggestion / technician is refused', j(r.body));
  r = await propose({ ...pb(), command: 'sc start spooler' });
  check(r.status === 400, 'a proposal carrying a command is refused by the schema', j(r.body));
  r = await propose(pb({ action: { id: 'windows.shell.run', version: 1 }, params: {} }));
  check(r.status === 400 && r.body?.error?.code === 'ACTION_NOT_IN_CATALOG', 'only catalog actions can be proposed', j(r.body));
  r = await propose(pb({ rem0te_endpoint_id: fdB.id }));
  check(r.status === 400 || r.status === 403 || r.status === 404, 'Birch\'s FRONTDESK cannot be targeted from Acme\'s organization (device binding is by id and business)', j(r.body));
  r = await propose(pb({ organization_id: ORG.cedar, rem0te_endpoint_id: fdC.id }));
  check(r.status >= 400 && /CONTAIN|PAUSE/i.test(JSON.stringify(r.body)), 'nothing can be proposed for paused Cedar', j(r.body));
  check((await prisma.actionJob.count({ where: { customerId: acme.id, status: { in: ['APPROVED', 'DISPATCHED', 'SUCCEEDED'] } } })) === 0, 'no action job anywhere in Acme is approved, dispatched or run');
  check((await prisma.activityLog.count({ where: { customerId: acme.id, action: { in: ['ACTION_DISPATCHED', 'ACTION_RESULT'] } } })) === 0, 'and the audit log records no dispatch and no result');

  // ─────────────────────────────────────────────────────────────────────────
  section('An endpoint alert opens one ticket, and resolving it closes that ticket');
  await beat(fdA, { patchPosture: posture(true, []) });
  // The monitor counts from when rem0te first saw the restart pending; seed that an hour and a half ago.
  await until(async () => (await prisma.endpointMonitorState.findUnique({ where: { endpointId_ruleKey: { endpointId: fdA.id, ruleKey: 'reboot-pending' } } })), 10_000);
  await prisma.endpointMonitorState.update({ where: { endpointId_ruleKey: { endpointId: fdA.id, ruleKey: 'reboot-pending' } }, data: { breachSince: new Date(Date.now() - 90 * 60_000) } });
  await beat(fdB, { patchPosture: posture(true, []) });
  const raised = await until(() => peer.events.find((e) => e.kind === 'alert' && e.ev.type === 'alert.raised' && e.ev.alert.rem0te_endpoint_id === fdA.id), 40_000);
  check(!!raised && raised.ev.organization_id === ORG.acme && raised.ev.alert.kind === 'REBOOT_PENDING', 'alert.raised reached ClientSt0r for Acme\'s FRONTDESK', j(raised?.ev));
  const ps = raised?.ev.alert.patch_summary;
  check(ps && ps.reboot_required === true && ps.evidence_source === 'signed_agent_scan' && K.PatchSummary.safeParse(ps).success, 'it carries the redacted patch summary: restart required, from the signed scan', j(ps));
  check(!JSON.stringify(ps ?? {}).includes('Cumulative') && !JSON.stringify(ps ?? {}).includes(fdA.rid), 'the summary has no update titles or device identifiers');
  if (raised) example('alert-event.raised-with-patch-summary', 'rem0te → ClientSt0r: a signed alert event for a REBOOT_PENDING alert, carrying the redacted patch summary (revision 2). Verify over "rem0te-alert-event-v1\\n" + canonical JSON of `alert_event`.', { direction: 'rem0te_to_clientst0r', request: { method: 'POST', path: '/api/integration/v1/events', headers: raised.headers, body: raised.raw }, response: { status: 204, headers: {}, body: null }, request_schema: 'signed-alert-event', response_schema: null });
  const tickets = [...peer.tickets.entries()].filter(([, t]) => t.alertId === raised?.ev.alert.alert_id);
  check(tickets.length === 1, 'ClientSt0r opened exactly one ticket for it', j(tickets));
  const [ticketId] = tickets[0] ?? [];
  r = await call('POST', `/api/integration/v1/alerts/${raised?.ev.alert.alert_id}/ticket`, { body: { contract: 'ticket-rmm-v1', organization_id: ORG.acme, ticket_id: ticketId, ticket_url: `https://clientst0r.example/tickets/${ticketId}` }, record: { name: 'alert-ticket-link', description: 'ClientSt0r → rem0te: link the ticket it opened. Idempotent for the same ticket; another ticket is 409.', request_schema: 'alert-ticket-link', response_schema: 'alert' } });
  check(r.status === 201 && r.body.ticket?.id === ticketId, 'ClientSt0r linked that ticket to the alert', j(r.body));
  await sleep(4000);
  check(!peer.events.some((e) => e.kind === 'alert' && e.ev.alert.rem0te_endpoint_id === fdB.id), 'Birch\'s FRONTDESK (same name, no ticketing) produced no event for anyone');
  // The restart happens; the next signed scan shows nothing pending.
  await beat(fdA, { patchPosture: posture(false, []) });
  const resolved = await until(() => peer.events.find((e) => e.kind === 'alert' && e.ev.type === 'alert.resolved' && e.ev.alert.alert_id === raised?.ev.alert.alert_id), 40_000);
  check(!!resolved && resolved.ev.alert.ticket?.id === ticketId, 'alert.resolved arrived carrying the same ticket id', j(resolved?.ev?.alert));
  check(peer.tickets.get(ticketId)?.state === 'resolved' && [...peer.tickets.values()].filter((t) => t.alertId === raised?.ev.alert.alert_id).length === 1, 'ClientSt0r resolved that same ticket — one alert, one ticket, opened and closed', j([...peer.tickets.entries()]));

  // ─────────────────────────────────────────────────────────────────────────
  section('Delivery retried across a restart, without a duplicate');
  await stop('worker');
  peer.failNext = 3; // the next three deliveries lose their acknowledgement
  const key2 = `cs-ticket-77-${sfx}`;
  const b2 = jobBody({ org: ORG.acme, tech: 'cs-tina', endpoint: fdA.id, key: key2 });
  r = await submit(b2);
  const job2 = r.body?.job_id;
  check(r.status === 202 && !!job2, 'a job is accepted while the worker is down', j(r.body));
  await stop('api');
  startApi(); startWorker();
  await waitUp(`${API}/health`, 'api');
  r = await submit({ ...b2 }, { name: 'job-submit.replayed', description: 'ClientSt0r → rem0te: the same idempotency key and body again (here after a restart). 200 with idempotent-replayed: true and the same job — never a second job.', request_schema: 'job-request', response_schema: 'job' });
  check(r.status === 200 && r.body.job_id === job2 && r.headers.get('idempotent-replayed') === 'true', 'resubmitted after the restart: 200, idempotent-replayed, the same job id', j(r.body));
  r = await submit({ ...b2, ticket: { ...b2.ticket, body: 'Different text under the same key' } });
  check(r.status === 409 && r.body?.error?.code === 'IDEMPOTENCY_CONFLICT', 'the same key with a different body is a conflict, not a second job', j(r.body));
  const done2 = await settle(job2, 'cs-tina', ORG.acme);
  check(done2?.status === 'succeeded', 'the job finished after the restart', j(done2?.status));
  const got2 = await until(() => peer.events.find((e) => e.kind === 'job' && e.ev.job_id === job2 && e.ev.type === 'job.succeeded'), 40_000);
  check(!!got2, 'job.succeeded was delivered once the acknowledgements stopped failing');
  check((await prisma.integrationJob.count({ where: { peerId: PEER, idempotencyKey: key2 } })) === 1, 'exactly one job row exists for that key');
  const succ2 = peer.events.filter((e) => e.kind === 'job' && e.ev.job_id === job2 && e.ev.type === 'job.succeeded');
  check(succ2.length === 1, 'ClientSt0r applied job.succeeded once (redeliveries carry the same event_id and are acknowledged, not applied)', `${succ2.length} applied, ${peer.duplicates} duplicates acknowledged`);
  const alertEvents = await prisma.integrationAlertEvent.groupBy({ by: ['alertId', 'type'], where: { peerId: PEER }, _count: true });
  check(alertEvents.every((g) => g._count === 1), 'and no alert event was ever recorded twice', j(alertEvents));

  // ─────────────────────────────────────────────────────────────────────────
  section('Ownership: model keys and customer messages stay in ClientSt0r');
  check(peer.inference.length >= 3 && peer.inference.every((x) => !('api_key' in x.r) && !JSON.stringify(x.r).match(/sk-[A-Za-z0-9]{8}/)), 'every model run went to ClientSt0r\'s inference endpoint by profile name; no key in any request');
  r = await call('GET', '/api/integration/v1/capabilities');
  check(!('messaging' in (r.body?.features ?? {})) && (done1?.result?.draft_replies ?? []).length > 0 && done1.result.draft_replies.every((d) => d.visibility === 'staff_only' && d.requires_human_review === true), 'rem0te has no customer-messaging feature; a reply comes back staff-only, for human review, for ClientSt0r to send', j(done1?.result?.draft_replies));
  check(peer.badSignatures === 0, 'every rem0te request and event ClientSt0r received verified against rem0te\'s published key');

  section('Audit');
  const audit = await prisma.activityLog.groupBy({ by: ['action'], where: { customerId: { in: [acme.id, birch.id, cedar.id] } }, _count: true });
  const A = Object.fromEntries(audit.map((a) => [a.action, a._count]));
  check(Object.keys(A).some((k) => /INTEGRATION_JOB/.test(k)) && Object.keys(A).some((k) => /ACTION_(PROPOSED|REQUESTED)/.test(k)), 'jobs and proposals are in the audit log, by business', j(A));
}

async function writeExamples() {
  rmSync(EXAMPLES, { recursive: true, force: true });
  mkdirSync(path.join(EXAMPLES, 'keys'), { recursive: true });
  for (const [n, k] of Object.entries(KEYS)) {
    writeFileSync(path.join(EXAMPLES, 'keys', `${n}.pub.pem`), pub(k));
    writeFileSync(path.join(EXAMPLES, 'keys', `${n}.TEST-ONLY.pem`), k.export({ type: 'pkcs8', format: 'pem' }));
  }
  const meta = {
    contract: 'ticket-rmm-v1', contract_revision: K.CONTRACT_REVISION ?? null,
    generated_by: 'apps/api/scripts/e2e-ticket-workflow.mjs --write-examples', generated_at: new Date().toISOString(),
    rem0te_version: JSON.parse((await import('node:fs')).readFileSync(path.resolve(here, '..', '..', '..', 'version.json'), 'utf8')).version,
    peer: { id: PEER, audience: AUD, peer_audience: PEER_AUD, request_key_id: `${PEER}/req-1`, delegation_key_id: 'del-1' },
    rem0te: { key_id: 'rem0te/rem0te-example-1' },
    keys: 'keys/*.pub.pem verify these examples. keys/*.TEST-ONLY.pem are their private halves, published on purpose so the signatures can be reproduced: they protect nothing and must never be configured on a server.',
  };
  writeFileSync(path.join(EXAMPLES, 'index.json'), JSON.stringify({ ...meta, examples: examples.map((e) => ({ name: e.name, file: `${e.name}.json`, direction: e.direction, description: e.description })) }, null, 2) + '\n');
  for (const e of examples) writeFileSync(path.join(EXAMPLES, `${e.name}.json`), JSON.stringify(e, null, 2) + '\n');
  console.log(`\nwrote ${examples.length} examples to ${path.relative(process.cwd(), EXAMPLES)}`);
}

async function cleanup() {
  await Promise.all(['api', 'worker', 'signer'].map(stop));
  peerServer.close();
  try {
    const ids = created.businesses;
    await prisma.containmentPause.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.integrationAlertEvent.deleteMany({ where: { peerId: PEER } });
    const jobs = await prisma.integrationJob.findMany({ where: { peerId: PEER }, select: { id: true } });
    await prisma.integrationReplayGuard.deleteMany({ where: { OR: [{ jobId: { in: jobs.map((x) => x.id) } }, { key: { startsWith: `${PEER}:` } }] } });
    await prisma.integrationJob.deleteMany({ where: { peerId: PEER } });
    await prisma.actionJob.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.integrationTechnicianMapping.deleteMany({ where: { peerId: PEER } });
    await prisma.integrationOrgMapping.deleteMany({ where: { peerId: PEER } });
    await prisma.monitorAlert.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.endpointMonitorState.deleteMany({ where: { endpointId: { in: created.endpoints } } });
    await prisma.monitorRule.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.monitorNotifyPolicy.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.technicianAssignment.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.endpointInventory.deleteMany({ where: { endpointId: { in: created.endpoints } } });
    await prisma.rustdeskNode.deleteMany({ where: { endpointId: { in: created.endpoints } } });
    await prisma.endpoint.deleteMany({ where: { id: { in: created.endpoints } } });
    await prisma.membership.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.customer.deleteMany({ where: { id: { in: ids } } });
    await prisma.user.updateMany({ where: { id: { in: created.users } }, data: { status: 'SUSPENDED' } });
  } catch (e) { console.error('cleanup:', e.message); }
  await prisma.$disconnect();
  rmSync(work, { recursive: true, force: true });
}

try {
  await main();
  if (WRITE && fail === 0) await writeExamples();
  else if (WRITE) console.log('\nexamples NOT written: the run had failures');
} catch (e) {
  fail++; failures.push(`crashed: ${e.stack ?? e}`); console.error(e);
  for (const k of ['api', 'worker', 'signer']) if (kids[k]) console.error(`── ${k}\n${kids[k].log.slice(-2500)}`);
} finally {
  await cleanup();
  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
  if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exitCode = 1; }
}
void randomUUID;
