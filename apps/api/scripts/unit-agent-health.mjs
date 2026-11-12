#!/usr/bin/env node
// Tests for 0.36 agent health, run against dist:
//
//   node apps/api/scripts/unit-agent-health.mjs
//
// Pure functions only:
//   - the AGENT_SILENT monitor (monitoring/engine.ts): its parameters and
//     bounds, that it is recommended but off unless created, when it raises,
//     holds and clears, and what its alert says;
//   - re-resolving a queued automatic client update (client-updates/
//     policy.ts, reconcileQueued): keep, adopt, re-plan or withdraw, and why;
//   - the heartbeat's snapshot-schedule quiet window (diagnostics-catalog/
//     snapshot-schedule.ts, quietUntil), which lets a heartbeat with nothing
//     due skip the scheduler's three queries.

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const m = require(join(here, '..', 'dist', 'monitoring', 'engine.js'));
const P = require(join(here, '..', 'dist', 'client-updates', 'policy.js'));
const C = require(join(here, '..', 'dist', 'common', 'connectivity.js'));
const SS = require(join(here, '..', 'dist', 'diagnostics-catalog', 'snapshot-schedule.js'));

let pass = 0, fail = 0;
const failures = [];
const check = (ok, name, detail = '') => { if (ok) pass++; else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`); } };
const section = (s) => console.log(`\n── ${s}`);
const T0 = new Date(Date.UTC(2026, 10, 12, 12, 0, 0));
const ago = (min) => new Date(T0.getTime() - min * 60_000);
const rule = (params = {}) => ({ id: 'r-agent-silent', scopeKey: 'global', key: 'agent-silent', kind: 'AGENT_SILENT', enabled: true, severity: 'WARNING', name: 'Agent silent', params });
const live = (o) => ({ name: 'DESKTOP-4SADDCN', isOnline: true, lastSeenAt: ago(90), cpuLoadPercent: null, memoryTotalMb: null, memoryFreeMb: null, systemDiskTotalMb: null, systemDiskFreeMb: null, liveSampledAt: null, rebootRequired: null, updatesCheckedAt: null, ...o });
const ev = (params, l, st = m.EMPTY_STATE) => m.evaluateLive(rule(params), live(l), st, T0, false);

section('Parameters and bounds');
check(m.MONITOR_KINDS.includes('AGENT_SILENT'), 'AGENT_SILENT is a monitor kind');
let p = m.parseParams('AGENT_SILENT', {});
check(p.ok && p.params.minutes === 60, 'defaults to 60 minutes', JSON.stringify(p));
check(m.AGENT_SILENT_BOUNDS.min === C.HEARTBEAT_STALE_MS / 60_000 && m.AGENT_SILENT_BOUNDS.min === 30, 'the floor is the console’s agent-silent window (30 min)');
check(!m.parseParams('AGENT_SILENT', { minutes: 29 }).ok, '29 minutes is refused: the computer would still show Online');
check(m.parseParams('AGENT_SILENT', { minutes: 30 }).ok, '30 minutes is accepted');
check(m.parseParams('AGENT_SILENT', { minutes: 10080 }).ok && !m.parseParams('AGENT_SILENT', { minutes: 10081 }).ok, 'the ceiling is 7 days (10,080 minutes)');
check(!m.parseParams('AGENT_SILENT', { minutes: 60.5 }).ok && !m.parseParams('AGENT_SILENT', { minutes: '60' }).ok, 'minutes must be a whole number');
check(!m.parseParams('AGENT_SILENT', { minutes: 60, notify: 'x' }).ok, 'unknown params are refused (strict)');

section('Recommended, but off until someone adds it (0.36.1)');
const rec = m.RECOMMENDED.filter((r) => r.kind === 'AGENT_SILENT');
check(rec.length === 1 && rec[0].key === 'agent-silent' && rec[0].severity === 'WARNING' && rec[0].params.minutes === m.AGENT_SILENT_BOUNDS.def && m.parseParams('AGENT_SILENT', rec[0].params).ok,
  'one RECOMMENDED starter: key agent-silent, WARNING, AGENT_SILENT_BOUNDS.def (60) minutes', JSON.stringify(rec));
check(m.RECOMMENDED.length === 7 && new Set(m.RECOMMENDED.map((r) => r.key)).size === 7, 'the recommended set is seven monitors with distinct keys', m.RECOMMENDED.map((r) => r.key).join(','));
check(!('OPTIONAL' in m), 'the separate OPTIONAL list is gone');
check(m.effectiveRules([], m.scopesFor({ id: 'e1', customerId: 'b1', siteId: null })).length === 0, 'no rule anywhere: nothing applies (off unless enabled)');
const g = rule({ minutes: 60 });
const off = { ...g, id: 'r2', scopeKey: 'b:b1', enabled: false };
check(m.effectiveRules([g, off], m.scopesFor({ id: 'e1', customerId: 'b1', siteId: null })).length === 0, 'a global agent-silent monitor switched off for a business does not apply there');
const grp = { ...g, id: 'r3', scopeKey: 'g:grp1', enabled: true, params: { minutes: 240 }, priority: 1 };
let eff = m.effectiveRules([off, grp], m.scopesFor({ id: 'e1', customerId: 'b1', siteId: null }, ['grp1']));
check(eff.length === 1 && eff[0].id === 'r3', 'a device-group monitor beats the business’s off switch for its members (0.35 precedence)');
eff = m.effectiveRules([off, grp], m.scopesFor({ id: 'e2', customerId: 'b1', siteId: null }, []));
check(eff.length === 0, '…and not for a computer outside the group');

section('Raise, hold, clear');
let v = ev({ minutes: 60 }, { lastSeenAt: ago(90) });
check(v.verdict === 'breach', 'reachable, agent silent 90 min, threshold 60: raised', v.verdict);
check(v.verdict === 'breach' && v.state.breachSince.getTime() === T0.getTime(), 'breachSince is when it was first seen breaching');
v = ev({ minutes: 60 }, { lastSeenAt: ago(59) });
check(v.verdict === 'ok' && v.clear === true, 'silent 59 min: not breaching, and it clears');
v = ev({ minutes: 60 }, { lastSeenAt: ago(60) });
check(v.verdict === 'breach', 'exactly at the threshold: raised');
v = ev({ minutes: 60 }, { lastSeenAt: ago(90), isOnline: false });
check(v.verdict === 'pending', 'silent and no longer reachable: held — the Offline monitor’s case; not raised, not cleared', v.verdict);
v = ev({ minutes: 60 }, { lastSeenAt: ago(1), isOnline: false });
check(v.verdict === 'ok' && v.clear === true, 'the agent checked in (even while hbbs says unreachable): clears');
v = ev({ minutes: 60 }, { lastSeenAt: null });
check(v.verdict === 'skip', 'an agent that never checked in: not this monitor’s case (skip)', v.verdict);
v = ev({ minutes: 60 }, { lastSeenAt: ago(17_280) }); // 12 days
check(v.verdict === 'breach' && /agent silent for 12 d/.test(v.title), 'twelve days: the title says “12 d”', v.title);
const prior = { breachCount: 1, okCount: 0, breachSince: ago(30), lastMatchAt: null };
v = ev({ minutes: 60 }, { lastSeenAt: ago(120) }, prior);
check(v.verdict === 'breach' && v.state.breachSince.getTime() === ago(30).getTime(), 'a breach that was already open keeps its breachSince (no state write per tick)');
v = m.evaluateLive(rule({ minutes: 5 }), live({}), m.EMPTY_STATE, T0, false);
check(v.verdict === 'skip' && /invalid params/.test(v.reason), 'stored params under the floor are not evaluated');

section('What the alert says');
v = ev({ minutes: 60 }, { lastSeenAt: ago(90) });
check(/remote control should still work/i.test(v.title), 'the title says remote control should still work', v.title);
check(/Update agent/.test(v.detail.whatToDo) && /re-run the installer/.test(v.detail.whatToDo), 'the detail suggests Update agent or re-running the installer', v.detail.whatToDo);
check(v.detail.lastHeartbeatAt === ago(90).toISOString() && v.detail.silentMinutes === 90 && v.detail.thresholdMinutes === 60, 'the detail carries the last heartbeat, minutes silent and the threshold');
check(m.silentFor(45) === '40 min' && m.silentFor(59) === '50 min' && m.silentFor(60) === '1 h' && m.silentFor(119) === '1 h' && m.silentFor(47 * 60) === '47 h' && m.silentFor(48 * 60) === '2 d', 'silentFor: tens of minutes under 1 h, hours under 2 d, then days');
check(m.agentSilentTitle('PC', 90) === m.agentSilentTitle('PC', 110) && m.agentSilentTitle('PC', 90) !== m.agentSilentTitle('PC', 130), 'the title changes only when the coarse figure changes (so the sweep rewrites it rarely)');

section('Re-resolving a queued automatic client update');
const pol = (id, enabled = true) => ({ id, enabled });
const A = pol('pA'), B = pol('pB'), Aoff = pol('pA', false);
let d = P.reconcileQueued('pA', A, [A, B]);
check(d.action === 'keep' && d.reason === null, 'the queuing policy still governs it, enabled: keep', JSON.stringify(d));
d = P.reconcileQueued('pG', B, [pol('pG'), B]);
check(d.action === 'replan' && d.reason === 'no_longer_applies' && d.from === 'pG' && d.to === 'pB', 'left the group; the business policy is on: re-planned under it', JSON.stringify(d));
d = P.reconcileQueued('pG', Aoff, [pol('pG'), Aoff]);
check(d.action === 'withdraw' && d.reason === 'no_longer_applies' && d.to === null, 'left the group; the business policy is off: withdrawn (the 0.35 report)', JSON.stringify(d));
d = P.reconcileQueued('pG', null, [pol('pG')]);
check(d.action === 'withdraw' && d.reason === 'no_longer_applies', 'left the group; no other policy: withdrawn', JSON.stringify(d));
d = P.reconcileQueued('pA', Aoff, [Aoff]);
check(d.action === 'withdraw' && d.reason === 'policy_off', 'its own policy switched off: withdrawn, policy_off', JSON.stringify(d));
d = P.reconcileQueued('pGone', null, []);
check(d.action === 'withdraw' && d.reason === 'policy_removed', 'its policy deleted, nothing else: withdrawn, policy_removed', JSON.stringify(d));
d = P.reconcileQueued('pGone', B, [B]);
check(d.action === 'replan' && d.reason === 'policy_removed' && d.to === 'pB', 'its policy deleted, another on: re-planned, policy_removed', JSON.stringify(d));
d = P.reconcileQueued(null, A, [A]);
check(d.action === 'adopt' && d.reason === 'no_policy_recorded' && d.to === 'pA', 'queued before 0.36 (no policy recorded), a policy on: adopted', JSON.stringify(d));
d = P.reconcileQueued(null, null, []);
check(d.action === 'withdraw' && d.reason === 'no_policy_recorded', 'queued before 0.36 and nothing governs it: withdrawn', JSON.stringify(d));
check(Object.keys(P.QUEUED_REASON_TEXT).sort().join() === 'no_longer_applies,no_policy_recorded,policy_off,policy_removed', 'every reason has text');

// With the real resolver: a group policy wins; once the computer leaves the group, the business one does.
const biz = { id: 'pBiz', customerId: 'c1', siteId: null, groupId: null, priority: null, enabled: false, timeZone: 'UTC', windows: [], skipActiveSession: true, skipLoggedOnUser: false };
const grpP = { ...biz, id: 'pGrp', groupId: 'g1', priority: 1, enabled: true };
let effP = P.effectivePolicy([biz, grpP], 'c1', null, ['g1']);
check(effP?.id === 'pGrp', 'in the group: the group policy governs');
check(P.reconcileQueued('pGrp', effP, [biz, grpP]).action === 'keep', '…and a request it queued is kept');
effP = P.effectivePolicy([biz, grpP], 'c1', null, []);
d = P.reconcileQueued('pGrp', effP, [biz, grpP]);
check(effP?.id === 'pBiz' && d.action === 'withdraw' && d.reason === 'no_longer_applies', 'left the group, business policy off: the business policy governs and the request is withdrawn', JSON.stringify(d));
const bizOn = { ...biz, enabled: true };
d = P.reconcileQueued('pGrp', P.effectivePolicy([bizOn, grpP], 'c1', null, []), [bizOn, grpP]);
check(d.action === 'replan' && d.to === 'pBiz', 'left the group, business policy on: re-planned under the business policy', JSON.stringify(d));

section('Heartbeat cost: the snapshot scheduler’s quiet window');
{
  const now = T0.getTime();
  const H = 3_600_000;
  const sch = { ...SS.SCHEDULE_DEFAULTS };
  const hist = (agoMs, extra = {}) => ({ lastCompletedAt: new Date(now - agoMs), lastAutoRequestedAt: new Date(now - agoMs), lastAutoFailed: false, open: false, ...extra });
  const keys = ['process_list', 'service_list', 'network_adapters'];
  const H3 = Object.fromEntries(keys.map((k) => [k, hist(H)]));
  check(SS.QUIET_CAP_MS === H && SS.QUIET_MAX_ENTRIES === 50_000, 'capped at one hour; at most 50,000 entries');
  check(SS.quietUntil(sch, H3, now, SS.QUIET_CAP_MS) === now + H, 'every key taken 1 h ago (6 h interval): quiet for the cap, 1 h');
  const near = { ...H3, service_list: hist(6 * H - 10 * 60_000) };
  check(SS.quietUntil(sch, near, now, SS.QUIET_CAP_MS) === now + 10 * 60_000, 'one key due in 10 min: quiet only until then');
  const due = { ...H3, network_adapters: hist(7 * H) };
  check(SS.quietUntil(sch, due, now, SS.QUIET_CAP_MS) === null, 'a key already due: no quiet window');
  const open = { ...H3, process_list: hist(H, { open: true }) };
  check(SS.quietUntil(sch, open, now, SS.QUIET_CAP_MS) === null, 'a run still open: no quiet window (its outcome changes the answer)');
  const failed = { ...H3, process_list: hist(10 * 60_000, { lastAutoFailed: true, lastCompletedAt: null }) };
  check(SS.quietUntil(sch, failed, now, SS.QUIET_CAP_MS) === now + 50 * 60_000, 'a failed attempt 10 min ago: quiet until its one-hour retry');
  check(SS.quietUntil({ ...sch, enabled: false }, H3, now, SS.QUIET_CAP_MS) === null, 'schedule off: no window (the scheduler returns earlier anyway)');
  const never = Object.fromEntries(keys.map((k) => [k, { lastCompletedAt: null, lastAutoRequestedAt: null, lastAutoFailed: false, open: false }]));
  check(SS.quietUntil(sch, never, now, SS.QUIET_CAP_MS) === null, 'never taken: due now, no window');
  // The window never outlasts dueKeys’ own answer.
  for (const at of [0, 30, 59, 61, 120].map((m) => now + m * 60_000)) {
    const q = SS.quietUntil(sch, near, now, SS.QUIET_CAP_MS);
    if (at < q) check(SS.dueKeys(sch, at, near, () => false).length === 0, `inside the window (+${(at - now) / 60_000} min) dueKeys agrees nothing is due`);
  }
}

console.log(`\nunit-agent-health: ${pass} passed, ${fail} failed`);
if (fail) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
