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
 * 0.64: the sidebar's "Add device" link under Devices (desktop and the phone
 * drawer, hidden from a Business User without Add computers), and step 3's
 * "Download .exe" button and Command tab for the link just made. Every
 * confirmation now defaults to off, so this suite writes an `ask` row per
 * function (api/scripts/lib/confirm-asks.mjs) before its API starts.
 *
 * 0.35 drives the 0.34 screens that had only been built: the Chat tab (start
 * a chat, send, and watch sent → delivered → shown → read as a simulated
 * computer acknowledges over the real device routes, apps/api/scripts/lib/
 * chat-device.mjs); the Run panel on approved versions with no approval
 * signer; adding a software catalog entry through step-up and the software
 * compliance report; Email settings saved through step-up and a test email to
 * a loopback SMTP sink (lib/smtp-sink.mjs, UI_SMTP_PORT 3503); creating a
 * scheduled report; the Agent card and Agent migrations (and, 0.37, the
 * Full agent page it links to); the History tab's AI
 * summary against a reference ClientSt0r peer that does not advertise
 * device_timeline_v1 (UI_PEER_PORT 3504); and the Data retention card.
 *
 * 0.35 adds: every swept page has its side padding (the heading never sits
 * against the menu or the screen edge); the device page lists the static and
 * rule groups a computer is in, each opening the device list filtered by it;
 * a Linux computer's update and restart wording is Linux's, on the device
 * page and the dashboard; the drawer's close button and the brand header
 * reach 4.5:1 on a pale and on a dark branding accent; "Schedule this
 * report" on each schedulable report opens Scheduled reports prefilled with
 * its filters, for a Platform Admin and a Business Owner, and is not offered
 * to a Business User; and at 375 px the device-list filters sit behind a
 * "Filters (n)" button that opens a sheet, while desktop keeps them inline.
 *
 * 0.36 adds: the login page's brand band and the public Quick Connect page's
 * step numbers and download buttons reach 4.5:1 on a pale, a dark and the
 * default accent; with a containment banner showing, the dashboard still fits
 * 1440 × 900 without scrolling; and the dashboard map draws an agent-silent
 * computer's marker amber, beside a green (online) and a grey (offline) one,
 * with a Business Owner seeing only their own business's markers. The map
 * resolves addresses through the API's own GeoipService against a fixture
 * database this suite writes (apps/api/scripts/lib/mmdb-fixture.mjs) holding
 * only RFC 5737 documentation networks — never the production GeoIP file.
 *
 * 0.37 adds the agent's buttons in the computer page's header, beside
 * Connect, at both widths and in both themes: "Upgrade to full agent" on a
 * standard Windows agent is a real <button disabled> with its reason, the fix
 * and a Devices → Full agent link beside it while no signed release is
 * published, and enabled once one is; it opens the same dialog as the Agent
 * card (and so does the "Agent out of date" chip); a request goes through
 * step-up and both the header ("Upgrade requested — waiting for check-in")
 * and the card follow it; a signed agent shows "Full agent" and no upgrade;
 * Linux shows the command to copy; a Business User (computers:view only) is
 * offered none of it. The published release is a real signed repository made
 * with the offline release tool (RELEASE_BIN, which CI's e2e job builds),
 * served to this suite's API through UPDATE_REPO_DIR and switched on only for
 * those checks — otherwise its timestamp is moved aside, which the API reads
 * as "no signed release" (the Full agent page's step 1 stays "not done").
 *
 * 0.36 also adds the tray's chat window, /assist, at the size the tray opens it
 * and smaller, in the light and dark schemes (UI_COMBOS=assist runs only it):
 * the one-time code leaving the address bar, the cookie, starting a chat,
 * a technician's reply drawn as text, receipts, Enter to send, ending, and
 * the used-link page on going back.
 *
 * 0.53 adds the patch policy editor's maintenance window: Weekly by default,
 * then Monthly — "second Tuesday + 2" previews the next openings the signer's
 * own occurrence function gives, and a day of the month is held at 28 — at
 * both widths and in both themes, cancelled before anything is proposed.
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
import { createHash, generateKeyPairSync, randomBytes } from 'crypto';
import { createServer } from 'http';
import { execFileSync, spawn, spawnSync } from 'child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import path from 'path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(HERE, '..');
const ROOT = path.resolve(WEB_DIR, '../..');
// 0.87: the URLs the pre-0.87 menu linked to, from the migration table's URL column.
const OLD_ROUTES = [...readFileSync(path.join(ROOT, 'docs/NAVIGATION_MIGRATION.md'), 'utf8').matchAll(/^\| [^|]+\| [^|]+\| `(\/[^`?#]*)` \|/gm)].map((m) => m[1]);
const API_DIR = path.join(ROOT, 'apps/api');

// ── Refusals, before anything is started or written ────────────────────────
const FORBIDDEN_PORTS = [3000, 3001, 443, 4000, 4001];
const WEB_PORT = Number(process.env.UI_WEB_PORT ?? 3501);
const API_PORT = Number(process.env.UI_API_PORT ?? 3502);
// 0.35: a loopback SMTP sink (Email settings) and a reference ClientSt0r peer (the AI summary's state).
const SMTP_PORT = Number(process.env.UI_SMTP_PORT ?? 3503);
const PEER_PORT = Number(process.env.UI_PEER_PORT ?? 3504);
for (const p of [WEB_PORT, API_PORT, SMTP_PORT, PEER_PORT]) {
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
// 0.35: the loopback SMTP sink and the device side of chat, shared with the API suites.
const { createSmtpSink } = await import(path.join(API_DIR, 'scripts/lib/smtp-sink.mjs'));
const { chatDevice } = await import(path.join(API_DIR, 'scripts/lib/chat-device.mjs'));
const prisma = new PrismaClient();
// 0.64: every confirmation defaults to off. This suite proves the step-up
// dialog, so it asks for them all before its API reads the policy.
const { confirmEverythingAsks } = await import(path.join(API_DIR, 'scripts/lib/confirm-asks.mjs'));
await confirmEverythingAsks(prisma);

// 0.36: a GeoIP database of three documentation networks, one per connectivity
// state, written here and handed to the API as GEOIP_DB_PATH. Without it the
// API would read whatever is at the default path — on this host, production's.
const { writeCityMmdb } = await import(path.join(API_DIR, 'scripts/lib/mmdb-fixture.mjs'));
const GEO_DIR = mkdtempSync(path.join(tmpdir(), 'rem0te-ui-geo-'));
const GEO = {
  online: { cidr: '192.0.2.0/24', ip: '192.0.2.10', city: 'Online Town', lat: 47.6, lon: -122.3 },
  silent: { cidr: '198.51.100.0/24', ip: '198.51.100.7', city: 'Silent Town', lat: 45.5, lon: -117.0 },
  offline: { cidr: '203.0.113.0/24', ip: '203.0.113.7', city: 'Offline Town', lat: 43.6, lon: -110.2 },
};
const GEOIP_FILE = writeCityMmdb(path.join(GEO_DIR, 'fixture-city.mmdb'),
  Object.values(GEO).map((g) => ({ ...g, region: 'Fixture', regionCode: 'FX', country: 'US', countryName: 'United States' })));

// 0.37: a signed update repository with a signed agent in it, made with the
// offline release tool, for "Upgrade to full agent" to be offered. Its
// timestamp is kept aside (`.off`) except while signedRelease(true) — then the
// API, which reads the repository from disk on every request, sees a release.
/** The release label the suite's signed agent target is published under (0.70.1). */
const SIGNED_AGENT_LABEL = '0.70.1';
const SIGNED = (() => {
  const bin = process.env.RELEASE_BIN;
  if (!bin) return null;
  const work = mkdtempSync(path.join(tmpdir(), 'rem0te-ui-signed-'));
  const keys = path.join(work, 'keys'); const repo = path.join(work, 'repo'); const files = path.join(work, 'files');
  mkdirSync(keys); mkdirSync(files);
  const rel = (...a) => execFileSync(bin, a, { encoding: 'utf8' });
  for (const k of ['r1', 'r2', 'r3', 'targets', 'snapshot', 'timestamp']) rel('keygen', '-out', path.join(keys, `${k}.pem`));
  rel('init', '-repo', repo, '-root-key', path.join(keys, 'r1.pem'), '-root-key', path.join(keys, 'r2.pem'), '-root-key', path.join(keys, 'r3.pem'),
    '-root-threshold', '2', '-targets-key', path.join(keys, 'targets.pem'), '-snapshot-key', path.join(keys, 'snapshot.pem'), '-timestamp-key', path.join(keys, 'timestamp.pem'));
  execFileSync(process.execPath, [path.join(API_DIR, 'scripts/build-signed-installer.mjs'), '--out', path.join(files, 'install.ps1')]);
  const agent = Buffer.concat([Buffer.from('MZ fake signed agent for the UI suite '), randomBytes(64), Buffer.from('REM0TE_INST_URL:'), Buffer.alloc(240)]);
  writeFileSync(path.join(files, 'rem0te-agent.exe'), agent);
  rel('release', '-repo', repo, '-targets-key', path.join(keys, 'targets.pem'), '-snapshot-key', path.join(keys, 'snapshot.pem'), '-timestamp-key', path.join(keys, 'timestamp.pem'),
    '-add', `windows/install.ps1=${path.join(files, 'install.ps1')}`, '-add', `windows/rem0te-agent.exe=${path.join(files, 'rem0te-agent.exe')}`,
    // 0.70.1: the release label the console shows for a signed agent on this build.
    '-custom', `windows/rem0te-agent.exe=${JSON.stringify({ version: SIGNED_AGENT_LABEL })}`);
  const ts = path.join(repo, 'metadata', 'timestamp.json');
  renameSync(ts, `${ts}.off`);
  return { work, repo, ts, agentSha256: createHash('sha256').update(agent).digest('hex') };
})();
function signedRelease(on) {
  if (!SIGNED) return false;
  const { ts } = SIGNED;
  if (on && existsSync(`${ts}.off`)) renameSync(`${ts}.off`, ts);
  if (!on && existsSync(ts)) renameSync(ts, `${ts}.off`);
  return true;
}

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
    RETENTION_SWEEP: 'off', REPORT_SCHEDULE_SWEEP: 'off', SCRIPT_OUTPUT_SWEEP: 'off', CHAT_RETENTION_SWEEP: 'off', TRAY_SWEEP: 'off', AUTO_MIGRATION_SWEEP: 'off', WINGET_INDEX_SWEEP: 'off', WARRANTY_SWEEP: 'off', BACKUP_SYNC_SWEEP: 'off', AUTOMATION_SWEEP: 'off', RESTART_WINDOW_SWEEP: 'off',
    // 0.59: the SSO session safety-net.
    SSO_SESSION_SWEEP: 'off',
    // 0.77: the terminal sweep (expiry and transcript pruning).
    TERMINAL_SWEEP: 'off',
    // 0.80: the MDM sync. The Mobile devices page reads rows this suite writes;
    // the stand-in address makes its connector "ready" (loopback, NODE_ENV=test)
    // and nothing listens there, because nothing syncs.
    MDM_SWEEP: 'off', MDM_TEST_BASE_URL: 'http://127.0.0.1:3509',
    // 0.72: Managed Secure Access is off, as in production; the suite checks
    // the console asks no gated /msa/managed or /msa/grants route.
    MSA_GRANTS: 'off',
    // 0.35: the agent-silent fixture is reachable (isOnline) with an old heartbeat; with no hbbs here the stale sweep would take it offline within a minute.
    STALE_SWEEP: 'off',
    // 0.35 automatic snapshots: the fixtures' snapshots are the only ones, and
    // snapshotAutoUpdate() below drives its device by hand.
    SNAPSHOT_SWEEP: 'off',
    AGENT_AUTO_UPDATE: 'off',
    FRONTEND_URL: WEB, PUBLIC_API_URL: WEB,
    VERSION_FILE: path.join(ROOT, 'version.json'),
    // 0.35: the relay is this suite's SMTP sink on loopback, and the ClientSt0r peer its reference peer.
    SMTP_ALLOW_LOCAL_RELAY: 'loopback', INTEGRATION_PEERS_FILE: peer.file, INTEGRATION_CAPABILITIES_TTL_MS: '0',
    // 0.36: the map's fixture GeoIP database (documentation networks only).
    GEOIP_DB_PATH: GEOIP_FILE,
    // 0.74: Admin → Security reads a fixture host, never the runner's own (and never changes it).
    SECURITY_HOST_FIXTURE: path.join(API_DIR, 'scripts', 'fixtures', 'host-security.json'),
    // 0.37: the suite's own signed repository (see SIGNED), never a real one.
    ...(SIGNED ? { UPDATE_REPO_DIR: SIGNED.repo } : { UPDATE_REPO_DIR: '' }),
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
    // INTERNAL_API_URL is left out, not set to '': next.config.js reads it with
    // `??`, so '' baked in a bare `/api/:path*` destination with no origin and
    // the patch below had nothing to replace. Unset, the build gets the same
    // default destination CI's build has, and the copy is patched from that.
    const { INTERNAL_API_URL: _unused, ...buildEnv } = process.env;
    const b = spawnSync('npx', ['next', 'build'], { cwd: WEB_DIR, encoding: 'utf8', env: { ...buildEnv, NEXT_TELEMETRY_DISABLED: '1' } });
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
  // 0.35: a Business User (computers:view only), to whom "Schedule this report" is not offered.
  const roleUser = await prisma.role.findFirst({ where: { type: 'BUSINESS_USER' } });
  const member = await mk('member');
  await prisma.membership.create({ data: { userId: member.id, tenantId: tenant.id, customerId: A.id, roleId: roleUser.id, capabilities: ['computers:view'] } });

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
  // 0.36: the offline one is the map's grey marker (Offline Town, in A).
  for (let i = 2; i <= 5; i++) others.push(await ep(A, `${TAG}-WS-0${i}`, { siteId: i % 2 ? site.id : null, isOnline: i !== 4, lastSeenAt: new Date(now - (i === 4 ? 3 * 86400_000 : 120_000)), ...(i === 4 ? { ipAddress: GEO.offline.ip } : {}) }));
  const linux = await ep(A, `${TAG}-LNX-01`, { platform: 'Linux', osVersion: 'Ubuntu 24.04', agentVersion: '0.33.0' });
  const birch = await ep(B, `${TAG}-BIRCH-ONLY`, { ipAddress: GEO.online.ip }); // 0.36: the map's green marker (Online Town, in B)
  // 0.35: the Linux computer reports, from its package manager, a pending restart (fresh scan).
  await prisma.endpointInventory.create({ data: { endpointId: linux.id, osCaption: 'Ubuntu 24.04 LTS', updatesCheckedAt: new Date(now - 3600_000), pendingUpdates: [], pendingUpdateCount: 0, rebootRequired: true } });
  // 0.35: a static group holding the main device, and a rule group (online computers) in A; B has a same-named rule group.
  const front = await prisma.endpointGroup.create({ data: { tenantId: tenant.id, customerId: A.id, name: `${TAG} Front desk`, members: { create: [{ endpointId: main.id }] } } });
  const onlineRule = await prisma.endpointGroup.create({ data: { tenantId: tenant.id, customerId: A.id, name: `${TAG} Online`, kind: 'RULE', rule: { online: 'online' } } });
  await prisma.endpointGroup.create({ data: { tenantId: tenant.id, customerId: B.id, name: `${TAG} Online`, kind: 'RULE', rule: { online: 'online' } } });
  void birch;
  // 0.35 (item 7): reachable through RustDesk (isOnline) with an agent silent for twelve days — in B, so A's counts are untouched.
  // 0.36: alone at Silent Town on the map, so that marker must be amber.
  const silent = await ep(B, `${TAG}-BIRCH-SILENT`, { lastSeenAt: new Date(now - 12 * 86400_000 - 3600_000), ipAddress: GEO.silent.ip });
  // 0.35: a draft library script of A, so the script page itself is swept for its padding.
  const body = 'Get-Date';
  const script = await prisma.script.create({ data: { scope: 'BUSINESS', tenantId: tenant.id, customerId: A.id, name: `${TAG} Clock`, createdById: admin.id,
    versions: { create: [{ version: 1, description: 'Prints the date', language: 'powershell', targetOs: 'windows', risk: 'low', content: body, contentBytes: Buffer.byteLength(body),
      contentSha256: createHash('sha256').update(body).digest('hex'), definitionSha256: createHash('sha256').update(`def:${body}`).digest('hex'), authorId: admin.id, contributorIds: [admin.id] }] } } });

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
  return { tenant, A, B, site, admin, owner, member, main, others, linux, front, onlineRule, script, silent };
}

// The branding accent is the platform's own (one row per tenant), so the
// drawer checks set it and put it back exactly as it was — or remove the row
// if there was none.
let brandingBefore; // undefined: not touched
async function setAccent(tenantId, accentColor) {
  if (brandingBefore === undefined) {
    const b = await prisma.tenantBranding.findUnique({ where: { tenantId } });
    brandingBefore = b ? { tenantId, accentColor: b.accentColor } : { tenantId, none: true };
  }
  await prisma.tenantBranding.upsert({ where: { tenantId }, create: { tenantId, accentColor }, update: { accentColor } });
}
async function restoreBranding() {
  const b = brandingBefore;
  if (!b) return;
  brandingBefore = undefined;
  if (b.none) await prisma.tenantBranding.deleteMany({ where: { tenantId: b.tenantId } });
  else await prisma.tenantBranding.update({ where: { tenantId: b.tenantId }, data: { accentColor: b.accentColor } });
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
      await prisma.endpointGroupMember.deleteMany({ where: { endpointId: { in: eps } } }).catch(() => {});
      await prisma.endpointInventory.deleteMany({ where: { endpointId: { in: eps } } }).catch(() => {});
      return prisma.endpoint.deleteMany({ where: { id: { in: eps } } });
    }],
    ['device groups', () => prisma.endpointGroup.deleteMany({ where: { customerId: { in: ids } } })],
    ['backups', () => prisma.backupConnection.deleteMany({ where: { customerId: { in: ids } } })],
    ['scripts', () => prisma.script.deleteMany({ where: { customerId: { in: ids } } })],
    ['branding', restoreBranding],
    ['sites', () => prisma.site.deleteMany({ where: { customerId: { in: ids } } })],
    ['MDM connectors', () => prisma.mdmConnector.deleteMany({ where: { customerId: { in: ids } } })],
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
// 0.72: this suite's API runs with MSA_GRANTS unset (off). The console must
// then make no request at all to a gated Managed Secure Access route — each
// would be a 404 on every device page view. 0.73 adds /msa/sessions and
// /msa/cutover-runs, and Devices → Managed sessions is visited below.
const msaGated = [];
let msaReadinessReads = 0;
function instrument(page) {
  page.problems = [];
  page.on('request', (r) => {
    if (!r.url().startsWith(WEB)) return;
    const u = r.url().slice(WEB.length);
    if (/\/api\/v1\/msa\/(managed|grants|sessions|cutover-runs)(\/|\?|$)/.test(u)) msaGated.push(`${r.method()} ${u}`);
    if (/\/api\/v1\/msa\/readiness\//.test(u)) msaReadinessReads++;
  });
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
/** WCAG 2.x contrast of two computed CSS colours ("rgb(…)"/"rgba(…)", opaque). */
const rgbOf = (c) => (c.match(/\d+(\.\d+)?/g) ?? ['0', '0', '0']).slice(0, 3).map(Number);
const relLum = (c) => { const [r, g, b] = rgbOf(c).map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a, b) => { const [x, y] = [relLum(a), relLum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
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
    await addDeviceShortcut(page, desktopNav, label);
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
  {
    // 0.64: Add device is in the drawer too, inside its width (0.87: inside the Devices group).
    await openNavGroup(drawer, 'devices');
    const sc = drawer.locator('[data-testid="nav-shortcut-devices"]');
    const b = await sc.boundingBox().catch(() => null);
    check(await sc.isVisible() && await sc.getAttribute('href') === '/endpoints/enroll' && /Add device/.test(await sc.innerText()) && b && box && b.x >= box.x && b.x + b.width <= box.x + box.width + 0.5,
      `${label}: the drawer has an "Add device" link under Devices, inside the drawer`, JSON.stringify(b));
  }
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
  await openNavGroup(drawer, 'devices');
  await drawer.locator('[data-nav-item="/endpoints"]').click();
  await page.waitForURL((u) => u.pathname === '/endpoints', { timeout: 15_000 }).catch(() => {});
  await drawer.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
  check(new URL(page.url()).pathname === '/endpoints' && !(await drawer.isVisible()), `${label}: following a menu link navigates and closes the drawer`, page.url());
  await settled(page);
  await trigger.click();
  await drawer.waitFor({ state: 'visible' });
  await openNavGroup(drawer, 'devices');
  await drawer.locator('[data-nav-item="/endpoints"]').click();
  await drawer.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
  check(!(await drawer.isVisible()), `${label}: a link to the page already open closes it too`);
}

/** 0.87: menu groups are buttons that open; a page is a [data-nav-item] link inside one. */
async function openNavGroup(scope, id) {
  const g = scope.locator(`button[data-nav="${id}"]`).first();
  if (await g.count() && await g.getAttribute('aria-expanded') === 'false') await g.click();
}
async function openAllNavGroups(scope) {
  for (let i = 0; i < 12; i++) {
    const closed = scope.locator('button[data-nav][aria-expanded="false"]');
    if (!(await closed.count())) return;
    await closed.first().click();
  }
}
/** 0.87: device tabs sit in groups; open the group that holds a tab before clicking it. */
async function openTab(page, id) {
  const tab = page.locator(`[data-testid="tab-${id}"]`);
  if (!(await tab.isVisible().catch(() => false))) {
    const g = page.locator(`[data-testid="workspace-groups"] [data-tabs~="${id}"]`).first();
    if (await g.count()) await g.click();
    await tab.waitFor({ timeout: 10_000 }).catch(() => {});
  }
  await tab.click();
}

/**
 * 0.64: "Add device" is a link of its own in the sidebar, under Devices (until
 * now it was only a tab on the Devices pages). It opens the flow, and is the
 * highlighted row there instead of Devices.
 */
async function addDeviceShortcut(page, nav, label) {
  await openNavGroup(nav, 'devices');
  const sc = nav.locator('[data-testid="nav-shortcut-devices"]');
  const devices = nav.locator('[data-nav-item="/endpoints"]');
  const sb = await sc.boundingBox().catch(() => null), db = await devices.boundingBox().catch(() => null);
  check(await sc.isVisible() && await sc.getAttribute('href') === '/endpoints/enroll' && (await sc.innerText()).trim() === 'Add device',
    `${label}: the sidebar has an "Add device" link`, await sc.innerText().catch(() => 'missing'));
  check(sb && db && sb.y > db.y && Math.abs(sb.x - db.x) <= 1, `${label}: it sits in the Devices group, under All devices`, JSON.stringify({ sb, db }));
  await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': ip() });
  await sc.click();
  await page.waitForURL((u) => u.pathname === '/endpoints/enroll', { timeout: 15_000 }).catch(() => {});
  await page.locator('[data-testid="add-device-flow"]').waitFor({ timeout: 15_000 }).catch(() => {});
  check(new URL(page.url()).pathname === '/endpoints/enroll' && await page.locator('[data-testid="add-device-flow"]').isVisible(), `${label}: it opens Add device`, page.url());
  check(await sc.getAttribute('aria-current') === 'page' && await devices.getAttribute('aria-current') !== 'page',
    `${label}: there it is the highlighted row, not All devices`, await devices.getAttribute('aria-current').catch(() => ''));
  await settled(page);
}

async function mainPagesSweep(page, f, vp, label) {
  // The pages a person reaches from the menu, plus the hub tabs: taken from
  // the menu itself, so a page added to it is swept without editing this.
  let hrefs;
  if (vp === 'phone') {
    await page.locator('[data-testid="nav-drawer-trigger"]').click();
    const drawer = page.locator('[data-testid="nav-drawer"]');
    await drawer.waitFor({ state: 'visible' });
    await openAllNavGroups(drawer);
    hrefs = await drawer.locator('a[href^="/"]').evaluateAll((els) => els.map((e) => e.getAttribute('href')));
    await page.keyboard.press('Escape');
    await drawer.waitFor({ state: 'hidden' });
  } else {
    await openAllNavGroups(page.locator('nav[aria-label="Main"]').first());
    hrefs = await page.locator('aside a[href^="/"]').evaluateAll((els) => els.map((e) => e.getAttribute('href')));
  }
  const extra = ['/my-computers', '/sessions', '/quick-connect', '/patching', '/endpoints/enroll', '/endpoints/new', '/settings/api-keys', '/settings/monitoring', '/settings/client-updates', '/reports/agent-coverage', '/reports/offline-time', '/reports/patch-compliance', '/reports/alert-frequency',
    // 0.35: the pages that had no side padding, and a page under each.
    '/automation/scripts', `/automation/scripts/${f.script.id}`, '/automation/software', '/reports/schedules',
    // 0.87: every pre-0.87 menu URL (docs/NAVIGATION_MIGRATION.md's table) still opens.
    ...OLD_ROUTES];
  const all = [...new Set([...hrefs, ...extra])].filter((h) => !/^\/(docs|help)\//.test(h));
  check(all.length >= 15, `${label}: ${all.length} main pages to sweep`);
  const bad = [], noisy = [], unpadded = [], noHeading = [];
  // 0.35: the page's own heading must sit inside a side gutter — p-4 is 16 px,
  // p-6 24 px; the Patching and Script library pages had none (0 px), their
  // title against the menu on desktop and the screen edge on a phone.
  const minPad = 12;
  for (const href of all) {
    await go(page, href);
    const o = await overflow(page);
    if (o.doc > 1 || o.main > 1) bad.push(`${href}: ${JSON.stringify(o)}`);
    const pad = await page.evaluate(() => {
      const main = document.querySelector('main');
      const h = main?.querySelector('h1');
      if (!main || !h) return null;
      const m = main.getBoundingClientRect(), r = h.getBoundingClientRect();
      return { left: Math.round(r.left - m.left), right: Math.round(m.right - r.right) };
    });
    if (pad === null) noHeading.push(href);
    else if (pad.left < minPad) unpadded.push(`${href}: heading ${pad.left} px from the left of the page`);
    const ps = takeProblems(page);
    if (ps.length) noisy.push(`${href}: ${fmtProblems(ps)}`);
  }
  check(bad.length === 0, `${label}: none of them scrolls sideways`, bad.join('\n      '));
  check(unpadded.length === 0, `${label}: every page's heading sits inside the side padding (${all.length - noHeading.length} measured${noHeading.length ? `; no h1 on ${noHeading.join(', ')}` : ''})`, unpadded.join('\n      '));
  check(noisy.length === 0, `${label}: none of them logs an error or fails a request`, noisy.join('\n      '));
}

async function devicesAndWorkspace(page, f, vp, label) {
  await go(page, '/endpoints');
  const search = page.locator('input[aria-label="Search devices"]');
  await search.fill(`${TAG}-WS`);
  const row = page.locator(`table a[href="/endpoints/${f.main.id}"]`);
  const rows = await rowsSettle(page, 5);
  check(rows === 5, `${label}: the device list finds the five ${TAG}-WS devices`, `rows ${rows}`);
  // 0.68: Health in words, never "None".
  const health = await page.locator('table [data-health]').evaluateAll((els) => els.map((e) => e.getAttribute('data-health')));
  check(health.length === 5 && health.every((h) => ['healthy', 'warning', 'issues', 'unknown'].includes(h)), `${label}: Health says healthy, warning, issues or unknown for each`, health.join(','));
  // 0.70: each Health label opens that computer's Monitoring tab.
  const healthLinks = await page.locator('table a[data-testid="health-link"]').evaluateAll((els) => els.map((e) => e.getAttribute('href')));
  check(healthLinks.length === 5 && healthLinks.every((h) => /^\/endpoints\/[^/?]+\?tab=monitoring$/.test(h ?? '')), `${label}: every Health label links to its computer's Monitoring tab`, healthLinks.join(','));
  const flagged = health.filter((h) => h === 'warning' || h === 'issues').length;
  const clears = await page.locator('table [data-testid="clear-alerts"]').count();
  check(clears === flagged, `${label}: Clear is offered beside each Warning or Issues label and nowhere else`, `clear ${clears}, flagged ${flagged}`);
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
  // 0.87: the tabs are in groups; the group row lists every tab (data-tabs), the tab list only the open group's.
  const tabs = (await page.locator('[data-testid="workspace-groups"] [data-tabs]').evaluateAll((els) => els.map((e) => e.getAttribute('data-tabs')))).join(' ').split(' ').filter(Boolean);
  const expected = ['overview', 'performance', 'monitoring', 'software', 'processes', 'services', 'network', 'patches', 'events', 'diagnostics', 'actions', 'history'];
  check(expected.every((t) => tabs.includes(t)), `${label}: all twelve workspace tabs for a Windows agent`, tabs.join(','));
  // 0.88 (P1-2): the compact header, checked by what it changed rather than
  // by a total that a device's own messages and agent buttons legitimately
  // lengthen: the identity row (name, status, customer, site, last seen) is
  // at most two lines on a desktop and a few on a phone; Connect, Terminal,
  // Tools and More are one row at both widths; and on a phone the attention
  // chips are one row that scrolls sideways instead of stacking.
  const geo = await page.evaluate(() => {
    const h = (sel) => Math.round(document.querySelector(sel)?.getBoundingClientRect().height ?? 0);
    const btns = [...document.querySelectorAll('[data-testid="device-actions"] :is([data-testid="action-connect"], [data-testid="action-terminal"], [data-testid="action-tools"], [data-testid="action-more"])')]
      .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
      .map((e) => Math.round(e.getBoundingClientRect().top));
    const chips = [...document.querySelectorAll('[data-testid="attention-strip"] > *')].map((e) => Math.round(e.getBoundingClientRect().top));
    return { identity: h('[data-testid="device-identity"]'), rows: new Set(btns).size, buttons: btns.length, chipRows: new Set(chips).size, chips: chips.length };
  });
  // Two lines on a desktop: a long status ("Reachable (RustDesk) · agent silent 57 min" with its
  // stale mark) wraps the facts under the name, which is fine.
  const identityMax = vp === 'phone' ? 150 : 64;
  check(geo.identity > 0 && geo.identity <= identityMax, `${label}: the identity row (name, status, customer, site, last seen) takes at most ${identityMax} px (compact header, 0.88)`, JSON.stringify(geo));
  check(geo.buttons >= 3 && geo.rows === 1, `${label}: Connect, Terminal, Tools and More are one row${vp === 'phone' ? '; Diagnose, Run action and Patch are in More' : ''}`, JSON.stringify(geo));
  if (vp === 'phone') check(geo.chips > 0 && geo.chipRows === 1, `${label}: on a phone the attention chips are one row that scrolls, not a stack`, JSON.stringify(geo));
  check(await page.locator('[data-testid="device-actions"] [data-testid="header-full-agent"]').count() === 0, `${label}: no green "Full agent" chip in the header`);
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
    await openTab(page, t);
    const panel = page.locator('[role="tabpanel"][data-state="active"]');
    await panel.waitFor({ timeout: 10_000 });
    await settled(page, 12_000);
    const text = (await panel.innerText().catch(() => '')).trim();
    const p = proof[t];
    const ok = p ? await p(text) : text.length > 0;
    check(ok && await page.locator(`[data-testid="tab-${t}"]`).getAttribute('aria-selected') === 'true', `${label}: the ${t} tab renders${p ? ' the fixture data' : ''}`, text.slice(0, 200));
    // 0.88: every tab showing reported state says how old it is, in one place;
    // the others (request lists, live views) say nothing there.
    const FRESH = { overview: 'Inventory collected', software: 'Inventory collected', performance: 'Last check-in', monitoring: 'Last monitoring report', patches: 'Update scan', processes: 'Snapshot taken', services: 'Snapshot taken', network: 'Snapshot taken' };
    const fl = page.locator('[data-testid="freshness"]');
    if (FRESH[t]) {
      await fl.first().waitFor({ timeout: 10_000 }).catch(() => {});
      const ft = await fl.first().innerText().catch(() => '');
      const verdict = await fl.first().getAttribute('data-verdict').catch(() => null);
      check(await fl.count() === 1 && ft.includes(FRESH[t]) && ['fresh', 'stale', 'none', 'unknown'].includes(verdict ?? '') && (verdict === 'unknown' ? /not reported yet/.test(ft) : /ago|just now/.test(ft)),
        `${label}: the ${t} tab says how old its data is (${FRESH[t]})`, `${ft} [${verdict}]`);
    } else {
      check(await fl.count() === 0, `${label}: the ${t} tab has no freshness line (its rows carry their own times)`);
    }
    if (vp === 'phone') await noSideScroll(page, `${label} ${t} tab`);
    if (['performance', 'processes', 'network'].includes(t)) await shot(page, `${label}-tab-${t}`);
    await cleanCheck(page, `${label} ${t} tab`);
  }
  if (vp === 'desktop' && !namingChecked) { namingChecked = true; await deviceNaming(page, f, label); }
}

// 0.68: Rename, aliases and notes on the device page, once, then put back.
let namingChecked = false;
async function deviceNaming(page, f, label) {
  const before = await prisma.endpoint.findUnique({ where: { id: f.main.id }, select: { name: true, description: true } });
  await openTab(page, 'overview');
  await settled(page);
  await page.locator('[data-testid="rename-device"]').click();
  const dlg = page.locator('[data-testid="rename-dialog"]');
  await dlg.waitFor({ timeout: 10_000 });
  check(await page.locator('[data-testid="rename-name"]').inputValue() === before.name, `${label}: Rename opens with the current name`);
  const nick = `${TAG} Front desk`;
  await page.locator('[data-testid="rename-name"]').fill(nick);
  await page.locator('[data-testid="rename-description"]').fill('Reception, by the window');
  await page.locator('[data-testid="rename-save"]').click();
  await dlg.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {});
  // Wait for the new text, not just the element: the old description is already on the page, so
  // waiting for the element alone read the header before it refreshed (seen once in CI after 0.85.1).
  await page.waitForFunction((n) => {
    const h = document.querySelector('[data-testid="device-header"] h1');
    const d = document.querySelector('[data-testid="device-description"]');
    return h?.textContent?.trim() === n && d?.textContent?.trim() === 'Reception, by the window';
  }, nick, { timeout: 15_000 }).catch(() => {});
  const h1 = await page.locator('[data-testid="device-header"] h1').innerText().catch(() => '');
  const desc = await page.locator('[data-testid="device-description"]').innerText().catch(() => '');
  check(h1 === nick && desc === 'Reception, by the window', `${label}: the new name and description show in the header`, JSON.stringify({ h1, desc }));
  const audit = await prisma.activityLog.findFirst({ where: { action: 'ENDPOINT_UPDATED', resourceId: f.main.id }, orderBy: { createdAt: 'desc' } });
  check(audit?.metadata?.renamed?.before === before.name && audit?.metadata?.renamed?.after === nick && audit?.metadata?.descriptionChanged === true
    && !JSON.stringify(audit?.metadata).includes('Reception'), `${label}: the rename is audited, before and after, without the description's text`, JSON.stringify(audit?.metadata));

  // settled() waits for the page's first load only; after a click, wait for what the click must produce.
  const shows = (sel, text) => page.locator(sel, { hasText: text }).first().waitFor({ timeout: 15_000 }).then(() => true, () => false);
  await page.locator('[data-testid="alias-add"]').click();
  await page.locator('[data-testid="alias-input"]').fill('FRONT-PC');
  await page.locator('[data-testid="alias-input"]').press('Enter');
  check(await shows('[data-testid="device-aliases"]', 'FRONT-PC'), `${label}: an alias is added in place`);
  await page.locator('[data-testid="alias-add"]').click();
  await page.locator('[data-testid="alias-input"]').fill('front-pc');
  await page.locator('[data-testid="alias-input"]').press('Enter');
  check(await shows('[data-testid="device-aliases"]', 'already has the alias'), `${label}: the same alias in another case is refused, with the reason`);
  await page.locator('button[aria-label="Remove alias FRONT-PC"]').click();
  const gone = await page.locator('button[aria-label="Remove alias FRONT-PC"]').waitFor({ state: 'detached', timeout: 15_000 }).then(() => true, () => false);
  check(gone && (await prisma.endpointAlias.count({ where: { endpointId: f.main.id, alias: 'FRONT-PC' } })) === 0, `${label}: and removed`);

  await page.locator('[data-testid="overview-note-input"]').fill(`${TAG} replaced the dock`);
  await page.locator('[data-testid="overview-note-add"]').click();
  check(await shows('[data-testid="overview-notes"]', `${TAG} replaced the dock`), `${label}: a note is added from the Overview`);
  // The refused duplicate alias is the one failed request this section causes, on purpose.
  await cleanCheck(page, `${label} device naming`, (p) => (p.kind === 'http' && p.status === 409 && p.code === 'ALIAS_EXISTS') || (p.kind !== 'http' && /409/.test(p.text ?? '')));
  await prisma.endpoint.update({ where: { id: f.main.id }, data: { name: before.name, description: before.description } });
  await page.reload();
  await page.locator('[data-testid="workspace-tabs"]').waitFor({ timeout: 20_000 });
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
  // 0.54: Schedule restart… — the options, the RustDesk exception never ticked by default, the signed-in note. Cancelled: nothing is requested.
  const restartBtn = bar.locator('[data-testid="bulk-restart"]');
  if (await restartBtn.isVisible().catch(() => false)) {
    await restartBtn.click();
    const rd = page.getByRole('dialog').filter({ has: page.locator('[data-testid="restart-options"]') });
    await rd.waitFor({ timeout: 10_000 }).catch(() => {});
    const exc = rd.locator('[data-testid="restart-ignore-remote-session"]');
    check(await rd.isVisible() && !(await exc.isChecked()) && !(await rd.locator('[data-testid="restart-only-if-required"]').isChecked())
      && /Restart even if a technician is connected through RustDesk \(their session is dropped\)/.test(await rd.innerText())
      && /A signed-in user does not stop the restart\. They see the 15-minute warning, and unsaved work is lost\./.test(await rd.innerText()),
      `${label}: bulk Schedule restart offers the RustDesk exception unticked, and says a signed-in user does not stop it`, (await rd.innerText().catch(() => '')).slice(0, 300));
    await rd.locator('[data-testid="schedule-later"]').check();
    check(await rd.locator('[data-testid="schedule-at"]').isVisible() && await rd.locator('[data-testid="restart-when-note"]').isVisible(), `${label}: a restart can be given a date, time and zone`);
    await exc.check();
    check(/do(es)? not stop it either|the warning still shows/.test(await rd.locator('[data-testid="restart-signed-in-note"]').innerText()), `${label}: ticking the exception says the warning still shows`);
    check(await rd.locator('[data-testid="bulk-restart-submit"]').isDisabled(), `${label}: no restart is requested without a reason`);
    if (vp === 'phone') { const b = await rd.boundingBox(); check(b && b.x >= 0 && b.x + b.width <= 375.5, `${label}: the restart dialog fits the screen`, JSON.stringify(b)); }
    await shot(page, `${label}-bulk-restart`);
    await rd.getByRole('button', { name: 'Cancel' }).click();
    await rd.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
  } else check(false, `${label}: the bulk bar offers Schedule restart… to someone who can edit computers`);
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
  await page.getByRole('radio', { name: /Everyone at the customer/ }).check();
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
  // 0.64: the installer is a real download, and the command is its own tab.
  const dl = cmd.locator('[data-testid="download-installer"]');
  const href = await dl.getAttribute('href').catch(() => null);
  check(await dl.isVisible() && /Download \.exe/.test(await dl.innerText()) && /\/api\/v1\/public\/install\/windows\.exe\?token=[0-9a-f]{64}$/.test(href ?? '') && await dl.getAttribute('download') === 'install-reboot-remote.exe',
    `${label}: Windows opens on a "Download .exe" button for the link just made`, href ?? 'no button');
  check(await cmd.locator('[data-testid="copy-link"]').innerText().catch(() => '') === href, `${label}: the same link is there to copy and send`);
  // 0.65: Download .msi beside it, the silent msiexec line with this link's
  // token, and the honest note. The button fetches; a server that cannot
  // build one says so in the page instead of saving an error as a file.
  const token = (href ?? '').split('token=')[1] ?? '\0';
  const note = await cmd.locator('[data-testid="msi-note"]').innerText().catch(() => '');
  check(await cmd.locator('[data-testid="download-msi"]').isVisible() && /Download \.msi/.test(await cmd.locator('[data-testid="download-msi"]').innerText()),
    `${label}: a "Download .msi" button sits next to Download .exe`);
  check(await cmd.locator('[data-testid="copy-msiexec"]').innerText().catch(() => '') === `msiexec /i rem0te.msi TOKEN=${token} /qn`,
    `${label}: the silent install line is msiexec /i rem0te.msi TOKEN=<this link's token> /qn, ready to copy`);
  check(/has not yet been run on real Windows/.test(note) && /never the agent/.test(note) && /deployment key/.test(note),
    `${label}: the note says the .msi has not run on real Windows, that uninstalling it leaves the agent, and points to deployment keys`, note);
  if (vp === 'desktop' && signedRelease(false)) {
    await cmd.locator('[data-testid="download-msi"]').click();
    await cmd.locator('[data-testid="msi-error"]').waitFor({ timeout: 15_000 }).catch(() => {});
    check(/does not publish the signed agent yet/.test(await cmd.locator('[data-testid="msi-error"]').innerText().catch(() => '')),
      `${label}: with no signed agent published, the page says the .msi needs it (no file saved)`);
    signedRelease(true);
    const haveTools = existsSync('/usr/bin/wixl') && existsSync('/usr/bin/msibuild');
    if (haveTools) {
      const [dlEvent] = await Promise.all([page.waitForEvent('download', { timeout: 30_000 }).catch(() => null), cmd.locator('[data-testid="download-msi"]').click()]);
      check(dlEvent?.suggestedFilename() === 'rem0te.msi' && !(await cmd.locator('[data-testid="msi-error"]').isVisible()),
        `${label}: with a signed agent published, Download .msi saves rem0te.msi`, dlEvent?.suggestedFilename() ?? 'no download');
      if (dlEvent) await dlEvent.delete().catch(() => {});
    } else {
      await cmd.locator('[data-testid="download-msi"]').click();
      await page.waitForFunction(() => /msitools/.test(document.querySelector('[data-testid="msi-error"]')?.textContent ?? ''), null, { timeout: 15_000 }).catch(() => {});
      check(!process.env.CI && /msitools/.test(await cmd.locator('[data-testid="msi-error"]').innerText().catch(() => '')),
        `${label}: without msitools on the server the page says so (under CI msitools must be installed)`);
    }
    signedRelease(false);
  }
  const dlBox = await dl.boundingBox();
  if (vp === 'phone') check(dlBox && dlBox.x >= 0 && dlBox.x + dlBox.width <= 375.5, `${label}: the download button fits the screen`, JSON.stringify(dlBox));
  await cmd.locator('[data-testid="tab-command"]').click();
  const cmdText = await cmd.locator('[data-testid="copy-command"]').innerText().catch(() => '');
  check(/^irm \S+\/api\/v1\/public\/install\/win\/[0-9a-f]{64} \| iex$/.test(cmdText) && cmdText.includes((href ?? '').split('token=')[1] ?? '\0') && !(await dl.isVisible()),
    `${label}: the Command tab shows the PowerShell command, for the same token`, cmdText);
  if (vp === 'phone') await noSideScroll(page, `${label} install command`);
  await shot(page, `${label}-add-device`);
  await cleanCheck(page, `${label} Add device`, (p) => stepUp403(p) || (p.kind === 'http' && p.status === 503 && ['MSI_NEEDS_SIGNED_AGENT', 'MSI_BUILDER_UNAVAILABLE'].includes(p.code)));
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

/**
 * 0.74: Admin → Security against the fixture host. Every tab renders its
 * content (not an error card); a finding whose source could not be read says
 * Unknown and never OK; nothing on the page shows OK for an unknown status.
 */
async function serverSecurity(page, label, vp) {
  await go(page, '/admin/security');
  const score = page.locator('[data-testid="security-score"]');
  await score.waitFor({ timeout: 30_000 }).catch(() => {});
  check(await score.isVisible() && (await score.getAttribute('data-grade')) === 'poor', `${label}: Security overview shows a score (poor: the fixture host fails a critical check)`, await page.locator('main').innerText().catch(() => ''));
  const root = page.locator('[data-testid="finding-host.ssh.root_login"]');
  check(await root.count() === 1 && (await root.getAttribute('data-status')) === 'unknown' && /Unknown/.test(await root.innerText()) && !/\bOK\b/.test(await root.innerText()),
    `${label}: SSH root login behind an unreadable include is Unknown, not OK`, await root.innerText().catch(() => '(missing)'));
  await page.locator('[data-testid="findings-all"]').click();
  const unknownOk = await page.locator('[data-status="unknown"]').evaluateAll((els) => els.filter((e) => /(^|\s)OK(\s|$)/.test(e.querySelector('span')?.innerText ?? '')).length);
  check(unknownOk === 0 && await page.locator('[data-status="unknown"]').count() > 0, `${label}: no Unknown finding is labelled OK`, `${unknownOk} labelled OK`);
  if (vp === 'phone') await noSideScroll(page, `${label} Security overview`);
  await shot(page, `${label}-security`);
  await acceptRiskDialog(page, label, vp);
  const tabs = [
    ['access-rules', '[data-testid="unenforced-rules"]'],
    ['fail2ban', '[data-testid="jail-sshd"]'],
    ['tls', '[data-testid="cert-remote.example.com"]'],
    ['os-updates', '[data-testid="os-updates-state"][data-state="ok"]'],
    ['dependencies', '[data-testid="deps-state"][data-state="ok"]'],
    // 0.87: not `main li`: the header's breadcrumb list is inside <main> and hidden on a phone, so .first() waited on it.
    ['features', '[role="tabpanel"] table'],
  ];
  for (const [tab, sel] of tabs) {
    await page.locator(`[data-testid="security-tab-${tab}"]`).click();
    const ok = await page.locator(sel).first().waitFor({ timeout: 60_000 }).then(() => true).catch(() => false);
    const err = await page.locator('[data-testid="security-error"]').count();
    check(ok && err === 0, `${label}: Security → ${tab} renders`, ok ? 'an error card is shown' : (await page.locator('main').innerText()).slice(-600));
    if (vp === 'phone') await noSideScroll(page, `${label} Security ${tab}`);
  }
  await page.locator('[data-testid="security-tab-tls"]').click();
  const failing = page.locator('[data-testid="cert-approve.example.com"]');
  check(await failing.count() === 1 && (await failing.getAttribute('data-status')) === 'fail', `${label}: the certificate with under 20 days is not shown as valid`);
  await cleanCheck(page, `${label} Security`);
}

/**
 * 0.75.1: accepting a finding as a risk. A never-acceptable finding (the
 * Platform Admin without MFA) offers no Accept and says why; the listener
 * finding's Accept… opens a dialog that refuses a reason under 3 characters,
 * asks to confirm it is you (server.security asks in this suite), and moves
 * the finding to a collapsed Accepted risks section labelled Accepted, never
 * OK; Re-open puts it back. Every combination leaves it open again.
 */
async function acceptRiskDialog(page, label, vp) {
  await page.locator('[data-testid="findings-attention"]').click();
  const id = 'network.listeners';
  const row = page.locator(`[data-testid="finding-${id}"]`);
  check(await row.count() === 1 && await page.locator(`[data-testid="accept-${id}"]`).isVisible(), `${label}: a failing listener finding offers Accept…`);
  const mfa = page.locator('[data-testid="finding-portal.mfa.admins"]');
  check(await mfa.count() === 1 && await mfa.locator('[data-testid^="accept-"]').count() === 0 && /Cannot be accepted/.test(await mfa.innerText()),
    `${label}: a Platform Admin without MFA cannot be accepted, and the row says why`, await mfa.innerText().catch(() => '(missing)'));
  await page.locator(`[data-testid="accept-${id}"]`).click();
  const dlg = page.locator('[data-testid="accept-dialog"]');
  await dlg.waitFor({ timeout: 10_000 }).catch(() => {});
  check(await dlg.isVisible(), `${label}: Accept… opens the dialog`);
  if (vp === 'phone') { const b = await dlg.boundingBox(); check(b && b.x >= 0 && b.x + b.width <= 375.5, `${label}: the accept dialog fits the screen`, JSON.stringify(b)); }
  await dlg.locator('[data-testid="accept-reason"]').fill('ab');
  check(await dlg.locator('[data-testid="accept-confirm"]').isDisabled(), `${label}: a reason under 3 characters cannot be submitted`);
  await dlg.locator('[data-testid="accept-reason"]').fill('udp/5353 and tcp/8080 are closed at the hardware firewall');
  await dlg.locator('[data-testid="accept-expiry"]').selectOption('90');
  await shot(page, `${label}-security-accept`);
  await forgetStepUp(page);
  await dlg.locator('[data-testid="accept-confirm"]').click();
  await confirmStepUp(page, label, 'accepting a security finding');
  await dlg.waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => {});
  check(!(await dlg.isVisible()), `${label}: the dialog closes once accepted`, await dlg.innerText().catch(() => ''));
  await page.locator('[data-testid="accepted-risks"]').waitFor({ timeout: 15_000 }).catch(() => {});
  check(await row.count() === 0, `${label}: the accepted finding leaves the Needs attention list`);
  await page.locator('[data-testid="accepted-risks-toggle"]').click();
  const acc = page.locator(`[data-testid="accepted-${id}"]`);
  await acc.waitFor({ timeout: 10_000 }).catch(() => {});
  const accText = await acc.innerText().catch(() => '');
  check(/Accepted/.test(accText) && !/(^|\s)OK(\s|$)/.test(accText) && /closed at the hardware firewall/.test(accText) && /Re-opens/.test(accText) && (await acc.getAttribute('data-status')) === 'fail',
    `${label}: Accepted risks shows it as Accepted (never OK) with who, why and the expiry`, accText);
  const score = await page.locator('[data-testid="security-score"]').innerText();
  check(/1 accepted/.test(score), `${label}: the summary counts it as accepted`, score);
  if (vp === 'phone') await noSideScroll(page, `${label} Accepted risks`);
  await shot(page, `${label}-security-accepted`);
  await acc.locator(`[data-testid="reopen-${id}"]`).click();
  await row.waitFor({ timeout: 15_000 }).catch(() => {});
  check(await row.count() === 1 && await page.locator('[data-testid="accepted-risks"]').count() === 0, `${label}: Re-open puts it back under Needs attention (and asks nothing)`);
  await cleanCheck(page, `${label} Security accept`, stepUp403);
}

// ── 0.35 ────────────────────────────────────────────────────────────────────

/** The drawer's close button and the brand header on a pale and a dark accent, and the default one. */
async function drawerContrast(page, f, label) {
  const trigger = page.locator('[data-testid="nav-drawer-trigger"]');
  const drawer = page.locator('[data-testid="nav-drawer"]');
  for (const accent of ['#FDE68A', '#1E3A8A', '#3B82F6']) {
    await setAccent(f.tenant.id, accent);
    await go(page, '/dashboard');
    await trigger.click();
    await drawer.waitFor({ state: 'visible', timeout: 10_000 });
    const header = drawer.locator('[data-testid="brand-header"]');
    // The branding query lands after the drawer opens: wait for the accent itself.
    await page.waitForFunction((el) => getComputedStyle(el).backgroundColor !== 'rgba(0, 0, 0, 0)', await header.elementHandle(), { timeout: 10_000 }).catch(() => {});
    const c = await drawer.evaluate((el) => {
      const h = el.querySelector('[data-testid="brand-header"]'), b = el.querySelector('[data-testid="nav-drawer-close"]');
      const hr = h.getBoundingClientRect(), br = b.getBoundingClientRect();
      return { bg: getComputedStyle(h).backgroundColor, button: getComputedStyle(b).color, title: getComputedStyle(h.querySelector('.font-semibold') ?? h).color, onHeader: br.top >= hr.top && br.bottom <= hr.bottom + 1 };
    });
    const rb = contrast(c.button, c.bg), rt = contrast(c.title, c.bg);
    check(c.onHeader && rb >= 4.5, `${label}: on accent ${accent} the drawer's close button is ${rb.toFixed(2)}:1 (WCAG AA is 4.5:1)`, JSON.stringify(c));
    check(rt >= 4.5, `${label}: and the portal title on it is ${rt.toFixed(2)}:1`, JSON.stringify(c));
    if (accent === '#FDE68A') await shot(page, `${label}-drawer-pale-accent`);
    await page.keyboard.press('Escape');
    await drawer.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
  }
  await restoreBranding();
  await cleanCheck(page, `${label} drawer on branding accents`);
}

/** Groups on the device page, and a Linux computer's own wording there. */
async function devicePageGroups(page, f, vp, label) {
  await go(page, `/endpoints/${f.main.id}`);
  const box = page.locator('[data-testid="device-groups"]');
  await box.waitFor({ timeout: 15_000 });
  const links = await box.locator('a').evaluateAll((els) => els.map((a) => ({ text: a.textContent.trim(), kind: a.getAttribute('data-group-kind'), href: a.getAttribute('href') })));
  const want = [{ text: `${TAG} Front desk`, kind: 'static', id: f.front.id }, { text: `${TAG} Online · rule`, kind: 'rule', id: f.onlineRule.id }];
  check(links.length === 2 && want.every((w) => links.some((l) => l.text === w.text && l.kind === w.kind && new URL(l.href, WEB).searchParams.get('groupId') === w.id)),
    `${label}: the device page lists its static group and the rule group it matches (not Business B's same-named one), each linking to the list filtered by it`, JSON.stringify(links));
  if (vp === 'phone') await noSideScroll(page, `${label} device groups`);
  await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': ip() });
  await box.locator('a[data-group-kind="rule"]').click();
  await page.waitForURL((u) => u.pathname === '/endpoints' && u.searchParams.get('groupId') === f.onlineRule.id, { timeout: 15_000 }).catch(() => {});
  // A's online computers: WS-01, 02, 03, 05 and LNX-01 (WS-04 is offline),
  // and the chat computer seed035() adds (signed agent, heartbeat now). Named,
  // not only counted: when the two 0.35 branches met, the count moved from 5
  // to 6 and only a name says which computer joined.
  const members = [`${TAG}-WS-01`, `${TAG}-WS-02`, `${TAG}-WS-03`, `${TAG}-WS-05`, `${TAG}-LNX-01`, `${TAG}-CHAT`];
  const n = await rowsSettle(page, members.length);
  const body = await page.locator('tbody').innerText().catch(() => '');
  check(new URL(page.url()).searchParams.get('groupId') === f.onlineRule.id && n === members.length && members.every((m) => body.includes(m)) && !body.includes(`${TAG}-WS-04`),
    `${label}: following the rule group lists its six members, by name (and not the offline WS-04)`, `${page.url()} rows ${n}: ${members.filter((m) => !body.includes(m)).join(', ') || 'all named'}`);
  await cleanCheck(page, `${label} device groups`);

  // A Linux computer: its package manager, not Windows Update.
  await go(page, `/endpoints/${f.linux.id}`);
  await page.locator('[data-testid="workspace-tabs"]').waitFor({ timeout: 20_000 });
  await settled(page);
  let text = await page.locator('main').innerText();
  check(text.includes('Package updates') && !/Windows Update|Windows is/.test(text), `${label}: a Linux computer's Overview names its package updates, never Windows Update`, text.match(/.{0,60}Windows.{0,60}/)?.[0] ?? '');
  await openTab(page, 'patches');
  const panel = page.locator('[role="tabpanel"][data-state="active"]');
  await panel.waitFor({ timeout: 10_000 });
  await settled(page, 12_000);
  text = await panel.innerText();
  check(/Package updates/.test(text) && /package manager/.test(text) && !/Windows Update|Windows is|from Windows/.test(text) && /A restart is pending/.test(text) && /deployments are Windows only/.test(text),
    `${label}: its Patches tab says the package manager reports a pending restart, never Windows Update, and that deployments are Windows only`, text.match(/.{0,80}Windows.{0,80}/)?.[0] ?? text.slice(0, 400));
  if (vp === 'phone') await noSideScroll(page, `${label} Linux patches tab`);
  await cleanCheck(page, `${label} Linux device page`);
}

/**
 * 0.35: the dashboard fits the screen at the common desktop sizes — neither
 * the document nor <main> (the shell's scroller) scrolls — with the map shown,
 * every panel inside the viewport and long lists scrolling in their own card.
 * At 375 px it stacks and scrolls down, never sideways.
 */
async function dashboardFit(browser, f, vp, theme, label) {
  const sizes = vp === 'phone' ? [null] : [[1440, 900], [1366, 768]];
  for (const size of sizes) {
    const ctx = size
      ? await browser.newContext({ viewport: { width: size[0], height: size[1] }, extraHTTPHeaders: { 'x-forwarded-for': ip() } })
      : await newContext(browser, vp, theme);
    if (size) await ctx.addInitScript((t) => { try { localStorage.setItem('theme', t); localStorage.removeItem('dashboard.map'); } catch { /* */ } }, theme);
    try {
      const tag = size ? `${label} ${size[0]}×${size[1]}` : label;
      const page = await signIn(ctx, f.admin.email, tag, theme);
      await go(page, '/dashboard');
      await page.locator('[data-testid="dashboard-grid"]').waitFor({ timeout: 20_000 });
      await settled(page);
      if (!size) {
        await noSideScroll(page, `${tag} dashboard`);
        const m = await page.evaluate(() => document.querySelector('main').scrollHeight > innerHeight);
        check(m, `${tag}: the dashboard stacks and scrolls down at phone width`);
        continue;
      }
      await page.locator('[data-testid="dashboard-map"]').waitFor({ timeout: 10_000 });
      const m = await page.evaluate(() => {
        const main = document.querySelector('main');
        const panels = [...document.querySelectorAll('[data-testid="dashboard-grid"] > *')].map((el) => { const r = el.getBoundingClientRect(); return { id: el.getAttribute('data-testid'), bottom: Math.round(r.bottom), right: Math.round(r.right) }; });
        return { doc: document.documentElement.scrollHeight, vh: innerHeight, mainScroll: main.scrollHeight, mainClient: main.clientHeight, docW: document.documentElement.scrollWidth, vw: innerWidth, panels };
      });
      check(m.doc <= m.vh && m.mainScroll <= m.mainClient + 1, `${tag}: the dashboard fits the window, map shown — the document (${m.doc} ≤ ${m.vh}) and the page (${m.mainScroll} ≤ ${m.mainClient}) do not scroll`, JSON.stringify(m));
      check(m.panels.length >= 7 && m.panels.every((p) => p.bottom <= m.vh + 1 && p.right <= m.vw + 1) && m.docW <= m.vw, `${tag}: all ${m.panels.length} panels, the map among them, are inside the viewport and nothing overflows sideways`, JSON.stringify(m.panels));
      await page.screenshot({ path: path.join(OUT_DIR, `dashboard-${size[0]}x${size[1]}-${theme}.png`) });
      await cleanCheck(page, `${tag} dashboard`);
    } finally { await ctx.close(); }
  }
}

/** 0.35: reachable with a silent agent is amber and says so — never a green "Online". */
async function agentSilentUi(page, f, label) {
  await go(page, `/endpoints?search=${encodeURIComponent(`${TAG}-BIRCH-SILENT`)}`);
  await rowsSettle(page, 1);
  const dot = page.locator('table [data-connectivity]').first();
  const cell = page.locator('[data-testid="last-seen-cell"]').first();
  const cellText = (await cell.innerText().catch(() => '')).trim();
  check(await dot.getAttribute('data-connectivity').catch(() => null) === 'agent_silent' && /agent silent 12 d/.test(cellText) && !/^Online/.test(cellText),
    `${label}: the device list draws a twelve-day-silent, RustDesk-reachable computer amber, "agent silent 12 d", not Online`, `${await dot.getAttribute('data-connectivity').catch(() => null)} / ${cellText}`);
  await go(page, `/endpoints/${f.silent.id}`);
  const st = page.locator('[data-testid="device-status"]');
  await st.waitFor({ timeout: 20_000 });
  const stText = (await st.innerText()).trim();
  const hint = await st.locator('dd').getAttribute('title');
  const dotCls = await st.locator('span[aria-hidden="true"]').getAttribute('class');
  check(stText.includes('Reachable (RustDesk) · agent silent 12 d') && /bg-amber-500/.test(dotCls ?? '') && /remote control should work/.test(hint ?? '') && /Update agent/.test(hint ?? ''),
    `${label}: its device page header says "Reachable (RustDesk) · agent silent 12 d" in amber, with a tooltip naming what still works and Update agent`, `${stText} | ${dotCls} | ${hint}`);
  // 0.37.2: Remote Support lists every reachable computer; a silent agent's card is amber, never the green "Online" it used to hard-code.
  await go(page, '/sessions');
  await settled(page);
  const card = page.locator('[data-status]', { hasText: `${TAG}-BIRCH-SILENT` }).first();
  await card.waitFor({ timeout: 20_000 }).catch(() => {});
  const cardTone = await card.getAttribute('data-status').catch(() => null);
  const cardDot = await card.locator('span[title]').first().getAttribute('class').catch(() => null);
  const cardText = (await card.innerText().catch(() => '')).trim();
  const counts = (await page.locator('[data-testid="reachable-counts"]').innerText().catch(() => '')).trim();
  check(cardTone === 'degraded' && /bg-amber-500/.test(cardDot ?? '') && !/bg-green-500/.test(cardDot ?? '') && /agent silent 12 d/.test(cardText) && /Agent last checked in 12d ago/.test(cardText) && /\d+ agent silent/.test(counts),
    `${label}: Remote Support draws the agent-silent computer amber with "agent silent 12 d" and counts it apart from online ones`, `${cardTone} | ${cardDot} | ${cardText.replace(/\s+/g, ' ')} | ${counts}`);
  await go(page, '/dashboard');
  await settled(page);
  const dash = await page.locator('main').innerText();
  check(/\d+ online · \d+ agent silent · \d+ offline/.test(dash), `${label}: the dashboard's Devices tile counts agent-silent computers apart from online ones`, dash.match(/.{0,40}online.{0,60}/)?.[0] ?? '');
  await cleanCheck(page, `${label} agent silent`);
}

/**
 * 0.66: an alert explains itself. The DS-HOME1 fixture: the five sections, the
 * honest "cannot be ruled out", the row's "partly checked" badge, the raw
 * event, the monitor rule and similar alerts — no console error, no side scroll.
 */
async function alertExplanation(page, f, vp, label) {
  const al = f.c.dsAlert;
  await go(page, `/alerts?alert=${al.id}`);
  const box = page.getByTestId('alert-explanation').first();
  await box.waitFor({ timeout: 20_000 }).catch(() => {});
  const t = await box.innerText().catch(() => '');
  // 0.92 (UX P1-6): the eight questions come first; the explanation box keeps why it was raised and how it was classified.
  const qs = page.getByTestId('alert-questions').first();
  await qs.waitFor({ timeout: 20_000 }).catch(() => {});
  const qt = await qs.innerText().catch(() => '');
  const answers = await qs.locator('[data-question]').evaluateAll((els) => els.map((e) => [e.getAttribute('data-question'), e.getAttribute('data-status')]));
  const ak = answers.map((x) => x[0]);
  check(['What happened?', 'Which customer and device are affected?', 'When was it observed?', 'How fresh is the evidence?', 'Why does it matter?', 'What can I safely do?', 'Was it verified as resolved?'].every((h) => qt.includes(h))
    && /shadow copy/i.test(qt) && /cannot be ruled out/.test(qt),
    `${label}: the alert answers the eight questions (what, who, when, how fresh, why it matters, what to do, verified)`, qt.replace(/\s+/g, ' ').slice(0, 400));
  check(JSON.stringify(ak.filter((k) => k !== 'ticket')) === JSON.stringify(['what', 'who', 'when', 'fresh', 'why', 'act', 'resolved'])
    && ['fresh', 'stale', 'unknown'].includes(answers.find((x) => x[0] === 'fresh')?.[1] ?? '') && answers.find((x) => x[0] === 'resolved')?.[1] === 'open',
    `${label}: in order, with the evidence's freshness and "not yet" resolved`, JSON.stringify(answers));
  check(/change nothing on the device/.test(qt) && /no ticket is needed/.test(qt), `${label}: and says acknowledging and resolving change nothing on the device and need no ticket`);
  check(['Why was this alert generated?', 'Classification details'].every((h) => t.includes(h)) && !t.includes('Recommended action') && /Partly seen/.test(t),
    `${label}: the explanation box keeps why it was raised and how sure Rem0te is, without repeating the answers`, t.replace(/\s+/g, ' ').slice(0, 300));
  check(await page.getByTestId('alert-investigate').first().innerText().catch(() => '') === 'Investigate on the device: Event log', `${label}: an event alert links to the device's Event log`);
  const badge = await page.locator('[data-testid="alerts-list"] [data-testid="alert-class"]').first().innerText().catch(() => '');
  check(/partly checked/.test(badge), `${label}: the alert row says it was only partly checked`, badge);
  const views = page.getByTestId('alert-views').first();
  await views.getByRole('button', { name: 'View raw event' }).click();
  const raw = await page.getByTestId('alert-raw').first().innerText().catch(() => '');
  check(/HarddiskVolumeShadowCopy59/.test(raw) && /0xC00000A2/.test(raw), `${label}: View raw event shows the event as the agent sent it`, raw.slice(0, 200));
  await views.getByRole('button', { name: 'View matching monitor rule' }).click();
  const rule = await page.getByTestId('alert-rule').first().innerText().catch(() => '');
  check(/disk-errors/.test(rule) && /"levels"/.test(rule), `${label}: View matching monitor rule names the monitor and its parameters`, rule.slice(0, 200));
  await views.getByRole('button', { name: /View similar alerts/ }).click();
  const sim = await page.getByTestId('alert-similar').first().innerText().catch(() => '');
  check(/No other alert you can see has the same event fingerprint/.test(sim), `${label}: View similar alerts says when there are none`, sim.slice(0, 200));
  if (vp === 'phone') await noSideScroll(page, `${label} alert explanation`);
  await cleanCheck(page, `${label} alert explanation`);
}

/**
 * 0.67: Report false positive and the False positives & rules page. The
 * first desktop run reports DS-HOME1's alert (recommending prevention, not
 * resolving it, so the 0.66 checks still hold on later runs), proposes a rule
 * from the recommendation, tests it and opens the approval dialog — which it
 * cancels, so nothing is approved and the alert is unchanged. Every run checks
 * the modal and the page draw without a console error or a side scroll.
 */
let fpReported = false;
async function falsePositiveUi(page, f, vp, label) {
  const al = f.c.dsAlert;
  await go(page, `/alerts?alert=${al.id}`);
  const open = page.getByTestId('fp-open').first();
  await open.waitFor({ timeout: 20_000 }).catch(() => {});
  await open.click();
  const dlg = page.getByTestId('fp-dialog');
  await dlg.getByTestId('fp-alert').waitFor({ timeout: 20_000 }).catch(() => {});
  const t = await dlg.innerText().catch(() => '');
  check(/does not turn off the monitor/.test(t) && /disk-errors/.test(t) && /Similar alerts/.test(t),
    `${label}: Report false positive shows the alert, its monitor and similar alerts, and says it does not turn the monitor off`, t.replace(/\s+/g, ' ').slice(0, 300));
  if (!fpReported) {
    const reasons = await dlg.getByTestId('fp-reasons').locator('input[type="radio"]').count();
    check(reasons === 8, `${label}: the dialog offers the eight reasons`, String(reasons));
    check(await dlg.getByTestId('fp-submit').isDisabled(), `${label}: Report waits for a reason`);
    await dlg.getByLabel('Known harmless event').check();
    await dlg.getByTestId('fp-recommend').check();
    const proposed = await dlg.getByTestId('fp-proposed').innerText().catch(() => '');
    check(/a suggestion/.test(proposed), `${label}: recommending prevention shows the proposed handling as a suggestion`, proposed.slice(0, 200));
    if (vp === 'phone') await noSideScroll(page, `${label} false-positive dialog`);
    await dlg.getByTestId('fp-submit').click();
    await dlg.waitFor({ state: 'detached', timeout: 20_000 }).catch(() => {});
    fpReported = true;
    const badge = page.getByTestId('alert-fp-count').first();
    await badge.waitFor({ timeout: 20_000 }).catch(() => {});
    check(/×1/.test(await badge.innerText().catch(() => '')), `${label}: the alert now says it was reported as a false positive once`);
    const st = await prisma.monitorAlert.findUnique({ where: { id: al.id }, select: { state: true, severity: true } });
    check(st?.state !== 'RESOLVED' && st?.severity === al.severity, `${label}: reporting without "Also resolve" left the alert open and unchanged`, JSON.stringify(st));
  } else {
    check(await dlg.getByTestId('fp-already').count() === 1, `${label}: a second look says you already reported it`);
    if (vp === 'phone') await noSideScroll(page, `${label} false-positive dialog`);
    await page.keyboard.press('Escape');
  }
  await cleanCheck(page, `${label} false-positive dialog`);

  await go(page, '/alerts/quality');
  await page.getByTestId('q-totals').waitFor({ timeout: 20_000 }).catch(() => {});
  const totals = await page.getByTestId('q-totals').innerText().catch(() => '');
  check(/False-positive reports/.test(totals) && /Rules pending approval/.test(totals), `${label}: False Positives & Rule Improvements shows its totals`, totals.replace(/\s+/g, ' ').slice(0, 200));
  if (fpProposed) {
    // Proposing converted the recommendation; the rule waits in the rules list, unapproved.
    const row = page.getByTestId('q-rule-row').filter({ hasText: 'disk-errors' }).first();
    await row.waitFor({ timeout: 20_000 }).catch(() => {});
    check(/pending/.test(await row.innerText().catch(() => '')), `${label}: the proposed rule is listed as pending, not applied`);
  }
  const rec = page.locator('[data-testid="q-rec"][data-monitor="disk-errors"]').first();
  if (!fpProposed) {
    await rec.waitFor({ timeout: 20_000 }).catch(() => {});
    check(/never approve anything/.test(await rec.innerText().catch(() => '')), `${label}: the recommendation card says reports never approve anything`);
  }
  if (vp === 'desktop' && !fpProposed) {
    fpProposed = true;
    await rec.getByTestId('q-rec-propose').click();
    const ed = page.getByTestId('q-editor');
    await ed.waitFor({ timeout: 10_000 });
    await ed.getByTestId('q-editor-save').click();
    const detail = page.getByTestId('q-rule-detail').first();
    await detail.waitFor({ timeout: 20_000 }).catch(() => {});
    check(/Not tested yet/.test(await detail.innerText().catch(() => '')) && await detail.getByTestId('q-approve').isDisabled(), `${label}: a proposed rule cannot be approved before it is tested`);
    await detail.getByRole('button', { name: /Test proposed rule/ }).click();
    await detail.getByTestId('q-sim').waitFor({ timeout: 30_000 }).catch(() => {});
    const sim = await detail.getByTestId('q-sim').innerText().catch(() => '');
    check(/Over the last \d+ days/.test(sim), `${label}: Test proposed rule shows what it would have done to stored alerts`, sim.slice(0, 200));
    await detail.getByTestId('q-approve').click();
    const ad = page.getByTestId('q-approve-dialog');
    await ad.waitFor({ timeout: 10_000 }).catch(() => {});
    check(/roll it back/.test(await ad.innerText().catch(() => '')), `${label}: the approval dialog says what the rule will do and that it can be rolled back`);
    await ad.getByRole('button', { name: 'Cancel' }).click();
    const row = await prisma.alertQualityRule.findFirst({ where: { customerId: f.B.id }, orderBy: { createdAt: 'desc' }, select: { status: true } });
    check(row?.status === 'pending', `${label}: cancelling leaves the rule awaiting approval`, JSON.stringify(row));
    const st = await prisma.monitorAlert.findUnique({ where: { id: al.id }, select: { state: true, severity: true } });
    check(st?.state !== 'RESOLVED' && st?.severity === al.severity, `${label}: an unapproved rule did not touch the alert`, JSON.stringify(st));
  }
  if (vp === 'phone') await noSideScroll(page, `${label} false positives page`);
  await cleanCheck(page, `${label} false positives page`);
}
let fpProposed = false;

// ── 0.36 ────────────────────────────────────────────────────────────────────

const FILL = { online: 'rgb(16, 185, 129)', agent_silent: 'rgb(245, 158, 11)', offline: 'rgb(100, 116, 139)' }; // emerald-500, amber-500, slate-500
/** The marker drawn for a fixture place, or null: its state, its computed fill, and whether it is on screen. */
async function marker(page, city) {
  const m = page.locator(`[data-testid="dashboard-map"] circle[data-place="${city}"]`);
  if (!(await m.count())) return null;
  return m.first().evaluate((el) => { const r = el.getBoundingClientRect(); return { state: el.getAttribute('data-connectivity'), fill: getComputedStyle(el).fill, w: r.width, x: r.x, y: r.y }; });
}

/**
 * The dashboard map's markers, resolved through the API's GeoipService from
 * the fixture database: an agent-silent computer alone at a place is amber,
 * never green; the online and offline ones beside it are green and grey; the
 * tooltip says "agent silent". Then a Business Owner of A sees A's marker and
 * none of B's.
 */
async function mapMarkers(page, label) {
  await go(page, '/dashboard');
  await page.locator('[data-testid="dashboard-map"]').waitFor({ timeout: 20_000 });
  await page.locator(`[data-testid="dashboard-map"] circle[data-place="${GEO.silent.city}"]`).waitFor({ timeout: 20_000 }).catch(() => {});
  const [s, o, x] = [await marker(page, GEO.silent.city), await marker(page, GEO.online.city), await marker(page, GEO.offline.city)];
  check(s?.state === 'agent_silent' && s.fill === FILL.agent_silent && s.w > 0,
    `${label}: the map draws the agent-silent computer's marker (${GEO.silent.city}) amber, not green`, JSON.stringify(s));
  check(o?.state === 'online' && o.fill === FILL.online && x?.state === 'offline' && x.fill === FILL.offline,
    `${label}: beside it the online computer's marker is green and the offline one's grey`, JSON.stringify({ o, x }));
  // The tooltip, from hovering the amber marker itself.
  await page.locator(`[data-testid="dashboard-map"] circle[data-place="${GEO.silent.city}"]`).hover({ force: true }).catch(() => {});
  const tip = page.locator('[data-testid="dashboard-map"] .bg-popover');
  await tip.waitFor({ timeout: 5_000 }).catch(() => {});
  const tipText = (await tip.innerText().catch(() => '')).replace(/\s+/g, ' ');
  check(tipText.includes(GEO.silent.city) && /1 device · 0 online · 1 agent silent/.test(tipText),
    `${label}: hovering it says "1 computer · 0 online · 1 agent silent"`, tipText);
  await cleanCheck(page, `${label} map markers`);
}
async function mapMarkersOwner(page, label) {
  await go(page, '/dashboard');
  await page.locator('[data-testid="dashboard-map"]').waitFor({ timeout: 20_000 });
  await page.locator(`[data-testid="dashboard-map"] circle[data-place="${GEO.offline.city}"]`).waitFor({ timeout: 20_000 }).catch(() => {});
  const [s, o, x] = [await marker(page, GEO.silent.city), await marker(page, GEO.online.city), await marker(page, GEO.offline.city)];
  check(x?.state === 'offline' && s === null && o === null,
    `${label}: a Business Owner of A sees A's marker (${GEO.offline.city}) and neither of B's`, JSON.stringify({ s, o, x }));
}

/**
 * With a containment banner showing, the dashboard still fits 1440 × 900:
 * it is sized to the viewport less the top bar AND the banner
 * (--containment-banner-h), so neither the document nor <main> scrolls and
 * every panel stays inside the window. The pause is on business B and lives
 * only for this check.
 */
async function dashboardBanner(browser, f, theme, label) {
  const pause = await prisma.containmentPause.create({ data: {
    scope: 'BUSINESS', customerId: f.B.id, kinds: ['updates'], reason: `UI suite ${TAG}: dashboard layout under a banner`, setById: f.admin.id, setBy: 'msp',
  } });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, extraHTTPHeaders: { 'x-forwarded-for': ip() } });
  await ctx.addInitScript((t) => { try { localStorage.setItem('theme', t); localStorage.removeItem('dashboard.map'); } catch { /* */ } }, theme);
  try {
    const tag = `${label} 1440×900 with a containment banner`;
    const page = await signIn(ctx, f.admin.email, tag, theme);
    await go(page, '/dashboard');
    const banner = page.locator('[data-testid="containment-banner"]');
    await banner.waitFor({ timeout: 20_000 });
    await page.locator('[data-testid="dashboard-grid"]').waitFor({ timeout: 20_000 });
    await page.locator('[data-testid="dashboard-map"]').waitFor({ timeout: 10_000 });
    await settled(page);
    const m = await page.evaluate(() => {
      const main = document.querySelector('main');
      const b = document.querySelector('[data-testid="containment-banner"]').getBoundingClientRect();
      const panels = [...document.querySelectorAll('[data-testid="dashboard-grid"] > *')].map((el) => { const r = el.getBoundingClientRect(); return { id: el.getAttribute('data-testid'), bottom: Math.round(r.bottom) }; });
      return { doc: document.documentElement.scrollHeight, vh: innerHeight, mainScroll: main.scrollHeight, mainClient: main.clientHeight, banner: Math.round(b.height),
        varH: getComputedStyle(document.documentElement).getPropertyValue('--containment-banner-h').trim(), panels };
    });
    check(m.banner > 0 && Math.abs(parseFloat(m.varH) - m.banner) <= 1, `${tag}: the banner (${m.banner} px) publishes its height as --containment-banner-h (${m.varH})`, JSON.stringify(m));
    check(m.doc <= m.vh && m.mainScroll <= m.mainClient + 1, `${tag}: the dashboard still fits — the document (${m.doc} ≤ ${m.vh}) and the page (${m.mainScroll} ≤ ${m.mainClient}) do not scroll`, JSON.stringify(m));
    check(m.panels.length >= 7 && m.panels.every((p) => p.bottom <= m.vh + 1), `${tag}: all ${m.panels.length} panels are inside the viewport`, JSON.stringify(m.panels));
    await page.screenshot({ path: path.join(OUT_DIR, `dashboard-banner-1440x900-${theme}.png`) });
    await cleanCheck(page, `${tag} dashboard`);
  } finally {
    await ctx.close();
    await prisma.containmentPause.delete({ where: { id: pause.id } }).catch(() => {});
  }
}

/**
 * The signed-out pages drawn on the branding accent — the login page's brand
 * band and the public Quick Connect page's step numbers (and download
 * buttons, when a client is configured) — pick black or white by luminance:
 * 4.5:1 on a pale, a dark and the default accent. Quick Connect is switched
 * on for the check and put back.
 */
async function accentPages(browser, f, theme, label) {
  const qc = await prisma.platformSettings.findUnique({ where: { id: 'singleton' }, select: { quickConnectEnabled: true } });
  await prisma.platformSettings.upsert({ where: { id: 'singleton' }, create: { id: 'singleton', quickConnectEnabled: true }, update: { quickConnectEnabled: true } });
  const ctx = await newContext(browser, 'desktop', theme);
  const page = await ctx.newPage();
  instrument(page);
  try {
    for (const accent of ['#FDE68A', '#1E3A8A', '#3B82F6']) {
      await setAccent(f.tenant.id, accent);
      const want = `rgb(${parseInt(accent.slice(1, 3), 16)}, ${parseInt(accent.slice(3, 5), 16)}, ${parseInt(accent.slice(5, 7), 16)})`;
      await go(page, '/login');
      const band = page.locator('[data-accent-band]');
      await band.waitFor({ timeout: 15_000 }).catch(() => {});
      const b = await band.evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, title: getComputedStyle(el.querySelector('.font-semibold') ?? el).color, icon: getComputedStyle(el.querySelector('svg') ?? el).color })).catch(() => null);
      const rt = b ? contrast(b.title, b.bg) : 0, ri = b ? contrast(b.icon, b.bg) : 0;
      check(b?.bg === want && rt >= 4.5 && ri >= 4.5, `${label}: on accent ${accent} the login page's brand band title is ${rt.toFixed(2)}:1 and its mark ${ri.toFixed(2)}:1 (WCAG AA is 4.5:1)`, JSON.stringify(b));
      await go(page, '/quick');
      const inks = page.locator('[data-accent-ink]');
      await inks.first().waitFor({ timeout: 15_000 }).catch(() => {});
      const q = await inks.evaluateAll((els) => els.map((el) => ({ bg: getComputedStyle(el).backgroundColor, ink: getComputedStyle(el).color, text: el.textContent.trim().slice(0, 30) })));
      const worst = q.length ? Math.min(...q.map((x) => contrast(x.ink, x.bg))) : 0;
      check(q.length >= 4 && q.every((x) => x.bg === want) && worst >= 4.5,
        `${label}: on accent ${accent} Quick Connect's ${q.length} step numbers and buttons are at least ${worst.toFixed(2)}:1`, JSON.stringify(q));
      if (accent === '#FDE68A') await shot(page, `${label}-quick-pale-accent`);
    }
    await cleanCheck(page, `${label} login and Quick Connect on branding accents`);
  } finally {
    await ctx.close();
    await restoreBranding();
    await prisma.platformSettings.update({ where: { id: 'singleton' }, data: { quickConnectEnabled: qc?.quickConnectEnabled ?? false } }).catch(() => {});
  }
}

