#!/usr/bin/env node
/**
 * The console in a real browser, self-contained enough for CI (0.34).
 *
 * It needs no docs stack. It starts its own API from apps/api/dist on
 * UI_API_PORT (3502) against DATABASE_URL, copies the web standalone build
 * (building it first if there is none), points the COPY's baked-in API
 * rewrite at that API, serves it on UI_WEB_PORT (3501), seeds its own
 * fixtures and removes them afterwards.
 *
 * At desktop (1440 × 900) and phone width (375 × 812), in the light and dark
 * themes — set the way the app sets them, through localStorage.theme — it
 * covers: sign-in; the menu drawer (focus trap, Esc, closes on navigation,
 * accessible name) and the desktop sidebar; Devices list → a device → every
 * workspace tab; saving and reopening a view; bulk selection; the search
 * palette (Ctrl+K); Add Device through the step-up dialog, cancelled and then
 * confirmed; API keys create through step-up, cancelled and then confirmed;
 * the Reports pages; the System status cards; and (0.35, snapshotAutoUpdate)
 * a Processes tab that updates itself, without a reload, when a simulated
 * device completes a run — after Refresh, and on its periodic re-read. At 375 px no page may
 * scroll sideways: a wide table scrolls inside its own container.
 *
 * Any console error, uncaught exception, or unexpected failed request on a
 * page fails that page's check. The only failures expected are the 403
 * STEP_UP_REQUIRED answers the step-up flows provoke on purpose.
 *
 * Finally it runs scripts/e2e-search-palette.mjs against the same stack
 * (UI_SKIP_PALETTE=1 skips it).
 *
 * Refuses: a database whose name lacks "test" or "scratch"; https; ports
 * 3000, 3001, 443, 4000 and 4001 (production, and the docs stack).
 *
 *   DATABASE_URL=postgresql://…/rem0te_ui_test node apps/web/scripts/e2e-ui.mjs
 *
 * Needs a built API (apps/api/dist) and `npx playwright install
 * chromium-headless-shell`. UI_REBUILD=1 rebuilds the web app first; without
 * it an existing apps/web/.next/standalone is used as it is, so rebuild after
 * changing the web app. Screenshots go to OUT_DIR (default: a temp directory).
 */
import { chromium } from 'playwright';
import { createRequire } from 'module';
import { spawn, spawnSync } from 'child_process';
import { randomBytes } from 'crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import path from 'path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(HERE, '..');
const ROOT = path.resolve(WEB_DIR, '../..');
const API_DIR = path.join(ROOT, 'apps/api');

// ── Refusals, before anything is started or written ────────────────────────
const FORBIDDEN_PORTS = [3000, 3001, 443, 4000, 4001];
const WEB_PORT = Number(process.env.UI_WEB_PORT ?? 3501);
const API_PORT = Number(process.env.UI_API_PORT ?? 3502);
for (const p of [WEB_PORT, API_PORT]) {
  if (!Number.isInteger(p) || FORBIDDEN_PORTS.includes(p)) throw new Error(`Refusing port ${p}: 3000/3001/443 are production and 4000/4001 the docs stack`);
}
const WEB = `http://127.0.0.1:${WEB_PORT}`;
const API_ORIGIN = `http://127.0.0.1:${API_PORT}`;
if (/:(3000|443)\b/.test(WEB) || /^https:\/\//.test(WEB) || /:(4000|4001)\b/.test(WEB)) {
  throw new Error(`Refusing to test against ${WEB} — the UI suite runs only against the stack it starts`);
}
const DB = process.env.DATABASE_URL ?? '';
const dbName = DB.split('/').pop()?.split('?')[0] ?? '';
if (!/test|scratch/.test(dbName)) throw new Error(`Refusing to run: database "${dbName}" is not a test or scratch database`);

const apiRequire = createRequire(path.join(API_DIR, 'package.json'));
const { PrismaClient } = apiRequire('@prisma/client');
const argon2 = apiRequire('argon2');

const OUT_DIR = process.env.OUT_DIR ?? await mkdtemp(path.join(tmpdir(), 'rem0te-ui-'));
const prisma = new PrismaClient();

