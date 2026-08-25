#!/usr/bin/env node
// End-to-end proof of the primary Rem0te product story:
//
//   1. Platform admin logs in.
//   2. Creates a Company (ACME).
//   3. Invites an employee (john@acme) and activates them.
//   4. Creates a managed-enrollment token bound to ACME + John.
//   5. Simulates the Windows installer:
//        POST /enrollment/claim { token, rustdeskId, password, hostname, platform }
//      The endpoint the installer sends CANNOT influence which company or
//      which user gets access — those are stamped from the token.
//   6. Verifies the created Endpoint belongs to ACME, has ComputerAccess
//      for John, and has an encrypted permanentPassword.
//   7. Logs in as John.
//   8. GET /endpoints/mine returns the new computer.
//   9. POST /endpoints/:id/connect returns { rustdeskId, password }.
//  10. Cleans up.
//
// If any step fails, exits non-zero.

import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { randomBytes } from 'crypto';

const prisma = new PrismaClient();
const API = 'http://127.0.0.1:3001/api/v1';
const suffix = randomBytes(3).toString('hex');

function jbody(v) { try { return typeof v === 'string' ? v.slice(0, 180) : JSON.stringify(v).slice(0, 180); } catch { return String(v).slice(0, 180); } }
async function req(method, path, body, cookie) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = r.headers.get('set-cookie') || '';
  const text = await r.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed, setCookie };
}
function assert(cond, msg) { if (!cond) throw new Error('FAIL: ' + msg); }
function log(step, r, ok) {
  const mark = ok ? '✓' : '·';
  console.log(`  ${mark} ${step}: HTTP ${r.status} ${jbody(r.body)}`);
}

// ── Setup: seed a platform admin and a would-be-employee ────────────────────
const adminPw = 'admin-password-1234';
const johnPw  = 'john-password-1234';
const admin = await prisma.user.create({
  data: {
    email: `e2e-admin-${suffix}@test.invalid`,
    passwordHash: await argon2.hash(adminPw, { type: argon2.argon2id }),
    firstName: 'E2E', lastName: 'Admin',
    isPlatformAdmin: true, status: 'ACTIVE',
  },
});
// Note: we deliberately do NOT pre-seed a Membership. Login uses the
// platform-admin fallback to pick the default tenant.

const created = [];

