#!/usr/bin/env node
/**
 * End-to-end proof of the v0.8.0 access-control model and Quick Connect.
 *
 * The whole point of this file is section 18 of the spec: prove server-side
 * that Business A can never reach Business B, that Business User permissions
 * are actually enforced rather than merely hidden in the UI, and that Quick
 * Connect obeys all three of its switches.
 *
 * Everything it creates is namespaced with a random suffix and torn down at
 * the end, including on failure.
 *
 * Run:  node scripts/e2e-business-access.mjs
 */

import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { randomBytes } from 'crypto';

const prisma = new PrismaClient();
const API = 'http://127.0.0.1:3001/api/v1';
const sfx = randomBytes(3).toString('hex');

const PW = 'test-password-123456';

let pass = 0, fail = 0;
const failures = [];

function ok(name) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
function bad(name, detail) {
  fail++; failures.push(`${name} — ${detail}`);
  console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${detail}`);
}
function check(cond, name, detail = '') { if (cond) ok(name); else bad(name, detail); }
function section(t) { console.log(`\n\x1b[1m${t}\x1b[0m`); }

async function req(method, path, { body, cookie } = {}) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed, setCookie: r.headers.get('set-cookie') || '' };
}

async function login(email) {
  const r = await req('POST', '/auth/login', { body: { email, password: PW } });
  if (r.status !== 200) throw new Error(`login ${email} failed: ${r.status} ${JSON.stringify(r.body)}`);
  const m = r.setCookie.match(/access_token=([^;]+)/);
  if (!m) throw new Error(`login ${email}: no access_token cookie`);
  return `access_token=${m[1]}`;
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const created = { users: [], businesses: [], endpoints: [] };

async function makeUser(email, { platformAdmin = false } = {}) {
  const u = await prisma.user.create({
    data: {
      email, passwordHash: await argon2.hash(PW, { type: argon2.argon2id }),
      firstName: 'E2E', lastName: email.split('@')[0],
      status: 'ACTIVE', isPlatformAdmin: platformAdmin,
    },
  });
  created.users.push(u.id);
  return u;
}

async function makeMembership(user, tenantId, businessId, roleType, capabilities = []) {
  const role = await prisma.role.findFirst({ where: { tenantId, type: roleType } });
  if (!role) throw new Error(`role ${roleType} missing on tenant ${tenantId}`);
  return prisma.membership.create({
    data: { userId: user.id, tenantId, customerId: businessId, roleId: role.id, capabilities, isActive: true },
  });
}

async function makeEndpoint(tenantId, businessId, name) {
  const e = await prisma.endpoint.create({
    data: {
      tenantId, customerId: businessId, name, hostname: name,
      status: 'ACTIVE', isOnline: true, isManaged: true, accessMode: 'COMPANY_WIDE',
      rustdeskNode: { create: { tenantId, rustdeskId: String(100000000 + Math.floor(Math.random() * 800000000)) } },
    },
  });
  created.endpoints.push(e.id);
  return e;
}

async function cleanup() {
  await prisma.$transaction([
    prisma.computerAccess.deleteMany({ where: { userId: { in: created.users } } }),
    prisma.connectionGrant.deleteMany({ where: { userId: { in: created.users } } }),
    prisma.supportSession.deleteMany({ where: { technicianId: { in: created.users } } }),
    prisma.activityLog.deleteMany({ where: { actorId: { in: created.users } } }),
    prisma.launcherToken.deleteMany({ where: { userId: { in: created.users } } }),
    prisma.membership.deleteMany({ where: { userId: { in: created.users } } }),
    prisma.invitation.deleteMany({ where: { invitedById: { in: created.users } } }),
  ]);
  await prisma.rustdeskNode.deleteMany({ where: { endpointId: { in: created.endpoints } } });
  await prisma.endpoint.deleteMany({ where: { id: { in: created.endpoints } } });
  await prisma.deviceClaimToken.deleteMany({ where: { customerId: { in: created.businesses } } });
  await prisma.apiKey.deleteMany({ where: { customerId: { in: created.businesses } } });
  await prisma.activityLog.updateMany({ where: { customerId: { in: created.businesses } }, data: { customerId: null } });
  await prisma.customer.deleteMany({ where: { id: { in: created.businesses } } });
  await prisma.user.deleteMany({ where: { id: { in: created.users } } });
}

// ── Run ──────────────────────────────────────────────────────────────────────

let originalQuickConnect = false;

try {
  const tenant = await prisma.tenant.findFirst({ where: { isActive: true }, orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('no platform container — run the seed first');

  originalQuickConnect =
    (await prisma.platformSettings.findUnique({ where: { id: 'singleton' } }))?.quickConnectEnabled ?? false;

  section('Fixtures');

  const bizA = await prisma.customer.create({
    data: { tenantId: tenant.id, name: `E2E Business A ${sfx}`, isActive: true, quickConnectEnabled: true },
  });
  const bizB = await prisma.customer.create({
    data: { tenantId: tenant.id, name: `E2E Business B ${sfx}`, isActive: true, quickConnectEnabled: false },
  });
  created.businesses.push(bizA.id, bizB.id);

  const admin = await makeUser(`e2e-admin-${sfx}@test.invalid`, { platformAdmin: true });
  const ownerA = await makeUser(`e2e-owner-a-${sfx}@test.invalid`);
  const userA = await makeUser(`e2e-user-a-${sfx}@test.invalid`);
  const ownerB = await makeUser(`e2e-owner-b-${sfx}@test.invalid`);

  await makeMembership(ownerA, tenant.id, bizA.id, 'BUSINESS_OWNER');
  await makeMembership(userA, tenant.id, bizA.id, 'BUSINESS_USER', ['computers:view', 'computers:connect']);
  await makeMembership(ownerB, tenant.id, bizB.id, 'BUSINESS_OWNER');

  const epA = await makeEndpoint(tenant.id, bizA.id, `E2E-A-PC-${sfx}`);
  const epB = await makeEndpoint(tenant.id, bizB.id, `E2E-B-PC-${sfx}`);

  ok('two businesses, three users and two computers created');

  const cAdmin = await login(admin.email);
  const cOwnerA = await login(ownerA.email);
  const cUserA = await login(userA.email);
  const cOwnerB = await login(ownerB.email);
  ok('all four accounts can sign in');

  // ── Platform Admin ────────────────────────────────────────────────────────
  section('PLATFORM ADMIN');

  {
    const r = await req('GET', '/businesses', { cookie: cAdmin });
    const names = (r.body?.data ?? []).map((b) => b.name);
    check(names.includes(bizA.name) && names.includes(bizB.name),
      'sees every business', `got ${names.length} businesses`);
  }
  {
    const r = await req('GET', '/endpoints', { cookie: cAdmin });
    const ids = (r.body?.data?.endpoints ?? []).map((e) => e.id);
    check(ids.includes(epA.id) && ids.includes(epB.id), 'sees every computer');
  }
  {
    const r = await req('GET', `/admin/search?q=E2E-`, { cookie: cAdmin });
    const found = (r.body?.data?.computers ?? []).map((c) => c.id);
    check(r.body?.data?.scope === 'platform' && found.includes(epA.id) && found.includes(epB.id),
      'global search spans businesses', JSON.stringify(r.body?.data?.scope));
  }
  {
    const r = await req('POST', '/businesses', {
      cookie: cAdmin, body: { name: `E2E Temp ${sfx}` },
    });
    if (r.status === 201 || r.status === 200) {
      created.businesses.push(r.body?.data?.id);
      ok('can create a business');
      const del = await req('DELETE', `/businesses/${r.body.data.id}`, { cookie: cAdmin });
      check(del.status === 200, 'can delete an empty business', `HTTP ${del.status}`);
    } else {
      bad('can create a business', `HTTP ${r.status} ${JSON.stringify(r.body)}`);
    }
  }
  {
    const r = await req('PATCH', `/businesses/${bizB.id}`, { cookie: cAdmin, body: { isActive: false } });
    check(r.status === 200, 'can disable a business', `HTTP ${r.status}`);
    await req('PATCH', `/businesses/${bizB.id}`, { cookie: cAdmin, body: { isActive: true } });
  }
  {
    const r = await req('GET', '/admin/unassigned-devices', { cookie: cAdmin });
    check(r.status === 200, 'can list unassigned computers', `HTTP ${r.status}`);
  }

  // ── Business Owner ────────────────────────────────────────────────────────
  section('BUSINESS OWNER (Business A)');

  {
    const r = await req('GET', '/businesses', { cookie: cOwnerA });
    const names = (r.body?.data ?? []).map((b) => b.name);
    check(names.length === 1 && names[0] === bizA.name,
      'sees ONLY their own business', `saw: ${JSON.stringify(names)}`);
  }
  {
    const r = await req('GET', '/endpoints', { cookie: cOwnerA });
    const ids = (r.body?.data?.endpoints ?? []).map((e) => e.id);
    check(ids.includes(epA.id) && !ids.includes(epB.id),
      'sees ONLY their own computers', `saw ${ids.length}`);
  }
  {
    const r = await req('GET', '/users', { cookie: cOwnerA });
    const emails = (r.body?.data ?? []).map((m) => m.user.email);
    check(emails.includes(userA.email) && !emails.includes(ownerB.email),
      'sees ONLY their own people', `saw: ${JSON.stringify(emails)}`);
  }
  {
    const r = await req('PATCH', `/users/${userA.id}/capabilities`, {
      cookie: cOwnerA, body: { capabilities: ['computers:view'] },
    });
    check(r.status === 200, 'can change a Business User\'s permissions', `HTTP ${r.status}`);
  }
  {
    const r = await req('PATCH', `/users/${userA.id}/level`, {
      cookie: cOwnerA, body: { level: 'BUSINESS_OWNER' },
    });
    check(r.status === 403, 'CANNOT promote someone to Business Owner', `HTTP ${r.status}`);
  }
  {
    const r = await req('POST', '/enrollment/tokens', { cookie: cOwnerA, body: { businessId: bizA.id } });
    check(r.status === 201 || r.status === 200, 'can mint a managed-device installer for their business', `HTTP ${r.status}`);
  }
  {
    const r = await req('POST', '/enrollment/tokens', { cookie: cOwnerA, body: { businessId: bizB.id } });
    check(r.status === 403, 'CANNOT mint an installer bound to another business', `HTTP ${r.status}`);
  }
  {
    const r = await req('GET', '/admin/platform-settings', { cookie: cOwnerA });
    check(r.status === 403, 'CANNOT read platform settings', `HTTP ${r.status}`);
  }
  {
    const r = await req('GET', '/users/platform-admins', { cookie: cOwnerA });
    check(r.status === 403, 'CANNOT list Platform Admins', `HTTP ${r.status}`);
  }
  {
    const r = await req('GET', `/platform/${tenant.id}`, { cookie: cOwnerA });
    check(r.status === 403, 'CANNOT read platform configuration', `HTTP ${r.status}`);
  }

  // ── Cross-business isolation ──────────────────────────────────────────────
  section('CROSS-BUSINESS ISOLATION (A must never reach B)');

  const crossChecks = [
    ['GET',   `/businesses/${bizB.id}`,                  'business record'],
    ['GET',   `/businesses/${bizB.id}/users`,            'business users'],
    ['GET',   `/endpoints/${epB.id}`,                    'computer detail'],
    ['GET',   `/endpoints/${epB.id}/access`,             'computer access list'],
    ['GET',   `/endpoints/${epB.id}/password`,           'computer password'],
    ['PATCH', `/endpoints/${epB.id}`,                    'computer rename'],
    ['PATCH', `/endpoints/${epB.id}/archive`,            'computer archive'],
    ['POST',  `/endpoints/${epB.id}/connect`,            'remote connection'],
    ['POST',  `/endpoints/${epB.id}/rotate-credential`,  'credential rotation'],
    ['GET',   `/businesses/${bizB.id}/sites`,            'sites'],
    ['GET',   `/audit?businessId=${bizB.id}`,            'audit log'],
    ['GET',   `/sessions?businessId=${bizB.id}`,         'sessions'],
    ['GET',   `/users?businessId=${bizB.id}`,            'user list'],
    ['GET',   `/endpoints?businessId=${bizB.id}`,        'computer list'],
    ['GET',   `/dashboard?businessId=${bizB.id}`,        'dashboard counts'],
  ];

  for (const [method, path, label] of crossChecks) {
    const r = await req(method, path, {
      cookie: cOwnerA,
      ...(method === 'PATCH' ? { body: { name: 'pwned' } } : {}),
    });
    // 403 (refused) and 404 (indistinguishable from absent) are both correct.
    // 200 is only acceptable if the payload is provably empty.
    let leaked = false;
    if (r.status === 200) {
      const d = r.body?.data;
      const rows = Array.isArray(d) ? d
        : Array.isArray(d?.endpoints) ? d.endpoints
          : Array.isArray(d?.logs) ? d.logs
            : Array.isArray(d?.sessions) ? d.sessions
              : null;
      leaked = rows === null ? true : rows.some((x) => x.id === epB.id || x.id === bizB.id);
      if (rows && rows.length > 0 && !leaked) {
        // Rows came back, but they must all be Business A's.
        leaked = rows.some((x) => x.customerId === bizB.id || x.business?.id === bizB.id);
      }
    }
    check(!leaked, `Owner A blocked from Business B ${label}`,
      `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
  }

  {
    // The classic /business/12/device/123 → /business/13/device/456 probe.
    const r = await req('POST', `/businesses/${bizB.id}/users`, {
      cookie: cOwnerA,
      body: { email: `e2e-injected-${sfx}@test.invalid`, level: 'BUSINESS_USER' },
    });
    check(r.status === 403 || r.status === 404,
      'Owner A cannot inject a user into Business B', `HTTP ${r.status}`);
  }
  {
    const r = await req('PATCH', `/users/${ownerB.id}/capabilities`, {
      cookie: cOwnerA, body: { capabilities: ['users:manage'] },
    });
    check(r.status === 403 || r.status === 404,
      'Owner A cannot alter a Business B user', `HTTP ${r.status}`);
  }
  {
    const r = await req('DELETE', `/users/${ownerB.id}`, { cookie: cOwnerA });
    check(r.status === 403 || r.status === 404,
      'Owner A cannot delete a Business B user', `HTTP ${r.status}`);
  }
  {
    // Owner B must be equally blind in the other direction.
    const r = await req('GET', '/endpoints', { cookie: cOwnerB });
    const ids = (r.body?.data?.endpoints ?? []).map((e) => e.id);
    check(ids.includes(epB.id) && !ids.includes(epA.id),
      'Owner B sees only Business B (isolation is symmetric)', `saw ${ids.length}`);
  }

  // ── Business User permissions ─────────────────────────────────────────────
  section('BUSINESS USER PERMISSIONS');

  async function setCaps(caps) {
    await prisma.membership.updateMany({ where: { userId: userA.id }, data: { capabilities: caps } });
  }

  await setCaps(['computers:view', 'computers:connect']);
  {
    const r = await req('GET', '/endpoints', { cookie: cUserA });
    check(r.status === 200 && (r.body?.data?.endpoints ?? []).some((e) => e.id === epA.id),
      'with computers:view — can list computers', `HTTP ${r.status}`);
  }
  {
    const r = await req('POST', `/endpoints/${epA.id}/connect`, { cookie: cUserA });
    check(r.status === 200 || r.status === 201,
      'with computers:connect — can connect', `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
  }

  await setCaps(['computers:view']);
  {
    const r = await req('POST', `/endpoints/${epA.id}/connect`, { cookie: cUserA });
    check(r.status === 403,
      'removing Remote connect BLOCKS the connection', `HTTP ${r.status}`);
  }
  {
    const r = await req('POST', '/sessions', { cookie: cUserA, body: { endpointId: epA.id } });
    check(r.status === 403,
      'removing Remote connect also blocks starting a session', `HTTP ${r.status}`);
  }
  {
    const r = await req('POST', '/launcher/token', { cookie: cUserA, body: { endpointId: epA.id } });
    check(r.status === 403,
      'removing Remote connect also blocks the launcher token', `HTTP ${r.status}`);
  }

  await setCaps([]);
  {
    const r = await req('GET', '/endpoints', { cookie: cUserA });
    check(r.status === 403, 'with no permissions — cannot list computers', `HTTP ${r.status}`);
  }
  {
    const r = await req('GET', '/users', { cookie: cUserA });
    check(r.status === 403, 'with no permissions — cannot list users', `HTTP ${r.status}`);
  }
  {
    const r = await req('GET', '/audit', { cookie: cUserA });
    check(r.status === 403, 'with no permissions — cannot read the audit log', `HTTP ${r.status}`);
  }

  {
    // Self-escalation, the attack this model exists to stop.
    const r = await req('PATCH', `/users/${userA.id}/capabilities`, {
      cookie: cUserA, body: { capabilities: ['users:manage', 'computers:connect', 'audit:view'] },
    });
    check(r.status === 403, 'CANNOT grant themselves permissions', `HTTP ${r.status}`);

    const after = await prisma.membership.findFirst({ where: { userId: userA.id }, select: { capabilities: true } });
    check((after?.capabilities ?? []).length === 0,
      'self-escalation left the database untouched', JSON.stringify(after?.capabilities));
  }
  {
    const r = await req('PATCH', `/users/${userA.id}/level`, { cookie: cUserA, body: { level: 'BUSINESS_OWNER' } });
    check(r.status === 403, 'CANNOT promote themselves to Business Owner', `HTTP ${r.status}`);
  }
  {
    const r = await req('PATCH', `/users/${userA.id}/platform-admin`, { cookie: cUserA, body: { enabled: true } });
    check(r.status === 403, 'CANNOT make themselves a Platform Admin', `HTTP ${r.status}`);
  }
  {
    const r = await req('GET', `/admin/search?q=E2E-`, { cookie: cUserA });
    const found = (r.body?.data?.computers ?? []).map((c) => c.id);
    check(r.status === 200 && !found.includes(epB.id),
      'search stays inside their own business', `saw ${found.length} computers`);
  }

  // ── Quick Connect ─────────────────────────────────────────────────────────
  section('QUICK CONNECT');

  async function setPlatformQuickConnect(enabled) {
    await prisma.platformSettings.upsert({
      where: { id: 'singleton' },
      update: { quickConnectEnabled: enabled },
      create: { id: 'singleton', quickConnectEnabled: enabled },
    });
  }

  // Platform OFF beats everything.
  await setPlatformQuickConnect(false);
  {
    const r = await req('GET', '/quick-connect/status', { cookie: cOwnerA });
    check(r.body?.data?.canUse === false, 'platform switch OFF — unavailable even to an owner');
  }
  {
    const r = await req('POST', '/quick-connect/connect', {
      cookie: cOwnerA, body: { rustdeskId: '123456789', password: 'A7k9X2' },
    });
    check(r.status === 403, 'platform switch OFF — connect refused', `HTTP ${r.status}`);
  }
  {
    const r = await fetch('http://127.0.0.1:3001/api/v1/public/quick-connect');
    const j = await r.json();
    check(j?.data?.enabled === false, 'platform switch OFF — public page reports unavailable');
  }
  {
    const r = await fetch('http://127.0.0.1:3001/api/v1/public/quick-connect/download/windows');
    check(r.status === 404, 'platform switch OFF — client download refused', `HTTP ${r.status}`);
  }

  // Platform ON.
  await setPlatformQuickConnect(true);
  {
    const r = await req('GET', '/quick-connect/status', { cookie: cOwnerA });
    check(r.body?.data?.canUse === true,
      'platform ON + business ON + owner — available', JSON.stringify(r.body?.data));
  }
  {
    // Business B has quickConnectEnabled = false.
    const r = await req('GET', '/quick-connect/status', { cookie: cOwnerB });
    check(r.body?.data?.canUse === false && r.body?.data?.platformEnabled === true,
      'business switch OFF — unavailable to that business', JSON.stringify(r.body?.data));
  }
  {
    const r = await req('POST', '/quick-connect/connect', {
      cookie: cOwnerB, body: { rustdeskId: '123456789', password: 'A7k9X2' },
    });
    check(r.status === 403, 'business switch OFF — connect refused', `HTTP ${r.status}`);
  }

  // User capability gate.
  await setCaps([]);
  {
    const r = await req('GET', '/quick-connect/status', { cookie: cUserA });
    check(r.body?.data?.canUse === false && r.body?.data?.hasCapability === false,
      'user capability OFF — unavailable', JSON.stringify(r.body?.data));
  }
  {
    const r = await req('POST', '/quick-connect/connect', {
      cookie: cUserA, body: { rustdeskId: '123456789', password: 'A7k9X2' },
    });
    check(r.status === 403, 'user capability OFF — connect refused', `HTTP ${r.status}`);
  }

  await setCaps(['support:quick_connect']);
  let qcSessionId = null;
  {
    const r = await req('GET', '/quick-connect/status', { cookie: cUserA });
    check(r.body?.data?.canUse === true, 'user capability ON — available', JSON.stringify(r.body?.data));
  }
  {
    const r = await req('POST', '/quick-connect/connect', {
      cookie: cUserA,
      body: { rustdeskId: '123 456 789', password: 'A7k9X2', contactName: 'E2E caller' },
    });
    qcSessionId = r.body?.data?.sessionId ?? null;
    check((r.status === 200 || r.status === 201) && r.body?.data?.rustdeskId === '123456789',
      'user capability ON — connect succeeds and normalises the ID', `HTTP ${r.status}`);
  }
  {
    const eps = await prisma.endpoint.count({ where: { customerId: bizA.id } });
    check(eps === 1, 'Quick Connect created NO managed computer', `business A has ${eps} computers`);
  }
  {
    const s = await prisma.supportSession.findUnique({ where: { id: qcSessionId } });
    check(s?.isAdHoc === true && s?.customerId === bizA.id && s?.endpointId === null,
      'session is ad-hoc and scoped to the right business');
  }
  {
    const logs = await prisma.activityLog.findMany({
      where: { action: 'QUICK_CONNECT_INITIATED', resourceId: qcSessionId },
    });
    const meta = JSON.stringify(logs[0]?.metadata ?? {});
    check(logs.length === 1 && meta.includes('123456789'), 'audit record written with the remote ID');
    check(!meta.includes('A7k9X2'), 'password NOT present in the audit metadata', meta);
  }
  {
    const anywhere = await prisma.activityLog.count({
      where: { metadata: { path: ['password'], not: undefined } },
    }).catch(() => 0);
    const raw = await prisma.$queryRaw`
      SELECT COUNT(*)::int AS n FROM "ActivityLog" WHERE metadata::text LIKE '%A7k9X2%'`;
    check(Number(raw?.[0]?.n ?? 0) === 0, 'password appears nowhere in the audit log', `${anywhere}`);
  }
  {
    const raw = await prisma.$queryRaw`
      SELECT COUNT(*)::int AS n FROM "SupportSession" WHERE CAST("notes" AS text) LIKE '%A7k9X2%'`;
    check(Number(raw?.[0]?.n ?? 0) === 0, 'password not stored on the session record');
  }
  {
    const r = await req('POST', `/quick-connect/sessions/${qcSessionId}/end`, {
      cookie: cUserA, body: { result: 'completed' },
    });
    check(r.status === 200 || r.status === 201, 'session can be closed', `HTTP ${r.status}`);
    const ended = await prisma.activityLog.count({
      where: { action: 'QUICK_CONNECT_ENDED', resourceId: qcSessionId },
    });
    check(ended === 1, 'session end is audited');
  }
  {
    // Retry after closing — a support call often needs a second attempt.
    const r = await req('POST', '/quick-connect/connect', {
      cookie: cUserA, body: { rustdeskId: '123456789', password: 'B8m0Y3' },
    });
    check(r.status === 200 || r.status === 201, 'can reconnect after closing', `HTTP ${r.status}`);
    if (r.body?.data?.sessionId) {
      await req('POST', `/quick-connect/sessions/${r.body.data.sessionId}/end`, { cookie: cUserA });
    }
  }
  {
    const r = await req('POST', '/quick-connect/connect', {
      cookie: cUserA, body: { rustdeskId: 'not-an-id', password: 'A7k9X2' },
    });
    check(r.status === 400, 'malformed Remote ID rejected', `HTTP ${r.status}`);
  }
  {
    // Owner A must not see Business B's Quick Connect history.
    const r = await req('GET', `/quick-connect/sessions?businessId=${bizB.id}`, { cookie: cOwnerA });
    check(r.status === 403, 'Quick Connect history is business-scoped', `HTTP ${r.status}`);
  }
  {
    const r = await fetch('http://127.0.0.1:3001/api/v1/public/quick-connect');
    const j = await r.json();
    const text = JSON.stringify(j);
    check(j?.data?.enabled === true, 'platform ON — public page reports available');
    check(!text.includes(bizA.name) && !text.includes(userA.email),
      'public page leaks no business or user names', text.slice(0, 200));
  }

  // ── Disabled business locks its own people out ────────────────────────────
  section('DISABLED BUSINESS');
  {
    await prisma.customer.update({ where: { id: bizA.id }, data: { isActive: false } });
    const r = await req('GET', '/endpoints', { cookie: cOwnerA });
    check(r.status === 401, 'disabling a business locks its users out immediately', `HTTP ${r.status}`);
    await prisma.customer.update({ where: { id: bizA.id }, data: { isActive: true } });
  }

  // ── Unauthenticated ───────────────────────────────────────────────────────
  section('UNAUTHENTICATED');
  for (const p of ['/businesses', '/endpoints', '/users', '/audit', '/quick-connect/status', '/admin/platform-settings']) {
    const r = await req('GET', p);
    check(r.status === 401, `unauthenticated ${p} refused`, `HTTP ${r.status}`);
  }

} catch (err) {
  bad('harness', err.message);
  console.error(err);
} finally {
  await prisma.platformSettings.upsert({
    where: { id: 'singleton' },
    update: { quickConnectEnabled: originalQuickConnect },
    create: { id: 'singleton', quickConnectEnabled: originalQuickConnect },
  }).catch(() => {});
  await cleanup().catch((e) => console.error('cleanup failed:', e.message));
  await prisma.$disconnect();
}

console.log(`\n\x1b[1mResult: ${pass} passed, ${fail} failed\x1b[0m`);
if (fail > 0) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