/**
 * 0.89 (UX P1-3): the device list. Two devices with one name in two customers
 * each say which customer and site they are, at every width; on a phone every
 * row does, the toolbar is one row and no name hides under the sticky Connect
 * column; the built-in views set the server's own filters; a star from the row
 * menu puts a device in "My favourites" and taking it off takes it out; the
 * density control is a toggle named for what it does.
 */
async function deviceListP13(page, f, vp, label) {
  const twin = `${TAG}-TWIN-${label.replace('/', '-').toUpperCase()}`;
  const mkTwin = (biz) => prisma.endpoint.create({ data: {
    tenantId: f.tenant.id, customerId: biz.id, name: twin, hostname: `${twin.toLowerCase()}.corp.example.com`, platform: 'Windows', osVersion: 'Windows 11 Pro',
    status: 'ACTIVE', isOnline: false, isManaged: true, accessMode: 'COMPANY_WIDE', lastSeenAt: new Date(Date.now() - 86400_000), deviceClass: 'WORKSTATION', agentVersion: '0.33.0',
  } });
  const twins = [await mkTwin(f.A), await mkTwin(f.B)];
  try {
    await go(page, '/endpoints');
    const search = page.locator('input[aria-label="Search devices"]');
    await search.fill(twin);
    const n = await rowsSettle(page, 2);
    const where = await page.locator('[data-testid="device-where"]').evaluateAll((els) => els.map((e) => ({ text: e.textContent ?? '', shared: e.getAttribute('data-shared'), shown: e.getBoundingClientRect().height > 0 })));
    check(n === 2 && where.length === 2 && where.every((w) => w.shared === 'true' && w.shown)
      && where.some((w) => w.text.includes(`${TAG} Acme`)) && where.some((w) => w.text.includes(`${TAG} Birch`)),
    `${label}: two devices named alike each show their customer (and site) under the name (directive §9)`, JSON.stringify(where));
    const links = await page.locator(`table a[data-testid="device-name"]`).evaluateAll((els) => els.map((e) => e.getAttribute('href')));
    check(new Set(links).size === 2 && twins.every((t) => links.includes(`/endpoints/${t.id}`)), `${label}: …and each still opens by its own id`, links.join(', '));

    await search.fill(`${TAG}-WS`);
    await rowsSettle(page, 5);
    const ws = await page.locator('[data-testid="device-where"]').evaluateAll((els) => els.map((e) => ({ shared: e.getAttribute('data-shared'), shown: e.getBoundingClientRect().height > 0 })));
    if (vp === 'phone') {
      check(ws.length === 5 && ws.every((w) => w.shown), `${label}: on a phone every row names its customer under the device (the Customer column is hidden)`, JSON.stringify(ws));
      const geo = await page.evaluate(() => {
        const tb = document.querySelector('[data-testid="device-toolbar"]');
        const vis = [...tb.querySelectorAll('button, input')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
        let covered = 0;
        for (const tr of document.querySelectorAll('tbody tr')) {
          const a = tr.querySelector('[data-testid="device-name"]')?.getBoundingClientRect(); const c = tr.lastElementChild?.getBoundingClientRect();
          if (a && c && a.right > c.left + 1) covered++;
        }
        return { rows: new Set(vis.map((e) => Math.round(e.getBoundingClientRect().top))).size, controls: vis.length, covered };
      });
      check(geo.rows === 1 && geo.controls === 4, `${label}: the toolbar is one row — search, Filters, Views and a menu (F-21)`, JSON.stringify(geo));
      check(geo.covered === 0, `${label}: no device name hides under the sticky Connect column`, JSON.stringify(geo));
    } else {
      check(ws.length === 5 && ws.every((w) => !w.shown), `${label}: on a desktop a name nobody else has needs no customer line (the Customer column says it)`, JSON.stringify(ws));
      const dens = page.locator('[data-testid="density-toggle"]');
      const before = await dens.getAttribute('aria-pressed');
      await dens.click();
      const after = await dens.getAttribute('aria-pressed');
      check((await dens.innerText()).trim() === 'Compact rows' && before !== after, `${label}: density is a toggle named "Compact rows", its state in aria-pressed (F-21)`, `${before} → ${after}`);
      await dens.click();
    }

    // Built-in views: the server's own filters, in the address bar.
    const views = page.locator('[data-testid="views-menu"]');
    // Wait for the view to be applied (it empties the search box) before typing a search, or the reset wipes what was typed.
    const openBuiltin = async (id) => {
      await views.click();
      const item = page.locator(`[role="menu"] [data-testid="builtin-${id}"]`);
      const name = (await item.innerText()).trim();
      await item.click();
      await page.waitForFunction((n) => document.querySelector('[data-testid="views-menu"]')?.getAttribute('aria-label') === n
        && (document.querySelector('input[aria-label="Search devices"]')?.value ?? '') === '', name, { timeout: 10_000 }).catch(() => {});
      await settled(page);
    };
    await views.click();
    const offered = await page.locator('[role="menu"] [data-testid^="builtin-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
    const notOffered = await page.locator('[role="menu"] [data-testid="builtin-not-offered"]').innerText().catch(() => '');
    await page.keyboard.press('Escape');
    check(['favorites', 'recent', 'critical', 'offline', 'windows-servers', 'windows-workstations', 'linux', 'macos', 'restart', 'critical-updates', 'agent-outdated', 'warranty'].every((id) => offered.includes(`builtin-${id}`))
      && /failed automation/.test(notOffered) && /aging hardware/.test(notOffered) && /backup failures/.test(notOffered),
    `${label}: the Views menu offers the built-in views and says which of §9's are not offered yet, and why`, `${offered.join(',')} | ${notOffered}`);
    await openBuiltin('windows-workstations');
    const q = new URL(page.url()).searchParams;
    check(q.get('platform') === 'windows' && q.get('windowsRole') === 'workstation' && await page.locator('[data-testid="builtin-view"]').isVisible()
      && await views.getAttribute('aria-label') === 'Windows workstations',
    `${label}: "Windows workstations" sets platform=windows&windowsRole=workstation, names itself and says what it shows`, page.url());
    // Type only once the view's own rows are on screen, then wait for the search to reach the address bar.
    await rowsSettle(page, 5, true);
    await search.fill(`${TAG}-WS`);
    await page.waitForURL((u) => u.searchParams.get('search') === `${TAG}-WS` && u.searchParams.get('windowsRole') === 'workstation', { timeout: 10_000 }).catch(() => {});
    const wsN = await rowsSettle(page, 5);
    check(wsN === 5, `${label}: the five Windows 11 Pro fixtures are workstations`,
      `rows ${wsN}; url ${page.url()}; box "${await search.inputValue()}"; names ${(await page.locator('[data-testid="device-name"]').allInnerTexts()).slice(0, 6).join(', ')}`);
    await openBuiltin('windows-servers');
    await search.fill(`${TAG}-WS`);
    await page.waitForURL((u) => u.searchParams.get('search') === `${TAG}-WS` && u.searchParams.get('windowsRole') === 'server', { timeout: 10_000 }).catch(() => {});
    const srvN = await rowsSettle(page, 0);
    check(srvN === 0, `${label}: …and none of them is a server`, `rows ${srvN}`);

    // Favourites from the row menu, and "My favourites". Start from "not a
    // favourite" (whatever an earlier section left), and put it back after.
    const favWhere = { userId: f.admin.id, list: 'favorite', kind: 'device', ref: f.main.id };
    const priorFav = await prisma.userNavItem.findFirst({ where: favWhere });
    await prisma.userNavItem.deleteMany({ where: favWhere });
    try {
      await go(page, '/endpoints');
      await search.fill(f.main.name);
      await rowsSettle(page, 1);
      await page.getByRole('button', { name: `More for ${f.main.name}` }).click();
      const toggle = page.locator('[role="menu"] [data-testid="row-toggle-favorite"]');
      check((await toggle.innerText()).includes('Add to favourites'), `${label}: the row menu offers "Add to favourites"`, await toggle.innerText());
      await toggle.click();
      const starRow = page.locator(`tbody tr:has(a[href="/endpoints/${f.main.id}"]) [data-testid="row-favorite"]`);
      await starRow.waitFor({ timeout: 10_000 }).catch(() => {});
      check(await starRow.count() === 1, `${label}: …and the row then shows a star`);
      await openBuiltin('favorites');
      await search.fill(f.main.name);
      const favN = await rowsSettle(page, 1);
      check(favN === 1 && new URL(page.url()).searchParams.get('mine') === 'favorite', `${label}: "My favourites" (mine=favorite) lists it`, `rows ${favN}, ${page.url()}`);
      await page.getByRole('button', { name: `More for ${f.main.name}` }).click();
      await page.locator('[role="menu"] [data-testid="row-toggle-favorite"]').click();
      const gone = await rowsSettle(page, 0);
      check(gone === 0, `${label}: taking the star off takes it out of "My favourites" without a reload`, `rows ${gone}`);
    } finally {
      await prisma.userNavItem.deleteMany({ where: favWhere });
      if (priorFav) await prisma.userNavItem.create({ data: priorFav });
    }
    await go(page, '/endpoints');
    await noSideScroll(page, `${label} device list (0.89)`);
    await shot(page, `${label}-device-list-favourites`);
    await cleanCheck(page, `${label} device list (0.89)`);
  } finally {
    await prisma.endpoint.deleteMany({ where: { id: { in: twins.map((t) => t.id) } } });
  }
}

/** At 375 px the filters are behind "Filters (n)" in a sheet; on desktop they stay inline. */
async function filtersSheet(page, vp, label) {
  await go(page, '/endpoints');
  const trigger = page.locator('[data-testid="filters-sheet-trigger"]');
  const inlineOnline = page.getByRole('combobox', { name: 'Online' });
  await page.locator('input[aria-label="Search devices"]').fill(`${TAG}-WS`);
  await rowsSettle(page, 5);
  if (vp === 'desktop') {
    check(!(await trigger.isVisible()) && await inlineOnline.isVisible(), `${label}: the filters sit inline beside the search, with no Filters button`);
    return;
  }
  // 0.89: an icon button named "Filters" (with the count when some are set), so the toolbar is one row.
  check(await trigger.isVisible() && !(await inlineOnline.isVisible()) && await trigger.getAttribute('aria-label') === 'Filters', `${label}: the filters are behind a "Filters" button, not stacked above the table`, String(await trigger.getAttribute('aria-label')));
  const table = await page.locator('table').first().boundingBox();
  const search = await page.locator('input[aria-label="Search devices"]').boundingBox();
  check(table && search && table.y - (search.y + search.height) < 200, `${label}: the table starts within 200 px of the search box`, `search bottom ${search && Math.round(search.y + search.height)}, table top ${table && Math.round(table.y)}`);
  await trigger.click();
  const sheet = page.locator('[data-testid="filters-sheet"]');
  await sheet.waitFor({ timeout: 5_000 });
  const b = await sheet.boundingBox();
  check(b && b.x >= 0 && b.x + b.width <= 375.5 && b.y + b.height <= 812.5, `${label}: the sheet fits the screen`, JSON.stringify(b));
  await shot(page, `${label}-filters-sheet`);
  await sheet.getByRole('combobox', { name: 'Online' }).click();
  await page.getByRole('option', { name: 'Online (agent checking in)', exact: true }).click();
  const n = await rowsSettle(page, 4);
  check(n === 4, `${label}: Online, chosen in the sheet, applies at once (four of the five are online)`, `rows ${n}`);
  await sheet.locator('[data-testid="filters-sheet-done"]').click();
  await sheet.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
  check(!(await sheet.isVisible()) && await trigger.getAttribute('aria-label') === 'Filters (1 set)' && (await trigger.innerText()).trim() === '1', `${label}: closing it leaves the count on the button ("Filters (1 set)")`, `${await trigger.getAttribute('aria-label')} / ${await trigger.innerText()}`);
  await noSideScroll(page, `${label} filters sheet`);
  await trigger.click();
  await sheet.waitFor({ timeout: 5_000 });
  await sheet.getByRole('combobox', { name: 'Online' }).click();
  await page.getByRole('option', { name: 'Online: all' }).click();
  await rowsSettle(page, 5);
  await page.keyboard.press('Escape');
  await sheet.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
  check(await trigger.getAttribute('aria-label') === 'Filters' && (await trigger.innerText()).trim() === '', `${label}: and clearing it there takes the count off`, `${await trigger.getAttribute('aria-label')} / ${await trigger.innerText()}`);
  await cleanCheck(page, `${label} filters sheet`);
}

/** "Schedule this report": offered where a schedule can be made, and it carries the filters. */
async function scheduleLinks(page, f, label) {
  const link = page.locator('[data-testid="schedule-report"]');
  for (const r of ['patch-compliance', 'agent-coverage', 'alert-frequency', 'offline-time']) {
    await go(page, `/reports/${r}`);
    check(await link.isVisible() && new URL(await link.getAttribute('href'), WEB).searchParams.get('report') === r, `${label}: ${r} offers "Schedule this report"`);
  }
  await go(page, '/reports/software-compliance');
  check(!(await link.isVisible()), `${label}: software compliance, which cannot be scheduled, does not`);

  // Agent coverage, for Business A, not heard from in 14 days.
  await go(page, `/reports/agent-coverage?businessId=${f.A.id}&silentDays=14`);
  await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': ip() });
  await link.click();
  await page.waitForURL((u) => u.pathname === '/reports/schedules', { timeout: 15_000 });
  await hydrated(page); await settled(page);
  const form = page.locator('[data-testid="report-schedule-form"]');
  await form.waitFor({ timeout: 15_000 }).catch(() => {});
  const u = new URL(page.url());
  const v = async (sel) => page.locator(sel).inputValue().catch(() => null);
  check(u.searchParams.get('businessId') === f.A.id && u.searchParams.get('silentDays') === '14', `${label}: the link carries the report's business and silent-days filter`, page.url());
  check(await v('#sched-business') === f.A.id && await v('#sf-report') === 'agent-coverage' && await v('#sf-silent') === '14' && await page.locator('[data-testid="schedule-prefill"]').isVisible(),
    `${label}: Scheduled reports opens on that business with the form prefilled (report, 14 days) and says so`, `${await v('#sched-business')} ${await v('#sf-report')} ${await v('#sf-silent')}`);
  await cleanCheck(page, `${label} schedule from agent coverage`);

  // Offline time on 30 days → monthly; on 90 days → weekly, and the page says why.
  await go(page, `/reports/schedules?report=offline-time&businessId=${f.A.id}&days=30`);
  await form.waitFor({ timeout: 15_000 }).catch(() => {});
  check(await v('#sf-report') === 'offline-time' && await v('#sf-freq') === 'monthly', `${label}: a 30-day report is prefilled as monthly`, `${await v('#sf-report')} ${await v('#sf-freq')}`);
  await go(page, `/reports/alert-frequency?businessId=${f.A.id}&days=90`);
  await link.click();
  await page.waitForURL((x) => x.pathname === '/reports/schedules', { timeout: 15_000 });
  await hydrated(page); await settled(page);
  await form.waitFor({ timeout: 15_000 }).catch(() => {});
  const note = await page.locator('[data-testid="schedule-prefill"]').innerText().catch(() => '');
  check(await v('#sf-report') === 'alert-frequency' && await v('#sf-freq') === 'weekly' && /90 days/.test(note) && /7 days \(weekly\) or 30 days \(monthly\)/.test(note),
    `${label}: a 90-day report is prefilled weekly, and the page says a schedule covers 7 or 30 days`, note);
  await cleanCheck(page, `${label} schedule from alert frequency`);
}

/** A Business User may not own a schedule: no link on any report, and the API refuses them too. */
async function memberChecks(browser, f, vp, theme, label) {
  const ctx = await newContext(browser, vp, theme);
  try {
    const page = await signIn(ctx, f.member.email, `${label} (Business User)`, theme);
    // 0.64: the Add device link is shown only with Add computers.
    if (vp === 'desktop') await openNavGroup(page.locator('nav[aria-label="Main"]').first(), 'devices');
    if (vp === 'desktop') check(await page.locator('nav[aria-label="Main"] [data-nav-item="/endpoints"]').first().isVisible() && await page.locator('[data-testid="nav-shortcut-devices"]').count() === 0,
      `${label}: a Business User without Add computers has no "Add device" link in the sidebar`);
    await go(page, '/reports/agent-coverage');
    check(await page.locator('main h1').first().isVisible() && !(await page.locator('[data-testid="schedule-report"]').isVisible()), `${label}: a Business User sees the report without "Schedule this report"`);
    const r = await page.request.get(`${WEB}/api/v1/reports/schedules`, { headers: { 'x-forwarded-for': ip() } });
    check(r.status() === 403, `${label}: and the API refuses them a schedule list (HTTP ${r.status()}), as the link's rule says`);
    await cleanCheck(page, `${label} Business User report`);
    // 0.37: computers:view only — the header offers no agent buttons; the card's upgrade is not offered to them either.
    await go(page, `/endpoints/${f.main.id}`);
    await page.locator('[data-testid="agent-card"] [data-testid="agent-migrate"]').waitFor({ timeout: 15_000 }).catch(() => {});
    const hdr = page.locator('[data-testid="device-actions"]');
    const offered = await hdr.locator('[data-testid="header-upgrade-full-agent"], [data-testid="header-update-agent"], [data-testid="header-agent-command"], [data-testid="header-full-agent"]').count();
    const cardBtn = page.locator('[data-testid="agent-card"] [data-testid="agent-migrate"]');
    check(await hdr.isVisible() && offered === 0 && await cardBtn.count() === 1 && await cardBtn.isDisabled(),
      `${label}: a Business User (computers:view) gets no agent buttons in the header, and the card's Upgrade to full agent is disabled`, `header buttons ${offered}, card button ${await cardBtn.count()}`);
    await cleanCheck(page, `${label} Business User device header`);
    // 0.75: Tools for a Business User (computers:view only): no action can be
    // requested and the Security log is not theirs — shown, disabled, saying why.
    const st = await openTools(page, f.main.id);
    const notMine = [...ACTION_TOOLS, 'security-log'].filter((t) => st[t] !== 'not_permitted');
    check(notMine.length === 0 && st['test-connection'] === 'available' && st['patch-scan'] === 'available',
      `${label}: a Business User's Tools say Not permitted for every action and the Security log, and still offer the read-only ones`, notMine.join(', ') || JSON.stringify(st));
    check(await page.getByTestId('tool-restart-schedule').getAttribute('data-disabled') === 'true' && await page.getByTestId('tool-restart-schedule').locator('button').count() === 0,
      `${label}: a tool the Business User may not use has no button (it would 403)`);
    await closeTools(page);
    await cleanCheck(page, `${label} Business User Tools`);
    // 0.80: no View mobile devices — no nav entry, and the API refuses the list.
    const mr = await page.request.get(`${WEB}/api/v1/mobile-devices`, { headers: { 'x-forwarded-for': ip() } });
    check(mr.status() === 403 && await page.locator('a[href="/mobile-devices"]').count() === 0,
      `${label}: a Business User without View mobile devices has no Mobile devices link, and the API refuses the list (HTTP ${mr.status()})`);
  } finally { await ctx.close(); }
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

    // 0.35: the Business Owner's dashboard words the Linux computer's restart as Linux's.
    await go(page, '/dashboard');
    const dash = await page.locator('main').innerText();
    check(/Linux is waiting for a restart/.test(dash) && !/Windows is waiting for a restart/.test(dash), `${label}: the dashboard says "Linux is waiting for a restart" for the Linux computer`, dash.match(/.{0,80}waiting for a restart.{0,40}/)?.[0] ?? '(no restart line)');
    if (vp === 'desktop') await mapMarkersOwner(page, label);
    await go(page, '/reports/patch-compliance');
    check(await page.locator('[data-testid="schedule-report"]').isVisible(), `${label}: a Business Owner is offered "Schedule this report"`);
    await cleanCheck(page, `${label} owner dashboard and report`);
  } finally { await ctx.close(); }
}

// ── 0.87 Compass: the shell ─────────────────────────────────────────────────
// As Business A's owner, in a context of its own: the sidebar collapses and
// stays collapsed after a reload with the browser's copy cleared (so the
// server kept it), a collapsed group opens a flyout, Ctrl+K never shows
// Business B, a favourite made on a device page is in the header's menu and
// opens it, the profile menu offers System, and no app switcher is drawn.
// The owner's navigation rows are deleted at the end.
async function navShell(browser, f, vp, theme, label) {
  const ctx = await newContext(browser, vp, theme);
  try {
    const page = await signIn(ctx, f.owner.email, `${label} (owner, shell)`, theme);
    const sidebar = page.locator('aside [data-testid="sidebar"], [data-testid="sidebar"]').first();
    if (vp === 'desktop') {
      const toggle = page.locator('[data-testid="sidebar-toggle"]');
      check(await sidebar.getAttribute('data-collapsed') === 'false' && (await sidebar.boundingBox())?.width >= 220 && (await sidebar.boundingBox())?.width <= 240,
        `${label}: the sidebar starts expanded, 220–240 px`, JSON.stringify(await sidebar.boundingBox()));
      await toggle.click();
      await page.waitForFunction(() => document.querySelector('[data-testid="sidebar"]')?.getAttribute('data-collapsed') === 'true', null, { timeout: 5_000 }).catch(() => {});
      await page.waitForTimeout(400); // the width animates for 150 ms
      const w = (await sidebar.boundingBox())?.width ?? 0;
      check(w >= 56 && w <= 64 && await toggle.getAttribute('aria-pressed') === 'true', `${label}: the toggle collapses it to 56–64 px and says so`, String(w));
      for (let i = 0; i < 20; i++) { const r = await prisma.userNavPreference.findUnique({ where: { userId: f.owner.id } }); if (r?.sidebarCollapsed) break; await new Promise((x) => setTimeout(x, 250)); }
      check((await prisma.userNavPreference.findUnique({ where: { userId: f.owner.id } }))?.sidebarCollapsed === true, `${label}: the server keeps it`);
      await page.evaluate(() => { try { localStorage.removeItem('nav.prefs'); } catch { /* */ } });
      await page.reload();
      await settled(page);
      await page.waitForFunction(() => document.querySelector('[data-testid="sidebar"]')?.getAttribute('data-collapsed') === 'true', null, { timeout: 10_000 }).catch(() => {});
      check(await sidebar.getAttribute('data-collapsed') === 'true', `${label}: after a reload with the browser's copy cleared, it is still collapsed`);
      await page.locator('button[data-nav="devices"]').first().click();
      const fly = page.locator('[data-testid="nav-flyout-devices"]');
      await fly.waitFor({ timeout: 5_000 }).catch(() => {});
      check(await fly.isVisible() && await fly.locator('a[href="/endpoints"]').count() === 1, `${label}: a collapsed group opens a flyout with its pages`);
      await shot(page, `${label}-nav-collapsed-flyout`);
      await page.keyboard.press('Escape');
      await toggle.click();
      await page.waitForFunction(() => document.querySelector('[data-testid="sidebar"]')?.getAttribute('data-collapsed') === 'false', null, { timeout: 5_000 }).catch(() => {});
      check(await sidebar.getAttribute('data-collapsed') === 'false', `${label}: and expands again`);
      check(await page.locator('[data-testid="breadcrumbs"]').isVisible(), `${label}: the header shows breadcrumbs`);
    }

    // The palette: Business B is never offered to Business A's owner.
    await go(page, '/dashboard');
    const pal = page.locator('[data-testid="global-search"]');
    if (vp === 'desktop') await page.keyboard.press('Control+k');
    else await page.locator('[data-testid="global-search-trigger"]').click();
    await pal.waitFor({ timeout: 5_000 });
    const quick = await pal.locator('[data-group="quick"] [role="option"], [data-group="pages"] [role="option"]').count();
    check(quick > 0, `${label}: before anything is typed, the palette offers pages and quick actions`, String(quick));
    const answered = page.waitForResponse((r) => r.url().includes('/search?q=') && r.url().includes('BIRCH'), { timeout: 15_000 }).catch(() => null);
    await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': ip() });
    await page.locator('[data-testid="global-search-input"]').pressSequentially(`${TAG}-BIRCH`, { delay: 15 });
    const res = await answered;
    await page.waitForTimeout(400);
    const opts = await pal.locator('[role="option"]').allInnerTexts();
    check(res && res.status() === 200 && !opts.some((t) => /BIRCH|Birch/.test(t)), `${label}: searching for Business B's computer finds nothing of Business B`, opts.join(' | ').slice(0, 300));
    await page.locator('[data-testid="global-search-input"]').fill('');
    await page.locator('[data-testid="global-search-input"]').pressSequentially(`${TAG} Birch`, { delay: 15 });
    await page.waitForTimeout(1200);
    check(!(await pal.locator('[role="option"]').allInnerTexts()).some((t) => /Birch/.test(t)), `${label}: nor Business B itself`);
    await page.keyboard.press('Escape');

    // A favourite, from the device page to the header's menu and back.
    await go(page, `/endpoints/${f.main.id}`);
    const star = page.locator('[data-testid="record-favorite"]');
    await star.waitFor({ timeout: 15_000 });
    await page.waitForFunction(() => !document.querySelector('[data-testid="record-favorite"]')?.hasAttribute('disabled'), null, { timeout: 10_000 }).catch(() => {});
    if (await star.getAttribute('aria-pressed') !== 'true') await star.click();
    await page.waitForFunction(() => document.querySelector('[data-testid="record-favorite"]')?.getAttribute('aria-pressed') === 'true', null, { timeout: 10_000 }).catch(() => {});
    check(await star.getAttribute('aria-pressed') === 'true', `${label}: the star on a device page makes it a favourite`);
    check(await prisma.userNavItem.count({ where: { userId: f.owner.id, list: 'favorite', kind: 'device', ref: f.main.id } }) === 1, `${label}: kept on the server as a kind and an id`);
    await go(page, '/dashboard');
    await page.locator('[data-testid="favorites-trigger"]').click();
    const item = page.locator('[data-testid="favorite-item"]').filter({ hasText: `${TAG}-WS-01` });
    await item.first().waitFor({ timeout: 5_000 }).catch(() => {});
    check(await item.count() === 1, `${label}: it is in the header's favourites, named`);
    if (theme === 'light') await shot(page, `${label}-favorites`);
    await item.first().click();
    await page.waitForURL((u) => u.pathname === `/endpoints/${f.main.id}`, { timeout: 15_000 }).catch(() => {});
    check(new URL(page.url()).pathname === `/endpoints/${f.main.id}`, `${label}: and opens the device`, page.url());
    await settled(page);

    // The profile menu: theme with System, density and mode; no app switcher.
    await page.locator('[data-testid="profile-menu-trigger"]').click();
    const menu = page.locator('[data-testid="profile-menu"]');
    await menu.waitFor({ timeout: 5_000 }).catch(() => {});
    check(await menu.locator('[data-testid="theme-system"]').count() === 1 && await menu.locator('[data-testid="mode-advanced"]').count() === 1 && await menu.locator('[data-testid="density-compact"]').count() === 1,
      `${label}: the profile menu offers Light, Dark and System, density and mode`);
    check(!/Support Rem0te/.test(await menu.innerText().catch(() => '')), `${label}: a Business Owner is not offered "Support Rem0te" (staff only)`);
    await page.keyboard.press('Escape');
    check(await page.locator('[data-testid="app-switcher"]').count() === 0 && await page.locator('header a[href*="clientst0r" i], header a[href*="agit8or" i]').count() === 0,
      `${label}: standalone: no app switcher and no link to another product in the header`);
    check(await page.locator('[data-testid="skip-link"]').count() === 1 && await page.locator('main#main-content').count() === 1, `${label}: a skip link to the main content`);
    await workspaceModes(page, f, vp, label);
    await cleanCheck(page, `${label} shell`);
  } finally {
    await ctx.close();
    await prisma.userNavItem.deleteMany({ where: { userId: f.owner.id } });
    await prisma.userNavPreference.deleteMany({ where: { userId: f.owner.id } });
  }
}

/**
 * 0.90 (UX P1-4, directive §11): technician workspaces are a menu, never a
 * permission. L1 narrows the sidebar to its pages and reorders the device
 * page's tab groups; every other page is still in Ctrl+K and opens by URL.
 */
async function workspaceModes(page, f, vp, label) {
  const savedAs = async (w) => {
    for (let i = 0; i < 20; i++) { if ((await prisma.userNavPreference.findUnique({ where: { userId: f.owner.id } }))?.workspace === w) return true; await new Promise((x) => setTimeout(x, 250)); }
    return false;
  };
  await go(page, '/dashboard');
  await page.locator('[data-testid="profile-menu-trigger"]').click();
  const menu = page.locator('[data-testid="profile-menu"]');
  await menu.waitFor({ timeout: 5_000 }).catch(() => {});
  check(await menu.locator('[data-testid^="workspace-"][role="menuitemradio"]').count() === 4 && /changes the menu, not what you may do/.test(await menu.locator('[data-testid="workspace-note"]').innerText().catch(() => '')),
    `${label}: the profile menu offers four workspaces and says a workspace is not a permission`);
  await menu.locator('[data-testid="workspace-l1"]').click();
  check(await savedAs('l1'), `${label}: choosing L1 support is kept on the server`);
  await page.keyboard.press('Escape').catch(() => {});
  if (vp === 'desktop') {
    const side = page.locator('[data-testid="sidebar"]').first();
    await page.locator('[data-testid="nav-workspace"]').waitFor({ timeout: 5_000 }).catch(() => {});
    check(/L1 support/.test(await page.locator('[data-testid="nav-workspace"]').innerText().catch(() => '')), `${label}: the sidebar names the workspace at its foot`);
    check(await side.locator('[data-nav="patching"], [data-nav-item="/patching"]').count() === 0 && await side.locator('[data-nav="admin"], [data-nav-item="/settings"]').count() === 0,
      `${label}: in L1, Patching and Administration leave the sidebar`);
    // Devices has several L1 pages, so it is a group (closed on the dashboard); Monitoring has one, Alerts, so it is a link.
    check(await side.locator('[data-nav-item="/alerts"]').count() >= 1 && await side.locator('[data-nav="devices"]').count() >= 1,
      `${label}: and Alerts and the Devices group stay`);
  }
  // Not a permission: Ctrl+K still offers a page outside the workspace, and its URL opens.
  if (vp === 'desktop') await page.keyboard.press('Control+k');
  else await page.locator('[data-testid="global-search-trigger"]').click();
  const pal = page.locator('[data-testid="global-search"]');
  await pal.waitFor({ timeout: 5_000 }).catch(() => {});
  await page.locator('[data-testid="global-search-input"]').pressSequentially('Patch management', { delay: 15 });
  await page.waitForTimeout(600);
  check((await pal.locator('[data-group="pages"] [role="option"]').allInnerTexts()).some((t) => /Patch management/.test(t)), `${label}: in L1, Ctrl+K still offers Patch management`);
  await page.keyboard.press('Escape');
  await go(page, '/patching');
  check(new URL(page.url()).pathname === '/patching' && !/not allowed|forbidden/i.test(await page.locator('main').innerText().catch(() => '')), `${label}: and /patching opens as before`, page.url());
  // The device page: L1 puts Health and Tools before Software and System.
  await go(page, `/endpoints/${f.main.id}`);
  await page.locator('[data-testid="workspace-groups"] [data-tabs]').first().waitFor({ timeout: 15_000 }).catch(() => {});
  const order = await page.locator('[data-testid="workspace-groups"] [data-tabs]').evaluateAll((els) => els.map((e) => e.getAttribute('data-tabs') ?? ''));
  const at = (tab) => order.findIndex((t) => t.split(' ').includes(tab));
  check(at('overview') === 0 && at('diagnostics') > -1 && at('diagnostics') < at('processes') && at('monitoring') < at('software'),
    `${label}: in L1 the device page shows Health and Tools before Software and System, every group still there`, order.join(' | '));
  // Back to every page.
  if (vp === 'desktop') {
    await page.locator('[data-testid="nav-workspace-all"]').click();
  } else {
    await page.locator('[data-testid="profile-menu-trigger"]').click();
    await page.locator('[data-testid="profile-menu"] [data-testid="workspace-all"]').click();
    await page.keyboard.press('Escape').catch(() => {});
  }
  check(await savedAs('all'), `${label}: "All pages" is kept on the server`);
  if (vp === 'desktop') {
    await page.locator('[data-testid="nav-workspace"]').waitFor({ state: 'detached', timeout: 5_000 }).catch(() => {});
    check(await page.locator('[data-testid="nav-workspace"]').count() === 0 && await page.locator('[data-testid="sidebar"] [data-nav="patching"], [data-testid="sidebar"] [data-nav-item="/patching"]').count() >= 1,
      `${label}: "Show every page" brings Patching back and drops the workspace line`);
  }
  await go(page, `/endpoints/${f.main.id}`);
  await page.locator('[data-testid="workspace-groups"] [data-tabs]').first().waitFor({ timeout: 15_000 }).catch(() => {});
  const back = await page.locator('[data-testid="workspace-groups"] [data-tabs]').evaluateAll((els) => els.map((e) => e.getAttribute('data-tabs') ?? ''));
  const atB = (tab) => back.findIndex((t) => t.split(' ').includes(tab));
  check(atB('software') < atB('diagnostics'), `${label}: and the device page's own order returns`, back.join(' | '));
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
    if (vp === 'phone') await drawerContrast(page, f, label);
    await devicesAndWorkspace(page, f, vp, label);
    await devicePageGroups(page, f, vp, label);
    await filtersSheet(page, vp, label);
    await deviceListP13(page, f, vp, label);
    await agentSilentUi(page, f, label);
    await alertExplanation(page, f, vp, label);
    await falsePositiveUi(page, f, vp, label);
    if (vp === 'desktop') await mapMarkers(page, label);
    await savedViewAndBulk(page, f, vp, label);
    await palette(page, f, vp, label);
    await addDevice(page, f, vp, label);
    await reports(page, label, vp);
    await scheduleLinks(page, f, label);
    await systemStatus(page, label, vp);
    await serverSecurity(page, label, vp);
    await coverage035(page, f, vp, label);
    await fullAgentPage(page, f, vp, theme, label);
    await msaReadinessUi(page, f, vp, theme, label);
    await remoteStatesUi(page, f, vp, label);
    await headerAgentUpgrade(page, f, vp, theme, label);
    await toolsPanel(page, f, vp, theme, label);
    await rollbackDisplays(page, f, vp, theme, label);
    await diagnosticsPaletteUi(page, f, vp, theme, label);
    await terminalPanel(page, f, vp, theme, label);
    await filesPanel(page, f, vp, theme, label);
    await mobileDevicesUi(page, f, vp, theme, label);
    await backupsUi(page, f, vp, theme, label);
    await backupSettingsUi(page, f, vp, theme, label);
    await mdmSettingsUi(page, f, vp, theme, label);
    if (theme === 'light') await mainPagesSweep(page, f, vp, label);
  } finally { await ctx.close(); }
  await navShell(browser, f, vp, theme, label);
  await mobileRequiresSetup(browser, f, vp, theme, label);
  await apiKeys(browser, f, vp, theme, label);
  if (theme === 'light') await memberChecks(browser, f, vp, theme, label);
  await dashboardFit(browser, f, vp, theme, label);
  if (vp === 'desktop') {
    await dashboardBanner(browser, f, theme, label);
    await accentPages(browser, f, theme, label);
  }
}

