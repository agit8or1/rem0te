#!/usr/bin/env node
// Automation schedules (0.58), run against dist:
//
//   node apps/api/scripts/unit-automation-schedule.mjs
//
// The shared document (actions/automation-policy.ts): hourly recurrence as
// automation's own closed shape beside the patch policy's weekly and monthly
// windows (which are not widened), fail-closed on any other shape; the
// offline rule as the plan's signed notAfter; the document's own rules and
// digest; the quorum (two approvers other than the author, customer sign-off,
// direct mode). Then evaluateAutomationPlan's refusals one by one, and the
// approval signer in-process on loopback: proposing, the approval page,
// passkey approval (the author and a script's contributors refused), signing
// occurrence plans, no overlap, the per-occurrence limit, a revoked script or
// package stopping every later plan, a pause, revocation, direct mode, and
// the CLI. No database, no portal.

import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createPublicKey, generateKeyPairSync, randomBytes, verify } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { syntheticPasskey } from './lib/synthetic-passkey.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const dist = join(here, '..', 'dist');
const A = require(join(dist, 'actions', 'automation-policy.js'));
const P = require(join(dist, 'actions', 'patch-policy.js'));
const sr = require(join(dist, 'actions', 'script-run.js'));
const S = require(join(dist, 'common', 'schedule.js'));
const { startSigner } = require(join(dist, 'approval-signer', 'server.js'));

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => { if (ok) passed++; else failures.push(`${name}${detail ? ` — ${detail}` : ''}`); };
const hex = (n) => randomBytes(n).toString('hex');
const code = (r) => (r.ok ? 'ok' : r.code);

const BIZ_A = 'biz_acme_0001', BIZ_B = 'biz_birch_0001', BIZ_D = 'biz_direct_001';
const AUTHOR = { userId: 'user_requester', name: 'Dana (L2)' };
const C1 = { endpointId: 'ep_frontdesk_a', hostname: 'FRONTDESK', rustdeskId: '123456789', deviceSecretSha256: 'b'.repeat(64) };
const C2 = { endpointId: 'ep_backoffice_a', hostname: 'BACKOFFICE', rustdeskId: '223456789', deviceSecretSha256: 'c'.repeat(64) };
const SW = { packageId: '7zip.7zip', version: '24.08', installerSha256: 'e'.repeat(64), scope: 'machine', detection: { kind: 'display_name', name: '7-Zip', match: 'prefix', compare: 'gte', version: '24.08' } };
const SWD = { name: '7-Zip', publisher: 'Igor Pavlov', hashSource: 'winget_pkgs', manifestSha256: 'f'.repeat(64), entryId: 'entry_7zip_0001', entryRevision: 1 };
const ALWAYS = { kind: 'hourly', everyHours: 1, minute: 0, windowMinutes: 60, timezone: 'UTC' };

function doc(over = {}) {
  const now = Date.now();
  return {
    schema: A.AUTOMATION_SCHEMA, policyId: hex(16), name: 'Nightly 7-Zip', businessId: BIZ_A, businessName: 'Acme',
    task: { kind: 'software', operation: 'install', params: SW, display: SWD },
    targets: { kind: 'computers', computers: [C1, C2] },
    recurrence: ALWAYS, offline: { mode: 'run_when_online' }, maxRunsPerOccurrence: 1,
    createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 30 * 86_400_000).toISOString(),
    createdBy: AUTHOR, reason: 'Keep 7-Zip current', ...over,
  };
}
const target = (c, biz = BIZ_A) => ({ endpointId: c.endpointId, businessId: biz, businessName: 'Acme', hostname: c.hostname, deviceClass: 'WORKSTATION', rustdeskId: c.rustdeskId, deviceSecretSha256: c.deviceSecretSha256 });
// A plan valid 10 minutes, but never past the hour: the hourly window closes
// on the hour, and the signer (which reads the real clock) refuses a plan that
// outlives it. In the last 10 minutes of an hour the plan is simply shorter.
const tenMinutesInWindow = () => { const t = Date.now(); return new Date(Math.min(t + 10 * 60_000, Math.ceil(t / 3_600_000) * 3_600_000 - 1_000)); };
function planFor(d, digest, { targets = [C1, C2].map((c) => target(c)), notBefore = new Date(), notAfter, ...over } = {}) {
  const t = d.task;
  if (!notAfter) { const occ = A.automationOccurrenceAt(new Date(notBefore), d.recurrence); notAfter = occ ? A.latestNotAfter(d, occ, new Date(notBefore)) : new Date(new Date(notBefore).getTime() + 30 * 60_000); }
  const action = A.taskAction(t);
  return {
    schema: 'rem0te-action-plan/1', jobId: hex(16), action,
    artifact: { target: 'windows/rem0te-agent.exe', sha256: 'a'.repeat(64) },
    params: t.params, targets,
    requestedBy: { userId: d.createdBy.userId, name: d.createdBy.name, via: 'portal' },
    origin: { kind: 'technician', ticketRef: null }, reason: `${d.name} — scheduled run`,
    policy: { risk: 'high', approvalsRequired: 2, customerSignoff: false },
    window: { notBefore: new Date(notBefore).toISOString(), notAfter: new Date(notAfter).toISOString() },
    display: { updates: [], deployment: null, policy: { id: d.policyId, name: d.name, digest }, ...(t.kind === 'software' ? { software: t.display } : {}) },
    ...(t.kind === 'script' ? { script: t.script } : {}),
    createdAt: new Date().toISOString(), approvers: [], signedAt: null, ...over,
  };
}

