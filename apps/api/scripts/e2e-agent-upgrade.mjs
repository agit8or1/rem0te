#!/usr/bin/env node
/**
 * End-to-end: upgrading or updating a computer's agent from the console (0.34).
 *
 * Builds a real signed update repository with the offline release tool (as
 * e2e-signed-updates does), starts its own API from dist/ with
 * UPDATE_REPO_DIR pointing at it, and proves:
 *
 *   - the Agent card: agent type, version, whether it is current, channel and
 *     the portal's update mode, for standard, signed, Linux and macOS agents;
 *     another business's computer is a 404;
 *   - "Upgrade to full agent" refuses, each with its own code: no fresh
 *     sign-in, no reason, no computers:edit, another business, no repository,
 *     a repository with no signed agent, Linux, macOS, no device secret,
 *     already signed, an updates containment pause, and Signed only;
 *   - a request leads the heartbeat to hand exactly that computer — and no
 *     other — the reinstall flag with its nonce, and windows.ps1 fetched with
 *     that nonce serves the migration script pinned to the digest of the
 *     signed agent the repository serves at that moment (re-released: the new
 *     digest); the request never changes the platform's update mode; it is
 *     held under containment and in Signed only, and a signed heartbeat
 *     completes it;
 *   - "Update agent" queues the existing reinstall (same audit), a signed
 *     agent's "Check now" clears once it reports a newer update check, and
 *     Linux gets the command to re-run instead;
 *   - bulk agent.migrate / agent.update: fresh sign-in once, reason required,
 *     per-computer refusals, another business's computer is NOT_FOUND;
 *   - the Migration status view is scoped by business and computes states;
 *   - the Patches tab names the Agent card's button, or exactly what is missing;
 *   - audit entries for request, completion, cancel and bulk.
 *
 *   cd apps/api && npx nest build
 *   RELEASE_BIN=/path/to/rem0te-release DATABASE_URL=…/rem0te_agent_upgrade_test node scripts/e2e-agent-upgrade.mjs
 *
 * Self-starting on AGENT_UPGRADE_API_PORT (3521). Scratch databases only.
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const DB = process.env.DATABASE_URL ?? '';
const dbName = DB.split('/').pop()?.split('?')[0] ?? '';
if (!/scratch|test/.test(dbName)) { console.error(`Refusing to run against database "${dbName}": name must contain "scratch" or "test".`); process.exit(2); }
const BIN = process.env.RELEASE_BIN;
if (!BIN) { console.error('RELEASE_BIN (rem0te-release) is required'); process.exit(2); }
const PORT = Number(process.env.AGENT_UPGRADE_API_PORT ?? 3521);
if ([3000, 3001, 443].includes(PORT)) { console.error(`Refusing port ${PORT}: that is a production port.`); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const TAG = `AU${sfx}`;
const PW = 'agent-upgrade-e2e-password-1';

let pass = 0, fail = 0; const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;
const sha = (b) => createHash('sha256').update(b).digest('hex');

// ── The release machine: keys and a repository, outside anything served ────
const work = mkdtempSync(path.join(tmpdir(), 'rem0te-agentup-'));
const keys = path.join(work, 'keys'); mkdirSync(keys);
const repo = path.join(work, 'repo');
const rel = (...a) => execFileSync(BIN, a, { encoding: 'utf8' });
for (const k of ['r1', 'r2', 'r3', 'targets', 'snapshot', 'timestamp']) rel('keygen', '-out', path.join(keys, `${k}.pem`));
rel('init', '-repo', repo, '-root-key', path.join(keys, 'r1.pem'), '-root-key', path.join(keys, 'r2.pem'), '-root-key', path.join(keys, 'r3.pem'),
  '-root-threshold', '2', '-targets-key', path.join(keys, 'targets.pem'), '-snapshot-key', path.join(keys, 'snapshot.pem'), '-timestamp-key', path.join(keys, 'timestamp.pem'));
const files = path.join(work, 'files'); mkdirSync(files);
execFileSync(process.execPath, [path.join(here, 'build-signed-installer.mjs'), '--out', path.join(files, 'install.ps1')]);
const T = (n) => ['-targets-key', path.join(keys, 'targets.pem'), '-snapshot-key', path.join(keys, 'snapshot.pem'), '-timestamp-key', path.join(keys, 'timestamp.pem'), ...n];
const slot = Buffer.concat([Buffer.from('REM0TE_INST_URL:'), Buffer.alloc(240)]);
const fakeAgent = (label) => Buffer.concat([Buffer.from(`MZ fake signed agent ${label} `), randomBytes(64), slot, Buffer.from(' trailer')]);
// First release: the installer only — a repository with no signed agent in it.
rel('release', '-repo', repo, ...T(['-add', `windows/install.ps1=${path.join(files, 'install.ps1')}`]));
function publishAgent(bin) {
  const f = path.join(files, `agent-${sha(bin).slice(0, 8)}.exe`);
  writeFileSync(f, bin);
  rel('release', '-repo', repo, ...T(['-add', `windows/rem0te-agent.exe=${f}`]));
  return sha(bin);
}
const tsFile = path.join(repo, 'metadata', 'timestamp.json');
const withoutRepo = async (fn) => { renameSync(tsFile, `${tsFile}.off`); try { return await fn(); } finally { renameSync(`${tsFile}.off`, tsFile); } };

// ── API ─────────────────────────────────────────────────────────────────────
const env = {
  ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATABASE_URL: DB, UPDATE_REPO_DIR: repo,
  JWT_SECRET: randomBytes(32).toString('hex'), LAUNCHER_TOKEN_SECRET: randomBytes(32).toString('hex'),
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? randomBytes(32).toString('hex'), TRUSTED_PROXIES: 'loopback',
  HBBS_PRESENCE_HOST: '127.0.0.2', MONITOR_SWEEP: 'off', CLIENT_UPDATE_SWEEP: 'off', PATCH_POLICY_SWEEP: 'off', METRIC_SWEEP: 'off', AUDIT_SEALER: 'off',
  VERSION_FILE: path.resolve(here, '..', '..', '..', 'version.json'),
};
delete env.PUBLIC_API_URL;
let api;
async function waitUp() {
  for (let i = 0; i < 150; i++) { try { const r = await fetch(`${API}/health`); if (r.status < 500) return; } catch { /* not yet */ } await sleep(300); }
  throw new Error(`API did not come up:\n${api.log.slice(-3000)}`);
}

