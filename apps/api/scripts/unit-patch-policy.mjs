#!/usr/bin/env node
// Tests for patch policies (0.32), run against dist:
//
//   node apps/api/scripts/unit-patch-policy.mjs
//
// The pure evaluator the approval signer runs over a proposed ring plan
// (src/actions/patch-policy.ts), its maintenance-window arithmetic across
// timezones and DST changes, and the signer's own policy records — approval
// quorum, its signature over the approved policy, and signing a plan under
// one (src/approval-signer/core.ts). No database, no portal, no network.

import { createHash, createPublicKey, generateKeyPairSync, randomBytes, verify } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const dist = join(here, '..', 'dist');
const P = require(join(dist, 'actions', 'patch-policy.js'));
const core = require(join(dist, 'approval-signer', 'core.js'));
const { PLAN_SIGNING_PREFIX } = require(join(dist, 'actions', 'catalog.js'));

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => { if (ok) passed++; else failures.push(`${name}${detail ? ` — ${detail}` : ''}`); };
const iso = (s) => new Date(s).toISOString();
const sha = (s) => createHash('sha256').update(s).digest('hex');
const hex = (n) => randomBytes(n).toString('hex');

// ── Window arithmetic ───────────────────────────────────────────────────────
{
  const z = (...a) => P.zonedToUtc(...a).toISOString();
  check('UTC is UTC', z(2026, 11, 14, 22, 0, 'UTC') === '2026-11-14T22:00:00.000Z', z(2026, 11, 14, 22, 0, 'UTC'));
  check('Chicago in July is UTC-5 (CDT)', z(2026, 7, 4, 22, 0, 'America/Chicago') === '2026-07-05T03:00:00.000Z', z(2026, 7, 4, 22, 0, 'America/Chicago'));
  check('Chicago in January is UTC-6 (CST)', z(2026, 1, 10, 22, 0, 'America/Chicago') === '2026-01-11T04:00:00.000Z', z(2026, 1, 10, 22, 0, 'America/Chicago'));
  check('Kolkata has a half-hour offset (UTC+5:30)', z(2026, 1, 1, 9, 0, 'Asia/Kolkata') === '2026-01-01T03:30:00.000Z', z(2026, 1, 1, 9, 0, 'Asia/Kolkata'));
  check('Chatham has a 45-minute offset (UTC+13:45 in its summer)', z(2026, 1, 1, 12, 0, 'Pacific/Chatham') === '2025-12-31T22:15:00.000Z', z(2026, 1, 1, 12, 0, 'Pacific/Chatham'));
  // New York springs forward at 02:00 on 2026-03-08: 02:30 never happens.
  check('NY spring-forward: the skipped 02:30 is where it would have been (03:30 EDT)', z(2026, 3, 8, 2, 30, 'America/New_York') === '2026-03-08T07:30:00.000Z', z(2026, 3, 8, 2, 30, 'America/New_York'));
  // New York falls back at 02:00 on 2026-11-01: 01:30 happens twice.
  check('NY fall-back: the repeated 01:30 is the earlier one (EDT)', z(2026, 11, 1, 1, 30, 'America/New_York') === '2026-11-01T05:30:00.000Z', z(2026, 11, 1, 1, 30, 'America/New_York'));
  // London falls back at 02:00 BST on 2026-10-25 (a zone east of UTC in summer).
  check('London fall-back: the repeated 01:30 is the earlier one (BST)', z(2026, 10, 25, 1, 30, 'Europe/London') === '2026-10-25T00:30:00.000Z', z(2026, 10, 25, 1, 30, 'Europe/London'));
  // Sydney springs forward at 02:00 AEST on 2026-10-04 (southern hemisphere).
  check('Sydney spring-forward: the skipped 02:30 is 03:30 AEDT', z(2026, 10, 4, 2, 30, 'Australia/Sydney') === '2026-10-03T16:30:00.000Z', z(2026, 10, 4, 2, 30, 'Australia/Sydney'));

  const sat = { days: ['sat'], start: '22:00', end: '04:00', timezone: 'America/Chicago' };
  const o = P.occurrenceAt(new Date('2026-11-15T05:00:00Z'), sat); // Sat 23:00 CST
  check('a window that crosses midnight contains its late-night hours', o && o.start.toISOString() === '2026-11-15T04:00:00.000Z' && o.end.toISOString() === '2026-11-15T10:00:00.000Z', JSON.stringify(o));
  const o2 = P.occurrenceAt(new Date('2026-11-15T09:30:00Z'), sat); // Sun 03:30 CST, still Saturday's window
  check('…and the early hours of the next day belong to the day it started', o2 && o2.start.toISOString() === '2026-11-15T04:00:00.000Z', JSON.stringify(o2));
  check('the end is exclusive', P.occurrenceAt(new Date('2026-11-15T10:00:00Z'), sat) === null);
  check('the start is inclusive', P.occurrenceAt(new Date('2026-11-15T04:00:00Z'), sat) !== null);
  check('another weekday is outside', P.occurrenceAt(new Date('2026-11-14T05:00:00Z'), sat) === null);
  const n = P.nextOccurrence(new Date('2026-11-11T12:00:00Z'), sat); // a Wednesday
  check('the next occurrence from a Wednesday is Saturday night', n && n.start.toISOString() === '2026-11-15T04:00:00.000Z', JSON.stringify(n));
  check('nextOccurrence honours an upper bound', P.nextOccurrence(new Date('2026-11-11T12:00:00Z'), sat, new Date('2026-11-14T00:00:00Z')) === null);
  // DST inside a window: 2026-03-08 (Sunday) 01:00–04:00 New York is two real hours; 2026-11-01 00:00–03:00 is four.
  const spring = P.occurrenceAt(new Date('2026-03-08T06:30:00Z'), { days: ['sun'], start: '01:00', end: '04:00', timezone: 'America/New_York' });
  check('a window across spring-forward lasts 2 real hours, by the local clock', spring && spring.end - spring.start === 2 * 3600_000, JSON.stringify(spring));
  const fall = P.occurrenceAt(new Date('2026-11-01T05:30:00Z'), { days: ['sun'], start: '00:00', end: '03:00', timezone: 'America/New_York' });
  check('a window across fall-back lasts 4 real hours, by the local clock', fall && fall.end - fall.start === 4 * 3600_000, JSON.stringify(fall));
  check('the same local window is a different UTC hour in summer and winter',
    P.occurrenceAt(new Date('2026-07-05T03:30:00Z'), sat.days.includes('sat') ? { ...sat } : sat)?.start.toISOString() === '2026-07-05T03:00:00.000Z');
  check('a timezone the runtime knows is valid', P.validTimezone('America/Chicago') && P.validTimezone('UTC'));
  check('an unknown or malformed timezone is not', !P.validTimezone('Mars/Olympus_Mons') && !P.validTimezone('../etc/passwd') && !P.validTimezone(''));
  check('localTime reports the local weekday', P.localTime(new Date('2026-11-15T05:00:00Z'), 'America/Chicago').weekday === 'sat' && P.localTime(new Date('2026-11-15T05:00:00Z'), 'Asia/Tokyo').weekday === 'sun');
  check('a window schema refuses an empty window and an unknown day',
    !P.PolicyWindow.safeParse({ days: ['sat'], start: '02:00', end: '02:00', timezone: 'UTC' }).success
    && !P.PolicyWindow.safeParse({ days: ['someday'], start: '02:00', end: '03:00', timezone: 'UTC' }).success
    && !P.PolicyWindow.safeParse({ days: ['sat'], start: '24:00', end: '03:00', timezone: 'UTC' }).success);
}