let pass = 0, fail = 0; const failures = [];
const check = (c, m, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${m}`); } else { fail++; failures.push(`${m}${d ? ` — ${String(d).slice(0, 400)}` : ''}`); console.log(`  \x1b[31m✗\x1b[0m ${m}${d ? `\n      ${String(d).slice(0, 1500)}` : ''}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;

// ── The stack ───────────────────────────────────────────────────────────────
const procs = [];
function start(name, cmd, args, opts) {
  const p = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
  p.log = ''; const keep = (d) => { p.log = (p.log + d).slice(-200_000); };
  p.stdout.on('data', keep); p.stderr.on('data', keep);
  p.label = name; procs.push(p);
  return p;
}
async function stopAll() {
  for (const p of procs) {
    if (p.exitCode !== null || p.signalCode) continue;
    await new Promise((r) => { const t = setTimeout(() => { p.kill('SIGKILL'); r(); }, 8000); p.once('exit', () => { clearTimeout(t); r(); }); p.kill('SIGTERM'); });
  }
}
async function waitHttp(url, p, okStatus = (s) => s < 500, tries = 200) {
  for (let i = 0; i < tries; i++) {
    if (p.exitCode !== null) throw new Error(`${p.label} exited (${p.exitCode}):\n${p.log.slice(-3000)}`);
    try { const r = await fetch(url, { headers: { 'x-forwarded-for': ip() } }); if (okStatus(r.status)) return; } catch { /* not yet */ }
    await sleep(300);
  }
  throw new Error(`${p.label} did not come up at ${url}:\n${p.log.slice(-3000)}`);
}

function migrateAndSeed() {
  const env = { ...process.env, DATABASE_URL: DB };
  const m = spawnSync('npx', ['prisma', 'migrate', 'deploy'], { cwd: API_DIR, env, encoding: 'utf8' });
  if (m.status !== 0) throw new Error(`prisma migrate deploy failed:\n${m.stdout}\n${m.stderr}`);
}
async function ensureSeeded() {
  migrateAndSeed();
  if (await prisma.tenant.count()) return;
  const s = spawnSync('npx', ['prisma', 'db', 'seed'], {
    cwd: API_DIR, encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: DB, SEED_ADMIN_EMAIL: `ui-seed-${randomBytes(3).toString('hex')}@test.invalid`, SEED_ADMIN_PASSWORD: randomBytes(18).toString('base64') },
  });
  if (s.status !== 0) throw new Error(`prisma db seed failed:\n${s.stdout}\n${s.stderr}`);
}

function startApi() {
  const env = {
    ...process.env, NODE_ENV: 'test', PORT: String(API_PORT), DATABASE_URL: DB,
    JWT_SECRET: randomBytes(32).toString('hex'), LAUNCHER_TOKEN_SECRET: randomBytes(32).toString('hex'),
    ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? randomBytes(32).toString('hex'), TRUSTED_PROXIES: 'loopback',
    HBBS_PRESENCE_HOST: '127.0.0.2', I_KNOW_THIS_IS_NOT_PRODUCTION: '1',
    // Nothing in the background acts on this database while the browser looks at it.
    MONITOR_SWEEP: 'off', CLIENT_UPDATE_SWEEP: 'off', PATCH_POLICY_SWEEP: 'off', METRIC_SWEEP: 'off', AUDIT_SEALER: 'off',
    RETENTION_SWEEP: 'off', REPORT_SCHEDULE_SWEEP: 'off', SCRIPT_OUTPUT_SWEEP: 'off', CHAT_RETENTION_SWEEP: 'off',
    // 0.35 automatic snapshots: the fixtures' snapshots are the only ones, and
    // snapshotAutoUpdate() below drives its device by hand.
    SNAPSHOT_SWEEP: 'off',
    FRONTEND_URL: WEB, PUBLIC_API_URL: WEB,
    VERSION_FILE: path.join(ROOT, 'version.json'),
  };
  return start('api', process.execPath, [path.join(API_DIR, 'dist', 'main.js')], { cwd: API_DIR, env });
}

/**
 * `output: 'standalone'` bakes the rewrite destination in at build time
 * (CLAUDE.md), so INTERNAL_API_URL at runtime is ignored. The build is
 * copied and the COPY is patched; the build itself is never written. The
 * patch is verified: if the old destination survived anywhere, requests from
 * this browser would reach whatever API the build was made for — production,
 * on this host — so that is a hard stop.
 */
function prepareWeb() {
  const next = path.join(WEB_DIR, '.next');
  const standalone = path.join(next, 'standalone');
  if (process.env.UI_REBUILD === '1' || !existsSync(path.join(standalone, 'apps/web/server.js'))) {
    console.log('  building the web app (next build)…');
    const b = spawnSync('npx', ['next', 'build'], { cwd: WEB_DIR, encoding: 'utf8', env: { ...process.env, INTERNAL_API_URL: '', NEXT_TELEMETRY_DISABLED: '1' } });
    if (b.status !== 0) throw new Error(`next build failed:\n${b.stdout.slice(-4000)}\n${b.stderr.slice(-4000)}`);
  }
  console.log(`  web build from ${new Date(statSync(path.join(standalone, 'apps/web/server.js')).mtimeMs).toISOString()}`);
  const COPY = mkdtempSync(path.join(tmpdir(), 'rem0te-ui-web-'));
  cpSync(standalone, COPY, { recursive: true, verbatimSymlinks: true });
  cpSync(path.join(next, 'static'), path.join(COPY, 'apps/web/.next/static'), { recursive: true });
  cpSync(path.join(WEB_DIR, 'public'), path.join(COPY, 'apps/web/public'), { recursive: true });
  const files = ['apps/web/server.js', 'apps/web/.next/routes-manifest.json', 'apps/web/.next/required-server-files.json'].map((f) => path.join(COPY, f));
  const manifest = JSON.parse(readFileSync(files[1], 'utf8'));
  const rewrites = [manifest.rewrites].flat().concat(Object.values(manifest.rewrites ?? {}).flat()).filter((r) => r && r.source === '/api/:path*');
  const dest = rewrites[0]?.destination;
  const origin = dest?.replace(/\/api\/:path\*$/, '');
  if (!origin || !/^https?:\/\/[^/]+$/.test(origin)) throw new Error(`no /api rewrite found in the build's routes-manifest.json (${dest})`);
  for (const f of files) {
    const before = readFileSync(f, 'utf8');
    writeFileSync(f, before.split(`${origin}/api/`).join(`${API_ORIGIN}/api/`));
  }
  for (const f of files) {
    const after = readFileSync(f, 'utf8');
    if (after.includes(`${origin}/api/`) || !after.includes(`${API_ORIGIN}/api/`)) throw new Error(`patching ${f} failed: the build's rewrite to ${origin} is still there`);
  }
  console.log(`  rewrite ${origin}/api → ${API_ORIGIN}/api (in a copy: ${COPY})`);
  return COPY;
}

function startWeb(copy) {
  return start('web', process.execPath, ['server.js'], {
    cwd: path.join(copy, 'apps/web'),
    env: { ...process.env, PORT: String(WEB_PORT), HOSTNAME: '127.0.0.1', NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1' },
  });
}

// ── Fixtures ────────────────────────────────────────────────────────────────
const sfx = randomBytes(3).toString('hex');
const TAG = `UI${sfx}`;
const PW = `ui-e2e-${randomBytes(9).toString('hex')}`;
const created = { businesses: [], users: [] };

async function seed() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });
  const A = await prisma.customer.create({ data: { tenantId: tenant.id, name: `${TAG} Acme` } });
  const B = await prisma.customer.create({ data: { tenantId: tenant.id, name: `${TAG} Birch` } });
  created.businesses.push(A.id, B.id);
  const site = await prisma.site.create({ data: { tenantId: tenant.id, customerId: A.id, name: `${TAG} HQ` } });
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mk = async (tag, extra = {}) => { const u = await prisma.user.create({ data: { email: `ui-${tag}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'UI', lastName: tag, status: 'ACTIVE', ...extra } }); created.users.push(u.id); return u; };
  const admin = await mk('admin', { isPlatformAdmin: true });
  const owner = await mk('owner');
  await prisma.membership.create({ data: { userId: owner.id, tenantId: tenant.id, customerId: A.id, roleId: roleOwner.id } });

  const now = Date.now();
  const ep = (biz, name, extra = {}) => prisma.endpoint.create({ data: {
    tenantId: tenant.id, customerId: biz.id, name, hostname: `${name.toLowerCase()}.corp.example.com`, platform: 'Windows', osVersion: 'Windows 11 Pro',
    status: 'ACTIVE', isOnline: true, isManaged: true, accessMode: 'COMPANY_WIDE', lastSeenAt: new Date(now - 60_000), deviceClass: 'WORKSTATION',
    agentVersion: '0.33.0', ipAddress: '10.20.0.5', ...extra,
  } });
  // A long name on purpose: the phone-width checks are only as good as the
  // widest thing a real list holds.
  const main = await ep(A, `${TAG}-WS-01`, { siteId: site.id, description: 'Front desk workstation with a deliberately long description that must wrap rather than widen the page' });
  const others = [];
  for (let i = 2; i <= 5; i++) others.push(await ep(A, `${TAG}-WS-0${i}`, { siteId: i % 2 ? site.id : null, isOnline: i !== 4, lastSeenAt: new Date(now - (i === 4 ? 3 * 86400_000 : 120_000)) }));
  const linux = await ep(A, `${TAG}-LNX-01`, { platform: 'Linux', osVersion: 'Ubuntu 24.04', agentVersion: '0.33.0' });
  await ep(B, `${TAG}-BIRCH-ONLY`);

  await prisma.endpointInventory.create({ data: {
    endpointId: main.id, manufacturer: 'Contoso', model: 'Workstation 9000', serialNumber: `SN${TAG}`, osCaption: 'Microsoft Windows 11 Pro', osBuild: '26100',
    osArch: '64-bit', cpuModel: 'Intel(R) Core(TM) i7-1365U', cpuCores: 10, cpuThreads: 12,
  } }).catch((e) => console.log(`  (inventory fixture: ${e.message.split('\n').pop()})`));
  // A day of metric samples, every 10 minutes, and the hourly roll-ups the Performance tab reads for longer ranges.
  const samples = [];
  for (let t = now - 24 * 3600_000; t < now; t += 10 * 60_000) {
    const k = (t / 3600_000) % 24;
    samples.push({ endpointId: main.id, at: new Date(t), cpu: 20 + 15 * Math.sin(k / 3), memory: 55 + 5 * Math.cos(k / 4), disk: 61.5 });
  }
  await prisma.endpointMetricSample.createMany({ data: samples });
  const hours = [];
  for (let h = 1; h <= 7 * 24; h++) {
    const hour = new Date(Math.floor((now - h * 3600_000) / 3600_000) * 3600_000);
    hours.push({ endpointId: main.id, hour, samples: 6, cpuMin: 5, cpuAvg: 22, cpuMax: 70, memoryMin: 50, memoryAvg: 56, memoryMax: 63, diskMin: 61, diskAvg: 61.5, diskMax: 62 });
  }
  await prisma.endpointMetricHourly.createMany({ data: hours, skipDuplicates: true });

  // The three 0.33 snapshots, as the server stores them after sanitising.
  const done = new Date(now - 30 * 60_000);
  const run = (key, result) => prisma.diagnosticRun.create({ data: {
    endpointId: main.id, tenantId: tenant.id, customerId: A.id, key, status: 'COMPLETED', requestedById: admin.id,
    requestedAt: new Date(done.getTime() - 120_000), deliveredAt: done, startedAt: done, completedAt: done, expiresAt: new Date(now + 3600_000),
    result, resultBytes: JSON.stringify(result).length,
  } });
  await run('process_list', { processCount: 3, userNamesRead: true, processes: [
    { name: 'explorer', pid: 4242, cpuSeconds: 312.5, workingSetBytes: 182_000_000, user: 'CORP\\frontdesk', startedAt: new Date(now - 5 * 3600_000).toISOString() },
    { name: 'OUTLOOK', pid: 5120, cpuSeconds: 98.1, workingSetBytes: 410_000_000, user: 'CORP\\frontdesk', startedAt: new Date(now - 4 * 3600_000).toISOString() },
    { name: 'svchost', pid: 812, cpuSeconds: 12.0, workingSetBytes: 22_000_000, user: 'NT AUTHORITY\\SYSTEM', startedAt: new Date(now - 9 * 3600_000).toISOString() },
  ] });
  await run('service_list', { serviceCount: 2, services: [
    { name: 'Spooler', displayName: 'Print Spooler', state: 'Running', startMode: 'Automatic', account: 'LocalSystem' },
    { name: 'wuauserv', displayName: 'Windows Update', state: 'Stopped', startMode: 'Manual', account: 'LocalSystem' },
  ] });
  await run('network_adapters', { adapters: [
    { name: 'Intel(R) Ethernet Connection I219-LM', connectionId: 'Ethernet', status: 'Connected', up: true, mac: '00-11-22-AA-BB-CC', speedBps: 1e9,
      ipv4: ['10.20.0.5'], ipv6: ['fe80::1'], gateway: ['10.20.0.1'], dnsServers: ['10.20.0.1'], dnsSuffix: 'corp.example.com', dhcpEnabled: true, dhcpServer: '10.20.0.1' },
  ] });
  return { tenant, A, B, site, admin, owner, main, others, linux };
}

async function cleanup() {
  const ids = created.businesses;
  const steps = [
    ['saved views', () => prisma.savedView.deleteMany({ where: { OR: [{ customerId: { in: ids } }, { userId: { in: created.users } }] } })],
    ['api keys', () => prisma.apiKey.deleteMany({ where: { customerId: { in: ids } } })],
    ['enrolment tokens', () => prisma.deviceClaimToken.deleteMany({ where: { customerId: { in: ids } } })],
    ['endpoints', async () => {
      const eps = (await prisma.endpoint.findMany({ where: { customerId: { in: ids } }, select: { id: true } })).map((e) => e.id);
      await prisma.endpointCommand.deleteMany({ where: { endpointId: { in: eps } } }).catch(() => {});
      return prisma.endpoint.deleteMany({ where: { id: { in: eps } } });
    }],
    ['device groups', () => prisma.endpointGroup.deleteMany({ where: { customerId: { in: ids } } })],
    ['sites', () => prisma.site.deleteMany({ where: { customerId: { in: ids } } })],
    ['memberships', () => prisma.membership.deleteMany({ where: { OR: [{ customerId: { in: ids } }, { userId: { in: created.users } }] } })],
    ['businesses', () => prisma.customer.deleteMany({ where: { id: { in: ids } } })],
    ['users', () => prisma.user.deleteMany({ where: { id: { in: created.users } } })],
  ];
  for (const [what, fn] of steps) {
    try { await fn(); } catch (e) { console.error(`  cleanup (${what}): ${e.message.split('\n').filter(Boolean).pop()}`); }
  }
}

// ── Browser helpers ─────────────────────────────────────────────────────────
const VIEWPORTS = {
  desktop: { viewport: { width: 1440, height: 900 } },
  phone: { viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 },
};

/**
 * Everything a page reports that a person would never see: console errors,
 * uncaught exceptions, and failed same-origin requests. "Failed to load
 * resource" console lines are the browser's echo of a failed request, and
 * the request itself is what is judged (with its status and code), so only
 * the echo is dropped.
 */
function instrument(page) {
  page.problems = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/^Failed to load resource:/.test(t)) return;
    page.problems.push({ kind: 'console', text: t });
  });
  page.on('pageerror', (e) => page.problems.push({ kind: 'uncaught', text: e.stack ?? e.message }));
  page.on('response', async (r) => {
    if (!r.url().startsWith(WEB) || r.status() < 400) return;
    const entry = { kind: 'http', status: r.status(), method: r.request().method(), url: r.url().slice(WEB.length) };
    page.problems.push(entry);
    try { entry.code = (await r.json())?.code; } catch { /* not JSON */ }
  });
  page.on('requestfailed', (r) => {
    // A navigation away aborts in-flight requests; that is not a fault.
    if (!r.url().startsWith(WEB) || /ERR_ABORTED/.test(r.failure()?.errorText ?? '')) return;
    page.problems.push({ kind: 'network', text: `${r.method()} ${r.url().slice(WEB.length)} ${r.failure()?.errorText}` });
  });
}
/** The problems since the last call, minus the ones this step provokes on purpose. */
function takeProblems(page, allow = () => false) {
  const all = page.problems.splice(0);
  return all.filter((p) => !allow(p));
}
const stepUp403 = (p) => p.kind === 'http' && p.status === 403 && p.code === 'STEP_UP_REQUIRED';
const fmtProblems = (ps) => ps.map((p) => (p.kind === 'http' ? `${p.method} ${p.url} → ${p.status}${p.code ? ` ${p.code}` : ''}` : `${p.kind}: ${p.text.split('\n').slice(0, 3).join(' | ')}`)).join('\n      ');

async function cleanCheck(page, label, allow) {
  await sleep(150);
  const ps = takeProblems(page, allow);
  check(ps.length === 0, `${label}: no console errors, exceptions or failed requests`, fmtProblems(ps));
}

async function hydrated(page) {
  await page.waitForFunction(() => document.documentElement.dataset.hydrated === '1', null, { timeout: 30_000 });
}
/** Network quiet and no "Loading…" left in the page. */
async function settled(page, timeout = 20_000) {
  await page.waitForLoadState('networkidle', { timeout }).catch(() => {});
  await page.waitForFunction(() => !/Loading…|Loading\.\.\.|Opening…/.test(document.querySelector('main')?.innerText ?? ''), null, { timeout }).catch(() => {});
}
async function go(page, href) {
  await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': ip() });
  await page.goto(`${WEB}${href}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await hydrated(page);
  await settled(page);
}

/**
 * Sideways scroll: the document and <main> must not be wider than the
 * screen. The culprit is the outermost element that pokes out with no
 * scrolling container between it and <main>.
 */
async function overflow(page) {
  return page.evaluate(() => {
    const de = document.documentElement;
    const main = document.querySelector('main');
    const res = { doc: de.scrollWidth - de.clientWidth, main: main ? main.scrollWidth - main.clientWidth : 0, culprit: null };
    if ((res.doc > 1 || res.main > 1) && main) {
      const limit = Math.min(main.getBoundingClientRect().right, de.clientWidth) + 1;
      for (const el of main.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.right <= limit) continue;
        if (getComputedStyle(el).position === 'fixed') continue;
        let a = el.parentElement, contained = false;
        while (a && a !== main) { if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(a).overflowX)) { contained = true; break; } a = a.parentElement; }
        if (contained) continue;
        res.culprit = `<${el.tagName.toLowerCase()} class="${String(el.className).slice(0, 120)}"> right=${Math.round(r.right)} text="${(el.textContent ?? '').trim().slice(0, 60)}"`;
        break;
      }
      // Content spilling out of a box that is itself narrow enough (a long
      // unbreakable word): the deepest element whose content is wider than it.
      if (!res.culprit) {
        const spill = [...main.querySelectorAll('*')].filter((el) => el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0 && getComputedStyle(el).overflowX === 'visible').pop();
        if (spill) res.culprit = `content wider than <${spill.tagName.toLowerCase()} class="${String(spill.className).slice(0, 120)}"> (${spill.scrollWidth} > ${spill.clientWidth}) text="${(spill.textContent ?? '').trim().slice(0, 60)}"`;
      }
    }
    return res;
  });
}
async function noSideScroll(page, label) {
  const o = await overflow(page);
  check(o.doc <= 1 && o.main <= 1, `${label}: no sideways page scroll`, JSON.stringify(o));
}
const lum = (rgb) => { const m = rgb.match(/\d+(\.\d+)?/g)?.map(Number) ?? [0, 0, 0]; return (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255; };
async function themeCheck(page, theme, label) {
  const { dark, bg } = await page.evaluate(() => ({ dark: document.documentElement.classList.contains('dark'), bg: getComputedStyle(document.body).backgroundColor }));
  check(dark === (theme === 'dark') && (theme === 'dark' ? lum(bg) < 0.25 : lum(bg) > 0.8), `${label}: the ${theme} theme from localStorage.theme`, `html.dark=${dark} body=${bg}`);
}
/** The device list's search is debounced: wait for the rows to match, not for the first row to appear. */
async function rowsSettle(page, n, not = false) {
  await page.waitForFunction(([k, neg]) => (document.querySelectorAll('tbody tr input[type=checkbox]').length === k) !== neg, [n, not], { timeout: 15_000 }).catch(() => {});
  await settled(page);
  return page.locator('tbody tr input[type=checkbox]').count();
}
const shot = (page, name) => page.screenshot({ path: path.join(OUT_DIR, `${name.replace(/\//g, '-')}.png`) }).catch(() => {});

async function newContext(browser, vp, theme) {
  const ctx = await browser.newContext({ ...VIEWPORTS[vp], extraHTTPHeaders: { 'x-forwarded-for': ip() } });
  // The application's own theme store, set before any of its scripts run.
  await ctx.addInitScript((t) => { try { localStorage.setItem('theme', t); } catch { /* storage unavailable */ } }, theme);
  return ctx;
}

async function signIn(ctx, email, label, theme) {
  const page = await ctx.newPage();
  instrument(page);
  await go(page, '/login');
  // The detector itself, before it is trusted to report a clean page.
  await page.evaluate(() => { console.error('e2e-ui self-test'); setTimeout(() => { throw new Error('e2e-ui self-test'); }, 0); });
  await sleep(200);
  const self = takeProblems(page);
  check(self.some((p) => p.kind === 'console') && self.some((p) => p.kind === 'uncaught'), `${label}: a console error and an uncaught exception are both caught`, fmtProblems(self));
  await themeCheck(page, theme, `${label} sign-in page`);
  await noSideScroll(page, `${label} sign-in page`);
  await page.fill('input[type=email]', email);
  await page.fill('input[type=password]', PW);
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30_000 }), page.click('button[type=submit]')]);
  await hydrated(page);
  await settled(page);
  check(!new URL(page.url()).pathname.startsWith('/login') && await page.locator('[data-testid="top-bar"]').isVisible(), `${label} signs in and lands in the console`, page.url());
  // A signed-out visitor's /auth/me (and the like) answer 401 before sign-in: that is the sign-in page working.
  await cleanCheck(page, `${label} sign-in`, (p) => p.kind === 'http' && p.status === 401 && /^\/api\/v1\/auth\//.test(p.url));
  return page;
}

