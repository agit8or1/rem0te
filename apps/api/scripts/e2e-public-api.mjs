#!/usr/bin/env node
// End-to-end proof of the /api/v1/pub/v1 API-key-authenticated public surface.
// Mints a key via the admin console, uses it via Bearer auth, cleans up.

import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { randomBytes } from 'crypto';

const prisma = new PrismaClient();
const API = 'http://127.0.0.1:3001/api/v1';
const suffix = randomBytes(3).toString('hex');
const adminPw = 'apikey-e2e-pw-1234';

async function req(method, path, body, headers = {}) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed, setCookie: r.headers.get('set-cookie') || '' };
}
function log(step, r, ok) { console.log(`  ${ok ? '✓' : '·'} ${step}: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 140)}`); }
function assert(cond, msg) { if (!cond) throw new Error('FAIL: ' + msg); }

const admin = await prisma.user.create({
  data: {
    email: `e2e-apikey-${suffix}@test.invalid`,
    passwordHash: await argon2.hash(adminPw, { type: argon2.argon2id }),
    firstName: 'E2E', lastName: 'ApiKey',
    isPlatformAdmin: true, status: 'ACTIVE',
  },
});
const created = [];

try {
  // 1. admin login (uses platform-admin default-tenant fallback)
  const login = await req('POST', '/auth/login', { email: admin.email, password: adminPw });
  const cookie = login.setCookie.split(';')[0];
  assert(login.status === 200, 'login failed');

  // 2. mint an API key
  const mint = await req('POST', '/apikeys',
    { name: `e2e ${suffix}`, scopes: ['companies:read', 'companies:write', 'computers:read', 'enrollment:write'] },
    { cookie });
  log('mint api key', mint, mint.status === 201);
  assert(mint.status === 201, 'mint failed');
  const rawKey = mint.body?.data?.key;
  const keyId = mint.body?.data?.id;
  assert(rawKey?.startsWith('rk_'), 'key format wrong');
  created.push({ type: 'apikey', id: keyId });

  // 3. whoami with the key
  const authH = { authorization: `Bearer ${rawKey}` };
  const whoami = await req('GET', '/pub/v1/whoami', null, authH);
  log('whoami', whoami, whoami.status === 200);
  assert(whoami.status === 200, 'whoami failed');
  assert(whoami.body?.tenantId, 'no tenantId in whoami');

  // 4. list companies (empty tenant is fine)
  const listCo = await req('GET', '/pub/v1/companies', null, authH);
  log('list companies', listCo, listCo.status === 200);
  assert(listCo.status === 200, 'list companies failed');

  // 5. create a company via API key
  const createCo = await req('POST', '/pub/v1/companies', { name: `ApiKey Co ${suffix}` }, authH);
  log('create company', createCo, createCo.status === 201);
  assert(createCo.status === 201, 'create failed');
  const customerId = createCo.body?.data?.id;
  created.push({ type: 'customer', id: customerId });

  // 6. mint enrollment token via API key
  const mintEnroll = await req('POST', '/pub/v1/enrollment/tokens',
    { customerId, accessMode: 'COMPANY_WIDE', platform: 'windows' }, authH);
  log('mint enrollment', mintEnroll, mintEnroll.status === 201);
  assert(mintEnroll.status === 201, 'mint enrollment failed');
  assert(mintEnroll.body?.data?.install?.command?.startsWith('irm '), 'install command missing');

  // 7. scope enforcement — reading users should be denied without users:read
  const usersDenied = await req('GET', '/pub/v1/users', null, authH);
  log('users denied (no scope)', usersDenied, usersDenied.status === 401);
  assert(usersDenied.status === 401, 'scope enforcement not working');

  // 8. revoke the key, verify it's rejected
  const revoke = await req('DELETE', `/apikeys/${keyId}`, null, { cookie });
  log('revoke key', revoke, revoke.status === 200);
  const afterRevoke = await req('GET', '/pub/v1/whoami', null, authH);
  log('whoami after revoke', afterRevoke, afterRevoke.status === 401);
  assert(afterRevoke.status === 401, 'revoked key still works');

  console.log('\n✓ PUBLIC API END-TO-END PROOF PASSED');
} catch (err) {
  console.error('\n✗', err.message);
  process.exitCode = 1;
} finally {
  for (const c of created.reverse()) {
    try {
      if (c.type === 'customer') await prisma.customer.delete({ where: { id: c.id } });
      if (c.type === 'apikey') await prisma.apiKey.delete({ where: { id: c.id } });
    } catch {}
  }
  await prisma.user.delete({ where: { id: admin.id } }).catch(()=>{});
  await prisma.$disconnect();
}