// ── Fixtures: one business, a canary and a ring of two ──────────────────────
const SEC = '0fa1201d-4330-4fa8-8ae9-b877473b6441', UPD = 'cd5ffd1e-e932-4e3a-bf74-18bf0b1bbd83';
const BIZ = 'biz_acme_0001';
const pc = (name) => ({ endpointId: `ep_${name.toLowerCase()}_0001`, hostname: name, rustdeskId: String(100000000 + Math.floor(Math.random() * 8e8)), deviceSecretSha256: sha(name) });
const CANARY = pc('CANARY'), R1A = pc('R1A'), R1B = pc('R1B'), OTHER = pc('OTHER');
const CU = { updateId: '5a1b2c3d-0000-4000-8000-000000000001', revision: 201, kb: 'KB5044284', title: '2026-11 Cumulative Update', className: 'Security Updates', severity: 'Critical' };
const NET = { updateId: '5a1b2c3d-0000-4000-8000-000000000002', revision: 3, kb: 'KB5044099', title: '.NET update', className: 'Updates', severity: null };
const id = (u) => ({ updateId: u.updateId, revision: u.revision });
const key = (u) => `${u.updateId}@${u.revision}`;
// Friday 22:00 America/Chicago (CST) on 2026-11-13 = 04:00Z on the 14th.
const NOW = new Date('2026-11-14T04:00:00Z');
const AUTHOR = { userId: 'user_author01', name: 'Owen' };

