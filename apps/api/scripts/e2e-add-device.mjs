#!/usr/bin/env node
/**
 * End-to-end proof of Add device (0.32): the guided flow's server half.
 *
 *   POST /enrollment/tokens            — business and site bound at mint time
 *   GET  /enrollment/tokens/:id/status — has the device arrived, and its first health
 *   POST /enrollment/claim, /heartbeat, /command-result — the real device path
 *
 *   - token creation keeps its permission checks: computers:add is required; a
 *     Business Owner cannot mint for another business by naming it (businessId
 *     or the legacy customerId), nor bind another business's site, and a
 *     foreign site is refused with the same message as a non-existent one;
 *   - the site travels with the token: the claimed device lands in it; a site
 *     deactivated before the claim is dropped (the device still enrols); a
 *     deleted site leaves the token valid with no site;
 *   - status walks waiting → enrolled, and first health fills in only from
 *     what the device really sent: online at claim, agent type after the
 *     first heartbeat, inventory after the first inventory command-result;
 *   - scoping: another business's owner gets a 404 for the token and cannot
 *     see the enrolled device anywhere; a Business User who mints an
 *     ASSIGNED_USERS token for someone else is told the device enrolled but
 *     is not shown it (endpointVisibilityWhere), while a COMPANY_WIDE one is
 *     shown; the Platform Admin sees all of it (the negative control);
 *   - nothing secret leaves the status route: no raw token, no token hash,
 *     no device secret;
 *   - expired and revoked tokens report as such;
 *   - minting needs a fresh re-authentication (0.33): a stale session gets
 *     STEP_UP_REQUIRED and writes nothing, and a scope refusal comes first;
 *   - (0.64) the downloads step 3 offers — the Linux and macOS scripts from
 *     the command's own path-token URL and the Windows .exe — are
 *     attachments carrying the token, and fetching them consumes nothing;
 *   - (0.65) the .msi: refused with no signed agent published, a malformed
 *     token refused before anything is looked up or built, an unusable one
 *     refused rather than dropped; with a stand-in signed repository (and
 *     msitools) real packages read back with msiinfo — the link's token or a
 *     deployment key stamped, none in the generic one — with no build
 *     directory left behind, and nothing consumed.
 *
 * Self-starting: it runs its own API from dist/ on ADDDEVICE_API_PORT (3861)
 * against DATABASE_URL, which must name a scratch/test database. Fixtures are
 * namespaced and removed at the end.
 *
 * Run:  DATABASE_URL=…/rem0te_adddevice_test node scripts/e2e-add-device.mjs
 */
