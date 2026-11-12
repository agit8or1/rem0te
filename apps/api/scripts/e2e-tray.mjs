#!/usr/bin/env node
/**
 * End-to-end proof of the tray (0.36): the tray icon on a managed Windows
 * computer, its chat page (/assist), support requests and self-help tools.
 * The computer side is simulated over the real routes, exactly as the agent
 * sends them: the signed tray host with the device secret, the standard
 * tray with its tray key, the standard heartbeat pairing with the device
 * secret, and the /assist page with its cookie and nothing else.
 *
 *   - pairing: the standard heartbeat is told to pair, /tray/pair mints a key
 *     (stored as a hash), re-pairing replaces it, the signed agent has none,
 *     a standard computer's device secret is not a tray credential, a bad key
 *     is refused and audited;
 *   - one-time chat codes: minted by the tray, stored as a hash, exchanged
 *     once at /assist/open for an HttpOnly, Secure, SameSite=Strict cookie on
 *     Path=/assist, a 303 off the URL; replay, an expired code and a guess
 *     are the same refusal; the page needs the cookie and x-assist on writes;
 *     no portal session is an /assist session and the reverse;
 *   - the page: strict CSP, no-store, nosniff, no secret, no code;
 *   - chat: a technician's chat reaches the tray (badge, delivered) and the
 *     page (shown, read, reply); the person starts one from the page (a
 *     support request in the queue, with a fixed description); one Windows
 *     account per chat;
 *   - recording: changing it needs a fresh sign-in and is audited (business
 *     owner for theirs, Platform Admin for any and for the default); a chat
 *     that is not recorded deletes each message once both sides have it and
 *     everything at the end — proven by counting rows;
 *   - a support request with resource usage and a screenshot: stored as
 *     attachments, served only to someone who can see the computer as well
 *     as the queue, with nosniff and a sandbox CSP; size, type, per-device,
 *     per-user and open caps;
 *   - self-help: the closed catalog, elevated tools signed-only, per-tool
 *     rate, offline reports, events on the computer's history, audit with no
 *     username;
 *   - containment: `actions` stops the elevated tools (and is recorded as a
 *     refused run), `remote` also the RustDesk restart and new chats; neither
 *     stops a support request;
 *   - business A/B isolation for people and for devices;
 *   - no message text, tray key, code or device secret in the audit log.
 *
 *   cd apps/api && npx nest build
 *   DATABASE_URL=postgresql://…/<name containing scratch or test> node scripts/e2e-tray.mjs
 *
 * Self-starting: it runs its own API from dist/ on TRAY_API_PORT (3632).
 * INTEGRATION, not Windows: the tray program has not run here; its own code
 * is tested by `go test ./internal/tray ./cmd/rem0te-tray`.
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const DB = process.env.DATABASE_URL ?? '';
const dbName = DB.split('/').pop()?.split('?')[0] ?? '';
if (!/scratch|test/.test(dbName)) { console.error(`Refusing to run against database "${dbName}": name must contain "scratch" or "test".`); process.exit(2); }
const PORT = Number(process.env.TRAY_API_PORT ?? 3632);
if ([3000, 3001, 4000, 4001, 443].includes(PORT)) { console.error(`Refusing port ${PORT}`); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'tray-e2e-password-123456';
const MARK = `zt${sfx}`; // every message and request text carries it, so the audit scan can look for it

let pass = 0, fail = 0;
const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;
const sha = (b) => createHash('sha256').update(b).digest('hex');

const apiEnv = {
  ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATABASE_URL: DB,
  JWT_SECRET: randomBytes(32).toString('hex'), LAUNCHER_TOKEN_SECRET: randomBytes(32).toString('hex'),
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? randomBytes(32).toString('hex'), TRUSTED_PROXIES: 'loopback', HBBS_PRESENCE_HOST: '127.0.0.2',
  VERSION_FILE: path.resolve(here, '..', '..', '..', 'version.json'), MONITOR_SWEEP: 'off', CLIENT_UPDATE_SWEEP: 'off', PATCH_POLICY_SWEEP: 'off', METRIC_SWEEP: 'off',
  CHAT_RETENTION_SWEEP: 'off', TRAY_SWEEP: 'off', RETENTION_SWEEP: 'off', SNAPSHOT_SWEEP: 'off',
};
let api;
function startApi() {
  api = spawn(process.execPath, [path.join(dist, 'main.js')], { env: apiEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  api.log = ''; api.stdout.on('data', (d) => { api.log += d; }); api.stderr.on('data', (d) => { api.log += d; });
}
async function stopApi() { if (!api || api.exitCode !== null) return; await new Promise((r) => { api.once('exit', r); api.kill('SIGTERM'); }); }
async function waitUp() {
  for (let i = 0; i < 120; i++) { try { const r = await fetch(`${API}/health`); if (r.status < 500) return; } catch { /* not yet */ } await sleep(300); }
  throw new Error(`api did not come up:\n${api.log.slice(-3000)}`);
}

// Paced under the 20 req/s burst throttler; a fresh client address per request
// so the per-IP route limits do not decide a check meant for something else.
const pace = () => new Promise((res) => setTimeout(res, 60));
async function req(method, p, { s, body, headers = {}, cookie, raw } = {}) {
  await pace();
  const h = { 'x-forwarded-for': s?.ip ?? ip(), ...headers };
  if (body !== undefined) h['content-type'] = 'application/json';
  const c = [s?.cookie, s?.stepUp ? `step_up=${s.stepUp}` : null, cookie].filter(Boolean).join('; ');
  if (c) h.cookie = c;
  const r = await fetch(`${API}${p}`, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
  if (raw) return { status: r.status, headers: r.headers, buf: Buffer.from(await r.arrayBuffer()) };
  const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j, data: j?.data, text, headers: r.headers };
}
async function login(email) {
  const s = { ip: ip() };
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': s.ip }, body: JSON.stringify({ email, password: PW }) });
  const mm = (r.headers.get('set-cookie') ?? '').match(/access_token=([^;]+)/);
  if (r.status !== 200 || !mm) throw new Error(`login ${email}: ${r.status} ${await r.text()}`);
  s.cookie = `access_token=${mm[1]}`;
  return s;
}
async function stepUp(s) {
  const r = await req('POST', '/auth/step-up', { s, body: { password: PW } });
  const mm = (r.headers.get('set-cookie') ?? '').match(/step_up=([^;]+)/);
  if (r.status !== 200 || !mm) throw new Error(`step-up: ${r.status} ${r.text}`);
  s.stepUp = mm[1];
}
const code = (r) => r.body?.code ?? r.body?.message?.code;
const msg = (r) => `HTTP ${r.status} ${JSON.stringify(r.body ?? '').slice(0, 400)}`;