function doc(over = {}) {
  return {
    schema: 'rem0te-patch-policy/1', policyId: hex(16), name: 'Acme security', businessId: BIZ, businessName: 'Acme',
    rings: [[CANARY], [R1A, R1B]], allow: { classifications: [SEC] }, soakHours: 0, failureThreshold: 0,
    window: { days: ['fri'], start: '21:00', end: '03:00', timezone: 'America/Chicago' }, reboot: 'never',
    createdAt: iso(NOW.getTime() - 3600_000), expiresAt: iso(NOW.getTime() + 30 * 86_400_000), createdBy: AUTHOR, reason: 'Security updates for Acme, weekly', ...over,
  };
}
const approvals = [
  { userId: 'user_olivia01', name: 'Olivia', role: 'approver', credentialSha256: sha('o'), at: iso(NOW.getTime() - 1800_000) },
  { userId: 'user_quinn001', name: 'Quinn', role: 'approver', credentialSha256: sha('q'), at: iso(NOW.getTime() - 1700_000) },
];
function state(d, over = {}) {
  return { doc: d, digest: P.policyDigest(d), status: 'ACTIVE', approvals, signatureValid: true, revokedAt: null, ledger: [], ...over };
}
const target = (c) => ({ endpointId: c.endpointId, businessId: BIZ, businessName: 'Acme', hostname: c.hostname, deviceClass: 'WORKSTATION', rustdeskId: c.rustdeskId, deviceSecretSha256: c.deviceSecretSha256 });
function plan(d, { ring = 0, computers = [CANARY], updates = [CU], dep = 'dep_acme_0001', nb = NOW, hours = 3, allow, reboot = 'never', requester = AUTHOR, display } = {}) {
  return {
    schema: 'rem0te-action-plan/1', jobId: hex(16), action: { id: 'windows.update.install', version: 1 },
    artifact: { target: 'windows/rem0te-agent.exe', sha256: sha('agent') },
    params: { updates: updates.map(id), reboot, ...(allow === null ? {} : { allow: allow ?? P.allowParams(d.allow) }) },
    targets: computers.map(target), requestedBy: { ...requester, via: 'portal' }, origin: { kind: 'technician', ticketRef: null },
    reason: `${d.name} — ring ${ring}`, policy: { risk: 'high', approvalsRequired: 2, customerSignoff: false },
    window: { notBefore: iso(nb), notAfter: iso(nb.getTime() + hours * 3600_000) },
    display: display ?? { updates: updates.map((u) => ({ ...u })), deployment: { id: dep, name: 'Acme security — 2026-11-13', ring, rings: d.rings.length }, policy: { id: d.policyId, name: d.name, digest: P.policyDigest(d) } },
    createdAt: iso(NOW), approvers: [], signedAt: null,
  };
}
const evaluate = (s, p, { digest, evidence = null, now = NOW, customerSignoff = false } = {}) => P.evaluatePolicyPlan(s, { plan: p, policyDigest: digest ?? s.digest, evidence }, { now, customerSignoff });
const code = (r) => (r.ok ? 'ok' : r.code);

