#!/usr/bin/env node
/**
 * End-to-end proof of the 0.19.12 session-mutation fixes, over HTTP against a
 * running API and a real Postgres — the counterpart of
 * unit-session-mutations.mjs, which proves the same rules without a database.
 * This one exists because conditional updates and row locks are only as good
 * as the SQL they turn into.
 *
 * It writes rows, so point it at a scratch stack — never production:
 *
 *   API_BASE=http://127.0.0.1:3102/api/v1 DATABASE_URL=… \
 *     node scripts/e2e-session-mutations.mjs
 */
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

// The API's burst throttler allows 20 requests a second per address; pace
// sequential calls under it so a 429 is never mistaken for a verdict.
const pace = () => new Promise((r) => setTimeout(r, 60));
async function req(method, path, { body, cookie, headers = {} } = {}) {
  await pace();
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed, setCookie: r.headers.get('set-cookie') || '' };
}
async function login(email) {
  const r = await req('POST', '/auth/login', { body: { email, password: PW } });
  const m = r.setCookie.match(/access_token=([^;]+)/);
  if (!m) throw new Error(`login ${email} failed: ${r.status} ${JSON.stringify(r.body)}`);
  return `access_token=${m[1]}`;
}

const created = { users: [], businesses: [], endpoints: [], rustdeskIds: [] };
async function makeUser(email, { platformAdmin = false } = {}) {
  const u = await prisma.user.create({
    data: {
      email, passwordHash: await argon2.hash(PW, { type: argon2.argon2id }),
      firstName: 'Sess', lastName: email.split('@')[0], status: 'ACTIVE', isPlatformAdmin: platformAdmin,
    },
  });
  created.users.push(u.id);
  return u;
}
async function makeMembership(user, tenantId, businessId, roleType, capabilities = []) {
  const role = await prisma.role.findFirst({ where: { tenantId, type: roleType } });
  return prisma.membership.create({
    data: { userId: user.id, tenantId, customerId: businessId, roleId: role.id, capabilities, isActive: true },
  });
}

/** Everything about a session that a mutation could touch. */
async function snapshot(id) {
  const s = await prisma.supportSession.findUnique({ where: { id } });
  const events = await prisma.supportSessionEvent.count({ where: { supportSessionId: id } });
  const tokens = await prisma.launcherToken.count({ where: { supportSessionId: id } });
  const { updatedAt: _u, ...rest } = s;
  return JSON.stringify({ ...rest, updatedAt: s.updatedAt.getTime(), events, tokens });
}

async function cleanup() {
  await prisma.$transaction([
    prisma.launcherToken.deleteMany({ where: { userId: { in: created.users } } }),
    prisma.supportSession.deleteMany({ where: { OR: [{ technicianId: { in: created.users } }, { customerId: { in: created.businesses } }] } }),
    prisma.activityLog.deleteMany({ where: { actorId: { in: created.users } } }),
    prisma.computerAccess.deleteMany({ where: { userId: { in: created.users } } }),
    prisma.membership.deleteMany({ where: { userId: { in: created.users } } }),
  ]);
  await prisma.rustdeskNode.deleteMany({ where: { endpointId: { in: created.endpoints } } });
  await prisma.endpoint.deleteMany({ where: { id: { in: created.endpoints } } });
  await prisma.activityLog.updateMany({ where: { customerId: { in: created.businesses } }, data: { customerId: null } });
  await prisma.customer.deleteMany({ where: { id: { in: created.businesses } } });
  await prisma.user.deleteMany({ where: { id: { in: created.users } } });
}

