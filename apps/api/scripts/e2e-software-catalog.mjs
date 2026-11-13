#!/usr/bin/env node
/**
 * End-to-end proof of the 0.41 software catalog: the searchable winget
 * index, one-click install from a search, and Uninstall for anything in a
 * computer's installed-software inventory (windows.software.remove@1).
 *
 * Self-contained, like e2e-software-deploy.mjs: a signed update repository
 * from the offline release tool, the approval signer as its own process
 * (Acme in direct mode, set with the signer's CLI; Globex signed, two
 * approvers), the compiled API on its own port (3661) against a scratch
 * database, and two loopback stand-ins: the winget source (3664, a real
 * SQLite schema-2 index.db built with the sqlite3 tool and zipped the way an
 * MSIX is) and raw.githubusercontent.com/microsoft/winget-pkgs (3665).
 * Nothing is fetched from the internet. rem0te-action-sim is the agent's
 * real verifier and executor (internal/action) with the stub winget and
 * the stub uninstall registry.
 *
 *   cd apps/api && npx nest build
 *   (cd ../../tools/windows-installer && go build -o /tmp/rem0te-release ./cmd/rem0te-release \
 *      && go build -o /tmp/rem0te-action-sim ./cmd/rem0te-action-sim)
 *   RELEASE_BIN=/tmp/rem0te-release ACTION_SIM=/tmp/rem0te-action-sim \
 *   DATABASE_URL=postgresql://…/reboot_remote_it_scratch node scripts/e2e-software-catalog.mjs
 *
 * What it proves is FIXTURE-TESTED behaviour. winget, the uninstall
 * registry and msiexec are simulated; none of it has run on a real Windows
 * computer.
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { syntheticPasskey } from './lib/synthetic-passkey.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const W = require(path.join(dist, 'software/winget-index.js'));

const DB = process.env.DATABASE_URL ?? '';
const dbName = DB.split('/').pop()?.split('?')[0] ?? '';
if (!/scratch|test/.test(dbName)) {
  console.error(`Refusing to run against database "${dbName}": name must contain "scratch" or "test".`);
  process.exit(2);
}
const BIN = process.env.RELEASE_BIN, SIM = process.env.ACTION_SIM;
if (!BIN || !SIM) { console.error('RELEASE_BIN (rem0te-release) and ACTION_SIM (rem0te-action-sim) are required'); process.exit(2); }
if (spawnSync('sqlite3', ['-version']).status !== 0) { console.error('the sqlite3 tool is required (the API reads the index with it)'); process.exit(2); }
const PORT = Number(process.env.SWC_API_PORT ?? 3661);
const SIGNER_PUBLIC = Number(process.env.SWC_SIGNER_PUBLIC_PORT ?? 3662);
const SIGNER_INTERNAL = Number(process.env.SWC_SIGNER_INTERNAL_PORT ?? 3663);
const INDEX = Number(process.env.SWC_INDEX_PORT ?? 3664);
const MANIFESTS = Number(process.env.SWC_MANIFEST_PORT ?? 3665);
if ([PORT, SIGNER_PUBLIC, SIGNER_INTERNAL, INDEX, MANIFESTS].some((p) => [3000, 3001, 443, 3201, 3202, 4000, 4001].includes(p))) { console.error('refusing a production port'); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
const ORIGIN = `http://127.0.0.1:${SIGNER_PUBLIC}`;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'software-catalog-e2e-password-123';
const ALL_ACTIONS = ['windows.service.start@1', 'windows.update.install@1', 'windows.service.restart@1', 'windows.reboot.schedule@1', 'windows.reboot.cancel@1', 'windows.logs.collect@1', 'windows.script.run@1', 'windows.software.install@1', 'windows.software.uninstall@1', 'windows.software.remove@1'];

let pass = 0, fail = 0; const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const work = mkdtempSync(path.join(tmpdir(), 'rem0te-swc-'));

// ── The winget source stand-in: a real schema-2 index.db in an MSIX-shaped zip ──
function buildIndexDb() {
  const f = path.join(work, 'index.db');
  const rows = [
    ['7zip.7zip', '7-Zip', '7zip', '24.09', 'igorpavlov'],
    ['7zip.7zip.Alpha', '7-Zip Alpha', null, '25.00', 'igorpavlov'],
    ['Notepad++.Notepad++', 'Notepad++', 'notepad++', '8.7.4', 'notepadplusplusteam'],
    ['Contoso.NoRule', 'Contoso No Rule', null, '1.0', 'contoso'],
    ['Contoso.UserOnly', 'Contoso User Only', null, '1.0', 'contoso'],
    ['Contoso.OddVersion', 'Contoso Odd', null, 'latest build', 'contoso'],
    ['-bad.id', 'refused id', null, '1.0', 'x'],
    ['bad id.x', 'refused id', null, '1.0', 'x'],
  ];
  const q = (v) => (v === null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
  const sql = [
    'CREATE TABLE metadata(name TEXT PRIMARY KEY, value TEXT);',
    "INSERT INTO metadata VALUES ('majorVersion','2'),('minorVersion','0'),('lastwritetime','1763000000');",
    'CREATE TABLE packages(rowid INTEGER PRIMARY KEY, id TEXT NOT NULL, name TEXT NOT NULL, moniker TEXT, latest_version TEXT NOT NULL, arp_min_version TEXT, arp_max_version TEXT, hash BLOB);',
    'CREATE TABLE norm_publishers2(norm_publisher TEXT NOT NULL, package INT64 NOT NULL);',
    ...rows.map(([id, name, mon, v, pub], i) => `INSERT INTO packages(rowid,id,name,moniker,latest_version) VALUES (${i + 1},${q(id)},${q(name)},${q(mon)},${q(v)}); INSERT INTO norm_publishers2 VALUES (${q(pub)},${i + 1});`),
  ].join('\n');
  execFileSync('sqlite3', [f, sql]);
  return readFileSync(f);
}
function makeZip(entries) {
  const locals = [], cds = []; let off = 0;
  for (const e of entries) {
    const data = Buffer.from(e.data), comp = deflateRawSync(data), crc = W.crc32(data), name = Buffer.from(e.name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 6); lh.writeUInt16LE(8, 8); lh.writeUInt16LE(name.length, 26);
    const dd = Buffer.alloc(16); dd.writeUInt32LE(0x08074b50, 0); dd.writeUInt32LE(crc, 4); dd.writeUInt32LE(comp.length, 8); dd.writeUInt32LE(data.length, 12);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(8, 8); cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(off, 42);
    locals.push(lh, name, comp, dd); cds.push(cd, name); off += 30 + name.length + comp.length + 16;
  }
  const cdBuf = Buffer.concat(cds), eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cdBuf, eocd]);
}
const MSIX = makeZip([{ name: 'AppxManifest.xml', data: '<Package/>' }, { name: 'Public/index.db', data: buildIndexDb() }]);
let indexMode = 'redirect';
const indexHits = [];
const indexServer = createServer((rq, rs) => {
  indexHits.push({ url: rq.url, auth: rq.headers.authorization ?? null, cookie: rq.headers.cookie ?? null, mode: indexMode });
  if (rq.url === '/elsewhere') { rs.writeHead(200); rs.end(MSIX); return; }
  if (rq.method !== 'GET' || rq.url !== '/cache/source2.msix') { rs.writeHead(404); rs.end(); return; }
  if (indexMode === 'redirect') { rs.writeHead(302, { location: `http://127.0.0.1:${INDEX}/elsewhere` }); rs.end(); return; }
  if (indexMode === '500') { rs.writeHead(500); rs.end('down'); return; }
  if (indexMode === 'garbage') { rs.writeHead(200); rs.end('<html>a captive portal</html>'.repeat(10)); return; }
  if (indexMode === 'big') {
    // Chunked, no length: the cap must hold while streaming.
    rs.writeHead(200);
    const chunk = Buffer.alloc(1024 * 1024);
    let n = 0; const more = () => { while (n < 40) { n++; if (!rs.write(chunk)) { rs.once('drain', more); return; } } rs.end(); };
    rs.on('error', () => undefined); more(); return;
  }
  rs.writeHead(200, { 'content-type': 'application/msix', 'content-length': String(MSIX.length) }); rs.end(MSIX);
});

// ── The winget-pkgs stand-in ────────────────────────────────────────────────
const SEVEN = { id: '7zip.7zip', v: '24.09', v0: '24.08', x64: '7-Zip 24.09 x64 exe (synthetic)', msi: '7-Zip 24.09 x64 msi (synthetic)', arm: '7-Zip 24.09 arm64 (synthetic)', x86: '7-Zip 24.09 x86 (synthetic)', old: '7-Zip 24.08 x64 exe (synthetic)' };
const up = (s) => sha(s).toUpperCase();
const sevenManifest = (v, x64, arm) => `PackageIdentifier: 7zip.7zip
PackageVersion: "${v}"
InstallerLocale: en-US
Scope: machine
Installers:
- Architecture: x86
  InstallerType: exe
  InstallerUrl: https://www.7-zip.org/a/7z-x86.exe
  InstallerSha256: ${up(SEVEN.x86)}
  ProductCode: 7-Zip
- Architecture: x64
  InstallerType: exe
  InstallerUrl: https://www.7-zip.org/a/7z-x64.exe
  InstallerSha256: ${up(x64)}
  ProductCode: 7-Zip
- Architecture: arm64
  InstallerType: exe
  InstallerUrl: https://www.7-zip.org/a/7z-arm64.exe
  InstallerSha256: ${up(arm)}
  ProductCode: 7-Zip
- Architecture: x64
  InstallerType: wix
  InstallerUrl: https://www.7-zip.org/a/7z-x64.msi
  InstallerSha256: ${up(SEVEN.msi)}
  ProductCode: '{23170F69-40C1-2702-2409-000001000000}'
  AppsAndFeaturesEntries:
  - DisplayName: 7-Zip ${v} (x64 edition)
    ProductCode: '{23170F69-40C1-2702-2409-000001000000}'
ManifestType: installer
ManifestVersion: 1.9.0
`;
const fixtures = {
  '7/7zip/7zip/24.09/7zip.7zip.installer.yaml': sevenManifest('24.09', SEVEN.x64, SEVEN.arm),
  '7/7zip/7zip/24.08/7zip.7zip.installer.yaml': sevenManifest('24.08', SEVEN.old, 'arm 24.08'),
  'c/Contoso/NoRule/1.0/Contoso.NoRule.installer.yaml': `PackageIdentifier: Contoso.NoRule\nPackageVersion: "1.0"\nInstallers:\n- Architecture: x64\n  InstallerType: exe\n  InstallerSha256: ${up('norule')}\nManifestType: installer\n`,
  'c/Contoso/UserOnly/1.0/Contoso.UserOnly.installer.yaml': `PackageIdentifier: Contoso.UserOnly\nPackageVersion: "1.0"\nInstallers:\n- Architecture: x64\n  Scope: user\n  InstallerSha256: ${up('user')}\n  ProductCode: Contoso\nManifestType: installer\n`,
};
const fetched = [];
const manifestServer = createServer((rq, rs) => {
  fetched.push({ url: rq.url, auth: rq.headers.authorization ?? null, cookie: rq.headers.cookie ?? null });
  const rel = (rq.url ?? '').replace(/^\/manifests\//, '');
  if (rq.method !== 'GET' || !fixtures[rel]) { rs.writeHead(404); rs.end('404: Not Found'); return; }
  rs.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); rs.end(fixtures[rel]);
});

// ── The release machine ─────────────────────────────────────────────────────
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
const agentBin = Buffer.concat([Buffer.from('MZ stand-in signed agent 0.41 '), randomBytes(64), slot]);
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
const apiEnv = {
  ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATABASE_URL: DB, UPDATE_REPO_DIR: repo,
  MONITOR_SWEEP: 'off', PATCH_POLICY_SWEEP: 'off', METRIC_SWEEP: 'off', CLIENT_UPDATE_SWEEP: 'off', AUTO_MIGRATION_SWEEP: 'off', AGENT_AUTO_UPDATE: 'off', WINGET_INDEX_SWEEP: 'off',
  APPROVAL_SIGNER_INTERNAL_URL: `http://127.0.0.1:${SIGNER_INTERNAL}`,
  WINGET_MANIFEST_BASE: `http://127.0.0.1:${MANIFESTS}/manifests`,
  WINGET_INDEX_URL: `http://127.0.0.1:${INDEX}/cache/source2.msix`,
  JWT_SECRET: randomBytes(32).toString('hex'), LAUNCHER_TOKEN_SECRET: randomBytes(32).toString('hex'),
  ENCRYPTION_KEY: randomBytes(32).toString('hex'), TRUSTED_PROXIES: 'loopback',
  VERSION_FILE: path.resolve(here, '..', '..', '..', 'version.json'),
};
async function waitUp(url, name) {
  for (let i = 0; i < 120; i++) { try { const r = await fetch(url); if (r.status < 500) return; } catch { /* not yet */ } await sleep(300); }
  throw new Error(`${name} did not come up:\n${kids[name]?.log.slice(-3000)}`);
}

