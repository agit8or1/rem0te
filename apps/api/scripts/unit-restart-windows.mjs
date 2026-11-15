#!/usr/bin/env node
// Restart scheduling and restart windows (0.54), run against dist:
//
//   node apps/api/scripts/unit-restart-windows.mjs
//
// The closed restart flags on windows.reboot.schedule@1 (onlyIfRequired and
// the owner's RustDesk-session exception, ignoreRemoteSession), each present
// only as exactly `true`; a patch policy's restart window and rule
// (if_required / always) in the signed document, fail-closed; the signer's
// evaluation of a restart plan under a policy — inside the restart window,
// the fixed 15-minute warning, the rule's own flags, the exception only when
// the policy has it, one open plan and at most three per computer per
// window; the same exception on an update install's in-window restart; the
// words the policy list shows; and pre-0.54 documents keeping their digest.
// No database, no network.

import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const dist = join(here, '..', 'dist');
const P = require(join(dist, 'actions', 'patch-policy.js'));
const C = require(join(dist, 'actions', 'catalog.js'));
const S = require(join(dist, 'common', 'schedule.js'));
const L = require(join(dist, 'tasks', 'lifecycle.js'));
const page = require(join(dist, 'approval-signer', 'page.js'));
let B = null;
try { B = require(join(dist, 'actions', 'restart-bulk.js')); } catch { /* checked below */ }

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => { if (ok) passed++; else failures.push(`${name}${detail ? ` — ${detail}` : ''}`); };
const iso = (t) => new Date(t).toISOString();
const sha = (s) => createHash('sha256').update(s).digest('hex');
const hex = (n) => randomBytes(n).toString('hex');
const code = (r) => (r.ok ? 'ok' : r.code);

// ── The catalog: two closed flags, exactly true ─────────────────────────────
{
  const ok = (p) => C.REBOOT_SCHEDULE.params.safeParse(p).success;
  check('a restart still parses with only its delay (pre-0.54 plans keep their bytes)', ok({ delayMinutes: 15 }));
  check('onlyIfRequired: true and ignoreRemoteSession: true parse, alone and together',
    ok({ delayMinutes: 15, onlyIfRequired: true }) && ok({ delayMinutes: 15, ignoreRemoteSession: true }) && ok({ delayMinutes: 5, onlyIfRequired: true, ignoreRemoteSession: true }));
  check('false, a string, a number or null is refused for either flag (present only when true)',
    [false, 'true', 1, null].every((v) => !ok({ delayMinutes: 15, onlyIfRequired: v }) && !ok({ delayMinutes: 15, ignoreRemoteSession: v })));
  check('any other key is refused (strict)', !ok({ delayMinutes: 15, force: true }) && !ok({ delayMinutes: 15, ignoreSignedInUser: true }) && !ok({ delayMinutes: 15, ignoreRemoteSessions: true }));
  check('the delay floor and ceiling hold', !ok({ delayMinutes: 4 }) && !ok({ delayMinutes: 1441 }) && !ok({ delayMinutes: 0, ignoreRemoteSession: true }));
  check('the flags are the same pair the agent knows', JSON.stringify(C.RESTART_FLAGS) === JSON.stringify(['onlyIfRequired', 'ignoreRemoteSession']));
  check('restartFlagsUsed names every flag present (an older agent refuses any of them, whatever the value)',
    JSON.stringify(C.restartFlagsUsed({ delayMinutes: 15 })) === '[]' && JSON.stringify(C.restartFlagsUsed({ delayMinutes: 15, ignoreRemoteSession: true })) === '["ignoreRemoteSession"]'
      && JSON.stringify(C.restartFlagsUsed({ delayMinutes: 15, onlyIfRequired: false })) === '["onlyIfRequired"]');
  check('the flags need a 0.54 agent', C.RESTART_FLAGS_MIN_AGENT === '0.54.0');
  const upd = (p) => C.UPDATE_INSTALL.params.safeParse({ updates: [{ updateId: '5a1b2c3d-0000-4000-8000-000000000001', revision: 1 }], ...p }).success;
  check('an update install may carry the exception only beside the in-window restart rule',
    upd({ reboot: 'if_required_in_window', ignoreRemoteSession: true }) && !upd({ reboot: 'never', ignoreRemoteSession: true }) && !upd({ reboot: 'if_required_in_window', ignoreRemoteSession: false }));
  check('…and an update install without it is unchanged', upd({ reboot: 'never' }) && upd({ reboot: 'if_required_in_window' }));
  check('the signed-in user note says plainly that a signed-in user does not stop it',
    C.SIGNED_IN_USER_NOTE === 'A signed-in user does not stop the restart. They see the 15-minute warning, and unsaved work is lost.');
  check('the exception label says the session is dropped', C.IGNORE_REMOTE_SESSION_LABEL === 'Restart even if a technician is connected through RustDesk (their session is dropped)');
  const words = [...C.REBOOT_SCHEDULE.warnings, ...C.UPDATE_INSTALL.warnings].join(' ');
  check('no restart warning says "someone is connected" or "signed in" stops a restart', !/someone is connected|while someone|nobody is signed in/i.test(words) && /technician is connected through RustDesk/.test(words), words.slice(0, 200));
}

