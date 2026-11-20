#!/usr/bin/env node
// Managed Secure Access session grants (0.71), run against dist:
//
//   node apps/api/scripts/unit-msa-grants.mjs
//
// Pure: src/msa/grant.ts (the document, its canonical form, signing and the
// verifier) and src/msa/msa-grants-flag.ts (the switch). The cross-language
// fixture (tools/windows-installer/internal/msa/testdata/msa-grants.json) is
// rebuilt in memory and must equal the file; every case must give its
// expected result here, exactly as the Go tests assert it there.

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { buildFixture, FIXTURE_PATH } from './gen-msa-grant-fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const G = require(join(here, '..', 'dist', 'msa', 'grant.js'));
const F = require(join(here, '..', 'dist', 'msa', 'msa-grants-flag.js'));

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => { if (ok) passed++; else failures.push(`${name}${detail ? ` — ${detail}` : ''}`); };
const J = JSON.stringify;

// ── The switch ──────────────────────────────────────────────────────────────
check('MSA_GRANTS: on only when exactly "on"', F.msaGrantsEnabled({ MSA_GRANTS: 'on' }) === true
  && ['', 'On', 'ON', 'true', '1', 'yes', ' on', 'on '].every((v) => F.msaGrantsEnabled({ MSA_GRANTS: v }) === false)
  && F.msaGrantsEnabled({}) === false);

// ── The fixture: the file is what the module makes, and every case holds ────
const fx = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
check('the fixture on disk is exactly what grant.ts makes (regenerate with scripts/gen-msa-grant-fixture.mjs)', J(buildFixture()) === J(fx));
check('the fixture names the prefix and the reason list', fx.prefix === G.GRANT_PREFIX && J(fx.reasons) === J([...G.REASONS]));
const keys = new Map(Object.entries(fx.keys).map(([k, v]) => [k, Buffer.from(v, 'base64')]));
const seenExpect = new Set();
for (const c of fx.cases) {
  let env;
  try { env = JSON.parse(c.envelope); } catch { env = c.envelope; }
  const x = c.context;
  const r = G.verifyEnvelope(env, {
    keys, endpointId: x.endpointId, rustdeskId: x.rustdeskId, now: Date.parse(x.now), seen: new Set(x.seen), ceiling: x.ceiling, remotePaused: x.remotePaused,
  });
  const got = r.ok ? 'ok' : r.reason;
  seenExpect.add(c.expect);
  check(`fixture: ${c.name} → ${c.expect}`, got === c.expect, `got ${got}`);
}
check('every reason code has at least one fixture case, and so does ok', G.REASONS.every((x) => seenExpect.has(x)) && seenExpect.has('ok'),
  G.REASONS.filter((x) => !seenExpect.has(x)).join(', '));
check('the fixture has at least 60 cases', fx.cases.length >= 60, String(fx.cases.length));

// ── The Go verifier agrees on the prefix and the order of reasons ───────────
{
  const go = readFileSync(join(here, '..', '..', '..', 'tools', 'windows-installer', 'internal', 'msa', 'grant', 'grant.go'), 'utf8');
  const prefix = /const Prefix = "([^"]*)"/.exec(go)?.[1];
  check('the Go prefix is the same string', prefix === G.GRANT_PREFIX.replace('\n', '\\n'), String(prefix));
  const consts = Object.fromEntries([...go.matchAll(/^\t(\w+)\s+= "([a-z_]+)"$/gm)].map((m) => [m[1], m[2]]));
  const body = /var Reasons = \[\]string\{([^}]*)\}/.exec(go)?.[1] ?? '';
  const goReasons = [...body.matchAll(/\b([A-Z]\w+)\b/g)].map((m) => consts[m[1]]);
  check('the Go reason list is the same list in the same order', J(goReasons) === J([...G.REASONS]), J(goReasons));
}

