#!/usr/bin/env node
/**
 * End-to-end proof of Settings → Confirm it is you (0.49), against the real
 * built API:
 *
 *   - a fresh database asks for every function (no ConfirmPolicy rows);
 *   - GET /security/confirm-policy: the catalog, the values and canChange
 *     (true only for a Platform Admin), and the always-ask note;
 *   - `ask` asks: a stale session's API key creation is STEP_UP_REQUIRED
 *     naming its key (apikey.create);
 *   - PUT is a Platform Admin's: a Business Owner is refused, even fresh;
 *   - an always-ask key (passkey.manage, fresh.auth.passkey, confirm.relax)
 *     and an unknown key are refused and nothing is written;
 *   - relaxing (ask → off) without a fresh confirmation is refused with
 *     action confirm.relax and nothing is written; with one it is written,
 *     takes effect at once and is audited (CONFIRM_POLICY_CHANGED, the keys
 *     before and after, nothing else);
 *   - `off` skips: the same stale API key creation now succeeds, and
 *     StepUpService's sites follow the policy (GET /auth/step-up `actions`);
 *     passkey.manage still asks;
 *   - asking again (off → ask) needs no fresh confirmation, and asks at once;
 *   - on restart the API reads the rows; a row naming an always-ask or an
 *     unknown key is ignored, and 0071's CHECK refuses any value but
 *     ask / off.
 *
 *   cd apps/api && npx nest build
 *   DATABASE_URL=postgresql://…/<scratch or test> node scripts/e2e-confirm-policy.mjs
 *
 * Port 3761 (API). Fixtures are namespaced and removed, and the database's
 * ConfirmPolicy rows are put back as they were, so later suites still ask.
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const DB = process.env.DATABASE_URL ?? '';
const dbName = DB.split('/').pop()?.split('?')[0] ?? '';
if (!/scratch|test/.test(dbName)) { console.error(`Refusing to run against database "${dbName}": name must contain "scratch" or "test".`); process.exit(2); }
const PORT = Number(process.env.CONFIRM_API_PORT ?? 3761);
if (PORT < 3761 || PORT > 3769) { console.error(`Refusing port ${PORT}: this suite uses 3761–3769.`); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'confirm-e2e-password-123';

let pass = 0, fail = 0;
const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;

const JWT = randomBytes(32).toString('hex'), LTS = randomBytes(32).toString('hex'), ENC = randomBytes(32).toString('hex');
let api;
function startApi() {
  const p = spawn(process.execPath, [path.join(dist, 'main.js')], {
    env: {
      ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATABASE_URL: DB, JWT_SECRET: JWT, LAUNCHER_TOKEN_SECRET: LTS, ENCRYPTION_KEY: ENC,
      TRUSTED_PROXIES: 'loopback', HBBS_PRESENCE_HOST: '127.0.0.2', VERSION_FILE: path.resolve(here, '..', '..', '..', 'version.json'), FRONTEND_URL: 'https://rmm.example.test',
      INTEGRATION_PEERS_FILE: '', MONITOR_SWEEP: 'off', CLIENT_UPDATE_SWEEP: 'off', PATCH_POLICY_SWEEP: 'off', METRIC_SWEEP: 'off', RETENTION_SWEEP: 'off',
      REPORT_SCHEDULE_SWEEP: 'off', CHAT_RETENTION_SWEEP: 'off', TRAY_SWEEP: 'off', SCRIPT_OUTPUT_SWEEP: 'off', AUTO_MIGRATION_SWEEP: 'off',
      GEOIP_DB_PATH: path.join(here, 'no-geoip.mmdb'), WINGET_INDEX_SWEEP: 'off', SNAPSHOT_SWEEP: 'off', AGENT_AUTO_UPDATE: 'off', AUDIT_SEALER: 'off', STALE_SWEEP: 'off',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.log = ''; p.stdout.on('data', (d) => { p.log += d; }); p.stderr.on('data', (d) => { p.log += d; });
  return p;
}
async function waitUp() {
  for (let i = 0; i < 120; i++) { try { const r = await fetch(`${API}/health`); if (r.status < 500) return; } catch { /* */ } await sleep(300); }
  throw new Error(`api did not come up:\n${api.log.slice(-3000)}`);
}
async function stopApi() {
  if (api && api.exitCode === null) await new Promise((r) => { api.once('exit', r); api.kill('SIGTERM'); });
}
async function req(method, p, { s, body, fresh } = {}) {
  await sleep(60);
  const h = { 'content-type': 'application/json', 'x-forwarded-for': ip() };
  if (s) h.cookie = s.cookie + (fresh && s.stepUp ? `; step_up=${s.stepUp}` : '');
  const r = await fetch(`${API}${p}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j, data: j?.data, text, setCookie: r.headers.get('set-cookie') ?? '' };
}
async function login(email) {
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip() }, body: JSON.stringify({ email, password: PW }) });
  const mm = (r.headers.get('set-cookie') ?? '').match(/access_token=([^;]+)/);
  if (r.status !== 200 || !mm) throw new Error(`login ${email}: ${r.status} ${await r.text()}`);
  const s = { cookie: `access_token=${mm[1]}` };
  const u = await req('POST', '/auth/step-up', { s, body: { password: PW } });
  const st = u.setCookie.match(/step_up=([^;]+)/);
  if (u.status !== 200 || !st) throw new Error(`step-up: ${u.status} ${u.text}`);
  s.stepUp = st[1];
  return s;
}
const code = (r) => r.body?.code ?? r.body?.message?.code ?? r.body?.error?.code;
const action = (r) => r.body?.action ?? r.body?.message?.action ?? r.body?.error?.action;
const msg = (r) => `HTTP ${r.status} ${typeof r.body === 'string' ? r.body.slice(0, 300) : JSON.stringify(r.body).slice(0, 400)}`;
const isStepUp = (r, a) => r.status === 403 && code(r) === 'STEP_UP_REQUIRED' && (!a || action(r) === a);
const created = { businesses: [], users: [] };
let savedPolicy = null;
// jsonb does not keep key order: compare with keys sorted at every level.
const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

async function all() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  savedPolicy = await prisma.confirmPolicy.findMany();
  await prisma.confirmPolicy.deleteMany({});
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });

  section('Fixtures (synthetic): a Platform Admin and a Business Owner of A');
  const A = await prisma.customer.create({ data: { tenantId: tenant.id, name: `Confirm Co ${sfx}` } });
  created.businesses.push(A.id);
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag, extra = {}) => { const u = await prisma.user.create({ data: { email: `cp-${tag}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'CP', lastName: tag, status: 'ACTIVE', ...extra } }); created.users.push(u.id); return u; };
  const admin = await mkUser('admin', { isPlatformAdmin: true });
  const owner = await mkUser('owner');
  await prisma.membership.create({ data: { userId: owner.id, tenantId: tenant.id, customerId: A.id, roleId: roleOwner.id } });

  api = startApi();
  await waitUp();
  const S = { admin: await login(admin.email), owner: await login(owner.email) };
  const newKey = (s, fresh) => req('POST', '/apikeys', { s, fresh, body: { name: `cp-${sfx}-${randomBytes(2).toString('hex')}`, scopes: ['computers:read'] } });

  section('A fresh database asks for everything');
  let r = await req('GET', '/security/confirm-policy', { s: S.owner });
  const view = r.data;
  check(r.status === 200 && Array.isArray(view?.catalog) && view.catalog.length >= 30, 'any signed-in user reads the catalog', msg(r));
  check(view && Object.values(view.values).every((v) => v === 'ask') && view.catalog.every((f) => f.value === 'ask' && f.default === 'ask'), 'every function is ask', JSON.stringify(view?.values));
  check(view?.canChange === false, 'canChange is false for a Business Owner');
  check(view && !view.catalog.some((f) => ['passkey.manage', 'confirm.relax', 'fresh.auth.passkey'].includes(f.key)), 'no always-ask key is offered as a toggle');
  check(view && view.alwaysAsk.some((l) => /password/i.test(l)) && view.alwaysAsk.some((l) => /authenticator/i.test(l)) && view.alwaysAsk.some((l) => /passkeys/i.test(l)), 'the always-ask note names password, authenticator and passkeys', JSON.stringify(view?.alwaysAsk));
  check(view && ['Software', 'Agents', 'Integrations', 'Security & access'].every((g) => view.groups.includes(g)) && view.catalog.every((f) => view.groups.includes(f.group)), 'every function is in a listed group', JSON.stringify(view?.groups));
  r = await req('GET', '/security/confirm-policy', { s: S.admin });
  check(r.status === 200 && r.data.canChange === true, 'canChange is true for a Platform Admin', msg(r));

  section('ask asks');
  r = await newKey(S.owner, false);
  check(isStepUp(r, 'apikey.create'), 'a stale API key creation is STEP_UP_REQUIRED, naming apikey.create', msg(r));
  r = await newKey(S.owner, true);
  check(r.status === 201 || r.status === 200, 'with a fresh confirmation it is created', msg(r));
  r = await req('GET', '/auth/step-up', { s: S.owner });
  check(r.status === 200 && ['credential.reveal', 'passkey.manage', 'platform.configure'].every((a) => r.data.actions.includes(a)), "the step-up status lists StepUpService's actions as asking", msg(r));

  section('Only a Platform Admin changes it');
  r = await req('PUT', '/security/confirm-policy', { s: S.owner, fresh: true, body: { values: { 'apikey.create': 'off' } } });
  check(r.status === 403 && code(r) !== 'STEP_UP_REQUIRED', 'a Business Owner is refused, even fresh', msg(r));
  r = await req('PUT', '/security/confirm-policy', { s: S.owner, body: { values: { 'apikey.create': 'ask' } } });
  check(r.status === 403, 'and so is a Business Owner asking for ask', msg(r));

  section('Always-ask and unknown keys cannot be set');
  for (const k of ['passkey.manage', 'fresh.auth.passkey', 'confirm.relax']) {
    r = await req('PUT', '/security/confirm-policy', { s: S.admin, fresh: true, body: { values: { [k]: 'off' } } });
    check(r.status === 400 && code(r) === 'CONFIRM_ALWAYS_ASKS', `${k}: refused (CONFIRM_ALWAYS_ASKS), even fresh`, msg(r));
  }
  r = await req('PUT', '/security/confirm-policy', { s: S.admin, fresh: true, body: { values: { 'made.up': 'off' } } });
  check(r.status === 400 && code(r) === 'UNKNOWN_CONFIRM_KEY', 'an unknown key: refused (UNKNOWN_CONFIRM_KEY)', msg(r));
  r = await req('PUT', '/security/confirm-policy', { s: S.admin, fresh: true, body: { values: { 'apikey.create': 'off', 'passkey.manage': 'off' } } });
  check(r.status === 400 && code(r) === 'CONFIRM_ALWAYS_ASKS', 'a batch carrying one always-ask key is refused whole', msg(r));
  r = await req('PUT', '/security/confirm-policy', { s: S.admin, fresh: true, body: { values: { 'apikey.create': 'never' } } });
  check(r.status === 400 && code(r) === 'INVALID_CONFIRM_VALUE', "a value other than ask / off: refused", msg(r));
  r = await req('PUT', '/security/confirm-policy', { s: S.admin, fresh: true, body: { value: 'off' } });
  check(r.status === 400 && code(r) === 'INVALID_CONFIRM_POLICY', "0.47's body shape is refused", msg(r));
  check((await prisma.confirmPolicy.count()) === 0, 'nothing was written by any refusal');

  section('Relaxing needs a fresh confirmation');
  r = await req('PUT', '/security/confirm-policy', { s: S.admin, body: { values: { 'apikey.create': 'off', 'credential.reveal': 'off' } } });
  check(isStepUp(r, 'confirm.relax'), 'a stale Platform Admin turning a confirmation off: STEP_UP_REQUIRED (confirm.relax)', msg(r));
  check((await prisma.confirmPolicy.count()) === 0, 'and nothing was written');
  const t0 = new Date();
  r = await req('PUT', '/security/confirm-policy', { s: S.admin, fresh: true, body: { values: { 'apikey.create': 'off', 'credential.reveal': 'off' } } });
  check(r.status === 200 && r.data.values['apikey.create'] === 'off' && r.data.values['credential.reveal'] === 'off' && r.data.values['software.catalog'] === 'ask', 'with a fresh confirmation: written', msg(r));
  const rows = await prisma.confirmPolicy.findMany({ orderBy: { key: 'asc' } });
  check(rows.length === 2 && rows.every((x) => x.value === 'off' && x.updatedById === admin.id), 'two rows, off, recording who', JSON.stringify(rows));
  const au = await prisma.activityLog.findMany({ where: { action: 'CONFIRM_POLICY_CHANGED', createdAt: { gte: t0 } } });
  check(au.length === 1 && au[0].actorId === admin.id, 'one CONFIRM_POLICY_CHANGED audit row, by the admin', JSON.stringify(au.map((a) => a.actorId)));
  check(au[0] && canon(au[0].metadata) === canon({ before: { 'apikey.create': 'ask', 'credential.reveal': 'ask' }, after: { 'apikey.create': 'off', 'credential.reveal': 'off' } }),
    'its meta is the changed keys before and after, nothing else', JSON.stringify(au[0]?.metadata));

  section('off skips — at once, no restart');
  r = await newKey(S.owner, false);
  check(r.status === 201 || r.status === 200, 'a stale API key creation now succeeds', msg(r));
  r = await req('GET', '/auth/step-up', { s: S.owner });
  check(r.status === 200 && !r.data.actions.includes('credential.reveal') && r.data.actions.includes('passkey.manage') && r.data.actions.includes('platform.configure'), "StepUpService follows the policy: credential.reveal off, passkey.manage still asks", msg(r));
  r = await req('POST', '/auth/passkeys/register/options', { s: S.owner });
  check(isStepUp(r, 'passkey.manage'), 'adding a passkey still asks (always-ask)', msg(r));
  r = await req('PUT', '/security/confirm-policy', { s: S.admin, body: { values: { 'software.catalog': 'off' } } });
  check(isStepUp(r, 'confirm.relax'), 'turning a further confirmation off still asks, with others already off', msg(r));
  r = await req('PUT', '/security/confirm-policy', { s: S.admin, body: { values: { 'apikey.create': 'off' } } });
  check(r.status === 200 && (await prisma.activityLog.count({ where: { action: 'CONFIRM_POLICY_CHANGED', createdAt: { gte: t0 } } })) === 1, 'setting a value it already has asks nothing and audits nothing', msg(r));

  section('Asking again needs no confirmation');
  r = await req('PUT', '/security/confirm-policy', { s: S.admin, body: { values: { 'apikey.create': 'ask' } } });
  check(r.status === 200 && r.data.values['apikey.create'] === 'ask', 'a stale Platform Admin turns apikey.create back to ask', msg(r));
  r = await newKey(S.owner, false);
  check(isStepUp(r, 'apikey.create'), 'and the stale API key creation asks again at once', msg(r));
  const au2 = await prisma.activityLog.findMany({ where: { action: 'CONFIRM_POLICY_CHANGED', createdAt: { gte: t0 } }, orderBy: { createdAt: 'asc' } });
  check(au2.length === 2 && canon(au2[1].metadata) === canon({ before: { 'apikey.create': 'off' }, after: { 'apikey.create': 'ask' } }), 'audited too', JSON.stringify(au2.map((a) => a.metadata)));

  section('The database is the source of truth: read on start, odd rows ignored');
  let refused = false;
  try { await prisma.confirmPolicy.create({ data: { key: 'apikey.create', value: 'maybe' } }); } catch { refused = true; }
  check(refused, "0071's CHECK refuses a value other than ask / off");
  refused = false;
  try { await prisma.confirmPolicy.create({ data: { key: 'DROP TABLE', value: 'off' } }); } catch { refused = true; }
  check(refused, "0071's CHECK refuses a key outside the charset");
  await prisma.confirmPolicy.upsert({ where: { key: 'apikey.create' }, update: { value: 'off' }, create: { key: 'apikey.create', value: 'off' } });
  await prisma.confirmPolicy.create({ data: { key: 'passkey.manage', value: 'off' } });
  await prisma.confirmPolicy.create({ data: { key: 'made.up.key', value: 'off' } });
  await stopApi();
  api = startApi();
  await waitUp();
  const S2 = { admin: await login(admin.email), owner: await login(owner.email) };
  r = await newKey(S2.owner, false);
  check(r.status === 201 || r.status === 200, 'after a restart, apikey.create off (written to the database) skips', msg(r));
  r = await req('POST', '/auth/passkeys/register/options', { s: S2.owner });
  check(isStepUp(r, 'passkey.manage'), 'a passkey.manage row saying off is ignored: still asks', msg(r));
  r = await req('GET', '/security/confirm-policy', { s: S2.admin });
  check(r.status === 200 && !('made.up.key' in r.data.values) && !('passkey.manage' in r.data.values), 'rows outside the catalog are not reported', msg(r));
}

