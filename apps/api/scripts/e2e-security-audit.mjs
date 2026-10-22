#!/usr/bin/env node
/**
 * End-to-end proof of the 0.18.22 security-audit fixes.
 *
 * Each section is one finding from that review, exercised against a running
 * API the way an attacker would have used it. Like the other e2e suites it
 * creates its own namespaced fixtures directly in the database and tears them
 * down at the end, including on failure.
 *
 * It writes rows, so point it at a scratch stack — never production:
 *
 *   API_BASE=http://127.0.0.1:3101/api/v1 DATABASE_URL=… ENCRYPTION_KEY=… \
 *     node scripts/e2e-security-audit.mjs
 */

import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { authenticator } from 'otplib';
import { createCipheriv, randomBytes } from 'crypto';

const API = process.env.API_BASE ?? 'http://127.0.0.1:3001/api/v1';
if (/:3001\b|:443\b|^https:/.test(API) && process.env.I_KNOW_THIS_IS_NOT_PRODUCTION !== '1') {
  console.error(`Refusing to run against ${API}: this suite writes fixtures. Use a scratch stack.`);
  process.exit(2);
}

const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'test-password-123456';
const encKey = Buffer.from(process.env.ENCRYPTION_KEY ?? '', 'hex');

let pass = 0, fail = 0;
const failures = [];
function ok(name) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
function bad(name, detail) {
  fail++; failures.push(`${name} — ${detail}`);
  console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${detail}`);
}
function check(cond, name, detail = '') { if (cond) ok(name); else bad(name, detail); }
function section(t) { console.log(`\n\x1b[1m${t}\x1b[0m`); }

async function req(method, path, { body, cookie, headers = {} } = {}) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed, text, setCookie: r.headers.get('set-cookie') || '' };
}
const cookieFrom = (r) => {
  const m = r.setCookie.match(/access_token=([^;]+)/);
  return m ? `access_token=${m[1]}` : null;
};
async function login(email, password = PW) {
  const r = await req('POST', '/auth/login', { body: { email, password } });
  const c = cookieFrom(r);
  if (!c) throw new Error(`login ${email} failed: ${r.status} ${JSON.stringify(r.body)}`);
  return c;
}
function encrypt(text) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encKey, iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${enc.toString('hex')}`;
}
const rid = () => String(100000000 + Math.floor(Math.random() * 800000000));
const secret = () => randomBytes(24).toString('base64url');

// ── Fixtures ─────────────────────────────────────────────────────────────────

const created = { users: [], businesses: [], endpoints: [], rustdeskIds: [] };

async function makeUser(email, { platformAdmin = false } = {}) {
  const u = await prisma.user.create({
    data: {
      email, passwordHash: await argon2.hash(PW, { type: argon2.argon2id }),
      firstName: 'Audit', lastName: email.split('@')[0], status: 'ACTIVE', isPlatformAdmin: platformAdmin,
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
async function makeEndpoint(tenantId, businessId, name, { accessMode = 'ASSIGNED_USERS', agentSecret, password } = {}) {
  const rustdeskId = rid();
  created.rustdeskIds.push(rustdeskId);
  const e = await prisma.endpoint.create({
    data: {
      tenantId, customerId: businessId, name, hostname: name, status: 'ACTIVE', isOnline: true,
      isManaged: true, accessMode,
      rustdeskNode: {
        create: {
          tenantId, rustdeskId,
          ...(agentSecret ? { agentSecretHash: (await import('crypto')).createHash('sha256').update(agentSecret).digest('hex') } : {}),
          ...(password ? { permanentPassword: encrypt(password) } : {}),
        },
      },
    },
  });
  created.endpoints.push(e.id);
  return { ...e, rustdeskId };
}

async function cleanup() {
  const nodes = await prisma.rustdeskNode.findMany({ where: { rustdeskId: { in: created.rustdeskIds } }, select: { endpointId: true } });
  const endpointIds = [...new Set([...created.endpoints, ...nodes.map((n) => n.endpointId)])];
  await prisma.$transaction([
    prisma.note.deleteMany({ where: { authorId: { in: created.users } } }),
    prisma.computerAccess.deleteMany({ where: { OR: [{ userId: { in: created.users } }, { endpointId: { in: endpointIds } }] } }),
    prisma.connectionGrant.deleteMany({ where: { userId: { in: created.users } } }),
    prisma.launcherToken.deleteMany({ where: { userId: { in: created.users } } }),
    prisma.supportSession.deleteMany({ where: { OR: [{ technicianId: { in: created.users } }, { customerId: { in: created.businesses } }] } }),
    prisma.activityLog.deleteMany({ where: { actorId: { in: created.users } } }),
    prisma.userMfaMethod.deleteMany({ where: { userId: { in: created.users } } }),
    prisma.membership.deleteMany({ where: { userId: { in: created.users } } }),
  ]);
  await prisma.deviceClaimToken.deleteMany({ where: { customerId: { in: created.businesses } } });
  await prisma.rustdeskNode.deleteMany({ where: { endpointId: { in: endpointIds } } });
  await prisma.endpointEnrollment.deleteMany({ where: { endpointId: { in: endpointIds } } }).catch(() => {});
  await prisma.endpoint.deleteMany({ where: { id: { in: endpointIds } } });
  await prisma.apiKey.deleteMany({ where: { customerId: { in: created.businesses } } });
  await prisma.site.deleteMany({ where: { customerId: { in: created.businesses } } });
  await prisma.activityLog.updateMany({ where: { customerId: { in: created.businesses } }, data: { customerId: null } });
  await prisma.customer.deleteMany({ where: { id: { in: created.businesses } } });
  await prisma.user.deleteMany({ where: { id: { in: created.users } } });
}

// ── Run ──────────────────────────────────────────────────────────────────────

try {
  const tenant = await prisma.tenant.findFirst({ where: { isActive: true }, orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('no platform container — run the seed first');
  // connect.cmd needs a configured RustDesk server.
  await prisma.tenantSettings.upsert({
    where: { tenantId: tenant.id },
    update: { rustdeskRelayHost: 'rd.audit.example.com', rustdeskPublicKey: 'A'.repeat(43) + '=' },
    create: { tenantId: tenant.id, rustdeskRelayHost: 'rd.audit.example.com', rustdeskPublicKey: 'A'.repeat(43) + '=' },
  });

  section('Fixtures');
  const bizA = await prisma.customer.create({ data: { tenantId: tenant.id, name: `Audit A ${sfx}`, isActive: true } });
  const bizB = await prisma.customer.create({ data: { tenantId: tenant.id, name: `Audit B ${sfx}`, isActive: true } });
  created.businesses.push(bizA.id, bizB.id);
  const siteB = await prisma.site.create({ data: { tenantId: tenant.id, customerId: bizB.id, name: `Audit B site ${sfx}`, isActive: true } });

  const admin = await makeUser(`audit-admin-${sfx}@test.invalid`, { platformAdmin: true });
  const ownerA = await makeUser(`audit-owner-a-${sfx}@test.invalid`);
  const editorA = await makeUser(`audit-editor-a-${sfx}@test.invalid`);
  const bareA = await makeUser(`audit-bare-a-${sfx}@test.invalid`);
  const mfaUser = await makeUser(`audit-mfa-${sfx}@test.invalid`);
  await makeMembership(ownerA, tenant.id, bizA.id, 'BUSINESS_OWNER');
  await makeMembership(editorA, tenant.id, bizA.id, 'BUSINESS_USER', ['computers:view', 'computers:edit', 'computers:connect']);
  await makeMembership(bareA, tenant.id, bizA.id, 'BUSINESS_USER', []);
  await makeMembership(mfaUser, tenant.id, bizA.id, 'BUSINESS_USER', ['computers:view']);

  const epSecret = secret();
  const epA = await makeEndpoint(tenant.id, bizA.id, `AUDIT-A-${sfx}`, { agentSecret: epSecret, password: 'hunter2-audit' });
  const epLegacy = await makeEndpoint(tenant.id, bizA.id, `AUDIT-LEGACY-${sfx}`);
  ok('fixtures created');

  const cAdmin = await login(admin.email);
  const cOwnerA = await login(ownerA.email);
  const cEditorA = await login(editorA.email);
  const cBareA = await login(bareA.email);

  // ── C1 ──────────────────────────────────────────────────────────────────
  section('C1 — device-reported hostname cannot inject into the Connect .cmd');
  {
    const hb = await req('POST', '/enrollment/heartbeat', {
      body: { rustdeskId: epA.rustdeskId, agentSecret: epSecret, hostname: `PC&calc.exe^|'x` },
    });
    check(hb.status === 200, 'authenticated heartbeat accepted', `HTTP ${hb.status}`);
    const cmd = await req('GET', `/endpoints/${epA.id}/connect.cmd`, { cookie: cOwnerA });
    check(cmd.status === 200, 'connect.cmd served', `HTTP ${cmd.status} ${cmd.text.slice(0, 200)}`);
    const title = (cmd.text.match(/^title .*$/m) ?? [''])[0];
    check(title && !/[&|^%'"<>]/.test(title), 'title line carries no cmd metacharacter', title);
    check(!cmd.text.includes('calc.exe^'), 'raw hostname appears nowhere in the script');
    const claimBad = await req('POST', '/enrollment/claim', { body: { token: 'x'.repeat(64), rustdeskId: `1&calc` } });
    check(claimBad.status === 400, 'claim rejects a non-numeric rustdeskId', `HTTP ${claimBad.status}`);
  }

  // ── H1 ──────────────────────────────────────────────────────────────────
  section('H1 — only a Platform Admin may type in a RustDesk ID');
  {
    const r = await req('POST', '/endpoints', { cookie: cOwnerA, body: { name: `squat-${sfx}`, rustdeskId: rid(), customerId: bizA.id } });
    check(r.status === 403, 'Business Owner refused', `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
    if (r.body?.data?.id) created.endpoints.push(r.body.data.id);
    const id = rid(); created.rustdeskIds.push(id);
    const a = await req('POST', '/endpoints', { cookie: cAdmin, body: { name: `admin-${sfx}`, rustdeskId: id, customerId: bizA.id } });
    check(a.status === 201 || a.status === 200, 'Platform Admin allowed', `HTTP ${a.status} ${JSON.stringify(a.body).slice(0, 160)}`);
    if (a.body?.data?.id) created.endpoints.push(a.body.data.id);
    const dup = await req('POST', '/endpoints', { cookie: cAdmin, body: { name: `dup-${sfx}`, rustdeskId: epA.rustdeskId, customerId: bizB.id } });
    check(dup.status === 409 && !JSON.stringify(dup.body).includes(bizA.name), 'duplicate ID refused without naming its owner', `HTTP ${dup.status}`);
  }

  // ── M9 ──────────────────────────────────────────────────────────────────
  section('M9 — a heartbeat never binds a first secret');
  {
    const r = await req('POST', '/enrollment/heartbeat', {
      body: { rustdeskId: epLegacy.rustdeskId, agentSecret: secret(), hostname: 'taken-over', password: 'attacker-pw' },
    });
    const node = await prisma.rustdeskNode.findUnique({ where: { rustdeskId: epLegacy.rustdeskId } });
    check(r.status === 200 && r.body?.data?.authenticated === false, 'unbound node answers unauthenticated', JSON.stringify(r.body?.data));
    check(!node.agentSecretHash && !node.permanentPassword && node.hostname !== 'taken-over', 'nothing was bound or written');
    check(r.body?.data?.endpointId === undefined, 'response does not reveal the endpoint id');
    const rot = await req('POST', `/endpoints/${epLegacy.id}/rotate-credential`, { cookie: cOwnerA });
    check(rot.status === 400, 'rotation refused for a node with no device secret', `HTTP ${rot.status}`);

    // The recovery path: a token minted for this very computer may rebind it.
    const t = await req('POST', '/enrollment/tokens', { cookie: cOwnerA, body: { businessId: bizA.id, endpointId: epLegacy.id } });
    const own = secret();
    const c = await req('POST', '/enrollment/claim', { body: { token: t.body?.data?.token, rustdeskId: epLegacy.rustdeskId, agentSecret: own } });
    const bound = await prisma.rustdeskNode.findUnique({ where: { rustdeskId: epLegacy.rustdeskId } });
    check(c.status === 200 && !!bound.agentSecretHash, 'a token minted for the computer re-binds it', `HTTP ${c.status} ${JSON.stringify(c.body).slice(0, 160)}`);
    const other = await req('POST', '/enrollment/tokens', { cookie: cOwnerA, body: { businessId: bizA.id } });
    const steal = await req('POST', '/enrollment/claim', { body: { token: other.body?.data?.token, rustdeskId: epLegacy.rustdeskId, agentSecret: secret() } });
    check(steal.status === 400, 'a token for any other computer cannot', `HTTP ${steal.status}`);
  }

  // ── M8 ──────────────────────────────────────────────────────────────────
  section('M8 — a claim token is single-use under a race');
  {
    const t = await req('POST', '/enrollment/tokens', { cookie: cOwnerA, body: { businessId: bizA.id, accessMode: 'COMPANY_WIDE' } });
    const token = t.body?.data?.token;
    check(!!token, 'token minted', `HTTP ${t.status}`);
    const ids = [rid(), rid(), rid(), rid()]; created.rustdeskIds.push(...ids);
    const results = await Promise.all(ids.map((id) =>
      req('POST', '/enrollment/claim', { body: { token, rustdeskId: id, hostname: `race-${id}`, agentSecret: secret() } })));
    const wins = results.filter((r) => r.status === 200).length;
    check(wins === 1, 'exactly one of four concurrent claims wins', `wins=${wins} statuses=${results.map((r) => r.status)}`);
  }

  // ── M4 + access mode ───────────────────────────────────────────────────
  section('M4 — computers:edit does not bypass per-computer grants');
  {
    const pw = await req('GET', `/endpoints/${epA.id}/password`, { cookie: cEditorA });
    check(pw.status === 403, 'password reveal refused without a grant', `HTTP ${pw.status}`);
    const set = await req('PATCH', `/endpoints/${epA.id}/password`, { cookie: cEditorA, body: { password: 'x' } });
    check(set.status === 403 || set.status === 400, 'password set refused without a grant', `HTTP ${set.status}`);
    const mode = await req('PATCH', `/endpoints/${epA.id}/access-mode`, { cookie: cEditorA, body: { mode: 'COMPANY_WIDE' } });
    check(mode.status === 403, 'access-mode change needs users:manage', `HTTP ${mode.status}`);
    const lt = await req('POST', '/launcher/token', { cookie: cEditorA, body: { endpointId: epA.id } });
    check(lt.status === 404 || lt.status === 403, 'launcher token refused without a grant', `HTTP ${lt.status}`);
    await prisma.computerAccess.create({ data: { tenantId: tenant.id, endpointId: epA.id, userId: editorA.id } });
    const pw2 = await req('GET', `/endpoints/${epA.id}/password`, { cookie: cEditorA });
    check(pw2.status === 200, 'password reveal allowed once granted', `HTTP ${pw2.status}`);
    const own = await req('GET', `/endpoints/${epA.id}/password`, { cookie: cOwnerA });
    check(own.status === 200, 'Business Owner still reaches it', `HTTP ${own.status}`);
  }

  // ── M5 ──────────────────────────────────────────────────────────────────
  section('M5 — business detail needs computers:view for the inventory');
  {
    const r = await req('GET', `/businesses/${bizA.id}`, { cookie: cBareA });
    check(r.status === 200 && r.body?.data?.endpoints === undefined, 'no-capability member gets no computer list', `HTTP ${r.status} keys=${Object.keys(r.body?.data ?? {})}`);
    const o = await req('GET', `/businesses/${bizA.id}`, { cookie: cOwnerA });
    check(Array.isArray(o.body?.data?.endpoints), 'owner still gets the computer list');
  }

  // ── M6 / M7 ─────────────────────────────────────────────────────────────
  section('M6/M7 — no cross-business session or site ids');
  {
    const sessB = await prisma.supportSession.create({ data: { tenantId: tenant.id, customerId: bizB.id, technicianId: admin.id } });
    const n = await req('POST', '/notes', { cookie: cOwnerA, body: { content: 'x', endpointId: epA.id, sessionId: sessB.id } });
    check(n.status === 404 || n.status === 400, 'note cannot ride onto another business\'s session', `HTTP ${n.status}`);
    const u = await req('PATCH', `/endpoints/${epA.id}`, { cookie: cOwnerA, body: { siteId: siteB.id } });
    check(u.status === 400, 'computer cannot point at another business\'s site', `HTTP ${u.status}`);
  }

  // ── Launcher ────────────────────────────────────────────────────────────
  section('Launcher — header only, session scoped');
  {
    const q = await req('GET', '/launcher/validate?token=abc');
    check(q.status !== 200 || q.body?.success === false, 'query-string token not accepted', `HTTP ${q.status} ${JSON.stringify(q.body).slice(0, 120)}`);
    const sessB = await prisma.supportSession.create({ data: { tenantId: tenant.id, customerId: bizB.id, technicianId: admin.id } });
    const lt = await req('POST', '/launcher/token', { cookie: cOwnerA, body: { endpointId: epA.id, sessionId: sessB.id } });
    check(lt.status === 404, 'token cannot carry another business\'s session', `HTTP ${lt.status}`);
  }

  // ── API keys ────────────────────────────────────────────────────────────
  section('API keys die with their creator\'s standing');
  {
    const k = await req('POST', '/apikeys', { cookie: cOwnerA, body: { name: `audit-${sfx}`, scopes: ['computers:read'] } });
    const key = k.body?.data?.key ?? k.body?.data?.rawKey ?? k.body?.data?.token;
    if (!key) {
      bad('API key created', `HTTP ${k.status} ${JSON.stringify(k.body).slice(0, 200)}`);
    } else {
      const who = () => req('GET', '/pub/v1/whoami', { headers: { authorization: `Bearer ${key}` } });
      check((await who()).status === 200, 'key works while its creator is an owner');
      const userRole = await prisma.role.findFirst({ where: { tenantId: tenant.id, type: 'BUSINESS_USER' } });
      await prisma.membership.updateMany({ where: { userId: ownerA.id }, data: { roleId: userRole.id } });
      check((await who()).status === 401, 'key refused once its creator is demoted');
      const ownerRole = await prisma.role.findFirst({ where: { tenantId: tenant.id, type: 'BUSINESS_OWNER' } });
      await prisma.membership.updateMany({ where: { userId: ownerA.id }, data: { roleId: ownerRole.id } });
    }
  }

  // ── Sessions ────────────────────────────────────────────────────────────
  section('Sessions — sign-out and password change revoke tokens');
  {
    const c1 = await login(bareA.email);
    const c2 = await login(bareA.email);
    const out = await req('POST', '/auth/logout', { cookie: c1 });
    check(out.status === 200, 'sign-out succeeds', `HTTP ${out.status}`);
    await new Promise((r) => setTimeout(r, 1100));
    check((await req('GET', '/auth/me', { cookie: c1 })).status === 401, 'signed-out token refused');
    check((await req('GET', '/auth/me', { cookie: c2 })).status === 401, 'other sessions end too');

    await new Promise((r) => setTimeout(r, 1100));
    const a = await login(bareA.email);
    const b = await login(bareA.email);
    const ch = await req('POST', '/auth/change-password', { cookie: a, body: { currentPassword: PW, newPassword: 'another-password-123' } });
    const fresh = cookieFrom(ch);
    check(ch.status === 200 && !!fresh, 'password change returns a replacement session', `HTTP ${ch.status}`);
    check((await req('GET', '/auth/me', { cookie: b })).status === 401, 'other session ends on password change');
    check((await req('GET', '/auth/me', { cookie: fresh })).status === 200, 'replacement session works');
    const em = await req('PATCH', '/auth/profile', { cookie: fresh, body: { email: `moved-${sfx}@test.invalid` } });
    check(em.status === 400, 'email change refused without the current password', `HTTP ${em.status}`);
    const em2 = await req('PATCH', '/auth/profile', { cookie: fresh, body: { email: `moved-${sfx}@test.invalid`, currentPassword: 'another-password-123' } });
    check(em2.status === 200, 'email change allowed with it', `HTTP ${em2.status}`);
    const junk = await req('PATCH', '/auth/profile', { cookie: fresh, body: { isPlatformAdmin: true } });
    check(junk.status === 400, 'unknown profile fields rejected', `HTTP ${junk.status}`);
  }

  // ── MFA ─────────────────────────────────────────────────────────────────
  section('MFA — no silent downgrade, no replay, per-account lockout');
  {
    let c = await login(mfaUser.email);
    const setup = await req('POST', '/mfa/totp/setup', { cookie: c });
    const totpSecret = setup.body?.data?.secret;
    const code = authenticator.generate(totpSecret);
    const conf = await req('POST', '/mfa/totp/confirm', { cookie: c, body: { code } });
    check(conf.status === 200, 'TOTP enrolled', `HTTP ${conf.status}`);
    const again = await req('POST', '/mfa/totp/setup', { cookie: c });
    check(again.status === 400, 'a second setup is refused while MFA is on', `HTTP ${again.status}`);
    const active = await prisma.userMfaMethod.findFirst({ where: { userId: mfaUser.id, type: 'TOTP', isActive: true } });
    check(!!active, 'MFA is still active');
    const self = await req('POST', `/users/${mfaUser.id}/mfa/reset`, { cookie: c });
    check(self.status === 403, 'self MFA reset without a code refused', `HTTP ${self.status}`);

    const startMfa = async () => {
      const l = await req('POST', '/auth/login', { body: { email: mfaUser.email, password: PW } });
      return (l.setCookie.match(/partial_token=([^;]+)/) ?? [])[1];
    };
    const verify = (pt, code) => req('POST', '/auth/mfa/verify', { cookie: `partial_token=${pt}`, body: { code } });

    // The enrolment consumed this step's code: wait into the next one.
    await new Promise((r) => setTimeout(r, (30 - (Math.floor(Date.now() / 1000) % 30) + 1) * 1000));
    const live = authenticator.generate(totpSecret);
    const first = await verify(await startMfa(), live);
    check(first.status === 200, 'a fresh code signs in', `HTTP ${first.status}`);
    const replay = await verify(await startMfa(), live);
    check(replay.status === 401, 'the same code is refused the second time', `HTTP ${replay.status}`);

    const pt = await startMfa();
    for (let i = 0; i < 5; i++) await verify(pt, '000000');
    await new Promise((r) => setTimeout(r, (30 - (Math.floor(Date.now() / 1000) % 30) + 1) * 1000));
    const locked = await verify(await startMfa(), authenticator.generate(totpSecret));
    check(locked.status === 401, 'a correct code is refused once the account is locked', `HTTP ${locked.status}`);
  }

  // ── Uploads ─────────────────────────────────────────────────────────────
  section('Logo uploads — raster only');
  {
    const tenantRow = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
    const fd = new FormData();
    fd.append('file', new Blob(['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'], { type: 'image/svg+xml' }), 'x.svg');
    const r = await fetch(`${API}/platform/${tenantRow.id}/branding/logo`, { method: 'PATCH', headers: { cookie: cAdmin }, body: fd });
    check(r.status === 400, 'SVG refused', `HTTP ${r.status}`);
  }
} catch (e) {
  bad('suite crashed', e?.stack ?? String(e));
} finally {
  await cleanup().catch((e) => bad('cleanup', String(e)));
  await prisma.$disconnect();
}

console.log(`\n\x1b[1mResult: ${pass} passed, ${fail} failed\x1b[0m`);
if (fail) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