// ── The checks ──────────────────────────────────────────────────────────────

async function shellChecks(page, vp, label) {
  const trigger = page.locator('[data-testid="nav-drawer-trigger"]');
  const desktopNav = page.locator('nav[aria-label="Main"]').first();
  if (vp === 'desktop') {
    check(!(await trigger.isVisible()) && await desktopNav.isVisible(), `${label}: the sidebar sits beside the page and there is no menu button`);
    return;
  }
  check(await trigger.isVisible() && !(await desktopNav.isVisible()), `${label}: no sidebar beside the page; a menu button in the top bar`);
  check(await trigger.getAttribute('aria-expanded') === 'false' && await trigger.getAttribute('aria-label') === 'Open menu', `${label}: the menu button is labelled and reports it is closed`);
  const drawer = page.locator('[data-testid="nav-drawer"]');
  await trigger.click();
  await drawer.waitFor({ state: 'visible', timeout: 10_000 });
  const a11y = await drawer.evaluate((el) => {
    const lab = el.getAttribute('aria-labelledby');
    return { role: el.getAttribute('role'), modal: el.getAttribute('aria-modal'), name: lab ? document.getElementById(lab)?.textContent : el.getAttribute('aria-label') };
  });
  check(a11y.role === 'dialog' && a11y.modal === 'true' && a11y.name === 'Main menu', `${label}: the drawer is a modal dialog named "Main menu"`, JSON.stringify(a11y));
  check(await trigger.getAttribute('aria-expanded') === 'true', `${label}: the menu button reports it is open`);
  const box = await drawer.boundingBox();
  check(box && box.x >= 0 && box.width <= 375 && box.height >= 700, `${label}: the drawer fits the screen`, JSON.stringify(box));
  check(await drawer.locator('nav[aria-label="Main"] [data-nav]').count() >= 3, `${label}: it holds the main menu`);
  await shot(page, `${label}-drawer`);
  // Focus is inside and stays inside, both ways round.
  let escaped = 0;
  for (let i = 0; i < 40; i++) { await page.keyboard.press('Tab'); if (!(await drawer.evaluate((el) => el.contains(document.activeElement)))) escaped++; }
  for (let i = 0; i < 8; i++) { await page.keyboard.press('Shift+Tab'); if (!(await drawer.evaluate((el) => el.contains(document.activeElement)))) escaped++; }
  check(escaped === 0, `${label}: Tab and Shift+Tab keep focus inside the open drawer`, `${escaped} presses left it`);
  await page.keyboard.press('Escape');
  await drawer.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
  check(!(await drawer.isVisible()) && await trigger.evaluate((el) => el === document.activeElement), `${label}: Esc closes it and focus returns to the menu button`);
  // A tap outside closes it.
  await trigger.click();
  await drawer.waitFor({ state: 'visible' });
  // Radix's DismissableLayer attaches its outside-pointerdown listener in a
  // setTimeout(0) after the dialog mounts, so a tap sent the instant the
  // drawer is visible can land before anything is listening — which is what
  // failed on a CI runner. Let a few tasks and two frames pass first.
  await page.evaluate(() => new Promise((r) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(r)), 50)));
  await page.mouse.click(360, 600);
  await drawer.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
  check(!(await drawer.isVisible()), `${label}: a tap outside closes it`);
  // Navigation closes it — to another page, and to the page already open.
  await trigger.click();
  await drawer.waitFor({ state: 'visible' });
  await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': ip() });
  await drawer.locator('[data-nav="devices"]').click();
  await page.waitForURL((u) => u.pathname === '/endpoints', { timeout: 15_000 }).catch(() => {});
  await drawer.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
  check(new URL(page.url()).pathname === '/endpoints' && !(await drawer.isVisible()), `${label}: following a menu link navigates and closes the drawer`, page.url());
  await settled(page);
  await trigger.click();
  await drawer.waitFor({ state: 'visible' });
  await drawer.locator('[data-nav="devices"]').click();
  await drawer.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
  check(!(await drawer.isVisible()), `${label}: a link to the page already open closes it too`);
}