// ── 0.35: the 0.34 screens, driven ──────────────────────────────────────────
// Everything in this section was typechecked and built in 0.34 but never
// driven in a browser. Each screen gets its own function; seed035() adds
// their fixtures and cleanup035() removes what it added outside the two
// businesses (which cascade).

const sha256 = (b) => createHash('sha256').update(b).digest('hex');

/** The loopback SMTP sink the Email settings page is pointed at. */
const smtp = createSmtpSink();

/**
 * A reference ClientSt0r peer that serves only its signed capabilities
 * document, advertising ticket triage and NOT device_timeline_v1: the state
 * the History tab's AI summary has to describe until ClientSt0r ships it.
 * The request and response signatures are the integration's own
 * (dist/integration/crypto.js); everything else answers 404.
 */
const peer = (() => {
  const C = apiRequire(path.join(API_DIR, 'dist/integration/crypto.js'));
  const dir = mkdtempSync(path.join(tmpdir(), 'rem0te-ui-peer-'));
  const self = generateKeyPairSync('ed25519'), req = generateKeyPairSync('ed25519'), del = generateKeyPairSync('ed25519');
  const ID = 'clientst0r-ui', AUD = 'clientst0r:ui', ORIGIN = `http://127.0.0.1:${PEER_PORT}`;
  const pem = (k) => k.export({ type: 'spki', format: 'pem' }).toString();
  writeFileSync(path.join(dir, 'self.pem'), self.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const file = path.join(dir, 'peers.json');
  writeFileSync(file, JSON.stringify({
    self: { keyId: 'rem0te-ui-1', privateKeyFile: path.join(dir, 'self.pem') },
    peers: [{
      id: ID, audience: 'rem0te:ui', peerAudience: AUD,
      requestKeys: [{ kid: 'req-1', publicKeyPem: pem(req.publicKey) }], delegationKeys: [{ kid: 'del-1', publicKeyPem: pem(del.publicKey) }],
      inferenceUrl: `${ORIGIN}/api/integration/v1/inference`, eventsUrl: `${ORIGIN}/api/integration/v1/events`,
      capabilitiesUrl: `${ORIGIN}/api/integration/v1/capabilities`, modelProfiles: ['triage-fast', 'summary-fast'],
    }],
  }));
  const state = { capsRequests: 0, badSignatures: 0, other: 0 };
  const server = createServer((rq, res) => {
    const chunks = []; rq.on('data', (d) => chunks.push(d));
    rq.on('end', () => {
      const body = Buffer.concat(chunks);
      const signed = rq.headers['rem0te-key-id'] === 'rem0te/rem0te-ui-1' && C.verifyEd25519(self.publicKey, C.requestSigningString({
        audience: AUD, method: rq.method, pathWithQuery: rq.url, timestamp: rq.headers['rem0te-timestamp'], nonce: rq.headers['rem0te-nonce'], bodySha256: C.sha256Hex(body),
      }), rq.headers['rem0te-signature']);
      if (!signed) { state.badSignatures++; res.writeHead(401).end(); return; }
      if (rq.method !== 'GET' || rq.url !== '/api/integration/v1/capabilities') { state.other++; res.writeHead(404).end(); return; }
      state.capsRequests++;
      const text = JSON.stringify({ contract: 'ticket-rmm-v1', peer_id: ID, inference_tasks: [{ task: 'ticket_triage_v1', model_profiles: ['triage-fast'] }], clientst0r_version: 'reference' });
      const sig = C.signEd25519(req.privateKey, C.responseSigningString(rq.headers['rem0te-nonce'], C.sha256Hex(Buffer.from(text))));
      res.writeHead(200, { 'content-type': 'application/json', 'rem0te-key-id': `${ID}/req-1`, 'rem0te-response-signature': sig }).end(text);
    });
  });
  return { ID, dir, file, server, state };
})();

/** Requests from the simulated computer straight to the suite's API, paced under the burst throttler. */
async function deviceReq(method, p, { body } = {}) {
  await sleep(60);
  const r = await fetch(`${API_ORIGIN}/api/v1${p}`, { method, headers: { 'content-type': 'application/json', 'x-forwarded-for': ip() }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j, data: j?.data };
}
const device = chatDevice(deviceReq);

const smtpBefore = { row: undefined };
const relayBefore = { row: undefined };
async function seed035(f) {
  const { tenant, A, admin, owner, main } = f;
  // A signed Windows agent that speaks chat protocol 1, bound to a device secret.
  const chat = await prisma.endpoint.create({ data: {
    tenantId: tenant.id, customerId: A.id, name: `${TAG}-CHAT`, hostname: `${TAG.toLowerCase()}-chat.corp.example.com`, platform: 'Windows', osVersion: 'Windows 11 Pro',
    status: 'ACTIVE', isOnline: true, isManaged: true, accessMode: 'COMPANY_WIDE', lastSeenAt: new Date(), deviceClass: 'WORKSTATION',
    updateChannel: 'signed', chatProtocol: 1, agentVersion: '0.34.0',
  } });
  const rid = String(100000000 + ((Math.random() * 899999999) | 0));
  const secret = randomBytes(24).toString('hex');
  await prisma.rustdeskNode.create({ data: { tenantId: tenant.id, endpointId: chat.id, rustdeskId: rid, agentSecretHash: sha256(secret) } });

  // Two approved scripts in Acme's library: one never proposed, one whose
  // allowlist entry the portal last mirrored as ACTIVE. The suite runs no
  // approval signer, so the Run panel has to say so for both.
  const { hashVersion } = apiRequire(path.join(API_DIR, 'dist/script-library/definition.js'));
  const mkScript = async (name, content) => {
    const sc = await prisma.script.create({ data: { scope: 'BUSINESS', tenantId: tenant.id, customerId: A.id, name, createdById: owner.id } });
    const def = { language: 'powershell', targetOs: 'windows', risk: 'low', parameters: [], content };
    let v = await prisma.scriptVersion.create({ data: { scriptId: sc.id, version: 1, description: `${name}: a read-only report for the UI suite.`, ...def, ...hashVersion(def), authorId: owner.id, contributorIds: [owner.id] } });
    v = await prisma.scriptVersion.update({ where: { id: v.id }, data: { status: 'IN_REVIEW', submittedAt: new Date() } });
    v = await prisma.scriptVersion.update({ where: { id: v.id }, data: { status: 'APPROVED', decidedById: admin.id, decidedAt: new Date(), decisionNote: 'Reads only.', approvedSha256: v.contentSha256 } });
    return { script: sc, version: v };
  };
  const unproposed = await mkScript(`${TAG} Spooler status`, "Get-Service -Name 'Spooler' | Select-Object Name, Status\n");
  const listed = await mkScript(`${TAG} Disk report`, "Get-PSDrive -PSProvider FileSystem | Select-Object Name, Used, Free\n");
  const entryId = randomBytes(16).toString('hex');
  await prisma.scriptAllowlistEntry.create({ data: { id: entryId, scriptVersionId: listed.version.id, customerId: A.id, contentSha256: listed.version.contentSha256, status: 'ACTIVE', approvalUrl: `${WEB}/approve/script/${entryId}`, proposedById: admin.id } });

  // A confirmed address in Acme, for a scheduled report to go to.
  const recipient = await prisma.emailRecipient.create({ data: { scopeKey: `b:${A.id}`, customerId: A.id, address: `ui-reports-${sfx}@test.invalid`, label: 'UI suite', verifiedAt: new Date(), addedById: owner.id } });
  // Acme is mapped to the reference ClientSt0r peer.
  await prisma.integrationOrgMapping.create({ data: { peerId: peer.ID, externalOrgId: `org-ui-${sfx}`, customerId: A.id, tenantId: tenant.id, createdById: 'e2e-ui' } });
  // A migration to the signed agent requested for the main computer, so the status page has a row.
  await prisma.agentMigration.create({ data: { endpointId: main.id, tenantId: tenant.id, customerId: A.id, nonce: `mig_${randomBytes(30).toString('base64url')}`, reason: `${TAG} pilot machine`, requestedById: admin.id } });
  // 0.37: a standard Windows agent in Birch with a device secret and an old
  // agent (so "Agent out of date"), for the header's Upgrade to full agent.
  // In B so that A's rule-group members and counts are unchanged.
  const upg = await prisma.endpoint.create({ data: {
    tenantId: tenant.id, customerId: f.B.id, name: `${TAG}-UPGRADE`, hostname: `${TAG.toLowerCase()}-upgrade.corp.example.com`, platform: 'Windows', osVersion: 'Windows 11 Pro',
    status: 'ACTIVE', isOnline: true, isManaged: true, accessMode: 'COMPANY_WIDE', lastSeenAt: new Date(), deviceClass: 'WORKSTATION', agentVersion: '0.19.0', ipAddress: '10.20.0.9',
  } });
  await prisma.rustdeskNode.create({ data: { tenantId: tenant.id, endpointId: upg.id, rustdeskId: String(100000000 + ((Math.random() * 899999999) | 0)), agentSecretHash: sha256(randomBytes(24).toString('hex')) } });
  // 0.66: an event alert as DS-HOME1's was after reclassification — the
  // known-harmless shadow-copy event, one of two counted events unseen — on a
  // computer of its own in Birch, under a monitor on that computer only.
  const cl = apiRequire(path.join(API_DIR, 'dist/monitoring/classify.js'));
  const eng = apiRequire(path.join(API_DIR, 'dist/monitoring/engine.js'));
  const ds = await prisma.endpoint.create({ data: {
    tenantId: tenant.id, customerId: f.B.id, name: `${TAG}-DSHOME1`, hostname: `${TAG.toLowerCase()}-dshome1.corp.example.com`, platform: 'Windows', osVersion: 'Windows 11 Pro',
    status: 'ACTIVE', isOnline: true, isManaged: true, accessMode: 'COMPANY_WIDE', lastSeenAt: new Date(), deviceClass: 'WORKSTATION',
  } });
  const diskRule = await prisma.monitorRule.create({ data: { scopeKey: `e:${ds.id}`, customerId: f.B.id, endpointId: ds.id, key: 'disk-errors', kind: 'EVENT_MATCH', name: 'Disk errors in the System log', severity: 'CRITICAL', params: eng.DISK_ERRORS_PARAMS, createdById: admin.id } });
  const sample = { eventId: 11, level: 4, provider: 'Microsoft-Windows-Kernel-General', message: 'TxR init phase for hive \\??\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy59\\Windows\\System32\\config\\DRIVERS (TM: {00000000-0000-4000-8000-0000000000a5}, RM: {00000000-0000-4000-8000-0000000000a4}) finished with result=0xC00000A2 (Internal code=7).' };
  const decision = cl.classifyEvents({ severity: 'CRITICAL', params: eng.DISK_ERRORS_PARAMS }, { count: 2, samples: [sample] });
  const dsAlert = await prisma.monitorAlert.create({ data: {
    tenantId: tenant.id, customerId: f.B.id, endpointId: ds.id, ruleId: diskRule.id, ruleKey: 'disk-errors', kind: 'EVENT_MATCH', dedupKey: `disk-errors:${ds.id}`,
    severity: decision.severity, title: `${TAG}-DSHOME1: 2 matching events in System`, detail: { log: 'System', count: 2, sample, samples: [sample], newestAt: new Date().toISOString(), threshold: 1 },
    classification: decision, classifierVersion: decision.v, fingerprint: decision.fingerprint,
    events: { create: [{ type: 'raised', detail: { rule: 'disk-errors' } }, { type: 'reclassified', detail: { from: 'CRITICAL', to: 'WARNING', class: 'UNKNOWN', basis: 'partial' } }] },
  } });
  // The migration script needs an address to name: with no https public
  // address here (PUBLIC_API_URL is this suite's http web), the relay host.
  const tset = await prisma.tenantSettings.findFirst({ orderBy: { createdAt: 'asc' } });
  if (tset && !tset.rustdeskRelayHost) { relayBefore.row = { id: tset.id, value: tset.rustdeskRelayHost }; await prisma.tenantSettings.update({ where: { id: tset.id }, data: { rustdeskRelayHost: 'relay.example.com' } }); }
  // The outbound-email singleton is global: remember it to put it back.
  smtpBefore.row = await prisma.smtpSettings.findUnique({ where: { id: 'singleton' } });
  return { chat: { id: chat.id, rid, secret, hostname: chat.hostname, platform: 'Windows' }, unproposed, listed, recipient, upg, dsAlert };
}

async function cleanup035() {
  const ids = created.businesses;
  const steps = [
    ['integration mappings', () => prisma.integrationOrgMapping.deleteMany({ where: { customerId: { in: ids } } })],
    ['report schedules', () => prisma.reportSchedule.deleteMany({ where: { customerId: { in: ids } } })],
    ['relay host', async () => {
      if (!relayBefore.row) return;
      await prisma.tenantSettings.update({ where: { id: relayBefore.row.id }, data: { rustdeskRelayHost: relayBefore.row.value } });
      relayBefore.row = undefined;
    }],
    ['smtp settings', async () => {
      if (smtpBefore.row === undefined) return;
      if (smtpBefore.row === null) await prisma.smtpSettings.deleteMany({ where: { id: 'singleton' } });
      else { const { id, updatedAt, ...rest } = smtpBefore.row; await prisma.smtpSettings.update({ where: { id }, data: rest }); }
      smtpBefore.row = undefined;
    }],
  ];
  for (const [what, fn] of steps) {
    try { await fn(); } catch (e) { console.error(`  cleanup (${what}): ${e.message.split('\n').filter(Boolean).pop()}`); }
  }
}

/**
 * A step-up lasts ten minutes (the step_up cookie), so an earlier flow in the
 * same session would let a later one through unasked. Each flow that must be
 * asked forgets it first.
 */
async function forgetStepUp(page) {
  await page.context().clearCookies({ name: 'step_up' });
}
/** The step-up dialog must appear; fill it with the password and confirm. */
async function confirmStepUp(page, label, what) {
  const dlg = stepUpDialog(page);
  await dlg.waitFor({ timeout: 10_000 }).catch(() => {});
  check(await dlg.isVisible(), `${label}: ${what} asks to confirm it's you`);
  await dlg.locator('#stepup-value').fill(PW);
  await dlg.getByRole('button', { name: 'Confirm' }).click();
  await dlg.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {});
}

/**
 * Chat (0.34): start one, send a message, and watch its receipt move only as
 * the simulated computer acknowledges it over the real device routes; the
 * person's reply appears; ending it files it under Earlier chats.
 */
async function chatTab(page, f, vp, label) {
  const ep = f.c.chat;
  await go(page, `/endpoints/${ep.id}?tab=chat`);
  if (!(await page.locator('[data-testid="chat-tab"]').isVisible().catch(() => false))) {
    await openTab(page, 'chat');
    await page.locator('[data-testid="chat-tab"]').waitFor({ timeout: 15_000 });
  }
  await settled(page);
  check(!(await page.locator('[data-testid="chat-unsupported"]').isVisible()) && await page.locator('[data-testid="chat-start"]').isVisible(), `${label}: a signed agent with chat offers Start chat`);
  await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': ip() });
  await page.locator('[data-testid="chat-start"]').click();
  const presence = page.locator('[data-testid="chat-presence"]');
  await presence.waitFor({ timeout: 15_000 }).catch(() => {});
  check(await presence.getAttribute('data-presence').catch(() => null) === 'waiting_for_checkin', `${label}: a new chat waits for the computer's check-in, and says so`, await presence.innerText().catch(() => ''));
  const conv = await prisma.chatConversation.findFirst({ where: { endpointId: ep.id, status: 'OPEN' } });
  const text = `${TAG} ${label}: is the printer on?`;
  await page.locator('[data-testid="chat-input"]').fill(text);
  await page.locator('[data-testid="chat-send"]').click();
  const receipt = page.locator('[data-testid="chat-message"]').filter({ hasText: text }).locator('[data-testid="chat-receipt"]');
  await receipt.waitFor({ timeout: 15_000 }).catch(() => {});
  check(await receipt.getAttribute('data-receipt').catch(() => null) === 'sent' && /not yet confirmed/.test(await receipt.innerText().catch(() => '')), `${label}: sent, and "not yet confirmed by the computer" until it is`, await receipt.innerText().catch(() => ''));
  if (vp === 'phone') await noSideScroll(page, `${label} chat`);

  // The computer: picks it up, opens the window, shows it, reads it.
  let r = await device.poll(ep, { state: 'connecting', noWait: true });
  const mine = r.data?.messages?.find((m) => m.text === text);
  check(r.status === 200 && r.data?.conversation?.id === conv?.id && !!mine, `${label}: the simulated computer's poll is handed the conversation and the message`, `HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
  const want = async (state, presenceCode) => {
    await page.waitForFunction(([t, s]) => [...document.querySelectorAll('[data-testid="chat-message"]')].some((m) => m.textContent.includes(t) && m.querySelector(`[data-receipt="${s}"]`)), [text, state], { timeout: 15_000 }).catch(() => {});
    if (presenceCode) await page.waitForFunction((c) => document.querySelector('[data-testid="chat-presence"]')?.getAttribute('data-presence') === c, presenceCode, { timeout: 15_000 }).catch(() => {});
    return { receipt: await receipt.getAttribute('data-receipt').catch(() => null), presence: await presence.getAttribute('data-presence').catch(() => null) };
  };
  await device.poll(ep, { state: 'no_user', delivered: [mine?.id], noWait: true });
  let s1 = await want('delivered', 'no_user');
  check(s1.receipt === 'delivered' && s1.presence === 'no_user', `${label}: acknowledged by the computer → "Delivered to the agent"; nobody signed in is said as such`, JSON.stringify(s1));
  await device.poll(ep, { state: 'window_open', userName: 'ACME\\frontdesk', shown: [mine?.id], noWait: true });
  s1 = await want('shown', 'window_open');
  const ptxt = await presence.innerText().catch(() => '');
  check(s1.receipt === 'shown' && s1.presence === 'window_open' && ptxt.includes('ACME\\frontdesk'), `${label}: the window opened for ACME\\frontdesk and drew it → "Shown on screen"`, `${JSON.stringify(s1)} ${ptxt}`);
  await device.poll(ep, { read: [mine?.id], noWait: true });
  s1 = await want('read');
  check(s1.receipt === 'read', `${label}: in front of the person → "Read"`, JSON.stringify(s1));
  const answer = `${TAG} yes, it is on <b>now</b>`;
  r = await device.reply(ep, conv?.id, answer);
  const reply = page.locator('[data-testid="chat-message"]').filter({ hasText: answer });
  await reply.waitFor({ timeout: 15_000 }).catch(() => {});
  check(r.status === 200 && await reply.isVisible() && /\(at the device\)/.test(await reply.innerText().catch(() => '')) && await reply.locator('b').count() === 0,
    `${label}: the person's reply appears, signed from the computer, as text (no HTML)`, `HTTP ${r.status} ${await reply.innerText().catch(() => '')}`);
  await shot(page, `${label}-chat`);
  await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': ip() });
  await page.locator('[data-testid="chat-end"]').click();
  await page.locator('[data-testid="chat-start"]').waitFor({ timeout: 15_000 }).catch(() => {});
  const ended = await prisma.chatConversation.findUnique({ where: { id: conv?.id ?? '' } });
  check(ended?.status === 'ENDED' && await page.locator('[data-testid="chat-past"]').count() >= 1, `${label}: End chat ends it and files it under Earlier chats`, ended?.status);
  await cleanCheck(page, `${label} Chat tab`);
}

/**
 * The Run panel on an approved version (0.34). This suite runs no approval
 * signer, so whatever the allowlist says, the panel must say a script cannot
 * be run here and offer no control that pretends otherwise.
 */
async function scriptRunPanel(page, f, vp, label) {
  for (const [which, sc] of [['never proposed', f.c.unproposed], ['mirrored as on the allowlist', f.c.listed]]) {
    await go(page, `/automation/scripts/${sc.script.id}`);
    const panel = page.locator('[data-script-run-panel]');
    await panel.waitFor({ timeout: 15_000 }).catch(() => {});
    const t = await panel.innerText().catch(() => '');
    const buttons = await panel.locator('button').evaluateAll((els) => els.map((e) => (e.textContent ?? '').trim()));
    check(/No approval signer is configured on this server, so scripts cannot be run here/.test(t) && /Not yet run on a real Windows computer/.test(t),
      `${label}: Run panel (${which}) says no approval signer is configured and that it has not run on real Windows`, t.slice(0, 300));
    if (sc === f.c.unproposed) {
      check(/Not proposed yet/.test(t) && !buttons.some((b) => /Propose|Request a run/.test(b)), `${label}: never proposed: "Not proposed yet", and no Propose or Request a run without a signer`, buttons.join(' | '));
    } else {
      check(/On the signer's allowlist/.test(t) && !buttons.some((b) => /Request a run|Revoke/.test(b)), `${label}: on the allowlist but no signer: the entry is shown, and neither Request a run nor Revoke is offered`, buttons.join(' | '));
    }
    if (vp === 'phone') await noSideScroll(page, `${label} script page`);
    await cleanCheck(page, `${label} Run panel (${which})`);
  }
  await shot(page, `${label}-script-run`);
}

let swSeq = 0;
/** Software catalog (0.34): add an entry through step-up, then find it in the compliance report. */
async function softwareCatalog(page, f, vp, label) {
  await go(page, '/automation/software');
  await page.getByRole('button', { name: 'Add software' }).click();
  const n = ++swSeq;
  const pkg = `UiE2e.Tool${sfx}${n}`, name = `${TAG} Tool ${n}`;
  await page.locator('#se-pkg').fill(pkg);
  await page.locator('#se-version').fill('1.2.3');
  await page.locator('#se-name').fill(name);
  if (await page.locator('#se-scope').count()) await page.locator('#se-scope').selectOption('business');
  if (await page.locator('#se-biz').count()) await page.locator('#se-biz').selectOption(f.A.id);
  await page.getByRole('radio', { name: 'Paste it myself' }).check();
  await page.locator('#se-sha').fill(sha256(`${pkg}-installer`));
  await page.locator('#det-version').fill('1.2.3');
  await page.locator('#det-name').fill('UI Tool');
  if (vp === 'phone') await noSideScroll(page, `${label} Add software`);
  await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': ip() });
  await forgetStepUp(page);
  await page.getByRole('button', { name: 'Add to the catalog' }).click();
  await confirmStepUp(page, label, 'adding to the software catalog');
  await page.waitForURL((u) => /^\/automation\/software\/[^/]+$/.test(u.pathname) && !u.pathname.endsWith('/deployments'), { timeout: 15_000 }).catch(() => {});
  await settled(page);
  await page.locator('main').getByText(name).first().waitFor({ timeout: 15_000 }).catch(() => {});
  const row = await prisma.softwareCatalogEntry.findFirst({ where: { customerId: f.A.id, packageId: pkg } });
  check(!!row && row.hashSource === 'ADMIN_PASTED' && new URL(page.url()).pathname === `/automation/software/${row.id}` && (await page.locator('main').innerText()).includes(name),
    `${label}: confirming adds the entry, pinned to the pasted hash, and opens it`, `${page.url()} row=${JSON.stringify(row && { id: row.id, src: row.hashSource })} main="${(await page.locator('main').innerText()).slice(0, 200)}"`);
  if (vp === 'phone') await noSideScroll(page, `${label} catalog entry`);
  await cleanCheck(page, `${label} Software catalog`, stepUp403);

  await go(page, `/reports/software-compliance?businessId=${f.A.id}`);
  await page.locator('main table').first().waitFor({ timeout: 15_000 }).catch(() => {});
  const txt = await page.locator('main').innerText();
  check(txt.includes(name) && /Unknown is a coverage gap/.test(txt) && !/could not be loaded|not available to you/i.test(txt), `${label}: the software compliance report lists the new entry`, txt.slice(0, 300));
  if (vp === 'phone') await noSideScroll(page, `${label} software compliance`);
  await shot(page, `${label}-software-compliance`);
  await cleanCheck(page, `${label} Software compliance report`);
}

/** Email settings (0.34): save a loopback relay through step-up, and send a test email that the sink receives. */
async function emailSettings(page, f, vp, label) {
  await go(page, '/settings/email');
  await page.locator('[data-testid="smtp-settings"]').waitFor({ timeout: 15_000 });
  const allowed = await page.locator('[data-testid="smtp-settings"]').innerText();
  check(/a relay on this server \(SMTP_ALLOW_LOCAL_RELAY=loopback\)/.test(allowed), `${label}: Email says which relays this server allows (loopback here)`, allowed.slice(0, 200));
  const enabled = page.locator('[data-testid="smtp-settings"] label').filter({ hasText: 'Send email' }).locator('input[type=checkbox]');
  if (!(await enabled.isChecked())) await enabled.check();
  await page.locator('#smtp-host').fill('127.0.0.1');
  await page.locator('#smtp-port').fill(String(SMTP_PORT));
  await page.locator('#smtp-tls').selectOption('none');
  await page.locator('#smtp-from').fill(`ui-${sfx}@test.invalid`);
  await page.locator('#smtp-from-name').fill(`${TAG} rem0te`);
  if (vp === 'phone') await noSideScroll(page, `${label} Email`);
  await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': ip() });
  await forgetStepUp(page);
  await page.getByRole('button', { name: 'Save (re-authenticate)' }).click();
  await confirmStepUp(page, label, 'saving the relay');
  await page.getByText('Email settings saved.').waitFor({ timeout: 15_000 }).catch(() => {});
  const row = await prisma.smtpSettings.findUnique({ where: { id: 'singleton' } });
  check(row?.enabled === true && row.host === '127.0.0.1' && row.port === SMTP_PORT && row.tlsMode === 'none' && await page.getByText('Email settings saved.').isVisible(),
    `${label}: saving through step-up stores the relay and says so`, JSON.stringify(row && { enabled: row.enabled, host: row.host, port: row.port, tls: row.tlsMode }));
  const shown = { host: await page.locator('#smtp-host').inputValue(), port: await page.locator('#smtp-port').inputValue(), tls: await page.locator('#smtp-tls').inputValue(), on: await enabled.isChecked() };
  check(shown.host === '127.0.0.1' && shown.port === String(SMTP_PORT) && shown.tls === 'none' && shown.on, `${label}: after saving, the form shows the relay that was saved`, JSON.stringify(shown));
  const before = smtp.sink.messages.length;
  await page.locator('[data-testid="smtp-test"]').waitFor({ timeout: 10_000 });
  await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': ip() });
  await page.getByRole('button', { name: 'Send test email' }).click();
  // The page names the address masked (u…@test.invalid); the sink proves which one.
  const sent = page.getByText(/^Test email sent to .+@test\.invalid\.$/);
  await sent.waitFor({ timeout: 20_000 }).catch(() => {});
  const mail = await smtp.waitMail((m) => smtp.sink.messages.indexOf(m) >= before && m.to.includes(f.admin.email), 10_000);
  check(await sent.isVisible() && !!mail && mail.from === `ui-${sfx}@test.invalid`, `${label}: Send test email reaches the loopback relay, and the page says it was sent`, `${mail ? `${mail.from} → ${mail.to} "${mail.subject}"` : `no mail (${smtp.sink.messages.length} in the sink)`} page: ${(await page.locator('main').innerText()).split('\n').filter((l) => /test email/i.test(l)).join(' / ')}`);
  await shot(page, `${label}-email`);
  await cleanCheck(page, `${label} Email settings`, stepUp403);
}

/** Scheduled reports (0.34): create one for Acme, to its confirmed address, through step-up. */
async function scheduledReports(page, f, vp, label) {
  await go(page, '/reports/schedules');
  await page.locator('#sched-business').selectOption(f.A.id);
  const form = page.locator('[data-testid="report-schedule-form"]');
  await form.waitFor({ timeout: 15_000 });
  await form.locator('label').filter({ hasText: f.c.recipient.address }).locator('input[type=checkbox]').check();
  await form.locator('#sf-time').fill('07:30');
  await form.locator('#sf-tz').fill('Europe/London');
  if (vp === 'phone') await noSideScroll(page, `${label} Scheduled reports`);
  const before = await prisma.reportSchedule.count({ where: { customerId: f.A.id } });
  await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': ip() });
  await forgetStepUp(page);
  await form.getByRole('button', { name: 'Create (re-authenticate)' }).click();
  await confirmStepUp(page, label, 'creating a scheduled report');
  await page.getByText('Schedule created.').waitFor({ timeout: 15_000 }).catch(() => {});
  const rows = await prisma.reportSchedule.findMany({ where: { customerId: f.A.id }, orderBy: { createdAt: 'desc' } });
  const s = rows[0];
  check(rows.length === before + 1 && s.time === '07:30' && s.timeZone === 'Europe/London' && s.recipientIds.includes(f.c.recipient.id) && s.ownerId === f.admin.id && !!s.nextRunAt,
    `${label}: creating stores one schedule to the confirmed address, with its next run`, JSON.stringify(s && { time: s.time, tz: s.timeZone, next: s.nextRunAt }));
  await page.locator('[data-testid="report-schedules"]').getByText(/07:30/).first().waitFor({ timeout: 10_000 }).catch(() => {});
  check(await page.getByText('Schedule created.').isVisible() && (await page.locator('[data-testid="report-schedules"]').innerText()).includes('07:30'), `${label}: the page says so and lists it`);
  await shot(page, `${label}-schedules`);
  await cleanCheck(page, `${label} Scheduled reports`, stepUp403);
}

/** The Agent card on Overview (0.34) and Agent migrations, reached from its link and from the Devices tab (0.35). */
async function agentCardAndMigrations(page, f, vp, label) {
  await go(page, `/endpoints/${f.main.id}`);
  const card = page.locator('[data-testid="agent-card"]');
  await card.waitFor({ timeout: 15_000 });
  await page.waitForFunction(() => !/Loading…/.test(document.querySelector('[data-testid="agent-card"]')?.textContent ?? 'Loading…'), null, { timeout: 15_000 }).catch(() => {});
  const t = await card.innerText();
  check(/Standard \(Windows\)/.test(t) && t.includes('0.33.0') && /pilot machine/.test(t) && !/could not be loaded/.test(t), `${label}: the Agent card shows the agent, its version and the open migration request`, t.slice(0, 400));
  check(await card.getByTestId('agent-migration').isVisible(), `${label}: and the move to the signed agent: offered, or why not`);
  if (vp === 'phone') await noSideScroll(page, `${label} Agent card`);
  await card.getByRole('link', { name: 'Agent migrations' }).click();
  await page.waitForURL((u) => u.pathname === '/endpoints/agent-migrations', { timeout: 15_000 });
  await hydrated(page); await settled(page);
  const table = page.locator('[data-testid="migration-table"]');
  await table.waitFor({ timeout: 15_000 }).catch(() => {});
  const row = table.locator('tr').filter({ hasText: `${TAG}-WS-01` });
  const counts = await page.locator('[data-testid="migration-counts"]').innerText().catch(() => '');
  check(await row.count() === 1 && /Pending/.test(await row.innerText()) && /Pending: [1-9]/.test(counts), `${label}: Agent migrations lists the request as Pending, and counts it`, counts);
  const current = await page.locator('[data-section-tabs="devices"] a[aria-current="page"]').innerText().catch(() => null);
  check(current === 'Agent migrations', `${label}: Agent migrations is the current Devices tab`, String(current));
  if (vp === 'phone') await noSideScroll(page, `${label} Agent migrations`);
  await shot(page, `${label}-agent-migrations`);
  await cleanCheck(page, `${label} Agent card and migrations`);
}

/**
 * Devices → Full agent (0.37), as the Platform Admin, at both widths and in
 * both themes: reached from the Agent card's link; four steps with their
 * live state — this suite's API has no signed repository, so step 1 is not
 * done and shows the setup command verbatim; step 3 says the portal cannot
 * see the timer; the automatic migration says this API's sweep is off
 * (AUTO_MIGRATION_SWEEP=off) and offers its controls; the honest note; the
 * Devices tab is current; and no sideways scroll at 375 px.
 */
async function fullAgentPage(page, f, vp, theme, label) {
  await go(page, `/endpoints/${f.main.id}`);
  const card = page.locator('[data-testid="agent-card"]');
  await card.waitFor({ timeout: 15_000 });
  await card.getByTestId('agent-card-full-agent').click();
  await page.waitForURL((u) => u.pathname === '/endpoints/full-agent', { timeout: 15_000 });
  await hydrated(page); await settled(page);
  await page.locator('[data-testid="full-agent-steps"]').waitFor({ timeout: 15_000 }).catch(() => {});
  const h1 = await page.locator('main h1').first().innerText().catch(() => '');
  const states = await page.locator('[data-testid^="full-agent-step-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-state')));
  check(h1 === 'Full agent' && states.length === 4 && states[0] === 'todo', `${label}: Full agent opens from the Agent card with four steps; step 1 not done here`, JSON.stringify({ h1, states }));
  const s1 = await page.getByTestId('full-agent-step-1').innerText().catch(() => '');
  check(s1.includes('sudo ./deploy/release/rem0te-signed-setup.sh') && /The easy way/.test(s1), `${label}: step 1 shows the setup command verbatim and links "The easy way"`, s1.slice(0, 300));
  const s3 = await page.getByTestId('full-agent-step-3').innerText().catch(() => '');
  check(s3.includes('rem0te-timestamp-refresh.timer') && s3.includes('sudo rem0te-signed-status') && /cannot see that timer/.test(s3), `${label}: step 3 names the timer and the status command and says the portal cannot see the timer`, s3.slice(0, 300));
  const auto = page.getByTestId('full-agent-auto');
  const at = await auto.innerText().catch(() => '');
  check(await auto.getAttribute('data-gate') === 'process_off' && /AUTO_MIGRATION_SWEEP=off/.test(at) && await page.getByTestId('full-agent-turn-off').isVisible(),
    `${label}: the automatic migration says this API's sweep is off, and the Platform Admin can turn it off`, at.slice(0, 300));
  check(/have not yet run on real Windows/.test(await page.getByTestId('full-agent-honest').innerText().catch(() => '')), `${label}: the honest note: nothing has run on real Windows yet`);
  const current = await page.locator('[data-section-tabs="devices"] a[aria-current="page"]').innerText().catch(() => null);
  check(current === 'Full agent', `${label}: Full agent is the current Devices tab`, String(current));
  await themeCheck(page, theme, `${label} Full agent`);
  if (vp === 'phone') await noSideScroll(page, `${label} Full agent`);
  await shot(page, `${label}-full-agent`);
  await cleanCheck(page, `${label} Full agent`);
}

// ── 0.69: Managed Secure Access readiness ──────────────────────────────────
// A third business of its own, so no other screen's counts move: one signed
// 0.69 computer whose stored preflight is a lab-tested RustDesk with every
// read answered (Compatible). Its name carries no TAG, so the device list,
// the palette and the map never meet it.
async function seedMsa(f) {
  const C = await prisma.customer.create({ data: { tenantId: f.tenant.id, name: `RDY ${sfx} Readiness` } });
  created.businesses.push(C.id);
  const ready = await prisma.endpoint.create({ data: {
    tenantId: f.tenant.id, customerId: C.id, name: `RDY-${sfx}-READY`, hostname: `rdy-${sfx}.corp.example.com`, platform: 'Windows', osVersion: 'Windows 11 Pro',
    status: 'ACTIVE', isOnline: true, isManaged: true, accessMode: 'COMPANY_WIDE', lastSeenAt: new Date(), deviceClass: 'WORKSTATION',
    updateChannel: 'signed', signedSeenAt: new Date(), agentVersion: '0.69.0', ipAddress: '10.20.0.9',
  } });
  const keys = Object.fromEntries(['access-mode', 'enable-keyboard', 'enable-clipboard', 'enable-file-transfer', 'enable-audio', 'enable-tunnel',
    'enable-remote-restart', 'approve-mode', 'verification-method', 'allow-auto-disconnect', 'auto-disconnect-timeout'].map((k) => [k, 'ok']));
  await prisma.rustdeskPreflight.create({ data: {
    endpointId: ready.id, checkedAt: new Date(Date.now() - 3600_000), schema: 'rem0te-rustdesk-preflight/1', installed: true, expectedPath: true,
    version: '1.4.7+65', build: 'flutter', service: 'running', cli: 'ok', keys, keysOk: 11, durationMs: 1300, agentVersion: '0.69.0',
  } });
  return { C, ready };
}

/**
 * Remote access readiness (0.69), as the Platform Admin, at both widths and
 * in both themes: the device card on a Compatible computer and on the main
 * (standard agent, Unsupported) one, each leading with "Readiness only";
 * its link to Devices → Remote access readiness; the counts; filtering by a
 * count (wait for the rows the click must produce: settled() only covers the
 * first load); the Devices tab is current; no sideways scroll at 375 px.
 */
async function msaReadinessUi(page, f, vp, theme, label) {
  const NOTE = 'Readiness only — Managed Secure Access is not available yet; nothing has changed on this device.';
  const cardState = async () => {
    const card = page.getByTestId('msa-readiness-card');
    await card.waitFor({ timeout: 15_000 });
    await page.getByTestId('msa-card-state').waitFor({ timeout: 15_000 }).catch(() => {});
    return { card, state: await page.getByTestId('msa-card-state').getAttribute('data-state').catch(() => null), text: await card.innerText().catch(() => '') };
  };
  await go(page, `/endpoints/${f.msa.ready.id}`);
  let c = await cardState();
  check(c.state === 'compatible' && c.text.includes(NOTE) && /lab-tested release/.test(c.text) && /11 of 11 answered/.test(c.text) && /1\.4\.7\+65/.test(c.text) && /not managed now/.test(c.text),
    `${label}: the device card says Readiness only first, then Compatible with its reasons and facts`, c.text.slice(0, 500));
  if (vp === 'phone') await noSideScroll(page, `${label} readiness card`);
  await shot(page, `${label}-msa-card`);
  await go(page, `/endpoints/${f.main.id}`);
  c = await cardState();
  check(c.state === 'unsupported' && c.text.includes(NOTE) && /standard agent/.test(c.text), `${label}: a standard-agent computer reads Unsupported, with the same note`, c.text.slice(0, 300));
  await c.card.getByTestId('msa-card-fleet-link').click();
  await page.waitForURL((u) => u.pathname === '/endpoints/remote-readiness', { timeout: 15_000 });
  await hydrated(page); await settled(page);
  await page.getByTestId('msa-fleet-counts').waitFor({ timeout: 15_000 }).catch(() => {});
  const h1 = await page.locator('main h1').first().innerText().catch(() => '');
  const note = await page.getByTestId('msa-fleet-note').innerText().catch(() => '');
  const compat = Number((await page.getByTestId('msa-count-compatible').innerText().catch(() => '0')).split('\n')[0]);
  check(h1 === 'Remote access readiness' && /nothing has changed on any device/.test(note) && compat >= 1 && await page.locator('[data-testid^="msa-count-"]').count() === 4,
    `${label}: Remote access readiness opens from the card: the note, four counts, Compatible ≥ 1`, JSON.stringify({ h1, note, compat }));
  await page.getByTestId('msa-count-compatible').click();
  await page.waitForFunction(() => {
    const rows = [...document.querySelectorAll('[data-testid="msa-fleet-rows"] li')];
    return rows.length > 0 && rows.every((r) => r.getAttribute('data-state') === 'compatible');
  }, null, { timeout: 15_000 }).catch(() => {});
  const rows = await page.locator('[data-testid="msa-fleet-rows"] li').evaluateAll((els) => els.map((e) => ({ s: e.getAttribute('data-state'), t: e.textContent ?? '' })));
  check(rows.length >= 1 && rows.every((r) => r.s === 'compatible') && rows.some((r) => r.t.includes(`RDY-${sfx}-READY`)) && await page.getByTestId('msa-count-compatible').getAttribute('aria-pressed') === 'true',
    `${label}: clicking Compatible lists only compatible computers, ours among them`, JSON.stringify(rows.slice(0, 5)));
  await page.getByTestId('msa-filter-clear').click();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="msa-fleet-rows"] li')].some((r) => r.getAttribute('data-state') !== 'compatible'), null, { timeout: 15_000 }).catch(() => {});
  const states = await page.locator('[data-testid="msa-fleet-rows"] li').evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute('data-state')))]);
  check(states.includes('unsupported') && states.every((s) => ['unsupported', 'upgrade_available', 'compatible', 'unknown'].includes(s)), `${label}: Show all brings the rest back, and no computer is managed`, JSON.stringify(states));
  const current = await page.locator('[data-section-tabs="remote"] a[aria-current="page"]').innerText().catch(() => null);
  check(current === 'Remote access readiness', `${label}: Remote access readiness is the current Remote support tab (0.87)`, String(current));
  await themeCheck(page, theme, `${label} Remote access readiness`);
  if (vp === 'phone') await noSideScroll(page, `${label} Remote access readiness`);
  await shot(page, `${label}-remote-readiness`);
  await cleanCheck(page, `${label} Remote access readiness`);

  // 0.73: Devices → Managed sessions with MSA_GRANTS off says so and asks no
  // gated route (the final msaGated check covers every request it made).
  await go(page, '/endpoints/managed-sessions');
  await page.getByTestId('msa-sessions-off').waitFor({ timeout: 15_000 }).catch(() => {});
  const off = await page.getByTestId('msa-sessions-off').innerText().catch(() => '');
  check(/not switched on on this server/.test(off) && await page.getByTestId('msa-cutover-runs').count() === 0,
    `${label}: Managed sessions says Managed Secure Access is off, and no cutover-run controls are drawn`, off.slice(0, 200));
  const cur = await page.locator('[data-section-tabs="remote"] a[aria-current="page"]').innerText().catch(() => null);
  check(cur === 'Managed sessions', `${label}: Managed sessions is the current Remote support tab (0.87)`, String(cur));
  if (vp === 'phone') await noSideScroll(page, `${label} Managed sessions`);
  await cleanCheck(page, `${label} Managed sessions`);
}

