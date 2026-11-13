#!/usr/bin/env node
/**
 * End-to-end proof of software deployment (v0.34): a catalog of allowlisted
 * winget packages pinned by version and installer SHA-256, installed and
 * uninstalled as signed, two-approver actions on one computer or ring by
 * ring, and the version-compliance report built from detection evidence.
 *
 * Self-contained, like e2e-maintenance-actions.mjs: a signed update
 * repository from the offline release tool, the approval signer as its own
 * process, the compiled API on its own port (3461) and a scratch database, a
 * local stand-in for raw.githubusercontent.com/microsoft/winget-pkgs (3464,
 * loopback only, the one override the API accepts), synthetic passkeys
 * checked by the signer's real WebAuthn verification, and rem0te-action-sim —
 * the agent's real verifier and executor (internal/action) running a stub
 * winget through the agent's real exec path (internal/winget).
 *
 *   cd apps/api && npx nest build
 *   (cd ../../tools/windows-installer && go build -o /tmp/rem0te-release ./cmd/rem0te-release \
 *      && go build -o /tmp/rem0te-action-sim ./cmd/rem0te-action-sim)
 *   RELEASE_BIN=/tmp/rem0te-release ACTION_SIM=/tmp/rem0te-action-sim \
 *   DATABASE_URL=postgresql://…/reboot_remote_it_scratch node scripts/e2e-software-deploy.mjs
 *
 * What it proves is FIXTURE-TESTED behaviour. winget, the uninstall
 * registry, file version resources and the ConfigMgr / Intune services are
 * simulated; none of it has run on a real Windows computer.
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { syntheticPasskey } from './lib/synthetic-passkey.mjs';

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
const BIN = process.env.RELEASE_BIN, SIM = process.env.ACTION_SIM;
if (!BIN || !SIM) { console.error('RELEASE_BIN (rem0te-release) and ACTION_SIM (rem0te-action-sim) are required'); process.exit(2); }
const PORT = Number(process.env.SW_API_PORT ?? 3461);
const SIGNER_PUBLIC = Number(process.env.SW_SIGNER_PUBLIC_PORT ?? 3462);
const SIGNER_INTERNAL = Number(process.env.SW_SIGNER_INTERNAL_PORT ?? 3463);
const MANIFESTS = Number(process.env.SW_MANIFEST_PORT ?? 3464);
if ([PORT, SIGNER_PUBLIC, SIGNER_INTERNAL, MANIFESTS].some((p) => [3000, 3001, 443, 3201, 3202, 4000, 4001].includes(p))) { console.error('refusing a production port'); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
const ROOT = `http://127.0.0.1:${PORT}`;
const ORIGIN = `http://127.0.0.1:${SIGNER_PUBLIC}`;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'software-e2e-password-123';
// The 0.34 catalog: the original six, then script run, then software.
const ALL_ACTIONS = ['windows.service.start@1', 'windows.update.install@1', 'windows.service.restart@1', 'windows.reboot.schedule@1', 'windows.reboot.cancel@1', 'windows.logs.collect@1', 'windows.script.run@1', 'windows.software.install@1', 'windows.software.uninstall@1', 'windows.software.remove@1'];

let pass = 0, fail = 0; const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── The packages (synthetic installers: their bytes are what is hashed) ────
const SEVEN = { id: '7zip.7zip', version: '24.08', bytes: '7-Zip 24.08 x64 installer (synthetic)', x86: '7-Zip 24.08 x86 installer (synthetic)', arm: '7-Zip 24.08 arm64 installer (synthetic)' };
const NPP = { id: 'Notepad++.Notepad++', v1: '8.7.1', v2: '8.7.2', b1: 'Notepad++ 8.7.1 installer (synthetic)', b2: 'Notepad++ 8.7.2 installer (synthetic)' };
const GLOBEX = { id: 'Globex.Tool', version: '2.0.0.0', bytes: 'Globex Tool 2.0 installer (synthetic)' };
const SEVEN_RULE = { kind: 'display_name', name: '7-Zip', match: 'prefix', compare: 'gte', version: '24.08' };
const NPP_RULE = { kind: 'uninstall_key', key: 'Notepad++', compare: 'gte', version: '8.7' };
const GLOBEX_RULE = { kind: 'file_version', base: 'ProgramFiles', file: 'Globex\\tool.exe', compare: 'eq', version: '2.0.0.0' };

// ── The winget-pkgs stand-in ────────────────────────────────────────────────
const up = (s) => sha(s).toUpperCase();
const sevenManifest = `# Created with a synthetic fixture
# yaml-language-server: $schema=https://aka.ms/winget-manifest.installer.1.6.0.schema.json

PackageIdentifier: 7zip.7zip
PackageVersion: "24.08"
InstallerType: exe
Scope: machine
Installers:
- Architecture: x86
  InstallerUrl: https://www.7-zip.org/a/7z2408.exe
  InstallerSha256: ${up(SEVEN.x86)}
- Architecture: x64
  InstallerUrl: https://www.7-zip.org/a/7z2408-x64.exe
  InstallerSha256: ${up(SEVEN.bytes)}
- Architecture: arm64
  InstallerUrl: https://www.7-zip.org/a/7z2408-arm64.exe
  InstallerSha256: ${up(SEVEN.arm)}
ManifestType: installer
ManifestVersion: 1.6.0
`;
const fixtures = {
  '7/7zip/7zip/24.08/7zip.7zip.installer.yaml': sevenManifest,
  'c/Contoso/Ambig/1.0/Contoso.Ambig.installer.yaml': `PackageIdentifier: Contoso.Ambig\nPackageVersion: "1.0"\nInstallers:\n- Architecture: x64\n  InstallerType: msi\n  InstallerSha256: ${up('a')}\n- Architecture: x64\n  InstallerType: exe\n  InstallerSha256: ${up('b')}\nManifestType: installer\n`,
  'c/Contoso/Wrong/1.0/Contoso.Wrong.installer.yaml': `PackageIdentifier: Contoso.Wrong\nPackageVersion: "2.0"\nInstallers:\n- Architecture: x64\n  InstallerSha256: ${up('c')}\nManifestType: installer\n`,
  'c/Contoso/Big/1.0/Contoso.Big.installer.yaml': `PackageIdentifier: Contoso.Big\n# ${'x'.repeat(300 * 1024)}\n`,
  'c/Contoso/UserOnly/1.0/Contoso.UserOnly.installer.yaml': `PackageIdentifier: Contoso.UserOnly\nPackageVersion: "1.0"\nInstallers:\n- Architecture: x64\n  Scope: user\n  InstallerSha256: ${up('d')}\nManifestType: installer\n`,
};
const fetched = [];
const manifestServer = createServer((rq, rs) => {
  fetched.push({ url: rq.url, auth: rq.headers.authorization ?? null, cookie: rq.headers.cookie ?? null });
  const rel = (rq.url ?? '').replace(/^\/manifests\//, '');
  if (rq.method !== 'GET' || !fixtures[rel]) { rs.writeHead(404); rs.end('404: Not Found'); return; }
  rs.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); rs.end(fixtures[rel]);
});

// ── The release machine ─────────────────────────────────────────────────────
const work = mkdtempSync(path.join(tmpdir(), 'rem0te-sw-'));
const keys = path.join(work, 'keys'); mkdirSync(keys);
const repo = path.join(work, 'repo');
const files = path.join(work, 'files'); mkdirSync(files);
const signerDir = path.join(work, 'signer'); mkdirSync(signerDir, { mode: 0o700 });
const rel = (...a) => execFileSync(BIN, a, { encoding: 'utf8' });
const signerCli = (args) => spawnSync(process.execPath, [path.join(dist, 'approval-signer', 'main.js'), ...args], { encoding: 'utf8', env: { ...process.env, APPROVAL_SIGNER_DIR: signerDir } });
for (const k of ['r1', 'r2', 'r3', 'targets', 'snapshot', 'timestamp']) rel('keygen', '-out', path.join(keys, `${k}.pem`));
rel('init', '-repo', repo, '-root-key', path.join(keys, 'r1.pem'), '-root-key', path.join(keys, 'r2.pem'), '-root-key', path.join(keys, 'r3.pem'),
  '-root-threshold', '2', '-targets-key', path.join(keys, 'targets.pem'), '-snapshot-key', path.join(keys, 'snapshot.pem'), '-timestamp-key', path.join(keys, 'timestamp.pem'));
const slot = Buffer.concat([Buffer.from('REM0TE_INST_URL:'), Buffer.alloc(240)]);
const agentBin = Buffer.concat([Buffer.from('MZ stand-in signed agent 0.34 '), randomBytes(64), slot]);
writeFileSync(path.join(files, 'agent.exe'), agentBin);
const AGENT_SHA = sha(agentBin);
const kg = signerCli(['keygen']);
if (kg.status !== 0) throw new Error(`signer keygen: ${kg.stderr}`);
writeFileSync(path.join(files, 'approval-keys.json'), kg.stdout);
rel('release', '-repo', repo, '-targets-key', path.join(keys, 'targets.pem'), '-snapshot-key', path.join(keys, 'snapshot.pem'), '-timestamp-key', path.join(keys, 'timestamp.pem'),
  '-add', `windows/rem0te-agent.exe=${path.join(files, 'agent.exe')}`, '-add', `approval/keys.json=${path.join(files, 'approval-keys.json')}`);

// ── Processes ───────────────────────────────────────────────────────────────
const kids = {};
function start(name, script, env) {
  const p = spawn(process.execPath, [script, ...(name === 'signer' ? ['serve'] : [])], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  p.log = ''; p.stdout.on('data', (d) => { p.log += d; }); p.stderr.on('data', (d) => { p.log += d; });
  kids[name] = p; return p;
}
async function stop(name) { const p = kids[name]; if (!p || p.exitCode !== null) return; await new Promise((r) => { p.once('exit', r); p.kill('SIGTERM'); }); }
const signerEnv = { ...process.env, APPROVAL_SIGNER_DIR: signerDir, APPROVAL_ORIGIN: ORIGIN, APPROVAL_RP_ID: '127.0.0.1', APPROVAL_PUBLIC_PORT: String(SIGNER_PUBLIC), APPROVAL_INTERNAL_PORT: String(SIGNER_INTERNAL) };
delete signerEnv.DATABASE_URL;

// ClientSt0r, only to show the software actions are not offered to it.
const pair = () => generateKeyPairSync('ed25519');
const pem = (k) => k.export({ type: 'spki', format: 'pem' }).toString();
const self = pair(), peerReq = pair(), peerDel = pair();
writeFileSync(path.join(work, 'self.pem'), self.privateKey.export({ type: 'pkcs8', format: 'pem' }));
const AUD = 'rem0te:sw-lab', PEER = `clientst0r-sw-${sfx}`;
const peersFile = path.join(work, 'peers.json');
writeFileSync(peersFile, JSON.stringify({
  self: { keyId: 'rem0te-sw-1', privateKeyFile: path.join(work, 'self.pem') },
  peers: [{ id: PEER, audience: AUD, peerAudience: 'clientst0r:sw-lab', requestKeys: [{ kid: 'req-1', publicKeyPem: pem(peerReq.publicKey) }], delegationKeys: [{ kid: 'del-1', publicKeyPem: pem(peerDel.publicKey) }], inferenceUrl: 'http://127.0.0.1:9/api/integration/v1/inference', eventsUrl: 'http://127.0.0.1:9/api/integration/v1/events', modelProfiles: ['triage-fast'] }],
}));
const apiEnv = {
  ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATABASE_URL: DB, UPDATE_REPO_DIR: repo, MONITOR_SWEEP: 'off', PATCH_POLICY_SWEEP: 'off', METRIC_SWEEP: 'off', CLIENT_UPDATE_SWEEP: 'off',
  APPROVAL_SIGNER_INTERNAL_URL: `http://127.0.0.1:${SIGNER_INTERNAL}`, INTEGRATION_PEERS_FILE: peersFile,
  WINGET_MANIFEST_BASE: `http://127.0.0.1:${MANIFESTS}/manifests`,
  JWT_SECRET: randomBytes(32).toString('hex'), LAUNCHER_TOKEN_SECRET: randomBytes(32).toString('hex'),
  ENCRYPTION_KEY: randomBytes(32).toString('hex'), TRUSTED_PROXIES: 'loopback',
  VERSION_FILE: path.resolve(here, '..', '..', '..', 'version.json'),
};
async function waitUp(url, name) {
  for (let i = 0; i < 120; i++) { try { const r = await fetch(url); if (r.status < 500) return; } catch { /* not yet */ } await sleep(300); }
  throw new Error(`${name} did not come up:\n${kids[name]?.log.slice(-3000)}`);
}