async function mainPagesSweep(page, vp, label) {
  // The pages a person reaches from the menu, plus the hub tabs: taken from
  // the menu itself, so a page added to it is swept without editing this.
  let hrefs;
  if (vp === 'phone') {
    await page.locator('[data-testid="nav-drawer-trigger"]').click();
    const drawer = page.locator('[data-testid="nav-drawer"]');
    await drawer.waitFor({ state: 'visible' });
    const settings = drawer.locator('[data-nav="settings"]');
    if (await settings.getAttribute('aria-expanded') === 'false') await settings.click();
    hrefs = await drawer.locator('a[href^="/"]').evaluateAll((els) => els.map((e) => e.getAttribute('href')));
    await page.keyboard.press('Escape');
    await drawer.waitFor({ state: 'hidden' });
  } else {
    const settings = page.locator('nav[aria-label="Main"] [data-nav="settings"]').first();
    if (await settings.getAttribute('aria-expanded') === 'false') await settings.click();
    hrefs = await page.locator('aside a[href^="/"]').evaluateAll((els) => els.map((e) => e.getAttribute('href')));
  }
  const extra = ['/my-computers', '/sessions', '/quick-connect', '/patching', '/endpoints/enroll', '/endpoints/new', '/settings/api-keys', '/settings/monitoring', '/settings/client-updates', '/reports/agent-coverage', '/reports/offline-time', '/reports/patch-compliance', '/reports/alert-frequency'];
  const all = [...new Set([...hrefs, ...extra])].filter((h) => !/^\/(docs|help)\//.test(h));
  check(all.length >= 15, `${label}: ${all.length} main pages to sweep`);
  const bad = [], noisy = [];
  for (const href of all) {
    await go(page, href);
    const o = await overflow(page);
    if (o.doc > 1 || o.main > 1) bad.push(`${href}: ${JSON.stringify(o)}`);
    const ps = takeProblems(page);
    if (ps.length) noisy.push(`${href}: ${fmtProblems(ps)}`);
  }
  check(bad.length === 0, `${label}: none of them scrolls sideways`, bad.join('\n      '));
  check(noisy.length === 0, `${label}: none of them logs an error or fails a request`, noisy.join('\n      '));
}

async function devicesAndWorkspace(page, f, vp, label) {
  await go(page, '/endpoints');
  const search = page.locator('input[aria-label="Search devices"]');
  await search.fill(`${TAG}-WS`);
  const row = page.locator(`table a[href="/endpoints/${f.main.id}"]`);
  const rows = await rowsSettle(page, 5);
  check(rows === 5, `${label}: the device list finds the five ${TAG}-WS devices`, `rows ${rows}`);
  if (vp === 'phone') {
    const table = await page.locator('table').first().evaluate((t) => ({ table: t.scrollWidth, box: t.parentElement.clientWidth, scrolls: getComputedStyle(t.parentElement).overflowX }));
    check(table.table > table.box && /auto|scroll/.test(table.scrolls), `${label}: the wide table scrolls inside its own container`, JSON.stringify(table));
  }
  await noSideScroll(page, `${label} device list`);
  await shot(page, `${label}-devices`);
  await cleanCheck(page, `${label} device list`);

  await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': ip() });
  await row.click();
  await page.waitForURL((u) => u.pathname === `/endpoints/${f.main.id}`, { timeout: 15_000 });
  await page.locator('[data-testid="workspace-tabs"]').waitFor({ timeout: 20_000 });
  await settled(page);
  check(await page.locator('main').innerText().then((t) => t.includes(`${TAG}-WS-01`)), `${label}: the device opens on its workspace`);
  const tabs = await page.locator('[data-testid="workspace-tabs"] [role="tab"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid').replace(/^tab-/, '')));
  const expected = ['overview', 'performance', 'monitoring', 'software', 'processes', 'services', 'network', 'patches', 'events', 'diagnostics', 'actions', 'history'];
  check(expected.every((t) => tabs.includes(t)), `${label}: all twelve workspace tabs for a Windows agent`, tabs.join(','));
  await cleanCheck(page, `${label} workspace`);
  // What each tab must show from the fixtures, so "renders" means rendered.
  const proof = {
    overview: (t) => t.includes('Contoso') || t.includes('Windows 11'),
    performance: async () => (await page.locator('[data-testid="performance-tab"] svg').count()) > 0,
    processes: (t) => t.includes('explorer') && t.includes('OUTLOOK'),
    services: (t) => t.includes('Print Spooler'),
    network: (t) => t.includes('Intel(R) Ethernet Connection I219-LM'),
  };
  for (const t of tabs) {
    await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': ip() });
    await page.locator(`[data-testid="tab-${t}"]`).click();
    const panel = page.locator('[role="tabpanel"][data-state="active"]');
    await panel.waitFor({ timeout: 10_000 });
    await settled(page, 12_000);
    const text = (await panel.innerText().catch(() => '')).trim();
    const p = proof[t];
    const ok = p ? await p(text) : text.length > 0;
    check(ok && await page.locator(`[data-testid="tab-${t}"]`).getAttribute('aria-selected') === 'true', `${label}: the ${t} tab renders${p ? ' the fixture data' : ''}`, text.slice(0, 200));
    if (vp === 'phone') await noSideScroll(page, `${label} ${t} tab`);
    if (['performance', 'processes', 'network'].includes(t)) await shot(page, `${label}-tab-${t}`);
    await cleanCheck(page, `${label} ${t} tab`);
  }
}