// ── HTTP helpers (as e2e-software-deploy.mjs) ───────────────────────────────
async function req(method, p, { s, body, business } = {}) {
  await sleep(60);
  const h = { 'content-type': 'application/json', 'x-forwarded-for': ip() };
  if (s) h.cookie = s.cookie + (s.stepUp ? `; step_up=${s.stepUp}` : '');
  if (business) h['x-rem0te-business'] = business;
  const r = await fetch(`${API}${p}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j, setCookie: r.headers.get('set-cookie') ?? '' };
}
async function login(email) {
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip() }, body: JSON.stringify({ email, password: PW }) });
  const m = (r.headers.get('set-cookie') ?? '').match(/access_token=([^;]+)/);
  if (r.status !== 200 || !m) throw new Error(`login ${email}: ${r.status} ${await r.text()}`);
  return { cookie: `access_token=${m[1]}` };
}
async function stepUp(s) {
  const r = await req('POST', '/auth/step-up', { s, body: { password: PW } });
  const m = r.setCookie.match(/step_up=([^;]+)/);
  if (r.status !== 200 || !m) throw new Error(`step-up: ${r.status} ${JSON.stringify(r.body)}`);
  return { ...s, stepUp: m[1] };
}
const code = (r) => r.body?.code ?? r.body?.message?.code ?? r.body?.error?.code;
const msg = (r) => `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 400)}`;
const sj = async (url, init = {}) => { const r = await fetch(url, init); let b = null; try { b = await r.json(); } catch { /* html */ } return { status: r.status, body: b }; };
const signerPost = (id, p, body) => sj(`${ORIGIN}/approve/${id}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify(body) });
async function approve(jobId, who) {
  const c = await signerPost(jobId, '/challenge', { decision: 'approve', role: 'approver' });
  if (c.status !== 200) return c;
  return signerPost(jobId, '/decide', { challengeId: c.body.challengeId, assertion: who.assert(c.body.options, { origin: ORIGIN }) });
}
const heartbeat = (ep, extra = {}) => req('POST', '/enrollment/heartbeat', {
  body: { rustdeskId: ep.rid, agentSecret: ep.secret, hostname: ep.hostname, platform: 'Windows', updateChannel: 'signed', agentActions: ALL_ACTIONS, agentSha256: AGENT_SHA, ...extra },
});
function resultsOf(ep) {
  const d = path.join(ep.state, 'actions', 'results');
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => /^[0-9a-f]{32}\.json$/.test(f)).map((f) => JSON.parse(readFileSync(path.join(d, f), 'utf8')));
}
let keysFile;
const stateFile = (ep) => path.join(ep.state, 'winget.json');
const setState = (ep, st) => writeFileSync(stateFile(ep), JSON.stringify(st));
const stateNow = (ep) => JSON.parse(readFileSync(stateFile(ep), 'utf8'));
function runAgent(ep, jobId, envelope) {
  const envFile = path.join(work, `env-${jobId}-${randomBytes(3).toString('hex')}.json`);
  writeFileSync(envFile, JSON.stringify(envelope));
  const args = ['-state', ep.state, '-keys', keysFile, '-job', jobId, '-envelope', envFile, '-rustdesk-id', ep.rid, '-secret', ep.secret, '-product-type', '1', '-self-sha', AGENT_SHA, '-winget', stateFile(ep), '-portal', `127.0.0.1:${PORT}`];
  return JSON.parse(execFileSync(SIM, args, { encoding: 'utf8', timeout: 120_000 }).trim());
}
const deliver = async (ep, jobId) => ((await heartbeat(ep)).body?.data?.actions ?? []).find((d) => d.jobId === jobId)?.envelope;
const report = async (ep) => {
  const h = await heartbeat(ep, { actionResults: resultsOf(ep) });
  for (const a of h.body?.data?.actionAcks ?? []) rmSync(path.join(ep.state, 'actions', 'results', `${a}.json`), { force: true });
  return h;
};
const WINGET = 'v1.9.25200';