// ── The computer side ────────────────────────────────────────────────────────
// The signed tray host: device secret. The standard tray: tray key. Both name
// the Windows account in the session as localUser.
const dev = (ep, extra = {}) => (ep.trayKey ? { trayKey: ep.trayKey, ...extra } : { rustdeskId: ep.rid, agentSecret: ep.secret, ...extra });
const tray = {
  status: (ep, user, delivered) => req('POST', '/tray/status', { body: dev(ep, { localUser: user, ...(delivered ? { delivered } : {}) }) }),
  code: (ep, user) => req('POST', '/tray/chat-code', { body: dev(ep, { localUser: user }) }),
  support: (ep, user, description, extra = {}) => req('POST', '/tray/support-requests', { body: dev(ep, { localUser: user, description, ...extra }) }),
  begin: (ep, user, tool) => req('POST', '/tray/self-help/begin', { body: dev(ep, { localUser: user, tool }) }),
  result: (ep, user, body) => req('POST', '/tray/self-help/result', { body: dev(ep, { localUser: user, ...body }) }),
  pair: (ep, secret = ep.secret) => req('POST', '/tray/pair', { body: { rustdeskId: ep.rid, agentSecret: secret } }),
};
const heartbeat = (ep, extra = {}) => req('POST', '/enrollment/heartbeat', { body: { rustdeskId: ep.rid, agentSecret: ep.secret, hostname: ep.hostname, platform: ep.platform, ...extra } });

// ── The /assist page, as the WebView2 window loads it ───────────────────────
async function openPage(ep, user) {
  const c = await tray.code(ep, user);
  if (c.status !== 200) return { mint: c };
  const o = await req('GET', `/assist/open?c=${encodeURIComponent(c.data.code)}`, { raw: true });
  const sc = o.headers.get('set-cookie') ?? '';
  const m = sc.match(/rem0te_assist=([^;]+)/);
  return { mint: c, open: o, setCookie: sc, cookie: m ? `rem0te_assist=${m[1]}` : null, code: c.data.code };
}
const page = {
  state: (p) => req('GET', '/assist/api/state', { cookie: p.cookie }),
  start: (p, text, clientId = randomBytes(9).toString('hex')) => req('POST', '/assist/api/start', { cookie: p.cookie, headers: { 'x-assist': '1' }, body: { text, clientId } }),
  send: (p, text, clientId = randomBytes(9).toString('hex')) => req('POST', '/assist/api/messages', { cookie: p.cookie, headers: { 'x-assist': '1' }, body: { text, clientId } }),
  receipts: (p, body) => req('POST', '/assist/api/receipts', { cookie: p.cookie, headers: { 'x-assist': '1' }, body }),
  end: (p) => req('POST', '/assist/api/end', { cookie: p.cookie, headers: { 'x-assist': '1' }, body: {} }),
};

// A real PNG (decodable), and a JPEG header of a given size.
function png(w, h) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const rows = Buffer.alloc((w * 3 + 1) * h); for (let i = 0; i < rows.length; i++) rows[i] = i % (w * 3 + 1) === 0 ? 0 : (i * 7) & 255;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
const jpeg = (w, h, pad = 0) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]), randomBytes(pad), Buffer.from([0xff, 0xd9])]);

const created = { businesses: [], users: [] };
let savedDefault = null;

