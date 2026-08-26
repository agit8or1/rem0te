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

  // 2. An API key belongs to exactly one business, so create one first.
  //    A key with no business would have platform-wide reach, which is
  //    precisely the hole the business boundary exists to close.
  const bizRes = await req('POST', '/businesses', { name: `ApiKey Biz ${suffix}` }, { cookie });
  log('create business', bizRes, bizRes.status === 201);
  assert(bizRes.status === 201, 'create business failed');
  const businessId = bizRes.body?.data?.id;
  created.push({ type: 'customer', id: businessId });

  // 3. mint an API key bound to that business
  const mint = await req('POST', '/apikeys',
    {
      name: `e2e ${suffix}`,
      businessId,
      scopes: ['companies:read', 'companies:write', 'computers:read', 'enrollment:write'],
    },
    { cookie });
  log('mint api key', mint, mint.status === 201);
  assert(mint.status === 201, 'mint failed');
  const rawKey = mint.body?.data?.key;
  const keyId = mint.body?.data?.id;
  assert(rawKey?.startsWith('rk_'), 'key format wrong');
  created.push({ type: 'apikey', id: keyId });

  // 4. whoami reports the key's business, not a tenant
  const authH = { authorization: `Bearer ${rawKey}` };
  const whoami = await req('GET', '/pub/v1/whoami', null, authH);
  log('whoami', whoami, whoami.status === 200);
  assert(whoami.status === 200, 'whoami failed');
  assert(whoami.body?.businessId === businessId, 'whoami is not bound to the key\'s business');

  // 5. the key sees ONLY its own business
  const listCo = await req('GET', '/pub/v1/businesses', null, authH);
  log('list businesses', listCo, listCo.status === 200);
  assert(listCo.status === 200, 'list businesses failed');
  const listed = listCo.body?.data ?? [];
  assert(listed.length === 1 && listed[0].id === businessId,
    `key should see exactly its own business, saw ${listed.length}`);

  // 6. creating a business is a platform-operator action — an API key is
  //    never a Platform Admin, so this must be refused.
  const createCo = await req('POST', '/pub/v1/businesses', { name: `ApiKey Co ${suffix}` }, authH);
  log('create business denied', createCo, createCo.status === 403);
  assert(createCo.status === 403, 'an API key must not be able to create a business');

  // 7. mint an enrollment token — lands in the key's own business
  const mintEnroll = await req('POST', '/pub/v1/enrollment/tokens',
    { accessMode: 'COMPANY_WIDE', platform: 'windows' }, authH);
  log('mint enrollment', mintEnroll, mintEnroll.status === 201);
  assert(mintEnroll.status === 201, 'mint enrollment failed');
  assert(mintEnroll.body?.data?.install?.command?.startsWith('irm '), 'install command missing');

  // 8. scope enforcement — reading users should be denied without users:read
  const usersDenied = await req('GET', '/pub/v1/users', null, authH);
  log('users denied (no scope)', usersDenied, usersDenied.status === 401);
  assert(usersDenied.status === 401, 'scope enforcement not working');

  // 9. revoke the key, verify it's rejected
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
    } catch { /* best-effort cleanup */ }
  }
  await prisma.user.delete({ where: { id: admin.id } }).catch(()=>{});
  await prisma.$disconnect();
}