async function req(method, p, { s, body } = {}) {
  // A fresh address per request: the global throttler is keyed by client address.
  const h = { 'content-type': 'application/json', 'x-forwarded-for': ip() };
  if (s) h.cookie = s.cookie + (s.stepUp ? `; step_up=${s.stepUp}` : '');
  const r = await fetch(`${API}${p}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j, data: j?.data, text, setCookie: r.headers.get('set-cookie') ?? '' };
}
async function login(email) {
  const r = await req('POST', '/auth/login', { body: { email, password: PW } });
  const m = r.setCookie.match(/access_token=([^;]+)/);
  if (r.status !== 200 || !m) throw new Error(`login ${email}: ${r.status} ${r.text.slice(0, 200)}`);
  return { cookie: `access_token=${m[1]}` };
}
async function stepUp(s) {
  const r = await req('POST', '/auth/step-up', { s, body: { password: PW } });
  const m = r.setCookie.match(/step_up=([^;]+)/);
  if (r.status !== 200 || !m) throw new Error(`step-up: ${r.status} ${r.text.slice(0, 200)}`);
  return { ...s, stepUp: m[1] };
}
const code = (r) => r.body?.code ?? r.body?.message?.code;
const msg = (r) => `HTTP ${r.status} ${r.text.slice(0, 300)}`;
const hb = (ep, extra = {}) => req('POST', '/enrollment/heartbeat', { body: { rustdeskId: ep.rid, agentSecret: ep.secret, ...extra } }).then((r) => r.body?.data ?? r.body);
const card = (s, ep) => req('GET', `/endpoints/${ep.id}/agent`, { s });
const migrate = (s, ep, reason = `${TAG} pilot move to signed`) => req('POST', `/endpoints/${ep.id}/agent/migrate`, { s, body: reason === undefined ? {} : { reason } });
const bulk = (s, body) => req('POST', '/endpoints/bulk', { s, body });
const audits = (action, resourceId) => prisma.activityLog.findMany({ where: { action, ...(resourceId ? { resourceId } : {}) }, orderBy: { createdAt: 'desc' } });
const setMode = (mode, legacyPortalMigration = false) => prisma.platformSettings.upsert({ where: { id: 'singleton' }, update: { updateTrustMode: mode, legacyPortalMigration }, create: { id: 'singleton', updateTrustMode: mode, legacyPortalMigration } });

const created = { users: [], businesses: [] };
let savedSettings = null;

async function main() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  const relay = (await prisma.tenantSettings.findFirst({ orderBy: { createdAt: 'asc' }, select: { rustdeskRelayHost: true } }))?.rustdeskRelayHost;
  if (!relay) throw new Error('the scratch database needs a relay host (seed with RUSTDESK_RELAY_HOST)');
  savedSettings = await prisma.platformSettings.findUnique({ where: { id: 'singleton' } });
  await setMode('legacy_allowed', false);
  const version = JSON.parse((await import('node:fs')).readFileSync(env.VERSION_FILE, 'utf8')).version;

  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });
  const roleUser = await prisma.role.findFirst({ where: { type: 'BUSINESS_USER' } });
  const A = await prisma.customer.create({ data: { tenantId: tenant.id, name: `${TAG} Acme` } });
  const B = await prisma.customer.create({ data: { tenantId: tenant.id, name: `${TAG} Birch` } });
  const C = await prisma.customer.create({ data: { tenantId: tenant.id, name: `${TAG} Contained` } });
  created.businesses.push(A.id, B.id, C.id);
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (t, extra = {}) => { const u = await prisma.user.create({ data: { email: `au-${t}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'AU', lastName: t, status: 'ACTIVE', ...extra } }); created.users.push(u.id); return u; };
  const admin = await mkUser('admin', { isPlatformAdmin: true });
  const ownerA = await mkUser('owner-a'), ownerB = await mkUser('owner-b'), userA = await mkUser('user-a'), ownerC = await mkUser('owner-c');
  await prisma.membership.create({ data: { userId: ownerA.id, tenantId: tenant.id, customerId: A.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: ownerB.id, tenantId: tenant.id, customerId: B.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: ownerC.id, tenantId: tenant.id, customerId: C.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: userA.id, tenantId: tenant.id, customerId: A.id, roleId: roleUser.id, capabilities: ['computers:view'] } });

  const mkEp = async (biz, name, { platform = 'Windows', channel = null, agentVersion = version, secret = true, status = 'ACTIVE', agentSha256 = null } = {}) => {
    const e = await prisma.endpoint.create({ data: {
      tenantId: tenant.id, customerId: biz.id, name, hostname: name.toLowerCase(), platform, status, isOnline: true, isManaged: true,
      accessMode: 'COMPANY_WIDE', lastSeenAt: new Date(), updateChannel: channel, agentVersion, agentSha256, deviceClass: 'WORKSTATION',
    } });
    const s = secret ? randomBytes(16).toString('hex') : null;
    const node = await prisma.rustdeskNode.create({ data: { tenantId: tenant.id, endpointId: e.id, rustdeskId: String(100000000 + ((Math.random() * 899999999) | 0)), ...(s ? { agentSecretHash: sha(s) } : {}) } });
    return { id: e.id, rid: node.rustdeskId, secret: s, name };
  };
  const w1 = await mkEp(A, `${TAG}-STD-1`);
  const w2 = await mkEp(A, `${TAG}-STD-2`);
  const w3 = await mkEp(A, `${TAG}-STD-3`, { agentVersion: '0.19.0' });
  const wNoSecret = await mkEp(A, `${TAG}-NOSECRET`, { secret: false });
  const wSigned = await mkEp(A, `${TAG}-SIGNED`, { channel: 'signed' });
  const lin = await mkEp(A, `${TAG}-LINUX`, { platform: 'linux' });
  const mac = await mkEp(A, `${TAG}-MAC`, { platform: 'macos' });
  const wArch = await mkEp(A, `${TAG}-ARCHIVED`, { status: 'ARCHIVED' });
  const wB = await mkEp(B, `${TAG}-B-STD`);
  const wC = await mkEp(C, `${TAG}-C-STD`);
  await prisma.containmentPause.create({ data: { scope: 'BUSINESS', customerId: C.id, kinds: ['updates'], reason: `${TAG}: incident`, setById: admin.id, setBy: 'msp' } });
  check(true, 'fixtures: businesses A, B and C (C has an updates pause); standard, signed, Linux, macOS, unbound and archived computers');

  api = spawn(process.execPath, [path.join(dist, 'main.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  api.log = ''; api.stdout.on('data', (d) => { api.log += d; }); api.stderr.on('data', (d) => { api.log += d; });
  await waitUp();
  const S = {
    admin: await stepUp(await login(admin.email)), ownerA: await login(ownerA.email), ownerB: await stepUp(await login(ownerB.email)),
    userA: await stepUp(await login(userA.email)), ownerC: await stepUp(await login(ownerC.email)),
  };
  S.ownerAF = await stepUp(S.ownerA);

  // ── The Agent card ─────────────────────────────────────────────────────────
  section('Agent card: type, version, current, channel and portal mode');
  {
    const r = await card(S.ownerA, w1);
    const d = r.data;
    check(r.status === 200 && d.kind === 'standard' && d.channel === 'standard' && d.version === version, 'standard Windows agent: type, channel and version', msg(r));
    check(d.current.state === 'current' && d.portal.mode === 'legacy_allowed' && d.portal.modeLabel === 'Legacy allowed', 'current against this portal; mode Legacy allowed', JSON.stringify({ c: d.current, p: d.portal }));
    check(d.update.possible && d.update.label === 'Update agent', 'Update agent offered');
    check(d.migration && !d.migration.possible && d.migration.code === 'NO_SIGNED_RELEASE' && /No signed release is published/.test(d.migration.reason) && d.migration.link?.href === '/endpoints/full-agent',
      'Upgrade to full agent: refused with "No signed release is published" and the Full agent link', JSON.stringify(d.migration));
    const old = (await card(S.ownerA, w3)).data;
    check(old.current.state === 'behind' && /older than 0\.20\.0/.test(old.current.text), 'an agent below the contract is "behind" and says why', JSON.stringify(old.current));
    const sg = (await card(S.ownerA, wSigned)).data;
    check(sg.kind === 'signed' && sg.channel === 'signed' && sg.update.label === 'Check for update now' && sg.migration === null, 'signed agent: Check for update now, no upgrade offered', JSON.stringify({ k: sg.kind, u: sg.update, m: sg.migration }));
    check(sg.current.state === 'unknown' && /No signed release/.test(sg.current.text), 'signed agent with nothing published to compare: unknown', JSON.stringify(sg.current));
    const l = (await card(S.ownerA, lin)).data;
    check(l.kind === 'linux' && !l.update.possible && /^curl -fsSL https?:\/\/[^ ]+\/api\/v1\/public\/install\/linux\.sh \| sudo bash$/.test(l.update.command ?? '') && l.migration === null,
      'Linux: re-run the installer, with the exact command', JSON.stringify(l.update));
    const m = (await card(S.ownerA, mac)).data;
    check(m.kind === 'macos' && /\/install\/macos\.sh \| sudo bash$/.test(m.update.command ?? ''), 'macOS: re-run the installer (with sudo)', JSON.stringify(m.update));
    const other = await card(S.ownerB, w1);
    check(other.status === 404, 'another business’s computer: 404', msg(other));
    const noView = await card(S.ownerA, wB);
    check(noView.status === 404, 'A cannot read B’s card either', msg(noView));
  }

  // ── Preconditions and refusals ─────────────────────────────────────────────
  section('Upgrade to full agent: each precondition refuses with its own reason');
  {
    let r = await migrate(S.ownerA, w1);
    check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED', 'no fresh sign-in: 403 STEP_UP_REQUIRED', msg(r));
    r = await migrate(S.ownerAF, w1, '');
    check(r.status === 400 && code(r) === 'REASON_REQUIRED', 'no reason: 400 REASON_REQUIRED', msg(r));
    r = await migrate(S.userA, w1);
    check(r.status === 403, 'no computers:edit: 403', msg(r));
    r = await migrate(S.ownerB, w1);
    check(r.status === 404, 'another business’s computer: 404, indistinguishable from a missing one', msg(r));
    r = await withoutRepo(() => migrate(S.ownerAF, w1));
    check(r.status === 409 && code(r) === 'NO_SIGNED_RELEASE' && /UPDATE_REPO_DIR/.test(r.body?.message), 'no repository: NO_SIGNED_RELEASE naming UPDATE_REPO_DIR', msg(r));
    r = await migrate(S.ownerAF, w1);
    check(r.status === 409 && code(r) === 'NO_SIGNED_RELEASE' && /windows\/rem0te-agent\.exe/.test(r.body?.message), 'repository without a signed agent: NO_SIGNED_RELEASE', msg(r));
  }
  const sha1 = publishAgent(fakeAgent('one'));
  {
    const fx = [[lin, 'LINUX_AGENT_READ_ONLY', 'Linux'], [mac, 'MACOS_AGENT_READ_ONLY', 'macOS'], [wNoSecret, 'NO_DEVICE_SECRET', 'no device secret'], [wSigned, 'ALREADY_SIGNED', 'already signed'], [wArch, 'ARCHIVED', 'archived']];
    for (const [ep, c, what] of fx) {
      const r = await migrate(S.ownerAF, ep);
      check(r.status === 409 && code(r) === c, `${what}: ${c}`, msg(r));
    }
    let r = await migrate(S.ownerC, wC);
    check(r.status === 409 && code(r) === 'CONTAINED' && new RegExp(`${TAG}: incident`).test(r.body?.message), 'updates containment pause: CONTAINED, with the pause reason', msg(r));
    await setMode('signed_only', false);
    r = await migrate(S.ownerAF, w1);
    check(r.status === 409 && code(r) === 'SIGNED_ONLY', 'Signed only (no portal migration): SIGNED_ONLY — a per-computer request must not loosen it', msg(r));
    const c = (await card(S.ownerA, w1)).data;
    check(c.portal.modeLabel === 'Signed only' && c.migration.code === 'SIGNED_ONLY' && !c.update.possible, 'card: Signed only, and Update agent not offered (it would be withheld)', JSON.stringify({ m: c.migration?.code, u: c.update }));
    await setMode('legacy_allowed', false);
    const n = await prisma.agentMigration.count({ where: { endpoint: { customerId: { in: [A.id, C.id] } } } });
    check(n === 0, 'no refused request left a row', `${n} rows`);
  }

  // ── A request, the heartbeat and windows.ps1 ───────────────────────────────
  section('A request: the heartbeat hands exactly that computer the migration, and the script pins the digest');
  let nonce;
  {
    const before = await prisma.platformSettings.findUnique({ where: { id: 'singleton' } });
    const r = await migrate(S.ownerAF, w1);
    check(r.status === 200 && r.data.state === 'pending' && !r.data.unchanged, 'owner A with a fresh sign-in: requested', msg(r));
    const after = await prisma.platformSettings.findUnique({ where: { id: 'singleton' } });
    check(after.updateTrustMode === before.updateTrustMode && after.legacyPortalMigration === before.legacyPortalMigration, 'the platform update mode is unchanged by a per-computer request', JSON.stringify({ before: [before.updateTrustMode, before.legacyPortalMigration], after: [after.updateTrustMode, after.legacyPortalMigration] }));
    const again = await migrate(S.ownerAF, w1);
    check(again.status === 200 && again.data.unchanged === true && again.data.id === r.data.id, 'a second request is the same request (one open per computer)', msg(again));
    const a = (await audits('AGENT_MIGRATION_REQUESTED', w1.id))[0];
    check(a && a.actorId === ownerA.id && a.metadata?.reason === `${TAG} pilot move to signed` && a.metadata?.signedAgentSha256 === sha1 && a.customerId === A.id, 'audited with actor, reason and the signed digest', JSON.stringify(a?.metadata));
    const row = await prisma.agentMigration.findFirst({ where: { endpointId: w1.id } });
    nonce = row.nonce;

    const d1 = await hb(w1);
    check(d1?.reinstallAgent?.nonce === nonce && /^mig_[A-Za-z0-9_-]{40}$/.test(nonce), 'heartbeat of that computer: reinstall flag carrying its migration nonce', JSON.stringify(d1?.reinstallAgent));
    const d2 = await hb(w2);
    check(!d2?.reinstallAgent, 'another computer in the same business: nothing', JSON.stringify(d2?.reinstallAgent));
    const d3 = await hb(wB);
    check(!d3?.reinstallAgent, 'a computer in another business: nothing', JSON.stringify(d3?.reinstallAgent));
    const anon = await req('POST', '/enrollment/heartbeat', { body: { rustdeskId: w1.rid } });
    check(anon.status === 401 || !(anon.body?.data ?? anon.body)?.reinstallAgent, 'a heartbeat without the device secret gets no nonce', msg(anon));
    const disp = await prisma.agentMigration.findUnique({ where: { id: row.id } });
    check(!!disp.dispatchedAt && disp.dispatchCount === 1, 'the dispatch is recorded', JSON.stringify({ d: disp.dispatchedAt, n: disp.dispatchCount }));

    const ps = await req('GET', `/public/install/windows.ps1?updateNonce=${nonce}`);
    const txt = ps.text;
    check(ps.status === 200 && txt.includes(`/api/v1/public/updates/targets/windows/${sha1}.rem0te-agent.exe`) && txt.includes(`-ne '${sha1}'`), 'windows.ps1 with the nonce: the migration script, pinned to the served signed agent digest', txt.slice(0, 400));
    check(txt.includes(`& $exe migrate --portal '${relay}'`) && !/\$UPDATE_CHANNEL|rustdesk\.exe|iex/i.test(txt), 'it runs migrate against the portal address, and nothing of the legacy installer', txt.slice(-300));
    check(txt.includes("'Rem0te-migrate-' + [guid]::NewGuid()"), 'it stages the binary in a fresh, unpredictable directory');
    const fetched = await prisma.agentMigration.findUnique({ where: { id: row.id } });
    check(!!fetched.fetchedAt, 'the download is recorded');
    const plain = await req('GET', '/public/install/windows.ps1');
    check(/\$UPDATE_CHANNEL = 'legacy'/.test(plain.text) && !plain.text.includes('migrate --portal'), 'windows.ps1 without the nonce: still the standard installer');
    const bogus = await req('GET', `/public/install/windows.ps1?updateNonce=mig_${'A'.repeat(40)}`);
    check(/\$UPDATE_CHANNEL = 'legacy'/.test(bogus.text) && !bogus.text.includes('migrate --portal'), 'an unknown migration nonce changes nothing');

    // The digest is the repository's at the moment of the fetch, not the request's.
    const sha2 = publishAgent(fakeAgent('two'));
    const ps2 = await req('GET', `/public/install/windows.ps1?updateNonce=${nonce}`);
    check(ps2.text.includes(`-ne '${sha2}'`) && !ps2.text.includes(sha1), 'after a new signed release the script pins the new digest', ps2.text.slice(0, 300));

    // Held, not handed out: containment, then Signed only.
    const pause = await prisma.containmentPause.create({ data: { scope: 'BUSINESS', customerId: A.id, kinds: ['updates'], reason: `${TAG}: hold`, setById: admin.id, setBy: 'msp' } });
    const h1 = await hb(w1);
    const held = await prisma.agentMigration.findUnique({ where: { id: row.id } });
    check(!h1?.reinstallAgent && held.holdReason === 'contained', 'under an updates pause: held, nothing handed out', JSON.stringify({ r: h1?.reinstallAgent, h: held.holdReason }));
    await prisma.containmentPause.update({ where: { id: pause.id }, data: { clearedAt: new Date(), clearedById: admin.id, clearReason: 'e2e' } });
    await setMode('signed_only', false);
    const h2 = await hb(w1);
    const held2 = await prisma.agentMigration.findUnique({ where: { id: row.id } });
    const ps3 = await req('GET', `/public/install/windows.ps1?updateNonce=${nonce}`);
    check(!h2?.reinstallAgent && held2.holdReason === 'signed_only', 'tightened to Signed only after the request: held', JSON.stringify({ r: h2?.reinstallAgent, h: held2.holdReason }));
    check(/Migration unavailable/.test(ps3.text) && !/Invoke-WebRequest|migrate --portal/.test(ps3.text), 'and windows.ps1 serves a script that runs nothing, even for the nonce', ps3.text.slice(0, 200));
    await setMode('signed_only', true);
    const h3 = await hb(w1);
    check(h3?.reinstallAgent?.nonce === nonce, 'Signed only + portal migration: handed out again', JSON.stringify(h3?.reinstallAgent));
    const c = (await card(S.ownerA, w1)).data;
    check(c.portal.modeLabel === 'Signed only + portal migration' && c.migration.request?.state === 'downloaded', 'card shows the mode and the request state', JSON.stringify({ m: c.portal.modeLabel, r: c.migration?.request?.state }));
    await setMode('legacy_allowed', false);

    // The machine migrated: its next heartbeat says signed.
    const done = await hb(w1, { updateChannel: 'signed', trustRootVersion: 1, targetsVersion: 3, agentSha256: sha2, agentUpdateCheckedAt: new Date().toISOString(), agentUpdateResult: 'installer exit 0' });
    const fin = await prisma.agentMigration.findUnique({ where: { id: row.id } });
    check(!!fin.completedAt && !done?.reinstallAgent?.nonce, 'a signed heartbeat completes the request', JSON.stringify({ c: fin.completedAt, r: done?.reinstallAgent }));
    const ca = (await audits('AGENT_MIGRATION_COMPLETED', w1.id))[0];
    check(ca?.metadata?.migrationId === row.id, 'completion is audited');
    const after2 = await req('GET', `/public/install/windows.ps1?updateNonce=${nonce}`);
    check(/\$UPDATE_CHANNEL = 'legacy'/.test(after2.text), 'a completed request’s nonce no longer serves the migration script');
    const sc = (await card(S.ownerA, w1)).data;
    check(sc.kind === 'signed' && sc.current.state === 'current' && sc.lastUpdate?.result === 'installer exit 0' && sc.migration?.request?.state === 'completed', 'card: now signed, current, with its last update result', JSON.stringify({ k: sc.kind, c: sc.current, l: sc.lastUpdate, m: sc.migration?.request?.state }));
  }

  // ── Update agent ───────────────────────────────────────────────────────────
  section('Update agent: the existing reinstall, and Check now for a signed agent');
  {
    let r = await req('POST', `/endpoints/${w2.id}/agent/update`, { s: S.ownerA });
    const n = await prisma.rustdeskNode.findUnique({ where: { endpointId: w2.id } });
    check(r.status === 200 && r.data.status === 'PENDING' && r.data.what === 'reinstall' && !!n.reinstallRequestedAt, 'standard agent: reinstall queued', msg(r));
    const a = (await audits('ENDPOINT_AGENT_REINSTALL_REQUESTED', w2.id))[0];
    check(a?.actorId === ownerA.id, 'audited as the existing reinstall (ENDPOINT_AGENT_REINSTALL_REQUESTED)');
    const h = await hb(w2);
    check(!!h?.reinstallAgent && !h.reinstallAgent.nonce, 'the heartbeat hands out the plain reinstall (no migration nonce)', JSON.stringify(h?.reinstallAgent));
    r = await req('POST', `/endpoints/${lin.id}/agent/update`, { s: S.ownerA });
    check(r.status === 400 && code(r) === 'LINUX_AGENT_READ_ONLY' && /Re-run the installer on the computer: curl -fsSL \S+\/install\/linux\.sh \| sudo bash/.test(r.body?.message ?? ''), 'Linux: refused, with the command to re-run', msg(r));
    r = await req('POST', `/endpoints/${w2.id}/agent/update`, { s: S.userA });
    check(r.status === 403, 'no computers:edit: 403', msg(r));
    r = await req('POST', `/endpoints/${wC.id}/agent/update`, { s: S.ownerC });
    check(r.status === 403 && code(r) === 'CONTAINED', 'under an updates pause: CONTAINED up front', msg(r));
    r = await req('POST', `/endpoints/${wSigned.id}/agent/update`, { s: S.ownerA });
    check(r.status === 200 && r.data.what === 'check', 'signed agent: Check for update now queued', msg(r));
    const s1 = await hb(wSigned, { updateChannel: 'signed', agentUpdateCheckedAt: new Date(Date.now() - 3600_000).toISOString(), agentUpdateResult: 'installer exit 0' });
    check(!!s1?.reinstallAgent, 'its heartbeat is told to update', JSON.stringify(s1?.reinstallAgent));
    await sleep(20);
    await hb(wSigned, { updateChannel: 'signed', agentUpdateCheckedAt: new Date().toISOString(), agentUpdateResult: 'metadata-refused: \u001b[31mexpired\u0007' });
    const sn = await prisma.rustdeskNode.findUnique({ where: { endpointId: wSigned.id } });
    const se = await prisma.endpoint.findUnique({ where: { id: wSigned.id } });
    check(!sn.reinstallRequestedAt, 'Check now clears once the agent reports a newer update check', JSON.stringify({ r: sn.reinstallRequestedAt }));
    // eslint-disable-next-line no-control-regex -- control characters are what this checks for
    check(se.agentUpdateResult === 'metadata-refused: [31mexpired' && !/[\x00-\x1f]/.test(se.agentUpdateResult), 'the reported result is stored inert (control characters removed)', JSON.stringify(se.agentUpdateResult));
    await hb(wSigned, { updateChannel: 'signed', agentUpdateCheckedAt: '0001-01-01T00:00:00Z', agentUpdateResult: 'zero' });
    const se2 = await prisma.endpoint.findUnique({ where: { id: wSigned.id } });
    check(se2.agentUpdateResult !== 'zero', 'a zero check time is not stored');
  }

  // ── Bulk ───────────────────────────────────────────────────────────────────
  section('Bulk: agent.migrate and agent.update, per-computer results');
  {
    const ids = [w2.id, w3.id, lin.id, wNoSecret.id, wSigned.id, wB.id, 'c' + 'x'.repeat(24)];
    let r = await bulk(S.ownerA, { action: 'agent.migrate', endpointIds: ids, reason: `${TAG} fleet move` });
    check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED', 'no fresh sign-in: the whole request is refused', msg(r));
    r = await bulk(S.ownerAF, { action: 'agent.migrate', endpointIds: ids });
    check(r.status === 400 && code(r) === 'REASON_REQUIRED', 'no reason: 400', msg(r));
    r = await bulk(S.ownerAF, { action: 'agent.update', endpointIds: [w2.id], reason: 'x y z' });
    check(r.status === 400, 'a reason on another action: 400', msg(r));
    r = await bulk(S.ownerAF, { action: 'agent.migrate', endpointIds: Array.from({ length: 201 }, (_, i) => `c${String(i).padStart(24, '0')}`), reason: `${TAG} too many` });
    check(r.status === 400 && code(r) === 'BULK_TOO_LARGE', 'over 200 computers: BULK_TOO_LARGE', msg(r));
    r = await bulk(S.ownerAF, { action: 'agent.migrate', endpointIds: ids, reason: `${TAG} fleet move` });
    const by = Object.fromEntries((r.data?.results ?? []).map((x) => [x.endpointId, x]));
    check(r.status === 200 && r.data.requested === 7 && r.data.succeeded === 2, 'two of seven requested', msg(r));
    check(by[w2.id]?.ok && by[w3.id]?.ok, 'the two standard computers: requested');
    check(by[lin.id]?.code === 'LINUX_AGENT_READ_ONLY' && by[wNoSecret.id]?.code === 'NO_DEVICE_SECRET' && by[wSigned.id]?.code === 'ALREADY_SIGNED',
      'Linux, no secret and signed: each with its own refusal', JSON.stringify([by[lin.id], by[wNoSecret.id], by[wSigned.id]].map((x) => x?.code)));
    check(by[wB.id]?.code === 'NOT_FOUND' && !by[wB.id]?.name && by[ids[6]]?.code === 'NOT_FOUND', 'another business’s computer and a made-up id: NOT_FOUND, nothing about them returned', JSON.stringify([by[wB.id], by[ids[6]]]));
    const rows = await prisma.agentMigration.findMany({ where: { endpointId: { in: [w2.id, w3.id] }, completedAt: null, cancelledAt: null } });
    check(rows.length === 2 && rows.every((x) => x.reason === `${TAG} fleet move`), 'one open request each, with the bulk reason');
    const bA = (await audits('DEVICE_BULK_ACTION')).find((x) => x.actorId === ownerA.id && x.metadata?.action === 'agent.migrate');
    check(bA && bA.customerId === A.id && bA.metadata.succeeded.length === 2 && bA.metadata.notFound === 2, 'bulk audit entry for business A', JSON.stringify(bA?.metadata));
    const per = await audits('AGENT_MIGRATION_REQUESTED', w3.id);
    check(per[0]?.metadata?.via === 'bulk', 'and a per-computer audit entry marked via bulk');
    r = await bulk(S.ownerAF, { action: 'agent.migrate', endpointIds: [w2.id], reason: `${TAG} again` });
    check(r.data?.results?.[0]?.ok && r.data.results[0].unchanged, 'already requested: unchanged');
    r = await bulk(S.ownerA, { action: 'agent.update', endpointIds: [w2.id, lin.id, wB.id] });
    const u = Object.fromEntries((r.data?.results ?? []).map((x) => [x.endpointId, x]));
    check(r.status === 200 && u[w2.id]?.ok && u[lin.id]?.code === 'LINUX_AGENT_READ_ONLY' && u[wB.id]?.code === 'NOT_FOUND', 'agent.update in bulk: queued, Linux refused, other business NOT_FOUND', msg(r));
    r = await bulk(S.userA, { action: 'agent.update', endpointIds: [w2.id] });
    check(r.status === 200 && r.data.results[0].ok === false && r.data.results[0].code === 'NOT_ALLOWED', 'no computers:edit: NOT_ALLOWED per computer', msg(r));
  }

  // ── Migration status view ──────────────────────────────────────────────────
  section('Migration status: scoped, with computed states');
  {
    const rb = await migrate(S.ownerB, wB, `${TAG} B move`);
    check(rb.status === 200, 'owner B requests its own computer', msg(rb));
    // One handed out three hours ago that never came back signed.
    await prisma.agentMigration.updateMany({ where: { endpointId: w3.id, completedAt: null }, data: { dispatchedAt: new Date(Date.now() - 3 * 3600_000), lastDispatchedAt: new Date(Date.now() - 3 * 3600_000), dispatchCount: 4 } });
    let r = await req('GET', '/agent-migrations', { s: S.ownerA });
    const names = (r.data?.rows ?? []).map((x) => x.name);
    check(r.status === 200 && names.includes(w2.name.toLowerCase()) && names.includes(w3.name.toLowerCase()) && !names.includes(wB.name.toLowerCase()), 'owner A sees A’s open requests and none of B’s', JSON.stringify(names));
    check(!names.includes(w1.name.toLowerCase()), 'completed requests are not in the default (open) view');
    const st3 = r.data.rows.find((x) => x.endpointId === w3.id);
    check(st3?.state === 'not_confirmed' && /Not confirmed/.test(st3.text), 'handed out 3 hours ago, still standard: not confirmed', JSON.stringify(st3));
    check(r.data.counts.completed === 1 && r.data.counts.not_confirmed === 1 && r.data.counts.pending === 1, 'counts by state', JSON.stringify(r.data.counts));
    r = await req('GET', '/agent-migrations?state=completed', { s: S.ownerA });
    check(r.data.rows.length === 1 && r.data.rows[0].endpointId === w1.id, 'state=completed');
    r = await req('GET', '/agent-migrations?state=all', { s: S.ownerB });
    check(r.data.rows.length === 1 && r.data.rows[0].endpointId === wB.id, 'owner B sees only B’s');
    r = await req('GET', '/agent-migrations?state=nonsense', { s: S.ownerA });
    check(r.status === 400, 'unknown state: 400');
    r = await req('GET', '/agent-migrations', { s: S.admin });
    const adminIds = (r.data?.rows ?? []).map((x) => x.endpointId);
    check(adminIds.includes(wB.id) && adminIds.includes(w2.id), 'the Platform Admin sees both businesses (negative control)');
  }

  // ── Cancel ─────────────────────────────────────────────────────────────────
  section('Cancel');
  {
    let r = await req('POST', `/endpoints/${wB.id}/agent/migrate/cancel`, { s: S.ownerA });
    check(r.status === 404, 'another business cannot cancel it: 404', msg(r));
    r = await req('POST', `/endpoints/${w2.id}/agent/migrate/cancel`, { s: S.ownerA });
    check(r.status === 200 && r.data.cancelled === true, 'owner A cancels w2', msg(r));
    const h = await hb(w2);
    check(!h?.reinstallAgent?.nonce, 'the heartbeat no longer hands out its nonce', JSON.stringify(h?.reinstallAgent));
    check((await audits('AGENT_MIGRATION_CANCELLED', w2.id)).length === 1, 'cancel is audited');
  }

  // ── Patches tab ────────────────────────────────────────────────────────────
  section('Patches tab: "What to do" points at the Agent card, or names what is missing');
  {
    let r = await req('GET', `/endpoints/${w2.id}/patches`, { s: S.ownerA });
    const i = r.data?.install;
    check(r.status === 200 && i && !i.possible && /Upgrade to full agent/.test(i.fix) && i.fixAction === 'agent-card', 'preconditions met: names the Agent card’s button', JSON.stringify(i));
    r = await req('GET', `/endpoints/${w3.id}/patches`, { s: S.ownerA });
    check(/already requested/.test(r.data?.install?.fix ?? '') && r.data.install.fixAction === 'agent-card', 'a request open: says so', JSON.stringify(r.data?.install));
    r = await withoutRepo(() => req('GET', `/endpoints/${w2.id}/patches`, { s: S.ownerA }));
    check(/No signed release is published/.test(r.data?.install?.fix ?? '') && r.data.install.fixLink?.href === '/endpoints/full-agent', 'nothing published: "No signed release is published", linked to the Full agent page', JSON.stringify(r.data?.install));
    r = await req('GET', `/endpoints/${wNoSecret.id}/patches`, { s: S.ownerA });
    check(/device secret/.test(r.data?.install?.fix ?? ''), 'no device secret: says that', JSON.stringify(r.data?.install));
  }
}

async function cleanup() {
  try {
    const ids = created.businesses;
    const eps = await prisma.endpoint.findMany({ where: { customerId: { in: ids } }, select: { id: true } });
    const epIds = eps.map((e) => e.id);
    await prisma.agentMigration.deleteMany({ where: { endpointId: { in: epIds } } });
    await prisma.containmentPause.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.endpointCommand.deleteMany({ where: { endpointId: { in: epIds } } });
    await prisma.rustdeskNode.deleteMany({ where: { endpointId: { in: epIds } } });
    await prisma.endpoint.deleteMany({ where: { id: { in: epIds } } });
    await prisma.membership.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.customer.deleteMany({ where: { id: { in: ids } } });
    if (created.users.length) {
      await prisma.privilegedActivity.deleteMany({ where: { identity: { in: created.users.map((u) => `user:${u}`) } } }).catch(() => undefined);
      await prisma.user.deleteMany({ where: { id: { in: created.users } } });
    }
    if (savedSettings) await prisma.platformSettings.update({ where: { id: 'singleton' }, data: { updateTrustMode: savedSettings.updateTrustMode, legacyPortalMigration: savedSettings.legacyPortalMigration } });
    rmSync(work, { recursive: true, force: true });
  } catch (e) { console.error('cleanup:', e.message); }
}

main()
  .catch((e) => { fail++; failures.push(`crashed: ${e.stack ?? e}`); console.error(e); if (api?.log) console.error(api.log.slice(-2000)); })
  .finally(async () => {
    await cleanup();
    if (api && api.exitCode === null) await new Promise((r) => { api.once('exit', r); api.kill('SIGTERM'); });
    await prisma.$disconnect();
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
    console.log('ALL PASSED');
  });