/**
 * 0.91 (UX P1-5, directive §12): the eight remote-support states. Three
 * sessions on the main device, each with only the evidence its stage needs:
 * the agent seeing it now (Session active), RustDesk opened (Client opened)
 * and the technician's own word (confirmed, never active). Then the device's
 * Managed Secure Access card lists its twelve items, with Enabled "No" while
 * the switch is off.
 */
async function remoteStatesUi(page, f, vp, label) {
  const base = { tenantId: f.tenant.id, customerId: f.A.id, endpointId: f.main.id, technicianId: f.admin.id, launchRequestedAt: new Date(Date.now() - 5 * 60_000) };
  const rows = await Promise.all([
    prisma.supportSession.create({ data: { ...base, status: 'SESSION_STARTED', statusSource: 'endpoint_agent', clientOpenedAt: new Date(Date.now() - 4 * 60_000), connectionConfirmedAt: new Date(Date.now() - 3 * 60_000), lastSignalAt: new Date() } }),
    prisma.supportSession.create({ data: { ...base, status: 'CLIENT_OPENED', statusSource: 'connect_script', clientOpenedAt: new Date(Date.now() - 60_000), lastSignalAt: new Date() } }),
    prisma.supportSession.create({ data: { ...base, status: 'SESSION_STARTED', statusSource: 'technician', connectionConfirmedAt: new Date(), lastSignalAt: new Date() } }),
  ]);
  try {
    await go(page, '/sessions');
    await page.locator('[data-testid="session-stage"]').first().waitFor({ timeout: 15_000 }).catch(() => {});
    const tab = await page.getByRole('tab').first().innerText().catch(() => '');
    check(/Open now/.test(tab) && !/^Connected/.test(tab), `${label}: the Sessions tab is "Open now", not "Connected"`, tab);
    const stages = await page.locator('[data-testid="session-stage"]').evaluateAll((els) => els.map((e) => ({ s: e.getAttribute('data-stage'), t: (e.getAttribute('title') ?? '') })));
    const has = (st) => stages.find((x) => x.s === st);
    check(!!has('active') && /agent saw the connection/.test(has('active').t), `${label}: the agent's recent signal reads "Session active", and says the agent saw it`, JSON.stringify(stages.slice(0, 6)));
    check(!!has('client_opened') && /not confirmed|has not confirmed/.test(has('client_opened').t), `${label}: RustDesk opening reads "Client opened", not a connection`);
    check(stages.some((x) => x.s === 'connection_confirmed' && /You reported/.test(x.t)), `${label}: the technician's own word is "confirmed by you", never "Session active"`);
    const labels = await page.locator('[data-testid="session-stage"]').allInnerTexts();
    check(labels.some((t) => /Session active/.test(t)) && labels.some((t) => /Client opened/.test(t)) && labels.some((t) => /Connection confirmed by you/.test(t)), `${label}: each badge names its stage`, labels.slice(0, 6).join(' | '));
    if (vp === 'phone') await noSideScroll(page, `${label} sessions (0.91)`);
    await shot(page, `${label}-remote-states`);
    await go(page, '/dashboard');
    const dash = await page.locator('main').innerText().catch(() => '');
    check(!/connected now/.test(dash), `${label}: the dashboard no longer says "connected now"`);
    // Managed Secure Access, item by item (switch off in this suite).
    await go(page, `/endpoints/${f.msa.ready.id}`);
    const facts = page.getByTestId('msa-facts');
    await facts.waitFor({ timeout: 15_000 }).catch(() => {});
    await facts.locator('summary').click().catch(() => {});
    const items = await facts.locator('[data-fact]').evaluateAll((els) => els.map((e) => [e.getAttribute('data-fact'), e.getAttribute('data-answer')]));
    const k = Object.fromEntries(items);
    check(items.length === 12 && k.enabled === 'no' && k.credential === 'no' && k.revocation === 'no' && k.support === 'yes',
      `${label}: the Managed Secure Access card lists the twelve items; with the switch off Enabled, credential and revocation are "No"`, JSON.stringify(items));
    check(/not switched on/i.test(await facts.locator('[data-fact="enabled"]').innerText().catch(() => '')), `${label}: and says the switch is off`);
    await cleanCheck(page, `${label} remote states (0.91)`);
  } finally {
    await prisma.supportSession.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
  }
}

