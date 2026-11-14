#!/usr/bin/env node
/**
 * End-to-end proof of chat attachments, emoji and the console's chat inbox
 * (0.44), over the real routes: the technician's console routes with a
 * session cookie, and the /assist page with its own cookie and x-assist,
 * exactly as the tray's WebView2 window loads it (the tray mints the code
 * with the device secret, as the signed tray host does).
 *
 *   - emoji round trip, both sides, unchanged; the 2,000 cap in UTF-16 code
 *     units in the API and in the database CHECK (1,000 emoji fit, 1,001 do
 *     not — and 1,500, which the 0.34 CHECK let through, are refused there);
 *   - an image (PNG) uploaded and served inline as image/png with nosniff and
 *     a sandbox CSP; a JPEG from the page shown to the technician;
 *   - disguised files: HTML named .png and declared image/png, and an SVG —
 *     stored as `file`, served only as application/octet-stream attachments,
 *     renamed .png.bin / .svg.bin;
 *   - limits: 10 MB a file (413), 20 files and 50 MB a chat (409);
 *   - who reads and who sends: a viewer (computers:view) reads, may not send;
 *     a user who cannot see the computer and another business's owner get
 *     404 for the file and for the upload; ids moved under another computer
 *     or conversation are 404; the upload needs x-assist and a live cookie
 *     before the file is read; the page reads only its own chat's files;
 *   - the `remote` containment pause refuses a send on both sides, and reads
 *     still work;
 *   - recording off: files survive the "read" purge while the chat is open,
 *     and nothing — message or file — is left after it ends;
 *   - retention: a chat ended over 400 days ago goes with its files, and
 *     CHAT_PRUNED counts them;
 *   - the inbox: only chats the caller can see, unread counts and a preview,
 *     per-user read marks, `unchanged` for an unchanged version, and a chat
 *     the person starts from the tray shows up;
 *   - audit: one CHAT_ATTACHMENT_SENT per file with ids, kind, type and size
 *     only, and no file name or content anywhere in the audit log.
 *
 *   cd apps/api && npx nest build
 *   DATABASE_URL=postgresql://…/<name containing scratch or test> node scripts/e2e-chat-attachments.mjs
 *
 * Self-starting: its own API from dist/ on CHAT_ATT_API_PORT (3703), with the
 * chat sweep every 2 s. INTEGRATION, not Windows: the tray's WebView2 window
 * has not loaded this page here.
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
const PORT = Number(process.env.CHAT_ATT_API_PORT ?? 3703);
if ([3000, 3001, 4000, 4001, 443].includes(PORT)) { console.error(`Refusing port ${PORT}`); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'chat-att-e2e-password-123456';
const MARK = `za${sfx}`; // in every file name and text, so the audit scan can look for it

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
  TRAY_SWEEP: 'off', RETENTION_SWEEP: 'off', SNAPSHOT_SWEEP: 'off', AGENT_AUTO_UPDATE: 'off', AUTO_MIGRATION_SWEEP: 'off',
  // Not production's GeoIP file (the API falls back to its path when this is unset).
  GEOIP_DB_PATH: path.join(here, 'no-geoip.mmdb'),
  // This suite proves the prune of attachments, so the chat sweep is on for its own API.
  CHAT_RETENTION_SWEEP: 'on', CHAT_SWEEP_SECONDS: '2',
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

const pace = () => new Promise((res) => setTimeout(res, 60));
/** A request: JSON `body`, or multipart `form` ({ name: string | { buf, filename, type } }). */
async function req(method, p, { s, body, form, headers = {}, cookie, raw } = {}) {
  await pace();
  const h = { 'x-forwarded-for': s?.ip ?? ip(), ...headers };
  let payload;
  if (form) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(form)) {
      if (typeof v === 'string') fd.append(k, v); else fd.append(k, new Blob([v.buf], { type: v.type ?? 'application/octet-stream' }), v.filename);
    }
    payload = fd;
  } else if (body !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const c = [s?.cookie, cookie].filter(Boolean).join('; ');
  if (c) h.cookie = c;
  const r = await fetch(`${API}${p}`, { method, headers: h, body: payload, redirect: 'manual' });
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
const code = (r) => r.body?.code ?? r.body?.message?.code;
const msg = (r) => `HTTP ${r.status} ${JSON.stringify(r.body ?? '').slice(0, 400)}`;

// A real PNG and JPEG header, as e2e-tray builds them.
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

async function all() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });
  const roleUser = await prisma.role.findFirst({ where: { type: 'BUSINESS_USER' } });
  const startedAt = new Date();

  section('Fixtures (synthetic): Acme and Birch; an owner each, a chatting user, a viewer, a user who sees nothing');
  const acme = await prisma.customer.create({ data: { tenantId: tenant.id, name: `Acme Dental ${sfx}` } });
  const birch = await prisma.customer.create({ data: { tenantId: tenant.id, name: `Birch Law ${sfx}` } });
  created.businesses.push(acme.id, birch.id);
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag, first) => { const u = await prisma.user.create({ data: { email: `chatatt-${tag}-${sfx}@test.invalid`, passwordHash: hash, firstName: first, lastName: 'Att', status: 'ACTIVE' } }); created.users.push(u.id); return u; };
  const owen = await mkUser('owen', 'Owen'), bea = await mkUser('bea', 'Bea'), tara = await mkUser('tara', 'Tara'), uma = await mkUser('uma', 'Uma'), nora = await mkUser('nora', 'Nora');
  await prisma.membership.create({ data: { userId: owen.id, tenantId: tenant.id, customerId: acme.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: bea.id, tenantId: tenant.id, customerId: birch.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: tara.id, tenantId: tenant.id, customerId: acme.id, roleId: roleUser.id, capabilities: ['computers:view', 'support:chat'] } });
  await prisma.membership.create({ data: { userId: uma.id, tenantId: tenant.id, customerId: acme.id, roleId: roleUser.id, capabilities: ['computers:view'] } });
  await prisma.membership.create({ data: { userId: nora.id, tenantId: tenant.id, customerId: acme.id, roleId: roleUser.id, capabilities: ['computers:view', 'support:chat'] } });
  const mkEp = async (biz, hostname) => {
    const e = await prisma.endpoint.create({ data: {
      tenantId: tenant.id, customerId: biz.id, name: hostname, hostname, platform: 'Windows 11', status: 'ACTIVE', isOnline: true, isManaged: true,
      accessMode: 'ASSIGNED_USERS', lastSeenAt: new Date(), deviceClass: 'WORKSTATION', updateChannel: 'signed', chatProtocol: 2, trayProtocol: 1, agentVersion: '0.44.0',
    } });
    const rid = String(100000000 + ((Math.random() * 899999999) | 0));
    const secret = randomBytes(24).toString('hex');
    await prisma.rustdeskNode.create({ data: { tenantId: tenant.id, endpointId: e.id, rustdeskId: rid, agentSecretHash: sha(secret) } });
    return { id: e.id, rid, secret, hostname };
  };
  const pc1 = await mkEp(acme, `FRONTDESK-${sfx}`), pc2 = await mkEp(acme, `XRAY-${sfx}`), pc3 = await mkEp(acme, `LAB-${sfx}`), bpc = await mkEp(birch, `BIRCH-${sfx}`);
  for (const ep of [pc1, pc3]) await prisma.computerAccess.create({ data: { tenantId: tenant.id, endpointId: ep.id, userId: tara.id } });
  await prisma.computerAccess.create({ data: { tenantId: tenant.id, endpointId: pc1.id, userId: uma.id } });
  // pc2 is granted to nobody: only the owner sees it. nora is granted nothing.

  startApi();
  await waitUp();
  const S = { owen: await login(owen.email), bea: await login(bea.email), tara: await login(tara.email), uma: await login(uma.email), nora: await login(nora.email) };
  const ALICE = 'ACME\\alice';
  const start = (s, ep) => req('POST', `/endpoints/${ep.id}/chat/conversations`, { s, body: {} });
  const say = (s, ep, cid, text) => req('POST', `/endpoints/${ep.id}/chat/conversations/${cid}/messages`, { s, body: { text } });
  const end = (s, ep, cid) => req('POST', `/endpoints/${ep.id}/chat/conversations/${cid}/end`, { s });
  const transcript = (s, ep, cid) => req('GET', `/endpoints/${ep.id}/chat/conversations/${cid}`, { s });
  const upload = (s, ep, cid, buf, filename, type) => req('POST', `/endpoints/${ep.id}/chat/conversations/${cid}/attachments`, { s, form: { file: { buf, filename, type } } });
  const fetchAtt = (s, ep, cid, aid) => req('GET', `/endpoints/${ep.id}/chat/conversations/${cid}/attachments/${aid}`, { s, raw: true });
  const inbox = (s, since) => req('GET', `/chat/inbox${since ? `?since=${encodeURIComponent(since)}` : ''}`, { s });
  const markRead = (s, conversationId, upTo) => req('POST', '/chat/inbox/read', { s, body: upTo ? { conversationId, upTo } : { conversationId } });
  async function openPage(ep, user = ALICE) {
    const c = await req('POST', '/tray/chat-code', { body: { rustdeskId: ep.rid, agentSecret: ep.secret, localUser: user } });
    if (c.status !== 200) throw new Error(`chat-code: ${msg(c)}`);
    const o = await req('GET', `/assist/open?c=${encodeURIComponent(c.data.code)}`, { raw: true });
    const m = (o.headers.get('set-cookie') ?? '').match(/rem0te_assist=([^;]+)/);
    return { cookie: m ? `rem0te_assist=${m[1]}` : null };
  }
  const page = {
    state: (p) => req('GET', '/assist/api/state', { cookie: p.cookie }),
    start: (p, text) => req('POST', '/assist/api/start', { cookie: p.cookie, headers: { 'x-assist': '1' }, body: { text, clientId: randomBytes(9).toString('hex') } }),
    send: (p, text) => req('POST', '/assist/api/messages', { cookie: p.cookie, headers: { 'x-assist': '1' }, body: { text, clientId: randomBytes(9).toString('hex') } }),
    upload: (p, buf, filename, { header = true, clientId = randomBytes(9).toString('hex'), type } = {}) =>
      req('POST', '/assist/api/attachments', { cookie: p.cookie, headers: header ? { 'x-assist': '1' } : {}, form: { clientId, file: { buf, filename, type } } }),
    file: (p, aid) => req('GET', `/assist/api/attachments/${aid}`, { cookie: p.cookie, raw: true }),
    receipts: (p, body) => req('POST', '/assist/api/receipts', { cookie: p.cookie, headers: { 'x-assist': '1' }, body }),
  };
  let r;

  // ── Emoji ─────────────────────────────────────────────────────────────────
  section('Emoji: through both sides unchanged; the cap counts as the browser and the agent do');
  r = await start(S.tara, pc1);
  const c1 = r.data?.conversation;
  check(r.status === 201 && c1?.status === 'OPEN', 'Tara starts a chat on pc1', msg(r));
  const emo = `${MARK} Fixed 🎉 👍🏽 👨‍👩‍👧 ❤️ 🇳🇴`;
  r = await say(S.tara, pc1, c1.id, emo);
  check(r.status === 201 && r.data?.message?.body === emo, 'a technician message with emoji, skin tone, ZWJ family, variation selector and flag is stored exactly', msg(r));
  const p1 = await openPage(pc1);
  r = await page.state(p1);
  check(r.status === 200 && r.data?.messages?.some((m) => m.text === emo), 'the page reads it back exactly', msg(r));
  r = await page.send(p1, `${MARK} thanks 🙏😀`);
  check(r.status === 200 || r.status === 201, 'the person replies with emoji', msg(r));
  r = await transcript(S.tara, pc1, c1.id);
  check(r.data?.messages?.some((m) => m.sender === 'END_USER' && m.body === `${MARK} thanks 🙏😀`), 'and the technician reads it exactly', msg(r));
  r = await say(S.tara, pc1, c1.id, '😀'.repeat(1000));
  check(r.status === 201, '1,000 emoji (2,000 UTF-16 code units) are accepted', msg(r));
  r = await say(S.tara, pc1, c1.id, '😀'.repeat(1001));
  check(r.status === 400 && code(r) === 'CHAT_TOO_LONG', '1,001 emoji are refused by the API', msg(r));
  r = await page.send(p1, '😀'.repeat(1001));
  check(r.status === 400 && code(r) === 'CHAT_TOO_LONG', '…and from the page', msg(r));
  const direct = async (body) => {
    try { const m = await prisma.chatMessage.create({ data: { conversationId: c1.id, sender: 'TECHNICIAN', authorName: 'x', body } }); await prisma.chatMessage.delete({ where: { id: m.id } }); return 'ok'; } catch (e) { return /ChatMessage_body_bounded|check constraint/i.test(String(e?.message)) ? 'refused' : String(e?.message).slice(0, 200); }
  };
  check(await direct('😀'.repeat(1000)) === 'ok', 'the database CHECK accepts 1,000 emoji');
  check(await direct('😀'.repeat(1001)) === 'refused' && await direct('😀'.repeat(1500)) === 'refused', 'and refuses 1,001 — and 1,500, which the code-point CHECK of 0.34 let through');
  check(await direct('x'.repeat(2000)) === 'ok' && await direct('x'.repeat(2001)) === 'refused' && await direct('') === 'refused', 'plain text: 2,000 characters fit, 2,001 and empty do not');

  // ── Images ────────────────────────────────────────────────────────────────
  section('An image: uploaded, classified by its bytes, shown inline, inert');
  const img = png(8, 6);
  r = await upload(S.tara, pc1, c1.id, img, `${MARK}-screen.png`, 'image/png');
  const imMsg = r.data?.message;
  check(r.status === 201 && imMsg?.attachment?.kind === 'image' && imMsg.attachment.contentType === 'image/png' && imMsg.attachment.sizeBytes === img.length && imMsg.body === `${MARK}-screen.png`, 'a PNG: an image message whose body is its name', msg(r));
  r = await fetchAtt(S.tara, pc1, c1.id, imMsg.attachment.id);
  check(r.status === 200 && r.headers.get('content-type') === 'image/png' && r.buf.equals(img), 'served as image/png, the same bytes', `${r.status} ${r.headers.get('content-type')}`);
  check(/^inline;/.test(r.headers.get('content-disposition') ?? '') && r.headers.get('x-content-type-options') === 'nosniff' && r.headers.get('content-security-policy') === "default-src 'none'; sandbox" && /no-store/.test(r.headers.get('cache-control') ?? ''),
    'inline, nosniff, a sandbox CSP, no-store', JSON.stringify(Object.fromEntries(r.headers)));
  r = await fetchAtt(S.uma, pc1, c1.id, imMsg.attachment.id);
  check(r.status === 200 && r.buf.equals(img), 'a viewer with computers:view on the computer can read it (as she can the transcript)', `${r.status}`);
  r = await upload(S.uma, pc1, c1.id, img, 'x.png');
  check(r.status === 403, '…but not send one (support:chat): 403', msg(r));
  r = await fetchAtt(S.nora, pc1, c1.id, imMsg.attachment.id);
  check(r.status === 404, 'a user who cannot see the computer: 404', `${r.status}`);
  r = await upload(S.nora, pc1, c1.id, img, 'x.png');
  check(r.status === 404, '…and cannot upload into its chat: 404', msg(r));
  r = await fetchAtt(S.bea, pc1, c1.id, imMsg.attachment.id);
  check(r.status === 404, 'another business\'s owner: 404', `${r.status}`);
  r = await fetchAtt(S.bea, bpc, c1.id, imMsg.attachment.id);
  check(r.status === 404, '…not even with Acme\'s ids under her own computer', `${r.status}`);
  r = await fetchAtt(S.owen, pc2, c1.id, imMsg.attachment.id);
  check(r.status === 404, 'an attachment is found only under its own computer', `${r.status}`);
  r = await fetchAtt(S.owen, pc1, 'c'.repeat(25), imMsg.attachment.id);
  check(r.status === 404, '…and its own conversation', `${r.status}`);
  r = await req('GET', `/endpoints/${pc1.id}/chat/conversations/${c1.id}/attachments/${imMsg.attachment.id}`, { raw: true });
  check(r.status === 401, 'without a session: 401', `${r.status}`);
  r = await transcript(S.tara, pc1, c1.id);
  const tImg = r.data?.messages?.find((m) => m.id === imMsg.id);
  check(tImg?.attachment?.id === imMsg.attachment.id && !('bytes' in tImg.attachment) && !JSON.stringify(r.data).includes(img.toString('base64').slice(0, 20)), 'the transcript lists the attachment\'s id, name, kind, type and size — never its bytes', JSON.stringify(tImg?.attachment));

  section('Disguised files: never an image, only a download');
  const html = Buffer.from(`<!doctype html><html><body><script>fetch('/api/v1/auth/me')</script>${MARK}</body></html>`);
  r = await upload(S.tara, pc1, c1.id, html, `${MARK}-cat.png`, 'image/png');
  const hMsg = r.data?.message;
  check(r.status === 201 && hMsg?.attachment?.kind === 'file' && hMsg.attachment.contentType === 'application/octet-stream' && hMsg.attachment.fileName === `${MARK}-cat.png.bin`, 'HTML named .png and declared image/png: stored as a file named .png.bin', msg(r));
  r = await fetchAtt(S.tara, pc1, c1.id, hMsg.attachment.id);
  check(r.status === 200 && r.headers.get('content-type') === 'application/octet-stream' && /^attachment;/.test(r.headers.get('content-disposition') ?? '') && r.headers.get('x-content-type-options') === 'nosniff' && r.headers.get('content-security-policy') === "default-src 'none'; sandbox",
    'served as application/octet-stream, Content-Disposition: attachment, nosniff, sandbox CSP', JSON.stringify(Object.fromEntries(r.headers)));
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><text>${MARK}</text></svg>`);
  r = await upload(S.tara, pc1, c1.id, svg, `${MARK}-logo.svg`, 'image/svg+xml');
  check(r.status === 201 && r.data?.message?.attachment?.kind === 'file' && r.data.message.attachment.fileName.endsWith('.svg.bin'), 'SVG: a file, never an image', msg(r));
  r = await fetchAtt(S.tara, pc1, c1.id, r.data.message.attachment.id);
  check(r.headers.get('content-type') === 'application/octet-stream' && /^attachment;/.test(r.headers.get('content-disposition') ?? ''), '…served only as a download', `${r.headers.get('content-type')}`);
  r = await upload(S.tara, pc1, c1.id, Buffer.from(`hello ${MARK}`), `../../${MARK}‮exe.txt`, 'text/plain');
  check(r.status === 201 && r.data?.message?.attachment?.fileName === `${MARK} exe.txt`, 'the name is sanitised: no path, no bidi override', msg(r));
  const disp = (await fetchAtt(S.tara, pc1, c1.id, r.data.message.attachment.id)).headers.get('content-disposition');
  check(disp === `attachment; filename="${MARK} exe.txt"; filename*=UTF-8''${MARK}%20exe.txt`, 'and offered under that name only', disp);

  section('Limits');
  r = await upload(S.tara, pc1, c1.id, Buffer.alloc(10 * 1024 * 1024 + 1, 1), 'big.bin');
  check(r.status === 413, 'a file over 10 MB: 413', msg(r));
  r = await upload(S.tara, pc1, c1.id, Buffer.alloc(0), 'empty.txt');
  check(r.status === 400 && code(r) === 'ATTACHMENT_EMPTY', 'an empty file: 400', msg(r));
  r = await req('POST', `/endpoints/${pc1.id}/chat/conversations/${c1.id}/attachments`, { s: S.tara, form: { other: 'x' } });
  check(r.status === 400 && code(r) === 'ATTACHMENT_MISSING', 'no file at all: 400', msg(r));
  const before = await prisma.chatConversation.findUnique({ where: { id: c1.id }, select: { attachmentCount: true, attachmentBytes: true } });
  await prisma.chatConversation.update({ where: { id: c1.id }, data: { attachmentCount: 20 } });
  r = await upload(S.tara, pc1, c1.id, img, 'one-more.png');
  check(r.status === 409 && code(r) === 'ATTACHMENT_COUNT', '20 files in one chat, then 409 ATTACHMENT_COUNT', msg(r));
  await prisma.chatConversation.update({ where: { id: c1.id }, data: { attachmentCount: before.attachmentCount, attachmentBytes: 50 * 1024 * 1024 - 10 } });
  r = await upload(S.tara, pc1, c1.id, img, 'too-much.png');
  check(r.status === 409 && code(r) === 'ATTACHMENT_TOTAL', '50 MB in one chat, then 409 ATTACHMENT_TOTAL', msg(r));
  await prisma.chatConversation.update({ where: { id: c1.id }, data: { attachmentBytes: before.attachmentBytes } });
  const n = await prisma.chatAttachment.count({ where: { conversationId: c1.id } });
  check(n === before.attachmentCount, 'a refused upload stores nothing', `${n} vs ${before.attachmentCount}`);

  // ── The page ──────────────────────────────────────────────────────────────
  section('The /assist page: its cookie, x-assist, and only its own chat');
  r = await page.state(p1);
  const pImg = r.data?.messages?.find((m) => m.id === imMsg.id);
  check(pImg?.attachment?.kind === 'image' && pImg.attachment.id === imMsg.attachment.id, 'the page sees the technician\'s image', JSON.stringify(pImg));
  r = await page.file(p1, imMsg.attachment.id);
  check(r.status === 200 && r.headers.get('content-type') === 'image/png' && r.buf.equals(img) && r.headers.get('content-security-policy') === "default-src 'none'; sandbox", 'and loads it with its cookie (same origin, under /assist: img-src \'self\')', `${r.status}`);
  r = await page.file(p1, hMsg.attachment.id);
  check(r.headers.get('content-type') === 'application/octet-stream' && /^attachment;/.test(r.headers.get('content-disposition') ?? ''), 'a disguised file reaches the page as a download only', `${r.headers.get('content-type')}`);
  r = await page.file({ cookie: null }, imMsg.attachment.id);
  check(r.status === 401, 'without the cookie: 401', `${r.status}`);
  const shot = jpeg(64, 48, 200);
  r = await page.upload(p1, shot, `${MARK}-error.jpg`, { type: 'image/jpeg' });
  const uAtt = r.data;
  check((r.status === 201 || r.status === 200) && uAtt?.attachment?.kind === 'image' && uAtt.attachment.contentType === 'image/jpeg', 'the person sends a JPEG from the page', msg(r));
  r = await page.upload(p1, shot, 'x.jpg', { header: false });
  check(r.status === 403 && code(r) === 'ASSIST_HEADER', 'an upload without x-assist (a cross-site form cannot set it): 403 before it is read', msg(r));
  r = await page.upload({ cookie: null }, shot, 'x.jpg');
  check(r.status === 401, 'an upload without the cookie: 401', msg(r));
  r = await page.upload({ cookie: `rem0te_assist=${randomBytes(32).toString('base64url')}` }, shot, 'x.jpg');
  check(r.status === 401, 'an upload with a forged cookie: 401', msg(r));
  r = await req('POST', '/assist/api/attachments', { s: S.tara, headers: { 'x-assist': '1' }, form: { clientId: 'abcdefgh1234', file: { buf: shot, filename: 'x.jpg' } } });
  check(r.status === 401, 'a portal session is not an /assist session for uploads either', msg(r));
  const cid1 = randomBytes(9).toString('hex');
  const u1 = await page.upload(p1, Buffer.from(`notes ${MARK}`), `${MARK}-notes.txt`, { clientId: cid1 });
  const u2 = await page.upload(p1, Buffer.from(`notes ${MARK}`), `${MARK}-notes.txt`, { clientId: cid1 });
  check(u1.data?.id && u2.data?.duplicate === true && u2.data.id === u1.data.id, 'a retried upload with the same client id is stored once', `${msg(u1)} ${msg(u2)}`);
  r = await transcript(S.tara, pc1, c1.id);
  const fromUser = r.data?.messages?.find((m) => m.id === uAtt?.id);
  check(fromUser?.sender === 'END_USER' && fromUser.attachment?.kind === 'image' && fromUser.authorName === ALICE, 'the technician sees the person\'s picture, from the person', JSON.stringify(fromUser));
  r = await fetchAtt(S.tara, pc1, c1.id, uAtt.attachment.id);
  check(r.status === 200 && r.headers.get('content-type') === 'image/jpeg' && r.buf.equals(shot), '…and loads it', `${r.status}`);

  // Another chat on another computer, and its file.
  r = await start(S.owen, pc2);
  const c2 = r.data?.conversation;
  r = await upload(S.owen, pc2, c2.id, png(4, 4), `${MARK}-other.png`);
  const otherAtt = r.data?.message?.attachment;
  check(r.status === 201 && !!otherAtt, 'Owen sends a file in a chat on pc2', msg(r));
  r = await page.file(p1, otherAtt.id);
  check(r.status === 404, 'pc1\'s page cannot read pc2\'s file by id: 404', `${r.status}`);
  const bp = await openPage(bpc, 'BIRCH\\carol');
  r = await page.file(bp, imMsg.attachment.id);
  check(r.status === 401 || r.status === 404, 'Birch\'s page cannot read Acme\'s file', `${r.status}`);

  // ── Containment ───────────────────────────────────────────────────────────
  section('Containment: a remote pause stops sending files, both sides');
  const pz = await prisma.containmentPause.create({ data: { scope: 'BUSINESS', customerId: acme.id, kinds: ['remote'], reason: `chat att e2e ${sfx}`, setById: owen.id, setBy: 'msp' } });
  r = await upload(S.tara, pc1, c1.id, img, 'paused.png');
  check(r.status === 403 && code(r) === 'CONTAINED', 'the technician\'s upload: 403 CONTAINED', msg(r));
  r = await page.upload(p1, shot, 'paused.jpg');
  check(r.status === 403 && code(r) === 'CONTAINED', 'the page\'s upload: 403 CONTAINED', msg(r));
  r = await fetchAtt(S.tara, pc1, c1.id, imMsg.attachment.id);
  check(r.status === 200, 'reading what is already there still works', `${r.status}`);
  r = await upload(S.bea, bpc, (await start(S.bea, bpc)).data?.conversation?.id, img, 'birch.png');
  check(r.status === 201, 'Birch is not paused: its owner still can', msg(r));
  await prisma.containmentPause.update({ where: { id: pz.id }, data: { clearedAt: new Date(), clearedById: owen.id, clearReason: 'e2e' } });
  r = await upload(S.tara, pc1, c1.id, img, `${MARK}-after.png`);
  check(r.status === 201, 'lifted: sending works again', msg(r));

  // ── The inbox ─────────────────────────────────────────────────────────────
  section('The inbox: only chats the caller can see, unread per user, previews');
  r = await page.send(p1, `${MARK} the printer still says offline, see picture`);
  check(r.status === 201 || r.status === 200, 'the person writes', msg(r));
  r = await inbox(S.tara);
  const tChat = r.data?.chats?.find((c) => c.conversationId === c1.id);
  check(r.status === 200 && tChat && tChat.unread >= 3 && tChat.computerName === pc1.hostname && tChat.businessName === acme.name && tChat.latest?.preview === `${MARK} the printer still says offline, see picture`,
    'Tara sees pc1\'s chat: unread replies, the computer and business, and a preview of the newest', JSON.stringify(tChat));
  check(!r.data.chats.some((c) => c.conversationId === c2.id), 'not pc2\'s chat, a computer she has not been granted', JSON.stringify(r.data.chats.map((c) => c.computerName)));
  check(r.data.totalUnread === r.data.chats.reduce((s, c) => s + c.unread, 0) && typeof r.data.version === 'string', 'a total and a version');
  const v = r.data.version;
  r = await inbox(S.tara, v);
  check(r.status === 200 && r.data?.unchanged === true && !('chats' in r.data), 'asked again with that version: `unchanged`, no list', msg(r));
  r = await inbox(S.nora);
  check(r.status === 200 && !r.data.chats.some((c) => [c1.id, c2.id].includes(c.conversationId)), 'Nora, who sees no computer, sees no chat', msg(r));
  r = await inbox(S.bea);
  check(r.status === 200 && !r.data.chats.some((c) => [c1.id, c2.id].includes(c.conversationId)) && r.data.chats.every((c) => c.businessName === birch.name), 'Birch\'s owner sees only Birch\'s chats', JSON.stringify(r.data?.chats?.map((c) => c.businessName)));
  r = await inbox(S.owen);
  check(r.data?.chats?.some((c) => c.conversationId === c1.id) && r.data.chats.some((c) => c.conversationId === c2.id), 'Acme\'s owner sees both of Acme\'s chats', JSON.stringify(r.data?.chats?.map((c) => c.computerName)));
  r = await inbox(S.uma);
  const umaBefore = r.data?.chats?.find((c) => c.conversationId === c1.id)?.unread;
  check(umaBefore >= 3, 'Uma, a viewer granted pc1, sees it too', String(umaBefore));
  r = await markRead(S.tara, c1.id);
  check(r.status === 200, 'Tara marks it read', msg(r));
  r = await inbox(S.tara, v);
  check(r.data?.unchanged === false && r.data.chats.find((c) => c.conversationId === c1.id)?.unread === 0, 'her unread count is 0, and the version moved', msg(r));
  r = await inbox(S.uma);
  check(r.data?.chats?.find((c) => c.conversationId === c1.id)?.unread === umaBefore, 'Uma\'s is unchanged: read marks are per user', JSON.stringify(r.data?.chats));
  r = await page.upload(p1, png(3, 3), `${MARK}-another.png`);
  check(r.status === 201 || r.status === 200, 'the person sends another picture', msg(r));
  r = await inbox(S.tara);
  const after = r.data?.chats?.find((c) => c.conversationId === c1.id);
  check(after?.unread === 1 && after.latest?.attachment === 'image', 'a new picture from the person: unread again, previewed as a picture', JSON.stringify(after));
  r = await markRead(S.nora, c1.id);
  check(r.status === 404, 'marking read a chat on a computer you cannot see: 404', msg(r));
  r = await markRead(S.bea, c1.id);
  check(r.status === 404, '…or in another business: 404', msg(r));
  r = await markRead(S.tara, c1.id, new Date(Date.now() + 86400e3).toISOString());
  const rs = await prisma.chatReadState.findUnique({ where: { userId_conversationId: { userId: tara.id, conversationId: c1.id } } });
  check(r.status === 200 && rs.lastReadAt.getTime() <= Date.now() + 1000, 'a read mark in the future is clamped to now', rs?.lastReadAt?.toISOString());

  section('A chat the person starts from the tray shows up in the inbox');
  const p3 = await openPage(pc3);
  r = await page.start(p3, `${MARK} my screen is frozen 😟`);
  check(r.status === 201 || r.status === 200, 'the person starts a chat from the page on pc3', msg(r));
  const c3id = r.data?.conversationId;
  r = await inbox(S.tara);
  const t3 = r.data?.chats?.find((c) => c.conversationId === c3id);
  check(t3?.startedBy === 'end_user' && t3.unread === 1 && t3.latest?.preview === `${MARK} my screen is frozen 😟`, 'Tara (granted pc3) sees it, unread, with the preview — emoji included', JSON.stringify(t3));
  r = await inbox(S.uma);
  check(!r.data?.chats?.some((c) => c.conversationId === c3id), 'Uma, not granted pc3, does not', JSON.stringify(r.data?.chats?.map((c) => c.computerName)));

  // ── Recording off ─────────────────────────────────────────────────────────
  section('A chat that is not recorded keeps no attachment after it ends');
  await end(S.tara, pc1, c1.id);
  await prisma.customer.update({ where: { id: acme.id }, data: { chatRecording: false } });
  r = await start(S.tara, pc1);
  const c4 = r.data?.conversation;
  check(c4?.recorded === false, 'a new chat on pc1 is not recorded', msg(r));
  const p4 = await openPage(pc1);
  r = await upload(S.tara, pc1, c4.id, img, `${MARK}-unrec.png`);
  const t4 = r.data?.message;
  r = await page.upload(p4, shot, `${MARK}-unrec.jpg`);
  const u4 = r.data;
  check(!!t4?.attachment && !!u4?.attachment, 'a file each way', msg(r));
  await page.receipts(p4, { shown: [t4.id], read: [t4.id] });
  await req('POST', `/endpoints/${pc1.id}/chat/conversations/${c4.id}/ack`, { s: S.tara, body: { ids: [u4.id] } });
  r = await page.file(p4, t4.attachment.id);
  const keptT = await prisma.chatMessage.count({ where: { id: t4.id } });
  check(r.status === 200 && keptT === 1, 'read by the page: unlike a text message, the file is kept while the chat is open (the window loads it from the server)', `${r.status} rows=${keptT}`);
  r = await fetchAtt(S.tara, pc1, c4.id, u4.attachment.id);
  check(r.status === 200, 'acknowledged by the technician\'s panel: kept too', `${r.status}`);
  await end(S.tara, pc1, c4.id);
  const left = await prisma.chatAttachment.count({ where: { conversationId: c4.id } }) + await prisma.chatMessage.count({ where: { conversationId: c4.id } });
  check(left === 0, 'ended: no message and no file of it is left', `rows left: ${left}`);
  r = await fetchAtt(S.tara, pc1, c4.id, t4.attachment.id);
  check(r.status === 404, '…and the file is a 404', `${r.status}`);
  await prisma.customer.update({ where: { id: acme.id }, data: { chatRecording: null } });

  // ── Retention ─────────────────────────────────────────────────────────────
  section('Retention: a chat ended over 400 days ago goes with its files');
  const c1Files = await prisma.chatAttachment.count({ where: { conversationId: c1.id } });
  await prisma.chatConversation.update({ where: { id: c1.id }, data: { endedAt: new Date(Date.now() - 401 * 86400e3) } });
  let gone = false;
  for (let i = 0; i < 40 && !gone; i++) { await sleep(500); gone = !(await prisma.chatConversation.findUnique({ where: { id: c1.id } })); }
  check(gone && c1Files > 0 && (await prisma.chatAttachment.count({ where: { conversationId: c1.id } })) === 0, `the old chat and its ${c1Files} files are deleted by the sweep`);
  const pruned = await prisma.activityLog.findFirst({ where: { action: 'CHAT_PRUNED', createdAt: { gte: startedAt } }, orderBy: { createdAt: 'desc' } });
  check(pruned?.metadata?.attachments >= c1Files && pruned.metadata.conversations >= 1, 'CHAT_PRUNED counts the files it took', JSON.stringify(pruned?.metadata));
  check(!!(await prisma.chatConversation.findUnique({ where: { id: c2.id } })) && (await prisma.chatAttachment.count({ where: { conversationId: c2.id } })) === 1, 'an open chat\'s files are untouched');

  // ── Audit ─────────────────────────────────────────────────────────────────
  section('Audit: ids, kinds, types and sizes; never a name or content');
  const rows = await prisma.activityLog.findMany({ where: { action: 'CHAT_ATTACHMENT_SENT', createdAt: { gte: startedAt } } });
  const acmeRows = rows.filter((a) => a.customerId === acme.id);
  check(acmeRows.length >= 10 && rows.every((a) => Object.keys(a.metadata).sort().join() === 'attachmentId,by,contentType,conversationId,kind,sizeBytes'), `one CHAT_ATTACHMENT_SENT per stored file (${acmeRows.length} in Acme), with ids, who, kind, type and size only`, JSON.stringify(rows.slice(0, 2).map((a) => a.metadata)));
  check(rows.some((a) => a.metadata.by === 'end_user' && !a.actorId) && rows.some((a) => a.metadata.by === 'technician' && a.actorId === tara.id), 'the technician\'s rows name them; the person\'s name no account');
  const leak = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "ActivityLog" WHERE "createdAt" >= $1 AND ("metadata"::text LIKE $2 OR coalesce("resource",'') LIKE $2)`, startedAt, `%${MARK}%`);
  check(leak[0].n === 0, 'no audit row written during the suite holds a file name, text or content', `rows: ${leak[0].n}`);
}

async function cleanup() {
  await stopApi();
  try {
    const ids = created.businesses;
    const eps = await prisma.endpoint.findMany({ where: { customerId: { in: ids } }, select: { id: true } });
    await prisma.chatConversation.deleteMany({ where: { endpointId: { in: eps.map((e) => e.id) } } });
    await prisma.assistSession.deleteMany({ where: { endpointId: { in: eps.map((e) => e.id) } } });
    await prisma.assistCode.deleteMany({ where: { endpointId: { in: eps.map((e) => e.id) } } });
    await prisma.supportRequest.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.containmentPause.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.computerAccess.deleteMany({ where: { endpointId: { in: eps.map((e) => e.id) } } });
    await prisma.rustdeskNode.deleteMany({ where: { endpointId: { in: eps.map((e) => e.id) } } });
    await prisma.endpoint.deleteMany({ where: { id: { in: eps.map((e) => e.id) } } });
    await prisma.membership.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.customer.deleteMany({ where: { id: { in: ids } } });
    if (created.users.length) await prisma.user.deleteMany({ where: { id: { in: created.users } } });
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