try {
  const tenant = await prisma.tenant.findFirst({ where: { isActive: true }, orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('no platform container — run the seed first');
  await prisma.tenantSettings.upsert({
    where: { tenantId: tenant.id },
    update: { rustdeskRelayHost: 'rd.sess.example.com', rustdeskPublicKey: 'A'.repeat(43) + '=' },
    create: { tenantId: tenant.id, rustdeskRelayHost: 'rd.sess.example.com', rustdeskPublicKey: 'A'.repeat(43) + '=' },
  });

  const bizA = await prisma.customer.create({ data: { tenantId: tenant.id, name: `Sess A ${sfx}`, isActive: true } });
  const bizB = await prisma.customer.create({ data: { tenantId: tenant.id, name: `Sess B ${sfx}`, isActive: true } });
  created.businesses.push(bizA.id, bizB.id);

  const alice = await makeUser(`sess-alice-${sfx}@test.invalid`);
  const mallory = await makeUser(`sess-mallory-${sfx}@test.invalid`);
  const ownerA = await makeUser(`sess-owner-a-${sfx}@test.invalid`);
  const ownerB = await makeUser(`sess-owner-b-${sfx}@test.invalid`);
  const bobB = await makeUser(`sess-bob-b-${sfx}@test.invalid`);
  await makeMembership(alice, tenant.id, bizA.id, 'BUSINESS_USER', ['computers:view', 'computers:connect', 'support:sessions_view']);
  await makeMembership(mallory, tenant.id, bizA.id, 'BUSINESS_USER', ['computers:view', 'computers:connect', 'support:sessions_view', 'support:history_view']);
  await makeMembership(ownerA, tenant.id, bizA.id, 'BUSINESS_OWNER');
  await makeMembership(ownerB, tenant.id, bizB.id, 'BUSINESS_OWNER');
  await makeMembership(bobB, tenant.id, bizB.id, 'BUSINESS_USER', ['computers:view', 'computers:connect', 'support:sessions_view', 'support:history_view']);

  // A computer both A technicians may connect to, so the only thing standing
  // between Mallory and Alice's session is the session's ownership.
  const rustdeskId = String(100000000 + Math.floor(Math.random() * 800000000));
  created.rustdeskIds.push(rustdeskId);
  const ep = await prisma.endpoint.create({
    data: {
      tenantId: tenant.id, customerId: bizA.id, name: `sess-ep-${sfx}`, hostname: `sess-ep-${sfx}`,
      status: 'ACTIVE', isOnline: true, isManaged: true, accessMode: 'COMPANY_WIDE',
      rustdeskNode: { create: { tenantId: tenant.id, rustdeskId } },
    },
  });
  created.endpoints.push(ep.id);

  const mkSession = (status = 'PENDING', extra = {}) => prisma.supportSession.create({
    data: { tenantId: tenant.id, customerId: bizA.id, technicianId: alice.id, endpointId: ep.id, status, ...extra },
  });

  const cAlice = await login(alice.email);
  const cMallory = await login(mallory.email);
  const cOwnerA = await login(ownerA.email);
  const cOwnerB = await login(ownerB.email);
  const cBobB = await login(bobB.email);

  // ── 1. Viewing is not modifying ────────────────────────────────────────────
  section('history_view grants reading, not writing');
  {
    const s = await mkSession('CLIENT_OPENED', { startedAt: new Date(Date.now() - 60_000) });
    check((await req('GET', `/sessions/${s.id}`, { cookie: cMallory })).status === 200,
      'history viewer can read a colleague\'s session');
    const before = await snapshot(s.id);
    const attempts = [
      ['PATCH', `/sessions/${s.id}/complete`, { disposition: 'resolved', notes: 'not mine' }],
      ['PATCH', `/sessions/${s.id}/cancel`, undefined],
      ['POST', `/sessions/${s.id}/events`, { event: 'client_closed' }],
      ['POST', `/sessions/${s.id}/events`, { event: 'client_opened' }],
      ['POST', `/sessions/${s.id}/events`, { event: 'forged_note', metadata: { x: 1 } }],
    ];
    for (const [m, p, b] of attempts) {
      const r = await req(m, p, { cookie: cMallory, body: b });
      check(r.status === 403, `history viewer ${m} ${p.replace(s.id, ':id')} → 403`, `HTTP ${r.status}`);
    }
    check(await snapshot(s.id) === before, 'rejected mutations changed nothing (row, events, tokens)');

    const tok = await req('POST', '/launcher/token', { cookie: cMallory, body: { endpointId: ep.id, sessionId: s.id } });
    check(tok.status === 404, 'history viewer cannot bind a launcher token to a colleague\'s session', `HTTP ${tok.status}`);
    check(await snapshot(s.id) === before, '… and no token row was written for it');
  }

  section('Cross-business stays denied');
  {
    const s = await mkSession('PENDING');
    const before = await snapshot(s.id);
    for (const [who, c] of [['other business Owner', cOwnerB], ['other business history viewer', cBobB]]) {
      const codes = [
        (await req('GET', `/sessions/${s.id}`, { cookie: c })).status,
        (await req('PATCH', `/sessions/${s.id}/complete`, { cookie: c, body: {} })).status,
        (await req('PATCH', `/sessions/${s.id}/cancel`, { cookie: c })).status,
        (await req('POST', `/sessions/${s.id}/events`, { cookie: c, body: { event: 'client_opened' } })).status,
      ];
      check(codes.every((x) => x === 404), `${who}: read/complete/cancel/event all 404`, codes.join(','));
    }
    check(await snapshot(s.id) === before, 'nothing changed');
  }

  section('Owners and supervisors keep their access');
  {
    const s = await mkSession('PENDING');
    const r1 = await req('POST', `/sessions/${s.id}/events`, { cookie: cAlice, body: { event: 'client_opened' } });
    check(r1.status === 200, 'technician records client_opened on own session', `HTTP ${r1.status}`);
    const r2 = await req('PATCH', `/sessions/${s.id}/complete`, { cookie: cAlice, body: { disposition: 'resolved' } });
    check(r2.status === 200 && r2.body?.data?.status === 'SESSION_COMPLETED', 'technician completes own session', `HTTP ${r2.status}`);

    const s2 = await mkSession('CLIENT_OPENED', { startedAt: new Date(Date.now() - 90_000) });
    const r3 = await req('PATCH', `/sessions/${s2.id}/complete`, { cookie: cOwnerA, body: {} });
    check(r3.status === 200, 'Business Owner completes a technician\'s session in their business', `HTTP ${r3.status}`);
    const d = (await prisma.supportSession.findUnique({ where: { id: s2.id } })).duration;
    check(d >= 89 && d <= 120, 'duration measured from the recorded start', `duration=${d}`);

    const s3 = await mkSession('PENDING');
    const tok = await req('POST', '/launcher/token', { cookie: cAlice, body: { endpointId: ep.id, sessionId: s3.id } });
    check(tok.status === 201 || tok.status === 200, 'technician binds a launcher token to own pending session', `HTTP ${tok.status} ${JSON.stringify(tok.body).slice(0, 200)}`);
  }

  // ── 2. Transitions ─────────────────────────────────────────────────────────
  section('Terminal sessions stay closed');
  for (const status of ['SESSION_COMPLETED', 'CANCELED', 'FAILED']) {
    const s = await mkSession(status, { startedAt: new Date(Date.now() - 120_000), completedAt: new Date(Date.now() - 60_000), duration: 60 });
    const before = await snapshot(s.id);
    const codes = [];
    for (const c of [cAlice, cOwnerA]) {
      codes.push((await req('POST', `/sessions/${s.id}/events`, { cookie: c, body: { event: 'client_opened' } })).status);
      codes.push((await req('POST', `/sessions/${s.id}/events`, { cookie: c, body: { event: 'client_closed' } })).status);
      codes.push((await req('POST', `/sessions/${s.id}/events`, { cookie: c, body: { event: 'late_note' } })).status);
      codes.push((await req('PATCH', `/sessions/${s.id}/complete`, { cookie: c, body: {} })).status);
      codes.push((await req('PATCH', `/sessions/${s.id}/cancel`, { cookie: c })).status);
    }
    check(codes.every((x) => x === 409), `${status}: every event/complete/cancel refused with 409`, codes.join(','));
    const tok = await req('POST', '/launcher/token', { cookie: cAlice, body: { endpointId: ep.id, sessionId: s.id } });
    check(tok.status === 404, `${status}: no launcher token can be bound to it`, `HTTP ${tok.status}`);
    check(await snapshot(s.id) === before, `${status}: row, duration and events unchanged`);
  }

  section('Duplicate and out-of-order events');
  {
    const s = await mkSession('PENDING');
    const early = await req('POST', `/sessions/${s.id}/events`, { cookie: cAlice, body: { event: 'client_closed' } });
    check(early.status === 409, 'client_closed before client_opened → 409', `HTTP ${early.status}`);
    await req('POST', `/sessions/${s.id}/events`, { cookie: cAlice, body: { event: 'client_opened' } });
    const start = (await prisma.supportSession.findUnique({ where: { id: s.id } })).startedAt;
    const before = await snapshot(s.id);
    const dup = await req('POST', `/sessions/${s.id}/events`, { cookie: cAlice, body: { event: 'client_opened' } });
    check(dup.status === 409, 'repeated client_opened → 409', `HTTP ${dup.status}`);
    check(await snapshot(s.id) === before, 'startedAt and event count unchanged by the repeat');
    check(start instanceof Date, 'startedAt recorded once');
  }

  section('Concurrency, on real Postgres');
  {
    const s = await mkSession('PENDING');
    const rs = await Promise.all(Array.from({ length: 8 }, () =>
      req('POST', `/sessions/${s.id}/events`, { cookie: cAlice, body: { event: 'client_opened' } })));
    const codes = rs.map((r) => r.status);
    check(codes.filter((x) => x === 200).length === 1 && codes.filter((x) => x === 409).length === 7,
      '8 concurrent client_opened: exactly one applies, seven 409', codes.join(','));
    const n = await prisma.supportSessionEvent.count({ where: { supportSessionId: s.id } });
    check(n === 1, 'exactly one event row', `rows=${n}`);

    const s2 = await mkSession('CLIENT_OPENED', { startedAt: new Date(Date.now() - 30_000) });
    const [a, b, c2] = await Promise.all([
      req('PATCH', `/sessions/${s2.id}/complete`, { cookie: cAlice, body: {} }),
      req('PATCH', `/sessions/${s2.id}/cancel`, { cookie: cOwnerA }),
      req('POST', `/sessions/${s2.id}/events`, { cookie: cAlice, body: { event: 'client_closed' } }),
    ]);
    const okCount = [a, b, c2].filter((r) => r.status === 200).length;
    check(okCount === 1, 'complete vs cancel vs client_closed racing: exactly one wins', `${a.status},${b.status},${c2.status}`);

    const s3 = await mkSession('CLIENT_OPENED', { startedAt: new Date(Date.now() - 30_000) });
    const rs3 = await Promise.all([
      req('PATCH', `/sessions/${s3.id}/complete`, { cookie: cAlice, body: {} }),
      ...Array.from({ length: 5 }, () => req('POST', `/sessions/${s3.id}/events`, { cookie: cAlice, body: { event: 'late_note' } })),
    ]);
    const fin = await prisma.supportSession.findUnique({ where: { id: s3.id } });
    const lateRows = await prisma.supportSessionEvent.findMany({ where: { supportSessionId: s3.id }, orderBy: { timestamp: 'asc' } });
    const afterClose = lateRows.filter((e) => e.timestamp > fin.completedAt);
    check(rs3[0].status === 200 && fin.status === 'SESSION_COMPLETED', 'complete applied');
    check(afterClose.length === 0, 'no annotation landed after the close committed', `${afterClose.length} late rows`);
  }

  section('Launcher redemption cannot reopen a closed session');
  {
    const s = await mkSession('PENDING');
    const tok = await req('POST', '/launcher/token', { cookie: cAlice, body: { endpointId: ep.id, sessionId: s.id } });
    const raw = tok.body?.data?.token;
    check(!!raw, 'token issued for own pending session', JSON.stringify(tok.body).slice(0, 200));
    const cancel = await req('PATCH', `/sessions/${s.id}/cancel`, { cookie: cAlice });
    check(cancel.status === 200, 'session canceled before the launcher redeems');
    const before = await snapshot(s.id);
    const v = await req('GET', '/launcher/validate', { headers: { authorization: `Bearer ${raw}` } });
    // Redemption itself may succeed (the token is valid and the computer is
    // still reachable); what it must not do is touch the closed session.
    const after = JSON.parse(await snapshot(s.id));
    const prev = JSON.parse(before);
    check(after.status === 'CANCELED' && after.startedAt === prev.startedAt && after.events === prev.events,
      'redeeming the token left the canceled session canceled, with no client_opened', `validate HTTP ${v.status}; status=${after.status} events=${after.events}`);
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