// ── 0.81: Backups ───────────────────────────────────────────────────────────
// A business of its own with a St0r connection row (the hash of a token
// nobody holds) and one asset on its computer: a job that succeeded with its
// integrity check passed and no restore drill, and a simulated drill that
// passed. The page must show three separate facts and never "verified".
async function seedBackups(f) {
  const E = await prisma.customer.create({ data: { tenantId: f.tenant.id, name: `BKP ${sfx} Backups` } });
  created.businesses.push(E.id);
  const ep = await prisma.endpoint.create({ data: {
    tenantId: f.tenant.id, customerId: E.id, name: `BKP-${sfx}-FS`, hostname: `bkp-${sfx}.corp.example.com`, platform: 'Windows',
    status: 'ACTIVE', isOnline: true, isManaged: true, accessMode: 'COMPANY_WIDE', lastSeenAt: new Date(),
  } });
  const conn = await prisma.backupConnection.create({ data: {
    id: `bkc${randomBytes(12).toString('hex')}`, customerId: E.id, kind: 'st0r', transport: 'push', enabled: true,
    pushTokenHash: createHash('sha256').update(randomBytes(32)).digest('hex'), pushTokenLast4: 'ab12', lastSyncAt: new Date(), lastResult: 'OK', createdById: f.admin.id,
  } });
  const now = Date.now();
  const asset = await prisma.backupProtectedAsset.create({ data: { customerId: E.id, connectionId: conn.id, externalId: 'fs-c', name: `BKP ${sfx} FS C: volume`, assetType: 'server', endpointId: ep.id, firstSeenAt: new Date(now - 30 * 86_400_000), lastSeenAt: new Date() } });
  const job = await prisma.backupJob.create({ data: { customerId: E.id, assetId: asset.id, externalId: 'j1', startedAt: new Date(now - 3 * 3_600_000), finishedAt: new Date(now - 2 * 3_600_000), completion: 'succeeded', integrity: 'passed' } });
  const pt = await prisma.backupRecoveryPoint.create({ data: { customerId: E.id, assetId: asset.id, externalId: 'p1', pointAt: new Date(now - 2 * 3_600_000), location: 'offsite', jobId: job.id } });
  await prisma.restoreDrill.create({ data: { customerId: E.id, assetId: asset.id, externalId: 'd1', recoveryPointId: pt.id, recoveryPointAt: pt.pointAt, target: 'isolated_vm', scope: 'full_image', result: 'passed', simulated: true, validation: 'boot', startedAt: new Date(now - 3_600_000), finishedAt: new Date(now - 1_800_000), elapsedSeconds: 1500 } });
  return { E, ep, asset };
}

/**
 * Backups (0.81), as the Platform Admin, at both widths and in both themes:
 * Acme (no provider) reads "Requires setup"; the backups business shows its
 * asset with completion, integrity and restore test apart, "Simulated only
 * (not verified)", the providers' limitations; no sideways scroll at 375 px.
 */
async function backupsUi(page, f, vp, theme, label) {
  await go(page, '/backups');
  const sel = page.getByTestId('backups-business');
  await sel.waitFor({ timeout: 15_000 });
  await page.waitForFunction((id) => !!document.querySelector(`[data-testid="backups-business"] option[value="${id}"]`), f.backups.E.id, { timeout: 15_000 }).catch(() => {});
  await sel.selectOption(f.A.id);
  await page.getByTestId('backups-needs').waitFor({ timeout: 15_000 }).catch(() => {});
  const needs = await page.getByTestId('backups-needs').getAttribute('data-state').catch(() => null);
  const needsText = await page.getByTestId('backups-needs').innerText().catch(() => '');
  check(needs === 'requires_setup' && /No backup provider is connected/.test(needsText), `${label}: a business with no provider reads "Requires setup" and says what is needed`, `${needs} ${needsText.slice(0, 200)}`);
  await sel.selectOption(f.backups.E.id);
  const cell = page.locator(`[data-asset="${f.backups.asset.id}"]`);
  await cell.waitFor({ timeout: 15_000 }).catch(() => {});
  const row = cell.locator('xpath=ancestor::tr');
  const attr = async (a) => row.locator(`[data-${a}]`).first().getAttribute(`data-${a}`).catch(() => null);
  const facts = { backup: await attr('backup'), completion: await attr('completion'), integrity: await attr('integrity'), restore: await attr('restore'), drill: await attr('drill') };
  const text = await row.innerText().catch(() => '');
  check(facts.backup === 'ok' && facts.completion === 'succeeded' && facts.integrity === 'passed' && facts.restore === 'not_tested' && facts.drill === 'simulated_only' && /Simulated only \(not verified\)/.test(text) && !/\bVerified\b/.test(text),
    `${label}: succeeded, integrity passed, restore not tested, simulated only — never "Verified"`, JSON.stringify({ facts, text: text.slice(0, 300) }));
  const prov = await page.getByTestId('backups-providers').innerText().catch(() => '');
  check(/St0r/.test(prov) && /Comet/.test(prov) && await page.getByTestId('backups-connections').count() === 1 && await page.getByTestId('backups-settings-link').count() === 1,
    `${label}: providers, and (Platform Admin) connections pointing to Settings → Backups`, prov.slice(0, 200));
  // 0.82: the link-to-computer control opens, lists the business's computers and the two choices, and is cancelled (nothing saved).
  await row.getByTestId('backups-link-open').click().catch(() => {});
  const linkSel = row.getByTestId('backups-link-select');
  await linkSel.waitFor({ timeout: 10_000 }).catch(() => {});
  await page.waitForFunction((id) => !!document.querySelector(`[data-testid="backups-link-select"] option[value="${id}"]`), f.backups.ep.id, { timeout: 10_000 }).catch(() => {});
  const linkOpts = await linkSel.locator('option').allInnerTexts().catch(() => []);
  check(linkOpts.some((o) => o.includes(`BKP-${sfx}-FS`)) && linkOpts.some((o) => /Not a device/.test(o)) && linkOpts.some((o) => /Automatic/.test(o)), `${label}: "Link to computer" offers the business's computers, "not a computer" and automatic`, JSON.stringify(linkOpts));
  if (vp === 'phone') await noSideScroll(page, `${label} Backups link control`);
  await row.getByRole('button', { name: 'Cancel' }).click().catch(() => {});
  await themeCheck(page, theme, `${label} Backups`);
  if (vp === 'phone') await noSideScroll(page, `${label} Backups`);
  await shot(page, `${label}-backups`);
  await cleanCheck(page, `${label} Backups`);
}

/**
 * Settings → Backups (0.82), as the Platform Admin, at both widths and in both
 * themes, read-only (nothing is created, rotated or revoked here): the steps
 * with the push address from the public address and a masked curl example,
 * the connection with its asset count and last result, the capabilities in
 * the four states (Comet planned, failover unsupported); no sideways scroll
 * at 375 px.
 */
async function backupSettingsUi(page, f, vp, theme, label) {
  await go(page, '/settings/backups');
  const sel = page.getByTestId('backup-settings-business');
  await sel.waitFor({ timeout: 15_000 }).catch(() => {});
  await page.waitForFunction((id) => !!document.querySelector(`[data-testid="backup-settings-business"] option[value="${id}"]`), f.backups.E.id, { timeout: 15_000 }).catch(() => {});
  await sel.selectOption(f.backups.E.id).catch(() => {});
  await page.getByTestId('backup-settings-steps').waitFor({ timeout: 15_000 }).catch(() => {});
  const url = await page.getByTestId('backup-push-url').innerText().catch(() => '');
  const curl = await page.getByTestId('backup-curl').innerText().catch(() => '');
  check(/\/api\/v1\/backups\/push$/.test(url.trim()) && /\?dryRun=1/.test(curl) && /Authorization: Bearer rbk_bkc[0-9a-f]+_•+ab12/.test(curl) && !/[0-9a-f]{64}/.test(curl),
    `${label}: Settings → Backups gives the push address and a curl example with the token masked`, `${url} | ${curl.slice(0, 200)}`);
  const steps = await page.getByTestId('backup-settings-steps').innerText().catch(() => '');
  check(/Create the St0r connection/.test(steps) && /Send a test push \(dry run\)/.test(steps) && /Token ends in/.test(steps) && /St0r push contract/.test(steps), `${label}: the five steps, the token's last four, and the contract`, steps.slice(0, 300));
  const conn = page.getByTestId('backup-connection').first();
  const connText = await conn.innerText().catch(() => '');
  check(/1 \(1 linked to a device\)/.test(connText) && await page.getByTestId('backup-rotate').count() === 1 && await page.getByTestId('backup-revoke').count() === 1,
    `${label}: the connection shows its assets, and Rotate and Revoke`, connText.slice(0, 300));
  const states = await page.locator('[data-testid="backup-settings-capabilities"] [data-capability]').evaluateAll((els) => els.map((e) => [e.getAttribute('data-capability'), e.getAttribute('data-state')]));
  const st = Object.fromEntries(states);
  check(st['st0r.push'] === 'available' && st.comet === 'planned' && st.failover === 'unsupported' && states.every(([, v]) => ['available', 'requires_setup', 'unsupported', 'planned'].includes(v)),
    `${label}: capabilities in the four states (push available, Comet planned, failover unsupported)`, JSON.stringify(st));
  check(await page.getByTestId('backup-settings-comet').count() === 1, `${label}: Comet shown as planned, with what it needs`);
  await themeCheck(page, theme, `${label} Settings → Backups`);
  if (vp === 'phone') await noSideScroll(page, `${label} Settings → Backups`);
  await shot(page, `${label}-settings-backups`);
  await cleanCheck(page, `${label} Settings → Backups`);
}

// ── 0.75: the device page's Tools panel ────────────────────────────────────
// A business of its own (no TAG in the names, so the list, palette and map
// never meet them): a signed Windows agent reporting every catalog action, a
// standard Windows agent, the read-only Linux and macOS agents, each with a
// device secret and checking in now, and an offline standard one. 0.76: the
// signed agent reports 0.76.0, so it carries the read-only palette; the
// standard and offline ones report 0.73.0 and must say they need a newer one.
async function seedTools(f) {
  const D = await prisma.customer.create({ data: { tenantId: f.tenant.id, name: `TLS ${sfx} Tools` } });
  created.businesses.push(D.id);
  const ACTIONS = ['windows.service.start@1', 'windows.update.install@1', 'windows.service.restart@1', 'windows.reboot.schedule@1', 'windows.reboot.cancel@1',
    'windows.logs.collect@1', 'windows.script.run@1', 'windows.software.install@1', 'windows.software.uninstall@1', 'windows.software.remove@1',
    'windows.service.control@1', 'windows.process.stop@1'];
  const mk = async (suffix, extra) => {
    const e = await prisma.endpoint.create({ data: {
      tenantId: f.tenant.id, customerId: D.id, name: `TLS-${sfx}-${suffix}`, hostname: `tls-${sfx}-${suffix.toLowerCase()}.corp.example.com`, platform: 'Windows', osVersion: 'Windows 11 Pro',
      status: 'ACTIVE', isOnline: true, isManaged: true, accessMode: 'COMPANY_WIDE', lastSeenAt: new Date(), deviceClass: 'WORKSTATION', agentVersion: '0.73.0', ...extra,
    } });
    await prisma.rustdeskNode.create({ data: { tenantId: f.tenant.id, endpointId: e.id, rustdeskId: String(100000000 + ((Math.random() * 899999999) | 0)), agentSecretHash: sha256(randomBytes(24).toString('hex')) } });
    return e;
  };
  return {
    D,
    // 0.78.0: the first signed agent that transfers files (0.77.0 ran the first terminal).
    signed: await mk('SIGNED', { updateChannel: 'signed', signedSeenAt: new Date(), agentActions: ACTIONS, agentVersion: '0.78.0' }),
    standard: await mk('STANDARD', {}),
    linux: await mk('LINUX', { platform: 'Linux', osVersion: 'Ubuntu 24.04', agentVersion: '0.33.0' }),
    mac: await mk('MAC', { platform: 'macOS', osVersion: 'macOS 15.1', agentVersion: '0.33.0' }),
    offline: await mk('OFFLINE', { isOnline: false, lastSeenAt: new Date(Date.now() - 3 * 86400_000) }),
  };
}

/**
 * 0.79: one finished software-install plan over three of the Tools
 * computers — succeeded on the signed one, failed on the standard one,
 * refused on the offline one — so the signed computer's Actions tab has a
 * partial job to show. Final (FAILED), so nothing asks a signer about it;
 * it goes with the business.
 */
async function seedRollbackJob(f) {
  const T = f.tools;
  const now = Date.now();
  const id = `uiact${sfx}`.replace(/[^A-Za-z0-9]/g, '').slice(0, 24);
  await prisma.actionJob.create({ data: {
    id, tenantId: f.tenant.id, customerId: T.D.id, endpointId: T.signed.id, actionId: 'windows.software.install', actionVersion: 1, params: {},
    reason: 'UI check: a plan over three computers', origin: 'technician', via: 'portal', requestedById: f.admin.id,
    status: 'FAILED', risk: 'high', approvalsRequired: 2, customerSignoff: false,
    notBefore: new Date(now - 3_600_000), notAfter: new Date(now + 3_600_000), plan: {}, digest: 'a'.repeat(64), approvalUrl: '',
    dispatchedAt: new Date(now - 3_000_000), outcome: 'failed', resultAt: new Date(now - 2_000_000),
    targets: { create: [
      { endpointId: T.signed.id, status: 'SUCCEEDED', outcome: 'succeeded', result: { detail: 'installed' }, resultAt: new Date(now - 2_500_000) },
      { endpointId: T.standard.id, status: 'FAILED', outcome: 'failed', result: { reason: 'install_failed' }, resultAt: new Date(now - 2_400_000) },
      { endpointId: T.offline.id, status: 'REFUSED_BY_ENDPOINT', statusReason: 'expired', resultAt: new Date(now - 2_000_000) },
    ] },
  } });
  return id;
}

/**
 * 0.79 (§89): rollback and repeatability, where an action is offered and
 * where a job is shown. The Tools panel: every action tool carries its
 * action's note, the restart's names the cancel and says not safe to
 * repeat. The Actions tab (no signer here): the per-action notes stay
 * readable, and the three-computer job shows its own note and a Partial
 * tally from the signed computer, whose own row succeeded while the plan
 * failed. Every width and theme, no sideways scroll, no console error.
 */
async function rollbackDisplays(page, f, vp, theme, label) {
  const ep = f.tools.signed;
  await go(page, `/endpoints/${ep.id}`);
  await openTools(page, ep.id);
  const notes = Object.fromEntries(await page.getByTestId('tools-panel').locator('li[data-testid^="tool-"]').evaluateAll((els) => els.map((e) => {
    const n = e.querySelector('[data-testid="tool-note"]');
    return [e.getAttribute('data-testid').replace(/^tool-/, ''), n ? { rollback: n.getAttribute('data-rollback'), repeat: n.getAttribute('data-repeat'), text: n.textContent } : null];
  })));
  const missing = ACTION_TOOLS.filter((t) => !notes[t]);
  check(missing.length === 0, `${label}: every action tool in Tools says how it is undone and whether it is safe to repeat`, missing.join(', '));
  const extra = Object.entries(notes).filter(([t, n]) => n && !ACTION_TOOLS.includes(t)).map(([t]) => t);
  check(extra.length === 0, `${label}: no other tool claims a rollback note`, extra.join(', '));
  const r = notes['restart-schedule'];
  check(r?.rollback === 'inverse' && r?.repeat === 'unsafe' && /Can be undone: Cancel a scheduled restart · Not safe to repeat/.test(r?.text ?? ''),
    `${label}: Tools: a restart is undone by the cancel and is not safe to repeat`, JSON.stringify(r));
  check(notes['logs-collect']?.rollback === 'read_only' && notes['logs-collect']?.repeat === 'safe' && notes['run-script']?.repeat === 'unsafe' && notes['process-stop']?.rollback === 'none',
    `${label}: Tools: logs are read-only, a script is not safe to repeat, an ended process has no undo`, JSON.stringify([notes['logs-collect'], notes['run-script'], notes['process-stop']]));
  await closeTools(page);

  await go(page, `/endpoints/${ep.id}?tab=actions`);
  const box = page.getByTestId('action-notes-unconfigured');
  await box.waitFor({ timeout: 15_000 });
  await box.locator('summary').click();
  const actionNotes = await box.getByTestId('action-note').evaluateAll((els) => els.map((e) => ({ rollback: e.getAttribute('data-rollback'), repeat: e.getAttribute('data-repeat'), text: e.textContent })));
  check(actionNotes.length === 5 && actionNotes.every((n) => n.rollback && n.repeat && /Safe to repeat\.|Not safe to repeat\./.test(n.text)),
    `${label}: with no signer, the Actions tab still says how each of its five actions is undone and whether it is safe to repeat`, JSON.stringify(actionNotes.map((n) => [n.rollback, n.repeat])));
  check(actionNotes.some((n) => n.repeat === 'unsafe' && /Cancel a scheduled restart/.test(n.text)), `${label}: Actions: the restart's note names the cancel and says not safe to repeat`);
  const job = page.getByTestId('job-note').first();
  await job.waitFor({ timeout: 15_000 });
  const jn = { rollback: await job.getAttribute('data-rollback'), repeat: await job.getAttribute('data-repeat'), text: await job.innerText() };
  check(jn.rollback === 'inverse' && jn.repeat === 'safe' && /Uninstall/.test(jn.text), `${label}: a job shows its action's rollback and repeatability`, JSON.stringify(jn));
  const tally = page.getByTestId('job-tally').first();
  const tt = await tally.innerText();
  check(await tally.getAttribute('data-partial') === 'true' && /Partial/.test(tt) && /Of 3 devices: 1 succeeded, 1 failed, 1 refused by the device\./.test(tt),
    `${label}: a plan over three computers shows Partial and how each stands, from the computer that succeeded`, tt);
  if (vp === 'phone') {
    const w = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, vw: innerWidth }));
    check(w.scroll <= w.vw + 1, `${label}: the Actions tab with notes and a tally fits 375 px with no sideways scroll`, JSON.stringify(w));
  }
  await themeCheck(page, theme, `${label} Actions tab notes`);
  await cleanCheck(page, `${label} rollback and repeat displays`);
}