import { PrismaClient } from '@prisma/client';
import { confirmEverythingAsks } from './lib/confirm-asks.mjs';
import argon2 from 'argon2';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const DB = process.env.DATABASE_URL ?? '';
const dbName = DB.split('/').pop()?.split('?')[0] ?? '';
if (!/scratch|test/.test(dbName)) { console.error(`Refusing to run against database "${dbName}": name must contain "scratch" or "test".`); process.exit(2); }
const PORT = Number(process.env.ADDDEVICE_API_PORT ?? 3861);
if ([3000, 3001, 3201, 3202, 443, 4000, 4001].includes(PORT)) { console.error(`Refusing port ${PORT}: production or the shared docs stack.`); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
const VERSION_FILE = path.resolve(here, '..', '..', '..', 'version.json');
const AGENT_VERSION = JSON.parse(readFileSync(VERSION_FILE, 'utf8')).version;
const prisma = new PrismaClient();
// 0.64: every confirmation defaults to off. This suite proves step-ups, so it
// asks for them all before its API reads the policy.
await confirmEverythingAsks(prisma);
const sfx = randomBytes(3).toString('hex');
const PW = 'add-device-e2e-password-1';
const TAG = `AD${sfx}`;

let pass = 0, fail = 0;
const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;

// 0.65: a stand-in signed update repository with an agent target, for the
// .msi (which packages only the signed agent). The API reads the repository
// from disk on every request and nothing here verifies its signatures, so
// plain JSON is enough. Its timestamp is kept aside (`.off`) except around
// the .msi section, so every other check runs as before, with no signed agent.
const REPO = mkdtempSync(path.join(tmpdir(), 'rem0te-adddevice-repo-'));
const FAKE_AGENT = Buffer.concat([Buffer.from('MZ e2e-add-device stand-in for the signed agent '), randomBytes(4096), Buffer.from('REM0TE_INST_URL:'), Buffer.alloc(240)]);
{
  const sha = createHash('sha256').update(FAKE_AGENT).digest('hex');
  mkdirSync(path.join(REPO, 'metadata'), { recursive: true }); mkdirSync(path.join(REPO, 'targets', 'windows'), { recursive: true });
  const meta = (f, signed) => writeFileSync(path.join(REPO, 'metadata', f), JSON.stringify({ signed }));
  meta('root.json', { version: 1 });
  meta('timestamp.json.off', { version: 1, meta: { 'snapshot.json': { version: 1 } } });
  meta('1.snapshot.json', { version: 1, meta: { 'targets.json': { version: 1 } } });
  meta('1.targets.json', { version: 1, targets: { 'windows/rem0te-agent.exe': { length: FAKE_AGENT.length, hashes: { sha256: sha } } } });
  writeFileSync(path.join(REPO, 'targets', 'windows', `${sha}.rem0te-agent.exe`), FAKE_AGENT);
}
const TS = path.join(REPO, 'metadata', 'timestamp.json');
const signedAgent = (on) => { if (on && existsSync(`${TS}.off`)) renameSync(`${TS}.off`, TS); if (!on && existsSync(TS)) renameSync(TS, `${TS}.off`); };
const HAVE_MSI_TOOLS = ['/usr/bin/wixl', '/usr/bin/msibuild', '/usr/bin/msiinfo'].every((p) => existsSync(p));
const MSI_TOOLS_REQUIRED = process.env.CI === 'true' || process.env.REQUIRE_MSI_TOOLS === '1';

const apiEnv = {
  ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATABASE_URL: DB, UPDATE_REPO_DIR: REPO,
  JWT_SECRET: randomBytes(32).toString('hex'), LAUNCHER_TOKEN_SECRET: randomBytes(32).toString('hex'),
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? randomBytes(32).toString('hex'), TRUSTED_PROXIES: 'loopback',
  HBBS_PRESENCE_HOST: '127.0.0.2', MONITOR_SWEEP: 'off', AUDIT_SEALER: 'off', VERSION_FILE,
};
let api;
function startApi() {
  api = spawn(process.execPath, [path.join(dist, 'main.js')], { env: apiEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  api.log = ''; api.stdout.on('data', (d) => { api.log += d; }); api.stderr.on('data', (d) => { api.log += d; });
}
async function stopApi() { if (!api || api.exitCode !== null) return; await new Promise((r) => { api.once('exit', r); api.kill('SIGTERM'); }); }
async function waitUp() {
  for (let i = 0; i < 150; i++) { try { const r = await fetch(`${API}/health`); if (r.status < 500) return; } catch { /* not yet */ } await sleep(300); }
  throw new Error(`api did not come up:\n${api.log.slice(-3000)}`);
}

async function req(method, p, s, body) {
  // A fresh address per request: the global throttler is keyed by client address.
  const h = { 'x-forwarded-for': ip() };
  if (s) h.cookie = s.cookie;
  if (body !== undefined) h['content-type'] = 'application/json';
  const r = await fetch(`${API}${p}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j, data: j?.data, text };
}
async function login(email) {
  const s = { ip: ip() };
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': s.ip }, body: JSON.stringify({ email, password: PW }) });
  const mm = (r.headers.get('set-cookie') ?? '').match(/access_token=([^;]+)/);
  if (r.status !== 200 || !mm) throw new Error(`login ${email}: ${r.status} ${await r.text()}`);
  s.cookie = `access_token=${mm[1]}`;
  return s;
}
/**
 * Minting a token needs a fresh re-authentication (0.33). The session keeps
 * its plain cookie in `bare` (a stale session, for the refusal checks) and
 * carries the step-up from here on, as the console's retried request does.
 */
async function stepUp(s) {
  const r = await fetch(`${API}/auth/step-up`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip(), cookie: s.cookie }, body: JSON.stringify({ password: PW }) });
  const mm = (r.headers.get('set-cookie') ?? '').match(/step_up=([^;]+)/);
  if (r.status !== 200 || !mm) throw new Error(`step-up: ${r.status} ${await r.text()}`);
  s.bare = s.bare ?? s.cookie;
  s.cookie = `${s.bare}; step_up=${mm[1]}`;
  return s;
}
const mint = (s, body) => req('POST', '/enrollment/tokens', s, body);
const status = (s, id) => req('GET', `/enrollment/tokens/${id}/status`, s);
const msg = (r) => `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`;
const rid = () => String(100000000 + ((Math.random() * 899999999) | 0));
const secret = () => randomBytes(24).toString('base64url');
const claim = (token, rustdeskId, agentSecret, hostname) =>
  req('POST', '/enrollment/claim', null, { token, rustdeskId, hostname, platform: 'Windows', osVersion: '10.0.22631', agentSecret, agentVersion: AGENT_VERSION });

const created = { businesses: [], users: [], rustdeskIds: [] };

async function all() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });
  const roleUser = await prisma.role.findFirst({ where: { type: 'BUSINESS_USER' } });

  section('Fixtures (synthetic): Business A (four sites, one inactive) and Business B (one site)');
  const A = await prisma.customer.create({ data: { tenantId: tenant.id, name: `${TAG} Acme` } });
  const B = await prisma.customer.create({ data: { tenantId: tenant.id, name: `${TAG} Birch` } });
  created.businesses.push(A.id, B.id);
  const siteA = await prisma.site.create({ data: { tenantId: tenant.id, customerId: A.id, name: `${TAG} HQ` } });
  const siteAOld = await prisma.site.create({ data: { tenantId: tenant.id, customerId: A.id, name: `${TAG} Closed`, isActive: false } });
  const siteA3 = await prisma.site.create({ data: { tenantId: tenant.id, customerId: A.id, name: `${TAG} Depot` } });
  const siteA4 = await prisma.site.create({ data: { tenantId: tenant.id, customerId: A.id, name: `${TAG} Annex` } });
  const siteB = await prisma.site.create({ data: { tenantId: tenant.id, customerId: B.id, name: `${TAG} Birch HQ` } });

  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag, extra = {}) => { const u = await prisma.user.create({ data: { email: `ad-${tag}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'AD', lastName: tag, status: 'ACTIVE', ...extra } }); created.users.push(u.id); return u; };
  const admin = await mkUser('admin', { isPlatformAdmin: true });
  const ownerA = await mkUser('owner-a'), ownerB = await mkUser('owner-b');
  const userA = await mkUser('user-a'), colleagueA = await mkUser('colleague-a'), viewOnlyA = await mkUser('viewonly-a'), addOnlyA = await mkUser('addonly-a');
  await prisma.membership.create({ data: { userId: ownerA.id, tenantId: tenant.id, customerId: A.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: ownerB.id, tenantId: tenant.id, customerId: B.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: userA.id, tenantId: tenant.id, customerId: A.id, roleId: roleUser.id, capabilities: ['computers:view', 'computers:add'] } });
  await prisma.membership.create({ data: { userId: colleagueA.id, tenantId: tenant.id, customerId: A.id, roleId: roleUser.id, capabilities: ['computers:view'] } });
  await prisma.membership.create({ data: { userId: viewOnlyA.id, tenantId: tenant.id, customerId: A.id, roleId: roleUser.id, capabilities: ['computers:view'] } });
  await prisma.membership.create({ data: { userId: addOnlyA.id, tenantId: tenant.id, customerId: A.id, roleId: roleUser.id, capabilities: ['computers:add'] } });
  check(true, 'created A (4 sites), B (1 site), 8 users');

  // 3201 is the approval signer's public port on this host, which is why the
  // default moved off it in 0.56.
  // (docs/approved-actions.md). If anything already answers there, this suite
  // would be talking to it rather than to the API it starts: refuse.
  const busy = await fetch(`${API}/health`).then(() => true, () => false);
  if (busy) throw new Error(`port ${PORT} is already in use; set ADDDEVICE_API_PORT to a free scratch port`);
  startApi();
  await waitUp();
  const S = {
    admin: await login(admin.email), ownerA: await login(ownerA.email), ownerB: await login(ownerB.email),
    userA: await login(userA.email), viewOnlyA: await login(viewOnlyA.email), addOnlyA: await login(addOnlyA.email),
  };

  // ── Step-up (0.33): a stale session mints nothing ─────────────────────────
  section('Minting needs a fresh re-authentication (0.33)');
  let r = await mint(S.ownerA, { businessId: A.id, siteId: siteA.id, accessMode: 'COMPANY_WIDE', description: 'Add device: stale' });
  check(r.status === 403 && r.body?.code === 'STEP_UP_REQUIRED' && r.body?.action === 'enrollment.create', 'owner A without a step-up: 403 STEP_UP_REQUIRED (enrollment.create)', msg(r));
  r = await mint(S.ownerA, { businessId: B.id, accessMode: 'COMPANY_WIDE' });
  check(r.status === 403 && r.body?.code !== 'STEP_UP_REQUIRED', 'owner A naming business B without a step-up: refused on scope, not asked to re-authenticate', msg(r));
  const staleRows = await prisma.deviceClaimToken.count({ where: { customerId: { in: [A.id, B.id] } } });
  check(staleRows === 0, 'no token row was written by the refused attempts', `rows: ${staleRows}`);
  for (const k of ['admin', 'ownerA', 'ownerB', 'userA', 'viewOnlyA', 'addOnlyA']) await stepUp(S[k]);
  check(true, 'every session steps up (password); the rest of this suite mints as the console does after the dialog');

  // ── Minting: the existing permission checks, plus the site ────────────────
  section('Minting a token: business and site are fixed, and only where the caller may manage');
  r = await mint(S.ownerA, { businessId: A.id, siteId: siteA.id, accessMode: 'COMPANY_WIDE', description: 'Add device: Windows' });
  const t1 = r.data;
  check(r.status === 201 || r.status === 200, 'owner A mints a token for A with site HQ', msg(r));
  check(/^[0-9a-f]{64}$/.test(t1?.token ?? '') && t1.siteId === siteA.id && t1.siteName === siteA.name && t1.customerId === A.id, 'the creation response carries the raw token once, and the site binding', JSON.stringify({ siteId: t1?.siteId, siteName: t1?.siteName }));
  const row1 = await prisma.deviceClaimToken.findUnique({ where: { id: t1.id } });
  check(row1.token === createHash('sha256').update(t1.token).digest('hex') && row1.token !== t1.token, 'only the hash is stored');
  const audit1 = await prisma.activityLog.findFirst({ where: { action: 'CLAIM_TOKEN_CREATED', resourceId: t1.id } });
  check(audit1?.customerId === A.id && audit1?.metadata?.siteId === siteA.id && audit1?.actorId === ownerA.id, 'minting is audited with the business, site and actor', JSON.stringify(audit1?.metadata));

  r = await mint(S.ownerA, { businessId: B.id, accessMode: 'COMPANY_WIDE' });
  check(r.status === 403, 'owner A naming business B is refused (403)', msg(r));
  r = await mint(S.ownerA, { customerId: B.id, accessMode: 'COMPANY_WIDE' });
  check(r.status === 403, 'owner A naming business B through the legacy customerId is refused (403)', msg(r));
  r = await mint(S.ownerA, { businessId: B.id, siteId: siteB.id, accessMode: 'COMPANY_WIDE' });
  check(r.status === 403, 'owner A naming B and B\'s site is refused (403)', msg(r));
  const foreignSite = await mint(S.ownerA, { businessId: A.id, siteId: siteB.id, accessMode: 'COMPANY_WIDE' });
  const missingSite = await mint(S.ownerA, { businessId: A.id, siteId: 'c' + randomBytes(12).toString('hex'), accessMode: 'COMPANY_WIDE' });
  check(foreignSite.status === 400 && /Unknown site for this business/.test(foreignSite.body?.message), 'owner A binding B\'s site to an A token is refused (400)', msg(foreignSite));
  check(missingSite.status === 400 && missingSite.body?.message === foreignSite.body?.message, 'a foreign site and a non-existent site get the same answer (no probing)', `${foreignSite.body?.message} / ${missingSite.body?.message}`);
  r = await mint(S.ownerA, { siteId: siteB.id, accessMode: 'COMPANY_WIDE' });
  check(r.status === 400, 'owner A with no business named and B\'s site: the token is A\'s, and B\'s site is refused', msg(r));
  r = await mint(S.ownerA, { businessId: A.id, siteId: siteAOld.id, accessMode: 'COMPANY_WIDE' });
  check(r.status === 400, 'an inactive site is refused', msg(r));
  r = await mint(S.ownerA, { businessId: A.id, accessMode: 'ASSIGNED_USERS', assignedUserIds: [ownerB.id] });
  check(r.status === 400, 'assigning a user of another business is refused (unchanged rule)', msg(r));
  r = await mint(S.viewOnlyA, { businessId: A.id, accessMode: 'COMPANY_WIDE' });
  check(r.status === 403, 'without computers:add, minting is refused (403)', msg(r));
  r = await mint(S.admin, { accessMode: 'COMPANY_WIDE' });
  check(r.status === 403, 'a Platform Admin must name a business', msg(r));
  const leaked = await prisma.deviceClaimToken.count({ where: { customerId: B.id } });
  check(leaked === 0, 'after every refused attempt, business B has no tokens at all', `B tokens: ${leaked}`);

  // ── 0.64: the downloads step 3 offers ───────────────────────────────────
  section('0.64: the installer downloads Add device offers carry the token, are attachments, and consume nothing');
  {
    const get = async (p) => { const res = await fetch(`${API}${p}`, { headers: { 'x-forwarded-for': ip() } }); const buf = Buffer.from(await res.arrayBuffer()); return { status: res.status, cd: res.headers.get('content-disposition') ?? '', ct: res.headers.get('content-type') ?? '', cc: res.headers.get('cache-control') ?? '', buf }; };
    for (const [os, file] of [['linux', 'install-rustdesk.sh'], ['mac', 'install-rustdesk-macos.sh']]) {
      const d = await get(`/public/install/${os}/${t1.token}`);
      check(d.status === 200 && d.cd === `attachment; filename="${file}"` && /no-store/.test(d.cc) && d.buf.toString('utf8').includes(t1.token),
        `${os}: the Download button's URL (the command's own path-token URL) is an attachment named ${file}, not cached, carrying the token`, `${d.status} ${d.cd} ${d.cc}`);
    }
    const exe = await get(`/public/install/windows.exe?token=${t1.token}`);
    // A test build may have no installer binary (503); when it has one, it is an attachment with the token in its slot.
    check((exe.status === 200 && exe.cd === 'attachment; filename="install-reboot-remote.exe"' && exe.ct.startsWith('application/octet-stream') && /no-store/.test(exe.cc) && exe.buf.includes(Buffer.from(t1.token)))
      || exe.status === 503, 'windows: the Download .exe URL is an attachment named install-reboot-remote.exe with the token in it (or 503 without an installer build)', `${exe.status} ${exe.cd}`);
    const row = await prisma.deviceClaimToken.findUnique({ where: { id: t1.id } });
    check(row.claimedAt === null && row.expiresAt > new Date(), 'downloading every installer consumed nothing: the token is still unclaimed and unexpired');
  }

  // ── 0.65: the .msi ──────────────────────────────────────────────────────
  section('0.65: the .msi — the token rules of the .exe, refused before anything is built, and it consumes nothing');
  {
    const get = async (p) => { const res = await fetch(`${API}${p}`, { headers: { 'x-forwarded-for': ip() } }); const buf = Buffer.from(await res.arrayBuffer()); let j = null; try { j = JSON.parse(buf.toString('utf8')); } catch { /* binary */ } return { status: res.status, cd: res.headers.get('content-disposition') ?? '', ct: res.headers.get('content-type') ?? '', cc: res.headers.get('cache-control') ?? '', buf, code: j?.code }; };
    const msiDirs = () => readdirSync(tmpdir()).filter((n) => n.startsWith('rem0te-msi-')).length;
    const dirsBefore = msiDirs();
    // A deployment key (§70), written directly: 96 hex, only its hash stored.
    const key = randomBytes(48).toString('hex');
    const keyRow = await prisma.deploymentKey.create({ data: {
      tenantId: A.tenantId, customerId: A.id, name: `${TAG} msi`, keyHash: createHash('sha256').update(key).digest('hex'), keyHint: key.slice(-4),
      maxUses: 5, expiresAt: new Date(Date.now() + 86_400_000), createdById: admin.id,
    } });
    const tExpForMsi = (await mint(S.ownerA, { businessId: A.id, accessMode: 'COMPANY_WIDE', description: 'Add device: msi expired' })).data;
    await prisma.deviceClaimToken.update({ where: { id: tExpForMsi.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });

    signedAgent(false);
    let d = await get(`/public/install/windows.msi?token=${t1.token}`);
    check(d.status === 503 && d.code === 'MSI_NEEDS_SIGNED_AGENT' && /no-store/.test(d.cc), 'no signed agent published: 503 MSI_NEEDS_SIGNED_AGENT (only the signed agent takes a token on its command line)', `${d.status} ${d.code}`);
    signedAgent(true);
    for (const [label, bad] of [['a quote', `${t1.token.slice(0, 20)}%22`], ['a space', `${t1.token.slice(0, 20)}%20--portal%20evil.example`], ['15 hex', t1.token.slice(0, 15)], ['non-hex', 'z'.repeat(64)]]) {
      d = await get(`/public/install/windows.msi?token=${bad}`);
      check(d.status === 400 && d.code === 'MSI_TOKEN_INVALID', `a token with ${label}: 400 MSI_TOKEN_INVALID, before any lookup or build`, `${d.status} ${d.code}`);
    }
    d = await get(`/public/install/windows.msi?token=${randomBytes(32).toString('hex')}`);
    check(d.status === 400 && d.code === 'ENROLLMENT_TOKEN_UNUSABLE', 'a well-formed token that is no token: 400 ENROLLMENT_TOKEN_UNUSABLE (not a package silently missing it)', `${d.status} ${d.code}`);
    d = await get(`/public/install/windows.msi?token=${tExpForMsi.token}`);
    check(d.status === 400 && d.code === 'ENROLLMENT_TOKEN_UNUSABLE', 'an expired token: 400 ENROLLMENT_TOKEN_UNUSABLE', `${d.status} ${d.code}`);
    check(msiDirs() === dirsBefore, 'nothing refused above made a build directory');

    const stamped = await get(`/public/install/windows.msi?token=${t1.token}`);
    const generic = await get('/public/install/windows.msi');
    const keyed = await get(`/public/install/windows.msi?token=${key}`);
    if (!HAVE_MSI_TOOLS) {
      check(!MSI_TOOLS_REQUIRED && stamped.status === 503 && stamped.code === 'MSI_BUILDER_UNAVAILABLE',
        'without msitools: 503 MSI_BUILDER_UNAVAILABLE, a clear code rather than a 500 (and under CI msitools must be installed)', `${stamped.status} ${stamped.code}`);
      console.log('  \x1b[33m–\x1b[0m the package checks were skipped: wixl / msibuild / msiinfo are not installed (apt-get install -y wixl msitools).');
    } else {
      check(stamped.status === 200 && stamped.ct.startsWith('application/x-msi') && stamped.cd === 'attachment; filename="rem0te.msi"' && /no-store/.test(stamped.cc),
        'the Download .msi URL: 200, application/x-msi, an attachment named rem0te.msi, not cached', `${stamped.status} ${stamped.ct} ${stamped.cd}`);
      const work = mkdtempSync(path.join(tmpdir(), 'e2e-adddevice-msi-'));
      const prop = (buf, name) => { const f = path.join(work, `${name}.msi`); writeFileSync(f, buf); return Object.fromEntries(execFileSync('/usr/bin/msiinfo', ['export', f, 'Property'], { encoding: 'utf8' }).split(/\r?\n/).slice(3).filter(Boolean).map((l) => l.split('\t'))); };
      const ca = (buf) => { const f = path.join(work, 'ca.msi'); writeFileSync(f, buf); return execFileSync('/usr/bin/msiinfo', ['export', f, 'CustomAction'], { encoding: 'utf8' }); };
      const ps = prop(stamped.buf, 'stamped'), pg = prop(generic.buf, 'generic'), pk = prop(keyed.buf, 'keyed');
      check(ps.TOKEN === t1.token, 'msiinfo: the stamped package\'s Property table carries exactly this link\'s token', ps.TOKEN);
      check(generic.status === 200 && !('TOKEN' in pg), 'without a token: the generic package, with no TOKEN (msiexec /i rem0te.msi TOKEN=… /qn)');
      check(keyed.status === 200 && pk.TOKEN === key, 'a 96-hex deployment key is stamped exactly as a claim token is', `${keyed.status} ${keyed.code}`);
      check(ps.Rem0tePortal === `127.0.0.1:${PORT}` && pg.Rem0tePortal === ps.Rem0tePortal, 'the portal is the address the .exe\'s slot would name (here the request host, no public address being configured)', ps.Rem0tePortal);
      check(/Rem0teInstall\t3074\tRem0teAgent\tinstall --token \[TOKEN\] --portal \[Rem0tePortal\]/.test(ca(stamped.buf)), 'its one custom action runs the signed agent: install --token [TOKEN] --portal [Rem0tePortal]');
      writeFileSync(path.join(work, 'x.msi'), stamped.buf);
      check(Buffer.compare(execFileSync('/usr/bin/msiinfo', ['extract', path.join(work, 'x.msi'), 'Binary.Rem0teAgent']), FAKE_AGENT) === 0, 'the agent inside is the published target, byte for byte');
      rmSync(work, { recursive: true, force: true });
      check(msiDirs() === dirsBefore, 'the API removed every build directory it made');
    }
    const rowAfter = await prisma.deviceClaimToken.findUnique({ where: { id: t1.id } });
    const keyAfter = await prisma.deploymentKey.findUnique({ where: { id: keyRow.id } });
    check(rowAfter.claimedAt === null && rowAfter.expiresAt > new Date() && keyAfter.useCount === 0 && keyAfter.lastUsedAt === null,
      'downloading the .msi consumed nothing: the token is unclaimed, the deployment key has used none', JSON.stringify({ claimedAt: rowAfter.claimedAt, useCount: keyAfter.useCount }));
    signedAgent(false);
    await prisma.deploymentKey.delete({ where: { id: keyRow.id } });
  }

  // ── Status: waiting, scoped, nothing secret ───────────────────────────────
  section('Status while waiting: scoped to the business, and nothing secret in it');
  r = await status(S.ownerA, t1.id);
  check(r.status === 200 && r.data.state === 'waiting' && r.data.device === null && r.data.token.siteId === siteA.id && r.data.token.businessId === A.id, 'owner A: waiting, bound to A / HQ', msg(r));
  check(!r.text.includes(t1.token) && !r.text.includes(row1.token) && !/"token":"/.test(r.text), 'the status body carries neither the token nor its hash');
  r = await status(S.ownerB, t1.id);
  check(r.status === 404, 'owner B asking for A\'s token gets 404', msg(r));
  r = await status(S.addOnlyA, t1.id);
  check(r.status === 403, 'without computers:view the status route is refused', msg(r));
  r = await status(S.ownerA, 'c' + randomBytes(12).toString('hex'));
  check(r.status === 404, 'an unknown token id is 404', msg(r));
  r = await status(S.admin, t1.id);
  check(r.status === 200 && r.data.state === 'waiting', 'negative control: the Platform Admin can read A\'s token');

  // ── The real device path ──────────────────────────────────────────────────
  section('The device arrives: claim → heartbeat → inventory, and status follows each step');
  const dev1 = { rid: rid(), secret: secret(), host: `${TAG}-WS01` };
  created.rustdeskIds.push(dev1.rid);
  r = await claim(t1.token, dev1.rid, dev1.secret, dev1.host);
  check(r.status === 200 && r.data?.endpoint?.id, 'the installer claims the token', msg(r));
  const ep1 = r.data?.endpoint?.id;
  r = await status(S.ownerA, t1.id);
  const d = r.data?.device;
  check(r.status === 200 && r.data.state === 'enrolled' && r.data.deviceVisible === true && d?.id === ep1, 'status: enrolled, and the device is the one that claimed', msg(r));
  check(d?.customer?.id === A.id && d?.site?.id === siteA.id && d?.customerId === A.id, 'the device landed in A, site HQ — the token\'s binding', JSON.stringify({ customer: d?.customer, site: d?.site }));
  check(d?.isOnline === true && d?.agentBound === true, 'first health: online at claim, device secret bound');
  check(d?.agentType === 'none' && d?.inventoryCollectedAt === null, 'before any heartbeat: no agent type and no inventory are claimed', JSON.stringify({ agentType: d?.agentType, inv: d?.inventoryCollectedAt }));
  check(!r.text.includes(dev1.secret) && !/agentSecretHash/.test(r.text), 'the status body carries no device secret or its hash');

  // 0.68: the installer's own check-ins (Register: a version, no live state;
  // the Test-Registered poll: every 5 s for up to 90) are handed no command.
  // They used to be, and each hand-out counted towards the four allowed, so a
  // slow RustDesk registration failed the first inventory before the agent beat.
  for (let i = 0; i < 6; i++) {
    r = await req('POST', '/enrollment/heartbeat', null, { rustdeskId: dev1.rid, agentSecret: dev1.secret, hostname: dev1.host, platform: 'Windows', agentVersion: AGENT_VERSION });
    if (r.status !== 200 || (r.data?.commands ?? []).length) break;
  }
  check(r.status === 200 && (r.data?.commands ?? []).length === 0, 'six installer check-ins (no live state): accepted, and handed no command', msg(r));
  const cmdsBefore = await prisma.endpointCommand.findMany({ where: { endpointId: ep1 }, select: { type: true, dispatchCount: true, status: true } });
  check(cmdsBefore.every((c) => c.dispatchCount === 0 && c.status !== 'FAILED'), 'nothing was dispatched to them, so nothing was failed for want of an answer', JSON.stringify(cmdsBefore));
  const s0 = await status(S.ownerA, t1.id);
  check(s0.data?.device?.inventoryCollectedAt === null && !s0.data?.device?.inventoryAsk?.dispatchedAt, 'status: no inventory, and not yet asked of the agent');

  r = await req('POST', '/enrollment/heartbeat', null, { rustdeskId: dev1.rid, agentSecret: dev1.secret, hostname: dev1.host, platform: 'Windows', agentVersion: AGENT_VERSION, loggedOnUser: 'WS01\\user', uptimeSeconds: 120 });
  check(r.status === 200 && r.data?.authenticated !== false, 'the agent\'s first heartbeat is accepted', msg(r));
  const inv = (r.data?.commands ?? []).find((c) => c.type === 'INVENTORY_REFRESH');
  let s1 = await status(S.ownerA, t1.id);
  check(s1.data?.device?.inventoryAsk?.status === 'DISPATCHED' && !!s1.data.device.inventoryAsk.dispatchedAt, 'status: the inventory was asked of the agent, and when', JSON.stringify(s1.data?.device?.inventoryAsk));
  check(s1.data?.device?.agentType === 'standard' && s1.data?.device?.agentVersion === AGENT_VERSION, 'after the heartbeat: standard agent, with its version', JSON.stringify(s1.data?.device && { t: s1.data.device.agentType, v: s1.data.device.agentVersion }));
  check(s1.data?.device?.inventoryCollectedAt === null, 'inventory is still not claimed before the agent sends it');
  check(!!inv, 'the heartbeat hands the agent an inventory command', JSON.stringify(r.data?.commands));
  if (inv) {
    r = await req('POST', '/enrollment/command-result', null, { rustdeskId: dev1.rid, agentSecret: dev1.secret, commandId: inv.id, ok: true, inventory: { osCaption: 'Microsoft Windows 11 Pro', manufacturer: 'Scratch', model: 'E2E', cpuCores: 4 } });
    check(r.status === 200, 'the agent reports its inventory', msg(r));
    s1 = await status(S.ownerA, t1.id);
    check(!!s1.data?.device?.inventoryCollectedAt && s1.data.device.osCaption === 'Microsoft Windows 11 Pro', 'status: inventory received, with what the agent reported', JSON.stringify(s1.data?.device && { at: s1.data.device.inventoryCollectedAt, os: s1.data.device.osCaption }));
  }
  r = await claim(t1.token, rid(), secret(), `${TAG}-AGAIN`);
  check(r.status === 400, 'the token cannot be claimed a second time', msg(r));

  // ── Scoping of the enrolled device ────────────────────────────────────────
  section('Another business cannot see the token or the device it enrolled');
  r = await status(S.ownerB, t1.id);
  check(r.status === 404, 'owner B: A\'s enrolled token is still 404', msg(r));
  r = await req('GET', `/endpoints/list?search=${encodeURIComponent(TAG)}`, S.ownerB);
  check(r.status === 200 && !(r.data?.rows ?? []).some((x) => x.id === ep1), 'owner B: the device is not in B\'s device list', msg(r));
  r = await req('GET', `/endpoints/${ep1}`, S.ownerB);
  check(r.status === 404 || r.status === 403, 'owner B: the device page is refused', msg(r));
  r = await req('GET', `/enrollment/tokens`, S.ownerB);
  check(r.status === 200 && !(r.data ?? []).some((x) => x.id === t1.id), 'owner B: the token is not in B\'s token list');
  r = await req('GET', `/endpoints/list?search=${encodeURIComponent(TAG)}`, S.ownerA);
  check(r.status === 200 && (r.data?.rows ?? []).some((x) => x.id === ep1 && x.site?.id === siteA.id), 'owner A: the device is in A\'s list, at site HQ', JSON.stringify((r.data?.rows ?? []).map((x) => x.site)));
  r = await status(S.admin, t1.id);
  check(r.status === 200 && r.data.device?.id === ep1, 'negative control: the Platform Admin sees the enrolled device');

  section('A Business User sees only what endpoint visibility allows them');
  r = await mint(S.userA, { businessId: A.id, accessMode: 'ASSIGNED_USERS', assignedUserIds: [colleagueA.id] });
  const tHidden = r.data;
  check(r.status === 201 || r.status === 200, 'user A (computers:add) mints an ASSIGNED_USERS token for a colleague', msg(r));
  r = await mint(S.userA, { businessId: B.id, accessMode: 'COMPANY_WIDE' });
  check(r.status === 403, 'user A naming business B is refused', msg(r));
  const dev2 = { rid: rid(), secret: secret() }; created.rustdeskIds.push(dev2.rid);
  r = await claim(tHidden.token, dev2.rid, dev2.secret, `${TAG}-COLLEAGUE`);
  check(r.status === 200, 'the colleague\'s device enrols', msg(r));
  const ep2 = r.data?.endpoint?.id;
  r = await status(S.userA, tHidden.id);
  check(r.status === 200 && r.data.state === 'enrolled' && r.data.deviceVisible === false && r.data.device === null, 'user A: told it enrolled, but not shown a device they may not see', msg(r));
  check(!r.text.includes(ep2), 'user A: not even its id');
  r = await status(S.ownerA, tHidden.id);
  check(r.status === 200 && r.data.device?.id === ep2, 'owner A sees that device (owners are unrestricted in their business)');
  r = await mint(S.userA, { businessId: A.id, siteId: siteA3.id, accessMode: 'COMPANY_WIDE' });
  const tWide = r.data;
  const dev3 = { rid: rid(), secret: secret() }; created.rustdeskIds.push(dev3.rid);
  await claim(tWide.token, dev3.rid, dev3.secret, `${TAG}-SHARED`);
  r = await status(S.userA, tWide.id);
  check(r.status === 200 && r.data.deviceVisible === true && r.data.device?.site?.id === siteA3.id, 'user A: a COMPANY_WIDE device is shown, at the site they chose', msg(r));

  // ── Sites that change under a live token ──────────────────────────────────
  section('A site that changes between mint and claim');
  r = await mint(S.ownerA, { businessId: A.id, siteId: siteA4.id, accessMode: 'COMPANY_WIDE' });
  const tClosed = r.data;
  await prisma.site.update({ where: { id: siteA4.id }, data: { isActive: false } });
  const dev4 = { rid: rid(), secret: secret() }; created.rustdeskIds.push(dev4.rid);
  r = await claim(tClosed.token, dev4.rid, dev4.secret, `${TAG}-CLOSED`);
  const ep4 = r.data?.endpoint?.id;
  const ep4row = ep4 ? await prisma.endpoint.findUnique({ where: { id: ep4 } }) : null;
  check(r.status === 200 && ep4row?.customerId === A.id && ep4row?.siteId === null, 'a site deactivated before the claim is dropped; the device still enrols into A', JSON.stringify({ status: r.status, site: ep4row?.siteId }));
  const siteGone = await prisma.site.create({ data: { tenantId: tenant.id, customerId: A.id, name: `${TAG} Temporary` } });
  r = await mint(S.ownerA, { businessId: A.id, siteId: siteGone.id, accessMode: 'COMPANY_WIDE' });
  const tGone = r.data;
  await prisma.site.delete({ where: { id: siteGone.id } });
  const tGoneRow = await prisma.deviceClaimToken.findUnique({ where: { id: tGone.id } });
  check(tGoneRow && tGoneRow.siteId === null, 'deleting a site keeps the token, without the site (SET NULL)');

  // ── Expired and revoked ───────────────────────────────────────────────────
  section('Expired and revoked links');
  r = await mint(S.ownerA, { businessId: A.id, accessMode: 'COMPANY_WIDE' });
  const tExp = r.data;
  await prisma.deviceClaimToken.update({ where: { id: tExp.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });
  r = await status(S.ownerA, tExp.id);
  check(r.status === 200 && r.data.state === 'expired' && r.data.device === null, 'an unused, expired token reports expired', msg(r));
  r = await claim(tExp.token, rid(), secret(), `${TAG}-LATE`);
  check(r.status === 400, 'and cannot be claimed', msg(r));
  r = await mint(S.ownerA, { businessId: A.id, accessMode: 'COMPANY_WIDE' });
  const tRev = r.data;
  r = await req('DELETE', `/enrollment/tokens/${tRev.id}`, S.ownerB);
  check(r.status === 404, 'owner B cannot revoke A\'s token', msg(r));
  r = await req('DELETE', `/enrollment/tokens/${tRev.id}`, S.ownerA);
  check(r.status === 200, 'owner A revokes a waiting token', msg(r));
  r = await status(S.ownerA, tRev.id);
  check(r.status === 404, 'a revoked token is gone (404), which the page reports as revoked', msg(r));

  section('A Platform Admin adding a device to B');
  r = await mint(S.admin, { businessId: B.id, siteId: siteB.id, accessMode: 'COMPANY_WIDE' });
  const tB = r.data;
  check((r.status === 201 || r.status === 200) && tB.siteId === siteB.id, 'admin mints for B with B\'s site', msg(r));
  const dev5 = { rid: rid(), secret: secret() }; created.rustdeskIds.push(dev5.rid);
  r = await claim(tB.token, dev5.rid, dev5.secret, `${TAG}-BIRCH`);
  const ep5 = r.data?.endpoint?.id;
  r = await status(S.ownerB, tB.id);
  check(r.status === 200 && r.data.device?.id === ep5 && r.data.device.site?.id === siteB.id, 'owner B sees the device the admin added to B', msg(r));
  r = await status(S.ownerA, tB.id);
  check(r.status === 404, 'owner A cannot see B\'s token or device', msg(r));
}

async function cleanup() {
  await stopApi();
  rmSync(REPO, { recursive: true, force: true });
  try {
    const ids = created.businesses;
    await prisma.deploymentKey.deleteMany({ where: { customerId: { in: ids } } });
    const eps = await prisma.endpoint.findMany({ where: { customerId: { in: ids } }, select: { id: true } });
    const epIds = eps.map((e) => e.id);
    await prisma.deviceClaimToken.deleteMany({ where: { OR: [{ customerId: { in: ids } }, { endpointId: { in: epIds } }] } });
    await prisma.endpointCommand.deleteMany({ where: { endpointId: { in: epIds } } });
    await prisma.endpointInventory.deleteMany({ where: { endpointId: { in: epIds } } });
    await prisma.computerAccess.deleteMany({ where: { endpointId: { in: epIds } } });
    await prisma.rustdeskNode.deleteMany({ where: { OR: [{ endpointId: { in: epIds } }, { rustdeskId: { in: created.rustdeskIds } }] } });
    await prisma.monitorAlert.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.endpoint.deleteMany({ where: { id: { in: epIds } } });
    await prisma.site.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.membership.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.customer.deleteMany({ where: { id: { in: ids } } });
    if (created.users.length) await prisma.user.deleteMany({ where: { id: { in: created.users } } });
  } catch (e) { console.error('cleanup:', e.message); }
  await prisma.$disconnect();
}

all()
  .catch((e) => { fail++; failures.push(`fatal: ${e.stack ?? e.message}`); console.error(e); })
  .finally(async () => {
    await cleanup();
    console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
    if (failures.length) { for (const f of failures) console.log(`  - ${f}`); if (api?.log) console.log(`\n── API output (last 4000 characters)\n${api.log.slice(-4000)}`); process.exit(1); }
    process.exit(0);
  });
