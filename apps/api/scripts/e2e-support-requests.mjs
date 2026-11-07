#!/usr/bin/env node
/**
 * End-to-end proof of customer support requests (v0.20, F4), over HTTP
 * against a running API and a real Postgres.
 *
 * Covers: the intake link is the only thing that picks a business; disabled
 * and unknown links look the same; bots are accepted-and-dropped; caps; the
 * status link shows nothing it should not; queue isolation by business and
 * capability; claim races; hand-off only to someone authorised in that
 * business; computer matching only for someone who can reach the computer;
 * Connect only by the claimer; customer cancel; retention.
 *
 * It writes rows, so point it at a scratch stack — never production:
 *
 *   API_BASE=http://127.0.0.1:3101/api/v1 DATABASE_URL=… node scripts/e2e-support-requests.mjs
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { randomBytes } from 'crypto';

const API = process.env.API_BASE || 'http://127.0.0.1:3001/api/v1';
if (/:3001\b|:443\b|^https:/.test(API) && process.env.I_KNOW_THIS_IS_NOT_PRODUCTION !== '1') {
  console.error(`Refusing to run against ${API}: this suite writes fixtures. Use a scratch stack.`);
  process.exit(2);
}

const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'test-password-123456';

let pass = 0, fail = 0;
const failures = [];
function check(cond, name, detail = '') {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; failures.push(`${name} — ${detail}`); console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${detail}`); }
}
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const pace = () => new Promise((r) => setTimeout(r, 60));

async function req(method, p, { body, cookie, headers = {} } = {}) {
  await pace();
  const r = await fetch(`${API}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed, text };
}
async function login(email) {
  await pace();
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }) });
  const m = (r.headers.get('set-cookie') || '').match(/access_token=([^;]+)/);
  if (!m) throw new Error(`login ${email} failed: ${r.status} ${await r.text()}`);
  return `access_token=${m[1]}`;
}

const created = { users: [], businesses: [], endpoints: [] };
async function makeUser(email) {
  const u = await prisma.user.create({
    data: { email, passwordHash: await argon2.hash(PW, { type: argon2.argon2id }), firstName: email.split('-')[1], lastName: 'Test', status: 'ACTIVE' },
  });
  created.users.push(u.id);
  return u;
}
async function member(user, tenantId, businessId, roleType, capabilities = []) {
  const role = await prisma.role.findFirst({ where: { tenantId, type: roleType } });
  return prisma.membership.create({ data: { userId: user.id, tenantId, customerId: businessId, roleId: role.id, capabilities, isActive: true } });
}

async function cleanup() {
  await prisma.supportSession.deleteMany({ where: { OR: [{ technicianId: { in: created.users } }, { customerId: { in: created.businesses } }] } });
  await prisma.supportRequest.deleteMany({ where: { customerId: { in: created.businesses } } });
  await prisma.technicianAssignment.deleteMany({ where: { customerId: { in: created.businesses } } });
  await prisma.computerAccess.deleteMany({ where: { endpointId: { in: created.endpoints } } });
  await prisma.connectionGrant.deleteMany({ where: { userId: { in: created.users } } }).catch(() => {});
  await prisma.launcherToken.deleteMany({ where: { userId: { in: created.users } } });
  await prisma.rustdeskNode.deleteMany({ where: { endpointId: { in: created.endpoints } } });
  await prisma.endpoint.deleteMany({ where: { id: { in: created.endpoints } } });
  await prisma.activityLog.deleteMany({ where: { actorId: { in: created.users } } });
  await prisma.activityLog.updateMany({ where: { customerId: { in: created.businesses } }, data: { customerId: null } });
  await prisma.membership.deleteMany({ where: { userId: { in: created.users } } });
  await prisma.customer.deleteMany({ where: { id: { in: created.businesses } } });
  await prisma.user.deleteMany({ where: { id: { in: created.users } } });
}

try {
  const tenant = await prisma.tenant.findFirst({ where: { isActive: true }, orderBy: { createdAt: 'asc' } });
  const bizA = await prisma.customer.create({ data: { tenantId: tenant.id, name: `Support A ${sfx}`, isActive: true } });
  const bizB = await prisma.customer.create({ data: { tenantId: tenant.id, name: `Support B ${sfx}`, isActive: true } });
  created.businesses.push(bizA.id, bizB.id);

  const ownerA = await makeUser(`sr-ownera-${sfx}@test.invalid`);
  const t1 = await makeUser(`sr-tina-${sfx}@test.invalid`);     // support:requests in A
  const t2 = await makeUser(`sr-tom-${sfx}@test.invalid`);      // support:requests in A
  const plain = await makeUser(`sr-paul-${sfx}@test.invalid`);  // A member, no support:requests
  const ownerB = await makeUser(`sr-ownerb-${sfx}@test.invalid`);
  const msp = await makeUser(`sr-mia-${sfx}@test.invalid`);     // MSP technician assigned to A
  await member(ownerA, tenant.id, bizA.id, 'BUSINESS_OWNER');
  await member(t1, tenant.id, bizA.id, 'BUSINESS_USER', ['computers:view', 'computers:connect', 'support:requests']);
  await member(t2, tenant.id, bizA.id, 'BUSINESS_USER', ['computers:view', 'computers:connect', 'support:requests']);
  await member(plain, tenant.id, bizA.id, 'BUSINESS_USER', ['computers:view', 'computers:connect']);
  await member(ownerB, tenant.id, bizB.id, 'BUSINESS_OWNER');
  await prisma.technicianAssignment.create({
    data: { tenantId: tenant.id, customerId: bizA.id, userId: msp.id, capabilities: ['computers:view', 'support:requests'], reason: 'e2e' },
  });

  // A computer in A that only an explicit grant can reach.
  const rd = String(100000000 + Math.floor(Math.random() * 800000000));
  const ep = await prisma.endpoint.create({
    data: {
      tenantId: tenant.id, customerId: bizA.id, name: `sr-pc-${sfx}`, hostname: `sr-pc-${sfx}`, status: 'ACTIVE',
      isOnline: true, isManaged: true, accessMode: 'ASSIGNED_USERS', rustdeskNode: { create: { tenantId: tenant.id, rustdeskId: rd } },
    },
  });
  created.endpoints.push(ep.id);
  await prisma.computerAccess.create({ data: { tenantId: tenant.id, endpointId: ep.id, userId: t1.id } });

  const cOwnerA = await login(ownerA.email);
  const cT1 = await login(t1.email);
  const cT2 = await login(t2.email);
  const cPlain = await login(plain.email);
  const cOwnerB = await login(ownerB.email);
  const cMsp = await login(msp.email);
  const asA = { 'x-rem0te-business': bizA.id };

  section('Intake link');
  let slug;
  {
    const off = await req('GET', '/support-requests/intake', { cookie: cOwnerA });
    check(off.status === 200 && off.body.data.enabled === false, 'intake is off by default', `HTTP ${off.status}`);
    const byUser = await req('PATCH', '/support-requests/intake', { cookie: cT1, body: { enabled: true } });
    check(byUser.status === 403, 'a Business User cannot turn intake on', `HTTP ${byUser.status}`);
    const cross = await req('PATCH', `/support-requests/intake?businessId=${bizA.id}`, { cookie: cOwnerB, body: { enabled: true } });
    check(cross.status === 403 || cross.status === 404, 'another business\'s Owner cannot turn it on', `HTTP ${cross.status}`);
    const on = await req('PATCH', '/support-requests/intake', { cookie: cOwnerA, body: { enabled: true } });
    slug = on.body?.data?.slug;
    check(on.status === 200 && /^[A-Za-z0-9_-]{16}$/.test(slug ?? ''), 'Owner turns it on; slug is server-generated and unguessable', JSON.stringify(on.body).slice(0, 200));
    const pub = await req('GET', `/public/support/intake/${slug}`);
    check(pub.status === 200 && JSON.stringify(pub.body.data) === JSON.stringify({ businessName: bizA.name }),
      'public page shows the business name and nothing else', JSON.stringify(pub.body));
    const unknown = await req('GET', `/public/support/intake/${'Z'.repeat(16)}`);
    const off2 = await prisma.customer.update({ where: { id: bizA.id }, data: { supportIntakeEnabled: false } });
    const disabled = await req('GET', `/public/support/intake/${slug}`);
    await prisma.customer.update({ where: { id: off2.id }, data: { supportIntakeEnabled: true } });
    check(unknown.status === 404 && disabled.status === 404 && unknown.body.message === disabled.body.message,
      'disabled and unknown links are indistinguishable', `${unknown.status}/${disabled.status}`);
  }

  section('Public submission');
  let token;
  {
    const missing = await req('POST', `/public/support/intake/${slug}`, { body: { name: 'Ann', elapsedMs: 9000 } });
    check(missing.status === 400, 'a request needs a description', `HTTP ${missing.status}`);
    const before = await prisma.supportRequest.count({ where: { customerId: bizA.id } });
    const bot1 = await req('POST', `/public/support/intake/${slug}`, { body: { name: 'Bot', description: 'x', website: 'http://spam', elapsedMs: 9000 } });
    const bot2 = await req('POST', `/public/support/intake/${slug}`, { body: { name: 'Bot', description: 'x', elapsedMs: 300 } });
    const after = await prisma.supportRequest.count({ where: { customerId: bizA.id } });
    check(bot1.status === 201 && bot2.status === 201 && after === before, 'honeypot and too-fast submissions look accepted but store nothing', `${bot1.status}/${bot2.status} rows ${before}->${after}`);
    const tryB = await req('POST', `/public/support/intake/${slug}?customerId=${bizB.id}&businessId=${bizB.id}`, {
      body: { name: 'Ann Customer', email: 'ann@example.com', description: 'Printer will not print', rustdeskId: rd, elapsedMs: 9000, customerId: bizB.id, businessId: bizB.id },
    });
    token = tryB.body?.data?.statusToken;
    const row = await prisma.supportRequest.findFirst({ where: { statusTokenHash: { not: '' }, contactEmail: 'ann@example.com' }, orderBy: { createdAt: 'desc' } });
    check(tryB.status === 201 || tryB.status === 400, 'submission answered', `HTTP ${tryB.status} ${JSON.stringify(tryB.body).slice(0, 160)}`);
    if (tryB.status === 400) {
      // forbidNonWhitelisted refuses the extra fields outright — also fine; resubmit cleanly.
      const ok = await req('POST', `/public/support/intake/${slug}?businessId=${bizB.id}`, {
        body: { name: 'Ann Customer', email: 'ann@example.com', description: 'Printer will not print', rustdeskId: rd, elapsedMs: 9000 },
      });
      token = ok.body?.data?.statusToken;
    }
    const stored = await prisma.supportRequest.findFirst({ where: { contactEmail: 'ann@example.com' }, orderBy: { createdAt: 'desc' } });
    check(stored?.customerId === bizA.id && stored?.endpointId === null,
      'the business came from the link alone (body/query business ignored); no computer was attached', `customer=${stored?.customerId} endpoint=${stored?.endpointId} row=${!!row}`);
    // Five public submissions a minute per address; this suite has used them.
    const limited = await req('POST', `/public/support/intake/${slug}`, { body: { name: 'Flood', description: 'again', elapsedMs: 9000 } });
    check(limited.status === 429, 'public submissions are rate-limited per address', `HTTP ${limited.status}`);
    console.log('      (waiting out the rate-limit window)');
    await new Promise((r) => setTimeout(r, 61_000));
    const codes = [];
    for (let i = 0; i < 3; i++) {
      codes.push((await req('POST', `/public/support/intake/${slug}`, { body: { name: `Extra ${i}`, description: 'again', elapsedMs: 9000 } })).status);
    }
    const capped = await prisma.supportRequest.count({ where: { customerId: bizA.id, origin: 'PUBLIC', status: 'WAITING' } });
    check(capped === 3 && codes[2] === 409, 'one address gets at most 3 open requests per business (the 4th is 409)', `open=${capped} codes=${codes}`);
  }

  section('Customer status link');
  {
    const s = await req('GET', `/public/support/status/${token}`);
    const txt = JSON.stringify(s.body);
    check(s.status === 200 && s.body.data.status === 'WAITING', 'status link works', `HTTP ${s.status}`);
    check(!txt.includes('ann@example.com') && !txt.includes(rd) && !txt.includes(ep.id) && !txt.includes(ep.name),
      'status shows no email, remote ID or computer', txt.slice(0, 200));
    const bad = await req('GET', `/public/support/status/${'A'.repeat(43)}`);
    check(bad.status === 404, 'a guessed token is 404', `HTTP ${bad.status}`);
  }

  section('Queue isolation');
  let reqRow;
  {
    const noCap = await req('GET', '/support-requests', { cookie: cPlain });
    check(noCap.status === 403, 'no support:requests → no queue', `HTTP ${noCap.status}`);
    const b = await req('GET', '/support-requests', { cookie: cOwnerB });
    check(b.status === 200 && b.body.data.every((r) => r.customerId === bizB.id), 'another business sees none of A\'s requests', `n=${b.body.data?.length}`);
    const list1 = await req('GET', '/support-requests', { cookie: cT1 });
    reqRow = list1.body.data.find((r) => r.contactEmail === 'ann@example.com');
    check(!!reqRow, 'a technician in A sees the request');
    check(reqRow?.computer?.id === ep.id, 'matched to the computer for someone who can reach it', JSON.stringify(reqRow?.computer));
    const list2 = await req('GET', '/support-requests', { cookie: cT2 });
    const asT2 = list2.body.data.find((r) => r.id === reqRow.id);
    check(asT2 && asT2.computer === null, 'NOT matched for a technician without access to that computer', JSON.stringify(asT2?.computer));
    const d = await req('GET', `/support-requests/${reqRow.id}`, { cookie: cOwnerB });
    check(d.status === 404, 'another business cannot open it by id', `HTTP ${d.status}`);
    const m = await req('GET', '/support-requests', { cookie: cMsp, headers: asA });
    check(m.status === 200 && m.body.data.some((r) => r.id === reqRow.id), 'MSP technician assigned to A sees A\'s queue', `HTTP ${m.status}`);
    const mNo = await req('GET', `/support-requests?businessId=${bizB.id}`, { cookie: cMsp, headers: { 'x-rem0te-business': bizB.id } });
    check(mNo.status === 403 || (mNo.status === 200 && mNo.body.data.every((r) => r.customerId !== bizB.id)) || mNo.status === 401,
      'the same technician cannot reach B\'s queue', `HTTP ${mNo.status}`);
  }

  section('Claim, hand-off, close');
  {
    const v = reqRow.version;
    const [a, b] = await Promise.all([
      req('POST', `/support-requests/${reqRow.id}/claim`, { cookie: cT1, body: { version: v } }),
      req('POST', `/support-requests/${reqRow.id}/claim`, { cookie: cT2, body: { version: v } }),
    ]);
    const winner = a.status === 200 ? 't1' : b.status === 200 ? 't2' : null;
    const loser = winner === 't1' ? b : a;
    check([a.status, b.status].sort().join() === '200,409', 'two technicians claim together: one wins, one 409', `${a.status},${b.status}`);
    check(/Already claimed by/.test(loser.body?.message ?? ''), 'the loser is told who has it', loser.body?.message);
    // Make sure t1 holds it for the rest of the section.
    if (winner === 't2') {
      const cur = await prisma.supportRequest.findUnique({ where: { id: reqRow.id } });
      await req('POST', `/support-requests/${reqRow.id}/handoff`, { cookie: cT2, body: { version: cur.version, toUserId: t1.id } });
    }
    let cur = await prisma.supportRequest.findUnique({ where: { id: reqRow.id } });
    check(cur.claimedById === t1.id && cur.status === 'CLAIMED', 'claimed by Tina', `${cur.claimedById} ${cur.status}`);

    const toPlain = await req('POST', `/support-requests/${reqRow.id}/handoff`, { cookie: cT1, body: { version: cur.version, toUserId: plain.id } });
    check(toPlain.status === 403, 'hand-off to someone without support:requests → 403', `HTTP ${toPlain.status}`);
    const toB = await req('POST', `/support-requests/${reqRow.id}/handoff`, { cookie: cT1, body: { version: cur.version, toUserId: ownerB.id } });
    check(toB.status === 403, 'hand-off to another business\'s Owner → 403', `HTTP ${toB.status}`);
    const byOther = await req('POST', `/support-requests/${reqRow.id}/handoff`, { cookie: cT2, body: { version: cur.version, toUserId: t2.id } });
    check(byOther.status === 403, 'someone who does not hold it cannot take it by hand-off', `HTTP ${byOther.status}`);
    const cands = await req('GET', `/support-requests/${reqRow.id}/handoff-candidates`, { cookie: cT1 });
    const candIds = (cands.body.data ?? []).map((c) => c.userId);
    check(candIds.includes(t2.id) && candIds.includes(msp.id) && !candIds.includes(plain.id) && !candIds.includes(ownerB.id),
      'hand-off candidates are exactly the people authorised in A (incl. the assigned MSP technician)', JSON.stringify(candIds));

    const conn = await req('POST', `/endpoints/${ep.id}/connect?supportRequestId=${reqRow.id}`, { cookie: cT2, body: {} });
    check(conn.status === 404 || conn.status === 403, 'Connect from the request by a non-claimer is refused', `HTTP ${conn.status}`);
    const conn1 = await req('POST', `/endpoints/${ep.id}/connect?supportRequestId=${reqRow.id}`, { cookie: cT1, body: {} });
    cur = await prisma.supportRequest.findUnique({ where: { id: reqRow.id }, include: { sessions: true } });
    check(conn1.status === 201 || conn1.status === 200, 'the claimer connects from the request', `HTTP ${conn1.status} ${JSON.stringify(conn1.body).slice(0, 160)}`);
    check(cur.status === 'CONNECTING' && cur.sessions.length === 1, 'request moved to CONNECTING with the session linked', `${cur.status} sessions=${cur.sessions.length}`);

    const toMsp = await req('POST', `/support-requests/${reqRow.id}/handoff`, { cookie: cT1, body: { version: cur.version, toUserId: msp.id, note: 'over to you' } });
    check(toMsp.status === 200, 'hand-off to the assigned MSP technician works', `HTTP ${toMsp.status} ${toMsp.body?.message ?? ''}`);
    cur = await prisma.supportRequest.findUnique({ where: { id: reqRow.id } });
    const oldDone = await req('POST', `/support-requests/${reqRow.id}/complete`, { cookie: cT1, body: { version: cur.version } });
    check(oldDone.status === 403, 'the previous holder can no longer close it', `HTTP ${oldDone.status}`);
    const stale = await req('POST', `/support-requests/${reqRow.id}/complete`, { cookie: cMsp, headers: asA, body: { version: cur.version - 1 } });
    check(stale.status === 409, 'a stale version is refused (no lost update)', `HTTP ${stale.status}`);
    const done = await req('POST', `/support-requests/${reqRow.id}/complete`, { cookie: cMsp, headers: asA, body: { version: cur.version, outcome: 'fixed printer' } });
    check(done.status === 200 && done.body.data.status === 'COMPLETED', 'the holder completes it', `HTTP ${done.status} ${done.body?.message ?? ''}`);
    const s = await req('GET', `/public/support/status/${token}`);
    check(s.body.data.status === 'COMPLETED' && s.body.data.open === false, 'customer sees it closed');
    const lateCancel = await req('POST', `/public/support/status/${token}/cancel`);
    check(lateCancel.status === 409, 'customer cannot cancel a closed request', `HTTP ${lateCancel.status}`);
    const events = await prisma.supportRequestEvent.findMany({ where: { requestId: reqRow.id }, orderBy: { createdAt: 'asc' } });
    check(['submitted', 'claimed', 'handed_off', 'completed'].every((e) => events.some((x) => x.event === e)), 'timeline records submit, claim, hand-off, complete',
      events.map((e) => e.event).join(','));
    const audits = await prisma.activityLog.count({ where: { resourceId: reqRow.id, action: { in: ['SUPPORT_REQUEST_SUBMITTED', 'SUPPORT_REQUEST_CLAIMED', 'SUPPORT_REQUEST_HANDED_OFF', 'SUPPORT_REQUEST_COMPLETED'] } } });
    check(audits >= 4, 'each step is audited', `audits=${audits}`);
  }

  section('Customer cancel, portal submit');
  {
    const extra = await prisma.supportRequest.findFirst({ where: { customerId: bizA.id, contactName: 'Extra 0' } });
    // Status tokens are only ever returned once; make a fresh request to cancel.
    await prisma.supportRequest.updateMany({ where: { customerId: bizA.id, origin: 'PUBLIC', status: 'WAITING' }, data: { status: 'CANCELED' } });
    await new Promise((r) => setTimeout(r, 61_000));
    const sub = await req('POST', `/public/support/intake/${slug}`, { body: { name: 'Carl', description: 'help', elapsedMs: 9000 } });
    const tok = sub.body?.data?.statusToken;
    const c = await req('POST', `/public/support/status/${tok}/cancel`);
    check(c.status === 200 && c.body.data.status === 'CANCELED', 'customer cancels a waiting request', `HTTP ${c.status}`);
    void extra;
    const portalBad = await req('POST', '/support-requests', { cookie: cPlain, body: { description: 'my pc', endpointId: ep.id } });
    check(portalBad.status === 404, 'portal: cannot attach a computer you cannot see', `HTTP ${portalBad.status}`);
    const portal = await req('POST', '/support-requests', { cookie: cT1, body: { description: 'my pc is slow', endpointId: ep.id } });
    const pr = portal.body?.data?.id && await prisma.supportRequest.findUnique({ where: { id: portal.body.data.id } });
    check(portal.status === 201 && pr?.customerId === bizA.id && pr?.endpointId === ep.id && pr?.origin === 'PORTAL',
      'portal: a business user raises a request for their own computer', `HTTP ${portal.status}`);
    const mspPortal = await req('POST', '/support-requests', { cookie: cMsp, headers: asA, body: { description: 'x' } });
    check(mspPortal.status === 403, 'portal: an MSP technician cannot raise requests as the customer', `HTTP ${mspPortal.status}`);
  }

  section('Retention');
  {
    const require = createRequire(import.meta.url);
    const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
    const { SupportRequestsService } = require(path.join(dist, 'support-requests/support-requests.service.js'));
    const svc = new SupportRequestsService(prisma, { log: async () => {} }, {}, {});
    const old = await prisma.supportRequest.create({
      data: {
        tenantId: tenant.id, customerId: bizA.id, origin: 'PUBLIC', contactName: 'Old', contactEmail: 'old@example.com', description: 'old',
        statusTokenHash: randomBytes(32).toString('hex'), statusExpiresAt: new Date(Date.now() + 86400_000),
        createdAt: new Date(Date.now() - 26 * 3600_000),
      },
    });
    const closed = await prisma.supportRequest.create({
      data: {
        tenantId: tenant.id, customerId: bizA.id, origin: 'PUBLIC', contactName: 'Gone', contactEmail: 'gone@example.com', description: 'gone',
        reportedRustdeskId: '123456789', status: 'COMPLETED', closedAt: new Date(Date.now() - 31 * 86400_000),
        statusTokenHash: randomBytes(32).toString('hex'), statusExpiresAt: new Date(Date.now() + 86400_000),
      },
    });
    await svc.retention();
    const o = await prisma.supportRequest.findUnique({ where: { id: old.id } });
    const c = await prisma.supportRequest.findUnique({ where: { id: closed.id } });
    check(o.status === 'EXPIRED', 'unclaimed request older than 24h expires', o.status);
    check(c.anonymizedAt && !c.contactName && !c.contactEmail && !c.description && !c.reportedRustdeskId && c.statusTokenHash !== closed.statusTokenHash,
      'closed request older than 30 days loses contact details and its status link', JSON.stringify({ n: c.contactName, e: c.contactEmail }));
  }
} catch (e) {
  fail++;
  failures.push(`suite crashed: ${e.stack || e}`);
  console.error(e);
} finally {
  await cleanup().catch((e) => console.error('cleanup failed', e));
  await prisma.$disconnect();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
