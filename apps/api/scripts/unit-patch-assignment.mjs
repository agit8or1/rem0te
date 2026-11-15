#!/usr/bin/env node
// Tests for company-wide and assignable patch policies (0.50), run against dist:
//
//   node apps/api/scripts/unit-patch-assignment.mjs
//
// The pure part (src/patching/assignment.ts): how the portal builds rings for
// a series (canary choice, rings of at most 25 in stable order, computers
// without a result key only in the last ring), the membership fingerprint,
// the bounded revision decision, and the override's closed values. Every
// document the ring builder produces is checked with the same
// validatePolicyDoc the approval signer runs. No database, no network.

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const dist = join(here, '..', 'dist');
const A = require(join(dist, 'patching', 'assignment.js'));
const P = require(join(dist, 'actions', 'patch-policy.js'));

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => { if (ok) passed++; else failures.push(`${name}${detail ? ` — ${detail}` : ''}`); };

const KEY = Buffer.alloc(32, 7).toString('base64');
const cand = (i, over = {}) => ({
  endpointId: `ep${String(i).padStart(6, '0')}x`, hostname: `PC-${i}`, createdAt: 1_700_000_000_000 + i * 1000,
  rustdeskId: String(100000000 + i), deviceSecretSha256: (i.toString(16).padStart(2, '0')).repeat(32).slice(0, 64),
  resultKey: KEY, canaryReady: true, reliability: 100, ...over,
});
const docOf = (plan, cs) => {
  const by = new Map(cs.map((c) => [c.endpointId, c]));
  const now = new Date();
  return {
    schema: P.POLICY_SCHEMA, policyId: 'a'.repeat(32), name: 'Company-wide', businessId: 'business01', businessName: 'B',
    rings: plan.rings.map((r) => r.map((id) => { const c = by.get(id); return { endpointId: id, hostname: c.hostname, rustdeskId: c.rustdeskId, deviceSecretSha256: c.deviceSecretSha256, ...(c.resultKey ? { resultKey: c.resultKey } : {}) }; })),
    allow: { classifications: ['0fa1201d-4330-4fa8-8ae9-b877473b6441'] }, soakHours: 0, failureThreshold: 0,
    window: { days: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'], start: '00:00', end: '23:59', timezone: 'UTC' }, reboot: 'never',
    createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 30 * 86_400_000).toISOString(), createdBy: { userId: 'user000001', name: 'U' }, reason: 'unit',
  };
};

