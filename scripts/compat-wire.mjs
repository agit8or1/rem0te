#!/usr/bin/env node
/**
 * Wire compatibility (0.73.1): replay what each released standard agent sends
 * against the API under test. docs/compatibility.md.
 *
 *   cd apps/api && npx nest build      # the API under test
 *   DATABASE_URL=postgresql://…/<name containing scratch or test> scripts/compat-wire.sh [agent]
 *
 * (compat-wire.sh migrates and seeds, then runs this.) For every agent × tag
 * in scripts/compat/wire/agents.json it starts from fresh computers in a fresh
 * business and replays that release's fixtures in order: the installer's
 * claim and unclaimed heartbeat, the agent's heartbeats and every follow-up
 * call (command results, diagnostic results, the monitor report, the
 * rotation confirm, the tray pairing). Each body is sent as the agent's exact
 * bytes (`raw`), with the placeholders filled. Before a heartbeat, whatever
 * the fixture says was in the answer it acted on (commands, diagnostics, a
 * rotation) is staged in the database, so the answer the server gives now is
 * read the way the old agent reads it:
 *
 *   linux, macos  the raw response text must contain `"authenticated":true`,
 *                 and the agent's own grep pattern (from that release's
 *                 script, in the manifest) must find every staged command.
 *                 The command ids replayed next are the ones that pattern
 *                 found, as the agent would.
 *   windows       `data` is an object; every field heartbeat.ps1 reads has a
 *                 type it can use; staged commands and diagnostics come back
 *                 with id and type/key; a staged rotation carries password and
 *                 sha256; nothing asks the agent to reinstall or retire; the
 *                 tray key matches the release's own pattern.
 *
 * And every call must be accepted (HTTP 200, success) and have the effect it
 * had at that release: the claim binds the secret to the business, the
 * heartbeat writes lastSeenAt, agentVersion, hostname and the live sample,
 * results close their command or run, inventory and updates land, the
 * rotation is confirmed, the tray key is recognised on the next heartbeat.
 *
 * A fixture listed in agents.json's knownIncompatible (with a reason) is
 * reported, not failed. Writes $COMPAT_OUT/wire/evidence.json.
 *
 * Scratch only: refuses a database not named *scratch* or *test*, and any
 * port outside 3981–3988 (so never production's 3000, 3001, 3201, 3202, 443,
 * 4000 or 4001). The API it starts listens on 127.0.0.1 over plain http.
 */
import { spawn } from 'node:child_process';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const API_DIR = path.join(ROOT, 'apps', 'api');
const WIRE = path.join(here, 'compat', 'wire');
const PRODUCTION_PORTS = [3000, 3001, 3201, 3202, 443, 4000, 4001];