// ── HTTP helpers ────────────────────────────────────────────────────────────
// Paced under the 20 req/s burst throttler, and a fresh source address per
// request: the write routes allow 10 a minute per address (RateLimit(10)).
// The step-up cookie is bound to the user and the session, not the address.
async function req(method, p, { s, body, business, raw = false } = {}) {
  await sleep(60);
  const h = { 'content-type': 'application/json', 'x-forwarded-for': ip() };
  if (s) h.cookie = s.cookie + (s.stepUp ? `; step_up=${s.stepUp}` : '');
  if (business) h['x-rem0te-business'] = business;
  const r = await fetch(`${API}${p}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j = text; if (!raw) { try { j = JSON.parse(text); } catch { j = text; } }
  return { status: r.status, body: j, setCookie: r.headers.get('set-cookie') ?? '', type: r.headers.get('content-type') ?? '' };
}
async function login(email) {
  const s = { ip: ip() };
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': s.ip }, body: JSON.stringify({ email, password: PW }) });
  const m = (r.headers.get('set-cookie') ?? '').match(/access_token=([^;]+)/);
  if (r.status !== 200 || !m) throw new Error(`login ${email}: ${r.status} ${await r.text()}`);
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
const msg = (r) => `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`;
const sj = async (url, init = {}) => { const r = await fetch(url, init); let b = null; try { b = await r.json(); } catch { /* html */ } return { status: r.status, body: b }; };
const signerPost = (id, p, body) => sj(`${ORIGIN}/approve/${id}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify(body) });
async function approve(jobId, who, { decision = 'approve', role = 'approver' } = {}) {
  const c = await signerPost(jobId, '/challenge', { decision, role });
  if (c.status !== 200) return c;
  return signerPost(jobId, '/decide', { challengeId: c.body.challengeId, assertion: who.assert(c.body.options, { origin: ORIGIN }) });
}
const heartbeat = (ep, extra = {}) => req('POST', '/enrollment/heartbeat', {
  body: { rustdeskId: ep.rid, agentSecret: ep.secret, hostname: ep.hostname, platform: ep.platform, updateChannel: 'signed', agentActions: ep.actions, agentSha256: AGENT_SHA, ...extra },
});
function resultsOf(ep) {
  const d = path.join(ep.state, 'actions', 'results');
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => /^[0-9a-f]{32}\.json$/.test(f)).map((f) => JSON.parse(readFileSync(path.join(d, f), 'utf8')));
}
function clearAcked(ep, acks) { for (const a of acks ?? []) rmSync(path.join(ep.state, 'actions', 'results', `${a}.json`), { force: true }); }
let keysFile;
// The simulated computer's winget, uninstall registry, files and app managers.
const wingetFile = (ep) => path.join(ep.state, 'winget.json');
const setWinget = (ep, st) => writeFileSync(wingetFile(ep), JSON.stringify(st));
const wingetNow = (ep) => JSON.parse(readFileSync(wingetFile(ep), 'utf8'));
const clearCalls = (ep) => { const s = wingetNow(ep); s.calls = []; setWinget(ep, s); };
function runAgent(ep, jobId, envelope, { pause, timeout } = {}) {
  const envFile = path.join(work, `env-${jobId}-${randomBytes(3).toString('hex')}.json`);
  writeFileSync(envFile, JSON.stringify(envelope));
  const args = ['-state', ep.state, '-keys', keysFile, '-job', jobId, '-envelope', envFile, '-rustdesk-id', ep.rid, '-secret', ep.secret, '-product-type', '1', '-self-sha', AGENT_SHA, '-winget', wingetFile(ep)];
  if (pause) args.push('-pause', pause);
  if (timeout) args.push('-winget-timeout', timeout);
  // 0.36: the agent fetches the signer's revocation statement from the portal's relay before each job.
  args.push('-portal', `127.0.0.1:${PORT}`);
  return JSON.parse(execFileSync(SIM, args, { encoding: 'utf8', timeout: 120_000 }).trim());
}
const WINGET = 'v1.9.25200';

// ClientSt0r client.
async function call(method, p) {
  const t = String(Math.floor(Date.now() / 1000)), n = randomBytes(18).toString('base64url');
  const sig = C.signEd25519(peerReq.privateKey, C.requestSigningString({ audience: AUD, method, pathWithQuery: p, timestamp: t, nonce: n, bodySha256: C.sha256Hex(Buffer.from('')) }));
  const r = await fetch(`${ROOT}${p}`, { method, headers: { 'rem0te-key-id': `${PEER}/req-1`, 'rem0te-timestamp': t, 'rem0te-nonce': n, 'rem0te-signature': sig } });
  const out = await r.text(); let j; try { j = JSON.parse(out); } catch { j = out; }
  return { status: r.status, body: j };
}

const created = { businesses: [], users: [], entries: [] };