/**
 * The Terminal tab (0.77) on the signed computer, as the Platform Admin: the
 * SYSTEM warning, opening with a reason (and the confirmation when it asks),
 * the waiting state with both clocks, End session; on the standard computer
 * it says what is needed. No agent runs here, so the shell never starts:
 * e2e-terminal.mjs drives the agent's worker. Every width and theme, no
 * sideways scroll, no console error.
 */
async function terminalPanel(page, f, vp, theme, label) {
  const ep = f.tools.signed;
  await prisma.terminalSession.deleteMany({ where: { endpointId: ep.id } });
  await go(page, `/endpoints/${ep.id}?tab=terminal`);
  await page.getByTestId('terminal-tab').waitFor({ timeout: 15_000 });
  const warn = await page.getByTestId('terminal-identity').innerText();
  check(/SYSTEM — full control of this device/.test(warn), `${label}: the Terminal tab says SYSTEM — full control of this computer`, warn.slice(0, 200));
  await page.getByTestId('terminal-reason').fill(`UI check ${vp} ${theme}`);
  await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': ip() });
  await page.getByTestId('terminal-open-button').click();
  const dlg = stepUpDialog(page);
  const asked = await dlg.waitFor({ timeout: 4_000 }).then(() => true).catch(() => false);
  if (asked) {
    check(/open a terminal/.test(await dlg.innerText()), `${label}: opening a terminal asks to confirm it's you, and says why`, await dlg.innerText().catch(() => ''));
    await dlg.locator('#stepup-value').fill(PW);
    await dlg.getByRole('button', { name: 'Confirm' }).click();
    await dlg.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {});
  }
  const live = page.getByTestId('terminal-live');
  await page.locator('[data-testid="terminal-live"][data-state="pending"]').waitFor({ timeout: 15_000 }).catch(() => {});
  const row = await prisma.terminalSession.findFirst({ where: { endpointId: ep.id }, orderBy: { createdAt: 'desc' } });
  check(await live.getAttribute('data-state') === 'pending' && row?.state === 'pending' && row.technicianId === f.admin.id,
    `${label}: the terminal opens and waits for the computer`, `${await live.getAttribute('data-state').catch(() => null)} ${row?.state}`);
  const idle = await page.getByTestId('terminal-idle').innerText().catch(() => '');
  const total = await page.getByTestId('terminal-total').innerText().catch(() => '');
  check(/^1[45]:\d\d$/.test(idle) && /^(59|60):\d\d$/.test(total), `${label}: both clocks are shown (idle ${idle}, total ${total})`);
  check(/next check-in/.test(await page.getByTestId('terminal-state').innerText()), `${label}: the waiting state says it starts at the next check-in`);
  // 0.93 (UX P1-7): the target, the server's hard limit as a clock time, the session's reference and audit link.
  const target = await live.getByTestId('tool-target').innerText().catch(() => '');
  check(target.includes(String(ep.name ?? '')) && /Customer/.test(target) && /Runs as SYSTEM/.test(target), `${label}: the terminal names its device, customer and SYSTEM`, target);
  const dl = await page.getByTestId('terminal-deadline').innerText().catch(() => '');
  check(/Hard limit: ends at \d\d:\d\d \(in (59|60) min\)/.test(dl) || /in 1 h 00 min/.test(dl), `${label}: the hard limit is the server's own time`, dl);
  const ref = live.getByTestId('op-ref').first();
  const auditLink = await ref.getByTestId('op-audit').getAttribute('href').catch(() => null);
  check(await ref.getAttribute('data-ref') === row?.id && auditLink === `/audit?resource=terminal_session&resourceId=${row?.id}`, `${label}: the session shows its reference and links to its own audit rows`, `${auditLink}`);
  await themeCheck(page, theme, `${label} Terminal tab`);
  if (vp === 'phone') await noSideScroll(page, `${label} Terminal tab`);
  await shot(page, `${label}-terminal`);
  await page.getByTestId('terminal-end').click();
  await page.locator('[data-testid="terminal-live"][data-state="ended"]').waitFor({ timeout: 10_000 }).catch(() => {});
  const ended = await prisma.terminalSession.findUnique({ where: { id: row?.id ?? '' } });
  check(ended?.state === 'ended' && ended.endReason === 'closed', `${label}: End session closes it`, `${ended?.state} ${ended?.endReason}`);
  await cleanCheck(page, `${label} Terminal tab`);
  if (vp === 'desktop' && auditLink) {
    await go(page, auditLink);
    await page.getByTestId('audit-record-filter').waitFor({ timeout: 10_000 }).catch(() => {});
    await page.waitForFunction(() => document.querySelectorAll('table tbody tr').length > 0, null, { timeout: 10_000 }).catch(() => {});
    const body = await page.locator('table tbody').innerText().catch(() => '');
    check(/TERMINAL[ _]OPENED/i.test(body) && (await page.getByTestId('audit-record-filter').innerText().catch(() => '')).includes(row?.id ?? '?'),
      `${label}: the audit link opens this session's rows`, body.slice(0, 200));
    await cleanCheck(page, `${label} audit log by record`);
  }
  await go(page, `/endpoints/${f.tools.standard.id}?tab=terminal`);
  await page.getByTestId('terminal-unsupported').waitFor({ timeout: 10_000 }).catch(() => {});
  check(/full \(signed\) agent/.test(await page.getByTestId('terminal-unsupported').innerText().catch(() => '')) && await page.getByTestId('terminal-open').count() === 0,
    `${label}: on the standard agent the Terminal tab says what is needed and offers no Open`);
  await cleanCheck(page, `${label} Terminal tab on the standard agent`);
  await prisma.terminalSession.deleteMany({ where: { endpointId: ep.id } });
}

/**
 * The Files tab (0.78) on the signed computer, as the Platform Admin. It
 * checks:
 *   - the SYSTEM warning;
 *   - fetching a file with a reason (and the confirmation when it asks):
 *     the progress card shows the direction and waits for the computer, then
 *     Cancel ends it;
 *   - sending a file the same way, after the browser has hashed it;
 *   - on the standard computer, the tab says what is needed.
 * No agent runs here, so nothing moves: e2e-files.mjs drives the agent's
 * worker. Every width and theme, no sideways scroll, no console error.
 */
async function filesPanel(page, f, vp, theme, label) {
  const ep = f.tools.signed;
  await prisma.fileTransfer.deleteMany({ where: { endpointId: ep.id } });
  await go(page, `/endpoints/${ep.id}?tab=files`);
  await page.getByTestId('files-tab').waitFor({ timeout: 15_000 });
  const warn = await page.getByTestId('files-identity').innerText();
  check(/SYSTEM — full control of this device/.test(warn), `${label}: the Files tab says SYSTEM — full control of this computer`, warn.slice(0, 200));
  const confirmIfAsked = async () => {
    const dlg = stepUpDialog(page);
    if (await dlg.waitFor({ timeout: 3_000 }).then(() => true).catch(() => false)) {
      check(/transfer a file/.test(await dlg.innerText()), `${label}: a transfer asks to confirm it's you, and says why`, await dlg.innerText().catch(() => ''));
      await dlg.locator('#stepup-value').fill(PW);
      await dlg.getByRole('button', { name: 'Confirm' }).click();
      await dlg.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {});
    }
  };
  await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': ip() });

  // Fetch.
  await page.getByTestId('files-download-path').fill('C:\\Windows\\Logs\\CBS\\CBS.log');
  await page.getByTestId('files-download-reason').fill(`UI check ${vp} ${theme}`);
  await page.getByTestId('files-download-button').click();
  await confirmIfAsked();
  const card = page.locator('[data-testid="files-progress"][data-direction="download"]');
  await page.locator('[data-testid="files-progress"][data-direction="download"][data-state="pending"]').waitFor({ timeout: 15_000 }).catch(() => {});
  const down = await prisma.fileTransfer.findFirst({ where: { endpointId: ep.id, direction: 'from_computer' }, orderBy: { createdAt: 'desc' } });
  check(await card.getAttribute('data-state') === 'pending' && down?.state === 'pending' && down.technicianId === f.admin.id && down.path === 'C:\\Windows\\Logs\\CBS\\CBS.log',
    `${label}: a fetch is asked for and waits for the computer`, `${await card.getAttribute('data-state').catch(() => null)} ${down?.state}`);
  check(/next check-in/.test(await card.getByTestId('files-progress-state').innerText()) && /Fetching from the device/.test(await card.innerText()),
    `${label}: the progress card says the direction and that it starts at the next check-in`);

  // Send.
  await page.getByTestId('files-upload-file').setInputFiles({ name: 'ui-check.txt', mimeType: 'text/plain', buffer: Buffer.from(`ui check ${vp} ${theme}\n`) });
  const suggested = await page.getByTestId('files-upload-path').inputValue();
  check(suggested === 'C:\\Windows\\Temp\\ui-check.txt', `${label}: choosing a file suggests an absolute local path`, suggested);
  await page.getByTestId('files-upload-reason').fill(`UI check ${vp} ${theme}`);
  await page.getByTestId('files-upload-button').click();
  await confirmIfAsked();
  const upCard = page.locator('[data-testid="files-progress"][data-direction="upload"]');
  await upCard.waitFor({ timeout: 15_000 }).catch(() => {});
  await page.waitForFunction(() => document.querySelector('[data-testid="files-progress"][data-direction="upload"]')?.getAttribute('data-state') === 'pending', null, { timeout: 15_000 }).catch(() => {});
  const up = await prisma.fileTransfer.findFirst({ where: { endpointId: ep.id, direction: 'to_computer' }, orderBy: { createdAt: 'desc' } });
  const body = Buffer.from(`ui check ${vp} ${theme}\n`);
  check(up?.state === 'pending' && up.sha256 === createHash('sha256').update(body).digest('hex') && Number(up.size) === body.length,
    `${label}: a send declares the size and the SHA-256 the browser computed`, `${up?.state} ${up?.sha256}`);
  check(/Sending to the device/.test(await upCard.innerText().catch(() => '')), `${label}: the send shows its direction`);
  // 0.93 (UX P1-7): the server's clocks, the target and the transfer's reference.
  const fdl = await card.getByTestId('files-deadline').innerText().catch(() => '');
  check(/Hard limit: ends at \d\d:\d\d/.test(fdl) && /Without progress it stops at \d\d:\d\d/.test(fdl), `${label}: a transfer shows its hard limit and stall time`, fdl);
  check(await card.getByTestId('op-ref').getAttribute('data-ref').catch(() => null) === down?.id && /Runs as SYSTEM/.test(await card.getByTestId('tool-target').innerText().catch(() => '')),
    `${label}: a transfer shows its reference and target`);
  await themeCheck(page, theme, `${label} Files tab`);
  if (vp === 'phone') await noSideScroll(page, `${label} Files tab`);
  await shot(page, `${label}-files`);

  // Cancel both.
  for (const [c, id, what] of [[card, down?.id, 'fetch'], [upCard, up?.id, 'send']]) {
    await c.getByTestId('files-cancel').click().catch(() => {});
    await page.waitForFunction((d) => document.querySelector(`[data-testid="files-progress"][data-direction="${d}"]`)?.getAttribute('data-state') === 'cancelled', what === 'fetch' ? 'download' : 'upload', { timeout: 10_000 }).catch(() => {});
    const row = await prisma.fileTransfer.findUnique({ where: { id: id ?? '' } });
    check(row?.state === 'cancelled' && row.endReason === 'cancelled' && await c.getAttribute('data-state') === 'cancelled', `${label}: Cancel ends the ${what}, and the card says so`, `${row?.state} ${row?.endReason}`);
  }
  check((await page.getByTestId('files-row').count()) >= 2, `${label}: both appear under Recent transfers`);
  await page.getByTestId('files-filter').fill('ui-check.txt');
  check(await page.getByTestId('files-row').count() === 1, `${label}: the transfer filter narrows the list`);
  await page.getByTestId('files-filter').fill('no-such-file-anywhere');
  check(await page.getByTestId('files-filter-none').count() === 1, `${label}: a filter that matches nothing says so`);
  await page.getByTestId('files-filter').fill('');
  await cleanCheck(page, `${label} Files tab`);
  await go(page, `/endpoints/${f.tools.standard.id}?tab=files`);
  await page.getByTestId('files-unsupported').waitFor({ timeout: 10_000 }).catch(() => {});
  check(/full \(signed\) agent/.test(await page.getByTestId('files-unsupported').innerText().catch(() => '')) && await page.getByTestId('files-upload').count() === 0,
    `${label}: on the standard agent the Files tab says what is needed and offers nothing to send`);
  await cleanCheck(page, `${label} Files tab on the standard agent`);
  await prisma.fileTransfer.deleteMany({ where: { endpointId: ep.id } });
}

/** The Tools panel on one computer: open it, and return each tool's state. */
async function openTools(page, id) {
  if (!new URL(page.url()).pathname.endsWith(`/endpoints/${id}`)) await go(page, `/endpoints/${id}`);
  await page.getByTestId('action-tools').click();
  const panel = page.getByTestId('tools-panel');
  await panel.waitFor({ timeout: 15_000 });
  // The catalog and diagnostics reads settle the actions' and diagnostics' states.
  await page.waitForFunction(() => !document.querySelector('[data-testid="tools-panel"] [data-state="checking"]'), null, { timeout: 15_000 }).catch(() => {});
  await settled(page, 10_000);
  return Object.fromEntries(await panel.locator('li[data-testid^="tool-"][data-state]').evaluateAll((els) => els.map((e) => [e.getAttribute('data-testid').replace(/^tool-/, ''), e.getAttribute('data-state')])));
}
const closeTools = async (page) => { await page.keyboard.press('Escape'); await page.getByTestId('tools-panel').waitFor({ state: 'detached', timeout: 5_000 }).catch(() => {}); };

const ACTION_TOOLS = ['run-script', 'service-control', 'service-restart', 'spooler-start', 'process-stop', 'software-install', 'software-remove', 'install-updates', 'restart-schedule', 'restart-cancel', 'logs-collect'];
const DIAG_TOOLS = ['refresh-inventory', 'disk-space', 'service-health', 'top-processes', 'recent-errors', 'reboot-status', 'network-connectivity', 'dns-resolution'];
const VIEW_TOOLS = ['services', 'processes', 'software-list', 'network', 'security-log'];
const SERVER_TOOLS = ['test-connection', 'diagnostics-report', 'os-support'];
const SCAN_TOOLS = ['patch-scan', 'restart-pending'];
const LATER_TOOLS = ['flush-dns'];
/** 0.76: the read-only palette's tools and the catalog key each opens. */
const PALETTE_TOOLS = {
  defender: 'defender_status', firewall: 'firewall_status', bitlocker: 'bitlocker_status', 'secure-boot-tpm': 'secure_boot_tpm', 'local-admins': 'local_admins',
  'dns-lookup': 'dns_lookup', 'tcp-port': 'tcp_port', 'route-table': 'route_table',
  'time-sync': 'time_sync', activation: 'windows_activation', 'unexpected-shutdowns': 'unexpected_shutdowns', 'scheduled-tasks': 'scheduled_tasks', 'signed-in': 'signed_in_sessions',
};
const SECURITY_KEYS = ['defender_status', 'firewall_status', 'bitlocker_status', 'secure_boot_tpm', 'local_admins'];
/** What each fixture must show, tool by tool (lib/device-tools.ts; this suite has no approval signer). */
function expectedTools(kind) {
  const e = {};
  for (const t of LATER_TOOLS) e[t] = 'coming_later';
  for (const t of SERVER_TOOLS) e[t] = 'available';
  const reads = kind === 'linux' || kind === 'mac' ? 'unsupported' : kind === 'offline' ? 'offline' : 'available';
  for (const t of [...DIAG_TOOLS, ...VIEW_TOOLS]) e[t] = reads;
  for (const t of SCAN_TOOLS) e[t] = kind === 'offline' && t === 'patch-scan' ? 'offline' : 'available';
  // 0.76: only the signed fixture's agent (0.76.0) carries the palette; the agent is decided before connectivity.
  for (const t of Object.keys(PALETTE_TOOLS)) e[t] = kind === 'linux' || kind === 'mac' ? 'unsupported' : kind === 'signed' ? 'available' : 'needs_newer_agent';
  // No approval signer here: every action says so, before the agent is looked at — except where the OS cannot run it at all.
  for (const t of ACTION_TOOLS) e[t] = kind === 'linux' || kind === 'mac' ? 'unsupported' : 'not_configured';
  // 0.77: the terminal needs the signed agent 0.77.0 (the standard ones need a newer agent before offline is looked at); this suite is a Platform Admin.
  e.terminal = kind === 'linux' || kind === 'mac' ? 'unsupported' : kind === 'signed' ? 'available' : 'needs_newer_agent';
  // 0.78: file transfer, the same rules from the signed agent 0.78.0.
  e['files-upload'] = e.terminal;
  e['files-download'] = e.terminal;
  return e;
}

/**
 * The Tools panel (0.75) at both widths and in both themes, as the Platform
 * Admin: opened from the header on a signed and a standard Windows agent, on
 * Linux, on macOS and on an offline computer, every tool in its expected
 * state, the eight groups in order, no sideways scroll, closed with Escape and
 * the focus back on the Tools button. On desktop/light and phone/dark every
 * tool that opens is picked, and must land in its flow: its tab selected, the
 * diagnostic's row marked, the Security log chosen — and nothing runs on the
 * way.
 */
async function toolsPanel(page, f, vp, theme, label) {
  const T = f.tools;
  for (const [kind, ep] of [['signed', T.signed], ['standard', T.standard], ['linux', T.linux], ['mac', T.mac], ['offline', T.offline]]) {
    await go(page, `/endpoints/${ep.id}`);
    const got = await openTools(page, ep.id);
    const want = expectedTools(kind);
    const wrong = Object.entries(want).filter(([t, s]) => got[t] !== s).map(([t, s]) => `${t}: ${got[t]} ≠ ${s}`);
    check(wrong.length === 0 && Object.keys(got).length === Object.keys(want).length, `${label}: Tools on the ${kind} computer: all ${Object.keys(want).length} tools in their expected state`, wrong.join('; ') || JSON.stringify(got));
    if (kind === 'signed') {
      const groups = await page.getByTestId('tools-panel').locator('section h3').allInnerTexts();
      check(groups.join('|').toLowerCase() === 'diagnostics|terminal and files|powershell / scripts|services & processes|software|windows updates|networking|security|maintenance',
        `${label}: the nine groups, in order`, groups.join('|'));
      const term = await page.getByTestId('tool-terminal').innerText();
      check(/SYSTEM/.test(term) && /full control/.test(term), `${label}: the terminal tool says SYSTEM, full control`, term.slice(0, 200));
      const reason = await page.getByTestId('tool-restart-schedule').innerText();
      check(/No approval signer is configured/.test(reason) && await page.getByTestId('tool-restart-schedule').getAttribute('data-disabled') === 'true',
        `${label}: an action with no signer is shown disabled, saying why`, reason.slice(0, 200));
      const later = await page.getByTestId('tool-flush-dns').innerText();
      check(/Coming later/i.test(later), `${label}: Flush DNS / renew DHCP is labelled Coming later`, later.slice(0, 200));
      check(await page.getByTestId('tool-security-posture').count() === 0, `${label}: 0.76 replaced the security-posture placeholder with the checks themselves`);
      await themeCheck(page, theme, `${label} Tools panel`);
      await shot(page, `${label}-tools-${kind}`);
    }
    if (kind === 'linux') {
      const r = await page.getByTestId('tool-services').innerText();
      check(/Linux agent is read-only/.test(r), `${label}: on Linux an unsupported tool says the agent is read-only`, r.slice(0, 200));
    }
    if (kind === 'mac') {
      const r = await page.getByTestId('tool-services').innerText();
      check(/macOS agent is read-only/.test(r), `${label}: on macOS an unsupported tool says the agent is read-only`, r.slice(0, 200));
    }
    if (kind === 'standard') {
      const r = await page.getByTestId('tool-defender').innerText();
      check(/older than 0\.76\.0/.test(r), `${label}: on a 0.73 agent a palette check says it needs 0.76.0`, r.slice(0, 200));
    }
    if (kind === 'offline') {
      const r = await page.getByTestId('tool-disk-space').innerText();
      check(/Offline, last seen \d+[mhd] ago/.test(r) && /expires/.test(r), `${label}: offline says when it was last seen, and that a diagnostic would expire`, r.slice(0, 200));
    }
    if (vp === 'phone') {
      const w = await page.getByTestId('tools-panel').evaluate((el) => ({ box: el.getBoundingClientRect().width, scroll: el.scrollWidth, client: el.clientWidth, vw: innerWidth }));
      check(w.box <= w.vw && w.scroll <= w.client + 1, `${label}: Tools on the ${kind} computer fits 375 px with no sideways scroll`, JSON.stringify(w));
    }
    await closeTools(page);
    // Radix returns the focus when the close animation ends, which on a slow
    // runner is after the panel detaches: wait for it, bounded, not one sample.
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'action-tools', null, { timeout: 3_000 }).catch(() => {});
    const focused = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'));
    check(focused === 'action-tools', `${label}: Escape closes Tools and gives the focus back to the Tools button (${kind})`, String(focused));
    await cleanCheck(page, `${label} Tools on the ${kind} computer`);
  }

  if (!((vp === 'desktop' && theme === 'light') || (vp === 'phone' && theme === 'dark'))) return;
  // Every tool that opens, picked on the signed computer, lands in its flow.
  const ep = T.signed;
  const landing = {
    'test-connection': { tab: 'diagnostics', extra: async () => (await page.getByTestId('diag-test-connection').count()) === 1 },
    'refresh-inventory': { tab: 'diagnostics', check: 'refresh_inventory' }, 'disk-space': { tab: 'diagnostics', check: 'disk_space' },
    'service-health': { tab: 'diagnostics', check: 'service_health' }, 'top-processes': { tab: 'diagnostics', check: 'top_processes' },
    'recent-errors': { tab: 'diagnostics', check: 'recent_system_errors' }, 'reboot-status': { tab: 'diagnostics', check: 'reboot_status' },
    'network-connectivity': { tab: 'diagnostics', check: 'network_connectivity' }, 'dns-resolution': { tab: 'diagnostics', check: 'dns_resolution' },
    services: { tab: 'services' }, processes: { tab: 'processes' }, 'software-list': { tab: 'software' }, network: { tab: 'network' },
    'security-log': { tab: 'events', extra: async () => new URL(page.url()).searchParams.get('log') === 'Security'
      && (await page.locator('[role="tabpanel"][data-state="active"] [role="combobox"]').first().innerText().catch(() => '')).trim() === 'Security' },
    'patch-scan': { tab: 'patches' }, 'restart-pending': { tab: 'patches' },
    // 0.76: each palette check, and the server's own Windows support row.
    ...Object.fromEntries(Object.entries(PALETTE_TOOLS).map(([t, k]) => [t, { tab: 'diagnostics', check: k }])),
    'os-support': { tab: 'diagnostics', check: 'os_support' },
    terminal: { tab: 'terminal' },
  };
  const before = await prisma.diagnosticRun.count({ where: { endpointId: ep.id } });
  for (const [tool, want] of Object.entries(landing)) {
    await openTools(page, ep.id);
    await page.getByTestId(`tool-${tool}`).locator('button').click();
    await page.getByTestId('tools-panel').waitFor({ state: 'detached', timeout: 5_000 }).catch(() => {});
    const tab = page.locator(`[data-testid="tab-${want.tab}"]`);
    await page.waitForFunction((t) => document.querySelector(`[data-testid="tab-${t}"]`)?.getAttribute('aria-selected') === 'true', want.tab, { timeout: 10_000 }).catch(() => {});
    await settled(page, 10_000);
    let ok = await tab.getAttribute('aria-selected') === 'true' && new URL(page.url()).searchParams.get('tab') === want.tab;
    if (ok && want.check) {
      await page.locator(`[data-diag-key="${want.check}"][data-focused="true"]`).waitFor({ timeout: 10_000 }).catch(() => {});
      ok = await page.locator(`[data-diag-key="${want.check}"][data-focused="true"]`).count() === 1 && new URL(page.url()).searchParams.get('check') === want.check;
    }
    if (ok && want.extra) ok = await want.extra();
    check(ok, `${label}: ${tool} opens the ${want.tab} tab${want.check ? ` at ${want.check}` : ''}`, page.url());
    await cleanCheck(page, `${label} ${tool} from Tools`);
  }
  check(await prisma.diagnosticRun.count({ where: { endpointId: ep.id } }) === before, `${label}: picking ${Object.keys(landing).length} tools ran nothing — a check runs only from its own Run button`);
  // The report is a link to the existing route, not a click here.
  await openTools(page, ep.id);
  const href = await page.getByTestId('tool-diagnostics-report').locator('a').getAttribute('href');
  check(href === `/api/v1/endpoints/${ep.id}/diagnostics/report`, `${label}: Download diagnostics report links to the existing route`, String(href));
  // Keyboard: a focused tool opens with Enter.
  await page.getByTestId('tool-disk-space').locator('button').focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => new URL(location.href).searchParams.get('check') === 'disk_space', null, { timeout: 10_000 }).catch(() => {});
  check(new URL(page.url()).searchParams.get('check') === 'disk_space', `${label}: a tool opens from the keyboard (Enter)`, page.url());
  await settled(page, 10_000);
  await cleanCheck(page, `${label} Tools from the keyboard`);
  // A deep link opens the same place on a fresh load.
  await go(page, `/endpoints/${ep.id}?tab=diagnostics&check=dns_resolution`);
  await page.locator('[data-diag-key="dns_resolution"][data-focused="true"]').waitFor({ timeout: 10_000 }).catch(() => {});
  check(await page.locator('[data-diag-key="dns_resolution"][data-focused="true"]').count() === 1, `${label}: ?tab=diagnostics&check=… marks that check on a fresh load`);
  if (vp === 'phone') await noSideScroll(page, `${label} diagnostics opened from Tools`);
  await cleanCheck(page, `${label} Tools deep link`);
}

/**
 * The read-only diagnostics palette (0.76) on the Diagnostics tab, as the
 * Platform Admin, at both widths and in both themes, on the Tools fixtures:
 *
 *   - the four groups in order (Security, Networking, Maintenance, General),
 *     with the Windows support row first under Security, read on the server:
 *     the fixture has no inventory, so it must say Unknown — never Healthy;
 *   - every palette row labelled lab-tested only;
 *   - a seeded firewall reading with two profiles not reported: the run and
 *     its row say Unknown, never Healthy, and the finding says why;
 *   - the DNS and TCP forms refuse a bad name and a bad port before anything
 *     is sent, and the Run button stays disabled;
 *   - on the standard computer (agent 0.73.0) every palette row says it needs
 *     0.76.0, and its Run is disabled;
 *   - on desktop/light: a DNS lookup and a TCP test are requested with exactly
 *     their canonical parameters, shown in the run and the history, and
 *     "Run all security checks" queues exactly the five security keys, one run
 *     each. The runs it made are deleted again (never an audit row).
 */
async function diagnosticsPaletteUi(page, f, vp, theme, label) {
  const T = f.tools;
  const ep = T.signed;
  const now = Date.now();
  const done = new Date(now - 10 * 60_000);
  const seeded = await prisma.diagnosticRun.create({ data: {
    endpointId: ep.id, tenantId: f.tenant.id, customerId: T.D.id, key: 'firewall_status', status: 'COMPLETED', requestedById: f.admin.id,
    requestedAt: new Date(done.getTime() - 60_000), deliveredAt: done, startedAt: done, completedAt: done, expiresAt: new Date(now + 3600_000),
    result: { profiles: [{ name: 'Domain', enabled: true, defaultInbound: 'Block', defaultOutbound: 'Allow' }], activeCategories: ['Private'], serviceState: 'Running' },
    resultBytes: 160,
  } });
  try {
    await go(page, `/endpoints/${ep.id}?tab=diagnostics`);
    await page.locator('[data-diag-group]').first().waitFor({ timeout: 15_000 }).catch(() => {});
    await settled(page, 10_000);
    const groups = await page.locator('[data-diag-group]').evaluateAll((els) => els.map((e) => e.getAttribute('data-diag-group')));
    check(groups.join('|') === 'security|networking|maintenance|general', `${label}: Diagnostics is grouped Security, Networking, Maintenance, General`, groups.join('|'));
    const secKeys = await page.locator('[data-diag-group="security"] [data-diag-key]').evaluateAll((els) => els.map((e) => e.getAttribute('data-diag-key')));
    check(secKeys.join('|') === ['os_support', ...SECURITY_KEYS].join('|'), `${label}: Security lists the Windows support row, then the five security checks`, secKeys.join('|'));
    const os = page.locator('[data-diag-key="os_support"]');
    const osHealth = await os.locator('[data-health]').first().getAttribute('data-health').catch(() => null);
    check(osHealth === 'unknown' && !/Healthy/.test(await os.innerText()) && await os.locator('button[data-diag-run]').count() === 0,
      `${label}: with no inventory, Windows support says Unknown (not Healthy) and has no Run — it runs on the server`, `${osHealth} ${(await os.innerText()).slice(0, 200)}`);
    const lab = await page.locator('[data-diag-key] [data-lab-only]').count();
    check(lab === Object.keys(PALETTE_TOOLS).length, `${label}: every palette check is labelled lab-tested only`, String(lab));
    check(await page.locator('[data-diag-key="dns_lookup"]').innerText().then((t) => /Remote connect/.test(t)), `${label}: DNS lookup says it needs Remote connect`);

    // Unknown is never drawn as Healthy.
    const fw = page.locator('[data-diag-key="firewall_status"]');
    check(await fw.locator('[data-health]').first().getAttribute('data-health').catch(() => null) === 'unknown', `${label}: a firewall reading with profiles not reported is Unknown on its row`);
    await fw.locator('button:not([data-diag-run])').first().click();
    const detail = page.locator('[data-findings]').first();
    await detail.waitFor({ timeout: 10_000 }).catch(() => {});
    const states = await detail.locator('[data-health]').evaluateAll((els) => els.map((e) => e.getAttribute('data-health')));
    const dt = await detail.innerText().catch(() => '');
    check(states.join('|') === 'healthy|unknown|unknown' && /Private profile/.test(dt) && /Not reported/.test(dt),
      `${label}: its findings: Domain Healthy, Private and Public Unknown (not reported)`, `${states.join('|')} ${dt.slice(0, 200)}`);

    // The forms refuse before anything is sent.
    const before = await prisma.diagnosticRun.count({ where: { endpointId: ep.id } });
    const dns = page.locator('[data-diag-key="dns_lookup"]');
    await dns.locator('[data-diag-param="name"]').fill('bad_name!');
    check(await dns.locator('[data-diag-param-error]').isVisible() && await dns.locator('button[data-diag-run]').isDisabled(), `${label}: DNS lookup refuses "bad_name!" and keeps Run disabled`);
    await dns.locator('[data-diag-param="name"]').fill('intranet.example.com');
    check(!(await dns.locator('[data-diag-param-error]').count()) && !(await dns.locator('button[data-diag-run]').isDisabled()), `${label}: …and accepts intranet.example.com`);
    const tcp = page.locator('[data-diag-key="tcp_port"]');
    await tcp.locator('[data-diag-param="host"]').fill('fileserver.example.com');
    await tcp.locator('[data-diag-param="port"]').fill('70000');
    check(/1 to 65535/.test(await tcp.locator('[data-diag-param-error]').innerText().catch(() => '')) && await tcp.locator('button[data-diag-run]').isDisabled(), `${label}: TCP port test refuses port 70000`);
    await tcp.locator('[data-diag-param="port"]').fill('445');
    await tcp.locator('[data-diag-param="timeoutSeconds"]').selectOption('3');
    check(!(await tcp.locator('button[data-diag-run]').isDisabled()), `${label}: …and accepts port 445`);
    check(await prisma.diagnosticRun.count({ where: { endpointId: ep.id } }) === before, `${label}: typing in the forms sent nothing`);
    await themeCheck(page, theme, `${label} Diagnostics palette`);
    if (vp === 'phone') await noSideScroll(page, `${label} Diagnostics palette`);
    await shot(page, `${label}-diagnostics-palette`);
    await cleanCheck(page, `${label} Diagnostics palette`);

    if (vp === 'desktop' && theme === 'light') {
      const since = new Date();
      await dns.locator('button[data-diag-run]').click();
      await page.waitForFunction(() => !!document.querySelector('[data-run-params]'), null, { timeout: 10_000 }).catch(() => {});
      await tcp.locator('button[data-diag-run]').click();
      await settled(page, 10_000);
      // The second POST can still be in flight when the page settles: wait for both rows.
      let mine = [];
      for (let i = 0; i < 40; i++) {
        mine = await prisma.diagnosticRun.findMany({ where: { endpointId: ep.id, requestedAt: { gte: since } }, orderBy: { requestedAt: 'asc' } });
        if (mine.some((r) => r.key === 'dns_lookup') && mine.some((r) => r.key === 'tcp_port')) break;
        await new Promise((res) => setTimeout(res, 250));
      }
      const pd = mine.find((r) => r.key === 'dns_lookup')?.params;
      const pt = mine.find((r) => r.key === 'tcp_port')?.params;
      check(JSON.stringify(pd) === JSON.stringify({ name: 'intranet.example.com' }), `${label}: DNS lookup was requested with exactly {name}`, JSON.stringify(pd));
      check(JSON.stringify(pt) === JSON.stringify({ host: 'fileserver.example.com', port: 445, timeoutSeconds: 3 }), `${label}: TCP port test was requested with exactly {host, port, timeoutSeconds}`, JSON.stringify(pt));
      await page.waitForFunction(() => [...document.querySelectorAll('[data-run-params]')].some((e) => e.textContent === 'fileserver.example.com:445 (3 s)'), null, { timeout: 10_000 }).catch(() => {});
      check(await page.locator('[data-run-params]', { hasText: 'fileserver.example.com:445 (3 s)' }).count() >= 1, `${label}: the parameters are shown with the run`);

      const all = page.locator('[data-diag-run-all="security"]');
      check(!(await all.isDisabled()), `${label}: Run all security checks is enabled`);
      const since2 = new Date();
      await all.click();
      await page.waitForFunction(() => /Run all security checks/.test(document.querySelector('[data-diag-run-all="security"]')?.textContent ?? ''), null, { timeout: 20_000 }).catch(() => {});
      await settled(page, 10_000);
      const sec = await prisma.diagnosticRun.findMany({ where: { endpointId: ep.id, requestedAt: { gte: since2 } }, orderBy: { requestedAt: 'asc' } });
      check(sec.map((r) => r.key).join('|') === SECURITY_KEYS.join('|') && sec.every((r) => r.params === null && r.status === 'REQUESTED'),
        `${label}: Run all security checks queued exactly the five security checks, in order, one run each, without parameters`, sec.map((r) => `${r.key}:${r.status}`).join('|'));
      await page.waitForFunction(() => document.querySelector('[data-diag-run-all="security"]')?.hasAttribute('disabled'), null, { timeout: 10_000 }).catch(() => {});
      check(await all.isDisabled(), `${label}: with every security check waiting, Run all security checks is disabled`);
      await cleanCheck(page, `${label} Diagnostics palette runs`);
      await prisma.diagnosticRun.deleteMany({ where: { endpointId: ep.id, requestedAt: { gte: since }, id: { not: seeded.id } } });
    }

    // An agent older than the palette: every palette row says so, and cannot be run.
    await go(page, `/endpoints/${T.standard.id}?tab=diagnostics`);
    await page.locator('[data-diag-group]').first().waitFor({ timeout: 15_000 }).catch(() => {});
    const rows = await page.locator('[data-diag-key]').evaluateAll((els) => els.map((e) => ({
      key: e.getAttribute('data-diag-key'), newer: !!e.querySelector('[data-diag-needs-newer]'), lab: !!e.querySelector('[data-lab-only]'),
      disabled: e.querySelector('button[data-diag-run]')?.hasAttribute('disabled') ?? null, form: !!e.querySelector('[data-diag-form]'),
    })));
    const pal = rows.filter((r) => r.lab);
    check(pal.length === Object.keys(PALETTE_TOOLS).length && pal.every((r) => r.newer && r.disabled === true && !r.form),
      `${label}: on agent 0.73.0 every palette check says it needs a newer agent, with Run disabled and no form`, JSON.stringify(pal.filter((r) => !(r.newer && r.disabled && !r.form))));
    check(rows.filter((r) => !r.lab && r.key !== 'os_support').every((r) => !r.newer), `${label}: …and the older checks do not`);
    check(await page.locator('[data-diag-run-all="security"]').isDisabled(), `${label}: …and Run all security checks is disabled`);
    await cleanCheck(page, `${label} Diagnostics palette on an older agent`);
  } finally {
    await prisma.diagnosticRun.deleteMany({ where: { id: seeded.id } });
  }
}