async function savedViewAndBulk(page, f, vp, label) {
  await go(page, '/endpoints');
  const search = page.locator('input[aria-label="Search devices"]');
  await search.fill(`${TAG}-WS-0`);
  await rowsSettle(page, 5);
  // Save it.
  const name = `${TAG} ${label}`.slice(0, 60);
  await page.getByRole('button', { name: /^Views$/ }).click();
  await page.getByRole('menuitem', { name: 'Save current view…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Save this view' });
  await dlg.waitFor();
  const dbox = await dlg.boundingBox();
  check(dbox && dbox.x >= 0 && dbox.x + dbox.width <= VIEWPORTS[vp].viewport.width + 0.5, `${label}: the save-view dialog fits the screen`, JSON.stringify(dbox));
  await dlg.locator('input:not([type=checkbox])').fill(name);
  await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': ip() });
  await dlg.getByRole('button', { name: 'Save' }).click();
  await dlg.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {});
  let saved = null;
  for (let i = 0; i < 20 && !saved; i++) { saved = await prisma.savedView.findFirst({ where: { userId: f.admin.id, name } }); if (!saved) await sleep(250); }
  check(!!saved && JSON.stringify(saved.filters).includes(`${TAG}-WS-0`), `${label}: saving a view stores the filters under its name`, JSON.stringify(saved?.filters));
  // Clear, then open it again.
  await search.fill('');
  await rowsSettle(page, 5, true);
  await page.getByRole('button', { name: new RegExp(`^(Views|${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})$`) }).click();
  await page.getByRole('menuitem').filter({ has: page.getByRole('button', { name: `Delete view ${name}` }) }).click();
  const n = await rowsSettle(page, 5);
  check(await search.inputValue() === `${TAG}-WS-0` && n === 5, `${label}: opening the view restores its search and rows`, await search.inputValue());
  await cleanCheck(page, `${label} saved view`);

  // Bulk selection.
  await page.getByRole('checkbox', { name: `Select ${TAG}-WS-01` }).check();
  await page.getByRole('checkbox', { name: `Select ${TAG}-WS-02` }).check();
  const bar = page.getByRole('region', { name: 'Bulk actions' });
  await bar.waitFor({ timeout: 5_000 });
  check((await bar.innerText()).includes('2 selected'), `${label}: two rows selected shows the bulk bar with the count`);
  if (vp === 'phone') { const b = await bar.boundingBox(); check(b && b.x + b.width <= 375.5, `${label}: the bulk bar wraps within the screen`, JSON.stringify(b)); }
  await noSideScroll(page, `${label} bulk bar`);
  await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': ip() });
  await bar.getByRole('button', { name: /Refresh inventory/ }).click();
  const result = page.getByRole('dialog').filter({ hasText: /of 2 done/ });
  await result.waitFor({ timeout: 15_000 }).catch(() => {});
  check(await result.isVisible() && /2 of 2 done/.test(await result.innerText()), `${label}: Refresh inventory reports what the server did with each`, await result.innerText().catch(() => ''));
  await shot(page, `${label}-bulk-result`);
  await page.keyboard.press('Escape');
  await result.waitFor({ state: 'hidden' }).catch(() => {});
  await page.getByRole('checkbox', { name: 'Select every device on this page' }).check();
  check((await bar.innerText()).includes('5 selected'), `${label}: the header checkbox selects every device on the page`);
  await bar.getByRole('button', { name: /Clear selection/ }).click();
  await bar.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
  check(!(await bar.isVisible()), `${label}: Clear selection removes the bar`);
  await cleanCheck(page, `${label} bulk selection`);
}