// ── Scheduling a restart at a time ──────────────────────────────────────────
{
  const now = new Date('2026-11-15T10:00:00Z');
  const at = S.scheduledStart({ local: '2026-11-16T22:30', timeZone: 'America/New_York' }, now, 'A restart');
  check('a restart at 22:30 New York is 03:30Z the next day', at.toISOString() === '2026-11-17T03:30:00.000Z', at.toISOString());
  let msg = '';
  try { S.scheduledStart({ local: '2026-12-01T10:00', timeZone: 'UTC' }, now, 'A restart'); } catch (e) { msg = e.getResponse?.().message ?? String(e); }
  check('more than 14 days ahead is refused, pointing at the restart window', /A restart can be scheduled at most 14 days ahead.*restart window/.test(msg), msg);
  msg = '';
  try { S.scheduledStart({ local: '2026-11-15T09:00', timeZone: 'UTC' }, now, 'A restart'); } catch (e) { msg = e.getResponse?.().code ?? String(e); }
  check('a time in the past is refused (SCHEDULE_IN_PAST)', msg === 'SCHEDULE_IN_PAST', msg);
  check('MAX_SCHEDULE_DAYS is still 14', S.MAX_SCHEDULE_DAYS === 14);
}

// ── Bulk ────────────────────────────────────────────────────────────────────
if (B) {
  const ok = (p) => B.BulkRestart.safeParse(p).success;
  check('bulk restart: the warning, an optional time and the two closed flags', ok({ delayMinutes: 15 }) && ok({ delayMinutes: 15, restartAt: { local: '2026-11-16T22:00', timeZone: 'UTC' }, onlyIfRequired: true, ignoreRemoteSession: true }));
  check('bulk restart: nothing else, and the flags only as true', !ok({ delayMinutes: 15, ignoreRemoteSession: false }) && !ok({ delayMinutes: 15, actionId: 'windows.script.run' }) && !ok({ delayMinutes: 2 }));
} else check('restart-bulk.js loads from dist', false);