// ── The evaluator: each refusal ─────────────────────────────────────────────
{
  const d = doc();
  const s = state(d);
  check('a canary plan inside the policy is accepted', evaluate(s, plan(d)).ok, JSON.stringify(evaluate(s, plan(d))));
  let r = evaluate(s, plan(d, { computers: [R1A] }));
  check('a computer outside the ring (a ring-1 computer as the canary) → computer_not_in_policy', code(r) === 'computer_not_in_policy', code(r));
  r = evaluate(s, plan(d, { computers: [OTHER] }));
  check('a computer outside the policy → computer_not_in_policy', code(r) === 'computer_not_in_policy', code(r));
  const reenrolled = plan(d); reenrolled.targets[0].deviceSecretSha256 = sha('re-enrolled');
  check('the approved computer re-enrolled (another device secret) → computer_not_in_policy', code(evaluate(s, reenrolled)) === 'computer_not_in_policy');
  const moved = plan(d); moved.targets[0].businessId = 'biz_birch_0001';
  check('the approved computer claimed for another business → computer_not_in_policy', code(evaluate(s, moved)) === 'computer_not_in_policy');
  r = evaluate(s, plan(d, { updates: [NET] }));
  check('an update of a class the policy does not install (Updates, under Security-only) → class_not_allowed', code(r) === 'class_not_allowed', code(r));
  const relabelled = plan(d, { updates: [NET] }); relabelled.display.updates[0].className = 'Drivers';
  check('a driver label → class_not_allowed', code(evaluate(s, relabelled)) === 'class_not_allowed');
  const dSev = doc({ allow: { classifications: [SEC, UPD], severities: ['Critical'] } });
  r = evaluate(state(dSev), plan(dSev, { updates: [NET] }));
  check('an update of a severity the policy does not install (Unrated, under Critical-only) → severity_not_allowed', code(r) === 'severity_not_allowed', code(r));
  const dKb = doc({ allow: { classifications: [SEC], excludeKbs: ['KB5044284'] } });
  r = evaluate(state(dKb), plan(dKb));
  check('an excluded KB → kb_excluded', code(r) === 'kb_excluded', code(r));
  r = evaluate(s, plan(d, { allow: { classifications: [SEC, UPD].sort() } }));
  check('a plan whose filter is wider than the policy\'s → filter_mismatch', code(r) === 'filter_mismatch', code(r));
  r = evaluate(s, plan(d, { allow: null }));
  check('a plan with no filter at all (the agent would install any eligible class) → filter_mismatch', code(r) === 'filter_mismatch', code(r));
  r = evaluate(s, plan(d, { reboot: 'in_window' }));
  check('a reboot rule other than the policy\'s → reboot_not_allowed', code(r) === 'reboot_not_allowed', code(r));
  r = evaluate(s, plan(d, { nb: new Date(NOW.getTime() + 6 * 3600_000), hours: 1 }));
  check('a plan that starts after the window closes → outside_window', code(r) === 'outside_window', code(r));
  r = evaluate(s, plan(d, { hours: 8 }));
  check('a plan that runs past the end of the window → outside_window', code(r) === 'outside_window', code(r));
  r = evaluate(s, plan(d, { nb: new Date('2026-11-15T04:00:00Z'), hours: 1 }), { now: new Date('2026-11-15T03:59:00Z') });
  check('a plan on a day the policy does not name (Saturday) → outside_window', code(r) === 'outside_window', code(r));
  r = evaluate(s, plan(d, { nb: new Date(NOW.getTime() - 3600_000), hours: 2 }));
  check('a plan dated in the past → outside_window', code(r) === 'outside_window', code(r));
  const dExp = doc({ expiresAt: iso(NOW.getTime() + 3600_000) });
  r = evaluate(state(dExp), plan(dExp), { now: new Date(NOW.getTime() + 3600_000) });
  check('after the policy\'s expiry → policy_expired', code(r) === 'policy_expired', code(r));
  r = evaluate(state(dExp), plan(dExp, { hours: 2 }));
  check('a plan that would run past the expiry → policy_expired', code(r) === 'policy_expired', code(r));
  r = evaluate(state(d, { revokedAt: iso(NOW), status: 'REVOKED' }), plan(d));
  check('a revoked policy → policy_revoked', code(r) === 'policy_revoked', code(r));
  r = evaluate(state(d, { revokedAt: iso(NOW) }), plan(d));
  check('…even if the record\'s status still says active (revocation wins)', code(r) === 'policy_revoked', code(r));
  r = evaluate(s, plan(d), { digest: sha('another policy') });
  check('the portal names another policy digest → policy_digest_mismatch', code(r) === 'policy_digest_mismatch', code(r));
  const widened = { ...d, rings: [[CANARY], [R1A, R1B, OTHER]] };
  r = evaluate({ ...s, doc: widened }, plan(widened, { ring: 1, computers: [OTHER] }));
  check('a policy document altered after approval (its hash no longer matches) → policy_digest_mismatch', code(r) === 'policy_digest_mismatch', code(r));
  r = evaluate(state(d, { signatureValid: false }), plan(d));
  check('a policy whose signer signature does not verify → policy_signature_invalid', code(r) === 'policy_signature_invalid', code(r));
  r = evaluate(state(d, { approvals: approvals.slice(0, 1) }), plan(d));
  check('a policy with one approval → policy_not_approved', code(r) === 'policy_not_approved', code(r));
  r = evaluate(state(d, { approvals: [approvals[0], { ...approvals[1], userId: AUTHOR.userId }] }), plan(d));
  check('a policy whose second "approval" is its own author → policy_not_approved', code(r) === 'policy_not_approved', code(r));
  r = evaluate(state(d, { approvals: [approvals[0], { ...approvals[1], userId: approvals[0].userId }] }), plan(d));
  check('two approvals by the same person → policy_not_approved', code(r) === 'policy_not_approved', code(r));
  r = evaluate(state(d, { status: 'AWAITING_APPROVAL' }), plan(d));
  check('a policy still awaiting approval → policy_not_active', code(r) === 'policy_not_active', code(r));
  r = evaluate(s, plan(d), { customerSignoff: true });
  check('the business now requires customer sign-off, which the policy lacks → policy_mismatch', code(r) === 'policy_mismatch', code(r));
  r = evaluate(s, plan(d, { requester: { userId: 'user_mallory1', name: 'Mallory' } }));
  check('a plan requested by someone other than the author → requester_mismatch', code(r) === 'requester_mismatch', code(r));
  const spool = plan(d); spool.action = { id: 'windows.service.start', version: 1 };
  check('another catalog action → action_not_in_policy', code(evaluate(s, spool)) === 'action_not_in_policy');
  const hidden = plan(d, { updates: [CU, { ...CU, updateId: '5a1b2c3d-0000-4000-8000-0000000000aa' }] }); hidden.display.updates = [hidden.display.updates[0]];
  check('an update the approvers are not shown → bad_display', code(evaluate(s, hidden)) === 'bad_display');
  r = evaluate(s, plan(d, { ring: 1, computers: [R1A] }));
  check('ring 1 before the canary was signed (skipping it) → ring_out_of_order', code(r) === 'ring_out_of_order', code(r));
  const ringSix = plan(d); ringSix.display.deployment.ring = 2;
  check('a ring the policy does not have → ring_out_of_order', code(evaluate(s, ringSix)) === 'ring_out_of_order');
}

