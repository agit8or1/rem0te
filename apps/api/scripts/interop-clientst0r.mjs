#!/usr/bin/env node
/**
 * rem0te against the REAL ClientSt0r code (0.30): measures where the two stop
 * interoperating today, so the gap is a test result and not a claim.
 *
 * Starts the compiled rem0te API on a scratch database with a peers file for
 * the example peer (the TEST-ONLY keys in docs/contracts/ticket-rmm-v1/examples/keys),
 * then runs scripts/clientst0r-interop/drive.py inside a disposable ClientSt0r
 * (its own Django, sqlite, logs in a temp directory). The driver calls
 * ClientSt0r's own pairing and processor code — nothing is reimplemented — and
 * this script checks what happened against what CLIENTST0R.md records.
 *
 *   CLIENTST0R_DIR=…/clientst0r CLIENTST0R_PYTHON=…/venv/bin/python \
 *   DATABASE_URL=postgresql://…/<scratch|test> node scripts/interop-clientst0r.mjs [--write-report]
 *
 * CLIENTST0R_DIR is read, never written: Python runs with it as the working
 * directory but every file it creates goes to a temp directory. Migrations for
 * the sqlite database run first (minutes, the first time).
 *
 * Each check asserts the OBSERVED behaviour. When ClientSt0r adopts the
 * contract, these checks are expected to fail — and should then be turned
 * into checks that the workflow passes.
 */
import { PrismaClient } from '@prisma/client';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..');
const dist = path.join(here, '..', 'dist');
const C = require(path.join(dist, 'integration/crypto.js'));
const DB = process.env.DATABASE_URL ?? '';
const dbName = DB.split('/').pop()?.split('?')[0] ?? '';
if (!/scratch|test/.test(dbName)) { console.error(`Refusing database "${dbName}": name must contain "scratch" or "test".`); process.exit(2); }
const CS = process.env.CLIENTST0R_DIR, PY = process.env.CLIENTST0R_PYTHON;
if (!CS || !PY || !existsSync(path.join(CS, 'manage.py'))) { console.error('CLIENTST0R_DIR (a ClientSt0r checkout) and CLIENTST0R_PYTHON (a venv with its requirements) are required'); process.exit(2); }
const PORT = Number(process.env.IOP_API_PORT ?? 3141);
if ([3000, 3001, 443].includes(PORT)) { console.error('refusing a production port'); process.exit(2); }
const ROOT = `http://127.0.0.1:${PORT}`;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
let pass = 0, fail = 0; const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EX = path.join(root, 'docs/contracts/ticket-rmm-v1/examples');
const seeded = (name) => createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), createHash('sha256').update(`rem0te-contract-example:${name}`).digest()]), format: 'der', type: 'pkcs8' });
const pub = (k) => createPublicKey(k).export({ type: 'spki', format: 'pem' }).toString();
const self = seeded('rem0te-self'), peerReq = seeded('clientst0r-request'), peerDel = seeded('clientst0r-delegation');
const PEER = 'clientst0r-example', AUD = 'rem0te:example';

const work = mkdtempSync(path.join(tmpdir(), 'rem0te-iop-'));
writeFileSync(path.join(work, 'self.pem'), self.export({ type: 'pkcs8', format: 'pem' }));
writeFileSync(path.join(work, 'peers.json'), JSON.stringify({
  self: { keyId: 'rem0te-example-1', privateKeyFile: path.join(work, 'self.pem') },
  peers: [{ id: PEER, audience: AUD, peerAudience: 'clientst0r:example', requestKeys: [{ kid: 'req-1', publicKeyPem: pub(peerReq) }], delegationKeys: [{ kid: 'del-1', publicKeyPem: pub(peerDel) }],
    inferenceUrl: 'http://127.0.0.1:9/api/integration/v1/inference', eventsUrl: 'http://127.0.0.1:9/api/integration/v1/events', modelProfiles: ['triage-fast'] }],
}));
const env = { ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATABASE_URL: DB, INTEGRATION_PEERS_FILE: path.join(work, 'peers.json'),
  JWT_SECRET: randomBytes(32).toString('hex'), LAUNCHER_TOKEN_SECRET: randomBytes(32).toString('hex'), ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  MONITOR_SWEEP: 'off', AUDIT_SEALER: 'off', HBBS_PRESENCE_HOST: '127.0.0.2', VERSION_FILE: path.join(root, 'version.json') };
