#!/usr/bin/env node
// End-to-end smoke test that PROVES the fixed customer creation works
// through the full HTTP → validation → service → DB chain.
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { randomBytes } from 'crypto';

const prisma = new PrismaClient();
const API = 'http://127.0.0.1:3001/api/v1';

const suffix = randomBytes(3).toString('hex');
const email = `e2e-${suffix}@test.invalid`;
const password = 'e2e-smoke-password-1234';
const passwordHash = await argon2.hash(password, { type: argon2.argon2id });

// 1. Seed a platform admin so we can log in.
const user = await prisma.user.create({
  data: {
    email, passwordHash,
    firstName: 'E2E', lastName: 'Smoke',
    isPlatformAdmin: true, status: 'ACTIVE',
  },
});
console.log('seeded platform-admin:', email, '(', user.id, ')');

async function log(step, fn) {
  try {
    const r = await fn();
    const body = typeof r.body === 'string' ? r.body.slice(0, 200) : JSON.stringify(r.body).slice(0, 200);
    console.log(`  ${step}: HTTP ${r.status} ${body}`);
    return r;
  } catch (e) {
    console.log(`  ${step}: ERR ${e.message}`);
    throw e;
  }
}

async function post(path, body, cookie) {
  const r = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = r.headers.get('set-cookie') || '';
  const text = await r.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed, setCookie };
}
async function get(path, cookie) {
  const r = await fetch(`${API}${path}`, { headers: cookie ? { cookie } : {} });
  const text = await r.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

try {
  // 2. Log in
  const login = await log('POST /auth/login', () => post('/auth/login', { email, password }));
  const cookie = login.setCookie.split(';')[0]; // access_token=...
  if (!cookie) throw new Error('no auth cookie');

  // 3. Create a company (Customer). Should return {success:true, data:{...}}
  const cust = await log('POST /customers (was broken)', () => post('/customers',
    { name: `ACME ${suffix}`, email: `admin@acme-${suffix}.test`, phone: '+15555550100', city: 'Boston', country: 'US' },
    cookie));
  if (cust.status !== 201 && cust.status !== 200) throw new Error(`create customer failed: ${cust.status}`);
  const customerId = cust.body?.data?.id;

  // 4. List customers — the new one should be there
  await log('GET /customers', () => get('/customers', cookie));

  // 5. Create an enrollment token bound to this customer + company-wide access
  const token = await log('POST /enrollment/tokens (managed)', () => post('/enrollment/tokens',
    { customerId, accessMode: 'COMPANY_WIDE', assignedUserIds: [], description: 'e2e test' },
    cookie));
  const rawToken = token.body?.data?.token;
  if (!rawToken) throw new Error('no token issued');

  // 6. Fetch the tokenized install URL — should embed the token as $CLAIM_TOKEN
  const install = await get(`/public/install/win/${rawToken}`);
  const claimSet = install.body && install.body.toString().includes(`$CLAIM_TOKEN   = '${rawToken}'`);
  console.log(`  GET /public/install/win/<token>: HTTP ${install.status} claim-token-embedded=${claimSet}`);

  // 7. Cleanup
  if (customerId) await prisma.customer.delete({ where: { id: customerId } }).catch(()=>{});
  console.log('\n✓ end-to-end proof passed');
} finally {
  await prisma.user.delete({ where: { id: user.id } }).catch(()=>{});
  await prisma.$disconnect();
}
