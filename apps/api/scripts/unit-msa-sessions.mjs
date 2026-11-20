#!/usr/bin/env node
// Managed Secure Access build step 5 (0.73), run against dist:
//
//   node apps/api/scripts/unit-msa-sessions.mjs
//
// The signed revocation (src/msa/revocation.ts) against the shared fixture
// the Go verifier also asserts (internal/msa/grant), the Connect grant terms
// (connect-terms.ts) over every combination of policy facts, and the session
// timeline (session-timeline.ts): Launched is never Connected.

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { buildRevocationFixture, REVOCATION_FIXTURE_PATH } from './gen-msa-grant-fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..', '..');
const require = createRequire(import.meta.url);
const dist = (f) => require(join(here, '..', 'dist', 'msa', f));
const R = dist('revocation.js');
const T = dist('connect-terms.js');
const TL = dist('session-timeline.js');
const M = dist('managed.js');

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => { if (ok) passed++; else failures.push(`${name}${detail ? ` — ${detail}` : ''}`); };
const J = JSON.stringify;
const go = (f) => readFileSync(join(ROOT, 'tools', 'windows-installer', f), 'utf8');

// ── The revocation: one prefix, one reason list, one fixture ────────────────
{
  const rv = go('internal/msa/grant/revocation.go');
  check('the revocation prefix is its own, the same on both sides', R.REVOCATION_PREFIX === 'rem0te-msa-revoke-v1\n'
    && rv.includes('const RevocationPrefix = "rem0te-msa-revoke-v1\\n"'));
  // The Go side compares its RevocationReasons with the fixture's, in order
  // (revocation_test.go); this compares the fixture's with the portal's.
  const fxReasons = JSON.parse(readFileSync(REVOCATION_FIXTURE_PATH, 'utf8')).reasons;
  check('the reasons are the same, in check order', J(fxReasons) === J(R.REVOCATION_REASONS) && /f\.Reasons\[i\]/.test(go('internal/msa/grant/revocation_test.go')), J(fxReasons));
  check('at most 20 grants and 9 hours on both sides', R.REVOCATION_MAX_GRANTS === 20 && R.REVOCATION_WINDOW_MS === 9 * 3_600_000
    && /RevocationMaxGrants\s*=\s*20/.test(rv) && /9 \* time\.Hour/.test(rv));
  const fx = JSON.parse(readFileSync(REVOCATION_FIXTURE_PATH, 'utf8'));
  check('the fixture on disk is exactly what revocation.ts makes (regenerate with scripts/gen-msa-grant-fixture.mjs)', J(buildRevocationFixture()) === J(fx));
  const keys = new Map(Object.entries(fx.keys).map(([k, v]) => [k, Buffer.from(v, 'base64')]));
  const reasons = new Set();
  for (const c of fx.cases) {
    const ctx = { keys, endpointId: c.context.endpointId, rustdeskId: c.context.rustdeskId, now: Date.parse(c.context.now), seen: new Set(c.context.seen) };
    let raw; try { raw = JSON.parse(c.envelope); } catch { raw = c.envelope; }
    const v = R.verifyRevocation(raw, ctx);
    const got = v.ok ? 'ok' : v.reason;
    check(`fixture: ${c.name} → ${c.expect}`, got === c.expect, got);
    if (!v.ok) reasons.add(v.reason);
    if (v.ok && c.ends) {
      const ends = fx.sessions.map((s) => R.revocationEnds(v.revocation, s));
      check(`fixture: ${c.name} ends exactly ${J(c.ends)}`, J(ends) === J(c.ends), J(ends));
    }
  }
  check('every reason is exercised by the fixture', R.REVOCATION_REASONS.every((x) => reasons.has(x)), J([...reasons]));
  // `all` ends only grants that started before it was issued.
  const r = { all: true, grantIds: [], issuedAt: '2026-11-20T12:10:00Z' };
  check('`all` ends a grant issued before it', R.revocationEnds(r, { grantId: 'a'.repeat(32), notBefore: '2026-11-20T12:00:00Z' }));
  check('`all` never ends a grant issued after it', !R.revocationEnds(r, { grantId: 'a'.repeat(32), notBefore: '2026-11-20T12:10:01Z' }));
  check('a named revocation ends only what it names', !R.revocationEnds({ all: false, grantIds: ['b'.repeat(32)], issuedAt: r.issuedAt }, { grantId: 'a'.repeat(32), notBefore: '2026-11-20T12:00:00Z' }));
  check('shape: neither all nor a grant is refused', !R.shapeOk({ all: false, grantIds: [] }) && R.shapeOk({ all: true, grantIds: [] }) && !R.shapeOk({ all: false, grantIds: Array(21).fill('a'.repeat(32)) }));
}