// ── The evaluator: ring order from the ledger, and the canary's evidence ────
{
  const d = doc();
  const canaryJob = hex(16);
  const signedAt = iso(NOW.getTime() - 2 * 3600_000);
  const ledger = [{ jobId: canaryJob, deploymentId: 'dep_acme_0001', ring: 0, signedAt, notBefore: signedAt, notAfter: iso(NOW.getTime() - 60_000), endpointIds: [CANARY.endpointId], updates: [key(CU)] }];
  const s = state(d, { ledger });
  const resultAt = new Date(NOW.getTime() - 90 * 60_000);
  const gt = (over = {}) => ({
    endpointId: CANARY.endpointId, status: 'SUCCEEDED', statusReason: null, reconciled: false, reconcileNote: null, resultAt,
    result: { outcome: 'restart_required', updates: [{ ...id(CU), state: 'restart_required' }] },
    scan: { scannedAt: iso(resultAt.getTime() + 30 * 60_000), reboot: { pending: false }, updates: [], history: [{ ...id(CU), operation: 'install', result: 'succeeded' }] },
    ...over,
  });
  const ev = (targets, over = {}) => ({ previousJobId: canaryJob, jobStatus: 'SUCCEEDED', targets: targets.map((t) => P.toEvidenceTarget(t, [id(CU)])), ...over });
  const effective = ev([gt()]);
  const ring1 = (over) => plan(d, { ring: 1, computers: [R1A, R1B], ...over });
  let r = evaluate(s, ring1(), { evidence: effective });
  check('ring 1 after the canary was signed and its evidence shows every update effective → accepted', r.ok, JSON.stringify(r));
  const back = P.fromEvidenceTarget(effective.targets[0]);
  check('evidence round-trips: the signer reaches "effective" from the reduced scan', P.targetStates([id(CU)], back, 'SUCCEEDED')[0].state === 'effective');
  r = evaluate(s, ring1({ computers: [R1A, R1B, OTHER] }), { evidence: effective });
  check('a widened ring (an extra computer) → computer_not_in_policy', code(r) === 'computer_not_in_policy', code(r));
  r = evaluate(s, ring1({ computers: [R1A, CANARY] }), { evidence: effective });
  check('the canary slipped into ring 1 → computer_not_in_policy', code(r) === 'computer_not_in_policy', code(r));
  r = evaluate(s, ring1({ updates: [CU, { ...CU, updateId: '5a1b2c3d-0000-4000-8000-0000000000bb', kb: 'KB5099999' }] }), { evidence: effective });
  check('ring 1 carrying an update the canary never installed → updates_not_proven', code(r) === 'updates_not_proven', code(r));
  const pending = ev([gt({ scan: { scannedAt: iso(resultAt.getTime() + 30 * 60_000), reboot: { pending: true }, updates: [], history: [{ ...id(CU), operation: 'install', result: 'succeeded' }] } })]);
  r = evaluate(s, ring1(), { evidence: pending });
  check('the canary installed but has not restarted (not yet effective) → canary_not_effective', code(r) === 'canary_not_effective', code(r));
  const stale = ev([gt({ scan: { scannedAt: iso(resultAt.getTime() - 60_000), reboot: { pending: false }, updates: [], history: [] } })]);
  r = evaluate(s, ring1(), { evidence: stale });
  check('only a scan from before the install (proves nothing) → canary_not_effective', code(r) === 'canary_not_effective', code(r));
  const failed = ev([gt({ status: 'FAILED', result: { outcome: 'failed', updates: [{ ...id(CU), state: 'failed', hresult: '0x80240022' }] } })]);
  r = evaluate(s, ring1(), { evidence: failed });
  check('the canary failed (over a threshold of 0) → gate_not_passed', code(r) === 'gate_not_passed', code(r));
  r = evaluate(s, ring1(), { evidence: ev([gt({ status: 'UNKNOWN', result: null })]) });
  check('the canary\'s outcome is uncertain and unreconciled → gate_not_passed', code(r) === 'gate_not_passed', code(r));
  r = evaluate(s, ring1(), { evidence: ev([gt({ status: 'DISPATCHED', result: null })]) });
  check('the canary has not answered, whatever the job status claims → gate_not_passed', code(r) === 'gate_not_passed', code(r));
  r = evaluate(s, ring1(), { evidence: ev([gt()], { previousJobId: hex(16) }) });
  check('evidence about some other plan → evidence_mismatch', code(r) === 'evidence_mismatch', code(r));
  r = evaluate(s, ring1(), { evidence: ev([]) });
  check('evidence that leaves the canary out → evidence_mismatch', code(r) === 'evidence_mismatch', code(r));
  r = evaluate(s, ring1(), { evidence: ev([gt(), gt({ endpointId: R1A.endpointId })]) });
  check('evidence naming a computer that was not in the ring → evidence_mismatch', code(r) === 'evidence_mismatch', code(r));
  r = evaluate(s, ring1());
  check('no evidence at all → evidence_mismatch', code(r) === 'evidence_mismatch', code(r));
  const dSoak = doc({ soakHours: 24 });
  const sSoak = state(dSoak, { ledger });
  r = evaluate(sSoak, plan(dSoak, { ring: 1, computers: [R1A, R1B] }), { evidence: effective });
  check('the soak time has not passed since the canary\'s result → gate_not_passed', code(r) === 'gate_not_passed' && /Soaking/.test(r.message), JSON.stringify(r));
  r = evaluate(state(d, { ledger: [...ledger, { ...ledger[0], jobId: hex(16), ring: 1, endpointIds: [R1A.endpointId, R1B.endpointId] }] }), plan(d), {});
  check('the canary again, after ring 1 was signed → ring_out_of_order', code(r) === 'ring_out_of_order', code(r));
  const open = [{ ...ledger[0], notAfter: iso(NOW.getTime() + 3600_000) }];
  r = evaluate(state(d, { ledger: open }), plan(d));
  check('the same ring again while its signed plan is still open → ring_already_signed', code(r) === 'ring_already_signed', code(r));
  const thrice = [0, 1, 2].map(() => ({ ...ledger[0], jobId: hex(16) }));
  r = evaluate(state(d, { ledger: thrice }), plan(d));
  check(`a ring signed ${P.MAX_RING_ATTEMPTS} times already → ring_retry_limit`, code(r) === 'ring_retry_limit', code(r));
  r = evaluate(state(d), plan(d), { evidence: effective });
  check('a canary plan that carries evidence → bad_evidence', code(r) === 'bad_evidence', code(r));
  const other = plan(d, { ring: 1, computers: [R1A], dep: 'dep_other_0001' });
  r = evaluate(s, other, { evidence: effective });
  check('ring 1 of a deployment whose canary was never signed (another deployment\'s canary does not count) → ring_out_of_order', code(r) === 'ring_out_of_order', code(r));
}