/**
 * The agent's buttons in the computer page's header (0.37), as the Platform
 * Admin. Upgrade to full agent: a real disabled button with its reason, fix
 * and Full agent link while no signed release is published; enabled once one
 * is, opening the same dialog as the Agent card and the "Agent out of date"
 * chip; on desktop/light a request goes through step-up and both the header
 * and the card follow it, then the card cancels it. Then a signed agent
 * ("Full agent", no upgrade), Linux (the command), and the main computer's
 * open request ("Upgrade requested — waiting for check-in").
 */
async function headerAgentUpgrade(page, f, vp, theme, label) {
  const upg = f.c.upg;
  const hdr = page.locator('[data-testid="device-actions"]');
  const btn = hdr.getByTestId('header-upgrade-full-agent');
  const loaded = () => page.waitForFunction(() => !!document.querySelector('[data-testid="header-upgrade-full-agent"]') && !/Loading…/.test(document.querySelector('[data-testid="agent-card"]')?.textContent ?? 'Loading…'), null, { timeout: 15_000 }).catch(() => {});
  const fits = async (what) => {
    if (vp !== 'phone') return;
    const boxes = await hdr.locator('button, [data-testid="header-full-agent"]').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { r: Math.round(r.right), t: (e.textContent ?? '').trim().slice(0, 30) }; }));
    check(boxes.length > 0 && boxes.every((b) => b.r <= 375), `${label}: ${what}: every header button wraps inside 375 px`, JSON.stringify(boxes));
    await noSideScroll(page, `${label} ${what}`);
  };

  signedRelease(false);
  await go(page, `/endpoints/${upg.id}`);
  await loaded();
  const tag = await btn.evaluate((e) => e.tagName).catch(() => null);
  const reason = hdr.getByTestId('header-upgrade-reason');
  const rt = await reason.innerText().catch(() => '');
  const tip = await btn.locator('xpath=..').getAttribute('title').catch(() => null);
  check(tag === 'BUTTON' && await btn.isDisabled() && await btn.getAttribute('data-state') === 'blocked' && /Upgrade to full agent/.test(await btn.innerText()),
    `${label}: with no signed release, the header's "Upgrade to full agent" is a real <button disabled>`, `${tag} ${await btn.getAttribute('data-state').catch(() => null)}`);
  check(await reason.isVisible() && /Upgrade to full agent unavailable: No signed release is published/.test(rt) && /What to do:/.test(rt)
      && await reason.locator('a[href="/endpoints/full-agent"]').count() === 1 && /No signed release is published/.test(tip ?? ''),
    `${label}: …with the reason beside it (and as its tooltip), what to do, and a link to Devices → Full agent`, `${rt.slice(0, 300)} | title=${tip}`);
  const upd = hdr.getByTestId('header-update-agent');
  check(await upd.isVisible() && await upd.innerText() === 'Update agent' && !(await upd.isDisabled()), `${label}: Update agent sits beside it, a separate button`);
  const card = page.locator('[data-testid="agent-card"]');
  const cardBtn = card.getByTestId('agent-migrate');
  check(await cardBtn.evaluate((e) => e.tagName).catch(() => null) === 'BUTTON' && await cardBtn.isDisabled() && /No signed release is published/.test(await card.getByTestId('agent-migration-blocked').innerText().catch(() => '')),
    `${label}: the Agent card shows the same disabled button and reason`);
  await themeCheck(page, theme, `${label} header agent buttons`);
  await fits('no signed release');
  await shot(page, `${label}-header-upgrade-disabled`);
  await cleanCheck(page, `${label} header upgrade (no release)`);

  if (!signedRelease(true)) {
    check(false, `${label}: the enabled state needs a signed release: set RELEASE_BIN to the rem0te-release tool (CI's e2e job builds it)`);
  } else {
    try {
      await go(page, `/endpoints/${upg.id}`);
      await page.waitForFunction(() => document.querySelector('[data-testid="header-upgrade-full-agent"]')?.getAttribute('data-state') === 'enabled', null, { timeout: 15_000 }).catch(() => {});
      check(await btn.getAttribute('data-state') === 'enabled' && !(await btn.isDisabled()) && !(await hdr.getByTestId('header-upgrade-reason').count()),
        `${label}: with a signed release published, the header's Upgrade to full agent is enabled, with no reason beside it`, String(await btn.getAttribute('data-state')));
      check(!(await card.getByTestId('agent-migrate').isDisabled()), `${label}: and so is the Agent card's`);
      const dlg = page.getByTestId('agent-migrate-dialog');
      const chip = page.getByTestId('attention-agent-outdated');
      check(await chip.isVisible(), `${label}: the old agent shows "Agent out of date"`);
      await chip.click();
      await dlg.waitFor({ timeout: 5_000 }).catch(() => {});
      check(await dlg.isVisible() && /Upgrade to full agent\?/.test(await dlg.innerText()) && /The full agent is the signed agent/.test(await dlg.innerText()), `${label}: the "Agent out of date" chip opens the Upgrade to full agent dialog`, await dlg.innerText().catch(() => ''));
      await dlg.getByRole('button', { name: 'Cancel' }).click();
      await dlg.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
      await btn.click();
      await dlg.waitFor({ timeout: 5_000 }).catch(() => {});
      check(await dlg.isVisible() && await dlg.locator('#agent-migrate-reason').isVisible() && await dlg.getByRole('button', { name: 'Request upgrade' }).isDisabled(),
        `${label}: the header's button opens the same dialog, asking for a reason before it can be sent`);
      await fits('upgrade dialog');
      await shot(page, `${label}-header-upgrade-dialog`);
      if (vp === 'desktop' && theme === 'light') {
        const before = await prisma.agentMigration.count({ where: { endpointId: upg.id } });
        await dlg.locator('#agent-migrate-reason').fill(`${TAG} header upgrade`);
        await forgetStepUp(page);
        await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': ip() });
        await dlg.getByRole('button', { name: 'Request upgrade' }).click();
        await confirmStepUp(page, label, 'Upgrade to full agent from the header');
        await page.waitForFunction(() => document.querySelector('[data-testid="header-upgrade-full-agent"]')?.getAttribute('data-state') === 'pending', null, { timeout: 15_000 }).catch(() => {});
        const rows = await prisma.agentMigration.findMany({ where: { endpointId: upg.id }, orderBy: { requestedAt: 'desc' } });
        const audit = rows[0] ? await prisma.activityLog.count({ where: { action: 'AGENT_MIGRATION_REQUESTED', resourceId: upg.id } }) : 0;
        check(rows.length === before + 1 && rows[0].reason === `${TAG} header upgrade` && rows[0].requestedById === f.admin.id && audit >= 1,
          `${label}: requesting it through step-up records one request with the reason, and its audit entry`, JSON.stringify({ rows: rows.length, before, audit }));
        check(await btn.isDisabled() && (await btn.innerText()).includes('Upgrade requested — waiting for check-in') && await hdr.getByTestId('header-upgrade-pending').isVisible(),
          `${label}: the header then says "Upgrade requested — waiting for check-in" instead of offering it again`, await btn.innerText().catch(() => ''));
        check(/header upgrade/.test(await card.getByTestId('agent-migration').innerText().catch(() => '')) && await card.getByTestId('agent-migrate').isDisabled(),
          `${label}: and the Agent card follows it without a reload (the same query)`);
        await card.getByTestId('agent-migrate-cancel').click();
        await page.waitForFunction(() => document.querySelector('[data-testid="header-upgrade-full-agent"]')?.getAttribute('data-state') === 'enabled', null, { timeout: 15_000 }).catch(() => {});
        const open = await prisma.agentMigration.count({ where: { endpointId: upg.id, completedAt: null, cancelledAt: null } });
        check(open === 0 && await btn.getAttribute('data-state') === 'enabled', `${label}: cancelling it on the card offers the header's button again`, `open ${open}`);
        await cleanCheck(page, `${label} header upgrade requested`, stepUp403);
      } else {
        await dlg.getByRole('button', { name: 'Cancel' }).click();
        await dlg.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
        await cleanCheck(page, `${label} header upgrade (release published)`);
      }
    } finally { signedRelease(false); }
  }

  // A signed agent: no upgrade, no green "Full agent" chip (0.88: it read as a
  // health status; the attention strip names the agent), and Check for update
  // now in More rather than on the header row.
  await go(page, `/endpoints/${f.c.chat.id}`);
  await page.getByTestId('attention-agent').waitFor({ timeout: 15_000 }).catch(() => {});
  check(/Signed agent/.test(await page.getByTestId('attention-agent').innerText().catch(() => '')) && await hdr.getByTestId('header-full-agent').count() === 0
      && await hdr.getByTestId('header-upgrade-full-agent').count() === 0 && await hdr.getByTestId('header-update-agent').count() === 0,
    `${label}: a signed agent is named in the attention strip, with no "Full agent" chip, upgrade button or update button on the header row`);
  await hdr.getByTestId('action-more').click();
  const signedCheck = page.locator('[role="menu"] [data-testid="header-update-agent"]');
  await signedCheck.waitFor({ timeout: 5_000 }).catch(() => {});
  check(/Check for update now/.test(await signedCheck.innerText().catch(() => '')), `${label}: …and Check for update now is in More`, await signedCheck.innerText().catch(() => ''));
  await page.keyboard.press('Escape');
  await fits('signed agent');
  await cleanCheck(page, `${label} header signed agent`);
  // 0.70.1: the same signed computer, reporting the published build while its
  // recorded label is still 0.34.0 (releases that change nothing in the agent
  // publish the same binary): the Agent card shows the published release,
  // current, with the recorded label under it.
  if (SIGNED && signedRelease(true)) {
    const prev = await prisma.endpoint.findUnique({ where: { id: f.c.chat.id }, select: { agentSha256: true, agentVersion: true } });
    const prevSha = prev?.agentSha256 ?? null;
    const recorded = prev?.agentVersion ?? '0.34.0';
    try {
      await prisma.endpoint.update({ where: { id: f.c.chat.id }, data: { agentSha256: SIGNED.agentSha256 } });
      await go(page, `/endpoints/${f.c.chat.id}`);
      const ver = page.locator('[data-testid="agent-card"] [data-testid="agent-card-version"]');
      await page.waitForFunction((v) => (document.querySelector('[data-testid="agent-card-version"]')?.textContent ?? '').includes(v), SIGNED_AGENT_LABEL, { timeout: 15_000 }).catch(() => {});
      const vt = await ver.innerText().catch(() => '');
      const ct = await page.locator('[data-testid="agent-card"]').innerText().catch(() => '');
      check(vt.includes(SIGNED_AGENT_LABEL) && vt.includes(`installed as ${recorded}; the same agent`) && /Current/.test(ct),
        `${label}: a signed agent on the published build shows ${SIGNED_AGENT_LABEL} and Current, "installed as ${recorded}; the same agent"`, vt);
      if (vp === 'phone') await noSideScroll(page, `${label} Agent card version`);
      await cleanCheck(page, `${label} Agent card published build`);
    } finally {
      await prisma.endpoint.update({ where: { id: f.c.chat.id }, data: { agentSha256: prevSha } });
      signedRelease(false);
    }
  }
  // Linux: the command, no upgrade.
  await go(page, `/endpoints/${f.linux.id}`);
  await hdr.getByTestId('header-agent-command').waitFor({ timeout: 15_000 }).catch(() => {});
  check(await hdr.getByTestId('header-agent-command').isVisible() && await hdr.getByTestId('header-upgrade-full-agent').count() === 0 && /install/i.test(await hdr.getByTestId('header-agent-command-text').innerText().catch(() => '')),
    `${label}: Linux shows the command to re-run (with a copy button), and no upgrade button`, await hdr.getByTestId('header-agent-command-text').innerText().catch(() => ''));
  await fits('Linux agent');
  await cleanCheck(page, `${label} header Linux agent`);
  // The main computer's open request (seeded): shown, not offered again.
  await go(page, `/endpoints/${f.main.id}`);
  await loaded();
  check(await btn.isDisabled() && await btn.getAttribute('data-state') === 'pending' && /Upgrade requested — waiting for check-in/.test(await btn.innerText()),
    `${label}: with a request open, the header shows "Upgrade requested — waiting for check-in", disabled`);
  await fits('open request');
  await cleanCheck(page, `${label} header open request`);
}

/** History tab (0.34): the AI summary says ClientSt0r does not offer it yet, and Generate stays off. */
async function aiHistoryPanel(page, f, vp, label) {
  const caps = peer.state.capsRequests;
  await go(page, `/endpoints/${f.main.id}`);
  await openTab(page, 'history');
  const why = page.locator('[data-testid="ai-summary-unavailable"]');
  await page.waitForFunction(() => /Needs ClientSt0r/.test(document.querySelector('[data-testid="ai-summary-unavailable"]')?.textContent ?? ''), null, { timeout: 15_000 }).catch(() => {});
  const t = await why.innerText().catch(() => '');
  check(/Needs ClientSt0r support for device_timeline_v1/.test(t) && /capabilities do not list it yet/.test(t) && await page.locator('[data-testid="ai-summary-generate"]').isDisabled(),
    `${label}: the AI summary says "Needs ClientSt0r support for device_timeline_v1" and Generate is off`, t);
  check(peer.state.capsRequests > caps && peer.state.badSignatures === 0, `${label}: …because the peer's signed capabilities document was read and does not list it`, JSON.stringify(peer.state));
  if (vp === 'phone') await noSideScroll(page, `${label} History tab`);
  await shot(page, `${label}-history`);
  await cleanCheck(page, `${label} History AI summary`);
}

/** System status (0.34): the Data retention card, strictly — every table with a class and a window, and the sweep's state. */
async function retentionCard(page, label, vp) {
  await go(page, '/admin/status');
  const rows = page.locator('[data-testid^="retention-"]');
  await rows.first().waitFor({ timeout: 15_000 }).catch(() => {});
  const n = await rows.count();
  const text = await page.locator('main').innerText();
  const first = n ? await rows.first().innerText() : '';
  check(n >= 5 && /Data retention/.test(text) && /The retention sweep is off in this API process \(RETENTION_SWEEP=off\)/.test(text) && /(Evidence|History|Transient)/.test(first) && !/Could not load retention status/.test(text),
    `${label}: the Data retention card lists ${n} tables with their class, and says the sweep is off here`, first);
  if (vp === 'phone') await noSideScroll(page, `${label} Data retention`);
  await cleanCheck(page, `${label} Data retention card`);
}

/**
 * 0.53: the patch policy editor's maintenance window, Weekly or Monthly. The
 * monthly form (an nth or last weekday plus an offset, or a day of the month)
 * shows the next three openings, which come from the API's window preview —
 * the signer's own functions — and must be the instants those functions give.
 * Nothing is proposed: the form is cancelled, so no step-up and no policy.
 */
async function patchWindowEditor(page, f, vp, label) {
  const pp = apiRequire(path.join(API_DIR, 'dist/actions/patch-policy.js'));
  await go(page, '/patching');
  await page.locator('main select').first().selectOption(f.A.id);
  await settled(page);
  await page.getByRole('button', { name: 'New policy' }).click();
  const editor = page.locator('[data-testid="pol-window"]');
  await editor.waitFor({ timeout: 20_000 });
  check(await page.locator('[data-testid="pol-weekly"]').isChecked(), `${label}: a new policy's window starts weekly`);
  await page.locator('[data-testid="pol-monthly"]').check();
  await page.locator('[data-testid="pol-week"]').selectOption('second');
  await page.locator('[data-testid="pol-weekday"]').selectOption('tue');
  await page.locator('[data-testid="pol-offset"]').fill('2');
  const tz = await page.locator('#pol-tz').inputValue();
  const want = pp.nextOccurrences(new Date(), { kind: 'monthly', week: 'second', weekday: 'tue', offsetDays: 2, start: '22:00', end: '04:00', timezone: tz }, 3); // 0.63: the policy never expires, so the preview has no bound
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid="pol-occurrence"]').length === n && /2 days after the second Tuesday/.test(document.querySelector('[data-testid="pol-preview"]')?.textContent ?? ''), want.length, { timeout: 15_000 }).catch(() => {});
  const preview = await page.locator('[data-testid="pol-preview"]').innerText();
  const day = (d) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(d);
  check(want.length >= 1 && /2 days after the second Tuesday of each month/.test(preview) && want.every((o) => preview.includes(day(o.start))),
    `${label}: "second Tuesday + 2" previews the openings the signer's function gives (${want.map((o) => day(o.start)).join('; ')}), in ${tz}`, preview);
  await page.locator('[data-testid="pol-monthly-day"]').check();
  await page.locator('[data-testid="pol-day"]').fill('31');
  check(await page.locator('[data-testid="pol-day"]').inputValue() === '28', `${label}: a day of the month past 28 is held at 28`, await page.locator('[data-testid="pol-day"]').inputValue());
  await page.waitForFunction(() => /the 28th of each month/.test(document.querySelector('[data-testid="pol-preview"]')?.textContent ?? ''), null, { timeout: 15_000 }).catch(() => {});
  check(/the 28th of each month/.test(await page.locator('[data-testid="pol-preview"]').innerText()), `${label}: the day-of-month form previews the 28th`, await page.locator('[data-testid="pol-preview"]').innerText());
  // 0.54: the restart window — a rule, its own window editor and preview, the RustDesk exception unticked, the signed-in note.
  check(!(await page.locator('[data-testid="pol-rw-window"]').isVisible().catch(() => false)), `${label}: a new policy has no restart window until one is chosen`);
  await page.locator('[data-testid="pol-restart-rule"]').selectOption('if_required');
  await page.locator('[data-testid="pol-rw-window"]').waitFor({ timeout: 10_000 }).catch(() => {});
  const rwText = await page.locator('[data-testid="pol-restart"]').innerText().catch(() => '');
  check(await page.locator('[data-testid="pol-rw-window"]').isVisible() && /Restart window/.test(rwText) && /asked for again 15 minutes later/.test(rwText),
    `${label}: "Restart if required, in a restart window" shows a restart window editor, and says a deferred restart is asked for again`, rwText.slice(0, 300));
  check(!(await page.locator('[data-testid="pol-ignore-remote-session"]').isChecked()) && /A signed-in user does not stop the restart/.test(rwText),
    `${label}: the policy's RustDesk exception starts unticked, beside the signed-in note`, rwText.slice(-300));
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="pol-rw-occurrence"]').length >= 1, null, { timeout: 15_000 }).catch(() => {});
  check(await page.locator('[data-testid="pol-rw-occurrence"]').count() >= 1, `${label}: the restart window previews its next openings`);
  if (vp === 'phone') await noSideScroll(page, `${label} patch policy window`);
  await shot(page, `${label}-patch-policy-monthly`);
  await page.getByRole('button', { name: 'Cancel' }).first().click();
  await cleanCheck(page, `${label} patch policy editor`);
}

/**
 * 0.57: Devices → Unassigned and Devices → Deploy agents, as a Platform Admin.
 * A pooled computer (no tenant, no business) is listed with how it arrived,
 * its source address and its hardware, but not who is signed in. Assigning it
 * to A asks to confirm it is you and moves it. A deployment key asks too, is
 * shown once, is stored only as its hash, and fills in the instructions in the
 * browser. Both businesses cascade at clean-up, keys with them.
 */
async function adoptionScreens(page, f, vp, label) {
  const name = `${TAG}-POOL-${label.replace(/[^a-z]/g, '-')}`;
  const ep = await prisma.endpoint.create({ data: {
    name, hostname: name, platform: 'Windows', status: 'PENDING_ENROLLMENT', arrivedVia: 'heartbeat', sourceIp: '198.51.100.23', lastSeenAt: new Date(), isOnline: true,
    inventory: { create: { manufacturer: 'Contoso Ltd', model: 'Field Laptop 7', domain: 'pool.example.com', loggedOnUser: 'POOL\\someone' } },
  } });
  try {
    await go(page, '/admin/unassigned');
    const row = page.locator('[data-testid="unassigned-table"] tr').filter({ hasText: name });
    await row.waitFor({ timeout: 15_000 }).catch(() => {});
    const text = await row.innerText().catch(() => '');
    check(/Agent check-in/.test(text) && text.includes('198.51.100.23') && /Contoso Ltd Field Laptop 7/.test(text), `${label}: Unassigned lists the pooled computer with how it arrived, its source address and hardware`, text);
    await row.getByRole('button', { name }).click();
    const all = await page.locator('main').innerText();
    check(/pool\.example\.com/.test(all) && !/someone/.test(all), `${label}: its details show the domain and never who is signed in`);
    if (vp === 'phone') await noSideScroll(page, `${label} Unassigned`);
    await shot(page, `${label}-unassigned`);
    await row.getByRole('checkbox').check();
    await page.locator('#adopt-business').selectOption(f.A.id);
    await forgetStepUp(page);
    await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': ip() });
    await page.locator('[data-testid="adoption-bulk"]').getByRole('button', { name: 'Assign', exact: true }).click();
    await confirmStepUp(page, label, 'assigning a computer');
    let moved = null;
    for (let i = 0; i < 30 && !moved; i++) { await sleep(300); moved = (await prisma.endpoint.findUnique({ where: { id: ep.id } }))?.customerId === f.A.id ? true : null; }
    const audit = await prisma.activityLog.findFirst({ where: { action: 'ENDPOINT_ADOPTED', resourceId: ep.id } });
    check(!!moved && audit?.actorId === f.admin.id, `${label}: Assign moved it into A, audited with the approver`, JSON.stringify(audit?.metadata ?? null));
    await cleanCheck(page, `${label} Unassigned`, stepUp403);

    await go(page, '/admin/deploy');
    if (vp === 'phone') await noSideScroll(page, `${label} Deploy agents`);
    const keyName = `${TAG} key ${label}`;
    await page.locator('#key-business').selectOption(f.A.id);
    await page.getByPlaceholder('Acme GPO rollout, November').fill(keyName);
    await forgetStepUp(page);
    await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': ip() });
    await page.getByRole('button', { name: 'Create key' }).click();
    await confirmStepUp(page, label, 'creating a deployment key');
    const once = page.locator('[data-testid="deployment-key-once"]');
    await once.waitFor({ timeout: 15_000 }).catch(() => {});
    const shown = ((await once.locator('code').innerText().catch(() => '')) || '').trim();
    const row2 = await prisma.deploymentKey.findFirst({ where: { customerId: f.A.id, name: keyName } });
    check(/^[0-9a-f]{96}$/.test(shown) && row2?.keyHash === sha256(shown) && row2?.mode === 'review', `${label}: the key is shown once, stored only as its hash, review by default`, shown.slice(0, 12));
    const gpo = await page.locator('pre').first().innerText().catch(() => '');
    check(gpo.includes(`/api/v1/public/install/win/${shown}`) && /Rem0teHeartbeat/.test(gpo), `${label}: the Group Policy script has the key filled in by the browser`);
    // 0.65: the .msi tab — the plain package carries no key; the key goes in TOKEN.
    await page.getByRole('tab', { name: 'Windows Installer (.msi)' }).click();
    const msiCode = (await page.locator('[role="tabpanel"][data-state="active"] pre').allInnerTexts().catch(() => [])).join('\n');
    check(msiCode.includes(`msiexec /i rem0te.msi TOKEN=${shown} /qn`) && /\/api\/v1\/public\/install\/windows\.msi\n/.test(`${msiCode}\n`) && /has not yet been run on real Windows/.test(await page.locator('[role="tabpanel"][data-state="active"]').innerText().catch(() => '')),
      `${label}: the Windows Installer tab gives the key-free .msi URL and msiexec … TOKEN=<key> /qn, and says it has not run on real Windows`, msiCode.slice(0, 300));
    await page.getByRole('tab', { name: 'Group Policy' }).click();
    await shot(page, `${label}-deploy-agents`);
    await once.getByRole('button', { name: 'I have stored it' }).click();
    await page.getByPlaceholder(/Paste a deployment key/).fill('');
    check((await page.locator('pre').first().innerText()).includes('<DEPLOYMENT-KEY>'), `${label}: with no key entered the commands show the placeholder`);
    await cleanCheck(page, `${label} Deploy agents`, stepUp403);
  } finally {
    await prisma.endpointGroupMember.deleteMany({ where: { endpointId: ep.id } }).catch(() => {});
    await prisma.endpointInventory.deleteMany({ where: { endpointId: ep.id } }).catch(() => {});
    await prisma.endpoint.deleteMany({ where: { id: ep.id } }).catch(() => {});
  }
}

/**
 * 0.58: Automation → Schedules. This stack has no approval signer, so the
 * list must say so (with the reason), show its empty state and offer no
 * "New schedule". The editor still works out an hourly schedule's next runs
 * through the preview route — the signer's own functions — and refuses
 * nothing silently. Nothing is proposed.
 */
async function automationSchedules(page, f, vp, label) {
  await go(page, '/automation/schedules');
  const text = await page.locator('main').innerText();
  check(/Automation schedules need the approval signer/.test(await page.locator('[data-testid="schedule-not-ready"]').innerText().catch(() => ''))
      && await page.locator('[data-testid="schedules-empty"]').isVisible().catch(() => false)
      && !(await page.locator('[data-testid="schedule-new"]').isVisible().catch(() => false)),
    `${label}: Schedules without a signer: says why, shows the empty state, offers no New schedule`, text.slice(0, 400));
  if (vp === 'phone') await noSideScroll(page, `${label} schedules`);
  await cleanCheck(page, `${label} schedules list`);
  await go(page, '/automation/schedules/new');
  await page.locator('[data-testid="rec-hourly"]').check();
  await page.locator('[data-testid="hourly-every"]').selectOption('6');
  await page.waitForFunction(() => /Every 6 hours at :00/.test(document.querySelector('[data-testid="schedule-preview"]')?.textContent ?? ''), null, { timeout: 15_000 }).catch(() => {});
  const prev = await page.locator('[data-testid="schedule-preview"]').innerText().catch(() => '');
  check(/Every 6 hours at :00/.test(prev) && (prev.match(/–/g) ?? []).length >= 3, `${label}: the editor previews an hourly schedule's next runs from the server`, prev.slice(0, 300));
  check(/does not expire/.test(await page.locator('[data-testid="schedule-no-expiry"]').innerText().catch(() => '')) && !/Expires after/.test(await page.locator('main').innerText()),
    `${label}: 0.63: the schedule editor asks for no expiry and says the schedule does not expire`);
  check(await page.locator('[data-testid="schedule-create"]').isDisabled() && /Give it a name|Choose/.test(await page.locator('[data-testid="schedule-problem"]').innerText().catch(() => '')),
    `${label}: Propose stays disabled, and says what is missing`);
  if (vp === 'phone') await noSideScroll(page, `${label} schedule editor`);
  await shot(page, `${label}-automation-schedule-new`);
  await cleanCheck(page, `${label} schedule editor`);
}

/**
 * 0.62: the patching forms in both approval modes. This stack has no approval
 * signer, so the mode the console mirrors (GET /actions/catalog's `approval`)
 * is answered here, once 'signed' and once 'direct'. Signed mode keeps
 * 0.61's words: "Propose for approval" and a reason for the approvers. Direct
 * mode says "Create policy", asks for no reason and says it is active at
 * once. In both, "Test on one computer first" starts unticked and the
 * computers are ticked, not put in rings. Nothing is submitted.
 */
async function patchingApprovalModes(page, f, vp, label) {
  for (const mode of ['signed', 'direct']) {
    const fake = async (route) => {
      const res = await route.fetch();
      const body = await res.json().catch(() => ({}));
      await route.fulfill({ response: res, json: { ...body, data: { ...(body.data ?? {}), approval: mode } } });
    };
    await page.route('**/api/v1/actions/catalog**', fake);
    try {
      await go(page, '/patching');
      await page.locator('main select').first().selectOption(f.A.id);
      await settled(page);
      // A patch policy.
      await page.getByRole('button', { name: 'New policy' }).click();
      await page.locator('[data-testid="pol-submit"]').waitFor({ timeout: 20_000 });
      await page.waitForFunction((m) => (document.querySelector('[data-testid="pol-submit"]')?.textContent ?? '').includes(m === 'direct' ? 'Create policy' : 'Propose for approval'), mode, { timeout: 15_000 }).catch(() => {});
      const btn = (await page.locator('[data-testid="pol-submit"]').innerText()).trim();
      const reason = await page.locator('[data-testid="pol-reason"]').isVisible().catch(() => false);
      const note = await page.locator('[data-testid="pol-direct-note"]').isVisible().catch(() => false);
      const testFirst = page.locator('[data-testid="pol-test-first"]');
      check(await testFirst.isVisible() && !(await testFirst.isChecked()), `${label} (${mode}): a new patch policy installs all at once — "Test on one computer first" starts unticked`);
      if (mode === 'direct') {
        check(btn === 'Create policy' && !reason && note && !/Propose for approval|approvers/i.test(await page.locator('[data-testid="pol-direct-note"]').innerText()),
          `${label} (direct): the policy form says "Create policy", asks for no approvers' reason, and says it is active at once`, `button "${btn}", reason shown ${reason}, note ${note}`);
      } else {
        check(btn === 'Propose for approval' && reason && !note, `${label} (signed): the policy form keeps "Propose for approval" and the approvers' reason`, `button "${btn}", reason shown ${reason}, note ${note}`);
      }
      await testFirst.check();
      const staged = await page.locator('[data-testid="pol-staging"]').innerText();
      check(/One device installs first/.test(staged) && /Soak between rings/.test(await page.locator('main').innerText()),
        `${label} (${mode}): ticking "Test on one computer first" brings back the canary, the rings and the soak`, staged.slice(0, 200));
      if (vp === 'phone') await noSideScroll(page, `${label} patch policy (${mode})`);
      await shot(page, `${label}-patch-policy-${mode}`);
      await page.getByRole('button', { name: 'Cancel' }).first().click();
      // A company-wide policy, where this business has none yet.
      const cw = page.getByRole('button', { name: 'Company-wide policy' });
      if (await cw.isVisible().catch(() => false)) {
        await cw.click();
        await page.locator('[data-testid="ser-submit"]').waitFor({ timeout: 20_000 });
        await page.waitForFunction((m) => (document.querySelector('[data-testid="ser-submit"]')?.textContent ?? '').includes(m === 'direct' ? 'Create policy' : 'Create'), mode, { timeout: 15_000 }).catch(() => {});
        const sbtn = (await page.locator('[data-testid="ser-submit"]').innerText()).trim();
        const sreason = await page.locator('[data-testid="ser-reason"]').isVisible().catch(() => false);
        check(!(await page.locator('[data-testid="ser-test-first"]').isChecked()) && (mode === 'direct' ? sbtn === 'Create policy' && !sreason : sbtn === 'Create' && sreason),
          `${label} (${mode}): the company-wide form starts all at once, and ${mode === 'direct' ? 'says "Create policy" with no reason' : 'keeps "Create" and the approvers\' reason'}`, `button "${sbtn}", reason shown ${sreason}`);
        await page.getByRole('button', { name: 'Cancel' }).first().click();
      }
      // A one-off deployment.
      await page.getByRole('button', { name: 'New deployment' }).click();
      await page.locator('[data-testid="dep-create"]').waitFor({ timeout: 20_000 });
      check(!(await page.locator('[data-testid="dep-test-first"]').isChecked()), `${label} (${mode}): a new deployment installs all at once — "Test on one computer first" starts unticked`);
      await page.getByRole('button', { name: 'Cancel' }).first().click();
      await cleanCheck(page, `${label} patching forms (${mode})`);
    } finally {
      await page.unroute('**/api/v1/actions/catalog**', fake);
    }
  }
}

