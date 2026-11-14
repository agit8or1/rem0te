#!/usr/bin/env node
/**
 * End-to-end proof of 0.43: browsing the whole winget index as a paged
 * table, and building the global and a business's software catalog by
 * selection (POST software/winget/catalog/bulk).
 *
 * Self-contained: the compiled API on its own port (3721) against a scratch
 * database, and a loopback stand-in for raw.githubusercontent.com/microsoft/
 * winget-pkgs (3722). The index itself is written straight into the
 * WingetPackage table (the reading of it is e2e-software-catalog.mjs's to
 * prove), with 240 synthetic packages so there is something to page through.
 * No approval signer is configured: adding to a catalog never needs one.
 * Nothing is fetched from the internet.
 *
 *   cd apps/api && npx nest build
 *   DATABASE_URL=postgresql://…/<name with scratch or test> node scripts/e2e-software-browse.mjs
 *
 * It refuses a database that already holds a winget index, and removes its
 * own index rows, catalog entries, businesses and users when it finishes.
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { URLSearchParams, fileURLToPath } from 'node:url';
import path from 'node:path';


const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');

const DB = process.env.DATABASE_URL ?? '';
const dbName = DB.split('/').pop()?.split('?')[0] ?? '';
if (!/scratch|test/.test(dbName)) {
  console.error(`Refusing to run against database "${dbName}": name must contain "scratch" or "test".`);
  process.exit(2);
}
const PORT = Number(process.env.SWB_API_PORT ?? 3721);
const MANIFESTS = Number(process.env.SWB_MANIFEST_PORT ?? 3722);
if ([PORT, MANIFESTS].some((p) => [3000, 3001, 443, 3201, 3202, 4000, 4001].includes(p))) { console.error('refusing a production port'); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'software-browse-e2e-password-123';

let pass = 0, fail = 0; const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const up = (s) => sha(s).toUpperCase();

// ── The winget-pkgs stand-in ────────────────────────────────────────────────
const exeManifest = (id, v, name) => `PackageIdentifier: ${id}
PackageVersion: "${v}"
InstallerLocale: en-US
Scope: machine
Installers:
- Architecture: x64
  InstallerType: exe
  InstallerUrl: https://example.com/${id}-${v}.exe
  InstallerSha256: ${up(`${id} ${v} x64`)}
  ProductCode: ${name}
ManifestType: installer
ManifestVersion: 1.9.0
`;
const fixtures = {
  '7/7zip/7zip/24.09/7zip.7zip.installer.yaml': exeManifest('7zip.7zip', '24.09', '7-Zip'),
  'n/Notepad++/Notepad++/8.7.4/Notepad++.Notepad++.installer.yaml': exeManifest('Notepad++.Notepad++', '8.7.4', 'Notepad++'),
  'm/Mozilla/Firefox/133.0/Mozilla.Firefox.installer.yaml': exeManifest('Mozilla.Firefox', '133.0', 'Mozilla Firefox'),
  'g/Git/Git/2.47.1/Git.Git.installer.yaml': exeManifest('Git.Git', '2.47.1', 'Git_is1'),
  'c/Contoso/NoRule/1.0/Contoso.NoRule.installer.yaml': `PackageIdentifier: Contoso.NoRule\nPackageVersion: "1.0"\nInstallers:\n- Architecture: x64\n  InstallerType: exe\n  InstallerSha256: ${up('norule')}\nManifestType: installer\n`,
  'c/Contoso/UserOnly/1.0/Contoso.UserOnly.installer.yaml': `PackageIdentifier: Contoso.UserOnly\nPackageVersion: "1.0"\nInstallers:\n- Architecture: x64\n  Scope: user\n  InstallerSha256: ${up('user')}\n  ProductCode: Contoso\nManifestType: installer\n`,
};
for (let i = 0; i < 30; i++) fixtures[`s/Synth/App${String(i).padStart(3, '0')}/1.${i}/Synth.App${String(i).padStart(3, '0')}.installer.yaml`] = exeManifest(`Synth.App${String(i).padStart(3, '0')}`, `1.${i}`, `SynthApp${i}`);
const fetched = [];
const manifestServer = createServer((rq, rs) => {
  fetched.push({ url: rq.url, auth: rq.headers.authorization ?? null, cookie: rq.headers.cookie ?? null });
  const rel = (rq.url ?? '').replace(/^\/manifests\//, '');
  if (rq.method !== 'GET' || !fixtures[rel]) { rs.writeHead(404); rs.end('404: Not Found'); return; }
  rs.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); rs.end(fixtures[rel]);
});

// The index: real-looking rows and 240 synthetic ones.
const NAMED = [
  ['7zip.7zip', '7-Zip', 'igorpavlov', '7zip', '24.09'],
  ['Notepad++.Notepad++', 'Notepad++', 'notepadplusplusteam', 'notepad++', '8.7.4'],
  ['Flo.Notepad2', 'Notepad2', 'flo', 'notepad2', '4.24'],
  ['Microsoft.WindowsNotepad', 'Windows Notepad', 'microsoft', null, '11.2410'],
  ['Mozilla.Firefox', 'Mozilla Firefox', 'mozilla', 'firefox', '133.0'],
  ['Git.Git', 'Git', 'thegitdevelopmentcommunity', 'git', '2.47.1'],
  ['Contoso.NoRule', 'Contoso No Rule', 'contoso', null, '1.0'],
  ['Contoso.UserOnly', 'Contoso User Only', 'contoso', null, '1.0'],
  ['Contoso.Missing', 'Contoso Missing Manifest', 'contoso', null, '1.0'],
  ['Contoso.OddVersion', 'Contoso Odd', 'contoso', null, 'latest build'],
  ['Zeta.Zed', 'Zed Editor', 'zeta', 'zed', '0.160'],
];
const SYNTH = 240;
const INDEX_ROWS = [
  ...NAMED.map(([packageId, name, publisher, moniker, latestVersion]) => ({ packageId, name, publisher, moniker, latestVersion })),
  ...Array.from({ length: SYNTH }, (_, i) => { const n = String(i).padStart(3, '0'); return { packageId: `Synth.App${n}`, name: `Synth App ${n}`, publisher: 'synthcorp', moniker: null, latestVersion: `1.${i}` }; }),
];
const TOTAL = INDEX_ROWS.length;

// ── The API ─────────────────────────────────────────────────────────────────
const apiEnv = {
  ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATABASE_URL: DB,
  MONITOR_SWEEP: 'off', PATCH_POLICY_SWEEP: 'off', METRIC_SWEEP: 'off', CLIENT_UPDATE_SWEEP: 'off', AUTO_MIGRATION_SWEEP: 'off', AGENT_AUTO_UPDATE: 'off', WINGET_INDEX_SWEEP: 'off',
  RETENTION_SWEEP: 'off', REPORT_SCHEDULE_SWEEP: 'off', SCRIPT_OUTPUT_SWEEP: 'off', CHAT_RETENTION_SWEEP: 'off', TRAY_SWEEP: 'off', SNAPSHOT_SWEEP: 'off', AUDIT_SEALER: 'off',
  HBBS_PRESENCE_HOST: '127.0.0.2', GEOIP_DB_PATH: path.join(here, '.no-geoip.mmdb'),
  WINGET_MANIFEST_BASE: `http://127.0.0.1:${MANIFESTS}/manifests`,
  JWT_SECRET: randomBytes(32).toString('hex'), LAUNCHER_TOKEN_SECRET: randomBytes(32).toString('hex'),
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? randomBytes(32).toString('hex'), TRUSTED_PROXIES: 'loopback',
  VERSION_FILE: path.resolve(here, '..', '..', '..', 'version.json'),
};
delete apiEnv.APPROVAL_SIGNER_INTERNAL_URL;
let api;
async function stopApi() { if (!api || api.exitCode !== null) return; await new Promise((r) => { api.once('exit', r); api.kill('SIGTERM'); }); }
async function waitUp() {
  for (let i = 0; i < 150; i++) { try { const r = await fetch(`${API}/health`); if (r.status < 500) return; } catch { /* not yet */ } await sleep(300); }
  throw new Error(`api did not come up:\n${api.log.slice(-3000)}`);
}