// ── A policy with a restart window ──────────────────────────────────────────
const BIZ = 'biz_restart_001';
const DEV = (name) => ({ endpointId: `ep_${name.toLowerCase()}_0001`, hostname: name, rustdeskId: String(100000000 + Math.floor(Math.random() * 8e8)), deviceSecretSha256: sha(name) });
// Ring 0's results open ring 1, so the canary carries a result key (§ 38); the base64 of 32 bytes is enough here.
const CANARY = { ...DEV('CANARY'), resultKey: randomBytes(32).toString('base64') };
const R1 = DEV('RING1');
const OTHER = DEV('OTHER');
const AUTHOR = { userId: 'user_author01', name: 'Owen' };
const SEC = '0fa1201d-4330-4fa8-8ae9-b877473b6441';
// Sunday 15 November 2026. The install window is Saturday night; the restart window is Sunday 02:00–04:00 UTC.
const NOW = new Date('2026-11-15T02:10:00Z');
const RW = { days: ['sun'], start: '02:00', end: '04:00', timezone: 'UTC' };
function doc(over = {}) {
  return {
    schema: 'rem0te-patch-policy/1', policyId: hex(16), name: 'Acme, Saturday night', businessId: BIZ, businessName: 'Acme',
    rings: [[CANARY], [R1]], allow: { classifications: [SEC] }, soakHours: 0, failureThreshold: 0,
    window: { days: ['sat'], start: '22:00', end: '04:00', timezone: 'America/New_York' }, reboot: 'never',
    createdAt: iso(NOW.getTime() - 3600_000), expiresAt: iso(NOW.getTime() + 30 * 86_400_000), createdBy: AUTHOR, reason: 'Weekly',
    ...over,
  };
}
const approvals = [
  { userId: 'user_olivia01', name: 'Olivia', role: 'approver', credentialSha256: sha('o'), at: iso(NOW.getTime() - 1800_000) },
  { userId: 'user_quinn001', name: 'Quinn', role: 'approver', credentialSha256: sha('q'), at: iso(NOW.getTime() - 1700_000) },
];
const state = (d, over = {}) => ({ doc: d, digest: P.policyDigest(d), status: 'ACTIVE', approvals, signatureValid: true, revokedAt: null, ledger: [], ...over });
function restartPlan(d, { c = CANARY, params = { delayMinutes: 15, onlyIfRequired: true }, nb = NOW, mins = 60, over = {} } = {}) {
  return {
    schema: 'rem0te-action-plan/1', jobId: hex(16), action: { id: 'windows.reboot.schedule', version: 1 },
    artifact: { target: 'windows/rem0te-agent.exe', sha256: sha('agent') }, params,
    targets: [{ endpointId: c.endpointId, businessId: BIZ, businessName: 'Acme', hostname: c.hostname, deviceClass: 'WORKSTATION', rustdeskId: c.rustdeskId, deviceSecretSha256: c.deviceSecretSha256 }],
    requestedBy: { ...AUTHOR, via: 'portal' }, origin: { kind: 'technician', ticketRef: null },
    reason: `Patch policy "${d.name}", restart window`, policy: { risk: 'high', approvalsRequired: 2, customerSignoff: false },
    window: { notBefore: iso(nb), notAfter: iso(nb.getTime() + mins * 60_000) },
    display: { updates: [], deployment: null, policy: { id: d.policyId, name: d.name, digest: P.policyDigest(d) } },
    createdAt: iso(NOW), approvers: [], signedAt: null, ...over,
  };
}
const evaluate = (s, p, now = NOW) => P.evaluatePolicyPlan(s, { plan: p, policyDigest: s.digest, evidence: null }, { now, customerSignoff: false });