async function all() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });
  const roleUser = await prisma.role.findFirst({ where: { type: 'BUSINESS_USER' } });
  const startedAt = new Date();
  savedDefault = (await prisma.platformSettings.findUnique({ where: { id: 'singleton' }, select: { chatRecordingDefault: true } }))?.chatRecordingDefault ?? true;

  section('Fixtures (synthetic): Acme and Birch; owners, a Platform Admin, a technician, a queue-only user, a viewer; computers of each kind');
  const acme = await prisma.customer.create({ data: { tenantId: tenant.id, name: `Acme Dental ${sfx}` } });
  const birch = await prisma.customer.create({ data: { tenantId: tenant.id, name: `Birch Law ${sfx}` } });
  created.businesses.push(acme.id, birch.id);
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag, extra = {}) => { const u = await prisma.user.create({ data: { email: `tray-${tag}-${sfx}@test.invalid`, passwordHash: hash, firstName: tag, lastName: 'Tray', status: 'ACTIVE', ...extra } }); created.users.push(u.id); return u; };
  const admin = await mkUser('admin', { isPlatformAdmin: true });
  const owen = await mkUser('owen'), bea = await mkUser('bea'), tara = await mkUser('tara'), quinn = await mkUser('quinn'), vic = await mkUser('vic');
  await prisma.membership.create({ data: { userId: owen.id, tenantId: tenant.id, customerId: acme.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: bea.id, tenantId: tenant.id, customerId: birch.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: tara.id, tenantId: tenant.id, customerId: acme.id, roleId: roleUser.id, capabilities: ['computers:view', 'support:chat', 'support:requests'] } });
  // Quinn works the queue but is granted no computer: she sees requests, not what came from a computer.
  await prisma.membership.create({ data: { userId: quinn.id, tenantId: tenant.id, customerId: acme.id, roleId: roleUser.id, capabilities: ['computers:view', 'support:requests'] } });
  await prisma.membership.create({ data: { userId: vic.id, tenantId: tenant.id, customerId: acme.id, roleId: roleUser.id, capabilities: ['computers:view'] } });
  const mkEp = async (biz, hostname, { platform = 'Windows 11', channel = 'signed', chat = 2, trayP = 1 } = {}) => {
    const e = await prisma.endpoint.create({ data: {
      tenantId: tenant.id, customerId: biz?.id ?? null, name: hostname, hostname, platform, status: 'ACTIVE', isOnline: true, isManaged: true,
      accessMode: 'ASSIGNED_USERS', lastSeenAt: new Date(), deviceClass: 'WORKSTATION', updateChannel: channel,
      chatProtocol: channel === 'signed' ? chat : null, trayProtocol: channel === 'signed' ? trayP : null, agentVersion: '0.36.0',
    } });
    const rid = String(100000000 + ((Math.random() * 899999999) | 0));
    const secret = randomBytes(24).toString('hex');
    await prisma.rustdeskNode.create({ data: { tenantId: tenant.id, endpointId: e.id, rustdeskId: rid, agentSecretHash: sha(secret) } });
    return { id: e.id, rid, secret, hostname, platform };
  };
  const sPC = await mkEp(acme, 'FRONTDESK'), std = await mkEp(acme, 'RECEPTION', { channel: 'legacy' }), lin = await mkEp(acme, 'web01', { platform: 'Linux', channel: 'legacy' });
  const bPC = await mkEp(birch, 'BIRCH-PC');
  for (const ep of [sPC, std, lin]) await prisma.computerAccess.create({ data: { tenantId: tenant.id, endpointId: ep.id, userId: tara.id } });
  await prisma.computerAccess.create({ data: { tenantId: tenant.id, endpointId: sPC.id, userId: vic.id } });

  startApi();
  await waitUp();
  const S = { admin: await login(admin.email), owen: await login(owen.email), bea: await login(bea.email), tara: await login(tara.email), quinn: await login(quinn.email), vic: await login(vic.email) };
  const ALICE = 'ACME\\alice', BOB = 'ACME\\bob';
  let r;

  // ── Pairing ────────────────────────────────────────────────────────────────
  section('Pairing the standard agent\'s tray');
  r = await heartbeat(std, { updateChannel: 'legacy', agentTray: 1 });
  check(r.status === 200 && r.data?.tray?.pair === true, 'a standard heartbeat with a tray and no key is told to pair', msg(r));
  let row = await prisma.endpoint.findUnique({ where: { id: std.id }, select: { trayProtocol: true } });
  check(row.trayProtocol === null, 'and the tray is not believed until it is paired', JSON.stringify(row));
  r = await tray.pair(std, randomBytes(24).toString('hex'));
  check(r.status === 401, 'pairing with the wrong device secret: 401', msg(r));
  r = await tray.pair(std);
  const key1 = r.data?.trayKey;
  check(r.status === 200 && /^tk_[a-z0-9]{24}\.[A-Za-z0-9_-]{43}$/.test(key1 ?? '') && r.data.keyId === key1.slice(3, 27), 'pairing with the device secret mints a tray key', msg(r));
  row = await prisma.endpoint.findUnique({ where: { id: std.id }, select: { trayKeyId: true, trayKeyHash: true } });
  check(row.trayKeyId === r.data.keyId && row.trayKeyHash === sha(key1.split('.')[1]) && !JSON.stringify(row).includes(key1.split('.')[1]), 'only the key id and the hash of its secret are stored');
  r = await heartbeat(std, { updateChannel: 'legacy', agentTray: 1, trayKeyId: key1.slice(3, 27) });
  row = await prisma.endpoint.findUnique({ where: { id: std.id }, select: { trayProtocol: true } });
  check(r.data?.tray === null && row.trayProtocol === 1, 'with the key id in the heartbeat: tray recorded, no pairing asked', `${msg(r)} ${JSON.stringify(row)}`);
  r = await tray.pair(std);
  const key2 = r.data?.trayKey;
  std.trayKey = key1;
  r = await tray.status(std, ALICE);
  check(r.status === 401, 're-pairing replaces the key: the old one stops working at once', msg(r));
  std.trayKey = key2;
  r = await tray.status(std, ALICE);
  check(r.status === 200 && r.data?.agent === 'standard', 'the new key works', msg(r));
  await heartbeat(std, { updateChannel: 'legacy', agentTray: 1, trayKeyId: key2.slice(3, 27) });
  r = await tray.pair(sPC);
  check(r.status === 409 && code(r) === 'TRAY_SIGNED', 'the signed agent\'s tray has no key: pairing it is refused', msg(r));
  r = await req('POST', '/tray/status', { body: { rustdeskId: std.rid, agentSecret: std.secret, localUser: ALICE } });
  check(r.status === 403 && code(r) === 'TRAY_KEY_REQUIRED', 'a standard computer\'s device secret is not a tray credential (its tray holds only the key)', msg(r));
  r = await req('POST', '/tray/status', { body: { trayKey: `tk_${'0'.repeat(24)}.${'A'.repeat(43)}` } });
  check(r.status === 401, 'an unknown tray key: 401', msg(r));
  const rej = await prisma.activityLog.findFirst({ where: { action: 'ENDPOINT_HEARTBEAT_REJECTED', createdAt: { gte: startedAt }, metadata: { path: ['reason'], equals: 'tray_key_unauthenticated' } } });
  check(!!rej && !JSON.stringify(rej.metadata).includes('AAAA'), 'refused tray keys are audited, without the key', JSON.stringify(rej?.metadata));
  const paired = await prisma.activityLog.findMany({ where: { action: 'TRAY_PAIRED', resourceId: std.id } });
  check(paired.length === 2 && paired[1].metadata.replaced === true && paired.every((a) => !JSON.stringify(a.metadata).includes(key2.split('.')[1])), 'TRAY_PAIRED twice (the second "replaced"), never with the secret', JSON.stringify(paired.map((a) => a.metadata)));
  r = await req('POST', '/tray/status', { body: { rustdeskId: sPC.rid, agentSecret: randomBytes(24).toString('hex') } });
  check(r.status === 401, 'the signed tray host with the wrong device secret: 401', msg(r));

  // ── Status ────────────────────────────────────────────────────────────────
  section('What the tray is told');
  await prisma.tenant.update({ where: { id: tenant.id }, data: {} });
  r = await tray.status(sPC, ALICE);
  const st = r.data;
  check(r.status === 200 && st.businessName === acme.name && st.agent === 'signed' && st.hasBusiness === true && st.businessId === acme.id && st.chat?.open === false && st.pollSeconds === 600, 'signed: the business name, agent type, no chat, a slow poll', msg(r));
  check(st.selfHelp?.length === 6 && st.selfHelp.every((t) => t.blocked === null) && st.recordNew === true, 'signed: all six tools, none blocked; chats recorded by default', JSON.stringify(st.selfHelp));
  check(!JSON.stringify(st).includes(sPC.secret), 'the response carries no secret');
  r = await tray.status(std, ALICE);
  check(r.data?.selfHelp?.length === 3 && r.data.selfHelp.every((t) => !t.elevated), 'standard: the three read-only tools only', JSON.stringify(r.data?.selfHelp));
  r = await tray.status(bPC, 'BIRCH\\carol');
  check(r.data?.businessName === birch.name && r.data.businessId === birch.id, 'Birch\'s tray is told Birch\'s name, nothing of Acme', JSON.stringify(r.data?.businessName));

  // ── One-time codes and the page ──────────────────────────────────────────
  section('One-time chat codes, the /assist cookie, and the page');
  r = await tray.code(lin, ALICE);
  check(r.status === 403 || r.status === 401, 'a Linux computer has no tray: no code', msg(r));
  let p = await openPage(sPC, ALICE);
  check(p.mint.status === 200 && /^[A-Za-z0-9_-]{43}$/.test(p.code) && !('url' in p.mint.data), 'the tray gets a code — never a URL — and builds the link itself', msg(p.mint));
  const codeRow = await prisma.assistCode.findFirst({ where: { endpointId: sPC.id }, orderBy: { createdAt: 'desc' } });
  check(codeRow.codeHash === sha(p.code) && !JSON.stringify(codeRow).includes(p.code) && codeRow.expiresAt - codeRow.createdAt === 60_000, 'only its hash is stored; it lives 60 seconds', JSON.stringify({ ...codeRow, codeHash: '…' }));
  check(p.open.status === 303 && p.open.headers.get('location') === 'chat', '/assist/open answers 303 to the page: the code leaves the address bar at once', `${p.open.status} ${p.open.headers.get('location')}`);
  check(/HttpOnly/.test(p.setCookie) && /Secure/.test(p.setCookie) && /SameSite=Strict/.test(p.setCookie) && /Path=\/assist(;|$)/.test(p.setCookie) && /Max-Age=7200/.test(p.setCookie), 'the cookie: HttpOnly, Secure, SameSite=Strict, Path=/assist, 2 hours', p.setCookie.replace(/=[A-Za-z0-9_-]{43}/, '=…'));
  check(p.cookie && !p.cookie.includes(p.code), 'the cookie is not the code');
  r = await req('GET', `/assist/open?c=${encodeURIComponent(p.code)}`, { raw: true });
  check(r.status === 410 && !(r.headers.get('set-cookie') ?? '').includes('rem0te_assist='), 'replaying the code from history: 410, no cookie', `${r.status}`);
  r = await req('GET', `/assist/open?c=${randomBytes(32).toString('base64url')}`, { raw: true });
  check(r.status === 410, 'a guessed code: the same refusal', `${r.status}`);
  const c2 = await tray.code(sPC, ALICE);
  await prisma.assistCode.updateMany({ where: { codeHash: sha(c2.data.code) }, data: { expiresAt: new Date(Date.now() - 1000) } });
  r = await req('GET', `/assist/open?c=${encodeURIComponent(c2.data.code)}`, { raw: true });
  check(r.status === 410, 'an expired code: the same refusal', `${r.status}`);
  const pg = await req('GET', '/assist/chat', { raw: true });
  const csp = pg.headers.get('content-security-policy') ?? '';
  check(pg.status === 200 && /default-src 'none'/.test(csp) && /script-src 'self'/.test(csp) && !/unsafe/.test(csp) && /frame-ancestors 'none'/.test(csp), 'the page: a strict CSP, no unsafe sources', csp);
  check(pg.headers.get('x-content-type-options') === 'nosniff' && /no-store/.test(pg.headers.get('cache-control') ?? '') && pg.headers.get('referrer-policy') === 'no-referrer', 'nosniff, no-store, no-referrer');
  const html = pg.buf.toString();
  check(!/rem0te_assist|agentSecret|trayKey/.test(html) && !html.includes(p.code), 'the page source holds no cookie, code, key or secret');
  const js = await req('GET', '/assist/assist.js', { raw: true });
  check(js.status === 200 && /javascript/.test(js.headers.get('content-type') ?? '') && !/innerHTML/.test(js.buf.toString()), 'its script is served as JavaScript and never sets innerHTML');
  r = await page.state({ cookie: null });
  check(r.status === 401 && code(r) === 'ASSIST_EXPIRED', 'the page\'s API without the cookie: 401', msg(r));
  r = await req('GET', '/assist/api/state', { s: S.owen });
  check(r.status === 401, 'a portal session is not an /assist session', msg(r));
  r = await req('GET', '/endpoints', { cookie: p.cookie });
  check(r.status === 401, 'and the /assist cookie opens nothing in the portal', msg(r));
  r = await page.state(p);
  check(r.status === 200 && r.data.businessName === acme.name && r.data.conversation === null && r.data.canStart === true && r.data.recordNew === true, 'with the cookie: the business, no chat yet, may start one, recorded', msg(r));
  r = await req('POST', '/assist/api/start', { cookie: p.cookie, body: { text: `${MARK} hi`, clientId: 'abcdefgh1' } });
  check(r.status === 403 && code(r) === 'ASSIST_HEADER', 'a write without x-assist (a cross-site form cannot set it): 403', msg(r));

  // ── A technician's chat reaches the tray and the page ───────────────────
  section('A technician\'s chat: tray badge, delivered, shown, read, reply');
  r = await req('POST', `/endpoints/${sPC.id}/chat/conversations`, { s: S.tara, body: {} });
  const conv1 = r.data?.conversation;
  check(r.status === 201 && conv1?.recorded === true && conv1.startedBy === 'technician', 'Tara starts a chat: recorded, started by a technician', msg(r));
  r = await heartbeat(sPC, { updateChannel: 'signed', agentChat: 2, agentTray: 1 });
  check(r.data?.chat?.open === true, 'the heartbeat says a chat is open (the agent writes the tray\'s signal file)', JSON.stringify(r.data?.chat));
  r = await req('POST', `/endpoints/${sPC.id}/chat/conversations/${conv1.id}/messages`, { s: S.tara, body: { text: `${MARK} Hello from IT <b>bold</b>` } });
  const tm1 = r.data?.message;
  r = await tray.status(sPC, ALICE);
  check(r.data?.chat?.open === true && r.data.chat.unread?.includes(tm1.id) && r.data.chat.autoOpen === true && r.data.pollSeconds === 10, 'the tray: chat open, one unread (the badge), open it automatically, poll fast', JSON.stringify(r.data?.chat));
  await tray.status(sPC, ALICE, [tm1.id]);
  let m = await prisma.chatMessage.findUnique({ where: { id: tm1.id } });
  check(m.deliveredAt && !m.shownAt, 'the tray reporting it showed the badge: delivered, not shown');
  await tray.status(bPC, 'BIRCH\\carol', [tm1.id]);
  r = await tray.status(bPC, 'BIRCH\\carol');
  check(r.data?.chat?.open === false, 'Birch\'s tray learns nothing of Acme\'s chat', JSON.stringify(r.data?.chat));
  p = await openPage(sPC, ALICE);
  r = await page.state(p);
  check(r.status === 200 && r.data.conversation?.id === conv1.id && r.data.messages?.[0]?.text === `${MARK} Hello from IT <b>bold</b>` && r.data.conversation.recorded === true, 'the page binds to the open chat and gets the message as text', msg(r));
  await page.receipts(p, { shown: [tm1.id] });
  m = await prisma.chatMessage.findUnique({ where: { id: tm1.id } });
  check(m.shownAt && !m.readAt, 'shown when the page reports it drawn');
  await page.receipts(p, { read: [tm1.id] });
  r = await req('GET', `/endpoints/${sPC.id}/chat/conversations/${conv1.id}`, { s: S.tara });
  check(r.data?.messages?.find((x) => x.id === tm1.id)?.receipt === 'read', 'read when it is in front; the technician sees "read"', JSON.stringify(r.data?.messages?.[0]));
  r = await page.send(p, `${MARK} the printer is offline`, 'clientid-aaa1');
  const um1 = r.data;
  r = await page.send(p, `${MARK} the printer is offline`, 'clientid-aaa1');
  check(r.data?.duplicate === true && r.data.id === um1.id, 'a retried reply with the same client id is stored once', msg(r));
  r = await req('GET', `/endpoints/${sPC.id}/chat/conversations/${conv1.id}`, { s: S.vic });
  const ut = r.data?.messages?.find((x) => x.id === um1.id);
  check(ut?.sender === 'END_USER' && ut.authorName === ALICE, 'a viewer reads the reply, signed as the Windows account', JSON.stringify(ut));
  const bob = await openPage(sPC, BOB);
  check(bob.mint.status === 409 && code(bob.mint) === 'CHAT_OTHER_USER', 'another Windows account on the same computer is told the chat is someone else\'s (no code)', msg(bob.mint));
  r = await tray.status(sPC, BOB);
  check(r.data?.chat?.open === false && r.data.chat.otherUser === true, 'and Bob\'s tray shows no badge for Alice\'s chat', JSON.stringify(r.data?.chat));
  r = await page.end(p);
  check(r.status === 200 && r.data?.ended === true, 'the person ends the chat from the page', msg(r));
  r = await page.state(p);
  check(r.data?.conversation?.status === 'ENDED', 'the page still shows it, ended (the session outlives the chat)', JSON.stringify(r.data?.conversation));
  r = await page.send(p, `${MARK} late`);
  check(r.status === 409, 'and cannot write into it', msg(r));
  m = await prisma.chatMessage.count({ where: { conversationId: conv1.id } });
  check(m === 2, 'a recorded chat keeps its transcript after it ends', `rows=${m}`);

  // ── The person starts a chat ────────────────────────────────────────────
  section('The person at the computer starts a chat from the tray');
  p = await openPage(sPC, ALICE);
  r = await page.state(p);
  check(r.data?.conversation === null && r.data.canStart === true, 'a fresh window: no chat; may start one');
  r = await page.start(p, `${MARK} my email will not send`);
  const conv2 = r.data?.conversationId;
  check(r.status === 201 && !!conv2, 'started', msg(r));
  const c2row = await prisma.chatConversation.findUnique({ where: { id: conv2 } });
  c2row.supportRequest = c2row?.supportRequestId ? await prisma.supportRequest.findUnique({ where: { id: c2row.supportRequestId } }) : null;
  check(c2row.startedBy === 'end_user' && c2row.deviceUser === ALICE && c2row.supportRequest?.origin === 'AGENT' && c2row.supportRequest.status === 'WAITING', 'a conversation started by the person, for their account, with a support request in the queue', JSON.stringify({ startedBy: c2row.startedBy, origin: c2row.supportRequest?.origin }));
  check(!c2row.supportRequest.description.includes(MARK), 'the queue entry\'s description is a fixed sentence: the message is not copied (it would outlive an unrecorded chat)', c2row.supportRequest.description);
  r = await req('GET', `/endpoints/${sPC.id}/chat`, { s: S.tara });
  check(r.data?.open?.id === conv2 && r.data.open.startedBy === 'end_user', 'the technician\'s panel shows it open, started from the tray', JSON.stringify(r.data?.open?.startedBy));
  r = await page.start(p, `${MARK} again`);
  check(r.status === 409 && code(r) === 'CHAT_ALREADY', 'the same window cannot start a second', msg(r));
  await req('POST', `/endpoints/${sPC.id}/chat/conversations/${conv2}/end`, { s: S.tara, body: {} });

  // ── Recording ───────────────────────────────────────────────────────────
  section('Whether chats are recorded: fresh sign-in, audited, owners and admins only');
  r = await req('GET', '/chat-recording', { s: S.owen });
  check(r.status === 200 && r.data.platformDefault === true && r.data.business?.id === acme.id && r.data.business.setting === null && r.data.business.canChange === true && r.data.canChangePlatform === false, 'Owen reads Acme\'s setting (the platform default) and may change it', msg(r));
  r = await req('PUT', '/chat-recording', { s: S.owen, body: { businessId: acme.id, recording: false } });
  check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED', 'without a fresh sign-in: 403 STEP_UP_REQUIRED', msg(r));
  r = await req('PUT', '/chat-recording', { s: S.tara, body: { businessId: acme.id, recording: false } });
  check(r.status === 403, 'a technician cannot change it', msg(r));
  await stepUp(S.bea);
  r = await req('PUT', '/chat-recording', { s: S.bea, body: { businessId: acme.id, recording: false } });
  check(r.status === 403 || r.status === 404, 'Birch\'s owner cannot change Acme\'s, even freshly signed in', msg(r));
  await stepUp(S.owen);
  r = await req('PUT', '/chat-recording', { s: S.owen, body: { businessId: acme.id, recording: false } });
  check(r.status === 200 && r.data.business.setting === false && r.data.business.effective === false, 'freshly signed in: Acme stops recording', msg(r));
  const recAudit = await prisma.activityLog.findFirst({ where: { action: 'CHAT_RECORDING_CHANGED', customerId: acme.id, createdAt: { gte: startedAt } } });
  check(recAudit?.actorId === owen.id && recAudit.metadata.scope === 'business' && recAudit.metadata.before === null && recAudit.metadata.after === false && Object.keys(recAudit.metadata).length === 3, 'audited: who, and before/after only', JSON.stringify(recAudit?.metadata));
  r = await req('PUT', '/chat-recording/platform', { s: S.owen, body: { recording: false } });
  check(r.status === 403, 'only a Platform Admin sets the platform default', msg(r));
  r = await req('PUT', '/chat-recording/platform', { s: S.admin, body: { recording: true } });
  check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED', 'and only freshly signed in', msg(r));
  await stepUp(S.admin);
  r = await req('PUT', '/chat-recording/platform', { s: S.admin, body: { recording: true } });
  check(r.status === 200 && r.data.platformDefault === true, 'the Platform Admin, freshly signed in, sets it', msg(r));
  r = await tray.status(sPC, ALICE);
  check(r.data?.recordNew === false, 'the tray now says new chats are not recorded', JSON.stringify(r.data?.recordNew));
  r = await tray.status(bPC, 'BIRCH\\carol');
  check(r.data?.recordNew === true, 'Birch is unaffected', JSON.stringify(r.data?.recordNew));

  section('A chat that is not recorded: deleted once both sides have it, and at the end');
  r = await req('POST', `/endpoints/${sPC.id}/chat/conversations`, { s: S.tara, body: {} });
  const conv3 = r.data?.conversation;
  check(conv3?.recorded === false, 'Tara\'s new chat is not recorded (frozen at the start)', JSON.stringify(conv3?.recorded));
  p = await openPage(sPC, ALICE);
  r = await page.state(p);
  check(r.data?.conversation?.recorded === false, 'the page is told it is not recorded', JSON.stringify(r.data?.conversation));
  const tA = (await req('POST', `/endpoints/${sPC.id}/chat/conversations/${conv3.id}/messages`, { s: S.tara, body: { text: `${MARK} unrecorded one` } })).data?.message;
  const tB = (await req('POST', `/endpoints/${sPC.id}/chat/conversations/${conv3.id}/messages`, { s: S.tara, body: { text: `${MARK} unrecorded two` } })).data?.message;
  await page.receipts(p, { shown: [tA.id, tB.id] });
  check(await prisma.chatMessage.count({ where: { id: { in: [tA.id, tB.id] } } }) === 2, 'shown is not enough: both rows are still there');
  await page.receipts(p, { read: [tA.id] });
  check(await prisma.chatMessage.count({ where: { id: tA.id } }) === 0 && await prisma.chatMessage.count({ where: { id: tB.id } }) === 1, 'once the page reports one read, that row is deleted — the other stays');
  const uA = (await page.send(p, `${MARK} unrecorded reply`)).data;
  r = await req('POST', `/endpoints/${sPC.id}/chat/conversations/${conv3.id}/ack`, { s: S.vic, body: { ids: [uA.id] } });
  check((r.status === 403 || r.status === 404) && await prisma.chatMessage.count({ where: { id: uA.id } }) === 1, 'a viewer\'s panel acknowledges nothing: the reply stays until the chatting technician sees it', msg(r));
  r = await req('POST', `/endpoints/${sPC.id}/chat/conversations/${conv3.id}/ack`, { s: S.bea, body: { ids: [uA.id] } });
  check(r.status === 404 && await prisma.chatMessage.count({ where: { id: uA.id } }) === 1, 'another business\'s owner: 404, nothing deleted', msg(r));
  r = await req('POST', `/endpoints/${sPC.id}/chat/conversations/${conv3.id}/ack`, { s: S.tara, body: { ids: [uA.id] } });
  check(r.status === 201 || r.status === 200, 'Tara\'s panel acknowledges the reply', msg(r));
  check(r.data?.deleted === 1 && await prisma.chatMessage.count({ where: { id: uA.id } }) === 0, 'and the row is deleted: both sides have it', JSON.stringify(r.data));
  r = await page.state(p);
  check(r.data?.conversation?.status === 'OPEN' && !r.data.messages.some((x) => x.id === tA.id || x.id === uA.id), 'the page\'s next read no longer has them (it shows its own copies)');
  await page.send(p, `${MARK} last words`);
  check(await prisma.chatMessage.count({ where: { conversationId: conv3.id } }) === 2, 'two messages not yet on both sides remain (tB unread, the last reply)');
  await req('POST', `/endpoints/${sPC.id}/chat/conversations/${conv3.id}/end`, { s: S.tara, body: {} });
  check(await prisma.chatMessage.count({ where: { conversationId: conv3.id } }) === 0, 'ending the chat deletes whatever is left');
  const conv3row = await prisma.chatConversation.findUnique({ where: { id: conv3.id } });
  check(conv3row?.status === 'ENDED' && conv3row.recorded === false, 'the conversation row stays (who, when) — the text is gone');
  await stepUp(S.owen);
  await req('PUT', '/chat-recording', { s: S.owen, body: { businessId: acme.id, recording: null } });

  // ── Support requests from the tray ──────────────────────────────────────
  section('A support request from the tray, with resource usage and a screenshot');
  const shot = png(320, 200);
  const usage = { sampledAt: new Date().toISOString(), cpuPercent: 37.5, memoryTotalMb: 16000, memoryUsedMb: 9100, diskTotalMb: 500000, diskFreeMb: 42000, uptimeSeconds: 93000,
    topProcesses: [{ name: 'OUTLOOK.EXE', cpuPercent: 22, memoryMb: 640 }, { name: 'C:\\Users\\alice\\evil.exe', cpuPercent: 99, memoryMb: 1 }] };
  r = await tray.support(sPC, ALICE, `${MARK} Outlook keeps freezing`, { usage, screenshot: shot.toString('base64') });
  const sr1 = r.data?.id;
  check(r.status === 201 && !!sr1, 'sent', msg(r));
  const srRow = await prisma.supportRequest.findUnique({ where: { id: sr1 }, include: { attachments: true } });
  check(srRow.origin === 'AGENT' && srRow.endpointId === sPC.id && srRow.customerId === acme.id && srRow.status === 'WAITING' && srRow.contactName === ALICE, 'in the queue: from the tray, for this computer, signed as the Windows account', JSON.stringify({ origin: srRow.origin, contact: srRow.contactName }));
  const shotAtt = srRow.attachments.find((a) => a.kind === 'screenshot'), useAtt = srRow.attachments.find((a) => a.kind === 'usage');
  check(shotAtt?.contentType === 'image/png' && shotAtt.width === 320 && shotAtt.height === 200 && Buffer.compare(Buffer.from(shotAtt.bytes), shot) === 0, 'the screenshot is stored as an attachment, exactly as sent', JSON.stringify({ ...shotAtt, bytes: undefined }));
  check(useAtt && useAtt.data.topProcesses.length === 1 && useAtt.data.topProcesses[0].name === 'OUTLOOK.EXE' && useAtt.data.cpuPercent === 37.5, 'the usage sample, with a path-like process name dropped', JSON.stringify(useAtt?.data?.topProcesses));
  r = await req('GET', `/support-requests/${sr1}`, { s: S.tara });
  check(r.status === 200 && r.data.attachments?.length === 2 && r.data.attachmentsHidden === 0 && !('bytes' in (r.data.attachments.find((a) => a.kind === 'screenshot') ?? {})), 'Tara (queue + this computer) sees both attachments listed, no bytes inline', msg(r));
  const got = await req('GET', `/support-requests/${sr1}/attachments/${shotAtt.id}`, { s: S.tara, raw: true });
  check(got.status === 200 && got.headers.get('content-type') === 'image/png' && Buffer.compare(got.buf, shot) === 0, 'she fetches the screenshot with her session', `${got.status} ${got.headers.get('content-type')}`);
  check(got.headers.get('x-content-type-options') === 'nosniff' && /sandbox/.test(got.headers.get('content-security-policy') ?? '') && /no-store/.test(got.headers.get('cache-control') ?? ''), 'served with nosniff, a sandbox CSP and no-store', JSON.stringify(Object.fromEntries(got.headers)));
  r = await req('GET', `/support-requests/${sr1}`, { s: S.quinn });
  check(r.status === 200 && r.data.attachments.length === 0 && r.data.attachmentsHidden === 2, 'Quinn works the queue but cannot see the computer: the request, and "2 attachments hidden"', msg(r));
  r = await req('GET', `/support-requests/${sr1}/attachments/${shotAtt.id}`, { s: S.quinn, raw: true });
  check(r.status === 404, '…and fetching the screenshot is a 404 for her', `${r.status}`);
  r = await req('GET', `/support-requests/${sr1}`, { s: S.bea });
  check(r.status === 404, 'Birch\'s owner: the request is a 404', msg(r));
  r = await req('GET', `/support-requests/${sr1}/attachments/${shotAtt.id}`, { s: S.bea, raw: true });
  check(r.status === 404, '…and so is its screenshot', `${r.status}`);
  r = await req('GET', `/support-requests/${sr1}/attachments/${shotAtt.id}`, { raw: true });
  check(r.status === 401, 'without a session: 401', `${r.status}`);

  section('Support request limits');
  r = await tray.support(sPC, ALICE, `${MARK} gif`, { screenshot: Buffer.from('GIF89a\x01\x00\x01\x00').toString('base64') });
  check(r.status === 400, 'a GIF (or anything not JPEG or PNG) is refused', msg(r));
  r = await tray.support(sPC, ALICE, `${MARK} big`, { screenshot: jpeg(1920, 1080, 720 * 1024).toString('base64') });
  check(r.status === 400 || r.status === 413, 'a screenshot over 700 KB is refused', msg(r));
  r = await tray.support(sPC, ALICE, `${MARK} wide`, { screenshot: jpeg(5000, 100).toString('base64') });
  check(r.status === 400, 'wider than 4096 px is refused', msg(r));
  r = await tray.support(sPC, ALICE, '   ');
  check(r.status === 400, 'an empty description is refused', msg(r));
  // Alice has two already this hour: the chat she started from the tray (its queue entry) and sr1.
  r = await tray.support(sPC, ALICE, `${MARK} third from alice`);
  check(r.status === 429 && code(r) === 'SUPPORT_RATE_LIMITED' && /one person/.test(r.body?.message ?? ''), 'a third request from one Windows account in an hour: 429 (refused requests above did not count)', msg(r));
  r = await tray.support(sPC, BOB, `${MARK} near the cap`, { screenshot: jpeg(1600, 900, 690 * 1024).toString('base64') });
  check(r.status === 201, 'another account may still ask; a 690 KB screenshot fits (the request stays under the 1 MB body limit)', msg(r));
  const openNow = await prisma.supportRequest.count({ where: { endpointId: sPC.id, origin: 'AGENT', status: { in: ['WAITING', 'CLAIMED', 'CONNECTING'] } } });
  r = await tray.support(sPC, 'ACME\\carl', `${MARK} from carl`);
  check(r.status === 429 || r.status === 409, `the computer's own caps (3 an hour, 3 open; ${openNow} open now) stop the next one`, msg(r));
  r = await tray.support(std, ALICE, `${MARK} from the standard tray`, { usage: { cpuPercent: 5 } });
  check(r.status === 201, 'the standard tray (tray key) sends one too', msg(r));
  r = await tray.support(lin, ALICE, `${MARK} linux`);
  check(r.status === 403 || r.status === 401, 'a Linux computer has no tray credential', msg(r));

  // ── Self-help ───────────────────────────────────────────────────────────
  section('Self-help: the closed catalog, signed-only elevated tools, rates, offline reports');
  r = await tray.begin(sPC, ALICE, 'cmd.run');
  check(r.status === 400, 'a tool not in the catalog: 400', msg(r));
  r = await tray.begin(sPC, ALICE, 'dns.check');
  const run1 = r.data?.runId;
  check(r.status === 200 && !!run1, 'dns.check may run: a run is recorded', msg(r));
  r = await tray.result(sPC, ALICE, { runId: run1, outcome: 'succeeded', summary: 'DNS is working.\u202e', detail: ['portal: 192.0.2.10', `x${'y'.repeat(390)}`] });
  const run1row = await prisma.traySelfHelpRun.findUnique({ where: { id: run1 } });
  check(r.status === 200 && run1row.status === 'succeeded' && run1row.summary === 'DNS is working.' && run1row.detail.length === 2 && run1row.detail[1].length <= 200 && run1row.localUser === ALICE && run1row.via === 'signed', 'its result: inert text, bounded detail, who and how', JSON.stringify(run1row));
  r = await tray.result(sPC, ALICE, { runId: run1, outcome: 'failed' });
  check(r.status === 404, 'a run reports once', msg(r));
  r = await tray.result(bPC, 'BIRCH\\carol', { runId: (await tray.begin(sPC, ALICE, 'net.details')).data?.runId, outcome: 'succeeded' });
  check(r.status === 404, 'another computer cannot report on this one\'s run', msg(r));
  for (const t of ['dns.flush', 'ip.renew', 'rustdesk.restart']) {
    r = await tray.begin(std, ALICE, t);
    check(r.status === 403 && code(r) === 'SELF_HELP_SIGNED_ONLY', `the standard tray's key never runs ${t}`, msg(r));
  }
  r = await tray.result(std, ALICE, { offline: true, tool: 'ip.renew', outcome: 'succeeded', ranAt: new Date().toISOString() });
  check(r.status === 403, 'nor reports one as run offline', msg(r));
  r = await tray.begin(std, ALICE, 'net.test');
  check(r.status === 200, 'it runs the read-only ones', msg(r));
  await tray.result(std, ALICE, { runId: r.data.runId, outcome: 'failed', summary: 'The local network answers, but your IT provider cannot be reached.' });
  const renews = [];
  for (let i = 0; i < 3; i++) renews.push(await tray.begin(sPC, ALICE, 'ip.renew'));
  check(renews[0].status === 200 && renews[1].status === 200 && renews[2].status === 429 && code(renews[2]) === 'SELF_HELP_RATE_LIMITED', 'ip.renew: twice per 15 minutes per computer, then 429', renews.map((x) => x.status).join());
  for (const x of renews.slice(0, 2)) await tray.result(sPC, ALICE, { runId: x.data.runId, outcome: 'succeeded', summary: 'The IP address was renewed.' });
  r = await tray.result(sPC, ALICE, { offline: true, tool: 'dns.flush', outcome: 'succeeded', summary: 'Flushed while the portal was unreachable.', ranAt: new Date(Date.now() - 3600_000).toISOString() });
  const offRow = r.data?.runId ? await prisma.traySelfHelpRun.findUnique({ where: { id: r.data.runId } }) : null;
  check(r.status === 200 && offRow?.offline === true && offRow.tool === 'dns.flush', 'the signed agent reports a run made while offline', msg(r));
  r = await tray.result(sPC, ALICE, { offline: true, tool: 'dns.flush', outcome: 'succeeded', ranAt: new Date(Date.now() - 8 * 86_400_000).toISOString() });
  check(r.status === 400, 'but not one older than 7 days', msg(r));
  r = await tray.result(sPC, ALICE, { outcome: 'succeeded' });
  check(r.status === 400, 'a result that names no run and is not offline is refused', msg(r));
  const shAudit = await prisma.activityLog.findMany({ where: { action: 'TRAY_SELF_HELP', resourceId: sPC.id } });
  check(shAudit.length >= 4 && shAudit.every((a) => Object.keys(a.metadata).every((k) => ['runId', 'tool', 'outcome', 'offline'].includes(k))), 'each run is audited with the run, tool, outcome and offline flag — no username, no output', JSON.stringify(shAudit.map((a) => a.metadata)));
  r = await req('GET', `/endpoints/${sPC.id}/tray`, { s: S.tara });
  check(r.status === 200 && r.data.tray.kind === 'signed' && r.data.selfHelp.some((x) => x.id === run1 && x.status === 'succeeded') && r.data.selfHelp.some((x) => x.offline), 'the computer\'s history lists the runs, offline ones marked', msg(r));
  check(r.data.requests?.some((q) => q.id === sr1 && q._count.attachments === 2), 'and the requests sent from its tray', JSON.stringify(r.data.requests));
  r = await req('GET', `/endpoints/${sPC.id}/tray`, { s: S.vic });
  check(r.status === 200 && r.data.requests === null, 'a viewer without the queue sees the runs but not the requests', msg(r));
  r = await req('GET', `/endpoints/${std.id}/tray`, { s: S.tara });
  check(r.data?.tray?.kind === 'standard', 'the standard computer: kind standard', JSON.stringify(r.data?.tray));
  r = await req('GET', `/endpoints/${lin.id}/tray`, { s: S.tara });
  check(r.data?.tray?.kind === 'unsupported' && /Linux and macOS/.test(r.data.tray.message), 'Linux: not supported, saying so', JSON.stringify(r.data?.tray));
  r = await req('GET', `/endpoints/${sPC.id}/tray`, { s: S.bea });
  check(r.status === 404, 'another business: 404', msg(r));
  r = await req('GET', `/endpoints/${std.id}/tray`, { s: S.vic });
  check(r.status === 404, 'a Business User who cannot see the computer: 404', msg(r));

  // ── Containment ─────────────────────────────────────────────────────────
  section('Containment');
  const pzA = await prisma.containmentPause.create({ data: { scope: 'BUSINESS', customerId: acme.id, kinds: ['actions'], reason: `tray e2e ${sfx}: actions`, setById: owen.id, setBy: 'msp' } });
  r = await tray.status(sPC, ALICE);
  const blocked = Object.fromEntries((r.data?.selfHelp ?? []).map((t) => [t.id, t.blocked]));
  check(r.data?.contained?.actions && blocked['dns.flush'] && blocked['ip.renew'] && blocked['rustdesk.restart'] && !blocked['dns.check'] && !blocked['net.test'], 'an actions pause: the tray shows the elevated tools blocked, the read-only ones not', JSON.stringify(blocked));
  const before = await prisma.traySelfHelpRun.count({ where: { endpointId: sPC.id, status: 'refused' } });
  r = await tray.begin(sPC, ALICE, 'dns.flush');
  check(r.status === 403 && code(r) === 'CONTAINED', 'dns.flush under an actions pause: 403 CONTAINED', msg(r));
  check(await prisma.traySelfHelpRun.count({ where: { endpointId: sPC.id, status: 'refused' } }) === before + 1, 'recorded as a refused run, so the history says someone tried');
  r = await tray.begin(sPC, ALICE, 'net.details');
  check(r.status === 200, 'a read-only tool still runs', msg(r));
  await tray.result(sPC, ALICE, { runId: r.data.runId, outcome: 'succeeded' });
  r = await tray.begin(bPC, 'BIRCH\\carol', 'dns.flush');
  check(r.status === 200, 'Birch is not paused', msg(r));
  await tray.result(bPC, 'BIRCH\\carol', { runId: r.data.runId, outcome: 'succeeded' });
  await prisma.containmentPause.update({ where: { id: pzA.id }, data: { clearedAt: new Date(), clearedById: owen.id, clearReason: 'e2e' } });
  const pzR = await prisma.containmentPause.create({ data: { scope: 'BUSINESS', customerId: acme.id, kinds: ['remote'], reason: `tray e2e ${sfx}: remote`, setById: owen.id, setBy: 'msp' } });
  r = await tray.begin(sPC, ALICE, 'rustdesk.restart');
  check(r.status === 403 && code(r) === 'CONTAINED', 'a remote pause stops the RustDesk restart', msg(r));
  r = await tray.begin(sPC, ALICE, 'dns.check');
  check(r.status === 200, 'but not a read-only tool', msg(r));
  p = await openPage(sPC, ALICE);
  r = await page.state(p);
  check(r.data?.canStart === false && !!r.data.contained, 'the page cannot start a chat under a remote pause, and says why', JSON.stringify({ canStart: r.data?.canStart, contained: r.data?.contained }));
  r = await page.start(p, `${MARK} contained`);
  check(r.status === 403 && code(r) === 'CONTAINED', 'starting one anyway: 403 CONTAINED', msg(r));
  r = await tray.support(std, BOB, `${MARK} during a pause`);
  check(r.status === 201, 'a support request is never stopped by containment', msg(r));
  await prisma.containmentPause.update({ where: { id: pzR.id }, data: { clearedAt: new Date(), clearedById: owen.id, clearReason: 'e2e' } });

  // ── Isolation and the audit log ─────────────────────────────────────────
  section('Business A/B isolation for devices');
  const pb = await openPage(bPC, 'BIRCH\\carol');
  r = await page.state(pb);
  check(r.data?.businessName === birch.name && r.data.conversation === null, 'Birch\'s page session sees Birch, and no Acme chat', JSON.stringify(r.data?.businessName));
  await prisma.assistSession.updateMany({ where: { tokenHash: sha(pb.cookie.split('=')[1]) }, data: { conversationId: conv2 } });
  r = await page.state(pb);
  check(!r.data?.conversation, 'even a Birch session pointed at an Acme conversation id reads nothing of it', JSON.stringify(r.data?.conversation));
  r = await page.send(pb, `${MARK} into acme`);
  check(r.status === 404 || r.status === 409, 'and cannot write into it', msg(r));

  section('The audit log: no message text, request text, codes, keys or secrets');
  const logs = await prisma.activityLog.findMany({ where: { createdAt: { gte: startedAt } } });
  const blob = JSON.stringify(logs.map(({ seq, ...a }) => a));
  check(!blob.includes(MARK), `no message or request text in ${logs.length} audit rows`);
  check(!blob.includes(sPC.secret) && !blob.includes(std.secret) && !blob.includes(key2.split('.')[1]) && !blob.includes(p.code), 'no device secret, tray key secret or chat code');
  const started = logs.filter((a) => a.action === 'CHAT_STARTED' && a.resourceId === sPC.id);
  check(started.some((a) => a.metadata.by === 'end_user' && a.actorId === null) && started.every((a) => typeof a.metadata.recorded === 'boolean'), 'CHAT_STARTED says who started it and whether it is recorded', JSON.stringify(started.map((a) => a.metadata)));
  const sub = logs.filter((a) => a.action === 'SUPPORT_REQUEST_SUBMITTED' && a.metadata?.origin === 'AGENT');
  check(sub.length >= 3 && sub.some((a) => a.metadata.screenshot === true && a.metadata.usage === true), 'tray requests are audited with whether they carried a screenshot and usage', JSON.stringify(sub.map((a) => a.metadata)));
}