async function req(method, p, { s, body } = {}) {
  await sleep(60);
  const h = { 'content-type': 'application/json', 'x-forwarded-for': ip() };
  if (s) h.cookie = s.cookie + (s.stepUp ? `; step_up=${s.stepUp}` : '');
  const r = await fetch(`${API}${p}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j, data: j?.data, setCookie: r.headers.get('set-cookie') ?? '' };
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
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined)).toString();
const browse = (s, o) => req('GET', `/software/winget/packages?${qs(o)}`, { s });
const bulk = (s, body) => req('POST', '/software/winget/catalog/bulk', { s, body });
const byId = (results) => Object.fromEntries(results.map((x) => [x.packageId.toLowerCase(), x]));

// The index is removed only if this run wrote it: a run that stopped before then leaves another suite's alone.
const created = { businesses: [], users: [], index: false };

async function all() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  if (await prisma.wingetPackage.count() || await prisma.wingetIndexState.count()) throw new Error('the scratch database already holds a winget index (an earlier run that did not clean up?)');
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });
  const roleUser = await prisma.role.findFirst({ where: { type: 'BUSINESS_USER' } });

  section('Fixtures (synthetic): Acme and Globex, their owners, an Acme user, and a winget index of 251 packages');
  const acme = await prisma.customer.create({ data: { tenantId: tenant.id, name: `SWB Acme ${sfx}` } });
  const globex = await prisma.customer.create({ data: { tenantId: tenant.id, name: `SWB Globex ${sfx}` } });
  created.businesses.push(acme.id, globex.id);
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag, extra = {}) => { const u = await prisma.user.create({ data: { email: `swb-${tag}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'SWB', lastName: tag, status: 'ACTIVE', ...extra } }); created.users.push(u.id); return u; };
  const admin = await mkUser('admin', { isPlatformAdmin: true });
  const owen = await mkUser('owen-acme-owner'), bob = await mkUser('bob-globex-owner'), uma = await mkUser('uma-acme-user');
  await prisma.membership.create({ data: { userId: owen.id, tenantId: tenant.id, customerId: acme.id, roleId: roleOwner.id, capabilities: [] } });
  await prisma.membership.create({ data: { userId: bob.id, tenantId: tenant.id, customerId: globex.id, roleId: roleOwner.id, capabilities: [] } });
  await prisma.membership.create({ data: { userId: uma.id, tenantId: tenant.id, customerId: acme.id, roleId: roleUser.id, capabilities: ['computers:view', 'computers:edit'] } });

  await new Promise((r) => manifestServer.listen(MANIFESTS, '127.0.0.1', r));
  api = spawn(process.execPath, [path.join(dist, 'main.js')], { env: apiEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  api.log = ''; api.stdout.on('data', (d) => { api.log += d; }); api.stderr.on('data', (d) => { api.log += d; });
  await waitUp();
  const A = await login(admin.email), O = await login(owen.email), B = await login(bob.email), U = await login(uma.email);

  section('An empty index says so; it is never an empty table without a reason');
  {
    const r = await browse(A, { page: 1 });
    check(r.status === 200 && r.data.mode === 'browse' && r.data.total === 0 && r.data.results.length === 0 && r.data.index.packages === 0 && r.data.page === 1 && r.data.pages === 1,
      'browse before the index is read: total 0, and the index state (packages 0) comes with it', msg(r));
  }
  created.index = true;
  await prisma.wingetPackage.createMany({ data: INDEX_ROWS });
  await prisma.wingetIndexState.upsert({ where: { id: 1 }, create: { id: 1, refreshedAt: new Date(), attemptedAt: new Date(), packages: TOTAL }, update: { refreshedAt: new Date(), attemptedAt: new Date(), packages: TOTAL } });

  section('Paging: the whole index, 50 a page, sorted by name, with the total');
  {
    const r1 = await browse(U, { page: 1 });
    check(r1.status === 200 && r1.data.total === TOTAL && r1.data.pageSize === 50 && r1.data.pages === Math.ceil(TOTAL / 50) && r1.data.results.length === 50,
      `page 1 of ${Math.ceil(TOTAL / 50)}: 50 rows of ${TOTAL}, for a Business User who can view computers`, msg(r1));
    const names = r1.data.results.map((x) => x.name);
    check(names.slice(0, 8).join('|') === '7-Zip|Contoso Missing Manifest|Contoso No Rule|Contoso Odd|Contoso User Only|Git|Mozilla Firefox|Notepad++' && names[9] === 'Synth App 000',
      'sorted by name', names.slice(0, 10).join(' | '));
    const row = r1.data.results.find((x) => x.packageId === '7zip.7zip');
    check(!!row && row.publisher === 'igorpavlov' && row.latestVersion === '24.09' && row.installable === true && Array.isArray(row.inCatalog), 'each row: name, publisher, package id, latest version, installable, inCatalog', JSON.stringify(row));
    const seen = new Set();
    let pages = 0;
    for (let p = 1; p <= r1.data.pages; p++) { const r = await browse(U, { page: p }); pages++; for (const x of r.data.results) seen.add(x.packageId); }
    check(seen.size === TOTAL && pages === 6, 'every package is on exactly one page', `${seen.size} distinct over ${pages} pages`);
    const last = await browse(U, { page: 99 });
    check(last.status === 200 && last.data.page === last.data.pages && last.data.results.length === TOTAL % 50, 'a page past the end is the last page', msg(last));
    const desc = await browse(U, { page: 1, sort: '-name' });
    check(desc.data.results[0].name === 'Zed Editor', 'sort -name: Z first', desc.data.results[0]?.name);
    const big = await browse(U, { page: 1, pageSize: 1000 });
    check(big.status === 200 && big.data.pageSize === 100 && big.data.results.length === 100, 'a page size over 100 is capped at 100', msg(big));
    const small = await browse(U, { page: 3, pageSize: 7 });
    check(small.data.results.length === 7 && small.data.page === 3, 'a smaller page size is honoured');
    for (const [bad, why] of [[{ page: 0 }, 'page 0'], [{ page: 'x' }, 'page x'], [{ page: 1, sort: 'publisher' }, 'an unknown sort'], [{ page: 1, letter: 'AB' }, 'two letters'], [{ page: 1, publisher: 'a b' }, 'a publisher with a space'], [{ page: 1, q: "x' OR '1'='1" }, 'a quote in the query']]) {
      const r = await browse(U, bad);
      check(r.status === 400 && code(r) === 'INVALID_REQUEST', `${why} → 400 INVALID_REQUEST`, msg(r));
    }
  }

  section('Filtering: as you type (the 0.42 ranking), by publisher, by letter');
  {
    const r = await browse(U, { page: 1, q: 'notepad' });
    check(r.status === 200 && r.data.sort === 'relevance' && r.data.ranked === true && r.data.total === 3 && r.data.results[0].packageId === 'Notepad++.Notepad++',
      'q=notepad: three matches, ranked, Notepad++ first', msg(r));
    const byName = await browse(U, { page: 1, q: 'notepad', sort: 'name' });
    check(byName.data.results.map((x) => x.name).join() === 'Notepad++,Notepad2,Windows Notepad', 'q=notepad sorted by name', byName.data.results.map((x) => x.name).join());
    const p = await browse(U, { page: 1, publisher: 'contoso' });
    check(p.data.total === 4 && p.data.results.every((x) => x.publisher === 'contoso'), 'publisher=contoso: its four packages only', msg(p));
    const l = await browse(U, { page: 1, letter: 'z' });
    check(l.data.total === 1 && l.data.results[0].packageId === 'Zeta.Zed', 'letter Z: Zed Editor', msg(l));
    const hash = await browse(U, { page: 1, letter: '#' });
    check(hash.data.total === 1 && hash.data.results[0].packageId === '7zip.7zip', 'letter #: 7-Zip (a name not starting with a letter)', msg(hash));
    const both = await browse(U, { page: 2, q: 'synth' });
    check(both.data.total === SYNTH && both.data.ranked === true && both.data.results.length === 50 && both.data.page === 2, `q=synth: ${SYNTH} matches, page 2 of the ranking`, msg(both));
    const none = await browse(U, { page: 1, q: 'nothing matches this' });
    check(none.status === 200 && none.data.total === 0 && none.data.index.packages === TOTAL, 'no match: total 0, and the index is not empty', msg(none));
    const old = await req('GET', '/software/winget/packages?q=notepad', { s: U });
    check(old.status === 200 && old.data.mode === undefined && old.data.results.length === 3 && old.data.page === undefined, 'without page or pageSize it is still the 0.41 search', msg(old));
  }

  section('Bulk add: assertFresh, the 25 cap, who may write');
  {
    const r = await bulk(A, { scope: 'global', packages: [{ packageId: '7zip.7zip' }] });
    check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED', 'without a fresh sign-in → 403 STEP_UP_REQUIRED, and nothing is read', msg(r));
    check(fetched.length === 0, 'no manifest was fetched for a refused request', JSON.stringify(fetched));
  }
  const As = await stepUp(A), Os = await stepUp(O), Bs = await stepUp(B), Us = await stepUp(U);
  {
    const many = Array.from({ length: 26 }, (_, i) => ({ packageId: `Synth.App${String(i).padStart(3, '0')}` }));
    let r = await bulk(As, { scope: 'global', packages: many });
    check(r.status === 400 && code(r) === 'TOO_MANY_PACKAGES', '26 packages → 400 TOO_MANY_PACKAGES', msg(r));
    r = await bulk(As, { scope: 'global', packages: [] });
    check(r.status === 400, 'no packages → 400', msg(r));
    r = await bulk(As, { scope: 'global', packages: [{ packageId: '7zip.7zip' }, { packageId: '7ZIP.7ZIP' }] });
    check(r.status === 400, 'the same package twice (any case) → 400', msg(r));
    r = await bulk(As, { scope: 'global', packages: [{ packageId: '7zip.7zip', installerSha256: 'a'.repeat(64) }] });
    check(r.status === 400, 'a package may not carry its own hash → 400', msg(r));
    check(fetched.length === 0, 'none of those fetched a manifest');
    r = await bulk(Os, { scope: 'global', packages: [{ packageId: '7zip.7zip' }] });
    check(r.status === 403 && code(r) === 'NOT_ALLOWED', 'a Business Owner cannot add to the global catalog', msg(r));
    r = await bulk(Us, { scope: 'business', packages: [{ packageId: '7zip.7zip' }] });
    check(r.status === 403 && code(r) === 'NOT_ALLOWED', 'a Business User (even with Edit computers) cannot add to the business catalog', msg(r));
    r = await bulk(Bs, { scope: 'business', businessId: acme.id, packages: [{ packageId: '7zip.7zip' }] });
    check(r.status === 404, 'Globex\'s owner naming Acme\'s catalog → 404', msg(r));
    const bb = await browse(B, { page: 1, businessId: acme.id });
    check(bb.status === 404, 'Globex\'s owner browsing with Acme\'s catalog marked → 404', msg(bb));
    r = await bulk(As, { scope: 'business', businessId: 'nosuchbusiness0', packages: [{ packageId: '7zip.7zip' }] });
    check(r.status === 404, 'a business that does not exist → 404', msg(r));
    check(fetched.length === 0, 'still no manifest fetched');
  }

  section('Bulk add to the global catalog: per-package results');
  const g = await bulk(As, { scope: 'global', packages: [
    { packageId: '7zip.7zip' }, { packageId: 'notepad++.notepad++' }, { packageId: 'Contoso.NoRule' }, { packageId: 'Contoso.UserOnly' },
    { packageId: 'Contoso.Missing' }, { packageId: 'Contoso.OddVersion' }, { packageId: 'Nobody.Knows' },
  ] });
  {
    check(g.status === 200 && g.data.target.scope === 'global' && g.data.results.length === 7, 'one request, seven results, in order', msg(g));
    const x = byId(g.data.results);
    check(x['7zip.7zip']?.status === 'added' && x['7zip.7zip'].version === '24.09' && x['7zip.7zip'].in === 'global', '7-Zip: added at the latest version', JSON.stringify(x['7zip.7zip']));
    check(x['notepad++.notepad++']?.status === 'added' && x['notepad++.notepad++'].packageId === 'Notepad++.Notepad++', 'Notepad++: added, under the index\'s own spelling of the id', JSON.stringify(x['notepad++.notepad++']));
    for (const [id, want] of [['contoso.norule', 'NO_DETECTION'], ['contoso.useronly', 'NO_MACHINE_INSTALLER'], ['contoso.missing', 'MANIFEST_NOT_FOUND'], ['contoso.oddversion', 'VERSION_NOT_INSTALLABLE'], ['nobody.knows', 'PACKAGE_NOT_IN_INDEX']]) {
      check(x[id]?.status === 'refused' && x[id].code === want && typeof x[id].message === 'string' && x[id].message.length > 10, `${id}: refused ${want}, with the reason`, JSON.stringify(x[id]));
    }
    check(g.data.counts.added === 2 && g.data.counts.refused === 5 && g.data.counts.already === 0, 'counts: 2 added, 5 refused', JSON.stringify(g.data.counts));
    check(fetched.every((f) => !f.auth && !f.cookie), 'manifest fetches carry no credentials');
    const entries = await prisma.softwareCatalogEntry.findMany({ where: { scope: 'GLOBAL', packageId: { in: ['7zip.7zip', 'Notepad++.Notepad++'] } } });
    check(entries.length === 2 && entries.every((e) => e.hashSource === 'WINGET_PKGS' && e.installerSha256 === sha(`${e.packageId} ${e.version} x64`) && e.createdById === admin.id),
      'two global entries, each pinning the manifest\'s x64 hash (hash source winget-pkgs)', JSON.stringify(entries.map((e) => [e.packageId, e.hashSource])));
    const audit = await prisma.activityLog.findMany({ where: { action: 'SOFTWARE_CATALOG_CREATED', resourceId: { in: entries.map((e) => e.id) } } });
    check(audit.length === 2 && audit.every((a) => a.metadata?.via === 'bulk' && a.metadata?.scope === 'global' && a.actorId === admin.id), 'one audit entry per added package, via: bulk', JSON.stringify(audit.map((a) => a.metadata?.via)));
    const refusedAudit = await prisma.activityLog.count({ where: { action: 'SOFTWARE_CATALOG_CREATED', metadata: { path: ['packageId'], equals: 'Contoso.NoRule' } } });
    check(refusedAudit === 0, 'nothing is audited as added for a refused package');
  }

  section('Marks: each row says which catalog holds it, at what version');
  {
    const r = await browse(U, { page: 1, q: '7zip' });
    const row = r.data.results.find((x) => x.packageId === '7zip.7zip');
    check(row?.inCatalog.length === 1 && row.inCatalog[0].scope === 'global' && row.inCatalog[0].version === '24.09' && typeof row.inCatalog[0].entryId === 'string' && row.inCatalog[0].revision === 1,
      'the Acme user sees 7-Zip "in global catalog · 24.09"', JSON.stringify(row?.inCatalog));
    check(r.data.target?.businessId === acme.id && r.data.you.canAddBusiness === false && r.data.you.canAddGlobal === false, 'the user\'s own business is the target; they cannot add', JSON.stringify({ t: r.data.target, y: r.data.you }));
    const o = await browse(O, { page: 1, q: '7zip' });
    check(o.data.you.canAddBusiness === true && o.data.you.canAddGlobal === false, 'Acme\'s owner can add to Acme\'s catalog, not the global one', JSON.stringify(o.data.you));
  }

  section('Bulk add to a business: the owner, already-there, and the results');
  {
    // Firefox is put into Globex's catalog first, by an admin, to show it never marks Acme's rows.
    const gx = await bulk(As, { scope: 'business', businessId: globex.id, packages: [{ packageId: 'Mozilla.Firefox' }] });
    check(gx.status === 200 && gx.data.results[0].status === 'added' && gx.data.target.businessId === globex.id, 'a Platform Admin adds Firefox to Globex\'s catalog', msg(gx));
    const before = fetched.length;
    const r = await bulk(Os, { scope: 'business', packages: [{ packageId: '7zip.7zip' }, { packageId: 'Mozilla.Firefox' }, { packageId: 'Git.Git' }, { packageId: 'Synth.App003' }] });
    check(r.status === 200 && r.data.target.scope === 'business' && r.data.target.businessId === acme.id, 'Acme\'s owner, naming no business: Acme\'s catalog', msg(r));
    const x = byId(r.data.results);
    check(x['7zip.7zip']?.status === 'already' && x['7zip.7zip'].in === 'global' && x['7zip.7zip'].version === '24.09', '7-Zip: already there (the global entry applies to Acme)', JSON.stringify(x['7zip.7zip']));
    check(x['mozilla.firefox']?.status === 'added' && x['mozilla.firefox'].in === 'business', 'Firefox: added to Acme (Globex\'s entry is not Acme\'s)', JSON.stringify(x['mozilla.firefox']));
    check(x['git.git']?.status === 'added' && x['synth.app003']?.status === 'added' && x['synth.app003'].version === '1.3', 'Git and Synth App 003: added', JSON.stringify([x['git.git'], x['synth.app003']]));
    check(fetched.length - before === 3, 'already-there packages read no manifest', `${fetched.length - before} fetched`);
    const again = await bulk(Os, { scope: 'business', businessId: acme.id, packages: [{ packageId: 'Git.Git' }, { packageId: 'Contoso.NoRule' }] });
    const y = byId(again.data.results);
    check(again.status === 200 && y['git.git']?.status === 'already' && y['git.git'].in === 'business' && y['contoso.norule']?.status === 'refused' && y['contoso.norule'].code === 'NO_DETECTION', 'again: Git already in Acme\'s catalog; No Rule still refused', msg(again));
    const audit = await prisma.activityLog.findMany({ where: { action: 'SOFTWARE_CATALOG_CREATED', customerId: acme.id } });
    check(audit.length === 3 && audit.every((a) => a.metadata?.via === 'bulk' && a.metadata?.scope === 'business' && a.actorId === owen.id), 'three audit entries for Acme, by its owner, via bulk', JSON.stringify(audit.map((a) => [a.metadata?.packageId, a.metadata?.via])));

    const m = await browse(O, { page: 1, q: 'firefox' });
    const ff = m.data.results.find((z) => z.packageId === 'Mozilla.Firefox');
    check(ff?.inCatalog.length === 1 && ff.inCatalog[0].scope === 'business' && ff.inCatalog[0].businessId === acme.id && ff.inCatalog[0].businessName === acme.name, 'Acme\'s owner sees Firefox "in Acme catalog", never Globex\'s entry', JSON.stringify(ff?.inCatalog));
    const am = await browse(A, { page: 1, q: 'firefox', businessId: globex.id });
    check(am.data.results[0].inCatalog.map((z) => z.businessId).join() === globex.id, 'a Platform Admin looking at Globex sees Globex\'s entry', JSON.stringify(am.data.results[0].inCatalog));
    const ag = await browse(A, { page: 1, q: 'firefox' });
    check(ag.data.target === null && ag.data.results[0].inCatalog.length === 0, 'a Platform Admin looking at the global catalog: Firefox is in none', JSON.stringify(ag.data.results[0].inCatalog));
    const sevenAcme = await browse(O, { page: 1, q: '7zip' });
    check(sevenAcme.data.results.find((z) => z.packageId === '7zip.7zip').inCatalog.map((z) => z.scope).join() === 'global', 'for Acme, 7-Zip shows the global entry only');
  }

  section('Twenty-five at once');
  {
    const pk = Array.from({ length: 25 }, (_, i) => ({ packageId: `Synth.App${String(i + 5).padStart(3, '0')}` }));
    const t0 = Date.now();
    const r = await bulk(As, { scope: 'global', packages: pk });
    const x = r.data?.results ?? [];
    const okIds = x.filter((z) => z.status === 'added').map((z) => z.packageId);
    // Fixtures exist for App000–App029; App030 and up have no manifest.
    check(r.status === 200 && x.length === 25 && okIds.length === 25, '25 packages in one request: all added', msg(r));
    check(x.map((z) => z.packageId).join() === pk.map((z) => z.packageId).join(), 'results come back in the order asked', x.map((z) => z.packageId).slice(0, 4).join());
    console.log(`      (${Date.now() - t0} ms for 25 manifest reads)`);
    const pk2 = [{ packageId: 'Synth.App028' }, { packageId: 'Synth.App029' }, { packageId: 'Synth.App030' }, { packageId: 'Synth.App031' }];
    const r2 = await bulk(As, { scope: 'global', packages: pk2 });
    const y = byId(r2.data.results);
    check(y['synth.app028'].status === 'already' && y['synth.app029'].status === 'already' && y['synth.app030'].code === 'MANIFEST_NOT_FOUND' && y['synth.app031'].code === 'MANIFEST_NOT_FOUND', 'already there, and refused where winget-pkgs has no manifest', JSON.stringify(r2.data.results));
  }

  section('Rate limit: three bulk requests a minute from one client');
  {
    const fixed = ip(), seen = [];
    for (let i = 0; i < 4; i++) {
      await sleep(60);
      const r = await fetch(`${API}/software/winget/catalog/bulk`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': fixed, cookie: `${As.cookie}; step_up=${As.stepUp}` }, body: JSON.stringify({ scope: 'global', packages: [{ packageId: 'Synth.App028' }] }) });
      seen.push(r.status); await r.text();
    }
    check(seen.slice(0, 3).every((s) => s === 200) && seen[3] === 429, 'the fourth within a minute → 429', seen.join());
  }

  section('Remove from a catalog: the archive route, by the entry a row names');
  {
    const r = await browse(O, { page: 1, q: 'git' });
    const row = r.data.results.find((z) => z.packageId === 'Git.Git');
    const mark = row?.inCatalog.find((z) => z.businessId === acme.id);
    check(!!mark, 'Git is marked in Acme\'s catalog with its entry id and revision', JSON.stringify(row?.inCatalog));
    const no = await req('POST', `/software/catalog/${mark.entryId}/archive`, { s: Bs, body: { reason: 'not yours', expectedRevision: mark.revision } });
    check(no.status === 404, 'Globex\'s owner cannot archive Acme\'s entry (404)', msg(no));
    const a = await req('POST', `/software/catalog/${mark.entryId}/archive`, { s: Os, body: { reason: 'Built the catalog by mistake', expectedRevision: mark.revision } });
    check(a.status === 200 && a.data.archivedAt, 'Acme\'s owner archives it', msg(a));
    const after = await browse(O, { page: 1, q: 'git' });
    check(after.data.results.find((z) => z.packageId === 'Git.Git').inCatalog.length === 0, 'the row is no longer marked');
    const re = await bulk(Os, { scope: 'business', packages: [{ packageId: 'Git.Git' }] });
    check(re.status === 200 && re.data.results[0].status === 'added', 'and it can be added again', msg(re));
  }
}

async function cleanup() {
  try {
    if (created.users.length) {
      const ids = (await prisma.softwareCatalogEntry.findMany({ where: { createdById: { in: created.users } }, select: { id: true } })).map((e) => e.id);
      if (ids.length) await prisma.softwareCatalogEntry.deleteMany({ where: { id: { in: ids } } });
    }
    if (created.index) { await prisma.wingetPackage.deleteMany({}); await prisma.wingetIndexState.deleteMany({}); }
    if (created.businesses.length) {
      await prisma.membership.deleteMany({ where: { customerId: { in: created.businesses } } });
      await prisma.customer.deleteMany({ where: { id: { in: created.businesses } } });
    }
    if (created.users.length) await prisma.user.deleteMany({ where: { id: { in: created.users } } });
  } catch (e) { console.error('cleanup:', e.message); }
}

all()
  .catch((e) => { fail++; failures.push(`crashed: ${e.stack ?? e}`); console.error(e); if (api) console.error(api.log.slice(-3000)); })
  .finally(async () => {
    await cleanup();
    await stopApi();
    manifestServer.close();
    await prisma.$disconnect();
    console.log(`\n${pass} passed, ${fail} failed`);
    if (failures.length) { console.log('\nFailures:'); for (const f of failures) console.log(`  - ${f}`); }
    process.exit(fail ? 1 : 0);
  });