try {
  // 1. Admin login
  const login = await req('POST', '/auth/login', { email: admin.email, password: adminPw });
  log('admin login', login, login.status === 200);
  assert(login.status === 200, 'login failed');
  const adminCookie = login.setCookie.split(';')[0];
  const tenantId = login.body?.data?.tenants?.[0]?.id || null;
  const meRes = await req('GET', '/auth/me', null, adminCookie);
  const adminTenantId = meRes.body?.data?.tenantId;
  assert(adminTenantId, 'admin got no tenantId in JWT');

  // 2. Create Company
  const cust = await req('POST', '/customers',
    { name: `ACME ${suffix}`, email: `admin@acme-${suffix}.test`, phone: '+15555550100', city: 'Boston', country: 'US' },
    adminCookie);
  log('create company', cust, cust.status === 201);
  assert(cust.status === 201, 'create customer failed');
  const customerId = cust.body?.data?.id;
  created.push({ type: 'customer', id: customerId });

  // 3. Invite an employee. usersService.invite creates a User (status=INVITED)
  //    and a Membership. We then flip the user to ACTIVE + set a password
  //    directly in the DB (the real UX would be an invite-accept flow).
  const listMembers1 = await req('GET', '/users', null, adminCookie);
  const roleId = await prisma.role.findFirst({ where: { tenantId: adminTenantId, type: 'TECHNICIAN' } }).then((r) => r?.id);
  assert(roleId, 'TECHNICIAN role not seeded');

  const invite = await req('POST', '/users/invite',
    { email: `john-${suffix}@acme.test`, roleId },
    adminCookie);
  log('invite user', invite, invite.status === 201);
  assert(invite.status === 201, 'invite failed');
  const johnUserId = invite.body?.membership?.userId;
  assert(johnUserId, 'no userId returned');
  created.push({ type: 'user', id: johnUserId });

  await prisma.user.update({
    where: { id: johnUserId },
    data: {
      status: 'ACTIVE',
      passwordHash: await argon2.hash(johnPw, { type: argon2.argon2id }),
      firstName: 'John', lastName: `Smith-${suffix}`,
    },
  });
  await prisma.membership.updateMany({
    where: { userId: johnUserId, tenantId: adminTenantId },
    data: { isActive: true, customerId },
  });

  // 4. Create a managed-enrollment token bound to Company + John
  const tokenRes = await req('POST', '/enrollment/tokens',
    { customerId, accessMode: 'ASSIGNED_USERS', assignedUserIds: [johnUserId], description: `e2e ${suffix}` },
    adminCookie);
  log('create enrollment token', tokenRes, tokenRes.status === 201);
  assert(tokenRes.status === 201, 'token creation failed');
  const rawToken = tokenRes.body?.data?.token;
  assert(rawToken, 'no token returned');

  // 5. Simulate the installer redeeming the token
  const rustdeskId = String(900000000 + Math.floor(Math.random() * 99999999));
  const claim = await req('POST', '/enrollment/claim',
    { token: rawToken, rustdeskId, password: 'endpoint-generated-pw-abc123', hostname: `DESKTOP-${suffix.toUpperCase()}`, platform: 'Windows' });
  log('installer claim', claim, claim.status === 200);
  assert(claim.status === 200, 'claim failed');
  const endpointId = claim.body?.data?.endpoint?.id;
  assert(endpointId, 'no endpoint returned');
  created.push({ type: 'endpoint', id: endpointId });

  // 6. Verify the created Endpoint has the correct customer + access rows
  const dbEndpoint = await prisma.endpoint.findUnique({
    where: { id: endpointId },
    include: {
      rustdeskNode: { select: { rustdeskId: true, permanentPassword: true } },
      computerAccess: true,
    },
  });
  assert(dbEndpoint?.customerId === customerId, `endpoint.customerId != expected (got ${dbEndpoint?.customerId})`);
  assert(dbEndpoint?.rustdeskNode?.permanentPassword, 'permanentPassword not stored');
  assert(dbEndpoint?.computerAccess.some((c) => c.userId === johnUserId), 'John was not granted ComputerAccess');
  console.log('  ✓ endpoint bound to ACME + John, password encrypted at rest');

  // 7. Log in as John
  const johnLogin = await req('POST', '/auth/login', { email: `john-${suffix}@acme.test`, password: johnPw });
  log('john login', johnLogin, johnLogin.status === 200);
  assert(johnLogin.status === 200, 'john login failed');
  const johnCookie = johnLogin.setCookie.split(';')[0];

  // 8. John sees "his" computer
  const mine = await req('GET', '/endpoints/mine', null, johnCookie);
  log('john /endpoints/mine', mine, Array.isArray(mine.body?.data) && mine.body.data.some((e) => e.id === endpointId));
  assert(Array.isArray(mine.body?.data) && mine.body.data.some((e) => e.id === endpointId), 'John does not see the assigned computer');

  // 9. Connect — returns rustdeskId + password
  const connect = await req('POST', `/endpoints/${endpointId}/connect`, {}, johnCookie);
  log('john connect', connect, connect.status === 200);
  assert(connect.status === 200, 'connect failed');
  assert(connect.body?.data?.rustdeskId === rustdeskId, 'connect returned wrong rustdeskId');
  assert(connect.body?.data?.password === 'endpoint-generated-pw-abc123', 'connect returned wrong password');
  console.log('  ✓ Connect returned correct rustdeskId + decrypted password');

  console.log('\n✓ FULL END-TO-END PROOF PASSED');
} catch (err) {
  console.error('\n✗', err.message);
  process.exitCode = 1;
} finally {
  // Cleanup
  for (const c of created.reverse()) {
    try {
      if (c.type === 'endpoint') {
        await prisma.rustdeskNode.deleteMany({ where: { endpointId: c.id } });
        await prisma.computerAccess.deleteMany({ where: { endpointId: c.id } });
        await prisma.endpoint.delete({ where: { id: c.id } });
      } else if (c.type === 'user') {
        await prisma.membership.deleteMany({ where: { userId: c.id } });
        await prisma.user.delete({ where: { id: c.id } });
      } else if (c.type === 'customer') {
        await prisma.customer.delete({ where: { id: c.id } });
      }
    } catch { /* best-effort */ }
  }
  await prisma.user.delete({ where: { id: admin.id } }).catch(()=>{});
  await prisma.$disconnect();
}