// The fixtures run in an hourly occurrence that is open all hour: start well inside one.
if (new Date().getUTCMinutes() >= 57) await new Promise((r) => setTimeout(r, (61 - new Date().getUTCMinutes()) * 60_000));

// ── The recurrence ──────────────────────────────────────────────────────────
{
  const H = (o) => A.HourlyRecurrence.safeParse({ kind: 'hourly', everyHours: 4, minute: 15, windowMinutes: 60, timezone: 'America/Chicago', ...o }).success;
  check('an hourly schedule parses with the closed every-N-hours set', H({}) && [1, 2, 3, 4, 6, 8, 12].every((n) => H({ everyHours: n, windowMinutes: 15 })));
  check('every 5, 24 or 0 hours is refused', [5, 24, 0, 7].every((n) => !H({ everyHours: n })));
  check('a window that runs into the next run is refused', !H({ everyHours: 1, windowMinutes: 61 }) && H({ everyHours: 1, windowMinutes: 60 }));
  check('a window under 15 minutes, a bad minute or an unknown zone is refused', !H({ windowMinutes: 14 }) && !H({ minute: 60 }) && !H({ timezone: 'Mars/Olympus' }));
  check('an hourly schedule is strict (no days, no extra keys)', !H({ days: ['mon'] }) && !H({ every: 4 }));
  check('the patch window union is not widened: hourly is not a PolicyWindow', !P.PolicyWindow.safeParse(ALWAYS).success && P.windowKind(ALWAYS) === null);
  const weekly = { days: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'], start: '02:00', end: '04:00', timezone: 'Europe/London' };
  const monthly = { kind: 'monthly', week: 'second', weekday: 'tue', offsetDays: 0, start: '22:00', end: '23:59', timezone: 'America/New_York' };
  check('daily (a weekly window on every day), weekly and monthly are the patch shapes, unchanged',
    A.AutomationRecurrence.safeParse(weekly).success && A.recurrenceKind(weekly) === 'weekly' && A.recurrenceKind(monthly) === 'monthly' && A.AutomationRecurrence.safeParse(monthly).success,
    JSON.stringify(A.AutomationRecurrence.safeParse(monthly).error?.issues?.slice(0, 1)));
  check('daily reads as daily', /^Daily 02:00–04:00 Europe\/London$/.test(A.recurrenceInWords(weekly)), A.recurrenceInWords(weekly));
  for (const bad of [{ kind: 'yearly', month: 1 }, { kind: 'hourly', everyHours: 5, minute: 0, windowMinutes: 30, timezone: 'UTC' }, null, 'daily', { kind: 'cron', expr: '* * * * *' }]) {
    check(`an unknown shape never opens (${JSON.stringify(bad)})`, A.recurrenceKind(bad) === null && A.automationOccurrenceAt(new Date(), bad) === null && A.automationNextOccurrence(new Date(), bad) === null);
  }
  const r = { kind: 'hourly', everyHours: 4, minute: 15, windowMinutes: 60, timezone: 'America/Chicago' };
  const t0 = new Date('2026-11-16T12:30:00Z'); // 06:30 CST
  const n = A.automationNextOccurrences(t0, r, 4);
  check('every 4 hours at :15 from local midnight, in the zone', n.length === 4 && n.map((o) => o.start.toISOString()).join(',') === '2026-11-16T14:15:00.000Z,2026-11-16T18:15:00.000Z,2026-11-16T22:15:00.000Z,2026-11-17T02:15:00.000Z', n.map((o) => o.start.toISOString()).join(','));
  check('an hourly occurrence is open for its window and closed after', !!A.automationOccurrenceAt(new Date('2026-11-16T14:40:00Z'), r) && !A.automationOccurrenceAt(new Date('2026-11-16T15:20:00Z'), r));
  // Spring forward in Chicago: 2027-03-14 02:00 does not exist.
  const dst = A.automationNextOccurrences(new Date('2027-03-14T05:00:00Z'), { kind: 'hourly', everyHours: 1, minute: 30, windowMinutes: 30, timezone: 'America/Chicago' }, 4).map((o) => o.start.getTime());
  check('a skipped DST hour yields no duplicate and stays in order', new Set(dst).size === dst.length && dst.every((x, i) => i === 0 || x > dst[i - 1]), dst.map((x) => new Date(x).toISOString()).join(','));
  check('the next occurrence respects the expiry', A.automationNextOccurrence(t0, r, new Date('2026-11-16T13:00:00Z')) === null);
  check('the hourly words', /Every 4 hours at :15/.test(A.recurrenceInWords(r)) && /America\/Chicago/.test(A.recurrenceInWords(r)));
}

// ── Offline behaviour is the signed notAfter ────────────────────────────────
{
  const occ = { start: new Date('2026-11-16T14:00:00Z'), end: new Date('2026-11-16T16:00:00Z') };
  const nb = new Date('2026-11-16T14:05:00Z');
  const d = (offline, exp = '2026-12-16T00:00:00Z') => ({ offline, expiresAt: exp });
  check('run when online: until the window closes', A.latestNotAfter(d({ mode: 'run_when_online' }), occ, nb).toISOString() === '2026-11-16T16:00:00.000Z');
  check('skip if offline: 15 minutes from the start of the plan', A.latestNotAfter(d({ mode: 'skip_if_offline' }), occ, nb).toISOString() === '2026-11-16T14:20:00.000Z' && A.SKIP_GRACE_MINUTES === 15);
  check('expire after N hours: from the occurrence\'s start, even past the window', A.latestNotAfter(d({ mode: 'expire_after', hours: 6 }), occ, nb).toISOString() === '2026-11-16T20:00:00.000Z');
  check('never past 24 hours from the plan\'s start or the expiry', A.latestNotAfter(d({ mode: 'expire_after', hours: 24 }, '2026-11-16T15:00:00Z'), occ, nb).toISOString() === '2026-11-16T15:00:00.000Z');
  check('an unknown offline rule signs nothing (null)', A.latestNotAfter(d({ mode: 'whenever' }), occ, nb) === null && A.latestNotAfter(d({ mode: 'expire_after', hours: 48 }), occ, nb) === null);
  check('the offline rule is a closed union', !A.AutomationOffline.safeParse({ mode: 'expire_after', hours: 25 }).success && !A.AutomationOffline.safeParse({ mode: 'skip_if_offline', hours: 1 }).success && !A.AutomationOffline.safeParse({ mode: 'retry' }).success);
}

// ── The document ────────────────────────────────────────────────────────────
{
  const d = doc();
  check('a software document parses and validates', A.AutomationDoc.safeParse(d).success && A.validateAutomationDoc(d, new Date()).ok);
  check('the document is strict', !A.AutomationDoc.safeParse({ ...d, command: 'whoami' }).success && !A.AutomationDoc.safeParse({ ...d, task: { ...d.task, params: { ...SW, args: '/S' } } }).success);
  check('at most 25 computers, at least one', !A.AutomationDoc.safeParse({ ...d, targets: { kind: 'computers', computers: [] } }).success
    && !A.AutomationDoc.safeParse({ ...d, targets: { kind: 'computers', computers: Array.from({ length: 26 }, (_, i) => ({ ...C1, endpointId: `ep_x_${String(i).padStart(4, '0')}`, rustdeskId: String(100000000 + i) })) } }).success);
  check('a group target names its cap, 1..25', A.AutomationDoc.safeParse({ ...d, targets: { kind: 'group', groupId: 'grp_tills_0001', groupName: 'Tills', maxTargets: 10 } }).success
    && !A.AutomationDoc.safeParse({ ...d, targets: { kind: 'group', groupId: 'grp_tills_0001', groupName: 'Tills', maxTargets: 26 } }).success);
  check('at most three plans per occurrence', !A.AutomationDoc.safeParse({ ...d, maxRunsPerOccurrence: 4 }).success && !A.AutomationDoc.safeParse({ ...d, maxRunsPerOccurrence: 0 }).success);
  check('an expiry over 90 days is refused', A.validateAutomationDoc(doc({ expiresAt: new Date(Date.now() + 91 * 86_400_000).toISOString() }), new Date()).reason === 'expiry_too_far');
  const in3 = P.WEEKDAYS[new Date(Date.now() + 3 * 86_400_000).getUTCDay()];
  check('a schedule that never opens before expiry is refused',
    A.validateAutomationDoc(doc({ recurrence: { days: [in3], start: '02:00', end: '03:00', timezone: 'UTC' }, expiresAt: new Date(Date.now() + 86_400_000).toISOString() }), new Date()).reason === 'never_runs');
  check('a computer named twice is refused', A.validateAutomationDoc(doc({ targets: { kind: 'computers', computers: [C1, C1] } }), new Date()).reason === 'duplicate_target');
  const dg = A.automationDigest(d);
  check('the digest is stable and depends on every byte', dg === A.automationDigest(JSON.parse(JSON.stringify(d))) && dg !== A.automationDigest({ ...d, reason: 'Keep 7-Zip current.' }));
  check('the digest and signing prefixes are automation\'s own', A.AUTOMATION_DIGEST_PREFIX === 'rem0te-automation-policy-v1\n' && A.AUTOMATION_SIGNING_PREFIX === 'rem0te-automation-policy-approved-v1\n' && A.AUTOMATION_DIGEST_PREFIX !== P.POLICY_DIGEST_PREFIX);
  const ap = (userId, role = 'approver') => ({ userId, name: userId, role, credentialSha256: 'd'.repeat(64), at: new Date().toISOString() });
  check('the quorum: two approvers other than the author', !A.automationQuorum(d, [ap('user_olivia01')], false) && A.automationQuorum(d, [ap('user_olivia01'), ap('user_quinn001')], false)
    && !A.automationQuorum(d, [ap(AUTHOR.userId), ap('user_olivia01')], false));
  check('customer sign-off needs a third person as customer', !A.automationQuorum(d, [ap('user_olivia01'), ap('user_quinn001')], true) && A.automationQuorum(d, [ap('user_olivia01'), ap('user_quinn001'), ap('user_owen0001', 'customer')], true));
  check('direct mode needs no approvals, never with customer sign-off', A.automationQuorum(d, [], false, true) && !A.automationQuorum(d, [], true, true));
  check('the one-time schedule helper gives a plan window of the requested hours', (() => {
    const now = new Date('2026-11-16T12:00:00Z');
    const w = S.scheduledPlanWindow({ local: '2026-11-17T09:30', timeZone: 'Europe/London' }, 4, now);
    return w.notBefore.toISOString() === '2026-11-17T09:30:00.000Z' && w.notAfter.toISOString() === '2026-11-17T13:30:00.000Z';
  })());
  let tooFar = null;
  try { S.scheduledPlanWindow({ local: '2026-12-31T09:30', timeZone: 'UTC' }, 4, new Date('2026-11-16T12:00:00Z')); } catch (e) { tooFar = e.getResponse?.(); }
  check('a one-time run more than 14 days ahead points at automation schedules', tooFar?.code === 'SCHEDULE_TOO_FAR' && /automation schedule/.test(tooFar.message), JSON.stringify(tooFar));
}

// ── evaluateAutomationPlan, refusal by refusal ─────────────────────────────
{
  const d = doc();
  const digest = A.automationDigest(d);
  const approvals = [{ userId: 'user_olivia01', name: 'Olivia', role: 'approver', credentialSha256: 'd'.repeat(64), at: new Date().toISOString() }, { userId: 'user_quinn001', name: 'Quinn', role: 'approver', credentialSha256: 'e'.repeat(64), at: new Date().toISOString() }];
  const state = (over = {}) => ({ doc: d, digest, status: 'ACTIVE', approvals, signatureValid: true, revokedAt: null, ledger: [], ...over });
  const now = new Date();
  const ev = (p, s = state(), o = {}) => code(A.evaluateAutomationPlan(s, { plan: p, policyDigest: digest }, { now, customerSignoff: false, ...o }));
  check('a plan inside the policy is accepted', ev(planFor(d, digest)) === 'ok', ev(planFor(d, digest)));
  const cases = [
    ['revoked', planFor(d, digest), state({ revokedAt: now.toISOString() }), 'policy_revoked'],
    ['a bad signature', planFor(d, digest), state({ signatureValid: false }), 'policy_signature_invalid'],
    ['awaiting approval', planFor(d, digest), state({ status: 'AWAITING_APPROVAL' }), 'policy_not_active'],
    ['one approval', planFor(d, digest), state({ approvals: approvals.slice(0, 1) }), 'policy_not_approved'],
    ['another action', { ...planFor(d, digest), action: { id: 'windows.software.uninstall', version: 1 } }, state(), 'action_not_in_policy'],
    ['widened params', { ...planFor(d, digest), params: { ...SW, version: '25.00' } }, state(), 'params_not_in_policy'],
    ['another catalog revision', { ...planFor(d, digest), display: { ...planFor(d, digest).display, software: { ...SWD, entryRevision: 2 } } }, state(), 'software_not_in_policy'],
    ['another policy named', { ...planFor(d, digest), display: { ...planFor(d, digest).display, policy: { id: hex(16), name: 'x', digest } } }, state(), 'bad_display'],
    ['a deployment named', { ...planFor(d, digest), display: { ...planFor(d, digest).display, deployment: { id: 'dep_x_000001', name: 'x', ring: 0, rings: 1 } } }, state(), 'bad_display'],
    ['someone else requesting', { ...planFor(d, digest), requestedBy: { userId: 'user_other001', name: 'Other', via: 'portal' } }, state(), 'requester_mismatch'],
    ['a computer not named', planFor(d, digest, { targets: [target({ ...C1, endpointId: 'ep_stranger_1' })] }), state(), 'computer_not_in_policy'],
    ['a re-enrolled computer', planFor(d, digest, { targets: [target({ ...C1, deviceSecretSha256: '9'.repeat(64) })] }), state(), 'computer_not_in_policy'],
    ['another business\'s computer', planFor(d, digest, { targets: [target(C1, BIZ_B)] }), state(), 'computer_not_in_policy'],
    ['starting in an hour', planFor(d, digest, { notBefore: new Date(now.getTime() + 3_600_000) }), state(), 'outside_schedule'],
    ['valid longer than the window', planFor(d, digest, { notAfter: new Date(now.getTime() + 2 * 3_600_000) }), state(), 'offline_rule_mismatch'],
    ['an earlier plan still open', planFor(d, digest), state({ ledger: [{ jobId: hex(16), occurrence: 'x', signedAt: now.toISOString(), notBefore: now.toISOString(), notAfter: new Date(now.getTime() + 60_000).toISOString(), endpointIds: [], planSha256: '0'.repeat(64) }] }), 'previous_run_open'],
  ];
  for (const [name, p, s, want] of cases) { const got = ev(p, s); check(`refused: ${name} (${want})`, got === want, got); }
  // The per-occurrence limit and no second plan for the same computer.
  const occ = A.automationOccurrenceAt(now, ALWAYS).start.toISOString();
  const closed = (ids) => ({ jobId: hex(16), occurrence: occ, signedAt: now.toISOString(), notBefore: now.toISOString(), notAfter: new Date(now.getTime() - 1000).toISOString(), endpointIds: ids, planSha256: '0'.repeat(64) });
  check('the per-occurrence limit holds', ev(planFor(d, digest, { targets: [target(C2)] }), state({ ledger: [closed([C1.endpointId])] })) === 'occurrence_run_limit');
  const d3 = { ...d, maxRunsPerOccurrence: 3 };
  const st3 = state({ doc: d3, digest: A.automationDigest(d3), ledger: [closed([C1.endpointId])] });
  const ev3 = (p) => code(A.evaluateAutomationPlan(st3, { plan: { ...p, display: { ...p.display, policy: { ...p.display.policy, digest: st3.digest } } }, policyDigest: st3.digest }, { now, customerSignoff: false }));
  check('a later plan in the occurrence may name only computers not yet named', ev3(planFor(d3, st3.digest, { targets: [target(C2)] })) === 'ok' && ev3(planFor(d3, st3.digest, { targets: [target(C1)] })) === 'already_ran_this_occurrence');
  // Group targets: the cap and the business only.
  const dgp = doc({ targets: { kind: 'group', groupId: 'grp_tills_0001', groupName: 'Tills', maxTargets: 1 } });
  const sg = state({ doc: dgp, digest: A.automationDigest(dgp) });
  const evg = (p) => code(A.evaluateAutomationPlan(sg, { plan: p, policyDigest: sg.digest }, { now, customerSignoff: false }));
  check('a group plan over its cap is refused, under it accepted', evg(planFor(dgp, sg.digest)) === 'too_many_targets' && evg(planFor(dgp, sg.digest, { targets: [target(C2)] })) === 'ok');
  check('a group plan naming another business\'s computer is refused', evg(planFor(dgp, sg.digest, { targets: [target(C2, BIZ_B)] })) === 'computer_not_in_policy');
  // Direct mode: a policy activated with no approvals counts only while the business stays direct.
  check('a direct policy stops counting outside direct mode', code(A.evaluateAutomationPlan(state({ approvals: [] }), { plan: planFor(d, digest), policyDigest: digest }, { now, customerSignoff: false, direct: true })) === 'ok'
    && code(A.evaluateAutomationPlan(state({ approvals: [] }), { plan: planFor(d, digest), policyDigest: digest }, { now, customerSignoff: false })) === 'policy_not_approved');
  check('customer sign-off required later invalidates the policy', ev(planFor(d, digest), state(), { customerSignoff: true }) === 'policy_mismatch');
  // The skip rule: a plan valid more than 15 minutes is refused.
  const ds = doc({ offline: { mode: 'skip_if_offline' } });
  const ss = state({ doc: ds, digest: A.automationDigest(ds) });
  // Pinned 5 minutes into the current hour: the hourly window closes on the
  // hour, so with the real clock in the last 15 minutes of an hour both plans
  // ran past the window and the check failed for a reason it does not test.
  const sNow = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000 + 5 * 60_000);
  const evs = (p) => code(A.evaluateAutomationPlan(ss, { plan: p, policyDigest: ss.digest }, { now: sNow, customerSignoff: false }));
  check('skip-if-offline: 15 minutes is accepted, 16 refused', evs(planFor(ds, ss.digest, { notBefore: sNow, notAfter: new Date(sNow.getTime() + 15 * 60_000) })) === 'ok' && evs(planFor(ds, ss.digest, { notBefore: sNow, notAfter: new Date(sNow.getTime() + 16 * 60_000) })) === 'offline_rule_mismatch');
}

