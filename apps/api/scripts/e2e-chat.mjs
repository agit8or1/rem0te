#!/usr/bin/env node
/**
 * End-to-end proof of chat (0.34): a technician in the portal and the person
 * at a managed Windows computer, with the device side simulated over the real
 * device-authenticated routes (POST /enrollment/chat/poll and /chat/reply,
 * with the device secret, exactly as the signed agent's chat host sends them).
 *
 *   - support states: signed agent with chat protocol 1 (yes); the standard
 *     agent, an old signed agent, Linux, macOS, an unbound or unassigned
 *     computer (no, each saying why); the heartbeat stores agentChat only for
 *     a signed agent and says `chat.open` only to it;
 *   - delivery states: sent → delivered → shown → read, each only when the
 *     agent confirms it; another computer's acknowledgement changes nothing;
 *     presence: waiting for check-in, connecting, no user signed in, window
 *     open (with the Windows account), the person closed the window;
 *   - the long-poll: held while there is nothing new, released by a message
 *     or the end; one held poll per computer; CHAT_MAX_WAITERS;
 *   - capability (support:chat to start/write/end, computers:view to read),
 *     a Business User without visibility (404), business A/B isolation for
 *     people and for devices;
 *   - containment: a `remote` pause blocks a new chat and new technician
 *     messages; an `actions` pause does not;
 *   - the length cap (2,000 characters) and the rate caps (20 a minute per
 *     side per conversation, 30 a minute per computer), control and bidi
 *     characters stripped, a reply retried with the same client id stored once;
 *   - the retention sweep: a conversation ended over 400 days ago is deleted
 *     with its messages, younger ones and open ones are not, CHAT_PRUNED is
 *     written, and the sealed audit entries for the deleted conversation are
 *     left exactly as they were;
 *   - the audit log has CHAT_STARTED / CHAT_ENDED with ids and counts and no
 *     message text anywhere.
 *
 *   cd apps/api && npx nest build
 *   DATABASE_URL=postgresql://…/<name containing scratch or test> node scripts/e2e-chat.mjs
 *
 * Self-starting: it runs its own API from dist/ on CHAT_API_PORT (3531), with
 * the chat sweep every 2 s, CHAT_MAX_WAITERS=1 and the audit sealer on.
 * INTEGRATION, not Windows: the desktop window has not run here, and the
 * agent's own chat code is tested by `go test ./internal/chat`.
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chatDevice } from './lib/chat-device.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const DB = process.env.DATABASE_URL ?? '';
const dbName = DB.split('/').pop()?.split('?')[0] ?? '';
if (!/scratch|test/.test(dbName)) { console.error(`Refusing to run against database "${dbName}": name must contain "scratch" or "test".`); process.exit(2); }
const PORT = Number(process.env.CHAT_API_PORT ?? 3531);
if ([3000, 3001, 4000, 4001, 443].includes(PORT)) { console.error(`Refusing port ${PORT}`); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'chat-e2e-password-123456';
const MARK = `zq${sfx}`; // every message text carries it, so the audit scan can look for it

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
  // This suite proves the sweep, so it is on (run-e2e.sh turns it off for every other suite).
  CHAT_RETENTION_SWEEP: 'on', CHAT_SWEEP_SECONDS: '2', CHAT_MAX_WAITERS: '1',
};
delete apiEnv.AUDIT_SEALER; // sealed rows, so the prune is proven not to touch them
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

// Paced under the 20 req/s burst throttler.
const pace = () => new Promise((res) => setTimeout(res, 60));
async function req(method, p, { s, body, nopace } = {}) {
  if (!nopace) await pace();
  const h = { 'content-type': 'application/json', 'x-forwarded-for': s?.ip ?? ip() };
  if (s) h.cookie = s.cookie;
  const r = await fetch(`${API}${p}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j, data: j?.data };
}
async function login(email) {
  const s = { ip: ip() };
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': s.ip }, body: JSON.stringify({ email, password: PW }) });
  const mm = (r.headers.get('set-cookie') ?? '').match(/access_token=([^;]+)/);
  if (r.status !== 200 || !mm) throw new Error(`login ${email}: ${r.status} ${await r.text()}`);
  s.cookie = `access_token=${mm[1]}`;
  return s;
}
const code = (r) => r.body?.code ?? r.body?.message?.code ?? r.body?.error?.code;
const msg = (r) => `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 400)}`;

// The agent's chat host, as internal/chat/client.go speaks (lib/chat-device.mjs).
const { poll, reply, heartbeat } = chatDevice(req);

const created = { businesses: [], users: [] };

async function all() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });
  const roleUser = await prisma.role.findFirst({ where: { type: 'BUSINESS_USER' } });
  const startedAt = new Date();

  section('Fixtures (synthetic): Acme and Birch; owners, a chatting user, a viewer, a user who sees nothing; computers of every kind');
  const acme = await prisma.customer.create({ data: { tenantId: tenant.id, name: `Acme Dental ${sfx}` } });
  const birch = await prisma.customer.create({ data: { tenantId: tenant.id, name: `Birch Law ${sfx}` } });
  created.businesses.push(acme.id, birch.id);
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag, first, last) => { const u = await prisma.user.create({ data: { email: `chat-${tag}-${sfx}@test.invalid`, passwordHash: hash, firstName: first, lastName: last, status: 'ACTIVE' } }); created.users.push(u.id); return u; };
  const owen = await mkUser('owen', 'Owen', 'Owner'), bea = await mkUser('bea', 'Bea', 'Birch');
  const tara = await mkUser('tara', 'Tara', 'Tech'), uma = await mkUser('uma', 'Uma', 'Viewer'), nora = await mkUser('nora', 'Nora', 'Nobody');
  await prisma.membership.create({ data: { userId: owen.id, tenantId: tenant.id, customerId: acme.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: bea.id, tenantId: tenant.id, customerId: birch.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: tara.id, tenantId: tenant.id, customerId: acme.id, roleId: roleUser.id, capabilities: ['computers:view', 'support:chat'] } });
  await prisma.membership.create({ data: { userId: uma.id, tenantId: tenant.id, customerId: acme.id, roleId: roleUser.id, capabilities: ['computers:view'] } });
  await prisma.membership.create({ data: { userId: nora.id, tenantId: tenant.id, customerId: acme.id, roleId: roleUser.id, capabilities: ['computers:view', 'support:chat'] } });
  const mkEp = async (biz, hostname, { platform = 'Windows', channel = 'signed', chat = 1, bound = true } = {}) => {
    const e = await prisma.endpoint.create({ data: {
      tenantId: tenant.id, customerId: biz?.id ?? null, name: hostname, hostname, platform, status: 'ACTIVE', isOnline: true, isManaged: true,
      accessMode: 'ASSIGNED_USERS', lastSeenAt: new Date(), deviceClass: 'WORKSTATION', updateChannel: channel, chatProtocol: chat, agentVersion: '0.34.0',
    } });
    const rid = String(100000000 + ((Math.random() * 899999999) | 0));
    const secret = randomBytes(24).toString('hex');
    await prisma.rustdeskNode.create({ data: { tenantId: tenant.id, endpointId: e.id, rustdeskId: rid, ...(bound ? { agentSecretHash: sha(secret) } : {}) } });
    return { id: e.id, rid, secret, hostname, platform };
  };
  const pc1 = await mkEp(acme, 'FRONTDESK'), pc2 = await mkEp(acme, 'XRAY-PC');
  const std = await mkEp(acme, 'OLD-STD', { channel: 'legacy', chat: null }), oldSigned = await mkEp(acme, 'OLD-SIGNED', { chat: null });
  const lin = await mkEp(acme, 'web01', { platform: 'Linux', channel: 'legacy', chat: null }), mac = await mkEp(acme, 'imac', { platform: 'macOS', channel: 'legacy', chat: null });
  const unbound = await mkEp(acme, 'NEVER-AUTH', { bound: false });
  const bpc = await mkEp(birch, 'FRONTDESK');
  for (const ep of [pc1, pc2]) await prisma.computerAccess.create({ data: { tenantId: tenant.id, endpointId: ep.id, userId: tara.id } });
  await prisma.computerAccess.create({ data: { tenantId: tenant.id, endpointId: pc1.id, userId: uma.id } });
  // nora: chat permission, but no computer granted — she sees none of them.

  startApi();
  await waitUp();
  const S = { owen: await login(owen.email), bea: await login(bea.email), tara: await login(tara.email), uma: await login(uma.email), nora: await login(nora.email) };
  const overview = (s, ep) => req('GET', `/endpoints/${ep.id}/chat`, { s });
  const start = (s, ep, body = {}) => req('POST', `/endpoints/${ep.id}/chat/conversations`, { s, body });
  const say = (s, ep, cid, text) => req('POST', `/endpoints/${ep.id}/chat/conversations/${cid}/messages`, { s, body: { text } });
  const end = (s, ep, cid) => req('POST', `/endpoints/${ep.id}/chat/conversations/${cid}/end`, { s });
  const transcript = (s, ep, cid) => req('GET', `/endpoints/${ep.id}/chat/conversations/${cid}`, { s });
  const receiptOf = async (s, ep, cid, mid) => (await transcript(s, ep, cid)).data?.messages?.find((m) => m.id === mid)?.receipt;

  section('Which computers can chat, and the portal says why not');
  let r = await overview(S.owen, pc1);
  check(r.status === 200 && r.data?.support?.supported === true && r.data.canSend === true && r.data.open === null && r.data.contained === null && r.data.limits?.retentionDays === 400, 'signed Windows agent with chat protocol 1: supported, nothing open, 400-day retention', msg(r));
  const why = async (ep) => (await overview(S.owen, ep)).data?.support;
  const s1 = await why(std), s2 = await why(oldSigned), s3 = await why(lin), s4 = await why(mac), s5 = await why(unbound);
  check(s1?.supported === false && s1.reason === 'agent' && /standard agent, which cannot chat/.test(s1.message), 'the standard agent: not supported, "cannot chat"', JSON.stringify(s1));
  check(s2?.supported === false && s2.reason === 'agent' && /too old to chat/.test(s2.message), 'a signed agent without the chat protocol: "too old"', JSON.stringify(s2));
  check(s3?.supported === false && s3.reason === 'platform' && /not available on Linux yet/.test(s3.message), 'Linux: "not available on Linux yet"', JSON.stringify(s3));
  check(s4?.supported === false && s4.reason === 'platform' && /not available on macOS yet/.test(s4.message), 'macOS: "not available on macOS yet"', JSON.stringify(s4));
  check(s5?.supported === false && s5.reason === 'not_bound', 'a computer that never authenticated: not supported', JSON.stringify(s5));
  for (const [ep, said] of [[std, /standard agent/], [lin, /Linux/], [mac, /macOS/], [unbound, /never authenticated/]]) {
    r = await start(S.owen, ep);
    check(r.status === 409 && code(r) === 'CHAT_UNSUPPORTED' && said.test(r.body?.message ?? ''), `starting a chat on ${ep.hostname} is refused, saying why`, msg(r));
  }
  r = await overview(S.uma, pc1);
  check(r.status === 200 && r.data?.canSend === false, 'a viewer without support:chat sees the panel but may not write', msg(r));

  section('Heartbeat: agentChat kept for a signed agent only; chat.open only when a chat is open');
  r = await heartbeat(pc1, { updateChannel: 'signed', agentChat: 1 });
  check(r.status === 200 && r.data?.chat?.open === false, 'signed agent reporting chat 1, nothing open: chat.open false', msg(r));
  r = await heartbeat(std, { updateChannel: 'legacy', agentChat: 1 });
  let row = await prisma.endpoint.findUnique({ where: { id: std.id }, select: { chatProtocol: true } });
  check(r.status === 200 && r.data?.chat === null && row.chatProtocol === null, 'the standard agent claiming chat is not believed, and is asked nothing', `${msg(r)} chatProtocol=${row.chatProtocol}`);
  r = await heartbeat(oldSigned, { updateChannel: 'signed' });
  row = await prisma.endpoint.findUnique({ where: { id: oldSigned.id }, select: { chatProtocol: true } });
  check(r.data?.chat === null && row.chatProtocol === null, 'a signed agent that reports no chat protocol: none stored, nothing asked');
  r = await heartbeat(pc1, { updateChannel: 'signed', agentChat: 100 });
  check(r.status === 400, 'an out-of-range chat protocol is refused by the DTO', msg(r));

  section('Who may start a chat');
  r = await start(S.uma, pc1);
  check(r.status === 403, 'without support:chat: 403', msg(r));
  r = await start(S.nora, pc1);
  check(r.status === 404, 'a Business User who cannot see the computer: 404, as for a missing one', msg(r));
  r = await overview(S.nora, pc1);
  check(r.status === 404, '…and she cannot read its chat panel either', msg(r));
  r = await start(S.bea, pc1);
  check(r.status === 404, 'another business\'s owner: 404', msg(r));
  r = await start(S.tara, pc1);
  const c1 = r.data?.conversation;
  check(r.status === 201 && c1?.status === 'OPEN' && r.data.existing === false && c1.technicianName === 'Tara Tech' && c1.businessName === acme.name, 'Tara starts one: open, with her name and the business name frozen in', msg(r));
  check(c1?.presence?.code === 'waiting_for_checkin' && /next check-in/.test(c1.presence.text), 'presence: waiting for the computer to pick it up at its next check-in', JSON.stringify(c1?.presence));
  r = await start(S.owen, pc1);
  check(r.status === 201 && r.data?.existing === true && r.data.conversation.id === c1.id, 'a second start returns the open one (one open chat per computer)', msg(r));

  section('Heartbeat and device isolation');
  r = await heartbeat(pc1, { updateChannel: 'signed', agentChat: 1 });
  check(r.data?.chat?.open === true && Object.keys(r.data.chat).join() === 'open', 'pc1\'s heartbeat says a chat is open — a flag, no names or text', JSON.stringify(r.data?.chat));
  r = await heartbeat(pc1, { updateChannel: 'signed', agentChat: 1 }, null);
  check(r.status === 401 && r.data === undefined, 'a heartbeat without the device secret is refused and learns nothing about it', msg(r));
  r = await heartbeat(bpc, { updateChannel: 'signed', agentChat: 1 });
  check(r.data?.chat?.open === false, 'Birch\'s computer is told nothing is open');
  r = await poll(pc1, { noWait: true }, randomBytes(24).toString('hex'));
  check(r.status === 401, 'a poll with the wrong device secret: 401', msg(r));
  const rej = await prisma.activityLog.findFirst({ where: { action: 'ENDPOINT_HEARTBEAT_REJECTED', resourceId: pc1.id, createdAt: { gte: startedAt } }, orderBy: { createdAt: 'desc' } });
  check(rej?.metadata?.reason === 'chat_poll_unauthenticated', 'and it is audited as a rejected device call', JSON.stringify(rej?.metadata));
  r = await poll(bpc, { conversationId: c1.id, noWait: true });
  check(r.status === 200 && r.data?.conversation === null, 'Birch\'s computer polling with Acme\'s conversation id gets nothing', msg(r));
  r = await reply(bpc, c1.id, `${MARK} from birch`);
  check(r.status === 404, 'and cannot post into it (404)', msg(r));

  section('Delivery: sent → delivered → shown → read, only when the agent says so');
  r = await say(S.tara, pc1, c1.id, `${MARK} Hi, this is Tara from IT. <script>alert(1)</script>`);
  const m1 = r.data?.message;
  check(r.status === 201 && m1?.receipt === 'sent' && m1.body.includes('<script>alert(1)</script>'), 'stored as plain text, verbatim (the console renders it escaped); receipt: sent', msg(r));
  r = await poll(pc1, { state: 'connecting', noWait: true });
  check(r.status === 200 && r.data?.conversation?.id === c1.id && r.data.conversation.businessName === acme.name && r.data.conversation.technicianName === 'Tara Tech' && r.data.messages?.[0]?.id === m1.id, 'the agent\'s first poll: the conversation with both names, and the message', msg(r));
  check(!JSON.stringify(r.data).includes('agentSecret') && !JSON.stringify(r.data).includes(pc1.secret), 'the response carries no secret');
  check(await receiptOf(S.tara, pc1, c1.id, m1.id) === 'sent', 'handing it over is not delivery: still sent until the agent acknowledges');
  r = await overview(S.tara, pc1);
  check(r.data?.open?.presence?.code === 'connecting', 'presence: the agent is opening the window', JSON.stringify(r.data?.open?.presence));
  await poll(bpc, { delivered: [m1.id], shown: [m1.id], read: [m1.id], noWait: true });
  check(await receiptOf(S.tara, pc1, c1.id, m1.id) === 'sent', 'another computer acknowledging this message changes nothing');
  await poll(pc1, { state: 'no_user', delivered: [m1.id], noWait: true });
  check(await receiptOf(S.tara, pc1, c1.id, m1.id) === 'delivered', 'acknowledged by pc1: delivered to the agent');
  r = await overview(S.tara, pc1);
  check(r.data?.open?.presence?.code === 'no_user' && /Nobody is signed in/.test(r.data.open.presence.text), 'presence: nobody signed in at the console (a real state, not "sent")', JSON.stringify(r.data?.open?.presence));
  r = await poll(pc1, { noWait: true });
  check(r.data?.messages?.length === 0, 'a delivered message is not handed over again', msg(r));
  await poll(pc1, { state: 'window_open', userName: 'ACME\\alice\u0007', history: true });
  r = await overview(S.tara, pc1);
  check(r.data?.open?.presence?.code === 'window_open' && r.data.open.deviceUser === 'ACME\\alice', 'presence: the window is open for ACME\\alice (control character dropped)', JSON.stringify(r.data?.open));
  await poll(pc1, { shown: [m1.id], noWait: true });
  check(await receiptOf(S.tara, pc1, c1.id, m1.id) === 'shown', 'shown when the window reports it drawn');
  await poll(pc1, { read: [m1.id], noWait: true });
  r = await transcript(S.tara, pc1, c1.id);
  const t1 = r.data?.messages?.find((m) => m.id === m1.id);
  check(t1?.receipt === 'read' && t1.deliveredAt && t1.shownAt && t1.readAt, 'read when the window reports it in front; each time is recorded', JSON.stringify(t1));
  const readAt = t1?.readAt;
  await poll(pc1, { read: [m1.id], noWait: true });
  r = await transcript(S.tara, pc1, c1.id);
  check(r.data?.messages?.find((m) => m.id === m1.id)?.readAt === readAt, 'a repeated acknowledgement keeps the first time');
  r = await poll(pc1, { delivered: ['not-an-id', '../x', 'a'.repeat(300)], noWait: true });
  check(r.status === 400 || r.status === 200, 'malformed ids are refused or ignored, never queried as given', msg(r));

  section('The person at the computer replies');
  r = await reply(pc1, c1.id, `  ${MARK} the printer\r\nsays offline${String.fromCharCode(0x202e)}\u0000  `, 'clientid-0001');
  const um = r.data;
  check(r.status === 200 && um?.duplicate === false, 'the reply is stored', msg(r));
  r = await reply(pc1, c1.id, `${MARK} the printer says offline`, 'clientid-0001');
  check(r.data?.duplicate === true && r.data.id === um?.id, 'a retry with the same client id is the same message, stored once', msg(r));
  r = await transcript(S.uma, pc1, c1.id);
  const ut = r.data?.messages?.find((m) => m.id === um?.id);
  check(r.status === 200 && ut?.sender === 'END_USER' && ut.body === `${MARK} the printer\nsays offline` && ut.authorName === 'ACME\\alice' && ut.receipt === null, 'the viewer reads it: CRLF normalised, control and bidi characters gone, signed as the Windows account', JSON.stringify(ut));
  r = await reply(pc1, c1.id, 'x'.repeat(2001));
  check(r.status === 400 && code(r) === 'CHAT_TOO_LONG', 'over 2,000 characters: refused, not cut', msg(r));
  r = await reply(pc1, c1.id, ' \r\n\t ');
  check(r.status === 400 && code(r) === 'CHAT_EMPTY', 'nothing but whitespace: refused', msg(r));
  r = await say(S.tara, pc1, c1.id, 'y'.repeat(2001));
  check(r.status === 400 && code(r) === 'CHAT_TOO_LONG', 'the technician has the same 2,000-character cap', msg(r));
  r = await say(S.tara, pc1, c1.id, `${MARK}` + 'z'.repeat(2000 - MARK.length));
  check(r.status === 201, 'exactly 2,000 characters is fine', msg(r));
  await poll(pc1, { delivered: [r.data?.message?.id], noWait: true });

  section('The long-poll');
  let t0 = Date.now();
  const held = poll(pc1, {});
  await sleep(1500);
  r = await say(S.tara, pc1, c1.id, `${MARK} are you still there?`);
  const m2 = r.data?.message;
  r = await held;
  check(r.status === 200 && r.data?.messages?.some((m) => m.id === m2?.id) && r.data.holdMs >= 1000 && Date.now() - t0 < 10_000, 'a poll with nothing new is held, and a technician message releases it at once', `holdMs=${r.data?.holdMs} ${msg(r).slice(0, 200)}`);
  await poll(pc1, { delivered: [m2.id], noWait: true });
  t0 = Date.now();
  const first = poll(pc1, {});
  await sleep(1200);
  const second = poll(pc1, { noWait: false });
  r = await first;
  check(r.status === 200 && Date.now() - t0 < 8000, 'one held poll per computer: a newer poll releases the older', `took ${Date.now() - t0} ms`);
  // pc2 needs an open chat to be held at all.
  const c2 = (await start(S.tara, pc2)).data?.conversation;
  t0 = Date.now();
  r = await poll(pc2, {});
  check(r.status === 200 && r.data?.retryAfterMs === 5000 && Date.now() - t0 < 3000, 'with CHAT_MAX_WAITERS=1 and pc1 held, pc2 is answered at once and told to back off', msg(r));
  await end(S.tara, pc1, c1.id).then(() => null);
  r = await second;
  check(r.status === 200 && r.data?.conversation?.status === 'ENDED' && r.data.conversation.endedReason === 'technician', 'ending the chat releases the held poll, which says it ended and why', msg(r));
  r = await end(S.tara, pc1, c1.id);
  check(r.status === 200 && r.data?.alreadyEnded === true, 'ending it again changes nothing', msg(r));
  r = await reply(pc1, c1.id, `${MARK} late`);
  check(r.status === 409 && code(r) === 'CHAT_ENDED', 'a reply after the end: 409 CHAT_ENDED', msg(r));
  r = await say(S.tara, pc1, c1.id, `${MARK} late`);
  check(r.status === 409 && code(r) === 'CHAT_ENDED', 'a technician message after the end: 409 CHAT_ENDED', msg(r));
  r = await heartbeat(pc1, { updateChannel: 'signed', agentChat: 1 });
  check(r.data?.chat?.open === false, 'the heartbeat no longer says a chat is open');

  section('Rate caps');
  r = await start(S.tara, pc1);
  const c3 = r.data?.conversation;
  let lastTech;
  for (let i = 0; i < 20; i++) lastTech = await say(S.tara, pc1, c3.id, `${MARK} t${i}`);
  r = await say(S.tara, pc1, c3.id, `${MARK} one too many`);
  check(lastTech?.status === 201 && r.status === 429 && code(r) === 'CHAT_RATE_LIMITED', '20 technician messages a minute in one chat, then 429', msg(r));
  let lastUser;
  for (let i = 0; i < 20; i++) lastUser = await reply(pc1, c3.id, `${MARK} u${i}`);
  r = await reply(pc1, c3.id, `${MARK} flood`);
  check(lastUser?.status === 200 && r.status === 429 && code(r) === 'CHAT_RATE_LIMITED', '20 replies a minute from the computer in one chat, then 429', msg(r));
  await end(S.tara, pc1, c3.id);
  const c4 = (await start(S.tara, pc1)).data?.conversation;
  const already = await prisma.chatMessage.count({ where: { sender: 'END_USER', createdAt: { gt: new Date(Date.now() - 55_000) }, conversation: { endpointId: pc1.id } } });
  let okRest = already >= 20 && already < 30;
  for (let i = already; i < 30; i++) okRest = okRest && (await reply(pc1, c4.id, `${MARK} v${i}`)).status === 200;
  r = await reply(pc1, c4.id, `${MARK} v30`);
  check(okRest && r.status === 429 && /from one computer/.test(r.body?.message ?? ''), `and 30 a minute from one computer across chats: a new chat does not reset it (${already} already this minute)`, msg(r));

  section('The person closes the window');
  r = await poll(pc1, { conversationId: c4.id, state: 'user_closed', noWait: true });
  check(r.data?.conversation?.status === 'ENDED' && r.data.conversation.endedReason === 'end_user', 'closing the window ends the chat, as ended by the person at the computer', msg(r));
  r = await transcript(S.tara, pc1, c4.id);
  check(r.data?.conversation?.presence?.code === 'ended' && /closed the chat window/.test(r.data.conversation.presence.text), 'the technician sees that they closed it', JSON.stringify(r.data?.conversation?.presence));

  section('Containment');
  const pz = await prisma.containmentPause.create({ data: { scope: 'BUSINESS', customerId: acme.id, kinds: ['actions'], reason: `chat e2e ${sfx}: actions only`, setById: owen.id, setBy: 'msp' } });
  r = await say(S.tara, pc2, c2.id, `${MARK} still fine`);
  check(r.status === 201, 'a pause on approved actions only does not stop chat', msg(r));
  await prisma.containmentPause.update({ where: { id: pz.id }, data: { clearedAt: new Date(), clearedById: owen.id, clearReason: 'e2e' } });
  const pr = await prisma.containmentPause.create({ data: { scope: 'BUSINESS', customerId: acme.id, kinds: ['remote'], reason: `chat e2e ${sfx}: suspected compromise`, setById: owen.id, setBy: 'msp' } });
  r = await say(S.tara, pc2, c2.id, `${MARK} blocked`);
  check(r.status === 403 && code(r) === 'CONTAINED' && /remote connections and chat/.test(r.body?.message ?? ''), 'a remote pause: no new technician message in an open chat (403 CONTAINED)', msg(r));
  r = await start(S.owen, pc1);
  check(r.status === 403 && code(r) === 'CONTAINED', 'and no new chat', msg(r));
  r = await overview(S.owen, pc2);
  check(r.data?.contained?.pauseId === pr.id && /suspected compromise/.test(r.data.contained.message), 'the panel says why', JSON.stringify(r.data?.contained));
  r = await start(S.bea, bpc);
  check(r.status === 201, 'Birch is not paused: its owner can still chat', msg(r));
  const cb = r.data?.conversation;
  r = await end(S.tara, pc2, c2.id);
  check(r.status === 200 && r.data?.ended === true, 'ending a chat is still allowed under a pause', msg(r));
  await prisma.containmentPause.update({ where: { id: pr.id }, data: { clearedAt: new Date(), clearedById: owen.id, clearReason: 'e2e' } });

  section('Business A/B isolation for transcripts');
  r = await transcript(S.bea, pc1, c1.id);
  check(r.status === 404, 'Birch\'s owner cannot read an Acme transcript (404)', msg(r));
  r = await transcript(S.bea, bpc, c1.id);
  check(r.status === 404, 'not even by putting Acme\'s conversation id under her own computer', msg(r));
  r = await transcript(S.owen, bpc, cb?.id);
  check(r.status === 404, 'and Acme\'s owner cannot read Birch\'s', msg(r));
  r = await end(S.owen, bpc, cb?.id);
  check(r.status === 404, 'or end it', msg(r));
  r = await transcript(S.nora, pc1, c1.id);
  check(r.status === 404, 'a Business User without visibility of the computer cannot read its transcript (404)', msg(r));
  r = await transcript(S.tara, pc2, c1.id);
  check(r.status === 404, 'a conversation is only found under its own computer', msg(r));
  await end(S.bea, bpc, cb.id);

  section('Linking a support request');
  const srA = await prisma.supportRequest.create({ data: { tenantId: tenant.id, customerId: acme.id, origin: 'PORTAL', endpointId: pc1.id, description: 'printer', statusTokenHash: sha(randomBytes(16)), statusExpiresAt: new Date(Date.now() + 86400e3) } });
  const srB = await prisma.supportRequest.create({ data: { tenantId: tenant.id, customerId: birch.id, origin: 'PORTAL', description: 'x', statusTokenHash: sha(randomBytes(16)), statusExpiresAt: new Date(Date.now() + 86400e3) } });
  r = await start(S.tara, pc1, { supportRequestId: srA.id });
  check(r.status === 403, 'linking needs "Handle support requests"', msg(r));
  r = await start(S.owen, pc1, { supportRequestId: srB.id });
  check(r.status === 404, 'another business\'s request cannot be linked (404)', msg(r));
  r = await start(S.owen, pc1, { supportRequestId: srA.id });
  const c5 = r.data?.conversation;
  check(r.status === 201 && c5?.supportRequestId === srA.id, 'the owner links Acme\'s request for this computer', msg(r));
  await end(S.owen, pc1, c5.id);

  section('Retention: ended over 400 days ago → deleted with its messages');
  const DAY = 86_400_000;
  // c1 went through the API, so it has sealed CHAT_STARTED / CHAT_ENDED entries.
  for (let i = 0; i < 40; i++) {
    const n = await prisma.activityLog.count({ where: { action: { in: ['CHAT_STARTED', 'CHAT_ENDED'] }, sealedAt: null, createdAt: { gte: startedAt } } });
    if (n === 0) break;
    await sleep(500);
  }
  const auditOf = (cid) => prisma.activityLog.findMany({ where: { action: { in: ['CHAT_STARTED', 'CHAT_ENDED'] }, metadata: { path: ['conversationId'], equals: cid } }, orderBy: { seq: 'asc' }, select: { id: true, action: true, chainHash: true, sealedAt: true, metadata: true } });
  const sealedBefore = await auditOf(c1.id);
  check(sealedBefore.length === 2 && sealedBefore.every((a) => a.chainHash && a.sealedAt), 'the chat to be pruned has a sealed CHAT_STARTED and CHAT_ENDED', JSON.stringify(sealedBefore.map((a) => [a.action, !!a.chainHash])));
  const c1Messages = await prisma.chatMessage.count({ where: { conversationId: c1.id } });
  await prisma.chatConversation.update({ where: { id: c1.id }, data: { endedAt: new Date(Date.now() - 401 * DAY), createdAt: new Date(Date.now() - 402 * DAY) } });
  await prisma.chatConversation.update({ where: { id: c3.id }, data: { endedAt: new Date(Date.now() - 399 * DAY) } });
  // An open chat whose start is ancient is never pruned (the inactivity rule ends it first, today).
  const ancientOpen = await prisma.chatConversation.create({ data: { tenantId: tenant.id, customerId: acme.id, endpointId: pc2.id, startedById: owen.id, technicianName: 'Owen Owner', businessName: acme.name, createdAt: new Date(Date.now() - 900 * DAY), lastActivityAt: new Date(Date.now() - 3 * 3600e3) } });
  let gone = false;
  for (let i = 0; i < 40 && !gone; i++) { await sleep(500); gone = !(await prisma.chatConversation.findUnique({ where: { id: c1.id } })); }
  check(gone && c1Messages > 0 && (await prisma.chatMessage.count({ where: { conversationId: c1.id } })) === 0, `the 401-day-old chat and its ${c1Messages} messages are deleted by the sweep`);
  check(!!(await prisma.chatConversation.findUnique({ where: { id: c3.id } })), 'one ended 399 days ago is kept');
  let anc;
  for (let i = 0; i < 20; i++) { anc = await prisma.chatConversation.findUnique({ where: { id: ancientOpen.id } }); if (anc?.status === 'ENDED') break; await sleep(500); }
  check(anc?.status === 'ENDED' && anc.endedReason === 'inactive' && anc.endedAt > new Date(Date.now() - 60_000), 'an open chat quiet for over two hours is ended as inactive (today) — not deleted', JSON.stringify({ status: anc?.status, reason: anc?.endedReason }));
  const pruned = await prisma.activityLog.findFirst({ where: { action: 'CHAT_PRUNED', createdAt: { gte: startedAt } }, orderBy: { createdAt: 'desc' } });
  check(pruned?.metadata?.conversations >= 1 && pruned.metadata.retentionDays === 400 && pruned.customerId === null && !JSON.stringify(pruned.metadata).includes(MARK), 'CHAT_PRUNED records the counts and the window, nothing else', JSON.stringify(pruned?.metadata));
  const sealedAfter = await auditOf(c1.id);
  check(JSON.stringify(sealedAfter) === JSON.stringify(sealedBefore), 'the pruned chat\'s sealed audit entries are untouched (same rows, same hashes)');

  section('Audit: start and end with ids and counts; no message text anywhere');
  const audit = await prisma.activityLog.findMany({ where: { action: { in: ['CHAT_STARTED', 'CHAT_ENDED'] }, createdAt: { gte: startedAt } } });
  const started = audit.filter((a) => a.action === 'CHAT_STARTED' && a.customerId === acme.id);
  const ended = audit.filter((a) => a.action === 'CHAT_ENDED' && a.customerId === acme.id);
  check(started.length === 5 && started.every((a) => a.actorId && Object.keys(a.metadata).every((k) => ['conversationId', 'supportRequestId'].includes(k))), 'five chats started in Acme through the API, each audited with who and the ids only', JSON.stringify(started.map((a) => a.metadata)));
  const reasons = ended.map((a) => a.metadata.reason).sort();
  check(JSON.stringify(reasons) === JSON.stringify(['end_user', 'inactive', 'technician', 'technician', 'technician', 'technician']), 'each end is audited once, with why', JSON.stringify(reasons));
  check(ended.every((a) => Object.keys(a.metadata).sort().join() === 'conversationId,durationSeconds,endUserMessages,reason,technicianMessages'), 'CHAT_ENDED carries ids and counts only');
  const c3End = ended.find((a) => a.metadata.conversationId === c3.id);
  check(c3End?.metadata.technicianMessages === 20 && c3End.metadata.endUserMessages === 20, 'the counts are the messages stored (20 and 20; the refused ones are not counted)', JSON.stringify(c3End?.metadata));
  const leak = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "ActivityLog" WHERE "createdAt" >= $1 AND ("metadata"::text LIKE $2 OR coalesce("resource",'') LIKE $2)`, startedAt, `%${MARK}%`);
  check(leak[0].n === 0, 'no ActivityLog row written during the suite contains any message text', `rows: ${leak[0].n}`);
}

async function cleanup() {
  await stopApi();
  try {
    const ids = created.businesses;
    const eps = await prisma.endpoint.findMany({ where: { customerId: { in: ids } }, select: { id: true } });
    await prisma.chatConversation.deleteMany({ where: { endpointId: { in: eps.map((e) => e.id) } } });
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