// ── Connect terms: every combination of policy facts stays under the ceiling ─
{
  let n = 0, above = 0;
  const bad = [];
  for (const mode of T.MANAGED_LAUNCH_MODES) for (const path of ['member', 'legacy_assignment', 'preset'])
  for (const consent of ['required', 'not_required']) for (const clip of ['off', 'request']) for (const files of ['off', 'request'])
  for (const pc of [true, false]) for (const pf of [true, false]) for (const lim of [null, 0, 1, 30, 60, 480, 10_000]) for (const ctlMax of [5, 120, 480]) {
    n++;
    const t = T.managedGrantTerms({ mode, path, maxSessionMinutes: lim, controls: { attendedConsent: consent, clipboard: clip, fileTransfer: files, maxSessionMinutes: ctlMax }, presetClipboard: pc, presetFiles: pf });
    if (!M.withinCeiling(t.mode, t.permissions) || t.permissions.tunnel || t.permissions.restart) above++;
    const preset = path === 'preset';
    const want = {
      mode: mode === 'view_only' ? 'view' : 'control',
      clipboard: mode !== 'view_only' && clip === 'request' && (!preset || pc),
      files: mode !== 'view_only' && files === 'request' && (!preset || pf),
      audio: mode !== 'view_only',
      consent: preset && consent === 'required' ? 'required' : 'not_required',
      max: Math.max(1, Math.min(480, lim ?? ctlMax)),
    };
    if (t.mode !== want.mode || t.permissions.clipboard !== want.clipboard || t.permissions.files !== want.files || t.permissions.audio !== want.audio
      || t.consent !== want.consent || t.maxMinutes !== want.max || t.idleMinutes !== Math.min(15, want.max)) bad.push(J({ mode, path, consent, clip, files, pc, pf, lim, ctlMax, t }));
  }
  check(`connect terms: ${n} combinations, none above the ceiling, never a tunnel or a restart`, above === 0, String(above));
  check('connect terms: each one exactly the documented rule', bad.length === 0, bad.slice(0, 3).join('\n'));
  check('view-only is view with nothing beyond', J(T.managedGrantTerms({ mode: 'view_only', path: 'member', maxSessionMinutes: null, controls: { attendedConsent: 'not_required', clipboard: 'request', fileTransfer: 'request', maxSessionMinutes: 60 }, presetClipboard: true, presetFiles: true }).permissions)
    === J({ clipboard: false, files: false, audio: false, tunnel: false, restart: false }));
}