async function cleanup() {
  await stopApi();
  try {
    if (savedPolicy !== null) {
      await prisma.confirmPolicy.deleteMany({});
      if (savedPolicy.length) await prisma.confirmPolicy.createMany({ data: savedPolicy });
    }
    await prisma.apiKey.deleteMany({ where: { customerId: { in: created.businesses } } });
    await prisma.membership.deleteMany({ where: { customerId: { in: created.businesses } } });
    await prisma.customer.deleteMany({ where: { id: { in: created.businesses } } });
    await prisma.activityLog.updateMany({ where: { actorId: { in: created.users } }, data: { actorId: null } }).catch(() => undefined);
    if (created.users.length) await prisma.user.deleteMany({ where: { id: { in: created.users } } }).catch((e) => console.error('users:', e.message.slice(0, 200)));
  } catch (e) { console.error('cleanup:', e.message); }
  await prisma.$disconnect();
}

all().catch((e) => { fail++; failures.push(`crashed: ${e.stack ?? e}`); console.error(e); })
  .finally(async () => {
    const logs = api?.log ?? '';
    await cleanup();
    console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
    if (failures.length) { for (const f of failures) console.log(`  - ${f}`); console.log(`\n── API output (last 4000 characters)\n${logs.slice(-4000)}`); process.exit(1); }
    process.exit(0);
  });