async function palette(page, f, vp, label) {
  await go(page, '/dashboard');
  const pal = page.locator('[data-testid="global-search"]');
  if (vp === 'desktop') await page.keyboard.press('Control+k');
  else await page.locator('[data-testid="global-search-trigger"]').click();
  await pal.waitFor({ timeout: 5_000 });
  check(await page.locator('[data-testid="global-search-input"]').evaluate((el) => el === document.activeElement), `${label}: ${vp === 'desktop' ? 'Ctrl+K' : 'the search button'} opens the palette with the input focused`);
  await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': ip() });
  await page.locator('[data-testid="global-search-input"]').pressSequentially(`${TAG}-WS-01`, { delay: 20 });
  const opt = page.locator('[data-group="computers"] [role="option"]');
  await opt.first().waitFor({ timeout: 15_000 }).catch(() => {});
  check(await opt.count() === 1, `${label}: the palette finds the device`, `options ${await opt.count()}`);
  const b = await pal.boundingBox();
  const vw = VIEWPORTS[vp].viewport;
  check(b && b.x >= 0 && b.x + b.width <= vw.width + 0.5 && b.y + b.height <= vw.height + 0.5, `${label}: the palette fits the screen`, JSON.stringify(b));
  await shot(page, `${label}-palette`);
  await page.keyboard.press('Enter');
  await page.waitForURL((u) => u.pathname === `/endpoints/${f.main.id}`, { timeout: 15_000 }).catch(() => {});
  check(new URL(page.url()).pathname === `/endpoints/${f.main.id}` && !(await pal.isVisible()), `${label}: Enter opens the device and closes the palette`, page.url());
  await settled(page);
  await page.keyboard.press('Control+k');
  await pal.waitFor({ timeout: 5_000 }).catch(() => {});
  await page.keyboard.press('Escape');
  await pal.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
  check(!(await pal.isVisible()), `${label}: Esc closes the palette`);
  await cleanCheck(page, `${label} search palette`);
}

const stepUpDialog = (page) => page.getByRole('dialog').filter({ hasText: 'Confirm it’s you' }).or(page.getByRole('dialog').filter({ hasText: "Confirm it's you" }));

async function addDevice(page, f, vp, label) {
  await go(page, '/endpoints/enroll');
  await noSideScroll(page, `${label} Add device`);
  await page.locator('#ad-business').selectOption(f.A.id);
  await page.getByRole('radio', { name: /Everyone in the business/ }).check();
  await page.locator('[data-testid="place-next"]').click();
  await page.getByRole('radio', { name: /Windows/ }).first().check();
  const before = await prisma.deviceClaimToken.count({ where: { customerId: f.A.id } });
  await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': ip() });
  await page.locator('[data-testid="make-link"]').click();
  const dlg = stepUpDialog(page);
  await dlg.waitFor({ timeout: 10_000 }).catch(() => {});
  check(await dlg.isVisible() && /make an install link/.test(await dlg.innerText()), `${label}: making an install link asks to confirm it's you, and says why`, await dlg.innerText().catch(() => ''));
  if (vp === 'phone') { const b = await dlg.boundingBox(); check(b && b.x >= 0 && b.x + b.width <= 375.5, `${label}: the step-up dialog fits the screen`, JSON.stringify(b)); }
  await shot(page, `${label}-stepup`);
  await page.keyboard.press('Escape');
  await dlg.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
  await page.locator('[data-testid="create-stepup-cancelled"]').waitFor({ timeout: 10_000 }).catch(() => {});
  check(await page.locator('[data-testid="create-stepup-cancelled"]').isVisible() && await prisma.deviceClaimToken.count({ where: { customerId: f.A.id } }) === before,
    `${label}: cancelling makes no link and says so, keeping the choices`);
  await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': ip() });
  await page.locator('[data-testid="make-link"]').click();
  await dlg.waitFor({ timeout: 10_000 });
  await dlg.locator('#stepup-value').fill(PW);
  await dlg.getByRole('button', { name: 'Confirm' }).click();
  await dlg.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {});
  const cmd = page.locator('[data-testid="step-command"][data-step-state="active"]');
  await cmd.waitFor({ timeout: 15_000 }).catch(() => {});
  check(await cmd.isVisible() && await prisma.deviceClaimToken.count({ where: { customerId: f.A.id } }) === before + 1, `${label}: confirming makes exactly one link and shows the install command`);
  if (vp === 'phone') await noSideScroll(page, `${label} install command`);
  await shot(page, `${label}-add-device`);
  await cleanCheck(page, `${label} Add device`, stepUp403);
}