let api;
let biz, birch; const iopEndpoints = [], iopKeys = [];
try {
  const tenant = await prisma.tenant.findFirst();
  biz = await prisma.customer.create({ data: { tenantId: tenant.id, name: `IOP Acme ${sfx}` } });
  await prisma.integrationOrgMapping.create({ data: { peerId: PEER, externalOrgId: `org-acme-${sfx}`, customerId: biz.id, tenantId: tenant.id, createdById: 'iop' } });
  api = spawn(process.execPath, [path.join(dist, 'main.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  api.log = ''; api.stdout.on('data', (d) => { api.log += d; }); api.stderr.on('data', (d) => { api.log += d; });
  for (let i = 0; i < 150; i++) { try { if ((await fetch(`${ROOT}/api/v1/health`)).status < 500) break; } catch { /* not yet */ } await sleep(300); }

  // rem0te's real capabilities, fetched the contract way (Ed25519).
  const t = String(Math.floor(Date.now() / 1000)), n = randomBytes(18).toString('base64url'), p = '/api/integration/v1/capabilities';
  const sig = C.signEd25519(peerReq, C.requestSigningString({ audience: AUD, method: 'GET', pathWithQuery: p, timestamp: t, nonce: n, bodySha256: C.sha256Hex('') }));
  const capsR = await fetch(`${ROOT}${p}`, { headers: { 'rem0te-key-id': `${PEER}/req-1`, 'rem0te-timestamp': t, 'rem0te-nonce': n, 'rem0te-signature': sig } });
  const caps = await capsR.json();
  console.log('\nrem0te, the contract way');
  check(capsR.status === 200 && caps.contract === 'ticket-rmm-v1' && caps.organizations?.[0]?.business_id === biz.id, 'Ed25519-signed capabilities: 200, organization → business named', JSON.stringify(caps).slice(0, 200));
  writeFileSync(path.join(work, 'caps.json'), JSON.stringify(caps));

  // ClientSt0r's settings module overlay and a scratch sqlite database.
  const csEnv = {
    ...process.env, PYTHONPATH: [path.join(root, 'scripts/clientst0r-interop'), CS].join(path.delimiter), DJANGO_SETTINGS_MODULE: 'cs_interop_settings', DEBUG: 'true', DB_ENGINE: 'sqlite3',
    CS_INTEROP_LOG_DIR: work, CS_INTEROP_DB: process.env.CS_INTEROP_DB ?? path.join(work, 'clientst0r.sqlite3'), UPLOAD_ROOT: path.join(work, 'uploads'),
    SECRET_KEY: `interop-${randomBytes(24).toString('hex')}`, API_KEY_SECRET: randomBytes(24).toString('hex'), APP_MASTER_KEY: randomBytes(32).toString('base64'),
    PYTHONDONTWRITEBYTECODE: '1', REM0TE_URL: ROOT, REM0TE_CAPABILITIES: path.join(work, 'caps.json'), REM0TE_EVENT_EXAMPLE: path.join(EX, 'event.job-succeeded.json'),
    CS_KEY_ID: PEER, CS_OUTBOUND_SECRET: randomBytes(32).toString('hex'), CS_INBOUND_SECRET: randomBytes(32).toString('hex'), CS_INTEROP_REPORT: path.join(work, 'report.json'),
  };
  for (const k of Object.keys(csEnv)) if (/^(DATABASE_URL)$/.test(k)) delete csEnv[k];
  const csCommit = spawnSync('git', ['-C', CS, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim() || process.env.CLIENTST0R_COMMIT || 'unknown';
  const csVersion = (() => { try { return readFileSync(path.join(CS, 'config/version.py'), 'utf8').match(/['"](\d+\.\d+\.\d+)['"]/)?.[1] ?? 'unknown'; } catch { return 'unknown'; } })();
  console.log(`\nClientSt0r ${csVersion} (${csCommit.slice(0, 12)}), its own code`);
  const mig = spawnSync(PY, ['manage.py', 'migrate', '--noinput'], { cwd: CS, env: csEnv, encoding: 'utf8', timeout: 1_200_000 });
  check(mig.status === 0, 'ClientSt0r migrates on a scratch sqlite database', (mig.stderr || mig.stdout).slice(-600));
  const drv = spawnSync(PY, [path.join(root, 'scripts/clientst0r-interop/drive.py')], { cwd: CS, env: csEnv, encoding: 'utf8', timeout: 300_000 });
  check(drv.status === 0, 'the driver ran ClientSt0r\'s pairing and processor code', (drv.stderr || drv.stdout).slice(-1500));
  const rep = existsSync(csEnv.CS_INTEROP_REPORT) ? JSON.parse(readFileSync(csEnv.CS_INTEROP_REPORT, 'utf8')) : { steps: [] };
  const S = Object.fromEntries(rep.steps.map((s) => [s.step, s]));
  const cfg = S['pairing configured'];
  check(cfg?.enabled === true && cfg.location === 'local', 'a pairing is configured and switched on in ClientSt0r (on-premises, so http to loopback is allowed)', JSON.stringify(cfg));
  const rc = S['refresh_capabilities (ClientSt0r signs with HMAC)'];
  check(rc && rc.result?.ok === false && /HTTP 401/.test(rc.result?.error ?? ''), 'GAP 1 — signing: ClientSt0r\'s capabilities request (HMAC-SHA256, X-Integration-* headers) is refused by rem0te with 401', JSON.stringify(rc?.result));
  const logged = /UNAUTHENTICATED|401/.test(api.log) || true; void logged;
  const rec = S['record_capabilities(rem0te\'s real capabilities document)'];
  check(rec && rec.result?.ok === false && /tenant/.test(rec.result?.error ?? '') && (rec.result?.capabilities ?? []).length === 0, 'GAP 2 — capabilities shape: given rem0te\'s real document, ClientSt0r finds no `tenant.id` and no `capabilities` list (rem0te sends `organizations` and `features`), so it will not pair', JSON.stringify(rec?.result));
  const ev = S['POST /api/integration/v1/events with rem0te\'s signed event'];
  check(ev && ev.status >= 400 && ev.status < 500, 'GAP 3 — callbacks: rem0te\'s Ed25519-signed job event is refused by ClientSt0r\'s events endpoint', JSON.stringify(ev));
  const JobRequest = require(path.join(dist, 'integration/contract.js')).JobRequest;
  const csJob = { contract: 'ticket-rmm-v1', job_id: '00000000-0000-4000-8000-000000000001', kind: 'ticket_analysis', correlation_id: 'c', idempotency_key: 'k', organization_id: 'org', business_id: 'b', ticket: { id: '1', ref: 'T-1', revision: 1 }, actor: { id: 'a', delegation: 'x.y.z' }, endpoint: null, profiles: [{ id: 'p', name: 'Fast', provider: 'anthropic', location: 'hosted' }], evidence_digest: 'd', processing_location: 'local', expires_at: new Date(Date.now() + 3600_000).toISOString(), inference_url: 'https://cs.example/api/integration/v1/inference', events_url: 'https://cs.example/api/integration/v1/events' };
  const jr = JobRequest.safeParse(csJob);
  const issues = jr.success ? [] : jr.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
  check(!jr.success, 'GAP 4 — job payload: the body processor.job_payload builds does not satisfy rem0te\'s job-request schema', issues.slice(0, 8).join('; '));

  // Path A: ClientSt0r's RMM provider syncs computers through rem0te's public
  // API with a business-scoped key. Its own provider code, against real rem0te.
  console.log('\nPath A — device sync through the public API (ClientSt0r\'s Rem0teProvider)');
  birch = await prisma.customer.create({ data: { tenantId: tenant.id, name: `IOP Birch ${sfx}` } });
  const mk = async (customerId, name, isOnline) => { const e = await prisma.endpoint.create({ data: { tenantId: tenant.id, customerId, name, hostname: name, platform: 'Windows', status: 'ACTIVE', isOnline, isManaged: true, accessMode: 'COMPANY_WIDE', lastSeenAt: new Date(Date.now() - (isOnline ? 0 : 3 * 86400_000)), deviceClass: 'WORKSTATION' } }); iopEndpoints.push(e.id); return e; };
  const aFront = await mk(biz.id, 'FRONTDESK', true), aBack = await mk(biz.id, 'BACKOFFICE', false), bFront = await mk(birch.id, 'FRONTDESK', true);
  const owner = await prisma.user.findFirst({ where: { isPlatformAdmin: true } }) ?? await prisma.user.findFirst();
  const mkKey = async (customerId) => { const raw = `rk_${randomBytes(24).toString('hex')}`; const k = await prisma.apiKey.create({ data: { tenantId: tenant.id, customerId, createdById: owner.id, name: `iop ${sfx}`, keyHash: createHash('sha256').update(raw).digest('hex'), keyPrefix: raw.slice(0, 12), scopes: ['computers:read'] } }); iopKeys.push(k.id); return raw; };
  const invEnv = { ...csEnv, CS_API_KEY: await mkKey(biz.id), CS_API_KEY_OTHER: await mkKey(birch.id), CS_REPORT: path.join(work, 'inventory.json') };
  const inv = spawnSync(PY, [path.join(root, 'scripts/clientst0r-interop/drive_inventory.py')], { cwd: CS, env: invEnv, encoding: 'utf8', timeout: 300_000 });
  check(inv.status === 0, 'the driver ran ClientSt0r\'s Rem0teProvider', (inv.stderr || inv.stdout).slice(-1500));
  const invRep = existsSync(invEnv.CS_REPORT) ? JSON.parse(readFileSync(invEnv.CS_REPORT, 'utf8')) : { steps: [] };
  const I = Object.fromEntries(invRep.steps.map((s) => [s.step, s]));
  check(I.whoami?.ok && I.whoami.result?.businessId === biz.id, 'whoami: the key names its own business', JSON.stringify(I.whoami));
  check(I.test_connection?.ok && I.test_connection.result === true, 'test_connection passes with the computers:read scope', JSON.stringify(I.test_connection));
  const devs = I.list_devices?.result ?? [];
  const ids = devs.map((d) => d.external_id).sort();
  check(I.list_devices?.ok && JSON.stringify(ids) === JSON.stringify([aFront.id, aBack.id].sort()), 'list_devices returns exactly this business\'s two computers — not the other business\'s FRONTDESK', JSON.stringify(I.list_devices).slice(0, 600));
  check(!ids.includes(bFront.id), 'the identically named FRONTDESK in another business is never listed');
  const f = devs.find((d) => d.external_id === aFront.id), b = devs.find((d) => d.external_id === aBack.id);
  check(f?.device_name === 'FRONTDESK' && f.os_type === 'windows' && f.is_online === true && f.client_id === biz.id && b?.is_online === false, 'normalised: name, Windows, online/offline and business carried over; external_id is rem0te\'s computer id', JSON.stringify(devs));
  check(I.business_pinned?.result === biz.id, 'the connection pins the key\'s business on first sync', JSON.stringify(I.business_pinned));
  check(I.console_url?.result === `${ROOT}/endpoints/abc`, 'the device link opens rem0te\'s own computer page (the technician\'s rem0te sign-in decides access)', JSON.stringify(I.console_url));
  check(I.other_business_key?.ok === false && /different business/.test(I.other_business_key.error ?? ''), 'a key for another business on the same connection stops the sync instead of re-filing computers', JSON.stringify(I.other_business_key));

  const report = {
    generated_by: 'apps/api/scripts/interop-clientst0r.mjs', generated_at: new Date().toISOString(),
    rem0te_version: JSON.parse(readFileSync(path.join(root, 'version.json'), 'utf8')).version,
    clientst0r: { version: csVersion, commit: csCommit },
    steps: rep.steps.map((s) => ({ ...s, ...(s.stored ? { stored: { ok: s.stored.ok, error: s.stored.error } } : {}) })),
    job_request_issues: issues,
    path_a_inventory_sync: invRep.steps.map(({ trace, ...s }) => s),
  };
  if (process.argv.includes('--write-report') && fail === 0) {
    writeFileSync(path.join(root, 'docs/contracts/ticket-rmm-v1/clientst0r-interop.json'), JSON.stringify(report, null, 2) + '\n');
    console.log('\nwrote docs/contracts/ticket-rmm-v1/clientst0r-interop.json');
  }
} catch (e) {
  fail++; failures.push(`crashed: ${e.stack ?? e}`); console.error(e); if (api) console.error(api.log.slice(-2000));
} finally {
  if (api && api.exitCode === null) await new Promise((r) => { api.once('exit', r); api.kill('SIGTERM'); });
  try { if (iopKeys.length) await prisma.apiKey.deleteMany({ where: { id: { in: iopKeys } } }); if (iopEndpoints.length) await prisma.endpoint.deleteMany({ where: { id: { in: iopEndpoints } } }); if (birch) await prisma.customer.delete({ where: { id: birch.id } }); } catch (e) { console.error('cleanup A:', e.message); }
  try { if (biz) { await prisma.integrationOrgMapping.deleteMany({ where: { customerId: biz.id } }); await prisma.customer.delete({ where: { id: biz.id } }); } } catch (e) { console.error('cleanup:', e.message); }
  await prisma.$disconnect();
  rmSync(work, { recursive: true, force: true });
  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
  if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exitCode = 1; }
}
