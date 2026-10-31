#!/usr/bin/env node
// Proof for 0.19.5: a reinstall's RustDesk password, reported with a device
// secret the server does not hold yet, becomes the live password when that
// secret is accepted. Writes fixtures — scratch API and database only:
//   API_BASE=http://127.0.0.1:3101/api/v1 SEED_ADMIN_EMAIL=... SEED_ADMIN_PASSWORD=... node scripts/e2e-candidate-password.mjs
const B = process.env.API_BASE; if (!B || B.includes(':3001')) throw new Error('scratch API only');
let cookie = '';
async function call(method, path, body, auth = true) {
  const r = await fetch(B + path, { method, headers: { 'content-type': 'application/json', ...(auth && cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.getSetCookie?.() ?? []; const at = sc.find(c => c.startsWith('access_token=')); if (at) cookie = at.split(';')[0];
  let j = null; try { j = await r.json(); } catch { /* non-JSON body */ }
  return { status: r.status, j };
}
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const login = await call('POST', '/auth/login', { email: process.env.SEED_ADMIN_EMAIL, password: process.env.SEED_ADMIN_PASSWORD }, false);
ok(login.status < 300 && cookie, 'login ' + login.status + ' ' + JSON.stringify(login.j?.data ?? login.j).slice(0, 120));
const biz = await call('POST', '/businesses', { name: 'CandPw Co' });
const bizId = biz.j?.data?.id; ok(!!bizId, 'business ' + biz.status);
const tok = await call('POST', '/enrollment/tokens', { businessId: bizId });
const token = tok.j?.data?.token ?? tok.j?.data?.rawToken ?? tok.j?.token; ok(!!token, 'claim token ' + tok.status + ' ' + Object.keys(tok.j?.data ?? {}).join(','));
const rid = '9' + String(Date.now()).slice(-8);
const cl = await call('POST', '/enrollment/claim', { token, rustdeskId: rid, hostname: 'CANDPW', platform: 'Windows', password: 'OldPassword000000001', agentSecret: 'secretA'.padEnd(43, 'a') }, false);
const epId = cl.j?.data?.endpoint?.id ?? cl.j?.data?.endpointId ?? cl.j?.data?.id; ok(cl.status < 300 && epId, 'claim ' + cl.status + ' ' + epId);
const pw = async () => (await call('POST', `/endpoints/${epId}/connect`)).j?.data?.password;
ok(await pw() === 'OldPassword000000001', 'connect hands out the claimed password');
const secB = 'secretB'.padEnd(43, 'b');
// Installer re-run: Register heartbeat with the new secret + new password -> rejected.
const h1 = await call('POST', '/enrollment/heartbeat', { rustdeskId: rid, agentSecret: secB, password: 'NewPassword000000002' }, false);
ok(h1.status === 401, 'mismatched heartbeat rejected (' + h1.status + ')');
ok(await pw() === 'OldPassword000000001', 'rejected heartbeat does not change the live password');
// Registration check: same secret, no password -> must not erase the candidate password.
const h2 = await call('POST', '/enrollment/heartbeat', { rustdeskId: rid, agentSecret: secB }, false);
ok(h2.status === 401, 'password-less check also rejected (' + h2.status + ')');
const acc = await call('POST', `/endpoints/${epId}/accept-device-secret`);
ok(acc.status < 300 && acc.j?.data?.passwordUpdated === true, 'accept reports passwordUpdated ' + acc.status + ' ' + JSON.stringify(acc.j?.data ?? acc.j));
ok(await pw() === 'NewPassword000000002', 'connect now hands out the password the reinstall reported');
const h3 = await call('POST', '/enrollment/heartbeat', { rustdeskId: rid, agentSecret: secB }, false);
ok(h3.status < 300, 'accepted secret heartbeats (' + h3.status + ')');
// A different secret replaces the candidate and its password; a candidate without a password leaves the live one.
await call('POST', '/enrollment/heartbeat', { rustdeskId: rid, agentSecret: 'secretC'.padEnd(43, 'c'), password: 'Hijack00000000000003' }, false);
await call('POST', '/enrollment/heartbeat', { rustdeskId: rid, agentSecret: 'secretD'.padEnd(43, 'd') }, false);
const acc2 = await call('POST', `/endpoints/${epId}/accept-device-secret`);
ok(acc2.status === 409, 'conflicting candidates refused (' + acc2.status + ')');
ok(await pw() === 'NewPassword000000002', 'conflict leaves the live password alone');
// Leak check: no response field contains candidate ciphertext or names it.
const ep = await call('GET', `/endpoints/${epId}`); const inv = await call('GET', `/endpoints/${epId}/inventory`);
ok(!JSON.stringify([ep.j, inv.j]).includes('candidatePassword'), 'candidatePassword never returned');
console.log(fails ? `${fails} FAILED` : 'ALL PASSED'); process.exit(fails ? 1 : 0);