async function cleanup() {
  await stopApi();
  try {
    const ids = created.businesses;
    const eps = (await prisma.endpoint.findMany({ where: { customerId: { in: ids } }, select: { id: true } })).map((e) => e.id);
    await prisma.chatConversation.deleteMany({ where: { endpointId: { in: eps } } });
    await prisma.supportRequest.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.traySelfHelpRun.deleteMany({ where: { endpointId: { in: eps } } });
    await prisma.assistSession.deleteMany({ where: { endpointId: { in: eps } } });
    await prisma.assistCode.deleteMany({ where: { endpointId: { in: eps } } });
    await prisma.containmentPause.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.computerAccess.deleteMany({ where: { endpointId: { in: eps } } });
    await prisma.rustdeskNode.deleteMany({ where: { endpointId: { in: eps } } });
    await prisma.endpoint.deleteMany({ where: { id: { in: eps } } });
    await prisma.membership.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.customer.deleteMany({ where: { id: { in: ids } } });
    if (created.users.length) await prisma.user.deleteMany({ where: { id: { in: created.users } } });
    if (savedDefault !== null) await prisma.platformSettings.updateMany({ where: { id: 'singleton' }, data: { chatRecordingDefault: savedDefault } });
  } catch (e) { console.error('cleanup:', e.message); }
  await prisma.$disconnect();
}

all().catch((e) => { fail++; failures.push(`crashed: ${e.stack ?? e}`); console.error(e); if (api) console.error(api.log.slice(-3000)); })
  .finally(async () => {
    await cleanup();
    console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
    if (failures.length) { for (const f of failures) console.log(`  - ${f}`); if (api?.log) console.log(`\n── API output (last 6000 characters)\n${api.log.slice(-6000)}`); process.exit(1); }
    process.exit(0);
  });