// ── The approval signer, in-process ─────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'rem0te-automation-'));
const { privateKey } = generateKeyPairSync('ed25519');
writeFileSync(join(dir, 'signer.key'), privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
const people = {
  requester: syntheticPasskey(AUTHOR),
  olivia: syntheticPasskey({ userId: 'user_olivia01', name: 'Olivia' }),
  quinn: syntheticPasskey({ userId: 'user_quinn001', name: 'Quinn' }),
  writer: syntheticPasskey({ userId: 'user_writer01', name: 'Wes (wrote the script)' }),
};
const member = (p, approve, customer = []) => ({ userId: p.userId, name: p.name, credentialId: p.credentialId, publicKey: p.publicKey, counter: 0, approve, customer, addedAt: new Date().toISOString() });
writeFileSync(join(dir, 'roster.json'), JSON.stringify({ members: [member(people.requester, ['*']), member(people.olivia, ['*']), member(people.quinn, ['*']), member(people.writer, ['*'])] }));
writeFileSync(join(dir, 'policy.json'), JSON.stringify({ default: { customerSignoff: false }, businesses: { [BIZ_D]: { customerSignoff: false, approval: 'direct' } } }));
const ORIGIN = 'http://127.0.0.1:39281';
const s = startSigner({ dir, origin: ORIGIN, rpId: '127.0.0.1', publicPort: 0, internalPort: 0 });
await Promise.all([s.internal, s.pub].map((x) => new Promise((r) => (x.listening ? r() : x.once('listening', r)))));
const INTERNAL = `http://127.0.0.1:${s.internal.address().port}`;
const PUBLIC = `http://127.0.0.1:${s.pub.address().port}`;
const j = async (url, init = {}) => { const r = await fetch(url, init); let b = null; try { b = await r.json(); } catch { /* not JSON */ } return { status: r.status, body: b }; };
const post = (path, body) => j(`${INTERNAL}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const pub = (id, path, body, origin = ORIGIN) => j(`${PUBLIC}/approve/automation/${id}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });
async function decide(id, who, decision = 'approve') {
  const c = await pub(id, '/challenge', { decision, role: 'approver' });
  if (c.status !== 200) return c;
  return pub(id, '/decide', { challengeId: c.body.challengeId, assertion: who.assert(c.body.options, { origin: ORIGIN }) });
}
const keysDoc = (await j(`${INTERNAL}/internal/v1/keys`)).body;
function verifyEnvelope(env) {
  if (!env) return null;
  const k = keysDoc.keys.find((x) => x.kid === env.kid);
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(k.ed25519, 'base64')]);
  const bytes = Buffer.from(env.plan, 'base64');
  return verify(null, Buffer.concat([Buffer.from('rem0te-action-plan-v1\n'), bytes]), createPublicKey({ key: spki, format: 'der', type: 'spki' }), Buffer.from(env.sig, 'base64')) ? JSON.parse(bytes.toString('utf8')) : null;
}