// ── The ring gate, as the portal and signer share it ────────────────────────
{
  const g = (targets, over = {}) => P.evaluateRingGate({ ring: 1, jobStatus: 'SUCCEEDED', targets, updates: [id(CU)], failureThreshold: 1, soakHours: 0, ...over }, NOW);
  const ok = { endpointId: 'a', status: 'SUCCEEDED', statusReason: null, reconciled: false, reconcileNote: null, resultAt: new Date(NOW - 3600_000), result: { outcome: 'succeeded', updates: [{ ...id(CU), state: 'installed' }] }, scan: null };
  const bad = { ...ok, endpointId: 'b', status: 'FAILED', result: { outcome: 'failed', updates: [{ ...id(CU), state: 'failed' }] } };
  check('one failure within a threshold of one passes', g([ok, bad]).ok);
  check('two failures over a threshold of one → too_many_failures', g([ok, bad, { ...bad, endpointId: 'c' }]).reason === 'too_many_failures');
  check('a reconciled uncertain computer still counts as failed', g([ok, { ...bad, endpointId: 'c', status: 'UNKNOWN', reconciled: true }, { ...bad, endpointId: 'd' }]).reason === 'too_many_failures');
  check('a ring every computer of which was canceled → ring_not_run', g([{ ...ok, status: 'CANCELED' }]).reason === 'ring_not_run');
  check('a job awaiting approval → in_progress', g([ok], { jobStatus: 'AWAITING_APPROVAL' }).reason === 'in_progress');
}