const DB = process.env.DATABASE_URL ?? '';
const dbName = DB.split('/').pop()?.split('?')[0] ?? '';
if (!/scratch|test/.test(dbName)) { console.error(`Refusing to run against database "${dbName}": name must contain "scratch" or "test".`); process.exit(2); }
const PORT = Number(process.env.WIRE_API_PORT ?? 3981);
if (PRODUCTION_PORTS.includes(PORT) || !(PORT >= 3981 && PORT <= 3988)) { console.error(`Refusing port ${PORT}: the wire replay uses 3981–3988 only.`); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
if (!API.startsWith('http://127.0.0.1:')) { console.error('Refusing: the replay talks only to its own loopback API.'); process.exit(2); }

const require = createRequire(path.join(API_DIR, 'package.json'));
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const ENC_KEY = process.env.ENCRYPTION_KEY ?? randomBytes(32).toString('hex');
const OUT = path.join(process.env.COMPAT_OUT ?? path.join(ROOT, '.compat-logs'), 'wire');
fs.mkdirSync(OUT, { recursive: true });
const AGENTS = JSON.parse(fs.readFileSync(path.join(WIRE, 'agents.json'), 'utf8'));
const only = process.argv[2];
const sfx = randomBytes(3).toString('hex');
const sha = (s) => createHash('sha256').update(s).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rid = () => String(100000000 + ((Math.random() * 899999999) | 0));
const encrypt = (text) => {
  const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', Buffer.from(ENC_KEY, 'hex'), iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return `${iv.toString('hex')}:${c.getAuthTag().toString('hex')}:${enc.toString('hex')}`;
};

let pass = 0, fail = 0, known = 0;
const failures = [];
let current = null;
const check = (c, n, d = '') => {
  if (c) { pass++; current.pass++; return true; }
  const k = current.knownFor(current.fixture);
  if (k) { known++; current.known.push({ fixture: current.fixture, check: n, reason: k.reason }); console.log(`    \x1b[33m~\x1b[0m ${current.fixture}: ${n} (known incompatible: ${k.reason})`); return false; }
  fail++; current.fail++;
  failures.push(`${current.label} ${current.fixture}: ${n} — ${d}`);
  console.log(`    \x1b[31m✗\x1b[0m ${current.fixture}: ${n}\n        ${String(d).slice(0, 600)}`);
  return false;
};

// ── The API under test ──────────────────────────────────────────────────────
const apiEnv = {
  ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATABASE_URL: DB,
  JWT_SECRET: randomBytes(32).toString('hex'), LAUNCHER_TOKEN_SECRET: randomBytes(32).toString('hex'),
  ENCRYPTION_KEY: ENC_KEY, TRUSTED_PROXIES: 'loopback', HBBS_PRESENCE_HOST: '127.0.0.2',
  VERSION_FILE: path.join(ROOT, 'version.json'), AUDIT_SEALER: 'off',
  // Never production's GeoIP file (§54): a path that does not exist, so the
  // API runs without one.
  GEOIP_DB_PATH: path.join(OUT, 'no-geoip.mmdb'),
  // Every sweep off: nothing but the replay writes to these computers.
  MONITOR_SWEEP: 'off', AGENT_AUTO_UPDATE: 'off', SNAPSHOT_SWEEP: 'off', AUTO_MIGRATION_SWEEP: 'off',
  PATCH_POLICY_SWEEP: 'off', METRIC_SWEEP: 'off', RETENTION_SWEEP: 'off', REPORT_SCHEDULE_SWEEP: 'off',
  CHAT_RETENTION_SWEEP: 'off', SCRIPT_OUTPUT_SWEEP: 'off', TRAY_SWEEP: 'off', WINGET_INDEX_SWEEP: 'off',
  WARRANTY_SWEEP: 'off', AUTOMATION_SWEEP: 'off', RESTART_WINDOW_SWEEP: 'off', SSO_SESSION_SWEEP: 'off',
};
let api;
async function startApi() {
  const busy = await fetch(`${API}/health`).then(() => true, () => false);
  if (busy) throw new Error(`port ${PORT} is already in use; set WIRE_API_PORT to a free port in 3981–3988`);
  api = spawn(process.execPath, [path.join(API_DIR, 'dist', 'main.js')], { cwd: API_DIR, env: apiEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  api.log = ''; api.stdout.on('data', (d) => { api.log += d; }); api.stderr.on('data', (d) => { api.log += d; });
  for (let i = 0; i < 150; i++) { try { const r = await fetch(`${API}/health`); if (r.status < 500) return; } catch { /* not yet */ } await sleep(300); }
  throw new Error(`api did not come up:\n${api.log.slice(-3000)}`);
}
async function stopApi() { if (!api || api.exitCode !== null) return; await new Promise((r) => { api.once('exit', r); api.kill('SIGTERM'); }); }

async function post(p, raw, ip) {
  const r = await fetch(`${API}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: raw });
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, text, body: j, data: j?.data };
}

// ── Fixtures ───────────────────────────────────────────────────────────────
function loadSet(agent, tag) {
  const dir = path.join(WIRE, agent, tag);
  if (!fs.existsSync(path.join(dir, 'manifest.json'))) return null;
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const fixtures = fs.readdirSync(dir).filter((f) => /^\d+-.*\.json$/.test(f)).sort()
    .map((f) => ({ file: f, ...JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }));
  return { manifest, fixtures };
}
function fill(raw, vars) {
  return raw.replace(/\{\{([A-Za-z0-9]+(?::[A-Za-z0-9_]+)?)\}\}/g, (m, k) => {
    if (!(k in vars)) throw new Error(`no value for ${m}`);
    return vars[k];
  });
}

const ADDR = (() => { let n = 0; return () => { n++; return `10.98.${(n >> 8) & 255}.${n & 255}`; }; })();

async function replaySet(agent, tag, set, tenant, admin) {
  const label = `${agent} ${tag}`;
  const knownList = AGENTS.knownIncompatible.filter((k) => k.agent === agent && k.tag === tag);
  for (const k of knownList) if (!k.reason) throw new Error(`knownIncompatible ${agent} ${tag} ${k.fixture} has no reason`);
  current = { label, pass: 0, fail: 0, known: [], fixture: '', knownFor: (f) => knownList.find((k) => k.fixture === f || k.fixture === '*') };
  const business = await prisma.customer.create({ data: { tenantId: tenant.id, name: `Wire ${agent} ${tag} ${sfx}` } });
  const ip = ADDR();
  const contract = set.manifest.contract ?? {};
  // One identity per computer the fixtures speak as.
  const ident = {};
  for (const name of ['claimed', 'pooled', 'retry']) {
    const token = randomBytes(32).toString('hex');
    ident[name] = { rustdeskId: rid(), agentSecret: randomBytes(32).toString('base64url'), password: `Wire-${randomBytes(6).toString('hex')}`, token, rotatePassword: `Rot-${randomBytes(8).toString('hex')}` };
    if (name !== 'pooled') {
      await prisma.deviceClaimToken.create({ data: { tenantId: tenant.id, token: sha(token), expiresAt: new Date(Date.now() + 3600_000), customerId: business.id, customerName: business.name, description: `wire ${label}` } });
    }
  }
  const vars = (id) => ({
    rustdeskId: id.rustdeskId, agentSecret: id.agentSecret, password: id.password, token: id.token,
    rotatePassword: id.rotatePassword, 'sha256:rotatePassword': sha(id.rotatePassword),
    ...(id.trayKeyId ? { trayKeyId: id.trayKeyId } : {}),
    ...Object.fromEntries(Object.entries(id.commands ?? {}).map(([t, v]) => [`commandId:${t}`, v])),
    ...Object.fromEntries(Object.entries(id.runs ?? {}).map(([k, v]) => [`diagRunId:${k}`, v])),
  });
  const node = (id) => prisma.rustdeskNode.findUnique({ where: { rustdeskId: id.rustdeskId }, include: { endpoint: { include: { inventory: true } } } });

  for (const f of set.fixtures) {
    current.fixture = f.file;
    const id = ident[f.identity];
    if (!check(!!id, `identity ${f.identity} is one the replay knows`)) continue;

    // Stage what the answer this agent acted on carried.
    if (f.stage) {
      const n = await node(id);
      if (!check(!!n?.endpointId, 'the computer exists before its heartbeat', JSON.stringify(n))) continue;
      const ep = n.endpoint;
      id.staged = { commands: [], runs: {} };
      for (const type of f.stage.commands ?? []) {
        const c = await prisma.endpointCommand.create({ data: { endpointId: ep.id, tenantId: ep.tenantId, customerId: ep.customerId, type, params: type === 'EVENT_LOG_QUERY' ? { logName: 'System', sinceHours: 24, maxEvents: 10 } : undefined, expiresAt: new Date(Date.now() + 3600_000) } });
        id.staged.commands.push({ type, id: c.id });
      }
      for (const key of f.stage.diagnostics ?? []) {
        const r = await prisma.diagnosticRun.create({ data: { endpointId: ep.id, tenantId: ep.tenantId, customerId: ep.customerId, key, requestedById: admin.id, expiresAt: new Date(Date.now() + 3600_000) } });
        id.staged.runs[key] = r.id;
      }
      if (f.stage.rotation) await prisma.rustdeskNode.update({ where: { id: n.id }, data: { pendingPassword: encrypt(id.rotatePassword), pendingPasswordAt: new Date() } });
    }

    // The server hands out two commands a heartbeat. A result for one not yet
    // handed out waits for the next heartbeat, as on the computer: the same
    // heartbeat is sent again (up to three times) and read the same way.
    if (f.commandType && !id.commands?.[f.commandType] && id.lastBeat) {
      for (let i = 0; i < 3 && !id.commands?.[f.commandType]; i++) {
        const again = await post(id.lastBeat.f.request.path, id.lastBeat.raw, ip);
        if (!check(again.status === 200, 'a repeated heartbeat is accepted', `HTTP ${again.status} ${again.text.slice(0, 300)}`)) break;
        await heartbeatContract(agent, contract, id.lastBeat.f, id, again, true);
      }
      check(!!id.commands?.[f.commandType], `the ${f.commandType} command is handed out within four heartbeats`);
    }
    let raw;
    try { raw = fill(f.raw, vars(id)); } catch (e) { check(false, 'every placeholder has a value', e.message); continue; }
    if (f.request.path === '/enrollment/heartbeat') id.lastBeat = { f, raw };
    const before = Date.now();
    const r = await post(f.request.path, raw, ip);
    const want = f.expect?.status ?? 200;
    if (!check(r.status === want && r.body?.success === true, `${f.request.path} is accepted (HTTP ${want})`, `HTTP ${r.status} ${r.text.slice(0, 500)}`)) continue;
    const body = JSON.parse(raw);
    const n = await node(id);
    const ep = n?.endpoint;

    switch (f.request.path) {
      case '/enrollment/claim': {
        check(!!ep && ep.customerId === business.id, 'the claim placed the computer in the token\'s business', JSON.stringify({ ep: ep?.id, c: ep?.customerId }));
        check(n?.agentSecretHash === sha(id.agentSecret), 'the claim bound the device secret');
        const tok = await prisma.deviceClaimToken.findUnique({ where: { token: sha(id.token) } });
        check(!!tok?.claimedAt, 'the token is consumed');
        break;
      }
      case '/enrollment/heartbeat': {
        check(!!ep, 'the heartbeat\'s computer exists', JSON.stringify(n));
        if (!ep) break;
        check(ep.lastSeenAt && ep.lastSeenAt.getTime() >= before - 2000, 'lastSeenAt is written', String(ep.lastSeenAt));
        if (f.identity === 'pooled') {
          check(ep.customerId === null, 'an unclaimed installer heartbeat lands in the unassigned pool', String(ep.customerId));
          break;
        }
        if (body.agentVersion) check(ep.agentVersion === body.agentVersion, `agentVersion ${body.agentVersion} is recorded`, String(ep.agentVersion));
        if (body.hostname) check(ep.hostname === body.hostname, 'the hostname is recorded', String(ep.hostname));
        if (body.platform) check(String(ep.platform).toLowerCase() === body.platform.toLowerCase(), 'the platform is recorded', String(ep.platform));
        if (body.memoryTotalMb !== undefined) check(ep.inventory?.memoryTotalMb === body.memoryTotalMb, 'the live memory sample is recorded', JSON.stringify(ep.inventory?.memoryTotalMb));
        if (body.loggedOnUser !== undefined) check(ep.inventory?.loggedOnUser === body.loggedOnUser, 'the signed-in user is recorded', JSON.stringify(ep.inventory?.loggedOnUser));
        if (body.rustdeskVersion) check(n.version === body.rustdeskVersion, 'the RustDesk version is recorded', String(n.version));
        await heartbeatContract(agent, contract, f, id, r);
        break;
      }
      case '/enrollment/command-result': {
        const c = await prisma.endpointCommand.findUnique({ where: { id: body.commandId } });
        check(c?.status === (body.ok ? 'SUCCEEDED' : 'FAILED'), `the ${f.commandType} command is closed as ${body.ok ? 'SUCCEEDED' : 'FAILED'}`, JSON.stringify([c?.status, c?.error]));
        const inv = ep?.inventory;
        if (body.inventory) {
          check(inv?.osCaption === body.inventory.osCaption && inv?.manufacturer === (body.inventory.manufacturer || null), 'the inventory lands', JSON.stringify([inv?.osCaption, inv?.manufacturer]));
          if (Array.isArray(body.inventory.disks)) check(Array.isArray(inv?.disks) && inv.disks.length === body.inventory.disks.length, 'every disk lands', JSON.stringify(inv?.disks));
          if (Array.isArray(body.inventory.software)) check(inv?.softwareCount === body.inventory.software.length, 'the software list lands', String(inv?.softwareCount));
        }
        if (body.updates) check(inv?.pendingUpdateCount === body.updates.pending.length && !!inv?.updatesCheckedAt, 'the pending updates land', JSON.stringify([inv?.pendingUpdateCount, inv?.updatesCheckedAt]));
        if (body.events) check(Array.isArray(c?.result?.events ?? c?.result) || c?.result != null, 'the events are kept with the command', JSON.stringify(c?.result).slice(0, 200));
        break;
      }
      case '/enrollment/diagnostic-result': {
        const run = await prisma.diagnosticRun.findUnique({ where: { id: body.runId } });
        const wantStatus = { running: 'RUNNING', completed: 'COMPLETED', failed: 'FAILED' }[body.state];
        check(run?.status === wantStatus, `the ${body.key} run is ${wantStatus}`, JSON.stringify([run?.status, run?.error]));
        if (body.state === 'completed') check(run?.result != null, 'its result is kept', String(run?.result));
        break;
      }
      case '/enrollment/monitor-report': break;
      case '/enrollment/confirm-rotation': {
        check(r.data?.confirmed === true, 'the rotation is confirmed (the field heartbeat.ps1 reads)', JSON.stringify(r.data));
        check(n?.pendingPassword === null && !!n?.permanentPassword, 'the rotated password is now the active one');
        break;
      }
      case '/tray/pair': {
        const pat = contract.trayPair?.trayKeyPattern;
        const tk = r.data?.trayKey;
        check(typeof tk === 'string' && (!pat || new RegExp(pat).test(tk)), 'the tray key matches the pattern this release accepts', String(tk).slice(0, 12));
        check(typeof r.data?.keyId === 'string' && /^[a-z0-9]{24}$/.test(r.data.keyId), 'a key id comes back', String(r.data?.keyId));
        id.trayKeyId = r.data?.keyId;
        break;
      }
      default: check(false, `a fixture path the replay knows (${f.request.path})`);
    }
  }
  return { agent, tag, evidence: set.manifest.evidence, fixtures: set.fixtures.length, pass: current.pass, fail: current.fail, knownIncompatible: current.known };
}

// What the old agent reads from a heartbeat answer.
async function heartbeatContract(agent, contract, f, id, r, resend = false) {
  const staged = id.staged ?? { commands: [], runs: {} };
  id.commands ??= {}; id.runs ??= {};
  const sent = (r.data?.commands ?? []).filter((c) => c && ['INVENTORY_REFRESH', 'UPDATE_SCAN', 'EVENT_LOG_QUERY'].includes(c.type));
  if (agent === 'linux' || agent === 'macos') {
    for (const s of contract.heartbeat?.rawContains ?? []) check(r.text.includes(s), `the raw answer contains ${s} (the agent stops without it)`, r.text.slice(0, 300));
    const pat = contract.heartbeat?.commandPattern;
    if (!check(!!pat, 'the manifest names the command pattern')) return;
    // The agent's own extraction: grep -oE <pattern>, then id and type. It
    // must see every command the server handed out, or that command is
    // dispatched again and again and never answered.
    const found = [...r.text.matchAll(new RegExp(pat, 'g'))].map((m) => m[0].match(/^\{"id":"([^"]+)","type":"([A-Z_]+)"$/)).filter(Boolean);
    check(sent.length > 0 || staged.commands.length === 0, 'the server hands out the staged commands', r.text.slice(0, 400));
    for (const c of sent) {
      const hit = found.find((m) => m[1] === c.id && m[2] === c.type);
      check(!!hit, `the agent's pattern finds the ${c.type} command the server sent`, r.text.slice(0, 400));
      if (hit) id.commands[c.type] = hit[1];
    }
    return;
  }
  // windows: heartbeat.ps1 reads $resp.data.<field> for the fields in the manifest.
  const d = r.data;
  if (!check(d && typeof d === 'object' && !Array.isArray(d), 'data is an object', r.text.slice(0, 300))) return;
  const isObj = (v) => v === null || v === undefined || (typeof v === 'object' && !Array.isArray(v));
  const isArr = (v) => v === null || v === undefined || Array.isArray(v);
  const shape = { commands: isArr, diagnostics: isArr, rotate: isObj, updateRustdesk: isObj, reinstallAgent: isObj, monitor: isObj, tray: isObj, chat: isObj,
    retireStandard: (v) => v === undefined || v === null || typeof v === 'boolean' };
  for (const k of contract.heartbeat?.reads ?? []) if (shape[k]) check(shape[k](d[k]), `data.${k} has a shape heartbeat.ps1 can read`, String(JSON.stringify(d[k])).slice(0, 200));
  check(!d.reinstallAgent && !d.updateRustdesk && d.retireStandard !== true, 'nothing asks this agent to reinstall, update RustDesk or retire', JSON.stringify([d.reinstallAgent, d.updateRustdesk, d.retireStandard]));
  check(sent.length > 0 || staged.commands.length === 0, 'the server hands out the staged commands', String(JSON.stringify(d.commands)).slice(0, 300));
  for (const c of sent) {
    check(typeof c.id === 'string' && c.id.length > 0, `the ${c.type} command has the id heartbeat.ps1 needs`, JSON.stringify(c));
    id.commands[c.type] = c.id;
  }
  if (resend) return;
  for (const [key, runId] of Object.entries(staged.runs)) {
    const hit = (d.diagnostics ?? []).find((x) => x && x.id === runId);
    check(hit && hit.key === key, `the staged ${key} diagnostic comes back with id and key`, String(JSON.stringify(d.diagnostics)).slice(0, 300));
    if (hit) id.runs[key] = hit.id;
  }
  if (f.stage?.rotation) check(d.rotate?.password === id.rotatePassword && d.rotate?.sha256 === sha(id.rotatePassword), 'the staged rotation comes back with password and sha256', JSON.stringify(d.rotate ? Object.keys(d.rotate) : d.rotate));
  if (f.request.body.trayKeyId) check(!(d.tray && d.tray.pair === true), 'the paired tray key is recognised (no second pairing asked)', JSON.stringify(d.tray));
}

// ── Main ───────────────────────────────────────────────────────────────────
const results = [];
try {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  // A catalog diagnostic has a requester (0059's CHECK); the seeded Platform Admin.
  const admin = await prisma.user.findFirst({ where: { isPlatformAdmin: true, status: 'ACTIVE' }, orderBy: { createdAt: 'asc' } });
  if (!admin) throw new Error('seed the scratch database first: no Platform Admin');
  await startApi();
  for (const [agent, def] of Object.entries(AGENTS.agents)) {
    if (only && agent !== only) continue;
    for (const { tag } of def.tags) {
      const set = loadSet(agent, tag);
      current = { label: `${agent} ${tag}`, pass: 0, fail: 0, known: [], fixture: 'manifest.json', knownFor: () => null };
      if (!check(!!set, `fixtures exist for ${agent} ${tag} (scripts/compat/capture-wire.mjs ${agent} ${tag})`)) { results.push({ agent, tag, missing: true }); continue; }
      const res = await replaySet(agent, tag, set, tenant, admin);
      results.push(res);
      console.log(`  ${res.fail ? '\x1b[31m✗' : '\x1b[32m✓'}\x1b[0m ${agent} ${tag} (${res.evidence}): ${res.fixtures} fixtures, ${res.pass} checks passed${res.fail ? `, ${res.fail} failed` : ''}${res.knownIncompatible.length ? `, ${res.knownIncompatible.length} known incompatible` : ''}`);
    }
  }
} catch (e) {
  fail++; failures.push(String(e?.stack ?? e));
  console.error(e);
  if (api) console.error(api.log.slice(-3000));
} finally {
  await stopApi();
  await prisma.$disconnect();
}
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'version.json'), 'utf8')).version;
fs.writeFileSync(path.join(OUT, 'evidence.json'), `${JSON.stringify({ server: version, evidence: 'wire replay against the API under test', sets: results, pass, fail, knownIncompatible: known }, null, 2)}\n`);
console.log(`\n${pass} passed, ${fail} failed${known ? `, ${known} known incompatible` : ''} (${results.length} agent × release sets)`);
if (fail) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