async function coverage035(page, f, vp, label) {
  await adoptionScreens(page, f, vp, label);
  await patchWindowEditor(page, f, vp, label);
  await patchingApprovalModes(page, f, vp, label);
  await automationSchedules(page, f, vp, label);
  await chatTab(page, f, vp, label);
  await scriptRunPanel(page, f, vp, label);
  await softwareCatalog(page, f, vp, label);
  await emailSettings(page, f, vp, label);
  await scheduledReports(page, f, vp, label);
  await agentCardAndMigrations(page, f, vp, label);
  await aiHistoryPanel(page, f, vp, label);
  await retentionCard(page, label, vp);
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

/**
 * 0.36: the tray's chat window, /assist, at the size the tray opens it (a
 * 440 × 640 window: about 420 × 600 of page) and smaller (320 × 480), in the
 * light and dark schemes the page takes from the system. A simulated signed
 * tray mints the one-time code over the real device route; the browser opens
 * /assist/open?c=… through the web server's rewrite exactly as WebView2
 * would. Proves: the code leaves the address bar, the page loads with its
 * strict CSP and no console error (a CSP violation is one), the person starts
 * a chat, a technician's reply appears as text, receipts reach the server,
 * Enter sends, ending takes two clicks, nothing scrolls sideways, and going
 * back to the code's URL shows the used-link page, not the chat.
 */
async function assistWindow(browser, f) {
  section('Tray chat window (/assist) at the tray\'s window size');
  const secret = randomBytes(24).toString('hex');
  const rid = String(100000000 + ((Math.random() * 899999999) | 0));
  const name = `${TAG}-TRAY`.toUpperCase();
  const ep = await prisma.endpoint.create({ data: {
    tenantId: f.tenant.id, customerId: f.A.id, name, hostname: name, platform: 'Windows', osVersion: 'Windows 11 Pro', status: 'ACTIVE',
    isOnline: true, isManaged: true, accessMode: 'COMPANY_WIDE', lastSeenAt: new Date(), deviceClass: 'WORKSTATION', agentVersion: '0.36.0',
    updateChannel: 'signed', chatProtocol: 2, trayProtocol: 1,
  } });
  await prisma.rustdeskNode.create({ data: { tenantId: f.tenant.id, endpointId: ep.id, rustdeskId: rid, agentSecretHash: sha256(secret) } });
  // The technician's side, straight to the API with a session of its own.
  const techIp = ip();
  const login = await fetch(`${API_ORIGIN}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': techIp }, body: JSON.stringify({ email: f.admin.email, password: PW }) });
  const techCookie = (login.headers.get('set-cookie') ?? '').match(/access_token=[^;]+/)?.[0];
  const tech = async (method, p, body) => {
    await sleep(60);
    const r = await fetch(`${API_ORIGIN}/api/v1${p}`, { method, headers: { 'content-type': 'application/json', 'x-forwarded-for': techIp, cookie: techCookie }, body: body ? JSON.stringify(body) : undefined });
    return r.json().catch(() => ({}));
  };
  const sizes = [['tray window', { width: 420, height: 600 }, 'light'], ['small window', { width: 320, height: 480 }, 'dark']];
  try {
    for (const [what, viewport, scheme] of sizes) {
      const label = `assist ${viewport.width}×${viewport.height} ${scheme}`;
      const code = (await deviceReq('POST', '/tray/chat-code', { body: { rustdeskId: rid, agentSecret: secret, localUser: 'CORP\\frontdesk' } })).data?.code;
      check(typeof code === 'string' && code.length === 43, `${label}: the simulated tray gets a one-time code`);
      const ctx = await browser.newContext({ viewport, colorScheme: scheme, extraHTTPHeaders: { 'x-forwarded-for': ip() } });
      try {
        const page = await ctx.newPage();
        instrument(page);
        await page.goto(`${WEB}/assist/open?c=${encodeURIComponent(code)}`);
        await page.locator('#start, #log').first().waitFor({ timeout: 15_000 }).catch(() => {});
        await sleep(300);
        check(new URL(page.url()).pathname === '/assist/chat' && !page.url().includes(code), `${label} (${what}): the code is gone from the address bar`, page.url());
        const cookies = await ctx.cookies();
        const c = cookies.find((k) => k.name === 'rem0te_assist');
        check(c && c.httpOnly && c.sameSite === 'Strict' && c.path === '/assist' && !cookies.some((k) => k.name === 'access_token'), `${label}: an HttpOnly, SameSite=Strict cookie on /assist and no portal session`, JSON.stringify(cookies.map((k) => k.name)));
        const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
        check(scheme === 'dark' ? lum(bg) < 0.25 : lum(bg) > 0.8, `${label}: the page follows the ${scheme} scheme`, bg);
        check(await page.locator('#start').isVisible() && /Acme/.test(await page.locator('#brand').innerText()), `${label}: no chat yet — the start form, under the business's name`);
        check(/recorded/.test(await page.locator('#recording').innerText()), `${label}: it says whether the chat is recorded`);

        await page.locator('#start-text').fill(`Printer jammed ${what}`);
        await page.locator('#start-send').click();
        await page.locator('#compose').waitFor({ timeout: 10_000 }).catch(() => {});
        check(await page.locator('#compose').isVisible() && /Printer jammed/.test(await page.locator('#log').innerText()), `${label}: starting shows the chat with the first message`);
        const conv = await prisma.chatConversation.findFirst({ where: { endpointId: ep.id, status: 'OPEN' }, orderBy: { createdAt: 'desc' } });
        check(conv?.startedBy === 'end_user' && !!conv.supportRequestId, `${label}: a chat started from the tray, with its support request`);

        const reply = `<img src=x onerror=alert(1)> try turning it off and on ${what}`;
        const sent = await tech('POST', `/endpoints/${ep.id}/chat/conversations/${conv.id}/messages`, { text: reply });
        const mid = sent?.data?.message?.id;
        const shown = await page.waitForFunction((t) => document.getElementById('log')?.innerText.includes(t), reply, { timeout: 15_000 }).then(() => true).catch(() => false);
        check(shown && await page.locator('#log img').count() === 0, `${label}: the technician's reply appears, as text (no element made from it)`);
        await page.bringToFront();
        const receipt = await (async () => { for (let i = 0; i < 20; i++) { const m = mid && await prisma.chatMessage.findUnique({ where: { id: mid } }); if (m?.shownAt) return m; await sleep(500); } return null; })();
        check(!!receipt?.shownAt, `${label}: the page reports the reply shown`);

        await page.locator('#text').fill(`It worked ${what}`);
        await page.locator('#text').press('Enter');
        const back = await (async () => { for (let i = 0; i < 20; i++) { const n = await prisma.chatMessage.count({ where: { conversationId: conv.id, sender: 'END_USER', body: `It worked ${what}` } }); if (n) return n; await sleep(300); } return 0; })();
        check(back === 1, `${label}: Enter sends the reply, stored once`);
        const ov = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth - document.documentElement.clientWidth, body: document.body.scrollWidth - document.body.clientWidth }));
        check(ov.doc <= 1 && ov.body <= 1, `${label}: nothing scrolls sideways`, JSON.stringify(ov));
        const box = await page.locator('#send').boundingBox();
        check(box && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height, `${label}: Send is on screen without scrolling`, JSON.stringify(box));
        await shot(page, `assist-${viewport.width}-${scheme}`);

        await page.locator('#end').click();
        check(/Yes, end it/.test(await page.locator('#end').innerText()), `${label}: End chat asks once more`);
        await page.locator('#end').click();
        await page.waitForFunction(() => /ended/.test(document.getElementById('note')?.innerText ?? ''), null, { timeout: 10_000 }).catch(() => {});
        check(/You ended this chat/.test(await page.locator('#note').innerText()) && await page.locator('#text').isDisabled(), `${label}: ended — the page says so and stops taking text`);
        check((await prisma.chatConversation.findUnique({ where: { id: conv.id } }))?.status === 'ENDED', `${label}: and the server has it ended`);

        await page.goto(`${WEB}/assist/open?c=${encodeURIComponent(code)}`);
        check(/already been used or has expired/.test(await page.locator('body').innerText()), `${label}: the code's URL again (history) shows the used-link page`);
        const probs = takeProblems(page, (p) => p.kind === 'http' && p.status === 410 && /^\/assist\/open/.test(p.url));
        check(probs.length === 0, `${label}: no console error (a CSP violation would be one), no failed request`, fmtProblems(probs));
      } finally { await ctx.close(); }
    }
  } finally {
    const convs = await prisma.chatConversation.findMany({ where: { endpointId: ep.id }, select: { supportRequestId: true } }).catch(() => []);
    await prisma.supportRequest.deleteMany({ where: { id: { in: convs.map((c) => c.supportRequestId).filter(Boolean) } } }).catch(() => {});
    await prisma.chatConversation.deleteMany({ where: { endpointId: ep.id } }).catch(() => {});
    await prisma.assistSession.deleteMany({ where: { endpointId: ep.id } }).catch(() => {});
    await prisma.assistCode.deleteMany({ where: { endpointId: ep.id } }).catch(() => {});
    await prisma.endpoint.delete({ where: { id: ep.id } }).catch(() => {});
  }
}

// ── Run ─────────────────────────────────────────────────────────────────────
let copyDir = null;
// ── 0.80: Devices → Mobile devices ─────────────────────────────────────────
// Rows written straight to this suite's database (MDM_SWEEP is off: nothing
// syncs). Business A gets a stand-in connector — ready, because the API runs
// under NODE_ENV=test with a loopback MDM_TEST_BASE_URL nothing listens on —
// two devices and two commands: a lock the provider ACCEPTED that the device
// has not finished, and a sync it completed. A business of its own, with its
// own owner and no connector, shows "Requires setup" and the empty state.
/**
 * Settings → Mobile devices (0.83 Beacon) fixtures: the one platform row,
 * written directly (the browser suite only reads it). A real CSR and a
 * TEST ONLY stand-in push certificate for it, made at run time by the API's
 * test-pki helper; the sealed columns hold sealed-shaped placeholders, which
 * the page never opens. Nothing here is a real Apple or Google credential.
 */
async function seedMdmSetup(f) {
  const T = await import(path.join(API_DIR, 'scripts/lib/test-pki.mjs'));
  const g = T.P.generatePushKey();
  const topic = T.testTopic();
  const now = new Date();
  const cert = T.pushCertFor({ csrPem: g.csrPem, topic, now, notAfter: new Date(now.getTime() + 200 * 86_400_000) });
  const facts = T.P.certFacts(cert.cert);
  const sealedLike = () => `${randomBytes(12).toString('hex')}:${randomBytes(16).toString('hex')}:${randomBytes(48).toString('hex')}`;
  await prisma.mdmPlatformSetup.update({
    where: { id: 'platform' },
    data: {
      revision: { increment: 1 }, appleChecklist: ['duns'], androidChecklist: [], signingRoute: 'own_vendor',
      pushKeyEnc: sealedLike(), pushCsrPem: g.csrPem, pushKeySpkiSha256: g.spkiSha256, pushKeyCreatedAt: now,
      vendorKeyEnc: null, vendorCertPem: null, vendorChainPem: null, vendorNotAfter: null, vendorSetAt: null,
      pushCertEnc: sealedLike(), pushCertSerial: facts.serial, pushCertSha256: facts.sha256, pushCertIssuer: T.P.nameText(facts.issuer).slice(0, 300),
      pushCertNotBefore: facts.notBefore, pushCertNotAfter: facts.notAfter, pushCertInstalledAt: now, pushCertRenewedAt: null,
      apnsTopic: topic, appleAccount: 'mdm-push@example.test', pushRemindedDays: null,
      // 0.85 Mooring: a sealed-shaped key that passed the connection test, and a recorded quota.
      androidKeyEnc: sealedLike(), androidProjectId: 'rem0te-ui-test', androidClientEmail: 'amapi-ui@rem0te-ui-test.iam.gserviceaccount.com', androidKeyIdLast4: 'a1b2', androidKeySetAt: now,
      androidTestedAt: now, androidTestResult: 'ok', androidQuotaDevices: 250, androidQuotaSetAt: now,
    },
  });
  // 0.85: business B bound to a (stand-in) Android enterprise with the default policy applied. Written
  // directly; the browser suite never reaches Google (its API has no AMAPI_TEST_BASE_URL, so it refuses).
  const signup = await prisma.androidSignup.create({ data: {
    tenantId: f.tenant.id, customerId: f.B.id, stateSha256: createHash('sha256').update(randomBytes(32)).digest('hex'), signupUrlName: `signupUrls/Cui${sfx}`,
    state: 'bound', createdById: f.admin.id, createdAt: now, expiresAt: new Date(now.getTime() + 30 * 60_000), claimedAt: now, finishedAt: now, enterpriseId: `LCui${sfx}`,
  } });
  await prisma.androidEnterprise.create({ data: {
    tenantId: f.tenant.id, customerId: f.B.id, enterpriseId: `LCui${sfx}`, signupId: signup.id, boundById: f.admin.id, boundAt: now, policyVersion: '1', policySetAt: now,
  } });
  return { topic, enterpriseId: `LCui${sfx}` };
}

/**
 * Settings → Mobile devices (0.83), as the Platform Admin, at both widths and
 * in both themes. Read-only except a delete dialog that is cancelled: the
 * Apple card with the push certificate's topic, expiry and account, the
 * loud same-account renewal warning, the mdmcert.download caveats, ABM
 * planned; the Android card with Google's permitted-use note and enterprise
 * sign-up planned; every capability in one of the four states; deleting the
 * push certificate warns that devices are orphaned. No sideways scroll at
 * 375 px.
 */
async function mdmSettingsUi(page, f, vp, theme, label) {
  await go(page, '/settings/mobile-devices');
  await page.getByTestId('mdm-apple').waitFor({ timeout: 15_000 }).catch(() => {});
  await page.getByTestId('mdm-pushcert').waitFor({ timeout: 15_000 }).catch(() => {});
  const pc = await page.getByTestId('mdm-pushcert').innerText().catch(() => '');
  check(pc.includes(f.mdmSetup.topic) && /mdm-push@example\.test/.test(pc) && /Not yet \(step 6\)/.test(pc) && /days\)/.test(pc),
    `${label}: Settings → Mobile devices shows the push certificate's topic, expiry, account, and "not yet proven"`, pc.slice(0, 300));
  const warn = await page.getByTestId('mdm-renewal-warning').innerText().catch(() => '');
  check(/same Apple Account/.test(warn) && /every enrolled iPhone and iPad/.test(warn), `${label}: renewal warns loudly to use the same Apple Account`, warn.slice(0, 200));
  const prereq = await page.getByTestId('mdm-apple-prereqs').innerText().catch(() => '');
  check(/D-U-N-S/.test(prereq) && /99 USD a year/.test(prereq) && /MDM CSR/.test(prereq) && await page.getByTestId('mdm-apple-tick-duns').isChecked().catch(() => false),
    `${label}: the Apple prerequisites with cost and lead time, and the owner's tick`, prereq.slice(0, 200));
  const links = await page.locator('[data-testid="mdm-settings"] a[target="_blank"]').evaluateAll((els) => els.map((e) => [e.getAttribute('href'), e.getAttribute('rel')]));
  check(links.length >= 8 && links.every(([h, r]) => /^https:\/\//.test(h) && r === 'noopener noreferrer'), `${label}: Apple's and Google's pages open in a new tab, noopener`, JSON.stringify(links.slice(0, 3)));
  await page.getByTestId('mdm-route-mdmcert').check().catch(() => {});
  await page.getByTestId('mdm-mdmcert').waitFor({ timeout: 10_000 }).catch(() => {});
  const mc = await page.getByTestId('mdm-mdmcert').innerText().catch(() => '');
  check(/one test device only/i.test(mc) && /revoke/.test(mc), `${label}: mdmcert.download is shown as test-only, with its trust caveats`, mc.slice(0, 200));
  await page.getByTestId('mdm-route-own_vendor').check().catch(() => {});
  await page.getByTestId('mdm-vendor-form').waitFor({ timeout: 10_000 }).catch(() => {});
  const perm = await page.getByTestId('mdm-android-permitted-use').innerText().catch(() => '');
  check(/commercial EMM/.test(perm) && /customers/.test(perm), `${label}: the Android card carries Google's permitted-use note (decision 21)`, perm.slice(0, 200));
  const states = await page.locator('[data-testid="mdm-capabilities"] [data-capability]').evaluateAll((els) => els.map((e) => [e.getAttribute('data-capability'), e.getAttribute('data-state')]));
  const st = Object.fromEntries(states);
  check(st['apple.push_certificate'] === 'available' && st['apple.enrollment'] === 'requires_setup' && st['apple.device_ca'] === 'requires_setup' && st['apple.profile_signer'] === 'requires_setup' && st['apple.abm'] === 'planned' && st['android.service_account'] === 'available'
    && st['android.connection_test'] === 'available' && st['android.quota'] === 'available' && st['android.enterprise'] === 'available' && st['android.enrollment'] === 'requires_setup' && st['apple.ios15'] === 'unsupported' && states.every(([, v]) => ['available', 'requires_setup', 'unsupported', 'planned'].includes(v)),
  `${label}: every capability in one of the four states`, JSON.stringify(st));
  // 0.84 Harbor: step 6 — the device CA and the signer are asked for first; no link can be made before both.
  const enroll = await page.getByTestId('mdm-apple-enroll').innerText().catch(() => '');
  check(/Device CA \(public certificates\)/.test(enroll) && /The CA.s key stays with the CA/.test(enroll) && /Upload the device CA and the profile signer first/.test(enroll)
    && /Not yet proven/.test(enroll) && /sends no lock, wipe/.test(enroll) && await page.getByTestId('mdm-deviceca-upload').isDisabled().catch(() => false)
    && await page.getByTestId('mdm-link-create').count() === 0,
  `${label}: step 6 asks for the device CA and the profile signer before any enrollment link, says nothing is proven yet and that only inventory is asked`, enroll.slice(0, 300));
  // 0.85 Mooring: Android steps 3–6, read-only here (the suite's API cannot reach Google, or a stand-in).
  const aTest = await page.getByTestId('mdm-android-step-test').innerText().catch(() => '');
  const aTestState = await page.getByTestId('mdm-android-step-test').getAttribute('data-state').catch(() => null);
  const aResult = await page.getByTestId('mdm-android-test-result').getAttribute('data-result').catch(() => null);
  check(aTestState === 'available' && aResult === 'ok' && /passed/.test(aTest) && /cannot check quota/.test(aTest), `${label}: Android step 3 shows the passed connection test, and that quota cannot be checked`, aTest.slice(0, 200));
  const aQuota = await page.getByTestId('mdm-android-quota-facts').innerText().catch(() => '');
  check(/Recorded 250/.test(aQuota), `${label}: Android step 4 shows the recorded quota`, aQuota);
  const aSign = await page.getByTestId('mdm-android-step-signup').innerText().catch(() => '');
  check(aSign.includes(`enterprises/${f.mdmSetup.enterpriseId}`) && aSign.includes(f.B.name) && /managed Google domain/.test(aSign) && /policy version 1/.test(aSign),
    `${label}: Android step 5 lists the bound business with its enterprise and policy, and recommends a managed Google domain`, aSign.slice(0, 300));
  const aEnroll = await page.getByTestId('mdm-android-step-enroll').innerText().catch(() => '');
  const usages = await page.getByTestId('mdm-android-token-usage').locator('option').allInnerTexts().catch(() => []);
  check(/never turns on network info/.test(aEnroll) && /BYOD/.test(aEnroll) && /never keeps its serial/.test(aEnroll) && /no real Android device has enrolled/.test(aEnroll)
    && usages.join('|') === 'Work profile (personal phone)|Fully managed (company phone)' && await page.getByTestId('mdm-android-token-create').isDisabled().catch(() => false),
  `${label}: Android step 6 says the policy never turns on network info, offers work profile or fully managed per token, and that no real device has enrolled`, aEnroll.slice(0, 300));
  const notProven = await page.getByTestId('mdm-android-not-proven').innerText().catch(() => '');
  check(/no real Google API has been called/.test(notProven) && /no enterprise has been created/.test(notProven), `${label}: the Android card says plainly nothing was proven against Google`, notProven);
  await page.getByTestId('mdm-pushcert-delete').click().catch(() => {});
  const dlg = page.getByRole('alertdialog').or(page.getByRole('dialog')).first();
  await dlg.waitFor({ timeout: 10_000 }).catch(() => {});
  const dt = await dlg.innerText().catch(() => '');
  check(/orphaned/.test(dt) && /does not ask you to confirm it is you/.test(dt), `${label}: deleting the push certificate warns that devices are orphaned, and asks no confirmation of identity`, dt.slice(0, 200));
  await dlg.getByRole('button', { name: 'Cancel' }).click().catch(() => {});
  await themeCheck(page, theme, `${label} Settings → Mobile devices`);
  if (vp === 'phone') await noSideScroll(page, `${label} Settings → Mobile devices`);
  await shot(page, `${label}-settings-mobile-devices`);
  await cleanCheck(page, `${label} Settings → Mobile devices`);
  // Google's redirect back after a sign-up: the page reads ?android=… once, says what happened, and clears it.
  await go(page, '/settings/mobile-devices?android=failed&code=bad_token&business=x');
  await page.getByTestId('mdm-settings-note').waitFor({ timeout: 15_000 }).catch(() => {});
  const note = await page.getByTestId('mdm-settings-note').innerText().catch(() => '');
  check(/did not finish/.test(note) && /enterprise token/.test(note) && !/android=/.test(page.url()), `${label}: after Google's redirect the page says why the sign-up failed, and clears the address`, `${note} ${page.url()}`);
}

async function seedMobile(f) {
  const E = await prisma.customer.create({ data: { tenantId: f.tenant.id, name: `MDM ${sfx} Empty` } });
  created.businesses.push(E.id);
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });
  const ownerE = await prisma.user.create({ data: { email: `ui-mdm-owner-${sfx}@test.invalid`, passwordHash: await argon2.hash(PW, { type: argon2.argon2id }), firstName: 'UI', lastName: 'mdm', status: 'ACTIVE' } });
  created.users.push(ownerE.id);
  await prisma.membership.create({ data: { userId: ownerE.id, tenantId: f.tenant.id, customerId: E.id, roleId: roleOwner.id } });
  const now = Date.now();
  const k = await prisma.mdmConnector.create({ data: { tenantId: f.tenant.id, customerId: f.A.id, provider: 'standin', externalTenantId: `ui-${sfx}`, enabled: true, lastSyncAt: new Date(now - 5 * 60_000), lastSyncResult: 'ok', lastSyncDevices: 2 } });
  const dev = (data) => prisma.mobileDevice.create({ data: { tenantId: f.tenant.id, customerId: f.A.id, connectorId: k.id, provider: 'standin', lastSyncedAt: new Date(now - 5 * 60_000), ...data } });
  const ipad = await dev({ providerDeviceId: `ui-ipad-${sfx}`, name: `${TAG} Front desk iPad`, platform: 'ipados', ownership: 'corporate', managementScope: 'device', enrollmentState: 'enrolled',
    complianceState: 'compliant', model: 'iPad (10th generation)', manufacturer: 'Apple', osVersion: '18.1', serialNumber: 'DMPXK12ABCD', storageTotalBytes: 64_000_000_000n, storageFreeBytes: 20_000_000_000n, lastCheckInAt: new Date(now - 9 * 60_000) });
  const pixel = await dev({ providerDeviceId: `ui-pixel-${sfx}`, name: `${TAG} Jo personal Pixel`, platform: 'android', ownership: 'byod', managementScope: 'work_profile', enrollmentState: 'enrolled',
    complianceState: 'noncompliant', complianceReason: 'Screen lock required by the work profile policy', model: 'Pixel 8', manufacturer: 'Google', osVersion: '15', lastCheckInAt: new Date(now - 3 * 60_000) });
  const cmd = (data) => prisma.mdmCommand.create({ data: { tenantId: f.tenant.id, customerId: f.A.id, mobileDeviceId: ipad.id, connectorId: k.id, origin: 'provider', ...data } });
  await cmd({ providerCommandId: `ui-lock-${sfx}`, kind: 'lock', state: 'acknowledged', requestedAt: new Date(now - 30 * 60_000), sentAt: new Date(now - 30 * 60_000), providerAcceptedAt: new Date(now - 29 * 60_000), expiresAt: new Date(now + 86_400_000) });
  await cmd({ providerCommandId: `ui-sync-${sfx}`, kind: 'sync', state: 'completed', requestedAt: new Date(now - 90 * 60_000), sentAt: new Date(now - 90 * 60_000), providerAcceptedAt: new Date(now - 89 * 60_000), deviceCompletedAt: new Date(now - 80 * 60_000), expiresAt: new Date(now + 86_400_000) });
  // 0.86 (§95): an Apple device on Rem0te's own connector, so the device page offers a lock. The suite never confirms one.
  const ka = await prisma.mdmConnector.create({ data: { tenantId: f.tenant.id, customerId: f.A.id, provider: 'apple', externalTenantId: 'rem0te', enabled: true, lastSyncAt: new Date(now - 5 * 60_000), lastSyncResult: 'ok', lastSyncDevices: 1 } });
  const iphone = await prisma.mobileDevice.create({ data: { tenantId: f.tenant.id, customerId: f.A.id, connectorId: ka.id, provider: 'apple', providerDeviceId: `ui-iphone-${sfx}`, name: `Lighthouse ${sfx} iPhone`,
    platform: 'ios', ownership: 'corporate', managementScope: 'device', enrollmentState: 'enrolled', complianceState: 'unknown', lastSyncedAt: new Date(now - 5 * 60_000) } });
  return { E, ownerE, ipad, pixel, iphone };
}

async function mobileDevicesUi(page, f, vp, theme, label) {
  const m = f.mobile;
  await go(page, '/mobile-devices');
  await page.getByTestId('mdm-rows').waitFor({ timeout: 15_000 }).catch(() => {});
  const h1 = await page.locator('main h1').first().innerText().catch(() => '');
  const setupState = await page.getByTestId('mdm-setup').getAttribute('data-state').catch(() => null);
  const rows = await page.locator('[data-testid="mdm-rows"] li').evaluateAll((els) => els.map((e) => ({ c: e.getAttribute('data-compliance'), t: e.textContent ?? '' })));
  const ours = rows.filter((r) => r.t.includes(TAG));
  check(h1 === 'Mobile devices' && setupState === 'available' && ours.length === 3 && /nothing can be erased/.test(await page.getByTestId('mdm-readonly-note').innerText().catch(() => '')),
    `${label}: Mobile devices lists the three devices (0.86: an iPhone joins them), says nothing can be erased, and the provider is available`, JSON.stringify({ h1, setupState, ours: ours.length }));
  const cur = await page.locator('[data-section-tabs="devices"] a[aria-current="page"]').innerText().catch(() => null);
  check(cur === 'Mobile devices', `${label}: Mobile devices is the current Devices tab`, String(cur));
  await page.getByTestId('mdm-count-noncompliant').click();
  await page.waitForFunction(() => {
    const r = [...document.querySelectorAll('[data-testid="mdm-rows"] li')];
    return r.length > 0 && r.every((x) => x.getAttribute('data-compliance') === 'noncompliant');
  }, null, { timeout: 15_000 }).catch(() => {});
  const nc = await page.locator('[data-testid="mdm-rows"] li').evaluateAll((els) => els.map((e) => e.textContent ?? ''));
  check(nc.length >= 1 && nc.some((t) => t.includes(`${TAG} Jo personal Pixel`) && t.includes('Personal (BYOD)') && t.includes('Screen lock required')),
    `${label}: Not compliant filters to the personal Pixel, with its ownership and the provider's reason`, nc.join(' | ').slice(0, 300));
  await page.getByTestId('mdm-filter-clear').click();
  await themeCheck(page, theme, `${label} Mobile devices`);
  if (vp === 'phone') await noSideScroll(page, `${label} Mobile devices`);
  await shot(page, `${label}-mobile-devices`);
  await cleanCheck(page, `${label} Mobile devices`);

  await page.locator(`a[href="/mobile-devices/${m.ipad.id}"]`).first().click();
  await page.waitForURL((u) => u.pathname === `/mobile-devices/${m.ipad.id}`, { timeout: 15_000 });
  await hydrated(page); await settled(page);
  await page.getByTestId('mdm-commands').waitFor({ timeout: 15_000 }).catch(() => {});
  const own = await page.getByTestId('mdm-ownership-card').innerText().catch(() => '');
  const comp = await page.getByTestId('mdm-compliance-card').innerText().catch(() => '');
  const serial = await page.getByTestId('mdm-serial').innerText().catch(() => '');
  check(/Corporate/.test(own) && /Whole device/.test(own) && /Compliant/.test(comp) && /DMPXK12ABCD/.test(serial),
    `${label}: the iPad's page shows ownership, compliance and its serial`, JSON.stringify({ own, comp, serial }).slice(0, 300));
  const lock = page.locator('[data-testid="mdm-commands"] li[data-kind="lock"]');
  const sync = page.locator('[data-testid="mdm-commands"] li[data-kind="sync"]');
  const lockState = await lock.getAttribute('data-state').catch(() => null);
  const lockAcc = await lock.getByTestId('mdm-cmd-accepted').getAttribute('data-done').catch(() => null);
  const lockDone = await lock.getByTestId('mdm-cmd-completed').getAttribute('data-done').catch(() => null);
  const lockText = await lock.innerText().catch(() => '');
  check(lockState === 'acknowledged' && lockAcc === 'yes' && lockDone === 'no' && /Accepted by the provider/.test(lockText) && /Not yet: waiting for the device/.test(lockText),
    `${label}: the lock reads accepted by the provider and NOT completed on the device, side by side`, JSON.stringify({ lockState, lockAcc, lockDone, lockText: lockText.slice(0, 200) }));
  check(await sync.getAttribute('data-state').catch(() => null) === 'completed' && await sync.getByTestId('mdm-cmd-accepted').getAttribute('data-done').catch(() => null) === 'yes'
    && await sync.getByTestId('mdm-cmd-completed').getAttribute('data-done').catch(() => null) === 'yes',
  `${label}: the sync reads both accepted and completed`);
  // 0.86: the read-only stand-in takes no command: every lost-device button is disabled, with the server's reason; nothing destructive exists.
  await page.getByTestId('mdm-lost-actions').waitFor({ timeout: 15_000 }).catch(() => {});
  const ipadActs = await page.locator('[data-testid="mdm-lost-actions"] button').evaluateAll((els) => els.map((e) => [e.getAttribute('data-testid'), e.hasAttribute('disabled')]));
  check(JSON.stringify(ipadActs) === JSON.stringify([['mdm-act-lock', true], ['mdm-act-lost_mode_start', true], ['mdm-act-lost_mode_stop', true]])
    && /cannot be sent commands/.test(await page.getByTestId('mdm-act-reason-lock').innerText().catch(() => ''))
    && await page.locator('main button').filter({ hasText: /^(Wipe|Erase|Retire)/ }).count() === 0,
  `${label}: a stand-in device: lock and lost mode shown disabled with the reason; no wipe, erase or retire anywhere`, JSON.stringify(ipadActs));
  await themeCheck(page, theme, `${label} mobile device`);
  if (vp === 'phone') await noSideScroll(page, `${label} mobile device`);
  await shot(page, `${label}-mobile-device`);
  await cleanCheck(page, `${label} mobile device`);

  await go(page, `/mobile-devices/${m.pixel.id}`);
  await page.getByTestId('mdm-ownership-card').waitFor({ timeout: 15_000 }).catch(() => {});
  const pOwn = await page.getByTestId('mdm-ownership-card').innerText().catch(() => '');
  const pSerial = await page.getByTestId('mdm-serial').innerText().catch(() => '');
  await page.getByTestId('mdm-no-commands').waitFor({ timeout: 15_000 }).catch(() => {});
  check(/Personal \(BYOD\)/.test(pOwn) && /Work profile only/.test(pOwn) && /Not kept for a personal device/.test(pSerial) && await page.getByTestId('mdm-no-commands').isVisible(),
    `${label}: the personal Pixel: work profile only, no serial kept, no commands`, JSON.stringify({ pOwn, pSerial }).slice(0, 300));
  if (vp === 'phone') await noSideScroll(page, `${label} personal mobile device`);
  await cleanCheck(page, `${label} personal mobile device`);

  // 0.86 (§95): an Apple device on Rem0te's own connector. Lock is offered; lost mode says why not; the dialog is opened and cancelled, never confirmed.
  await go(page, `/mobile-devices/${m.iphone.id}`);
  await page.getByTestId('mdm-lost-actions').waitFor({ timeout: 15_000 }).catch(() => {});
  const lockBtn = page.getByTestId('mdm-act-lock');
  const lostWhy = await page.getByTestId('mdm-act-reason-lost_mode_start').innerText().catch(() => '');
  check(await lockBtn.getAttribute('data-available').catch(() => null) === 'yes' && await page.getByTestId('mdm-act-lost_mode_start').getAttribute('data-available').catch(() => null) === 'no'
    && /supervised/.test(lostWhy), `${label}: an Apple device: Lock is offered; lost mode is not, because it never said it is supervised`, lostWhy);
  await lockBtn.click();
  await page.getByTestId('mdm-act-dialog').waitFor({ timeout: 10_000 }).catch(() => {});
  await page.getByTestId('mdm-act-message').fill(`Found? ${sfx}`).catch(() => {});
  await page.getByTestId('mdm-act-phone').fill('ring me').catch(() => {});
  const dlg = await page.getByTestId('mdm-act-dialog').innerText().catch(() => '');
  const confirmDisabled = await page.getByTestId('mdm-act-confirm').isDisabled().catch(() => null);
  await page.getByTestId('mdm-act-phone').fill('+44 20 7946 0000').catch(() => {});
  const confirmEnabled = await page.getByTestId('mdm-act-confirm').isEnabled().catch(() => null);
  check(/Lock this device\?/.test(dlg) && /Nothing is erased/.test(dlg) && /Rem0te does not keep it/.test(dlg) && confirmDisabled === true && confirmEnabled === true,
    `${label}: the lock dialog explains, takes a lock-screen message and phone number, and refuses a bad number`, dlg.slice(0, 300));
  await themeCheck(page, theme, `${label} lock dialog`);
  if (vp === 'phone') await noSideScroll(page, `${label} lock dialog`);
  await shot(page, `${label}-mobile-lock-dialog`);
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.getByTestId('mdm-act-dialog').waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {});
  check(await prisma.mdmCommand.count({ where: { mobileDeviceId: m.iphone.id } }) === 0, `${label}: cancelling sends nothing`);
  await cleanCheck(page, `${label} Apple mobile device`);
}

/** A Business Owner whose business has no provider: Requires setup, what each provider needs, the empty state. */
async function mobileRequiresSetup(browser, f, vp, theme, label) {
  const ctx = await newContext(browser, vp, theme);
  try {
    const page = await signIn(ctx, f.mobile.ownerE.email, `${label} (owner, no MDM provider)`, theme);
    await go(page, '/mobile-devices');
    await page.getByTestId('mdm-setup').waitFor({ timeout: 15_000 }).catch(() => {});
    await page.getByTestId('mdm-empty').waitFor({ timeout: 15_000 }).catch(() => {});
    const state = await page.getByTestId('mdm-setup').getAttribute('data-state').catch(() => null);
    const prereq = await page.locator('[data-testid="mdm-prerequisites"] li').allInnerTexts().catch(() => []);
    const empty = await page.getByTestId('mdm-empty').innerText().catch(() => '');
    check(state === 'requires_setup' && await page.getByTestId('mdm-requires-setup').isVisible() && prereq.length === 3
      && /Intune/.test(prereq[0]) && /quota/.test(prereq[1]) && /APNs/.test(prereq[2]) && /setup starts under Settings → Mobile devices/.test(empty),
    `${label}: with no provider the page says Requires setup, lists the three providers' prerequisites and an empty state`, JSON.stringify({ state, prereq: prereq.length, empty }));
    // 0.83: a Business Owner is told a Platform Admin sets it up, and gets no link to a page they cannot open.
    check(await page.getByTestId('mdm-settings-hint').isVisible().catch(() => false) && await page.getByTestId('mdm-settings-link').count() === 0,
      `${label}: the empty state says a Platform Admin sets it up under Settings → Mobile devices (no link for an owner)`);
    await themeCheck(page, theme, `${label} Mobile devices (requires setup)`);
    if (vp === 'phone') await noSideScroll(page, `${label} Mobile devices (requires setup)`);
    await shot(page, `${label}-mobile-requires-setup`);
    await cleanCheck(page, `${label} Mobile devices (requires setup)`);
  } finally { await ctx.close(); }
}

async function main() {
  section('Stack');
  await ensureSeeded();
  for (const [what, srv, port] of [['SMTP sink', smtp.server, SMTP_PORT], ['reference ClientSt0r peer', peer.server, PEER_PORT]]) {
    await new Promise((r, j) => { srv.once('error', j); srv.listen(port, '127.0.0.1', r); });
    check(true, `${what} on 127.0.0.1:${port}`);
  }
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
  f.c = await seed035(f);
  f.msa = await seedMsa(f);
  f.tools = await seedTools(f);
  f.rollbackJob = await seedRollbackJob(f);
  f.mobile = await seedMobile(f);
  f.backups = await seedBackups(f);
  f.mdmSetup = await seedMdmSetup(f);
  if (process.env.UI_HOLD === '1') {
    // Debugging only: leave the stack and fixtures up until interrupted.
    console.log(`  holding: ${WEB}  admin ${f.admin.email} / owner ${f.owner.email}  password in UI_HOLD_PW_FILE`);
    if (process.env.UI_HOLD_PW_FILE) writeFileSync(process.env.UI_HOLD_PW_FILE, PW, { mode: 0o600 });
    await new Promise((r) => { process.once('SIGINT', r); process.once('SIGTERM', r); });
    fail++; failures.push('UI_HOLD=1: a debugging run, no browser checks were made');
    return;
  }
  check(true, `fixtures: two businesses, a Platform Admin, a Business Owner and a Business User, ten devices (one that can chat, one to upgrade), three groups, three scripts (two approved), a confirmed address, a ClientSt0r mapping, a migration request (tag ${TAG})`);
  const browser = await chromium.launch();
  try {
    // UI_COMBOS=desktop/light,phone/dark narrows a debugging run; a run that skips any combination fails.
    const only = (process.env.UI_COMBOS ?? '').split(',').filter(Boolean);
    for (const vp of ['desktop', 'phone']) for (const theme of ['light', 'dark']) {
      if (only.length && !only.includes(`${vp}/${theme}`)) continue;
      await combo(browser, f, vp, theme);
    }
    for (const vp of ['desktop', 'phone']) if (!only.length || only.some((c) => c.startsWith(`${vp}/`))) await snapshotAutoUpdate(browser, f, vp);
    if (!only.length || only.includes('assist')) await assistWindow(browser, f);
    if (only.length) { fail++; failures.push(`UI_COMBOS=${only.join(',')}: a partial run`); }
  } finally { await browser.close(); }
  await cleanup035(); await cleanup(); created.businesses = []; created.users = [];

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
    check(msaReadinessReads > 0 && msaGated.length === 0,
      'MSA_GRANTS off: device pages read readiness but the console requested no /msa/managed, /msa/grants, /msa/sessions or /msa/cutover-runs route',
      `readiness reads ${msaReadinessReads}; gated: ${[...new Set(msaGated)].slice(0, 10).join(', ')}`);
    await cleanup035();
    await cleanup();
    await prisma.$disconnect();
    await stopAll();
    if (fail) for (const p of procs) console.log(`\n── ${p.label} log (tail)\n${p.log.slice(-4000)}`);
    if (copyDir) rmSync(copyDir, { recursive: true, force: true });
    smtp.server.close(); peer.server.close(); rmSync(peer.dir, { recursive: true, force: true });
    rmSync(GEO_DIR, { recursive: true, force: true });
    if (SIGNED) rmSync(SIGNED.work, { recursive: true, force: true });
    console.log(`\nScreenshots: ${OUT_DIR}`);
    console.log(`${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
    if (failures.length) { for (const x of failures) console.log(`  - ${x}`); process.exit(1); }
    process.exit(0);
  });