async function reports(page, label, vp) {
  await go(page, '/reports');
  await page.waitForURL((u) => u.pathname !== '/reports', { timeout: 15_000 }).catch(() => {});
  check(/^\/reports\/[a-z-]+$/.test(new URL(page.url()).pathname), `${label}: /reports opens the first report`, page.url());
  await cleanCheck(page, `${label} /reports`);
  for (const r of ['agent-coverage', 'offline-time', 'patch-compliance', 'alert-frequency']) {
    await go(page, `/reports/${r}`);
    const h1 = (await page.locator('main h1').first().innerText().catch(() => '')).trim();
    check(h1.length > 0 && !/could not|failed/i.test(await page.locator('main').innerText()), `${label}: the ${r} report renders`, h1);
    if (vp === 'phone') await noSideScroll(page, `${label} ${r}`);
    await cleanCheck(page, `${label} ${r} report`);
  }
  await shot(page, `${label}-report`);
}

async function systemStatus(page, label, vp) {
  await go(page, '/admin/status');
  const text = await page.locator('main').innerText();
  const want = ['Uptime', 'CPU Load', 'Memory', 'Disk', 'Services'];
  check(want.every((w) => text.includes(w)), `${label}: System status shows its cards`, want.filter((w) => !text.includes(w)).join(', '));
  // The Data retention card (0.34) where this build has one: it must list its tables, not an error.
  if (text.includes('Data retention')) {
    await page.locator('[data-testid^="retention-"]').first().waitFor({ timeout: 10_000 }).catch(() => {});
    check(await page.locator('[data-testid^="retention-"]').count() > 0, `${label}: the Data retention card lists its tables`);
  }
  if (vp === 'phone') await noSideScroll(page, `${label} System status`);
  await shot(page, `${label}-status`);
  await cleanCheck(page, `${label} System status`);
}

async function apiKeys(browser, f, vp, theme, label) {
  const ctx = await newContext(browser, vp, theme);
  try {
    const page = await signIn(ctx, f.owner.email, `${label} (Business Owner)`, theme);
    await go(page, '/settings/api-keys');
    await noSideScroll(page, `${label} API keys`);
    const keyName = `${TAG} ${vp} ${theme}`;
    const count = () => prisma.apiKey.count({ where: { customerId: f.A.id, name: keyName } });
    await page.locator('#ak-name').fill(keyName);
    await page.locator('label').filter({ hasText: 'enrollment:write' }).locator('input[type=checkbox]').check();
    await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': ip() });
    await page.getByRole('button', { name: 'Create key' }).click();
    const dlg = stepUpDialog(page);
    await dlg.waitFor({ timeout: 10_000 }).catch(() => {});
    // 0.34 (§34): every API key needs a fresh sign-in, not only one with enrollment:write.
    check(await dlg.isVisible() && /To create an API key, confirm your identity/.test(await dlg.innerText()), `${label}: creating a key (here with enrollment:write) asks to confirm it's you, and says why`, await dlg.innerText().catch(() => ''));
    await dlg.getByRole('button', { name: 'Close' }).click();
    await dlg.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
    await sleep(500);
    check(await count() === 0 && !(await page.locator('[data-testid="apikey-created"]').isVisible()), `${label}: cancelling the step-up creates no key`);
    check(await page.locator('#ak-name').inputValue() === keyName, `${label}: the form keeps what was typed`);
    await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': ip() });
    await page.getByRole('button', { name: 'Create key' }).click();
    await dlg.waitFor({ timeout: 10_000 });
    await dlg.locator('#stepup-value').fill(PW);
    await dlg.getByRole('button', { name: 'Confirm' }).click();
    const createdCard = page.locator('[data-testid="apikey-created"]');
    await createdCard.waitFor({ timeout: 15_000 }).catch(() => {});
    check(await createdCard.isVisible() && await count() === 1, `${label}: confirming creates the key and shows it once`);
    // The list refetches after the create: wait for the row, not for a table that may already be there.
    await page.locator('[data-testid="apikey-list"] tr').filter({ hasText: keyName }).waitFor({ timeout: 15_000 }).catch(() => {});
    check((await page.locator('[data-testid="apikey-list"]').innerText()).includes(keyName), `${label}: the new key is listed`);
    if (vp === 'phone') await noSideScroll(page, `${label} API keys list`);
    await shot(page, `${label}-api-keys`);
    await createdCard.getByRole('button', { name: 'I have saved it' }).click();
    await cleanCheck(page, `${label} API keys`, stepUp403);
  } finally { await ctx.close(); }
}

async function combo(browser, f, vp, theme) {
  const label = `${vp}/${theme}`;
  section(`${vp === 'desktop' ? 'Desktop 1440 × 900' : 'Phone 375 × 812'}, ${theme} theme`);
  const ctx = await newContext(browser, vp, theme);
  try {
    const page = await signIn(ctx, f.admin.email, label, theme);
    await themeCheck(page, theme, `${label} console`);
    await shot(page, `${label}-dashboard`);
    await shellChecks(page, vp, label);
    await cleanCheck(page, `${label} menu`);
    await devicesAndWorkspace(page, f, vp, label);
    await savedViewAndBulk(page, f, vp, label);
    await palette(page, f, vp, label);
    await addDevice(page, f, vp, label);
    await reports(page, label, vp);
    await systemStatus(page, label, vp);
    if (theme === 'light') await mainPagesSweep(page, vp, label);
  } finally { await ctx.close(); }
  await apiKeys(browser, f, vp, theme, label);
}

/**
 * 0.35: the Processes tab updates itself. A computer of its own, with a device
 * secret, so this suite can play the agent: heartbeat to the suite's API and
 * post the result the way heartbeat.ps1 does. Proves, at one viewport, with no
 * reload in between (a marker set on `window` must survive):
 *   - the honest state before anything is taken (SNAPSHOT_SWEEP=off here, so
 *     `process_off`, not "Refresh asks for one");
 *   - Refresh → pending → the device completes → the new list appears (the
 *     4 s poll while pending);
 *   - a run the page did not ask for (another person's Refresh, written
 *     straight to the database) completes → the new list appears on the
 *     30 s re-read while the tab is open.
 */