{
  const ok = (r) => P.PolicyRestart.safeParse(r).success;
  check('a restart rule is if_required or always, with a window', ok({ rule: 'if_required', window: RW }) && ok({ rule: 'always', window: { kind: 'monthly', week: 'second', weekday: 'tue', offsetDays: 2, start: '02:00', end: '04:00', timezone: 'UTC' } }));
  check('any other rule, a missing window or an extra key is refused', !ok({ rule: 'never', window: RW }) && !ok({ rule: 'if_required' }) && !ok({ rule: 'always', window: RW, every: 2 }) && !ok({ rule: 'sometimes', window: RW }));
  check('restartRuleOf fails closed on an unknown rule', P.restartRuleOf({ restart: { rule: 'if_required', window: RW } }) === 'if_required' && P.restartRuleOf({ restart: { rule: 'weekly', window: RW } }) === null && P.restartRuleOf({}) === null);

  const d = doc({ restart: { rule: 'if_required', window: RW } });
  check('a policy with a restart window parses and validates', P.PolicyDoc.safeParse(d).success && P.validatePolicyDoc(d, NOW).ok, JSON.stringify(P.validatePolicyDoc(d, NOW)));
  const never = doc({ restart: { rule: 'if_required', window: { kind: 'monthly', day: 1, start: '02:00', end: '04:00', timezone: 'UTC' } }, expiresAt: iso(NOW.getTime() + 10 * 86_400_000) });
  check('a restart window that never opens before expiry → restart_window_never_opens', P.validatePolicyDoc(never, NOW).reason === 'restart_window_never_opens', JSON.stringify(P.validatePolicyDoc(never, NOW)));
  check('the exception with nothing that restarts → override_without_restart', P.validatePolicyDoc(doc({ ignoreRemoteSession: true }), NOW).reason === 'override_without_restart');
  check('…but with the in-window rule, or a restart window, it is allowed',
    P.validatePolicyDoc(doc({ reboot: 'if_required_in_window', ignoreRemoteSession: true }), NOW).ok && P.validatePolicyDoc(doc({ restart: { rule: 'always', window: RW }, ignoreRemoteSession: true }), NOW).ok);
  check('the exception is exactly true in the document', !P.PolicyDoc.safeParse(doc({ reboot: 'if_required_in_window', ignoreRemoteSession: false })).success);

  // Words.
  check('the schedule in plain words',
    P.scheduleInWords(d) === 'Installs: Saturdays 22:00–04:00 America/New_York · Restarts: if required, Sundays 02:00–04:00 UTC', P.scheduleInWords(d));
  check('…a maintenance restart and the in-window rule together', /^every restart window \(maintenance restart\), Sundays 02:00–04:00 UTC; also if required in the install window/.test(P.restartInWords({ reboot: 'if_required_in_window', restart: { rule: 'always', window: RW } })), P.restartInWords({ reboot: 'if_required_in_window', restart: { rule: 'always', window: RW } }));
  check('…and never', /never/i.test(P.restartInWords({ reboot: 'never' })), P.restartInWords({ reboot: 'never' }));
  check('…the exception is said', /RustDesk/.test(P.restartInWords({ reboot: 'never', restart: { rule: 'if_required', window: RW }, ignoreRemoteSession: true })));

  // The signer's evaluation.
  const s = state(d);
  check('a restart plan inside the restart window, for a computer in the policy, is signed', evaluate(s, restartPlan(d)).ok, JSON.stringify(evaluate(s, restartPlan(d))));
  check('…for a later-ring computer too (a restart window covers every computer in the policy)', evaluate(s, restartPlan(d, { c: R1 })).ok);
  check('a computer not in the policy → computer_not_in_policy', code(evaluate(s, restartPlan(d, { c: OTHER }))) === 'computer_not_in_policy');
  check('a re-enrolled computer (identity differs) → computer_not_in_policy', code(evaluate(s, restartPlan(d, { c: { ...CANARY, deviceSecretSha256: sha('new') } }))) === 'computer_not_in_policy');
  check('two computers in one plan → computer_not_in_policy', code(evaluate(s, (() => { const p = restartPlan(d); p.targets.push({ ...p.targets[0], endpointId: R1.endpointId }); return p; })())) === 'computer_not_in_policy');
  check('a restart that would happen after the window closes → outside_restart_window', code(evaluate(s, restartPlan(d, { mins: 100 }))) === 'outside_restart_window');
  check('…the last plan that fits is signed (received by 03:45, restarted by 04:00)', evaluate(s, restartPlan(d, { mins: 95 })).ok);
  const sat = new Date('2026-11-14T02:10:00Z');
  check('Saturday at the same hour (outside the restart window) → outside_restart_window', code(evaluate(s, restartPlan(d, { nb: sat }), sat)) === 'outside_restart_window');
  const wide = doc({ restart: { rule: 'always', window: { ...RW, start: '00:00', end: '06:00' } } });
  check('a plan longer than 2 hours → outside_restart_window', code(evaluate(state(wide), restartPlan(wide, { params: { delayMinutes: 15 }, mins: 150 }))) === 'outside_restart_window'
    && evaluate(state(wide), restartPlan(wide, { params: { delayMinutes: 15 }, mins: 120 })).ok);
  check('a 30-minute warning (not the fixed 15) → restart_params_not_allowed', code(evaluate(s, restartPlan(d, { params: { delayMinutes: 30, onlyIfRequired: true } }))) === 'restart_params_not_allowed');
  check('"if required" without onlyIfRequired (the portal deciding alone) → restart_params_not_allowed', code(evaluate(s, restartPlan(d, { params: { delayMinutes: 15 } }))) === 'restart_params_not_allowed');
  const always = doc({ restart: { rule: 'always', window: RW } });
  check('a maintenance restart is signed without onlyIfRequired', evaluate(state(always), restartPlan(always, { params: { delayMinutes: 15 } })).ok);
  check('…and refused with it (the rule is the policy\'s, not the plan\'s)', code(evaluate(state(always), restartPlan(always))) === 'restart_params_not_allowed');
  check('the exception under a policy without it → override_not_allowed', code(evaluate(s, restartPlan(d, { params: { delayMinutes: 15, onlyIfRequired: true, ignoreRemoteSession: true } }))) === 'override_not_allowed');
  const withOv = doc({ restart: { rule: 'if_required', window: RW }, ignoreRemoteSession: true });
  check('…and signed under a policy that has it', evaluate(state(withOv), restartPlan(withOv, { params: { delayMinutes: 15, onlyIfRequired: true, ignoreRemoteSession: true } })).ok);
  check('a policy with the exception may still sign a plan without it', evaluate(state(withOv), restartPlan(withOv)).ok);
  check('a policy with no restart window signs no restart → restart_not_in_policy', code(evaluate(state(doc()), restartPlan(doc()))) === 'restart_not_in_policy');
  const bad = { ...d, restart: { rule: 'weekly', window: RW } };
  check('an unknown restart rule in a stored document signs nothing → restart_rule_unknown', code(evaluate(state(bad), restartPlan(bad))) === 'restart_rule_unknown');
  check('a restart plan naming a deployment or an update → bad_display',
    code(evaluate(s, restartPlan(d, { over: { display: { updates: [], deployment: { id: 'dep_x', name: 'x', ring: 0, rings: 1 }, policy: { id: d.policyId, name: d.name, digest: P.policyDigest(d) } } } }))) === 'bad_display');
  check('a restart plan naming another policy → bad_display', code(evaluate(s, restartPlan(d, { over: { display: { updates: [], deployment: null, policy: { id: hex(16), name: 'x', digest: P.policyDigest(d) } } } }))) === 'bad_display');
  check('a restart plan requested by someone else → requester_mismatch', code(evaluate(s, restartPlan(d, { over: { requestedBy: { userId: 'user_mallory', name: 'M', via: 'portal' } } }))) === 'requester_mismatch');
  check('a restart plan with evidence → bad_evidence', code(P.evaluatePolicyPlan(s, { plan: restartPlan(d), policyDigest: s.digest, evidence: { ring: 0 } }, { now: NOW, customerSignoff: false })) === 'bad_evidence');
  check('a revoked policy signs no restart', code(evaluate(state(d, { revokedAt: iso(NOW) }), restartPlan(d))) === 'policy_revoked');
  check('another action under the restart path is not possible (version 2) → action_not_in_policy', code(evaluate(s, restartPlan(d, { over: { action: { id: 'windows.reboot.schedule', version: 2 } } }))) === 'action_not_in_policy');

  // The ledger: one open plan, at most three per window.
  const key = '2026-11-15T02:00:00.000Z';
  const entry = (notAfter, ep = CANARY.endpointId) => ({ jobId: hex(16), kind: 'restart', restartWindow: key, deploymentId: `restart:${key}`, ring: 0, signedAt: iso(NOW), notBefore: iso(NOW), notAfter, endpointIds: [ep], updates: [], planSha256: sha('x') });
  check('a second restart while the first plan is open → restart_already_signed', code(evaluate(state(d, { ledger: [entry(iso(NOW.getTime() + 600_000))] }), restartPlan(d))) === 'restart_already_signed');
  check('…once it has closed (deferred), a retry is signed', evaluate(state(d, { ledger: [entry(iso(NOW.getTime() - 60_000))] }), restartPlan(d)).ok);
  const closed = [1, 2, 3].map(() => entry(iso(NOW.getTime() - 60_000)));
  check('a fourth in one window → restart_retry_limit', code(evaluate(state(d, { ledger: closed }), restartPlan(d))) === 'restart_retry_limit');
  check('another computer\'s restarts do not count', evaluate(state(d, { ledger: closed }), restartPlan(d, { c: R1 })).ok);
  const next = new Date('2026-11-22T02:10:00Z');
  check('the next restart window starts again', evaluate(state(d, { ledger: closed }), restartPlan(d, { nb: next }), next).ok);
  check('restart entries never count as a ring for the install path', P.MAX_RESTART_ATTEMPTS === 3 && P.POLICY_RESTART_DELAY_MINUTES === 15);

  // The approval page names the restart window, the signed-in note and the exception.
  const html = page.renderPolicyApprovalPage({ policyId: withOv.policyId, status: 'AWAITING_APPROVAL', digest: P.policyDigest(withOv), doc: withOv, decisions: [], revokedAt: null, revokeReason: null, signedPlans: 0 }, 'n0nce');
  check('the approval page states the restart window, the signed-in note and the exception',
    /restart window/i.test(html) && /A signed-in user does not stop the restart/.test(html) && /technician is connected through RustDesk/.test(html), html.match(/<ul>[\s\S]*?<\/ul>/)?.[0]?.slice(0, 400));
}