// ── Rings ───────────────────────────────────────────────────────────────────
{
  const one = A.planRings([cand(1, { resultKey: null })]);
  check('one computer alone: it is the canary, and needs no result key', one.ok && one.rings.length === 1 && one.rings[0][0] === cand(1).endpointId, JSON.stringify(one));
  const cs = Array.from({ length: 30 }, (_, i) => cand(i + 1, { reliability: i === 7 ? 168 : 50 }));
  const p = A.planRings(cs);
  check('31 → canary + rings: the canary is the computer that checks in most reliably', p.ok && p.canary.endpointId === cs[7].endpointId && /most reliably \(168/.test(p.canary.why), JSON.stringify(p.canary));
  check('29 after the canary: two even rings, each at most 25', p.ok && p.rings.length === 3 && p.rings.slice(1).every((r) => r.length <= 25) && p.rings.flat().length === 30 && Math.abs(p.rings[1].length - p.rings[2].length) <= 1, JSON.stringify(p.rings?.map((r) => r.length)));
  check('stable order: oldest enrolment first', p.ok && p.rings[1][0] === cs[0].endpointId, p.rings?.[1]?.[0]);
  const shuffled = A.planRings([...cs].reverse());
  check('the order of the input does not change the rings', JSON.stringify(shuffled.rings) === JSON.stringify(p.rings));
  const v = P.validatePolicyDoc(P.PolicyDoc.parse(docOf(p, cs)), new Date());
  check('the document it builds passes the signer\'s own validatePolicyDoc', v.ok, JSON.stringify(v));
  const pref = A.planRings(cs, { preferredCanary: cs[3].endpointId });
  check('a chosen canary is used while eligible', pref.ok && pref.canary.endpointId === cs[3].endpointId && /chosen/.test(pref.canary.why));
  const prev = A.planRings(cs, { previousCanary: cs[5].endpointId });
  check('otherwise the previous revision\'s canary is kept', prev.ok && prev.canary.endpointId === cs[5].endpointId);
  const notReady = A.planRings(cs.map((c, i) => (i === 3 ? { ...c, canaryReady: false } : c)), { preferredCanary: cs[3].endpointId });
  check('a chosen canary that is not ready is passed over, never forced', notReady.ok && notReady.canary.endpointId !== cs[3].endpointId);
  const mixed = [cand(1), cand(2, { resultKey: null }), cand(3), cand(4, { resultKey: null }), ...Array.from({ length: 40 }, (_, i) => cand(10 + i))];
  const m = A.planRings(mixed);
  const last = m.rings[m.rings.length - 1];
  check('computers without a result key go only in the last ring (§38)', m.ok && last.includes(cand(2).endpointId) && last.includes(cand(4).endpointId) && !m.rings.slice(0, -1).flat().some((id) => [cand(2).endpointId, cand(4).endpointId].includes(id)), JSON.stringify(m.rings.map((r) => r.length)));
  check('…and the document still validates', P.validatePolicyDoc(P.PolicyDoc.parse(docOf(m, mixed)), new Date()).ok);
  check('…and they are reported as last-ring-only', m.lastRingOnly.length === 2);
  const keyless = [cand(1, { resultKey: null }), cand(2, { resultKey: null })];
  const k = A.planRings(keyless);
  check('no computer with a result key and more than one computer: no canary, refused with why', !k.ok && k.code === 'no_canary', JSON.stringify(k));
  const big = Array.from({ length: 120 }, (_, i) => cand(i + 1));
  const b = A.planRings(big);
  check('more than 101: the rest are left out, policy_full, never a sixth ring', b.ok && b.rings.length === 5 && b.rings.flat().length === A.MAX_POLICY_COMPUTERS && b.leftOut.length === 19 && b.leftOut.every((x) => x.code === 'policy_full'), JSON.stringify({ r: b.rings?.length, n: b.rings?.flat().length, l: b.leftOut?.length }));
  check('…the left-out are the newest', b.leftOut[0].endpointId === big[101].endpointId);
  check('…and the full document validates', P.validatePolicyDoc(P.PolicyDoc.parse(docOf(b, big)), new Date()).ok);
  const manyKeyless = [cand(1), ...Array.from({ length: 30 }, (_, i) => cand(100 + i, { resultKey: null }))];
  const mk = A.planRings(manyKeyless);
  check('more keyless computers than the last ring holds: the excess are left out, no_result_key', mk.ok && mk.leftOut.filter((x) => x.code === 'no_result_key').length === 5 && mk.rings[mk.rings.length - 1].length === 25);
  for (const n of [1, 2, 24, 25, 26, 49, 50, 51, 75, 76, 99, 100]) {
    const r = A.laterRings(Array.from({ length: n }, (_, i) => `k${i}`), []);
    check(`laterRings(${n}): every ring 1–25, all placed`, r.rings.every((x) => x.length >= 1 && x.length <= 25) && r.rings.flat().length === n && r.rings.length === Math.ceil(n / 25), JSON.stringify(r.rings.map((x) => x.length)));
  }
  check('nobody: refused, no_computers', A.planRings([]).code === 'no_computers');
}

// ── Fingerprint ─────────────────────────────────────────────────────────────
{
  const c = (id, k) => ({ endpointId: id, rustdeskId: '123456789', deviceSecretSha256: 'a'.repeat(64), resultKey: k });
  const f1 = A.membershipFingerprint([[c('a1234567', KEY)], [c('b1234567', KEY)]]);
  check('same rings, same fingerprint', f1 === A.membershipFingerprint([[c('a1234567', KEY)], [c('b1234567', KEY)]]));
  check('another computer changes it', f1 !== A.membershipFingerprint([[c('a1234567', KEY)], [c('b1234567', KEY), c('c1234567', KEY)]]));
  check('another ring placement changes it', f1 !== A.membershipFingerprint([[c('a1234567', KEY), c('b1234567', KEY)]]));
  check('a new result key (agent state reset) changes it', f1 !== A.membershipFingerprint([[c('a1234567', KEY)], [c('b1234567', Buffer.alloc(32, 9).toString('base64'))]]));
}

// ── The bounded revision decision ───────────────────────────────────────────
{
  const now = new Date('2026-11-14T12:00:00Z');
  const later = (min) => new Date(now.getTime() + min * 60_000);
  const base = { now, desired: { fingerprint: 'B' }, current: { fingerprint: 'A', expiresAt: later(30 * 1440), status: 'ACTIVE' }, pending: null, rejected: null, settle: { fingerprint: null, since: null }, lastClaimAt: null, midRing: false, expiresInDays: 30 };
  const d = (o, m = 60, s = 10) => A.revisionDecision({ ...base, ...o }, m, s);
  check('up to date: nothing', d({ desired: { fingerprint: 'A' } }).act === 'none');
  const first = d({});
  check('a change first settles (debounce), and records since when', first.act === 'hold' && first.code === 'settling' && first.settle?.fingerprint === 'B');
  check('still settling before the settle time', d({ settle: { fingerprint: 'B', since: later(-5) } }).code === 'settling');
  check('a different change restarts the settle', d({ settle: { fingerprint: 'C', since: later(-50) } }).settle?.fingerprint === 'B');
  check('settled: proposed', d({ settle: { fingerprint: 'B', since: later(-11) } }).act === 'propose');
  check('rate-limited: at most one revision pass per business per N minutes', d({ settle: { fingerprint: 'B', since: later(-11) }, lastClaimAt: later(-30) }).code === 'rate_limited');
  check('…and allowed again after N minutes', d({ settle: { fingerprint: 'B', since: later(-11) }, lastClaimAt: later(-61) }).act === 'propose');
  check('never while the running revision is mid-ring', d({ settle: { fingerprint: 'B', since: later(-11) }, midRing: true }).code === 'mid_ring');
  check('a pending revision with the same computers: wait for it', d({ pending: { fingerprint: 'B', status: 'AWAITING_APPROVAL', revision: 2 } }).code === 'awaiting_approval');
  check('…or for it to take over', d({ pending: { fingerprint: 'B', status: 'ACTIVE', revision: 2 } }).code === 'waiting_to_take_over');
  check('a stale pending revision, the running one already right: dropped', d({ desired: { fingerprint: 'A' }, pending: { fingerprint: 'B', status: 'AWAITING_APPROVAL', revision: 2 } }).act === 'drop_pending');
  check('rejected with these exact computers: not proposed again', d({ settle: { fingerprint: 'B', since: later(-11) }, rejected: 'B' }).code === 'rejected');
  const renew = d({ desired: { fingerprint: 'A' }, current: { ...base.current, fingerprint: 'A', expiresAt: later(3 * 1440) } });
  check('renewal: due within the lead time, proposed without settling', renew.act === 'propose' && renew.trigger === 'renewal');
  check('renewal still waits for the business bound', d({ desired: { fingerprint: 'A' }, current: { ...base.current, fingerprint: 'A', expiresAt: later(3 * 1440) }, lastClaimAt: later(-1) }).code === 'rate_limited');
  check('renewal still waits for a deployment to finish', d({ desired: { fingerprint: 'A' }, current: { ...base.current, fingerprint: 'A', expiresAt: later(3 * 1440) }, midRing: true }).code === 'mid_ring');
  check('expired: proposed again (restart)', d({ current: { ...base.current, expiresAt: later(-1) } }).trigger === 'restart');
  check('nobody left, a revision running: withdrawn', d({ desired: null }).act === 'withdraw');
  check('nobody left, mid-ring: held until it finishes', d({ desired: null, midRing: true }).code === 'mid_ring');
  check('nobody and nothing running: held', d({ desired: null, current: null }).code === 'no_computers');
  check('renewal lead: seven days for a 30-day policy, a third of a short one', A.renewLeadMs(30) === 7 * 86_400_000 && A.renewLeadMs(3) === 86_400_000);
}

// ── The override and the settings ───────────────────────────────────────────
{
  check('override: inherit', A.OverrideDto.safeParse({ mode: 'inherit' }).success);
  check('override: exclude', A.OverrideDto.safeParse({ mode: 'exclude' }).success);
  check('override: a policy needs its id', !A.OverrideDto.safeParse({ mode: 'policy' }).success && A.OverrideDto.safeParse({ mode: 'policy', seriesId: 'clxyz12345' }).success);
  check('override: nothing else', !A.OverrideDto.safeParse({ mode: 'all' }).success && !A.OverrideDto.safeParse({ mode: 'exclude', seriesId: 'clxyz12345' }).success);
  const s = { allow: { classifications: ['0fa1201d-4330-4fa8-8ae9-b877473b6441'] }, window: { days: ['sat'], start: '22:00', end: '04:00', timezone: 'UTC' }, reason: 'company-wide' };
  const ok = A.SeriesSettings.safeParse(s);
  check('settings default to never restarting, 30 days, no failures allowed', ok.success && ok.data.reboot === 'never' && ok.data.expiresInDays === 30 && ok.data.failureThreshold === 0);
  check('settings: at most 90 days', !A.SeriesSettings.safeParse({ ...s, expiresInDays: 91 }).success);
  check('settings: the restart rule is the closed pair', !A.SeriesSettings.safeParse({ ...s, reboot: 'always' }).success);
  check('settings: nothing unknown', !A.SeriesSettings.safeParse({ ...s, rings: [] }).success);
  // 0.53: a company-wide or assignable policy may be monthly; each revision carries the window as given.
  const pt = { kind: 'monthly', week: 'second', weekday: 'tue', offsetDays: 3, start: '22:00', end: '04:00', timezone: 'America/Chicago' };
  const m = A.SeriesSettings.safeParse({ ...s, window: pt });
  check('settings: a monthly window (Patch Tuesday + 3) is accepted and kept exactly', m.success && JSON.stringify(m.data.window) === JSON.stringify(pt));
  check('settings: a day-of-month window is accepted, 1–28 only', A.SeriesSettings.safeParse({ ...s, window: { kind: 'monthly', day: 28, start: '01:00', end: '03:00', timezone: 'UTC' } }).success
    && !A.SeriesSettings.safeParse({ ...s, window: { kind: 'monthly', day: 29, start: '01:00', end: '03:00', timezone: 'UTC' } }).success);
  check('settings: an unknown window kind is refused', !A.SeriesSettings.safeParse({ ...s, window: { ...pt, kind: 'yearly' } }).success && !A.SeriesSettings.safeParse({ ...s, window: { ...s.window, kind: 'weekly' } }).success);
}

if (failures.length) {
  console.error(`✗ ${failures.length} of ${passed + failures.length} failed:`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`✓ unit-patch-assignment: ${passed} checks`);