// ── Signing, the canonical form, keys and passwords ─────────────────────────
{
  const k = G.newGrantKey();
  check('a new key: PKCS#8 PEM, a 32-byte public key, a 16-hex key id from its SHA-256',
    /^-----BEGIN PRIVATE KEY-----/.test(k.privatePem) && Buffer.from(k.publicKey, 'base64').length === 32 && G.KEY_ID_RE.test(k.keyId)
      && G.keyIdOf(Buffer.from(k.publicKey, 'base64')) === k.keyId);
  check('two keys differ', G.newGrantKey().keyId !== k.keyId);
  const now = Date.parse('2026-11-20T12:00:00Z');
  const g = {
    v: 1, grantId: G.newGrantId(), endpointId: 'cmtestendpoint000000000001', rustdeskId: '123456789', businessId: 'cmtestbusiness000000000001',
    technicianId: 'cmtesttechnician0000000001', mode: 'view', permissions: { clipboard: true, files: false, audio: false, tunnel: false, restart: false },
    consent: 'required', notBefore: G.isoSeconds(now), notAfter: G.isoSeconds(now + G.MAX_START_WINDOW_MS), maxMinutes: 60, idleMinutes: 15, password: G.newGrantPassword(),
  };
  const e = G.signGrant(g, k.privatePem, k.keyId);
  const ctx = { keys: new Map([[k.keyId, Buffer.from(k.publicKey, 'base64')]]), endpointId: g.endpointId, rustdeskId: g.rustdeskId, now: now + 1000, seen: new Set(), remotePaused: false,
    ceiling: { mode: 'view', permissions: { clipboard: true, files: false, audio: false, tunnel: false, restart: false } } };
  const v = G.verifyEnvelope(e, ctx);
  check('a fresh key signs a grant that verifies', v.ok && J(v.grant) === J(g));
  check('the canonical form has the fixed key order and no whitespace',
    Buffer.from(e.grant, 'base64').toString() === `{"v":1,"grantId":"${g.grantId}","endpointId":"${g.endpointId}","rustdeskId":"123456789","businessId":"${g.businessId}","technicianId":"${g.technicianId}","mode":"view","permissions":{"clipboard":true,"files":false,"audio":false,"tunnel":false,"restart":false},"consent":"required","notBefore":"2026-11-20T12:00:00Z","notAfter":"2026-11-20T12:05:00Z","maxMinutes":60,"idleMinutes":15,"password":"${g.password}"}`);
  const shuffled = { password: g.password, ...g };
  check('the canonical form does not depend on the object\'s key order', G.canonicalGrant(shuffled).equals(G.canonicalGrant(g)));
  const refuses = (over) => { try { G.signGrant({ ...g, ...over }, k.privatePem, k.keyId); return false; } catch { return true; } };
  check('signGrant refuses what the agent would refuse as malformed',
    refuses({ notAfter: G.isoSeconds(now + G.MAX_START_WINDOW_MS + 1000) }) && refuses({ notAfter: g.notBefore }) && refuses({ idleMinutes: 61 })
      && refuses({ maxMinutes: 481 }) && refuses({ password: 'short' }) && refuses({ mode: 'admin' }) && refuses({ extra: 1 }) && refuses({ v: 2 })
      && refuses({ notBefore: '2026-11-20T12:00:00.000Z' }));
  check('signGrant refuses a bad key id', (() => { try { G.signGrant(g, k.privatePem, 'XYZ'); return false; } catch { return true; } })());
  check('a verifier with no keys says unknown_key', G.verifyEnvelope(e, { ...ctx, keys: new Map() }).reason === 'unknown_key');
  const pws = Array.from({ length: 2000 }, () => G.newGrantPassword());
  check('passwords: 24 characters from the 62-letter alphabet, all different', pws.every((p) => G.PASSWORD_RE.test(p)) && new Set(pws).size === pws.length);
  const counts = new Map();
  for (const p of pws) for (const ch of p) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  const expect = (2000 * 24) / 62;
  check('passwords: every letter of the alphabet appears, none wildly over-represented', counts.size === 62 && [...counts.values()].every((n) => n > expect * 0.7 && n < expect * 1.3),
    J([...counts.entries()].sort((a, b) => a[1] - b[1]).slice(0, 3)));
  check('grant ids are 32 hex', Array.from({ length: 50 }, G.newGrantId).every((x) => G.GRANT_ID_RE.test(x)));
  check('isoSeconds drops milliseconds', G.isoSeconds(Date.parse('2026-11-20T12:00:00.999Z')) === '2026-11-20T12:00:00Z');
  check('the start window is five minutes, the skew 30 s, the limits 1–480 and 1–120',
    G.MAX_START_WINDOW_MS === 300_000 && G.CLOCK_SKEW_MS === 30_000 && G.MAX_MINUTES_MIN === 1 && G.MAX_MINUTES_MAX === 480 && G.IDLE_MINUTES_MIN === 1 && G.IDLE_MINUTES_MAX === 120);
}

if (failures.length) {
  console.error(`msa grants: ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`msa grants: ${passed} passed, 0 failed`);