// ── The timeline: Launched is never Connected ───────────────────────────────
{
  const t0 = new Date('2026-11-20T12:00:00Z');
  const at = (s) => new Date(t0.getTime() + s * 1000);
  const base = { state: 'issued', source: 'connect', createdAt: t0, receivedAt: null, deliveredAt: null, appliedAt: null, launchedAt: null, revealedAt: null, connectedAt: null,
    endedAt: null, revokedAt: null, revokeReason: null, outcome: null, notAfter: at(600), maxMinutes: 60 };
  const now = at(30).getTime();
  const steps = (x) => x.steps.map((s) => s.step).join();
  let x = TL.sessionTimeline(base, now);
  check('issued: requested, authorized; live', steps(x) === 'requested,authorized' && x.current === 'authorized' && x.live === true, J(x));
  check('every timeline says what the agent cannot see', x.cannotSee.length === 3 && x.cannotSee.some((l) => /consent/.test(l)));
  x = TL.sessionTimeline({ ...base, state: 'applied', deliveredAt: at(2), receivedAt: at(2), appliedAt: at(5), launchedAt: at(10), revealedAt: at(10) }, now);
  check('launched, no connection: current is launched, no connected step', x.current === 'launched' && !steps(x).includes('connected') && /no connection seen yet/.test(x.status), J(x));
  x = TL.sessionTimeline({ ...base, state: 'applied', deliveredAt: at(2), receivedAt: at(2), appliedAt: at(5), launchedAt: at(10), revealedAt: at(10), connectedAt: at(20) }, now);
  check('connected only when the agent saw it', x.current === 'connected' && /as the agent saw it/.test(x.status));
  x = TL.sessionTimeline({ ...base, state: 'revoked', deliveredAt: at(2), appliedAt: at(5), revokedAt: at(25), revokeReason: 'technician' }, now);
  check('revoked, not yet ended: says so, and that offline it ends at the limit', x.current === 'revoked' && x.live === false && /offline/.test(x.status), J(x));
  x = TL.sessionTimeline({ ...base, state: 'revoked', revokedAt: at(25), revokeReason: 'timeout' }, now);
  check('revoked before applied (the timeout)', /before it was applied/.test(x.status) && !steps(x).includes('applied'));
  x = TL.sessionTimeline({ ...base, state: 'ended', deliveredAt: at(2), appliedAt: at(5), endedAt: at(3600), outcome: 'max_minutes' }, now);
  check('the session limit is Expired', x.current === 'expired' && /session limit/.test(x.status));
  x = TL.sessionTimeline({ ...base, state: 'ended', deliveredAt: at(2), appliedAt: at(5), connectedAt: at(20), endedAt: at(900), outcome: 'disconnected' }, now);
  check('disconnected', x.current === 'disconnected' && x.live === false);
  x = TL.sessionTimeline({ ...base, state: 'failed', deliveredAt: at(2), endedAt: at(5), outcome: 'readback_mismatch' }, now);
  check('failed names the outcome', x.current === 'failed' && /readback_mismatch/.test(x.status));
  x = TL.sessionTimeline({ ...base, state: 'expired', notAfter: at(600) }, at(700).getTime());
  check('never delivered: expired', x.current === 'expired' && x.live === false);
  x = TL.sessionTimeline({ ...base, state: 'applied', deliveredAt: at(2), appliedAt: at(5), maxMinutes: 1 }, at(120).getTime());
  check('applied past its session limit is not live', x.live === false);
  check('the steps are the documented ones', J(TL.TIMELINE_STEPS) === J(['requested', 'authorized', 'received', 'applied', 'launched', 'connected', 'disconnected', 'expired', 'revoked', 'failed']));
}

// ── The closed lists the portal and the agent share ────────────────────────
{
  const enf = go('internal/msa/enforce/enforce.go');
  check('the agent knows the revoked and paused outcomes', /"revoked"/.test(enf) && /"paused"/.test(enf) && M.AGENT_OUTCOMES.includes('revoked') && M.AGENT_OUTCOMES.includes('paused'));
  const poller = go('internal/msa/enforce/poller.go');
  check('the agent reports received', /"received"/.test(poller) && M.REPORT_EVENTS[0] === 'received');
  check('the Connect wait is 60 s, polling fresh within 90 s', M.CONNECT_APPLY_TIMEOUT_MS === 60_000 && M.POLLING_FRESH_MS === 90_000);
  check('the session agent is 0.73.0', M.MIN_SESSION_AGENT === '0.73.0');
}

console.log(`unit-msa-sessions: ${passed} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.error(`  ✗ ${f}`); process.exit(1); }