// ── The exception on an update install's in-window restart, under a policy ──
{
  const installPlan = (d, params) => ({
    schema: 'rem0te-action-plan/1', jobId: hex(16), action: { id: 'windows.update.install', version: 1 },
    artifact: { target: 'windows/rem0te-agent.exe', sha256: sha('agent') },
    params: { updates: [{ updateId: '5a1b2c3d-0000-4000-8000-000000000001', revision: 1 }], allow: P.allowParams(d.allow), ...params },
    targets: [{ endpointId: CANARY.endpointId, businessId: BIZ, businessName: 'Acme', hostname: 'CANARY', deviceClass: 'WORKSTATION', rustdeskId: CANARY.rustdeskId, deviceSecretSha256: CANARY.deviceSecretSha256 }],
    requestedBy: { ...AUTHOR, via: 'portal' }, origin: { kind: 'technician', ticketRef: null }, reason: 'ring 0', policy: { risk: 'high', approvalsRequired: 2, customerSignoff: false },
    window: { notBefore: '2026-11-15T03:10:00.000Z', notAfter: '2026-11-15T05:00:00.000Z' },
    display: { updates: [{ updateId: '5a1b2c3d-0000-4000-8000-000000000001', revision: 1, kb: 'KB1', title: 'x', className: 'Security Updates', severity: 'Critical' }], deployment: { id: 'dep_1', name: 'x', ring: 0, rings: 2 }, policy: { id: d.policyId, name: d.name, digest: P.policyDigest(d) } },
    createdAt: iso(NOW), approvers: [], signedAt: null,
  });
  const inWin = doc({ reboot: 'if_required_in_window' });
  const at = new Date('2026-11-15T03:10:00Z');
  const ev = (d, p) => P.evaluatePolicyPlan(state(d), { plan: p, policyDigest: P.policyDigest(d), evidence: null }, { now: at, customerSignoff: false });
  check('an install ring with the exception under a policy without it → override_not_allowed', code(ev(inWin, installPlan(inWin, { reboot: 'if_required_in_window', ignoreRemoteSession: true }))) === 'override_not_allowed');
  const inWinOv = doc({ reboot: 'if_required_in_window', ignoreRemoteSession: true });
  check('…and not refused for it under a policy that has it', code(ev(inWinOv, installPlan(inWinOv, { reboot: 'if_required_in_window', ignoreRemoteSession: true }))) !== 'override_not_allowed', code(ev(inWinOv, installPlan(inWinOv, { reboot: 'if_required_in_window', ignoreRemoteSession: true }))));
  check('an install ring without the exception under a policy with it is still fine (it only narrows)', code(ev(inWinOv, installPlan(inWinOv, { reboot: 'if_required_in_window' }))) !== 'override_not_allowed');
}