async function snapshotAutoUpdate(browser, f, vp) {
  const label = `${vp} snapshots`;
  section(`Snapshot tab updates itself (${vp === 'desktop' ? '1440 × 900' : '375 × 812'})`);
  const secret = randomBytes(24).toString('hex');
  const rid = String(100000000 + ((Math.random() * 899999999) | 0));
  const name = `${TAG}-SNAP-${vp}`.toUpperCase();
  const ep = await prisma.endpoint.create({ data: {
    tenantId: f.tenant.id, customerId: f.A.id, name, hostname: name, platform: 'Windows', osVersion: 'Windows 11 Pro', status: 'ACTIVE',
    isOnline: true, isManaged: true, accessMode: 'COMPANY_WIDE', lastSeenAt: new Date(), deviceClass: 'WORKSTATION', agentVersion: '0.35.0',
  } });
  const { createHash } = await import('crypto');
  await prisma.rustdeskNode.create({ data: { tenantId: f.tenant.id, endpointId: ep.id, rustdeskId: rid, agentSecretHash: createHash('sha256').update(secret).digest('hex') } });
  const device = async (pathname, body) => {
    const r = await fetch(`${API_ORIGIN}/api/v1/enrollment/${pathname}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip() }, body: JSON.stringify({ rustdeskId: rid, agentSecret: secret, ...body }) });
    return r.json().catch(() => ({}));
  };
  /** One check-in, answering every process_list run handed out with a list holding `proc`. */
  const checkIn = async (proc) => {
    const hb = await device('heartbeat', { hostname: name, platform: 'Windows', agentVersion: '0.35.0' });
    const runs = (hb?.data?.diagnostics ?? []).filter((d) => d.key === 'process_list');
    for (const d of runs) {
      await device('diagnostic-result', { runId: d.id, key: d.key, state: 'running' });
      await device('diagnostic-result', { runId: d.id, key: d.key, state: 'completed', result: { processCount: 1, userNamesRead: true, processes: [{ name: proc, pid: 4321, cpuSeconds: 1.5, workingSetBytes: 5e7, user: 'CORP\\frontdesk', startedAt: new Date().toISOString() }] } });
    }
    return runs.length;
  };
  const ctx = await newContext(browser, vp, 'light');
  try {
    const page = await signIn(ctx, f.admin.email, label, 'light');
    await go(page, `/endpoints/${ep.id}?tab=processes`);
    const card = page.locator('[data-testid="snapshot-process_list"]');
    await card.waitFor({ timeout: 20_000 });
    await page.evaluate(() => { window.__noReload = 'still-here'; });
    const blocked = page.locator('[data-testid="snapshot-blocked"]');
    check(await blocked.getAttribute('data-reason').catch(() => null) === 'process_off' && /SNAPSHOT_SWEEP=off/.test(await blocked.innerText().catch(() => '')),
      `${label}: before anything is taken, the tab says why nothing arrives on its own (process_off), not "Refresh asks for one"`, await card.innerText().catch(() => ''));
    check(!/Refresh asks for one/.test(await card.innerText()), `${label}: the old dead-end wording is gone`);

    // 1. Refresh, then the device answers: the 4 s poll picks it up.
    await page.locator('[data-testid="snapshot-refresh"]').click();
    await page.locator('[data-testid="snapshot-pending"]').waitFor({ timeout: 10_000 });
    check(true, `${label}: Refresh shows the request pending`);
    const first = `autosnap-first-${vp}`;
    check((await checkIn(first)) === 1, `${label}: the simulated device is handed the run and completes it`);
    const t0 = Date.now();
    const shown1 = await page.waitForFunction((n) => document.querySelector('[data-testid="snapshot-process_list"]')?.innerText.includes(n), first, { timeout: 15_000 }).then(() => true).catch(() => false);
    check(shown1, `${label}: the new list appears without a reload (${Math.round((Date.now() - t0) / 1000)} s)`);
    check(await page.locator('[data-testid="snapshot-pending"]').count() === 0 && /Taken just now/.test(await page.locator('[data-testid="snapshot-age"]').innerText()), `${label}: no longer pending; "Taken just now"`);

    // 2. A run the page did not ask for: only the periodic re-read can show it.
    await prisma.diagnosticRun.create({ data: { endpointId: ep.id, tenantId: f.tenant.id, customerId: f.A.id, key: 'process_list', requestedById: f.owner.id, expiresAt: new Date(Date.now() + 15 * 60_000) } });
    const second = `autosnap-second-${vp}`;
    check((await checkIn(second)) === 1, `${label}: a run someone else asked for is completed by the device`);
    const t1 = Date.now();
    const shown2 = await page.waitForFunction((n) => document.querySelector('[data-testid="snapshot-process_list"]')?.innerText.includes(n), second, { timeout: 45_000 }).then(() => true).catch(() => false);
    check(shown2, `${label}: it appears on the tab's periodic re-read, without a reload (${Math.round((Date.now() - t1) / 1000)} s)`);
    check(await page.evaluate(() => window.__noReload) === 'still-here', `${label}: the page was never reloaded`);
    if (vp === 'phone') await noSideScroll(page, `${label} processes tab`);
    await shot(page, `${label}-processes-auto`);
    await cleanCheck(page, `${label} processes tab`);
  } finally {
    await ctx.close();
    await prisma.diagnosticRun.deleteMany({ where: { endpointId: ep.id } }).catch(() => {});
    await prisma.endpointCommand.deleteMany({ where: { endpointId: ep.id } }).catch(() => {});
    await prisma.endpoint.delete({ where: { id: ep.id } }).catch(() => {});
  }
}

// ── Run ─────────────────────────────────────────────────────────────────────
let copyDir = null;
async function main() {
  section('Stack');
  await ensureSeeded();
  const api = startApi();
  await waitHttp(`${API_ORIGIN}/api/v1/health`, api);
  check(true, `API from dist on ${API_ORIGIN} against ${dbName}`);
  copyDir = prepareWeb();
  const web = startWeb(copyDir);
  await waitHttp(`${WEB}/login`, web, (s) => s === 200);
  // Through the web server's rewrite to this suite's API — not another one.
  const h = await fetch(`${WEB}/api/v1/health`, { headers: { 'x-forwarded-for': ip() } });
  check(h.status < 500, `web on ${WEB}, its /api rewrite reaching the suite's API`, `HTTP ${h.status}`);
  const f = await seed();
  if (process.env.UI_HOLD === '1') {
    // Debugging only: leave the stack and fixtures up until interrupted.
    console.log(`  holding: ${WEB}  admin ${f.admin.email} / owner ${f.owner.email}  password in UI_HOLD_PW_FILE`);
    if (process.env.UI_HOLD_PW_FILE) writeFileSync(process.env.UI_HOLD_PW_FILE, PW, { mode: 0o600 });
    await new Promise((r) => { process.once('SIGINT', r); process.once('SIGTERM', r); });
    fail++; failures.push('UI_HOLD=1: a debugging run, no browser checks were made');
    return;
  }
  check(true, `fixtures: two businesses, a Platform Admin and a Business Owner, seven devices (tag ${TAG})`);
  const browser = await chromium.launch();
  try {
    for (const vp of ['desktop', 'phone']) for (const theme of ['light', 'dark']) await combo(browser, f, vp, theme);
    for (const vp of ['desktop', 'phone']) await snapshotAutoUpdate(browser, f, vp);
  } finally { await browser.close(); }
  await cleanup(); created.businesses = []; created.users = [];

  if (process.env.UI_SKIP_PALETTE !== '1') {
    section('Search palette suite (scripts/e2e-search-palette.mjs) against this stack');
    const r = spawnSync(process.execPath, [path.join(HERE, 'e2e-search-palette.mjs')], {
      cwd: WEB_DIR, encoding: 'utf8', env: { ...process.env, WEB_URL: WEB, OUT_DIR: path.join(OUT_DIR, 'palette') },
    });
    const out = `${r.stdout}${r.stderr}`;
    const summary = out.match(/(\d+) passed, (\d+) failed/);
    check(r.status === 0, `the search palette suite passes${summary ? ` (${summary[1]} passed)` : ''}`, out.slice(-3000));
  }
}

main()
  .catch((e) => { fail++; failures.push(`fatal: ${e.stack ?? e.message}`); console.error(e); })
  .finally(async () => {
    await cleanup();
    await prisma.$disconnect();
    await stopAll();
    if (fail) for (const p of procs) console.log(`\n── ${p.label} log (tail)\n${p.log.slice(-4000)}`);
    if (copyDir) rmSync(copyDir, { recursive: true, force: true });
    console.log(`\nScreenshots: ${OUT_DIR}`);
    console.log(`${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
    if (failures.length) { for (const x of failures) console.log(`  - ${x}`); process.exit(1); }
    process.exit(0);
  });