async function all() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  const preexisting = await prisma.softwareCatalogEntry.count({ where: { scope: 'GLOBAL', archivedAt: null, packageId: SEVEN.id } });
  if (preexisting) throw new Error(`the scratch database already has a live global ${SEVEN.id} entry (an earlier run that did not clean up?)`);
  const roleUser = await prisma.role.findFirst({ where: { type: 'BUSINESS_USER' } });
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });

  section('Fixtures (synthetic): Acme with eleven computers, Globex with one');
  const acme = await prisma.customer.create({ data: { tenantId: tenant.id, name: `SW Acme ${sfx}` } });
  const globex = await prisma.customer.create({ data: { tenantId: tenant.id, name: `SW Globex ${sfx}` } });
  created.businesses.push(acme.id, globex.id);
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag, extra = {}) => { const u = await prisma.user.create({ data: { email: `sw-${tag}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'SW', lastName: tag, status: 'ACTIVE', ...extra } }); created.users.push(u.id); return u; };
  const admin = await mkUser('admin', { isPlatformAdmin: true });
  const owen = await mkUser('owen-owner'), bob = await mkUser('bob-globex-owner'), pat = await mkUser('pat-user'), dana = await mkUser('dana-l2'), sam = await mkUser('sam-l3');
  const olivia = await mkUser('olivia-approver', { platformPermissions: ['technicians:manage'] }), quinn = await mkUser('quinn-approver', { platformPermissions: ['technicians:manage'] });
  await prisma.membership.create({ data: { userId: owen.id, tenantId: tenant.id, customerId: acme.id, roleId: roleOwner.id, capabilities: [] } });
  await prisma.membership.create({ data: { userId: bob.id, tenantId: tenant.id, customerId: globex.id, roleId: roleOwner.id, capabilities: [] } });
  await prisma.membership.create({ data: { userId: pat.id, tenantId: tenant.id, customerId: acme.id, roleId: roleUser.id, capabilities: ['computers:view', 'actions:request'] } });
  const l2 = await prisma.technicianPreset.findUnique({ where: { key: 'l2-technician' } });
  const l3 = await prisma.technicianPreset.findUnique({ where: { key: 'l3-senior' } });
  if (!l2 || !l3) throw new Error('built-in presets missing: boot the API once against this database (run-e2e.sh does)');
  await prisma.technicianAssignment.create({ data: { tenantId: tenant.id, customerId: acme.id, userId: dana.id, presetId: l2.id, capabilities: [] } });
  await prisma.technicianAssignment.create({ data: { tenantId: tenant.id, customerId: acme.id, userId: sam.id, presetId: l3.id, capabilities: [] } });
  const mkEp = async (hostname, { business = acme, actions = ALL_ACTIONS, platform = 'Windows', winget = { version: WINGET } } = {}) => {
    const e = await prisma.endpoint.create({ data: { tenantId: tenant.id, customerId: business.id, name: hostname, hostname, platform, status: 'ACTIVE', isOnline: true, isManaged: true, accessMode: 'COMPANY_WIDE', lastSeenAt: new Date(), deviceClass: 'WORKSTATION' } });
    const rid = String(100000000 + ((Math.random() * 899999999) | 0));
    const secret = randomBytes(24).toString('hex');
    await prisma.rustdeskNode.create({ data: { tenantId: tenant.id, endpointId: e.id, rustdeskId: rid, agentSecretHash: sha(secret) } });
    const state = path.join(work, `agent-${hostname}`); mkdirSync(state);
    const ep = { id: e.id, rid, secret, state, hostname, actions, platform };
    setWinget(ep, winget);
    return ep;
  };
  const sevenPkg = { installer: SEVEN.bytes, displayName: '7-Zip 24.08 (x64)', displayVersion: '24.08', uninstallKey: '7-Zip' };
  const offer7 = { [`${SEVEN.id}@${SEVEN.version}`]: sevenPkg };
  const canary = await mkEp('CANARY', { winget: { version: WINGET, packages: offer7 } });
  const r1a = await mkEp('R1A');
  const r1b = await mkEp('R1B', { winget: { version: WINGET, packages: { [`${SEVEN.id}@${SEVEN.version}`]: { ...sevenPkg, noEffect: true } } } });
  const r2a = await mkEp('R2A', { winget: { version: WINGET, packages: offer7 } });
  const r2b = await mkEp('R2B', { winget: { version: WINGET, packages: offer7 } });
  const oldpc = await mkEp('OLDPC', { actions: ALL_ACTIONS.slice(0, 6) });
  const macpc = await mkEp('MACPC', { platform: 'macOS' });
  const cmpc = await mkEp('CMPC');
  const nowg = await mkEp('NOWG', { winget: { version: '' } });
  const slow = await mkEp('SLOWPC', { winget: { version: WINGET, packages: { [`${SEVEN.id}@${SEVEN.version}`]: { ...sevenPkg, hang: true } } } });
  const intune = await mkEp('INTUNE', { winget: { version: WINGET, packages: offer7, managers: ['intune'] } });
  const gpc = await mkEp('GLOBEXPC', { business: globex, winget: { version: WINGET, packages: { [`${GLOBEX.id}@${GLOBEX.version}`]: { installer: GLOBEX.bytes, displayName: 'Globex Tool', displayVersion: '2.0.0.0', file: 'ProgramFiles|Globex\\tool.exe' } } } });
  const acmeEps = [canary, r1a, r1b, r2a, r2b, oldpc, macpc, cmpc, nowg, slow, intune];
  // What the inventory says (the 0.31 software list): OLDPC has 7-Zip, CMPC an
  // older one and ConfigMgr in its patch posture, NOWG had it 20 days ago,
  // INTUNE has never had it.
  const days = (n) => new Date(Date.now() - n * 86_400_000);
  const sw = (...p) => p.map(([name, version]) => ({ name, version, publisher: null, installedOn: null }));
  await prisma.endpointInventory.create({ data: { endpointId: oldpc.id, collectedAt: new Date(), software: sw(['7-Zip 24.08 (x64)', '24.08']), softwareCount: 1 } });
  await prisma.endpointInventory.create({
    data: {
      endpointId: cmpc.id, collectedAt: new Date(), software: sw(['7-Zip 23.01 (x64)', '23.01']), softwareCount: 1,
      patchPosture: { schema: 'rem0te-patch-posture/1', scannedAt: new Date().toISOString(), updates: [], history: [], reboot: { pending: false, sources: [] }, managers: ['configmgr'], autoUpdate: 'enabled' },
    },
  });
  await prisma.endpointInventory.create({ data: { endpointId: nowg.id, collectedAt: days(20), software: sw(['7-Zip 24.08 (x64)', '24.08']), softwareCount: 1 } });
  await prisma.endpointInventory.create({ data: { endpointId: intune.id, collectedAt: new Date(), software: sw(['Microsoft Edge', '130.0.2849.80']), softwareCount: 1 } });
  const pk = { olivia: syntheticPasskey({ userId: olivia.id, name: 'SW olivia' }), quinn: syntheticPasskey({ userId: quinn.id, name: 'SW quinn' }) };
  for (const k of Object.values(pk)) await prisma.userMfaMethod.create({ data: { userId: k.userId, type: 'WEBAUTHN', isActive: true, credentialId: k.credentialId, publicKey: Buffer.from(k.publicKey, 'base64url'), signCount: 0, name: 'Test key' } });
  check(true, 'two businesses, twelve computers, eight people');

  await new Promise((r) => manifestServer.listen(MANIFESTS, '127.0.0.1', r));
  start('signer', path.join(dist, 'approval-signer', 'main.js'), signerEnv);
  start('api', path.join(dist, 'main.js'), apiEnv);
  await waitUp(`http://127.0.0.1:${SIGNER_INTERNAL}/internal/v1/keys`, 'signer');
  await waitUp(`${API}/health`, 'api');
  const S = {};
  for (const [k, u] of Object.entries({ admin, owen, bob, pat, dana, sam, olivia, quinn })) S[k] = await login(u.email);

  section('Roster and keys');
  for (const who of ['olivia', 'quinn']) {
    const list = await req('GET', '/auth/passkeys', { s: S[who] });
    const mine = (list.body?.data ?? list.body ?? [])[0];
    const add = signerCli(['roster', 'add', '--export', mine.approvalExport, '--approve', '*', '--confirm-fingerprint', mine.approvalFingerprint]);
    if (add.status !== 0) throw new Error(`roster add ${who}: ${add.stderr}`);
  }
  {
    const metas = readdirSync(path.join(repo, 'metadata')).filter((f) => /^\d+\.targets\.json$/.test(f)).sort((a, b) => parseInt(b) - parseInt(a));
    const targets = await (await fetch(`${API}/public/updates/metadata/${metas[0]}`)).json();
    const t = targets.signed.targets['approval/keys.json'];
    const buf = Buffer.from(await (await fetch(`${API}/public/updates/targets/approval/${t.hashes.sha256}.keys.json`)).arrayBuffer());
    check(sha(buf) === t.hashes.sha256, 'approval/keys.json comes through the portal mirror and matches signed metadata');
    keysFile = path.join(work, 'keys.json'); writeFileSync(keysFile, buf);
  }
  for (const ep of [...acmeEps, gpc]) await heartbeat(ep);

  section('Catalog: eight actions; the two software actions high impact, never direct, not offered to ClientSt0r');
  {
    const cat = await req('GET', '/actions/catalog', { s: S.sam, business: acme.id });
    const acts = cat.body?.data?.actions ?? [];
    const by = Object.fromEntries(acts.map((a) => [a.id, a]));
    check(acts.map((a) => `${a.id}@${a.version}`).join(',') === ALL_ACTIONS.join(','), 'GET /actions/catalog lists exactly the nine, in order, software last (after script run)', acts.map((a) => a.id).join(','));
    check(['windows.software.install', 'windows.software.uninstall'].every((id) => by[id]?.workstationRisk === 'high' && by[id]?.direct === false && by[id]?.maxTargets === 25),
      'install and uninstall: high impact on a workstation, at most 25 computers, not requestable from the Actions tab');
    const caps = await call('GET', '/api/integration/v1/capabilities');
    check(caps.status === 200 && caps.body.features.actions.join(',') === 'windows.service.start@1,windows.update.install@1', 'ClientSt0r is still offered only the two 0.26/0.27 actions', JSON.stringify(caps.body?.features?.actions));
    const params = { packageId: SEVEN.id, version: SEVEN.version, installerSha256: sha(SEVEN.bytes), scope: 'machine', detection: SEVEN_RULE };
    const r = await req('POST', `/endpoints/${canary.id}/actions`, { s: S.sam, business: acme.id, body: { actionId: 'windows.software.install', version: 1, params, reason: 'straight from the Actions tab' } });
    check(r.status === 400 && code(r) === 'ACTION_NOT_DIRECT' && /software catalog/.test(JSON.stringify(r.body)), 'POST /endpoints/:id/actions with windows.software.install → 400 ACTION_NOT_DIRECT, pointing at the catalog', msg(r));
  }

  section('The catalog: manifest read, pinned hash, fresh sign-in, charset, audit');
  let seven, npp, gtool;
  {
    let r = await req('POST', '/software/manifest-preview', { s: S.admin, body: { packageId: SEVEN.id, version: SEVEN.version } });
    const inst = r.body?.data?.installers ?? [];
    check(r.status === 200 && r.body.data.manifestSha256 === sha(sevenManifest) && inst.length === 3 && inst.find((i) => i.architecture === 'x64')?.installerSha256 === sha(SEVEN.bytes),
      'manifest preview reads the winget-pkgs installer manifest: three installers, lower-cased hashes, the manifest\'s own SHA-256', msg(r));
    check(fetched.at(-1)?.url === '/manifests/7/7zip/7zip/24.08/7zip.7zip.installer.yaml' && fetched.every((f) => !f.auth && !f.cookie), 'the request is the winget-pkgs layout, with no credentials or cookies', JSON.stringify(fetched.at(-1)));
    for (const [n, body, want, st] of [
      ['an unknown version', { packageId: SEVEN.id, version: '99.0' }, 'MANIFEST_NOT_FOUND', 404],
      ['a manifest naming another version', { packageId: 'Contoso.Wrong', version: '1.0' }, 'MANIFEST_MISMATCH', 502],
      ['a manifest over 256 KB', { packageId: 'Contoso.Big', version: '1.0' }, 'MANIFEST_TOO_LARGE', 502],
    ]) {
      r = await req('POST', '/software/manifest-preview', { s: S.admin, body });
      check(r.status === st && code(r) === want, `${n} → ${st} ${want}`, msg(r));
    }
    r = await req('POST', '/software/manifest-preview', { s: S.sam, business: acme.id, body: { packageId: SEVEN.id, version: SEVEN.version } });
    check(r.status === 403, 'a technician cannot read manifests for the catalog (it is the owner\'s decision)', msg(r));

    const sevenBody = { scope: 'global', packageId: SEVEN.id, name: '7-Zip', publisher: 'Igor Pavlov', version: SEVEN.version, hash: { source: 'winget_pkgs', architecture: 'x64' }, detection: SEVEN_RULE };
    r = await req('POST', '/software/catalog', { s: S.admin, body: sevenBody });
    check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED', 'adding to the catalog without a fresh sign-in → 403 STEP_UP_REQUIRED', msg(r));
    check(!(await prisma.softwareCatalogEntry.count({ where: { packageId: SEVEN.id } })), '…and nothing was written');
    S.adminF = await stepUp(S.admin);
    S.owenF = await stepUp(S.owen);
    S.bobF = await stepUp(S.bob);
    S.samF = await stepUp(S.sam);
    S.patF = await stepUp(S.pat);

    // Every value that reaches winget's argument list or the detection probe is charset-checked first.
    const inj = [
      ['a package id with a shell separator', { packageId: '7zip.7zip;calc' }],
      ['a package id with a space and a flag', { packageId: '7zip.7zip --override' }],
      ['a package id that is a flag', { packageId: '--force.x' }],
      ['a package id starting with "-"', { packageId: '-h.7zip' }],
      ['a package id with a quote', { packageId: '7zip.7zip"&calc' }],
      ['a package id with a path', { packageId: '..\\..\\x.y' }],
      ['a package id with no dot', { packageId: '7zip' }],
      ['a package id over 128 characters', { packageId: `a.${'b'.repeat(64)}.${'c'.repeat(64)}` }],
      ['a version that is a flag', { version: '--force' }],
      ['a version with a space', { version: '24.08 --override x' }],
      ['an upper-case pasted hash', { hash: { source: 'admin_pasted', installerSha256: sha('x').toUpperCase() } }],
      ['an override flag in the hash', { hash: { source: 'admin_pasted', installerSha256: sha('x'), ignoreSecurityHash: true } }],
      ['a detection file walking out of Program Files', { detection: { kind: 'file_version', base: 'ProgramFiles', file: '..\\Windows\\System32\\cmd.exe', compare: 'gte', version: '1' } }],
      ['a detection file with a drive', { detection: { kind: 'file_version', base: 'ProgramFiles', file: 'C:\\x.exe', compare: 'gte', version: '1' } }],
      ['a detection file that is not a program', { detection: { kind: 'file_version', base: 'ProgramFiles', file: '7-Zip\\7z.bat', compare: 'gte', version: '1' } }],
      ['a detection base outside the two', { detection: { kind: 'file_version', base: 'Windows', file: 'x.exe', compare: 'gte', version: '1' } }],
      ['a registry key with a backslash', { detection: { kind: 'uninstall_key', key: '..\\Run', compare: 'gte', version: '1' } }],
      ['a display name with markup', { detection: { ...SEVEN_RULE, name: '<script>alert(1)</script>' } }],
      ['a detection rule that runs something', { detection: { kind: 'script', script: 'Get-Item' } }],
      ['an extra detection key', { detection: { ...SEVEN_RULE, command: 'whoami' } }],
      ['a user-scope entry', { scope: 'user' }],
      ['an extra field', { installArgs: '/S /D=C:\\evil' }],
    ];
    for (const [n, over] of inj) {
      r = await req('POST', '/software/catalog', { s: S.adminF, body: { ...sevenBody, ...over } });
      check(r.status === 400 && code(r) === 'INVALID_REQUEST', `${n} → 400`, msg(r));
    }
    check(!fetched.some((f) => /calc|override|force|\.\./.test(f.url)), 'no refused value ever reached the manifest fetch');

    r = await req('POST', '/software/catalog', { s: S.adminF, body: { ...sevenBody, hash: { source: 'winget_pkgs', architecture: 'arm64', installerSha256: sha(SEVEN.bytes) } } });
    check(r.status === 409 && code(r) === 'HASH_NOT_IN_MANIFEST', 'naming a hash that is not the architecture\'s installer → 409 HASH_NOT_IN_MANIFEST', msg(r));
    r = await req('POST', '/software/catalog', { s: S.adminF, body: { ...sevenBody, packageId: 'Contoso.Ambig', version: '1.0' } });
    check(r.status === 409 && code(r) === 'AMBIGUOUS_INSTALLER', 'two different x64 installers and none chosen → 409 AMBIGUOUS_INSTALLER', msg(r));
    r = await req('POST', '/software/catalog', { s: S.adminF, body: { ...sevenBody, packageId: 'Contoso.UserOnly', version: '1.0' } });
    check(r.status === 409 && code(r) === 'NO_MACHINE_INSTALLER', 'a package with only a per-user installer → 409 NO_MACHINE_INSTALLER', msg(r));

    r = await req('POST', '/software/catalog', { s: S.adminF, body: sevenBody });
    seven = r.body?.data;
    if (seven?.id) created.entries.push(seven.id);
    check(r.status === 201 && seven.scope === 'global' && seven.installerSha256 === sha(SEVEN.bytes) && seven.hashSource === 'winget_pkgs' && seven.manifestSha256 === sha(sevenManifest)
      && seven.architecture === 'x64' && /7z2408-x64\.exe$/.test(seven.installerUrl) && seven.revision === 1,
    'a Platform Admin, freshly signed in, adds 7-Zip 24.08 globally: the x64 hash pinned from the manifest, with the manifest\'s URL and digest', msg(r));
    r = await req('POST', '/software/catalog', { s: S.adminF, body: sevenBody });
    check(r.status === 409 && code(r) === 'ENTRY_EXISTS', 'a second live global 7zip.7zip → 409 ENTRY_EXISTS', msg(r));

    const nppBody = { scope: 'business', businessId: acme.id, packageId: NPP.id, name: 'Notepad++', publisher: 'Notepad++ Team', version: NPP.v1, hash: { source: 'admin_pasted', installerSha256: sha(NPP.b1) }, detection: NPP_RULE };
    r = await req('POST', '/software/catalog', { s: S.owen, body: nppBody });
    check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED', 'the Business Owner, not freshly signed in → STEP_UP_REQUIRED', msg(r));
    r = await req('POST', '/software/catalog', { s: S.owenF, body: { ...sevenBody, packageId: 'Contoso.Ambig' } });
    check(r.status === 403, 'the Business Owner cannot add to the global catalog', msg(r));
    r = await req('POST', '/software/catalog', { s: S.samF, business: acme.id, body: nppBody });
    check(r.status === 403, 'an L3 technician (even freshly signed in) cannot change the catalog', msg(r));
    r = await req('POST', '/software/catalog', { s: S.patF, body: nppBody });
    check(r.status === 403, 'a Business User cannot change the catalog', msg(r));
    r = await req('POST', '/software/catalog', { s: S.bobF, body: nppBody });
    check(r.status === 404 || r.status === 403, 'Globex\'s owner cannot add an entry to Acme\'s catalog', msg(r));
    r = await req('POST', '/software/catalog', { s: S.owenF, body: nppBody });
    npp = r.body?.data;
    if (npp?.id) created.entries.push(npp.id);
    check(r.status === 201 && npp.scope === 'business' && npp.businessId === acme.id && npp.hashSource === 'admin_pasted' && npp.manifestSha256 === null && npp.installerSha256 === sha(NPP.b1),
      'Acme\'s owner adds Notepad++ to Acme\'s catalog with a pasted hash, recorded as pasted', msg(r));

    r = await req('POST', '/software/catalog', { s: S.bobF, body: { scope: 'business', businessId: globex.id, packageId: GLOBEX.id, name: 'Globex Tool', version: GLOBEX.version, hash: { source: 'admin_pasted', installerSha256: sha(GLOBEX.bytes) }, detection: GLOBEX_RULE } });
    gtool = r.body?.data;
    if (gtool?.id) created.entries.push(gtool.id);
    check(r.status === 201 && gtool.businessId === globex.id, 'Globex\'s owner adds Globex Tool (file-version rule) to Globex\'s catalog', msg(r));

    const owenList = await req('GET', '/software/catalog', { s: S.owen });
    const ids = (owenList.body?.data?.entries ?? []).map((e) => e.id);
    check(ids.includes(seven.id) && ids.includes(npp.id) && !ids.includes(gtool.id) && owenList.body.data.you.canCreateBusiness === true && owenList.body.data.you.canCreateGlobal === false,
      'Acme sees the global entry and its own, not Globex\'s', msg(owenList));
    const bobList = await req('GET', '/software/catalog', { s: S.bob });
    const bids = (bobList.body?.data?.entries ?? []).map((e) => e.id);
    check(bids.includes(seven.id) && bids.includes(gtool.id) && !bids.includes(npp.id), 'Globex sees the global entry and its own, not Acme\'s');
    r = await req('GET', `/software/catalog/${npp.id}`, { s: S.bob });
    check(r.status === 404, 'Acme\'s entry by id, as Globex\'s owner → 404', msg(r));
    r = await req('POST', `/software/catalog/${npp.id}`, { s: S.bobF, body: { name: 'x', version: NPP.v2, hash: { source: 'admin_pasted', installerSha256: sha('x') }, detection: NPP_RULE, expectedRevision: 1 } });
    check(r.status === 404, 'changing Acme\'s entry as Globex\'s owner → 404 (it does not exist for them)', msg(r));
    r = await req('POST', `/software/catalog/${seven.id}`, { s: S.owenF, body: { name: '7-Zip', version: SEVEN.version, hash: { source: 'admin_pasted', installerSha256: sha('evil') }, detection: SEVEN_RULE, expectedRevision: 1 } });
    check(r.status === 403, 'a Business Owner cannot change a global entry', msg(r));
    r = await req('GET', '/software/catalog', { s: S.sam, business: acme.id });
    check(r.status === 200 && r.body.data.entries.every((e) => e.canEdit === false) && r.body.data.you.canCreateBusiness === false, 'the technician reads the catalog, can change none of it');

    const audits = await prisma.activityLog.findMany({ where: { resourceId: { in: [seven.id, npp.id, gtool.id] }, action: 'SOFTWARE_CATALOG_CREATED' } });
    const a7 = audits.find((a) => a.resourceId === seven.id);
    check(audits.length === 3 && a7?.metadata?.installerSha256 === sha(SEVEN.bytes) && a7.metadata.manifestSha256 === sha(sevenManifest) && a7.actorId === admin.id,
      'each addition is audited with who, the pinned hash and where it came from', JSON.stringify(a7?.metadata ?? null).slice(0, 200));
  }

  // One computer: a one-ring deployment, then the usual two approvals.
  async function single(s, ep, entryId, op = 'install', business) {
    const r = await req('POST', `/endpoints/${ep.id}/software/${entryId}/${op}`, { s, business, body: { reason: `Ticket ${op} ${ep.hostname}` } });
    if (r.status !== 201) return { r };
    const job = r.body.data.job;
    await approve(job.id, pk.olivia);
    const mid = (await req('GET', `/actions/${job.id}`, { s, business })).body?.data?.status;
    await approve(job.id, pk.quinn);
    const status = (await req('GET', `/actions/${job.id}`, { s, business })).body?.data?.status;
    return { r, job, deployment: r.body.data.deployment, mid, status };
  }
  const deliver = async (ep, jobId) => ((await heartbeat(ep)).body?.data?.actions ?? []).find((d) => d.jobId === jobId)?.envelope;
  const report = async (ep) => { const h = await heartbeat(ep, { actionResults: resultsOf(ep) }); clearAcked(ep, h.body?.data?.actionAcks); return h; };
  const swTab = async (s, ep, business) => (await req('GET', `/endpoints/${ep.id}/software/catalog`, { s, business })).body?.data;
  const target = (jobId) => prisma.actionTarget.findFirst({ where: { jobId } });
  const DL = (ep, jobId, id, v) => ['download', '--id', id, '--version', v, '--exact', '--source', 'winget', '--scope', 'machine', '--skip-dependencies', '--download-directory', path.join(ep.state, 'actions', 'software', jobId), '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'];
  const INSTALL = (id, v) => ['install', '--id', id, '--version', v, '--exact', '--source', 'winget', '--silent', '--scope', 'machine', '--skip-dependencies', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'];
  const UNINSTALL = (id) => ['uninstall', '--id', id, '--exact', '--source', 'winget', '--silent', '--scope', 'machine', '--accept-source-agreements', '--disable-interactivity'];

  section('Where it cannot run, the computer says so before anyone is asked');
  {
    const tab = async (ep) => (await swTab(S.sam, ep, acme.id))?.install;
    const t1 = await tab(oldpc);
    check(t1?.possible === false && /does not report support/.test(t1.reason) && /0\.34/.test(t1.fix ?? ''), 'a 0.33 agent: not possible, "update it to a signed agent build from 0.34"', JSON.stringify(t1));
    const t2 = await tab(macpc);
    check(t2?.possible === false && /macOS/.test(t2.reason), 'a macOS computer: not possible — the macOS agent only reports', JSON.stringify(t2));
    const t3 = await tab(cmpc);
    check(t3?.possible === false && /Configuration Manager/.test(t3.reason), 'ConfigMgr in the patch posture: "software on this computer is managed by Configuration Manager"', JSON.stringify(t3));
    for (const [n, ep] of [['the 0.33 agent', oldpc], ['the macOS computer', macpc], ['the ConfigMgr computer', cmpc]]) {
      const r = await req('POST', `/endpoints/${ep.id}/software/${seven.id}/install`, { s: S.sam, business: acme.id, body: { reason: 'try anyway' } });
      check(r.status === 409 && code(r) === 'SOFTWARE_NOT_POSSIBLE', `requesting it on ${n} anyway → 409 SOFTWARE_NOT_POSSIBLE`, msg(r));
    }
    const d = await swTab(S.dana, canary, acme.id);
    check(d?.install?.possible === false && /higher-risk/.test(d.install.fix ?? ''), 'an L2 technician (low-risk fixes only) sees Install as not possible for them', JSON.stringify(d?.install));
    let r = await req('POST', `/endpoints/${canary.id}/software/${seven.id}/install`, { s: S.dana, business: acme.id, body: { reason: 'please' } });
    check(r.status === 409 && code(r) === 'SOFTWARE_NOT_POSSIBLE', '…and requesting it → 409', msg(r));
    r = await req('POST', `/endpoints/${gpc.id}/software/${seven.id}/install`, { s: S.sam, business: acme.id, body: { reason: 'other business' } });
    check(r.status === 404, 'a Globex computer, as Acme\'s technician → 404', msg(r));
    r = await req('POST', `/endpoints/${canary.id}/software/${gtool.id}/install`, { s: S.sam, business: acme.id, body: { reason: 'other business entry' } });
    check(r.status === 404, 'Globex\'s catalog entry on an Acme computer → 404', msg(r));
    r = await req('GET', `/endpoints/${canary.id}/software/catalog`, { s: S.bob });
    check(r.status === 404, 'an Acme computer\'s software, as Globex\'s owner → 404', msg(r));
    r = await req('POST', `/endpoints/${canary.id}/software/${seven.id}/reinstall`, { s: S.sam, business: acme.id, body: { reason: 'x' } });
    check(r.status === 404, 'an operation other than install / uninstall → 404', msg(r));
    check(!(await prisma.actionJob.count({ where: { customerId: acme.id } })), 'none of that created a plan');
  }

  section('Install on one computer: two approvers, download, hash, install, detect');
  let firstJob;
  {
    const tab = await swTab(S.sam, canary, acme.id);
    const row = tab?.entries?.find((e) => e.id === seven.id);
    check(tab?.install?.possible === true && row?.compliance === 'unknown' && !tab.entries.some((e) => e.id === gtool.id), 'CANARY\'s Software tab: Install possible, 7-Zip unknown (no evidence yet), no Globex entry', JSON.stringify(tab).slice(0, 300));
    const x = await single(S.sam, canary, seven.id, 'install', acme.id);
    firstJob = x.job;
    check(x.r.status === 201 && x.job.risk === 'high' && x.job.approvalsRequired === 2 && x.deployment?.single === true, 'Sam (L3) installs 7-Zip on CANARY: a one-computer deployment, high risk, two approvals', msg(x.r));
    check(x.mid === 'AWAITING_APPROVAL' && x.status === 'APPROVED', 'one approval is not enough; the second, different approver signs it');
    const job = await prisma.actionJob.findUnique({ where: { id: x.job.id } });
    check(same(Object.keys(job.params).sort(), ['detection', 'installerSha256', 'packageId', 'scope', 'version']) && job.params.installerSha256 === sha(SEVEN.bytes) && job.params.scope === 'machine' && job.softwareDeploymentId === x.deployment.id,
      'the signed params are exactly the five closed keys, with the pinned hash', JSON.stringify(job.params));
    const page = await (await fetch(x.job.approvalUrl)).text();
    check(page.includes('7zip.7zip') && page.includes(sha(SEVEN.bytes)) && /read from the winget-pkgs manifest/.test(page) && page.includes(sha(sevenManifest).slice(0, 16)) && /Igor Pavlov/.test(page),
      'the approval page shows the package, version, pinned SHA-256, that it came from the manifest, and the manifest digest');
    const env = await deliver(canary, x.job.id);
    check(env?.schema === 'rem0te-action-envelope/1', 'the approved plan is delivered at the next heartbeat');
    const res = runAgent(canary, x.job.id, env);
    const st = wingetNow(canary);
    const o = res.observed ?? {};
    check(res.outcome === 'succeeded' && o.detectedBefore === 'absent' && o.detectedAfter === 'installed' && o.versionAfter === '24.08' && o.effective === 'true' && o.installerSha256 === sha(SEVEN.bytes) && o.wingetVersion,
      'the agent: absent before, installed 24.08 after, effective, and reports the hash it computed itself', JSON.stringify(res));
    check(same(st.calls, [['--version'], ['--version'], DL(canary, x.job.id, SEVEN.id, SEVEN.version), INSTALL(SEVEN.id, SEVEN.version)]),
      'winget received exactly: --version, download (SYSTEM-only directory, no dependencies), install --exact --silent --scope machine — each an argument array', JSON.stringify(st.calls));
    check(!JSON.stringify(st.calls).match(/--ignore-security-hash|--force|--override|--custom|--location|--manifest|--header/), 'no override, force, custom, location, manifest or header flag is ever passed');
    check(!existsSync(path.join(canary.state, 'actions', 'software', x.job.id)), 'the download directory is removed afterwards');
    const j = JSON.parse(readFileSync(path.join(canary.state, 'actions', 'journal', `${x.job.id}.json`), 'utf8'));
    check(j.state === 'done' && j.result?.outcome === 'succeeded', 'the journal records the job as done, with its result');
    clearCalls(canary);
    const again = runAgent(canary, x.job.id, env);
    check(again.outcome === 'succeeded' && !(wingetNow(canary).calls ?? []).length, 'a re-delivered envelope is answered from the journal: winget is not run again', JSON.stringify(again));
    await report(canary);
    const g = await req('GET', `/actions/${x.job.id}`, { s: S.sam, business: acme.id });
    check(g.body?.data?.status === 'SUCCEEDED' && g.body.data.result?.observed?.effective === 'true', 'recorded SUCCEEDED with what the agent saw', msg(g));
    const d = await req('GET', `/software/deployments/${x.deployment.id}`, { s: S.sam, business: acme.id });
    check(d.body?.data?.status === 'COMPLETED' && d.body.data.rings[0].gate.ok === true && d.body.data.entryState === 'current', 'the one-computer deployment is completed; its gate passed on the agent\'s own detection', msg(d));
    const after = await swTab(S.sam, canary, acme.id);
    const row2 = after.entries.find((e) => e.id === seven.id);
    check(row2?.compliance === 'compliant' && row2.evidence?.source === 'agent' && row2.last?.status === 'SUCCEEDED', 'CANARY\'s Software tab: 7-Zip compliant, from the agent\'s detection', JSON.stringify(row2));
    const audits = new Set((await prisma.activityLog.findMany({ where: { resourceId: { in: [x.job.id, x.deployment.id] } }, select: { action: true } })).map((a) => a.action));
    check(['SOFTWARE_DEPLOYMENT_CREATED', 'SOFTWARE_RING_REQUESTED', 'ACTION_REQUESTED', 'ACTION_DISPATCHED', 'ACTION_RESULT'].every((a) => audits.has(a)), 'the deployment, the ring request, dispatch and result are audited', [...audits].join(','));
  }

  section('Already installed: nothing runs');
  {
    clearCalls(canary);
    const x = await single(S.sam, canary, seven.id, 'install', acme.id);
    const res = runAgent(canary, x.job.id, await deliver(canary, x.job.id));
    check(res.outcome === 'no_change' && res.observed?.detectedBefore === 'installed' && same(wingetNow(canary).calls, [['--version']]), 'installing what is already there → no_change; only "winget --version" ran', JSON.stringify({ res, calls: wingetNow(canary).calls }));
    await report(canary);
    const d = await req('GET', `/software/deployments/${x.deployment.id}`, { s: S.sam, business: acme.id });
    check(d.body?.data?.status === 'COMPLETED' && d.body.data.rings[0].gate.reason === 'canary_proved_nothing', 'the deployment completes, and says the computer already had it', msg(d));
  }

  section('A changed entry stops further rings; a mismatched installer is refused');
  {
    let r = await req('POST', '/software/deployments', { s: S.sam, business: acme.id, body: { entryId: npp.id, operation: 'install', rings: [[r1a.id], [r2a.id]], soakHours: 0 } });
    const dep = r.body?.data;
    check(r.status === 201 && dep?.entryRevision === 1 && dep.rings.length === 2, 'a Notepad++ deployment is made from revision 1', msg(r));
    r = await req('POST', `/software/catalog/${npp.id}`, { s: S.owenF, body: { name: 'Notepad++', publisher: 'Notepad++ Team', version: NPP.v2, hash: { source: 'admin_pasted', installerSha256: sha(NPP.b2) }, detection: NPP_RULE, expectedRevision: 2 } });
    check(r.status === 409 && code(r) === 'ENTRY_CHANGED', 'a change naming the wrong revision → 409 ENTRY_CHANGED', msg(r));
    r = await req('POST', `/software/catalog/${npp.id}`, { s: S.owen, body: { name: 'Notepad++', publisher: 'Notepad++ Team', version: NPP.v2, hash: { source: 'admin_pasted', installerSha256: sha(NPP.b2) }, detection: NPP_RULE, expectedRevision: 1 } });
    check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED', 'a change without a fresh sign-in → STEP_UP_REQUIRED', msg(r));
    r = await req('POST', `/software/catalog/${npp.id}`, { s: S.owenF, body: { name: 'Notepad++', publisher: 'Notepad++ Team', version: NPP.v2, hash: { source: 'admin_pasted', installerSha256: sha(NPP.b2) }, detection: NPP_RULE, expectedRevision: 1 } });
    check(r.status === 200 && r.body.data.revision === 2 && r.body.data.version === NPP.v2, 'Acme\'s owner moves Notepad++ to 8.7.2: revision 2', msg(r));
    const au = await prisma.activityLog.findFirst({ where: { resourceId: npp.id, action: 'SOFTWARE_CATALOG_UPDATED' } });
    check(au?.metadata?.before?.installerSha256 === sha(NPP.b1) && au.metadata.after.installerSha256 === sha(NPP.b2), 'the change is audited with the hash before and after');
    r = await req('POST', `/software/deployments/${dep.id}/rings/0/request`, { s: S.sam, business: acme.id, body: { reason: 'go ahead' } });
    check(r.status === 409 && code(r) === 'ENTRY_CHANGED', 'the deployment made from revision 1 can no longer request a ring → 409 ENTRY_CHANGED', msg(r));
    const d = await req('GET', `/software/deployments/${dep.id}`, { s: S.sam, business: acme.id });
    check(d.body?.data?.entryState === 'changed', 'its page says the entry has changed');
    await req('POST', `/software/deployments/${dep.id}/cancel`, { s: S.sam, business: acme.id, body: { reason: 'entry changed' } });

    // R1A's source offers a different installer under 8.7.2 than the one pinned.
    setWinget(r1a, { version: WINGET, packages: { [`${NPP.id}@${NPP.v2}`]: { installer: 'Notepad++ 8.7.2 TAMPERED (synthetic)', uninstallKey: 'Notepad++', displayName: 'Notepad++ (64-bit x64)', displayVersion: '8.7.2' } } });
    const x = await single(S.sam, r1a, npp.id, 'install', acme.id);
    const page = await (await fetch(x.job.approvalUrl)).text();
    check(/typed in by the catalog&#39;s editor|typed in by the catalog's editor/.test(page) && page.includes(sha(NPP.b2)), 'the approval page says the hash was typed in, not read from a manifest');
    const res = runAgent(r1a, x.job.id, await deliver(r1a, x.job.id));
    const st = wingetNow(r1a);
    check(res.outcome === 'refused' && res.reason === 'hash_mismatch' && res.observed?.installerSha256 === sha('Notepad++ 8.7.2 TAMPERED (synthetic)') && res.observed?.detectedBefore === 'absent',
      'the downloaded installer is not the pinned one → refused hash_mismatch, with the hash it found', JSON.stringify(res));
    check(!st.calls.some((c) => c[0] === 'install') && !(st.installed ?? []).length, 'install was never run; nothing is installed');
    await report(r1a);
    const row = await target(x.job.id);
    check(row.status === 'REFUSED_BY_ENDPOINT' && row.statusReason === 'hash_mismatch', 'recorded as refused by the computer: hash_mismatch', JSON.stringify({ s: row.status, r: row.statusReason }));

    // The installer is right but the manifest winget downloaded declares another hash.
    setWinget(r1a, { version: WINGET, packages: { [`${NPP.id}@${NPP.v2}`]: { installer: NPP.b2, manifestSha256: sha('another installer'), uninstallKey: 'Notepad++', displayVersion: '8.7.2' } } });
    const y = await single(S.sam, r1a, npp.id, 'install', acme.id);
    const res2 = runAgent(r1a, y.job.id, await deliver(r1a, y.job.id));
    check(res2.outcome === 'refused' && res2.reason === 'manifest_hash_mismatch' && !wingetNow(r1a).calls.some((c) => c[0] === 'install'), 'a manifest that does not list the pinned hash → refused manifest_hash_mismatch, nothing installed', JSON.stringify(res2));
    await report(r1a);
  }

  section('Bulk: canary first, a gate on the agent\'s own detection, rings never direct');
  {
    let r = await req('POST', '/software/deployments', { s: S.sam, business: acme.id, body: { entryId: seven.id, operation: 'install', rings: [[r1b.id, r2a.id], [r2b.id]] } });
    check(r.status === 400 && code(r) === 'BAD_RINGS', 'a canary of two computers → 400 BAD_RINGS', msg(r));
    const many = Array.from({ length: 26 }, (_, i) => `c${String(i).padStart(9, '0')}`);
    r = await req('POST', '/software/deployments', { s: S.sam, business: acme.id, body: { entryId: seven.id, operation: 'install', rings: [[r1b.id], many] } });
    check(r.status === 400, 'a ring of 26 computers → 400 (25 at most)', msg(r));
    r = await req('POST', '/software/deployments', { s: S.sam, business: acme.id, body: { entryId: seven.id, operation: 'install', rings: [[r1b.id], [gpc.id]] } });
    check(r.status === 404, 'a ring naming a Globex computer → 404', msg(r));
    r = await req('POST', '/software/deployments', { s: S.sam, business: acme.id, body: { entryId: seven.id, operation: 'install', rings: [[r1b.id], [r2a.id, cmpc.id]] } });
    check(r.status === 409 && code(r) === 'SOFTWARE_NOT_POSSIBLE' && /^CMPC: .*Configuration Manager/.test(r.body?.message ?? ''), 'a ring including the ConfigMgr computer → 409, naming it', msg(r));
    r = await req('POST', '/software/deployments', { s: S.sam, business: acme.id, body: { entryId: seven.id, operation: 'install', rings: [[r1b.id], [r2a.id, r2b.id]], soakHours: 1, failureThreshold: 0, windowHours: 4 } });
    const dep = r.body?.data;
    check(r.status === 201 && dep?.status === 'ACTIVE' && dep.next.ring === 0 && dep.next.canRequest === true && !(await prisma.actionJob.count({ where: { softwareDeploymentId: dep?.id } })),
      'a deployment of 7-Zip: canary R1B, then R2A + R2B; nothing is requested by making it', msg(r));
    r = await req('POST', `/software/deployments/${dep.id}/rings/1/request`, { s: S.sam, business: acme.id, body: { reason: 'skip the canary' } });
    check(r.status === 409 && code(r) === 'RING_GATE', 'ring 1 before the canary → 409 RING_GATE', msg(r));
    r = await req('GET', `/software/deployments/${dep.id}`, { s: S.bob });
    check(r.status === 404, 'the deployment, as Globex\'s owner → 404', msg(r));

    // The canary's installer reports success and changes nothing.
    r = await req('POST', `/software/deployments/${dep.id}/rings/0/request`, { s: S.sam, business: acme.id, body: { reason: 'canary' } });
    let job = r.body?.data?.job;
    const firstCanary = job;
    check(r.status === 201 && job.risk === 'high' && job.approvalsRequired === 2, 'the canary is requested: its own signed plan, two approvals', msg(r));
    await approve(job.id, pk.olivia); await approve(job.id, pk.quinn);
    const page = await (await fetch(job.approvalUrl)).text();
    check(/canary \(ring 0\)/.test(page), 'the approval page names it the canary of this deployment');
    let res = runAgent(r1b, job.id, await deliver(r1b, job.id));
    check(res.outcome === 'failed' && res.reason === 'not_effective' && res.observed?.detectedAfter === 'absent' && res.observed?.effective === 'false', 'winget said it worked, the detection rule says it is not there → failed not_effective', JSON.stringify(res));
    await report(r1b);
    let d = (await req('GET', `/software/deployments/${dep.id}`, { s: S.sam, business: acme.id })).body?.data;
    check(d?.status === 'PAUSED' && /failed/.test(d.pausedReason ?? '') && d.next.canRequest === false, 'the canary failing pauses the deployment', JSON.stringify(d?.rings?.[0]?.gate));
    r = await req('POST', `/software/deployments/${dep.id}/rings/1/request`, { s: S.sam, business: acme.id, body: { reason: 'anyway' } });
    check(r.status === 409 && code(r) === 'RING_GATE', 'ring 1 while paused → 409 RING_GATE', msg(r));
    r = await req('POST', `/software/deployments/${dep.id}/resume`, { s: S.pat, body: { reason: 'resume it' } });
    check(r.status === 403, 'a Business User who did not make it cannot resume it', msg(r));
    r = await req('POST', `/software/deployments/${dep.id}/resume`, { s: S.sam, business: acme.id, body: { reason: 'fixed the package source on R1B' } });
    check(r.status === 200 && r.body.data.status === 'ACTIVE' && r.body.data.next.ring === 0 && r.body.data.next.canRequest === true, 'resumed by its creator: the canary is retried, never promoted past', msg(r));

    setWinget(r1b, { version: WINGET, packages: offer7 });
    r = await req('POST', `/software/deployments/${dep.id}/rings/0/request`, { s: S.sam, business: acme.id, body: { reason: 'canary again' } });
    job = r.body?.data?.job;
    await approve(job.id, pk.olivia); await approve(job.id, pk.quinn);
    res = runAgent(r1b, job.id, await deliver(r1b, job.id));
    check(res.outcome === 'succeeded' && res.observed?.effective === 'true', 'the canary again: installed and detected', JSON.stringify(res));
    await report(r1b);
    d = (await req('GET', `/software/deployments/${dep.id}`, { s: S.sam, business: acme.id })).body?.data;
    check(d?.rings[0].gate.reason === 'soaking' && d.next.ring === 1 && d.next.canRequest === false, 'the canary passed and soaks for an hour; ring 1 waits', JSON.stringify(d?.rings?.[0]?.gate));
    // Backdate the canary's results in order (the failed run first), as two hours passing would.
    await prisma.actionTarget.updateMany({ where: { jobId: firstCanary.id }, data: { resultAt: new Date(Date.now() - 3 * 3600_000) } });
    await prisma.actionTarget.updateMany({ where: { jobId: job.id }, data: { resultAt: new Date(Date.now() - 2 * 3600_000) } });
    d = (await req('GET', `/software/deployments/${dep.id}`, { s: S.sam, business: acme.id })).body?.data;
    check(d?.rings[0].gate.ok === true && d.next.ring === 1 && d.next.canRequest === true, 'after the soak (result backdated two hours) ring 1 may be requested', JSON.stringify(d?.next));
    r = await req('POST', `/software/deployments/${dep.id}/rings/1/request`, { s: S.sam, business: acme.id, body: { reason: 'ring 1' } });
    job = r.body?.data?.job;
    check(r.status === 201 && job.targets?.length === 2, 'ring 1: one signed plan naming both computers', msg(r));
    await approve(job.id, pk.olivia); await approve(job.id, pk.quinn);
    for (const ep of [r2a, r2b]) {
      const out = runAgent(ep, job.id, await deliver(ep, job.id));
      check(out.outcome === 'succeeded' && out.observed?.detectedAfter === 'installed', `${ep.hostname}: installed and detected`, JSON.stringify(out));
      await report(ep);
    }
    d = (await req('GET', `/software/deployments/${dep.id}`, { s: S.sam, business: acme.id })).body?.data;
    check(d?.status === 'COMPLETED' || d?.rings[1].gate.reason === 'soaking', 'every ring has run: the deployment completes', JSON.stringify({ s: d?.status, g: d?.rings?.[1]?.gate }));
  }

  section('No winget; a hung winget; something else manages the software');
  {
    let x = await single(S.sam, nowg, seven.id, 'install', acme.id);
    let res = runAgent(nowg, x.job.id, await deliver(nowg, x.job.id));
    check(res.outcome === 'not_executed' && res.reason === 'winget_unavailable', 'no App Installer for all users → not executed, winget_unavailable (said, not guessed around)', JSON.stringify(res));
    await report(nowg);
    const t = await swTab(S.sam, nowg, acme.id);
    check(t?.install?.possible === true && /winget not available/.test(t.install.warning ?? ''), 'its Software tab now warns that winget was not available last time', JSON.stringify(t?.install));

    x = await single(S.sam, slow, seven.id, 'install', acme.id);
    res = runAgent(slow, x.job.id, await deliver(slow, x.job.id), { timeout: '1500ms' });
    check(res.outcome === 'uncertain' && res.reason === 'timeout' && res.observed?.detectedNow === 'absent', 'winget never finishes: killed at the timeout → uncertain, with what detection sees now', JSON.stringify(res));
    await report(slow);
    const row = await target(x.job.id);
    check(row.status === 'UNKNOWN', 'recorded UNKNOWN', row.status);
    const t2 = await swTab(S.sam, slow, acme.id);
    check(t2?.install?.possible === false && /uncertain/.test(t2.install.reason), 'no further software plan on it until someone reconciles', JSON.stringify(t2?.install));
    const dd = (await req('GET', `/software/deployments/${x.deployment.id}`, { s: S.sam, business: acme.id })).body?.data;
    check(dd?.status === 'ACTIVE' && dd.rings[0].gate.reason === 'unreconciled', 'its deployment waits on reconciliation', JSON.stringify(dd?.rings?.[0]?.gate));
    const rc = await req('POST', `/actions/${x.job.id}/reconcile`, { s: S.sam, business: acme.id, body: { found: 'not_installed', note: 'Checked Programs and Features: no 7-Zip' } });
    check(rc.status === 200 || rc.status === 201, 'Sam reconciles it: not installed', msg(rc));
    const t3 = await swTab(S.sam, slow, acme.id);
    check(t3?.install?.possible === true, 'and Install is possible again', JSON.stringify(t3?.install));

    x = await single(S.sam, intune, seven.id, 'install', acme.id);
    res = runAgent(intune, x.job.id, await deliver(intune, x.job.id));
    check(res.outcome === 'refused' && res.reason === 'managed_elsewhere' && res.observed?.managers === 'intune' && !wingetNow(intune).calls?.length, 'the Intune Management Extension on the computer → refused managed_elsewhere; winget was not even asked', JSON.stringify(res));
    await report(intune);
    const t4 = await swTab(S.sam, intune, acme.id);
    check(t4?.install?.possible === false && /intune/.test(t4.install.reason), 'from then on its Software tab says another tool manages it', JSON.stringify(t4?.install));
  }

  section('Uninstall: a second signed action, confirmed gone by the detection rule');
  {
    clearCalls(canary);
    const x = await single(S.sam, canary, seven.id, 'uninstall', acme.id);
    check(x.r.status === 201 && x.job.approvalsRequired === 2 && x.status === 'APPROVED', 'uninstalling is its own plan with two approvals', msg(x.r));
    const res = runAgent(canary, x.job.id, await deliver(canary, x.job.id));
    check(res.outcome === 'succeeded' && res.observed?.detectedBefore === 'installed' && res.observed?.detectedAfter === 'absent', 'removed, and the rule no longer finds it', JSON.stringify(res));
    check(same(wingetNow(canary).calls, [['--version'], ['--version'], UNINSTALL(SEVEN.id)]), 'winget received: uninstall --id --exact --silent --scope machine (no version: whatever is installed)', JSON.stringify(wingetNow(canary).calls));
    await report(canary);
    const y = await single(S.sam, canary, seven.id, 'uninstall', acme.id);
    const res2 = runAgent(canary, y.job.id, await deliver(canary, y.job.id));
    check(res2.outcome === 'no_change', 'uninstalling what is not there → no_change', JSON.stringify(res2));
    await report(canary);
  }

  section('Globex, alone: the file-version rule');
  {
    const x = await single(S.bob, gpc, gtool.id, 'install');
    check(x.r.status === 201 && x.status === 'APPROVED', 'Globex\'s owner installs Globex Tool on its computer', msg(x.r));
    const res = runAgent(gpc, x.job.id, await deliver(gpc, x.job.id));
    check(res.outcome === 'succeeded' && res.observed?.detectedAfter === 'installed' && res.observed?.versionAfter === '2.0.0.0', 'detected by the file version under Program Files', JSON.stringify(res));
    await report(gpc);
    const r = await req('GET', `/actions/${x.job.id}`, { s: S.owen });
    check(r.status === 404, 'Acme\'s owner cannot read Globex\'s plan', msg(r));
  }

  section('Containment: held by the portal, refused by the agent');
  {
    setWinget(r2a, { ...wingetNow(r2a), packages: { ...offer7, [`${NPP.id}@${NPP.v2}`]: { installer: NPP.b2, uninstallKey: 'Notepad++', displayVersion: '8.7.2' } }, calls: [] });
    const x = await single(S.sam, r2a, npp.id, 'install', acme.id);
    const pause = await prisma.containmentPause.create({ data: { scope: 'BUSINESS', customerId: acme.id, kinds: ['actions'], reason: 'software e2e', setById: admin.id, setBy: 'msp' } });
    check(!(await deliver(r2a, x.job.id)), 'while actions are paused for the business the approved install is not delivered');
    const t = await swTab(S.sam, r2a, acme.id);
    check(t?.install?.possible === false, 'and no new software plan is possible', JSON.stringify(t?.install));
    await prisma.containmentPause.update({ where: { id: pause.id }, data: { clearedAt: new Date(), clearedById: admin.id, clearReason: 'test' } });
    const env = await deliver(r2a, x.job.id);
    check(!!env, 'delivered once the pause is lifted');
    const pf = path.join(work, 'pause.json');
    writeFileSync(pf, JSON.stringify({ schema: 'rem0te-pause/1', issuedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), reason: 'incident 12', actions: { all: false, businesses: [acme.id] }, updates: { all: false } }));
    const res = runAgent(r2a, x.job.id, env, { pause: pf });
    check(res.outcome === 'refused' && res.reason === 'paused' && !wingetNow(r2a).calls?.length, 'a signed pause covering the business: refused "paused" before winget is asked anything', JSON.stringify(res));
    await report(r2a);
  }

  section('Version compliance report: per entry, from stored evidence, per business');
  {
    const r = await req('GET', '/reports/software-compliance', { s: S.owen });
    const data = r.body?.data;
    const e7 = data?.entries?.find((e) => e.entry.id === seven.id), en = data?.entries?.find((e) => e.entry.id === npp.id);
    // 7-Zip over Acme's ten Windows computers:
    //   compliant  R1B, R2A, R2B (agent), OLDPC (inventory)      4
    //   outdated   CMPC (inventory 23.01)                         1
    //   missing    CANARY (uninstalled), SLOWPC (agent, now), INTUNE (inventory)  3
    //   unknown    R1A (nothing), NOWG (inventory 20 days old)    2
    check(r.status === 200 && e7 && e7.total === 10 && e7.compliant === 4 && e7.outdated === 1 && e7.missing === 3 && e7.unknown === 2 && e7.unknownStale === 1,
      '7-Zip over Acme\'s ten Windows computers: 4 compliant, 1 outdated, 3 missing, 2 unknown (one of them stale)', JSON.stringify(e7));
    // Notepad++ (a registry-key rule the inventory cannot answer): R1A said absent twice; the rest unknown.
    check(en && en.total === 10 && en.missing === 1 && en.unknown === 9 && en.compliant === 0, 'Notepad++ (registry-key rule): 1 missing (R1A\'s own detection), 9 unknown — never guessed from the inventory', JSON.stringify(en));
    check(data.notWindows === 1 && !data.entries.some((e) => e.entry.id === gtool.id), 'the macOS computer is counted apart; Globex\'s entry is not in Acme\'s report');
    check(!JSON.stringify(data.devices).includes('GLOBEXPC') && data.devices.find((x) => x.device.name === 'CMPC' && x.entry.id === seven.id)?.state === 'outdated', 'the attention list names Acme\'s computers only, CMPC outdated', JSON.stringify(data.devices?.slice(0, 3)));
    const b = (await req('GET', '/reports/software-compliance', { s: S.bob })).body?.data;
    const b7 = b?.entries?.find((e) => e.entry.id === seven.id), bg = b?.entries?.find((e) => e.entry.id === gtool.id);
    check(b7?.total === 1 && b7.unknown === 1 && bg?.total === 1 && bg.compliant === 1 && !b.entries.some((e) => e.entry.id === npp.id),
      'Globex\'s owner: 7-Zip over its one computer (unknown), Globex Tool compliant, no Acme entry', JSON.stringify(b?.entries));
    const a = (await req('GET', `/reports/software-compliance?businessId=${acme.id}`, { s: S.admin })).body?.data;
    check(a?.entries?.find((e) => e.entry.id === seven.id)?.total === 10, 'a Platform Admin scoped to Acme sees the same ten');
    const csv = await req('GET', '/reports/software-compliance/export.csv', { s: S.owen, raw: true });
    const lines = String(csv.body).trim().split(/\r?\n/);
    check(csv.status === 200 && /text\/csv/.test(csv.type) && lines.filter((l) => l.includes('7zip.7zip')).length === 10 && lines.filter((l) => l.includes('Notepad++.Notepad++')).length === 10 && !/GLOBEX|Globex/.test(String(csv.body)),
      'the CSV export: ten rows per entry, nothing from Globex', String(csv.body).slice(0, 300));
    const ex = await prisma.activityLog.findFirst({ where: { action: 'REPORT_EXPORTED', actorId: owen.id }, orderBy: { createdAt: 'desc' } });
    check(ex && JSON.stringify(ex.metadata).includes('software-compliance'), 'the export is audited', JSON.stringify(ex?.metadata ?? null));
  }

  section('Archiving: audited, fresh, and nothing further is requested from it');
  {
    const r = await req('POST', `/software/catalog/${npp.id}/archive`, { s: S.owenF, body: { reason: 'replaced by a business-wide policy', expectedRevision: 2 } });
    check(r.status === 200 && r.body.data.archivedAt, 'Acme\'s owner archives Notepad++', msg(r));
    const x = await req('POST', `/endpoints/${r2b.id}/software/${npp.id}/install`, { s: S.sam, business: acme.id, body: { reason: 'archived?' } });
    check(x.status === 409 && code(x) === 'ENTRY_ARCHIVED', 'an archived entry cannot be deployed → 409 ENTRY_ARCHIVED', msg(x));
    check(!!(await prisma.activityLog.findFirst({ where: { resourceId: npp.id, action: 'SOFTWARE_CATALOG_ARCHIVED' } })), 'the archive is audited');
  }

  section('No upload route, no approve route');
  {
    for (const [m, p] of [['POST', '/software/upload'], ['POST', `/software/catalog/${seven.id}/installer`], ['POST', `/software/deployments/x/approve`], ['PUT', `/software/catalog/${seven.id}`]]) {
      const r = await req(m, p, { s: S.adminF, body: {} });
      check(r.status === 404, `${m} ${p} → 404`, msg(r));
    }
  }
}

async function cleanup() {
  await stop('api'); await stop('signer');
  await new Promise((r) => manifestServer.close(() => r())).catch(() => undefined);
  try {
    if (created.businesses.length) {
      await prisma.containmentPause.deleteMany({ where: { customerId: { in: created.businesses } } });
      await prisma.actionJob.deleteMany({ where: { customerId: { in: created.businesses } } });
      await prisma.softwareDeployment.deleteMany({ where: { customerId: { in: created.businesses } } });
    }
    if (created.entries.length) await prisma.softwareCatalogEntry.deleteMany({ where: { id: { in: created.entries } } });
    if (created.businesses.length) {
      await prisma.technicianAssignment.deleteMany({ where: { customerId: { in: created.businesses } } });
      const eps = await prisma.endpoint.findMany({ where: { customerId: { in: created.businesses } }, select: { id: true } });
      await prisma.rustdeskNode.deleteMany({ where: { endpointId: { in: eps.map((e) => e.id) } } });
      await prisma.endpoint.deleteMany({ where: { id: { in: eps.map((e) => e.id) } } });
      await prisma.membership.deleteMany({ where: { customerId: { in: created.businesses } } });
      await prisma.customer.deleteMany({ where: { id: { in: created.businesses } } });
    }
    if (created.users.length) await prisma.user.deleteMany({ where: { id: { in: created.users } } });
  } catch (e) { console.error('cleanup:', e.message); }
  await prisma.$disconnect();
  rmSync(work, { recursive: true, force: true });
}

all().catch((e) => { fail++; failures.push(`crashed: ${e.stack ?? e}`); console.error(e); if (kids.api) console.error(kids.api.log.slice(-2500)); if (kids.signer) console.error(kids.signer.log.slice(-1500)); })
  .finally(async () => {
    await cleanup();
    console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
    if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
  });