// ── The signer's policy records ─────────────────────────────────────────────
{
  const { privateKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const k = core.loadSigningKey(pem);
  const pub = createPublicKey(k.key);
  const member = (userId, name, approve = ['*'], customer = []) => ({ userId, name, credentialId: hex(8), publicKey: hex(16), counter: 0, approve, customer, addedAt: iso(NOW) });
  const olivia = member('user_olivia01', 'Olivia'), quinn = member('user_quinn001', 'Quinn'), author = member(AUTHOR.userId, 'Owen'), birchOnly = member('user_birch001', 'Bea', ['biz_birch_0001']);
  const business = { default: { customerSignoff: false }, businesses: {} };
  const fresh = (d = doc()) => {
    const { doc: dd, digest } = core.admitPolicy(d, NOW);
    return { policyId: dd.policyId, status: 'AWAITING_APPROVAL', doc: dd, digest, decisions: [], signature: null, kid: null, revokedAt: null, revokedBy: null, revokeReason: null, ledger: [], refusals: [], createdAt: iso(NOW), updatedAt: iso(NOW) };
  };
  const refused = (fn) => { try { fn(); return null; } catch (e) { return e.code ?? e.message; } };

  check('admitPolicy refuses an expiry more than 90 days out', refused(() => core.admitPolicy(doc({ expiresAt: iso(NOW.getTime() + 91 * 86_400_000) }), NOW)) === 'expiry_too_far');
  check('admitPolicy refuses an expiry in the past', refused(() => core.admitPolicy(doc({ expiresAt: iso(NOW.getTime() - 1000) }), NOW)) === 'policy_expired');
  check('admitPolicy refuses a canary ring of two computers', refused(() => core.admitPolicy(doc({ rings: [[CANARY, R1A]] }), NOW)) === 'bad_rings');
  check('admitPolicy refuses a computer in two rings', refused(() => core.admitPolicy(doc({ rings: [[CANARY], [CANARY, R1A]] }), NOW)) === 'bad_rings');
  check('admitPolicy refuses a driver classification', refused(() => core.admitPolicy(doc({ allow: { classifications: ['ebfc1fc5-71a4-4f7b-9aca-3b9a503104a0'] } }), NOW)) === 'invalid_policy');
  check('admitPolicy refuses an unknown timezone', refused(() => core.admitPolicy(doc({ window: { days: ['sat'], start: '22:00', end: '04:00', timezone: 'Mars/Olympus_Mons' } }), NOW)) === 'invalid_policy');
  check('admitPolicy refuses a reboot rule (0.32 never restarts)', refused(() => core.admitPolicy(doc({ reboot: 'in_window' }), NOW)) === 'invalid_policy');
  check('admitPolicy refuses a window that never opens before expiry', refused(() => core.admitPolicy(doc({ window: { days: ['sat'], start: '22:00', end: '23:00', timezone: 'UTC' }, expiresAt: iso(NOW.getTime() + 3600_000) }), NOW)) === 'window_never_opens');
  check('admitPolicy refuses a field it does not know', refused(() => core.admitPolicy({ ...doc(), extraComputers: [OTHER] }, NOW)) === 'invalid_policy');

  let r = fresh();
  check('the author cannot approve their own policy', refused(() => core.recordPolicyDecision(r, author, 'approver', 'approve', NOW, false)) === 'requester_cannot_approve');
  check('an approver for another business cannot approve it', refused(() => core.recordPolicyDecision(r, birchOnly, 'approver', 'approve', NOW, false)) === 'not_authorized');
  check('a disabled roster member cannot approve it', refused(() => core.recordPolicyDecision(r, { ...quinn, disabled: true }, 'approver', 'approve', NOW, false)) === 'not_authorized');
  check('one approval is not the quorum', core.recordPolicyDecision(r, olivia, 'approver', 'approve', NOW, false) === 'AWAITING_APPROVAL');
  check('the same person twice is refused', refused(() => core.recordPolicyDecision(r, olivia, 'approver', 'approve', NOW, false)) === 'already_decided');
  check('a second approver makes the quorum', core.recordPolicyDecision(r, quinn, 'approver', 'approve', NOW, false) === 'ACTIVE');
  core.signPolicy(r, k, NOW);
  check('the signer\'s signature over the approved policy verifies', r.status === 'ACTIVE' && core.verifyPolicy(r, pub));
  const tampered = { ...r, doc: { ...r.doc, rings: [[CANARY], [R1A, R1B, OTHER]] } };
  check('a policy file edited on disk to add a computer no longer verifies', !core.verifyPolicy(tampered, pub));
  const forgedApproval = { ...r, decisions: [...r.decisions.slice(0, 1)] };
  check('a policy file edited on disk to drop an approval no longer verifies', !core.verifyPolicy(forgedApproval, pub));
  const notMine = generateKeyPairSync('ed25519').publicKey;
  check('the signature does not verify under another key', !core.verifyPolicy(r, notMine));

  const cs = fresh();
  core.recordPolicyDecision(cs, olivia, 'approver', 'approve', NOW, true);
  check('with customer sign-off required, two approvers are not enough', core.recordPolicyDecision(cs, quinn, 'approver', 'approve', NOW, true) === 'AWAITING_APPROVAL');
  check('…and a customer\'s sign-off completes it', core.recordPolicyDecision(cs, member('user_cust0001', 'Cara', [], [BIZ]), 'customer', 'approve', NOW, true) === 'ACTIVE');

  const rej = fresh();
  core.recordPolicyDecision(rej, olivia, 'approver', 'reject', NOW, false);
  check('a rejection is final', rej.status === 'REJECTED' && refused(() => core.recordPolicyDecision(rej, quinn, 'approver', 'approve', NOW, false)) === 'not_awaiting');
  const old = fresh();
  check('a proposal nobody approved within 7 days lapses', core.effectivePolicyStatus(old, new Date(NOW.getTime() + 8 * 86_400_000)) === 'EXPIRED'
    && refused(() => core.recordPolicyDecision(old, olivia, 'approver', 'approve', new Date(NOW.getTime() + 8 * 86_400_000), false)) === 'not_awaiting');
  check('an approved policy expires on its own date', core.effectivePolicyStatus(r, new Date(Date.parse(r.doc.expiresAt))) === 'EXPIRED');
  check('a revoked policy is revoked whatever else its record says', core.effectivePolicyStatus({ ...r, revokedAt: iso(NOW) }, NOW) === 'REVOKED');

  // Signing a plan under it, as the internal route does.
  const d = r.doc;
  const p0 = plan(d);
  const { job, entry } = core.signUnderPolicy(r, { plan: p0, policyDigest: r.digest, evidence: null }, k, business, NOW);
  const env = job.envelope;
  const bytes = Buffer.from(env.plan, 'base64');
  const signedPlan = JSON.parse(bytes.toString('utf8'));
  check('a canary inside the policy is signed at once, without a further approval', job.status === 'SIGNED' && verify(null, Buffer.concat([Buffer.from(PLAN_SIGNING_PREFIX), bytes]), pub, Buffer.from(env.sig, 'base64')));
  check('its approvers are the policy\'s two approvers, and not its requester (as the agent checks)',
    signedPlan.approvers.length === 2 && signedPlan.approvers.every((a) => a.role === 'approver' && a.userId !== signedPlan.requestedBy.userId) && new Set(signedPlan.approvers.map((a) => a.userId)).size === 2);
  check('the ledger records it', r.ledger.length === 1 && entry.jobId === p0.jobId && entry.ring === 0 && entry.endpointIds[0] === CANARY.endpointId);
  check('the same ring again while it is open → ring_already_signed', refused(() => core.signUnderPolicy(r, { plan: plan(d), policyDigest: r.digest }, k, business, NOW)) === 'ring_already_signed');
  check('a plan the agent would refuse anyway (risk understated) is refused before the policy is consulted',
    refused(() => { const x = plan(d); x.policy = { risk: 'low', approvalsRequired: 1, customerSignoff: false }; core.signUnderPolicy(r, { plan: x, policyDigest: r.digest }, k, business, NOW); }) === 'risk_mismatch');
  check('malformed evidence is refused, not ignored', refused(() => core.signUnderPolicy(r, { plan: plan(d, { ring: 1, computers: [R1A] }), policyDigest: r.digest, evidence: { previousJobId: 'x' } }, k, business, NOW)) === 'bad_evidence');
  check('a tampered policy file signs nothing → policy_signature_invalid', refused(() => core.signUnderPolicy({ ...tampered, ledger: [] }, { plan: plan(tampered.doc, { ring: 1, computers: [OTHER] }), policyDigest: tampered.digest }, k, business, NOW)) === 'policy_signature_invalid');
  check('a revoked policy signs nothing → policy_revoked', refused(() => core.signUnderPolicy({ ...r, ledger: [], revokedAt: iso(NOW) }, { plan: plan(d, { dep: 'dep_acme_0002' }), policyDigest: r.digest }, k, business, NOW)) === 'policy_revoked');
}

if (failures.length) {
  console.error(`✗ ${failures.length} failed, ${passed} passed`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ ${passed} patch-policy checks passed`);