const created = { businesses: [], users: [], entries: [] };

async function all() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  if (await prisma.wingetPackage.count()) throw new Error('the scratch database already holds a winget index (an earlier run that did not clean up?)');
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });

  section('Fixtures (synthetic): Acme (direct mode) and Globex (signed)');
  const acme = await prisma.customer.create({ data: { tenantId: tenant.id, name: `SWC Acme ${sfx}` } });
  const globex = await prisma.customer.create({ data: { tenantId: tenant.id, name: `SWC Globex ${sfx}` } });
  created.businesses.push(acme.id, globex.id);
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag, extra = {}) => { const u = await prisma.user.create({ data: { email: `swc-${tag}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'SWC', lastName: tag, status: 'ACTIVE', ...extra } }); created.users.push(u.id); return u; };
  const admin = await mkUser('admin', { isPlatformAdmin: true });
  const owen = await mkUser('owen-owner'), bob = await mkUser('bob-globex-owner'), sam = await mkUser('sam-l3');
  const olivia = await mkUser('olivia-approver', { platformPermissions: ['technicians:manage'] }), quinn = await mkUser('quinn-approver', { platformPermissions: ['technicians:manage'] });
  await prisma.membership.create({ data: { userId: owen.id, tenantId: tenant.id, customerId: acme.id, roleId: roleOwner.id, capabilities: [] } });
  await prisma.membership.create({ data: { userId: bob.id, tenantId: tenant.id, customerId: globex.id, roleId: roleOwner.id, capabilities: [] } });
  const l3 = await prisma.technicianPreset.findUnique({ where: { key: 'l3-senior' } });
  if (!l3) throw new Error('built-in presets missing: boot the API once against this database (run-e2e.sh does)');
  await prisma.technicianAssignment.create({ data: { tenantId: tenant.id, customerId: acme.id, userId: sam.id, presetId: l3.id, capabilities: [] } });
  const mkEp = async (hostname, business, { osArch = '64-bit', software = [], state = {} } = {}) => {
    const e = await prisma.endpoint.create({ data: { tenantId: tenant.id, customerId: business.id, name: hostname, hostname, platform: 'Windows', status: 'ACTIVE', isOnline: true, isManaged: true, accessMode: 'COMPANY_WIDE', lastSeenAt: new Date(), deviceClass: 'WORKSTATION' } });
    const rid = String(100000000 + ((Math.random() * 899999999) | 0));
    const secret = randomBytes(24).toString('hex');
    await prisma.rustdeskNode.create({ data: { tenantId: tenant.id, endpointId: e.id, rustdeskId: rid, agentSecretHash: sha(secret) } });
    await prisma.endpointInventory.create({ data: { endpointId: e.id, collectedAt: new Date(), osArch, software, softwareCount: software.length } });
    const ep = { id: e.id, rid, secret, hostname, state: path.join(work, `agent-${hostname}`) };
    mkdirSync(ep.state);
    setState(ep, { version: WINGET, ...state });
    return ep;
  };
  // What the 0.41 inventory reports per program: its key, view, and whether it registers a silent uninstall or is an MSI.
  const inv = (name, version, key, view, quiet, msi) => ({ name, version, publisher: null, installedOn: null, key, view, quiet, msi });
  const GUID = '{11111111-2222-3333-4444-555555555555}';
  const PROGRAMS = [
    { view: '64', key: GUID, displayName: 'Contoso Agent', displayVersion: '3.1', windowsInstaller: true, uninstallString: `MsiExec.exe /X${GUID}` },
    { view: '32', key: 'ContosoTool', displayName: 'Contoso Tool 2', displayVersion: '2.0', uninstallString: '"C:\\Program Files (x86)\\Contoso\\uninst.exe"', quietUninstallString: '"C:\\Program Files (x86)\\Contoso\\uninst.exe" /S' },
    { view: '64', key: 'ClickThrough', displayName: 'Click Through', displayVersion: '1.0', uninstallString: '"C:\\Program Files\\Click\\setup.exe" /remove' },
    { view: '64', key: 'Replaced', displayName: 'Something Else Now', displayVersion: '9.0', quietUninstallString: '"C:\\Program Files\\Else\\u.exe" /S' },
    { view: '64', key: 'Shelly', displayName: 'Shelly', displayVersion: '1.0', quietUninstallString: 'cmd.exe /c rd /s /q C:\\Shelly' },
    { view: '64', key: 'Sticky', displayName: 'Sticky App', displayVersion: '1.0', quietUninstallString: '"C:\\Program Files\\Sticky\\unins000.exe" /VERYSILENT', noEffect: true },
  ];
  const canarySw = [
    inv('Contoso Agent', '3.1', GUID, '64', false, true), inv('Contoso Tool 2', '2.0', 'ContosoTool', '32', true, false), inv('Click Through', '1.0', 'ClickThrough', '64', false, false),
    inv('Replaced App', '1.0', 'Replaced', '64', true, false), inv('Shelly', '1.0', 'Shelly', '64', true, false), inv('Sticky App', '1.0', 'Sticky', '64', true, false),
    { name: 'Legacy Thing', version: '1.0', publisher: null, installedOn: null },
  ];
  const sevenPkg = { installer: SEVEN.x64, displayName: '7-Zip 24.09 (x64)', displayVersion: '24.09', uninstallKey: '7-Zip' };
  const canary = await mkEp('SWC-CANARY', acme, { software: canarySw, state: { packages: { [`${SEVEN.id}@${SEVEN.v}`]: sevenPkg }, programs: PROGRAMS } });
  const second = await mkEp('SWC-SECOND', acme, { state: { packages: { [`${SEVEN.id}@${SEVEN.v}`]: sevenPkg } } });
  const armpc = await mkEp('SWC-ARM', acme, { osArch: 'ARM 64-bit Processor' });
  const gpc = await mkEp('SWC-GLOBEX', globex, { software: [inv('Contoso Tool 2', '2.0', 'ContosoTool', '32', true, false)], state: { programs: [PROGRAMS[1]] } });
  const pk = { olivia: syntheticPasskey({ userId: olivia.id, name: 'SWC olivia' }), quinn: syntheticPasskey({ userId: quinn.id, name: 'SWC quinn' }) };
  for (const k of Object.values(pk)) await prisma.userMfaMethod.create({ data: { userId: k.userId, type: 'WEBAUTHN', isActive: true, credentialId: k.credentialId, publicKey: Buffer.from(k.publicKey, 'base64url'), signCount: 0, name: 'Test key' } });
  check(true, 'two businesses, four computers, six people');

  await new Promise((r) => indexServer.listen(INDEX, '127.0.0.1', r));
  await new Promise((r) => manifestServer.listen(MANIFESTS, '127.0.0.1', r));
  start('signer', path.join(dist, 'approval-signer', 'main.js'), signerEnv);
  start('api', path.join(dist, 'main.js'), apiEnv);
  await waitUp(`http://127.0.0.1:${SIGNER_INTERNAL}/internal/v1/keys`, 'signer');
  await waitUp(`${API}/health`, 'api');
  const S = {};
  for (const [k, u] of Object.entries({ admin, owen, bob, sam, olivia, quinn })) S[k] = await login(u.email);
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
    keysFile = path.join(work, 'keys.json');
    writeFileSync(keysFile, Buffer.from(await (await fetch(`${API}/public/updates/targets/approval/${t.hashes.sha256}.keys.json`)).arrayBuffer()));
  }
  const set = signerCli(['policy', 'set', '--business', acme.id, '--approval', 'direct']);
  check(set.status === 0, 'the signer\'s operator puts Acme in direct mode (its CLI); Globex stays signed', set.stderr);
  for (const ep of [canary, second, armpc, gpc]) await heartbeat(ep);
  S.adminF = await stepUp(S.admin); S.owenF = await stepUp(S.owen); S.samF = await stepUp(S.sam); S.bobF = await stepUp(S.bob);

  section('The winget index: one fixed URL, bounded, no redirects, no credentials');
  {
    let r = await req('GET', '/software/winget/packages?q=7zip', { s: S.owen });
    check(r.status === 200 && r.body.data.results.length === 0 && r.body.data.index.packages === 0 && r.body.data.index.sweep === 'off', 'before it is read: no results, and the page says the sweep is off on this server', msg(r));
    r = await req('POST', '/software/winget/refresh', { s: S.owenF });
    check(r.status === 403, 'a Business Owner cannot read the index on demand (Platform Admin only)', msg(r));
    for (const [mode, re, n] of [['redirect', /fetch failed|did not answer|redirect/i, 'a redirect is not followed'], ['500', /answered 500/, 'a server error'], ['garbage', /not a zip/, 'something that is not an MSIX'], ['big', /larger than 32 MB/, 'a body past 32 MB, without a length, is cut off while streaming']]) {
      indexMode = mode;
      r = await req('POST', '/software/winget/refresh', { s: S.admin });
      const st = await prisma.wingetIndexState.findUnique({ where: { id: 1 } });
      check(r.status === 409 && code(r) === 'INDEX_NOT_READ' && re.test(st?.lastError ?? '') && !(await prisma.wingetPackage.count()), `${n} → 409 INDEX_NOT_READ, the reason recorded, nothing stored`, `${msg(r)} lastError=${st?.lastError}`);
    }
    check(!indexHits.some((h) => h.url === '/elsewhere'), 'the redirect target was never fetched');
    indexMode = 'ok';
    r = await req('POST', '/software/winget/refresh', { s: S.admin });
    check(r.status === 200 && r.body.data.packages === 6 && r.body.data.skipped === 2 && r.body.data.lastError === null && r.body.data.sourceSha256 === sha(MSIX) && r.body.data.sourceWrittenAt,
      'the index is read: six packages, the two ids outside the plan charset skipped, the source digest recorded', msg(r));
    check(indexHits.every((h) => !h.auth && !h.cookie) && indexHits.every((h) => h.url === '/cache/source2.msix' || h.url === '/elsewhere'), 'every fetch was the one URL, with no credentials or cookies', JSON.stringify(indexHits.slice(-2)));
    check(!!(await prisma.activityLog.findFirst({ where: { action: 'WINGET_INDEX_REFRESH_REQUESTED', actorId: admin.id } })), 'asking for a read is audited');
    r = await req('POST', '/software/winget/refresh', { s: S.admin });
    check(r.status === 409 && code(r) === 'INDEX_FRESH', 'a second read within the hour → 409 INDEX_FRESH', msg(r));
    indexMode = 'garbage';
    r = await req('GET', '/software/winget/packages?q=7zip', { s: S.sam, business: acme.id });
    const hits = r.body?.data?.results ?? [];
    check(r.status === 200 && hits[0]?.packageId === '7zip.7zip' && hits[0].latestVersion === '24.09' && hits[0].installable === true && hits.some((h) => h.packageId === '7zip.7zip.Alpha'),
      'a technician searches "7zip": 7zip.7zip first, at the index\'s latest version, installable', msg(r));
    r = await req('GET', '/software/winget/packages?q=contoso%20odd', { s: S.bob });
    check(r.status === 200 && r.body.data.results.length === 1 && r.body.data.results[0].installable === false, 'a version the agent would refuse is listed but not installable', msg(r));
    for (const q of ["7zip'--", '7zip;drop', '%25', 'a"b']) {
      r = await req('GET', `/software/winget/packages?q=${encodeURIComponent(q)}`, { s: S.owen });
      check(r.status === 400 && code(r) === 'INVALID_REQUEST', `a search of ${JSON.stringify(q)} → 400`, msg(r));
    }
  }

  section('One click on Acme (direct mode): the entry is made from the manifest, the install signed at once');
  let entry;
  {
    let tab = (await req('GET', `/endpoints/${canary.id}/software/catalog`, { s: S.owen })).body?.data;
    check(tab?.approval === 'direct' && tab.architecture === 'x64' && tab.install?.possible === true && tab.remove?.possible === true, 'the Software tab says direct mode, x64, Install and Uninstall possible', JSON.stringify(tab).slice(0, 300));
    const g = (await req('GET', `/endpoints/${gpc.id}/software/catalog`, { s: S.bob })).body?.data;
    check(g?.approval === 'signed', 'Globex\'s computer says signed');
    const cat = (await req('GET', `/actions/catalog?endpointId=${canary.id}`, { s: S.owen })).body?.data;
    const rm = cat?.actions?.find((a) => a.id === 'windows.software.remove');
    check(cat?.approval === 'direct' && cat.actions.map((a) => `${a.id}@${a.version}`).join(',') === ALL_ACTIONS.join(',') && rm?.direct === false && rm.maxTargets === 1 && rm.workstationRisk === 'high',
      'GET /actions/catalog?endpointId=: direct, ten actions, windows.software.remove last — high impact, one computer, not from the Actions tab', JSON.stringify(cat?.actions?.map((a) => a.id)));
    const before = { entries: await prisma.softwareCatalogEntry.count({ where: { customerId: acme.id } }), jobs: await prisma.actionJob.count({ where: { customerId: acme.id } }) };
    let r = await req('POST', `/endpoints/${canary.id}/software/winget-install`, { s: S.owen, body: { packageId: SEVEN.id } });
    check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED', 'without a fresh sign-in (direct mode) → 403 STEP_UP_REQUIRED', msg(r));
    r = await req('POST', `/endpoints/${canary.id}/software/winget-install`, { s: S.samF, business: acme.id, body: { packageId: SEVEN.id } });
    check(r.status === 403 && code(r) === 'NOT_ALLOWED', 'a technician cannot add a package to the business\'s catalog by installing it → 403', msg(r));
    for (const [pkg, want, st] of [['Contoso.NoRule', 'NO_DETECTION', 409], ['Contoso.UserOnly', 'NO_MACHINE_INSTALLER', 409], ['Nobody.Knows', 'PACKAGE_NOT_IN_INDEX', 404], ['Contoso.OddVersion', 'VERSION_NOT_INSTALLABLE', 409]]) {
      r = await req('POST', `/endpoints/${canary.id}/software/winget-install`, { s: S.owenF, body: { packageId: pkg } });
      check(r.status === st && code(r) === want, `${pkg} → ${st} ${want}`, msg(r));
    }
    r = await req('POST', `/endpoints/${canary.id}/software/winget-install`, { s: S.owenF, body: { packageId: SEVEN.id, installerSha256: sha('x') } });
    check(r.status === 400, 'a request naming its own hash → 400 (the hash only ever comes from the manifest)', msg(r));
    check(before.entries === await prisma.softwareCatalogEntry.count({ where: { customerId: acme.id } }) && before.jobs === await prisma.actionJob.count({ where: { customerId: acme.id } }), 'none of those wrote an entry or a plan');

    r = await req('POST', `/endpoints/${canary.id}/software/winget-install`, { s: S.owenF, body: { packageId: SEVEN.id } });
    const d = r.body?.data;
    entry = d?.entry;
    if (entry?.id) created.entries.push(entry.id);
    const e = entry?.id ? await prisma.softwareCatalogEntry.findUnique({ where: { id: entry.id } }) : null;
    check(r.status === 201 && entry.change === 'created' && e?.scope === 'BUSINESS' && e.customerId === acme.id && e.version === '24.09' && e.installerSha256 === sha(SEVEN.x64) && e.hashSource === 'WINGET_PKGS' && e.architecture === 'x64'
      && e.manifestSha256 === sha(fixtures['7/7zip/7zip/24.09/7zip.7zip.installer.yaml']) && same(Object.entries(e.detection).sort(), Object.entries({ kind: 'uninstall_key', key: '7-Zip', compare: 'gte', version: '24.09' }).sort()),
    'Acme\'s owner clicks Install on 7-Zip: a business entry pinned to the first x64 machine installer (the exe), its manifest digest, and an uninstall-key rule from its ProductCode', `${msg(r)} ${JSON.stringify(e)}`);
    check(d?.installer?.alternatives === 1 && d.installer.installerType === 'exe', 'the response says another x64 installer (the MSI) was not chosen', JSON.stringify(d?.installer));
    check(d?.job?.status === 'APPROVED' && d.job.direct === true && d.job.approvalsRequired === 0 && d.job.risk === 'high', 'the install is signed at once: APPROVED, direct, no approvers, high risk', JSON.stringify(d?.job).slice(0, 300));
    const audit = await prisma.activityLog.findFirst({ where: { action: 'SOFTWARE_CATALOG_CREATED', resourceId: entry.id } });
    check(audit?.actorId === owen.id && audit.metadata?.via === 'one_click' && audit.metadata?.hashSource === 'WINGET_PKGS', 'the new entry is audited as made by one click', JSON.stringify(audit?.metadata));
    check(fetched.some((f) => f.url === '/manifests/7/7zip/7zip/24.09/7zip.7zip.installer.yaml') && fetched.every((f) => !f.auth && !f.cookie), 'the manifest read was the winget-pkgs layout, no credentials');
    const env = await deliver(canary, d.job.id);
    const res = runAgent(canary, d.job.id, env);
    check(res.outcome === 'succeeded' && res.observed?.installerSha256 === sha(SEVEN.x64) && res.observed?.detectedAfter === 'installed', 'the computer installs it: the hash it computed itself is the pinned one, and the derived rule detects it', JSON.stringify(res).slice(0, 400));
    await report(canary);
    const j = await req('GET', `/actions/${d.job.id}`, { s: S.owen });
    check(j.body?.data?.status === 'SUCCEEDED', 'recorded SUCCEEDED', msg(j));

    r = await req('POST', `/endpoints/${second.id}/software/winget-install`, { s: S.samF, business: acme.id, body: { packageId: SEVEN.id, reason: 'same package on the second computer' } });
    check(r.status === 201 && r.body.data.entry.change === 'reused' && r.body.data.entry.id === entry.id && await prisma.softwareCatalogEntry.count({ where: { customerId: acme.id } }) === 1,
      'the technician installs the same package elsewhere: the entry is reused, nothing written to the catalog', msg(r));
    const res2 = runAgent(second, r.body.data.job.id, await deliver(second, r.body.data.job.id));
    check(res2.outcome === 'succeeded', 'and it installs there', JSON.stringify(res2).slice(0, 200));
    await report(second);
    r = await req('POST', `/endpoints/${armpc.id}/software/winget-install`, { s: S.owenF, body: { packageId: SEVEN.id } });
    check(r.status === 409 && code(r) === 'ENTRY_PINS_ANOTHER_INSTALLER', 'an arm64 computer: the business\'s 24.09 entry pins the x64 installer, so it is not silently repinned → 409', msg(r));
    r = await req('POST', `/endpoints/${armpc.id}/software/winget-install`, { s: S.owenF, body: { packageId: SEVEN.id, version: SEVEN.v0 } });
    const moved = await prisma.softwareCatalogEntry.findUnique({ where: { id: entry.id } });
    check(r.status === 201 && r.body.data.entry.change === 'updated' && moved.version === '24.08' && moved.revision === 2 && moved.architecture === 'arm64',
      'naming another version moves the business\'s entry to it (an upgrade or a rollback), for this computer\'s architecture', msg(r));
    check(!!(await prisma.activityLog.findFirst({ where: { action: 'SOFTWARE_CATALOG_UPDATED', resourceId: entry.id } })), '…audited as a catalog change');
    tab = (await req('GET', `/endpoints/${canary.id}/software/catalog`, { s: S.owen })).body?.data;
    check(tab?.entries?.some((x) => x.id === entry.id), 'the entry is on the Software tab');
  }

  section('Add to catalog from the search (Automation → Software catalog)');
  {
    let r = await req('POST', '/software/winget/catalog', { s: S.bob, body: { scope: 'business', businessId: globex.id, packageId: 'Notepad++.Notepad++' } });
    check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED', 'without a fresh sign-in → 403 STEP_UP_REQUIRED', msg(r));
    r = await req('POST', '/software/winget/catalog', { s: S.bobF, body: { scope: 'global', packageId: SEVEN.id } });
    check(r.status === 403, 'a Business Owner cannot add to the global catalog', msg(r));
    r = await req('POST', '/software/winget/catalog', { s: S.bobF, body: { scope: 'business', businessId: acme.id, packageId: SEVEN.id } });
    check(r.status === 403 || r.status === 404, 'Globex\'s owner cannot add to Acme\'s catalog', msg(r));
    r = await req('POST', '/software/winget/catalog', { s: S.adminF, body: { scope: 'global', packageId: SEVEN.id } });
    const g = r.body?.data?.entry;
    if (g?.id) created.entries.push(g.id);
    check(r.status === 201 && r.body.data.change === 'created' && g.scope === 'global' && g.hashSource === 'winget_pkgs' && g.installerSha256 === sha(SEVEN.x64), 'a Platform Admin adds 7-Zip 24.09 to the global catalog from the search', msg(r));
    r = await req('POST', '/software/winget/catalog', { s: S.adminF, body: { scope: 'global', packageId: SEVEN.id } });
    check(r.status === 201 && r.body.data.change === 'reused' && r.body.data.entry.id === g.id, 'adding it again reuses the entry');
  }

  section('Uninstall from the installed-software list (Acme, direct)');
  {
    const tab = (await req('GET', `/endpoints/${canary.id}/software/catalog`, { s: S.owen })).body?.data;
    const by = Object.fromEntries((tab?.installed ?? []).map((p) => [p.name, p]));
    check(by['Contoso Agent']?.removal?.method === 'msi' && by['Contoso Tool 2']?.removal?.method === 'quiet' && by['Click Through']?.removal?.possible === false && /interactive/.test(by['Click Through']?.removal?.reason ?? '')
      && by['Legacy Thing']?.removal?.possible === false && by['Legacy Thing'].key === null,
    'each program says how it would be removed: MSI → msiexec, silent uninstall → quiet, interactive only and no key → not offered, with why', JSON.stringify(tab?.installed).slice(0, 600));
    const n0 = await prisma.actionJob.count({ where: { customerId: acme.id } });
    let r = await req('POST', `/endpoints/${canary.id}/software/remove-program`, { s: S.owen, body: { key: GUID, view: '64', displayName: 'Contoso Agent' } });
    check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED', 'direct mode: without a fresh sign-in → 403 STEP_UP_REQUIRED', msg(r));
    r = await req('POST', `/endpoints/${canary.id}/software/remove-program`, { s: S.owenF, body: { key: 'NotThere', view: '64', displayName: 'Not There' } });
    check(r.status === 404 && code(r) === 'PROGRAM_NOT_IN_INVENTORY', 'a program the inventory does not list → 404', msg(r));
    r = await req('POST', `/endpoints/${canary.id}/software/remove-program`, { s: S.owenF, body: { key: GUID, view: '32', displayName: 'Contoso Agent' } });
    check(r.status === 404 && code(r) === 'PROGRAM_NOT_IN_INVENTORY', 'the right key in the wrong registry view → 404', msg(r));
    r = await req('POST', `/endpoints/${canary.id}/software/remove-program`, { s: S.owenF, body: { key: 'ClickThrough', view: '64', displayName: 'Click Through' } });
    check(r.status === 409 && code(r) === 'NO_SILENT_UNINSTALL', 'an interactive-only uninstaller → 409 NO_SILENT_UNINSTALL', msg(r));
    for (const [n, body] of [['a key that is a path', { key: '..\\Run', view: '64', displayName: 'x' }], ['a third view', { key: GUID, view: 'both', displayName: 'Contoso Agent' }], ['a command', { key: GUID, view: '64', displayName: 'Contoso Agent', quietUninstallString: 'cmd.exe /c calc' }]]) {
      r = await req('POST', `/endpoints/${canary.id}/software/remove-program`, { s: S.owenF, body });
      check(r.status === 400, `${n} → 400`, msg(r));
    }
    r = await req('POST', `/endpoints/${canary.id}/software/remove-program`, { s: S.bobF, body: { key: GUID, view: '64', displayName: 'Contoso Agent' } });
    check(r.status === 404, 'Globex\'s owner, on an Acme computer → 404', msg(r));
    r = await req('POST', `/endpoints/${canary.id}/actions`, { s: S.samF, business: acme.id, body: { actionId: 'windows.software.remove', version: 1, params: { key: GUID, view: '64', displayName: 'Contoso Agent' }, reason: 'straight from the Actions tab' } });
    check(r.status === 400 && code(r) === 'ACTION_NOT_DIRECT', 'windows.software.remove from the Actions tab → 400 ACTION_NOT_DIRECT', msg(r));
    check(n0 === await prisma.actionJob.count({ where: { customerId: acme.id } }), 'none of that made a plan');

    const removeOne = async (body, s = S.owenF) => {
      const x = await req('POST', `/endpoints/${canary.id}/software/remove-program`, { s, business: acme.id, body });
      const job = x.body?.data?.job;
      return { x, job, res: job ? runAgent(canary, job.id, await deliver(canary, job.id)) : null };
    };
    let o = await removeOne({ key: GUID, view: '64', displayName: 'Contoso Agent' });
    const signed = o.job ? await prisma.actionJob.findUnique({ where: { id: o.job.id } }) : null;
    check(o.x.status === 201 && o.job.status === 'APPROVED' && o.job.direct === true && o.x.body.data.method === 'msi' && same(Object.keys(signed.params).sort(), ['displayName', 'key', 'view']),
      'the MSI program: signed at once, the plan names only key, view and displayName', msg(o.x));
    let st = stateNow(canary);
    check(o.res?.outcome === 'succeeded' && o.res.observed?.method === 'msi' && o.res.observed?.presentAfter === 'false' && same(st.removals, [{ kind: 'msi', productCode: GUID }]) && !st.programs.some((p) => p.key === GUID),
      'the computer removes it with msiexec /x of the key\'s own product code; the key is gone, so it succeeded', JSON.stringify(o.res).slice(0, 400));
    await report(canary);
    o = await removeOne({ key: 'ContosoTool', view: '32', displayName: 'Contoso Tool 2' }, S.samF);
    st = stateNow(canary);
    check(o.res?.outcome === 'succeeded' && o.res.observed?.method === 'quiet' && o.res.observed?.program === 'uninst.exe' && same(st.removals.at(-1), { kind: 'quiet', exe: 'C:\\Program Files (x86)\\Contoso\\uninst.exe', args: '/S' }),
      'the technician removes the 32-bit tool: its registered QuietUninstallString, the program and its own arguments, no shell', JSON.stringify(o.res).slice(0, 400));
    await report(canary);
    const nRemovals = stateNow(canary).removals.length;
    o = await removeOne({ key: 'Replaced', view: '64', displayName: 'Replaced App' });
    check(o.res?.outcome === 'refused' && o.res.reason === 'program_changed' && stateNow(canary).removals.length === nRemovals, 'a key that now names another program → refused, program_changed, nothing run', JSON.stringify(o.res).slice(0, 300));
    await report(canary);
    o = await removeOne({ key: 'Shelly', view: '64', displayName: 'Shelly' });
    check(o.res?.outcome === 'refused' && o.res.reason === 'uninstall_command_refused' && stateNow(canary).removals.length === nRemovals, 'a QuietUninstallString that is cmd.exe → refused, nothing run', JSON.stringify(o.res).slice(0, 300));
    await report(canary);
    o = await removeOne({ key: 'Sticky', view: '64', displayName: 'Sticky App' });
    check(o.res?.outcome === 'failed' && o.res.reason === 'not_effective' && o.res.observed?.presentAfter === 'true', 'an uninstaller that exits 0 but leaves the key → failed, not_effective', JSON.stringify(o.res).slice(0, 300));
    await report(canary);
    const jobs = await prisma.actionJob.findMany({ where: { customerId: acme.id, actionId: 'windows.software.remove' }, orderBy: { createdAt: 'asc' } });
    check(same(jobs.map((x) => x.status), ['SUCCEEDED', 'SUCCEEDED', 'REFUSED_BY_ENDPOINT', 'REFUSED_BY_ENDPOINT', 'FAILED']),
      'each result is recorded against its job', JSON.stringify(jobs.map((x) => [x.status, x.statusReason])));
    const after = (await req('GET', `/endpoints/${canary.id}/software/catalog`, { s: S.owen })).body?.data;
    check(after?.installed?.find((p) => p.name === 'Sticky App')?.last?.reason === 'not_effective', 'the Software tab shows the last removal against the program');
  }

  section('Uninstall on Globex (signed): two approvers, then the computer');
  {
    const r = await req('POST', `/endpoints/${gpc.id}/software/remove-program`, { s: S.bob, body: { key: 'ContosoTool', view: '32', displayName: 'Contoso Tool 2', reason: 'no longer licensed' } });
    const job = r.body?.data?.job;
    check(r.status === 201 && job.status === 'AWAITING_APPROVAL' && job.approvalsRequired === 2 && !job.direct, 'signed mode, no fresh sign-in needed to ask: AWAITING_APPROVAL, two approvers', msg(r));
    const page = await (await fetch(job.approvalUrl)).text();
    check(page.includes('windows.software.remove') && page.includes('ContosoTool') && page.includes('Contoso Tool 2'), 'the approval page shows the action, the key and the program name');
    check(!(await deliver(gpc, job.id)), 'nothing is delivered before it is approved');
    await approve(job.id, pk.olivia);
    await approve(job.id, pk.quinn);
    check((await req('GET', `/actions/${job.id}`, { s: S.bob })).body?.data?.status === 'APPROVED', 'the second, different approver signs it');
    const res = runAgent(gpc, job.id, await deliver(gpc, job.id));
    check(res.outcome === 'succeeded' && res.observed?.method === 'quiet', 'two approvals later the computer removes it', JSON.stringify(res).slice(0, 300));
    await report(gpc);
    check((await req('GET', `/actions/${job.id}`, { s: S.bob })).body?.data?.status === 'SUCCEEDED', 'recorded SUCCEEDED');
  }
}

async function cleanup() {
  await stop('api'); await stop('signer');
  await new Promise((r) => indexServer.close(() => r())).catch(() => undefined);
  await new Promise((r) => manifestServer.close(() => r())).catch(() => undefined);
  try {
    if (created.businesses.length) {
      await prisma.actionJob.deleteMany({ where: { customerId: { in: created.businesses } } });
      await prisma.softwareDeployment.deleteMany({ where: { customerId: { in: created.businesses } } });
    }
    if (created.entries.length) await prisma.softwareCatalogEntry.deleteMany({ where: { id: { in: created.entries } } });
    await prisma.wingetPackage.deleteMany({});
    await prisma.wingetIndexState.deleteMany({});
    if (created.businesses.length) {
      await prisma.technicianAssignment.deleteMany({ where: { customerId: { in: created.businesses } } });
      const eps = await prisma.endpoint.findMany({ where: { customerId: { in: created.businesses } }, select: { id: true } });
      await prisma.endpointInventory.deleteMany({ where: { endpointId: { in: eps.map((e) => e.id) } } });
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