// ── Tasks wording ───────────────────────────────────────────────────────────
{
  check('Tasks says a deferral was a RustDesk session, never "someone signed in"',
    /technician was connected through RustDesk/.test(L.RESTART_REASON_TEXT.remote_session_open ?? '') && !/signed in|logged on/i.test(Object.values(L.RESTART_REASON_TEXT).join(' ')));
  check('Tasks says when the exception was used', L.OVERRIDE_TEXT === 'restarted although a technician was connected through RustDesk');
}

// ── Pre-0.54 documents are unchanged ────────────────────────────────────────
{
  // The 0.52 golden weekly document (unit-monthly-window.mjs): its digest must not move.
  const golden = {
    schema: 'rem0te-patch-policy/1', policyId: '0123456789abcdef0123456789abcdef', name: 'Golden weekly', businessId: 'biz_golden_01', businessName: 'Golden',
    rings: [[{ endpointId: 'ep_golden_canary', hostname: 'CANARY', rustdeskId: '123456789', deviceSecretSha256: 'a'.repeat(64) }]],
    allow: { classifications: [SEC] }, soakHours: 24, failureThreshold: 0,
    window: { days: ['sat', 'sun'], start: '22:00', end: '04:00', timezone: 'America/Chicago' }, reboot: 'never',
    createdAt: '2026-11-15T00:00:00.000Z', expiresAt: '2026-12-15T00:00:00.000Z', createdBy: { userId: 'user_golden01', name: 'G' }, reason: 'golden weekly',
  };
  const parsed = P.PolicyDoc.parse(golden);
  check('a pre-0.54 document parses to exactly its own bytes (no restart or exception is added)', JSON.stringify(parsed) === JSON.stringify(golden) && !('restart' in parsed) && !('ignoreRemoteSession' in parsed));
  check('…and its digest is the one the 0.52 signer computed', P.policyDigest(parsed) === '466423a5bb889e289b536d62ac25ddf66450179770f1161c576003fc3644f99b', P.policyDigest(parsed));
  check('a restart window changes the digest (it is signed)', P.policyDigest({ ...parsed, restart: { rule: 'if_required', window: RW } }) !== P.policyDigest(parsed));
}

if (failures.length) {
  console.error(`unit-restart-windows: ${failures.length} failed, ${passed} passed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`unit-restart-windows: ${passed} passed`);