try {
  const caps = (await j(`${INTERNAL}/internal/v1/capabilities`)).body;
  check('the signer says it supports automation policies', caps?.automations === 1, JSON.stringify(caps));

  // Propose (software, named computers): awaiting two approvals.
  const d = doc();
  let r = await post('/internal/v1/automations', { policy: d });
  check('a valid automation policy is admitted awaiting approval', r.status === 201 && r.body.status === 'AWAITING_APPROVAL' && r.body.digest === A.automationDigest(d) && r.body.approvalUrl === `${ORIGIN}/approve/automation/${d.policyId}`, JSON.stringify(r.body));
  r = await post('/internal/v1/automations', { policy: { ...d, reason: 'changed' } });
  check('another document under the same id is refused', r.status === 409 && r.body.error === 'policy_id_reused', JSON.stringify(r.body));
  r = await post('/internal/v1/automations', { policy: { ...doc(), command: 'whoami' } });
  check('a document with an extra field is refused', r.status === 409 && r.body.error === 'invalid_automation', JSON.stringify(r.body));
  r = await post(`/internal/v1/automations/${d.policyId}/plans`, { plan: planFor(d, A.automationDigest(d)), policyDigest: A.automationDigest(d) });
  check('nothing is signed under a policy awaiting approval', r.status === 409 && r.body.error === 'policy_not_active', JSON.stringify(r.body));
  for (const path of ['approve', 'activate', 'unrevoke']) {
    r = await post(`/internal/v1/automations/${d.policyId}/${path}`, { status: 'ACTIVE' });
    check(`no internal route ${path}s a policy`, r.status === 404, `${r.status}`);
  }
  r = await post(`/internal/v1/automations/${d.policyId}`, { plan: planFor(d, A.automationDigest(d)), policyDigest: A.automationDigest(d) });
  check('a POST to the policy itself is not a plan submission (404)', r.status === 404, `${r.status} ${JSON.stringify(r.body)}`);

  const html = await (await fetch(`${PUBLIC}/approve/automation/${d.policyId}`)).text();
  check('the approval page says what runs, where, when and what happens offline', /Automation: Nightly 7-Zip/.test(html) && /Install 7-Zip 24\.08/.test(html) && /FRONTDESK/.test(html) && /Every hour at :00/.test(html) && /runs it when it is next online/.test(html) && /does not ask you again for each run/.test(html));
  check('the page escapes the document', !/<script>alert/.test(html));

  r = await decide(d.policyId, people.requester);
  check('the author cannot approve their own schedule', r.status === 403 && r.body.error === 'requester_cannot_approve', JSON.stringify(r.body));
  r = await pub(d.policyId, '/challenge', { decision: 'approve', role: 'approver' }, 'https://evil.example.com');
  check('a cross-origin challenge is refused', r.status === 403);
  r = await decide(d.policyId, people.olivia);
  check('one approval is not enough', r.status === 200 && r.body.status === 'AWAITING_APPROVAL', JSON.stringify(r.body));
  r = await decide(d.policyId, people.olivia);
  check('the same person cannot approve twice', r.status === 409 && r.body.error === 'already_decided');
  r = await decide(d.policyId, people.quinn);
  check('a second approver makes it ACTIVE', r.status === 200 && r.body.status === 'ACTIVE', JSON.stringify(r.body));

  // An occurrence's plan is signed, with the policy's approvers.
  const digest = A.automationDigest(d);
  const p1 = planFor(d, digest);
  r = await post(`/internal/v1/automations/${d.policyId}/plans`, { plan: p1, policyDigest: digest });
  check('an occurrence plan inside the policy is signed at once', r.status === 201 && r.body.status === 'SIGNED', JSON.stringify(r.body));
  const st = (await j(`${INTERNAL}/internal/v1/plans/${p1.jobId}`)).body;
  const signed = verifyEnvelope(st?.envelope);
  check('the envelope verifies and carries the two policy approvers', !!signed && signed.approvers.map((a) => a.userId).sort().join(',') === 'user_olivia01,user_quinn001' && signed.display.policy.id === d.policyId);
  r = await post(`/internal/v1/automations/${d.policyId}/plans`, { plan: p1, policyDigest: digest });
  check('the same plan again is the same answer', r.status === 201 && r.body.jobId === p1.jobId);
  r = await post(`/internal/v1/automations/${d.policyId}/plans`, { plan: planFor(d, digest), policyDigest: digest });
  check('a second plan while the first is open is refused (no overlap)', r.status === 409 && r.body.error === 'previous_run_open', JSON.stringify(r.body));
  r = await post(`/internal/v1/automations/${d.policyId}/plans`, { plan: { ...planFor(d, digest), params: { ...SW, version: '25.00' } }, policyDigest: digest });
  check('a plan outside the policy is refused with its own code', r.status === 409 && ['params_not_in_policy', 'previous_run_open'].includes(r.body.error), JSON.stringify(r.body));
  const status = (await j(`${INTERNAL}/internal/v1/automations/${d.policyId}`)).body;
  check('the signer reports its plans and refusals for the portal to mirror', status.status === 'ACTIVE' && status.signedPlans === 1 && status.refusals.length >= 1 && status.approvals.length === 2);

  // A package archived (revoked) on the signer stops every later plan.
  const d2 = doc({ offline: { mode: 'skip_if_offline' } });
  await post('/internal/v1/automations', { policy: d2 });
  await decide(d2.policyId, people.olivia); await decide(d2.policyId, people.quinn);
  const dg2 = A.automationDigest(d2);
  r = await post(`/internal/v1/automations/${d2.policyId}/plans`, { plan: planFor(d2, dg2, { notAfter: tenMinutesInWindow() }), policyDigest: dg2 });
  check('a skip-if-offline plan of 10 minutes is signed', r.status === 201, JSON.stringify(r.body));
  await post(`/internal/v1/software/${SWD.entryId}/revoke`, { reason: 'archived in test' });
  const d2b = doc();
  r = await post('/internal/v1/automations', { policy: d2b });
  check('a new policy for a revoked package is refused at admission', r.status === 409 && r.body.error === 'software_revoked', JSON.stringify(r.body));

  // A script task: the allowlist entry, contributors, revocation.
  const CONTENT = 'param([string]$Name = "x")\nWrite-Output "hello $Name"\n';
  const prop = {
    allowlistId: hex(16), scriptId: 'scr_' + hex(6), versionId: 'ver_' + hex(6), name: 'Say hello', version: 1, description: 'Greets',
    businessId: BIZ_A, businessName: 'Acme', language: 'powershell', targetOs: 'windows', risk: 'medium',
    parameters: [{ name: 'Name', type: 'string', required: false, charset: 'identifier', maxLength: 32 }], contentSha256: sr.sha256Hex(CONTENT), content: CONTENT,
    contributors: [{ userId: people.writer.userId, name: people.writer.name }], reviewedBy: { userId: 'user_review01', name: 'Rob', at: new Date().toISOString() }, proposedBy: AUTHOR,
  };
  const block = sr.scriptBlockOf(prop);
  const scriptTask = { kind: 'script', params: { scriptVersionId: prop.versionId, sha256: block.contentSha256, parameters: { Name: 'world' }, timeoutMinutes: 5 }, script: block };
  const ds = doc({ task: scriptTask, name: 'Hourly hello' });
  r = await post('/internal/v1/automations', { policy: ds });
  check('a script schedule is refused until the script is on the allowlist', r.status === 409 && r.body.error === 'script_not_allowlisted', JSON.stringify(r.body));
  await post('/internal/v1/scripts', { proposal: prop });
  const sp = (id, path, b) => j(`${PUBLIC}/approve/script/${id}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify(b) });
  for (const who of [people.olivia, people.quinn]) { const c = await sp(prop.allowlistId, '/challenge', { decision: 'approve' }); await sp(prop.allowlistId, '/decide', { challengeId: c.body.challengeId, assertion: who.assert(c.body.options, { origin: ORIGIN }) }); }
  r = await post('/internal/v1/automations', { policy: doc({ task: { ...scriptTask, params: { ...scriptTask.params, parameters: { Name: 'not ok!' } } } }) });
  check('arguments the declarations refuse are refused at admission', r.status === 409 && r.body.error === 'arguments_not_allowed', JSON.stringify(r.body));
  r = await post('/internal/v1/automations', { policy: ds });
  check('a script schedule of an ACTIVE allowlist entry is admitted', r.status === 201 && r.body.status === 'AWAITING_APPROVAL', JSON.stringify(r.body));
  r = await decide(ds.policyId, people.writer);
  check('someone who wrote the script cannot approve its schedule', r.status === 409 && r.body.error === 'contributor_cannot_approve', JSON.stringify(r.body));
  await decide(ds.policyId, people.olivia); r = await decide(ds.policyId, people.quinn);
  check('two other approvers make the script schedule ACTIVE', r.body?.status === 'ACTIVE', JSON.stringify(r.body));
  const dgs = A.automationDigest(ds);
  const sp1 = planFor(ds, dgs, { notAfter: tenMinutesInWindow() });
  r = await post(`/internal/v1/automations/${ds.policyId}/plans`, { plan: sp1, policyDigest: dgs });
  check('a script occurrence plan is signed', r.status === 201, JSON.stringify(r.body));
  r = await post(`/internal/v1/scripts/${prop.allowlistId}/revoke`, { reason: 'bug found' });
  check('the script is revoked on the signer', r.status === 200);
  // A later occurrence (the earlier plan closed by then): refused for the revocation, before the policy is looked at.
  r = await post(`/internal/v1/automations/${ds.policyId}/plans`, { plan: planFor(ds, dgs), policyDigest: dgs });
  check('a revoked script stops every later plan', r.status === 409 && r.body.error === 'script_revoked', JSON.stringify(r.body));

  // Pause and revocation.
  const d3 = doc({ task: { kind: 'software', operation: 'uninstall', params: SW, display: { ...SWD, entryId: 'entry_other_001' } } });
  await post('/internal/v1/automations', { policy: d3 });
  await decide(d3.policyId, people.olivia); await decide(d3.policyId, people.quinn);
  const dg3 = A.automationDigest(d3);
  await post('/internal/v1/pauses', { scope: 'business', businessId: BIZ_A, reason: 'containment drill' });
  r = await post(`/internal/v1/automations/${d3.policyId}/plans`, { plan: planFor(d3, dg3), policyDigest: dg3 });
  check('a containment pause on the signer stops automation plans', r.status === 409 && r.body.error === 'paused', JSON.stringify(r.body));
  const cli = (args) => spawnSync(process.execPath, [join(dist, 'approval-signer', 'main.js'), ...args], { encoding: 'utf8', env: { ...process.env, APPROVAL_SIGNER_DIR: dir } });
  const pauses = (await j(`${INTERNAL}/internal/v1/pauses`)).body.pauses;
  for (const p of pauses) cli(['pause', 'clear', '--id', p.id, '--reason', 'drill over']);
  r = await post(`/internal/v1/automations/${d3.policyId}/revoke`, { reason: 'no longer wanted' });
  check('the portal may revoke', r.status === 200 && r.body.status === 'REVOKED');
  check('revocation is its own write-once file', existsSync(join(dir, 'automation-revocations', `${d3.policyId}.json`)));
  r = await post(`/internal/v1/automations/${d3.policyId}/plans`, { plan: planFor(d3, dg3), policyDigest: dg3 });
  check('nothing is signed under a revoked policy', r.status === 409 && r.body.error === 'policy_revoked', JSON.stringify(r.body));
  r = await decide(d3.policyId, people.olivia);
  check('a revoked policy cannot be decided on again', r.status === 409);

  // Direct mode: active at admission, no approvals, the plan says direct.
  const dd = doc({ businessId: BIZ_D, businessName: 'Direct Co', task: { kind: 'software', operation: 'install', params: SW, display: { ...SWD, entryId: 'entry_direct_01' } } });
  r = await post('/internal/v1/automations', { policy: dd });
  check('in direct mode the policy is ACTIVE at admission', r.status === 201 && r.body.status === 'ACTIVE' && r.body.direct === true, JSON.stringify(r.body));
  const ddg = A.automationDigest(dd);
  const pd = planFor(dd, ddg, { targets: [target(C1, BIZ_D)], policy: { risk: 'high', approvalsRequired: 0, customerSignoff: false, approval: 'direct' } });
  r = await post(`/internal/v1/automations/${dd.policyId}/plans`, { plan: pd, policyDigest: ddg });
  const sd = verifyEnvelope((await j(`${INTERNAL}/internal/v1/plans/${pd.jobId}`)).body?.envelope);
  check('a direct-mode occurrence plan is signed with no approvers', r.status === 201 && !!sd && sd.approvers.length === 0 && sd.policy.approval === 'direct', JSON.stringify(r.body));

  // The CLI.
  const out = cli(['automation', 'list']);
  check('`automation list` shows each policy and whether its signature verifies', out.status === 0 && out.stdout.includes(d.policyId) && /signature ok/.test(out.stdout) && /REVOKED/.test(out.stdout) && /approvals=direct/.test(out.stdout), out.stderr || out.stdout.slice(0, 300));
  const rv = cli(['automation', 'revoke', '--id', d.policyId, '--reason', 'operator revoked']);
  check('`automation revoke` revokes on the signer host', rv.status === 0 && (await j(`${INTERNAL}/internal/v1/automations/${d.policyId}`)).body.status === 'REVOKED', rv.stderr);
  check('a second revoke is refused (the first stands)', cli(['automation', 'revoke', '--id', d.policyId, '--reason', 'again']).status !== 0);
} finally {
  await s.close();
  rmSync(dir, { recursive: true, force: true });
}

const loaded = Object.keys(require.cache).filter((k) => /node_modules[\\/](@nestjs|@prisma|\.prisma)/.test(k) && !/common[\\/]schedule/.test(k));
check('the automation evaluator and the signer load no Prisma module', !loaded.some((k) => /@prisma|\.prisma/.test(k)), loaded.slice(0, 3).join(', '));

if (failures.length) {
  console.error(`✗ ${failures.length} failed, ${passed} passed`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ ${passed} automation-schedule checks passed`);
