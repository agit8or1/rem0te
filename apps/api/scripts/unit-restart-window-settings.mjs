#!/usr/bin/env node
// The simple restart window (0.60), run against dist:
//
//   cd apps/api && npx nest build && node scripts/unit-restart-window-settings.mjs
//
// The restart task in the shared automation document
// (actions/automation-policy.ts): its closed shape and params, which targets
// and schedules it may have, and the signer's decision about every restart
// plan (evaluateAutomationRestart through evaluateAutomationPlan), refusal by
// refusal, with the per-computer ledger. Then which window governs a computer
// (restart-windows/resolve.ts): computer > group (priority) > business, "no
// automatic restarts", a window not yet approved falling through, and when a
// restart is asked for again. Then the signer's approval page for a restart
// window. No database, no portal, no signer process.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const dist = join(here, '..', 'dist');
const A = require(join(dist, 'actions', 'automation-policy.js'));
const P = require(join(dist, 'actions', 'patch-policy.js'));
const C = require(join(dist, 'actions', 'catalog.js'));
const R = require(join(dist, 'restart-windows', 'resolve.js'));
const { canonicalJson } = require(join(dist, 'integration', 'crypto.js'));
const page = require(join(dist, 'approval-signer', 'page.js'));

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => { if (ok) passed++; else failures.push(`${name}${detail ? ` — ${detail}` : ''}`); };
const hex = (n) => randomBytes(n).toString('hex');
const code = (r) => (r.ok ? 'ok' : r.code);

const BIZ = 'biz_acme_0001', OTHER = 'biz_birch_0001';
const AUTHOR = { userId: 'user_setter01', name: 'Sam (L3)' };
const PC = { endpointId: 'ep_dewey_wks22', hostname: 'DEWEY-WKS2022', rustdeskId: '123456789', deviceSecretSha256: 'b'.repeat(64) };
const PC2 = { endpointId: 'ep_frontdesk_1', hostname: 'FRONTDESK', rustdeskId: '223456789', deviceSecretSha256: 'c'.repeat(64) };
const hhmm = (t) => `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`;
const ALL = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
// A daily window open now: from an hour ago to two hours ahead, UTC.
const openNow = () => ({ days: ALL, start: hhmm(new Date(Date.now() - 60 * 60_000)), end: hhmm(new Date(Date.now() + 120 * 60_000)), timezone: 'UTC' });
const NIGHTLY = { days: ALL, start: '02:00', end: '04:00', timezone: 'America/Chicago' };

function doc(over = {}) {
  const now = Date.now();
  return {
    schema: A.AUTOMATION_SCHEMA, policyId: hex(16), name: 'Restart window — Acme', businessId: BIZ, businessName: 'Acme',
    task: { kind: 'restart', rule: 'if_required' },
    targets: { kind: 'business' },
    recurrence: openNow(), offline: { mode: 'run_when_online' }, maxRunsPerOccurrence: 3,
    createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 90 * 86_400_000).toISOString(),
    createdBy: AUTHOR, reason: 'Restart window set for the business from the console', ...over,
  };
}
const target = (c, biz = BIZ) => ({ endpointId: c.endpointId, businessId: biz, businessName: 'Acme', hostname: c.hostname, deviceClass: 'WORKSTATION', rustdeskId: c.rustdeskId, deviceSecretSha256: c.deviceSecretSha256 });
function planFor(d, digest, { targets = [target(PC)], notBefore = new Date(), notAfter = new Date(Date.now() + 15 * 60_000), params, ...over } = {}) {
  return {
    schema: 'rem0te-action-plan/1', jobId: hex(16), action: { id: 'windows.reboot.schedule', version: 1 },
    artifact: { target: 'windows/rem0te-agent.exe', sha256: 'a'.repeat(64) },
    params: params ?? A.restartParamsFor(d.task), targets,
    requestedBy: { userId: d.createdBy.userId, name: d.createdBy.name, via: 'portal' },
    origin: { kind: 'technician', ticketRef: null }, reason: `${d.name}, window`,
    policy: { risk: 'high', approvalsRequired: 2, customerSignoff: false },
    window: { notBefore: new Date(notBefore).toISOString(), notAfter: new Date(notAfter).toISOString() },
    display: { updates: [], deployment: null, policy: { id: d.policyId, name: d.name, digest } },
    createdAt: new Date().toISOString(), approvers: [], signedAt: null, ...over,
  };
}

// ── The restart task ────────────────────────────────────────────────────────
{
  const T = (t) => A.RestartTask.safeParse(t).success;
  check('a restart task is "if_required" or "always", nothing else', T({ kind: 'restart', rule: 'if_required' }) && T({ kind: 'restart', rule: 'always' }) && !T({ kind: 'restart', rule: 'sometimes' }) && !T({ kind: 'restart' }));
  check('the RustDesk exception is present only when true', T({ kind: 'restart', rule: 'always', ignoreRemoteSession: true }) && !T({ kind: 'restart', rule: 'always', ignoreRemoteSession: false }));
  check('the task is strict: no delay, no command, no other key', !T({ kind: 'restart', rule: 'always', delayMinutes: 5 }) && !T({ kind: 'restart', rule: 'always', command: 'shutdown /r' }));
  check('its plans are windows.reboot.schedule@1', JSON.stringify(A.taskAction({ kind: 'restart' })) === JSON.stringify({ id: 'windows.reboot.schedule', version: 1 }));
  check('if required: the fixed 15-minute warning and onlyIfRequired', JSON.stringify(A.restartParamsFor({ rule: 'if_required' })) === JSON.stringify({ delayMinutes: 15, onlyIfRequired: true }));
  check('always: the fixed warning only', JSON.stringify(A.restartParamsFor({ rule: 'always' })) === JSON.stringify({ delayMinutes: 15 }));
  check('the exception is added only when ticked', JSON.stringify(A.restartParamsFor({ rule: 'always', ignoreRemoteSession: true })) === JSON.stringify({ delayMinutes: 15, ignoreRemoteSession: true }));
  check('the params are ones windows.reboot.schedule itself accepts', [A.restartParamsFor({ rule: 'if_required', ignoreRemoteSession: true }), A.restartParamsFor({ rule: 'always' })].every((p) => C.REBOOT_SCHEDULE.params.safeParse(p).success));
  check('the warning is the update restart\'s 15 minutes', A.RESTART_WINDOW_DELAY_MINUTES === 15 && A.RESTART_WINDOW_DELAY_MINUTES === C.UPDATE_RESTART_WARNING_MINUTES);
  check('the words say a signed-in user\'s session is not what stops it, a RustDesk technician is', /never while a technician is connected through RustDesk/.test(A.taskInWords({ kind: 'restart', rule: 'if_required' })) && /restarts even if a technician is connected/.test(A.taskInWords({ kind: 'restart', rule: 'always', ignoreRemoteSession: true })));
  check('the words for "always" say it restarts whether or not Windows asks', /whether or not Windows asks/.test(A.taskInWords({ kind: 'restart', rule: 'always' })));
}

// ── The document ────────────────────────────────────────────────────────────
{
  const now = new Date();
  const v = (d) => { const s = A.AutomationDoc.safeParse(d); if (!s.success) return `schema: ${s.error.issues[0]?.message}`; const r = A.validateAutomationDoc(s.data, now); return r.ok ? 'ok' : r.reason; };
  check('a business restart window parses and validates', v(doc()) === 'ok', v(doc()));
  check('a group\'s (every member) and one named computer\'s validate', v(doc({ targets: { kind: 'group_members', groupId: 'grp_servers_01', groupName: 'Servers' } })) === 'ok' && v(doc({ targets: { kind: 'computers', computers: [PC] } })) === 'ok');
  check('a restart window may not use the per-run-capped group target', v(doc({ targets: { kind: 'group', groupId: 'grp_servers_01', groupName: 'Servers', maxTargets: 5 } })) === 'restart_target_kind');
  check('a script or software task may not name a whole business or a group\'s every member', (() => {
    const sw = { kind: 'software', operation: 'install', params: { packageId: '7zip.7zip', version: '24.08', installerSha256: 'e'.repeat(64), scope: 'machine', detection: { kind: 'display_name', name: '7-Zip', match: 'prefix', compare: 'gte', version: '24.08' } }, display: { name: '7-Zip', publisher: 'Igor Pavlov', hashSource: 'winget_pkgs', manifestSha256: 'f'.repeat(64), entryId: 'entry_7zip_0001', entryRevision: 1 } };
    return v(doc({ task: sw })) === 'target_restart_only' && v(doc({ task: sw, targets: { kind: 'group_members', groupId: 'grp_servers_01', groupName: 'Servers' } })) === 'target_restart_only';
  })());
  check('a restart window is never hourly', v(doc({ recurrence: { kind: 'hourly', everyHours: 4, minute: 0, windowMinutes: 60, timezone: 'UTC' } })) === 'restart_schedule_kind');
  check('its offline rule is run_when_online (the window and warning bound it)', v(doc({ offline: { mode: 'skip_if_offline' } })) === 'restart_offline_rule' && v(doc({ offline: { mode: 'expire_after', hours: 6 } })) === 'restart_offline_rule');
  check('a window under 30 minutes is refused', v(doc({ recurrence: { days: ALL, start: '02:00', end: '02:20', timezone: 'UTC' } })) === 'restart_window_too_short' && v(doc({ recurrence: { days: ALL, start: '02:00', end: '02:30', timezone: 'UTC' } })) === 'ok');
  check('monthly windows are allowed (0.53\'s shapes)', v(doc({ recurrence: { kind: 'monthly', week: 'second', weekday: 'wed', offsetDays: 0, start: '02:00', end: '04:00', timezone: 'Europe/London' } })) === 'ok');
  check('an unknown restart rule fails the schema', v(doc({ task: { kind: 'restart', rule: 'when_idle' } })).startsWith('schema'));
  check('the business target is strict', !A.AutomationDoc.safeParse(doc({ targets: { kind: 'business', exclude: ['x'] } })).success);
  // A 0.58 document (script or software) parses to exactly its own bytes: nothing is defaulted in, so its digest is unchanged.
  const sw58 = doc({ task: { kind: 'software', operation: 'install', params: { packageId: '7zip.7zip', version: '24.08', installerSha256: 'e'.repeat(64), scope: 'machine', detection: { kind: 'display_name', name: '7-Zip', match: 'prefix', compare: 'gte', version: '24.08' } }, display: { name: '7-Zip', publisher: 'Igor Pavlov', hashSource: 'winget_pkgs', manifestSha256: 'f'.repeat(64), entryId: 'entry_7zip_0001', entryRevision: 1 } }, targets: { kind: 'computers', computers: [PC] }, recurrence: { kind: 'hourly', everyHours: 1, minute: 0, windowMinutes: 60, timezone: 'UTC' }, maxRunsPerOccurrence: 1 });
  check('a 0.58 software document keeps its bytes and digest', canonicalJson(A.AutomationDoc.parse(sw58)) === canonicalJson(sw58) && A.automationDigest(A.AutomationDoc.parse(sw58)) === A.automationDigest(sw58));
  check('the targets in words', /every computer of Acme that this window governs/.test(A.targetsInWords({ kind: 'business' }, 'Acme')) && /every member of group "Servers"/.test(A.targetsInWords({ kind: 'group_members', groupId: 'grp_servers_01', groupName: 'Servers' }, 'Acme')));
}

// ── The signer's decision, refusal by refusal ───────────────────────────────
{
  const d = doc();
  const digest = A.automationDigest(d);
  const approvals = [{ userId: 'user_olivia01', name: 'Olivia', role: 'approver', credentialSha256: 'd'.repeat(64), at: new Date().toISOString() }, { userId: 'user_quinn001', name: 'Quinn', role: 'approver', credentialSha256: 'e'.repeat(64), at: new Date().toISOString() }];
  const state = (over = {}, dd = d, dg = digest) => ({ doc: dd, digest: dg, status: 'ACTIVE', approvals, signatureValid: true, revokedAt: null, ledger: [], ...over });
  const now = new Date();
  const ev = (p, s = state(), o = {}) => code(A.evaluateAutomationPlan(s, { plan: p, policyDigest: s.digest }, { now, customerSignoff: false, ...o }));
  const ok = planFor(d, digest);
  check('a restart plan inside the window is accepted', ev(ok) === 'ok', ev(ok));
  check('it is keyed by the occurrence', A.evaluateAutomationPlan(state(), { plan: ok, policyDigest: digest }, { now, customerSignoff: false }).occurrence === A.automationOccurrenceAt(now, d.recurrence).start.toISOString());
  check('any computer of the business, for a business window', ev(planFor(d, digest, { targets: [target(PC2)] })) === 'ok');
  check('direct mode: accepted with no approvers', ev(ok, state({ approvals: [] }), { direct: true }) === 'ok');
  const later = new Date(Date.now() + 4 * 3_600_000);
  const cases = [
    ['revoked', ok, state({ revokedAt: now.toISOString() }), 'policy_revoked'],
    ['awaiting approval', ok, state({ status: 'AWAITING_APPROVAL' }), 'policy_not_active'],
    ['a bad signature', ok, state({ signatureValid: false }), 'policy_signature_invalid'],
    ['one approval', ok, state({ approvals: approvals.slice(0, 1) }), 'policy_not_approved'],
    ['another action', { ...ok, action: { id: 'windows.service.restart', version: 1 } }, state(), 'action_not_in_policy'],
    ['a shorter warning', planFor(d, digest, { params: { delayMinutes: 5, onlyIfRequired: true } }), state(), 'restart_params_not_allowed'],
    ['"if required" without onlyIfRequired', planFor(d, digest, { params: { delayMinutes: 15 } }), state(), 'restart_params_not_allowed'],
    ['the RustDesk exception, not in the window', planFor(d, digest, { params: { delayMinutes: 15, onlyIfRequired: true, ignoreRemoteSession: true } }), state(), 'override_not_allowed'],
    ['an extra parameter', planFor(d, digest, { params: { delayMinutes: 15, onlyIfRequired: true, force: true } }), state(), 'restart_params_not_allowed'],
    ['a script', { ...ok, script: { allowlistId: 'x' } }, state(), 'script_not_in_policy'],
    ['an update named', { ...ok, display: { ...ok.display, updates: [{ updateId: 'u', revision: 1, title: 'x', kb: null }] } }, state(), 'bad_display'],
    ['another policy named', { ...ok, display: { ...ok.display, policy: { id: hex(16), name: 'x', digest } } }, state(), 'bad_display'],
    ['someone else requesting', { ...ok, requestedBy: { userId: 'user_other001', name: 'Other', via: 'portal' } }, state(), 'requester_mismatch'],
    ['two computers in one plan', planFor(d, digest, { targets: [target(PC), target(PC2)] }), state(), 'computer_not_in_policy'],
    ['another business\'s computer', planFor(d, digest, { targets: [target(PC, OTHER)] }), state(), 'computer_not_in_policy'],
    ['starting after the window', planFor(d, digest, { notBefore: later, notAfter: new Date(later.getTime() + 15 * 60_000) }), state(), 'outside_restart_window'],
    ['picked up too late for the warning to fit', planFor(d, digest, { notAfter: new Date(Date.parse(new Date().toISOString()) + 115 * 60_000) }), state(), 'outside_restart_window'],
    ['starting later than when signed', planFor(d, digest, { notBefore: new Date(Date.now() + 20 * 60_000), notAfter: new Date(Date.now() + 40 * 60_000) }), state(), 'outside_restart_window'],
    ['starting in the past', planFor(d, digest, { notBefore: new Date(Date.now() - 30 * 60_000) }), state(), 'outside_restart_window'],
  ];
  for (const [name, p, s, want] of cases) { const got = ev(p, s); check(`refused: ${name} (${want})`, got === want, got); }
  // The exception, when the window has it.
  const dx = doc({ task: { kind: 'restart', rule: 'always', ignoreRemoteSession: true } });
  const gx = A.automationDigest(dx);
  check('the exception is signed when the window has it, and only exactly', ev(planFor(dx, gx), state({}, dx, gx)) === 'ok' && ev(planFor(dx, gx, { params: { delayMinutes: 15 } }), state({}, dx, gx)) === 'restart_params_not_allowed');
  check('"always" refuses onlyIfRequired', ev(planFor(dx, gx, { params: { delayMinutes: 15, onlyIfRequired: true, ignoreRemoteSession: true } }), state({}, dx, gx)) === 'restart_params_not_allowed');
  // Named computers: identity-bound.
  const dc = doc({ targets: { kind: 'computers', computers: [PC] } });
  const gc = A.automationDigest(dc);
  check('a computer\'s own window: only that computer', ev(planFor(dc, gc), state({}, dc, gc)) === 'ok' && ev(planFor(dc, gc, { targets: [target(PC2)] }), state({}, dc, gc)) === 'computer_not_in_policy');
  check('…as enrolled: a re-enrolled computer is refused', ev(planFor(dc, gc, { targets: [target({ ...PC, deviceSecretSha256: '9'.repeat(64) })] }), state({}, dc, gc)) === 'computer_not_in_policy');
  // Unknown targets fail closed.
  const du = { ...d, targets: { kind: 'site', siteId: 'x' } };
  check('an unknown target kind fails closed', code(A.evaluateAutomationRestart({ ...state(), doc: du }, { plan: ok, policyDigest: digest }, now)) === 'computer_not_in_policy');
  check('an unknown rule fails closed', code(A.evaluateAutomationRestart({ ...state(), doc: { ...d, task: { kind: 'restart', rule: 'maybe' } } }, { plan: ok, policyDigest: digest }, now)) === 'restart_rule_unknown');
  // The ledger: per computer, never across computers.
  const occ = A.automationOccurrenceAt(now, d.recurrence).start.toISOString();
  const entry = (ids, open, occurrence = occ) => ({ jobId: hex(16), occurrence, signedAt: now.toISOString(), notBefore: now.toISOString(), notAfter: new Date(now.getTime() + (open ? 60_000 : -1000)).toISOString(), endpointIds: ids, planSha256: '0'.repeat(64) });
  check('another computer\'s open plan does not hold this one (restarts are per computer)', ev(ok, state({ ledger: [entry([PC2.endpointId], true)] })) === 'ok');
  check('this computer\'s open plan does', ev(ok, state({ ledger: [entry([PC.endpointId], true)] })) === 'restart_already_signed');
  check('a second and third try in the window are signed', ev(ok, state({ ledger: [entry([PC.endpointId], false)] })) === 'ok' && ev(ok, state({ ledger: [entry([PC.endpointId], false), entry([PC.endpointId], false)] })) === 'ok');
  check('a fourth is refused (restart_retry_limit)', ev(ok, state({ ledger: [1, 2, 3].map(() => entry([PC.endpointId], false)) })) === 'restart_retry_limit');
  check('…as is a second, under a window allowing one try', (() => { const d1 = { ...d, maxRunsPerOccurrence: 1 }; const g1 = A.automationDigest(d1); return ev(planFor(d1, g1), state({ ledger: [entry([PC.endpointId], false)] }, d1, g1)) === 'restart_retry_limit'; })());
  check('the next window starts afresh', ev(ok, state({ ledger: [1, 2, 3].map(() => entry([PC.endpointId], false, '2020-01-01T00:00:00.000Z')) })) === 'ok');
  check('the ledger keeps a week and a day of restart plans', A.RESTART_LEDGER_KEEP_DAYS === 8);
  // Script and software policies still decide as in 0.58: an open plan holds the next.
  check('script/software windows keep "runs never overlap"', typeof A.evaluateAutomationPlan === 'function' && /previous_run_open/.test(A.evaluateAutomationPlan.toString()));
}

// ── Which window governs a computer ─────────────────────────────────────────
{
  const S = (id, scope, over = {}) => ({ id, scope, customerId: BIZ, groupId: null, endpointId: null, priority: null, mode: 'window', policyLive: true, ...over });
  const ep = (groups = []) => ({ id: PC.endpointId, customerId: BIZ, groupIds: new Set(groups) });
  const biz = S('s_business', 'business');
  const gServers = S('s_servers', 'group', { groupId: 'grp_servers', priority: 2 });
  const gTills = S('s_tills', 'group', { groupId: 'grp_tills', priority: 1 });
  const own = S('s_own', 'computer', { endpointId: PC.endpointId });
  const win = (e, ss) => R.effectiveSetting(e, ss).winner?.id ?? null;
  check('nothing set: nothing governs (never restarted automatically)', win(ep(), []) === null);
  check('the business window is the default', win(ep(), [biz]) === 's_business');
  check('a group\'s beats the business\'s', win(ep(['grp_servers']), [biz, gServers]) === 's_servers');
  check('a group the computer is not in does not apply', win(ep(['grp_other']), [biz, gServers]) === 's_business');
  check('between two groups, priority 1 first', win(ep(['grp_servers', 'grp_tills']), [biz, gServers, gTills]) === 's_tills');
  check('the computer\'s own beats every group and the business', win(ep(['grp_servers', 'grp_tills']), [biz, gServers, gTills, own]) === 's_own');
  check('"no automatic restarts" on the computer wins over a business window', win(ep(), [biz, S('s_off', 'computer', { endpointId: PC.endpointId, mode: 'off', policyLive: false })]) === 's_off');
  check('"no automatic restarts" on a group wins over the business', win(ep(['grp_servers']), [biz, { ...gServers, mode: 'off', policyLive: false }]) === 's_servers');
  const waiting = S('s_own_wait', 'computer', { endpointId: PC.endpointId, policyLive: false });
  const e = R.effectiveSetting(ep(), [biz, waiting]);
  check('a computer window waiting for approval does not govern yet: the business does, and the waiting one is named', e.winner?.id === 's_business' && e.notInForce.map((s) => s.id).join() === 's_own_wait');
  check('a business window not in force governs nothing', win(ep(), [{ ...biz, policyLive: false }]) === null);
  check('another business\'s setting never applies', win(ep(), [{ ...biz, customerId: OTHER }]) === null);
  check('a computer in no business has none', R.effectiveSetting({ id: PC.endpointId, customerId: null, groupIds: new Set() }, [biz]).winner === null);
  check('where it comes from, in words', R.sourceInWords({ scope: 'business' }, { business: 'Acme' }) === 'from business Acme' && R.sourceInWords({ scope: 'computer' }, {}) === 'set on this computer' && R.sourceInWords({ scope: 'group' }, { group: 'Servers' }) === 'from device group Servers');
  check('the decision does not depend on the order of the rows', win(ep(['grp_servers', 'grp_tills']), [gTills, own, gServers, biz].reverse()) === 's_own' && win(ep(['grp_servers', 'grp_tills']), [gServers, biz, gTills]) === 's_tills');
  // Asking again.
  check('asked again after a RustDesk session or "cannot tell"', R.mayRetry({ jobId: 'j', jobStatus: 'NOT_EXECUTED', targetStatus: 'NOT_EXECUTED', reason: 'remote_session_open' }) && R.mayRetry({ jobId: 'j', jobStatus: 'NOT_EXECUTED', targetStatus: 'NOT_EXECUTED', reason: 'session_state_unknown' }));
  check('asked again after a plan that never reached the computer', R.mayRetry({ jobId: 'j', jobStatus: 'EXPIRED', targetStatus: 'CANCELED' }) && R.mayRetry({ jobId: 'j', jobStatus: 'CANCELED' }) && R.mayRetry({ jobId: 'j', jobStatus: 'REJECTED' }) && R.mayRetry({ jobId: null }));
  check('never asked again after it restarted, said none was required, or failed otherwise', !R.mayRetry({ jobId: 'j', jobStatus: 'SUCCEEDED', targetStatus: 'SUCCEEDED' }) && !R.mayRetry({ jobId: 'j', jobStatus: 'NOT_EXECUTED', targetStatus: 'NOT_EXECUTED', reason: 'no_restart_required' }) && !R.mayRetry({ jobId: 'j', jobStatus: 'DISPATCHED', targetStatus: 'DISPATCHED' }) && !R.mayRetry({ jobId: 'j', jobStatus: 'FAILED', targetStatus: 'FAILED', reason: 'schedule_failed' }));
}

// ── The approval page ───────────────────────────────────────────────────────
{
  const d = doc({ recurrence: NIGHTLY });
  const view = { policyId: d.policyId, status: 'AWAITING_APPROVAL', digest: A.automationDigest(d), doc: d, decisions: [], signedPlans: 0, revokedAt: null, revokeReason: null, scriptContent: null };
  const html = page.renderAutomationApprovalPage(view, 'n0nce');
  check('the page names it a restart window', /<h1>Restart window: Restart window — Acme<\/h1>/.test(html));
  check('…says the signer cannot see which computers a business window governs', /cannot see which computers that is/.test(html));
  check('…the fixed warning, that a signed-in user does not stop it, and that it has not run on real Windows', /restarts 15 minutes later/.test(html) && html.includes(C.SIGNED_IN_USER_NOTE.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').slice(0, 30)) && html.includes(C.REBOOT_UNPROVEN.slice(0, 30)));
  check('…"if required" in plain words, and no RustDesk exception', /Only a computer Windows says needs a restart is planned/.test(html) && /never restarts while a technician is connected through RustDesk/.test(html));
  check('…the window in the zone, with its next openings', /Daily 02:00–04:00 America\/Chicago/.test(html) && /Next runs before it expires/.test(html));
  check('…and offers the passkey decision while awaiting approval', /Approve with passkey/.test(html) && /\/approve\/automation\//.test(html));
  const dx = doc({ task: { kind: 'restart', rule: 'always', ignoreRemoteSession: true }, targets: { kind: 'group_members', groupId: 'grp_servers_01', groupName: 'Servers' }, recurrence: NIGHTLY });
  const hx = page.renderAutomationApprovalPage({ ...view, doc: dx, digest: A.automationDigest(dx), status: 'ACTIVE' }, 'n0nce');
  check('a maintenance restart with the exception says both plainly', /Every computer restarts once in each window/.test(hx) && /their session is dropped/.test(hx) && /cannot see the group/.test(hx) && !/Approve with passkey/.test(hx));
}

if (failures.length) { console.error(`unit-restart-window-settings: ${passed} passed, ${failures.length} failed`); for (const f of failures) console.error(`  ✗ ${f}`); process.exit(1); }
console.log(`unit-restart-window-settings: ${passed} passed`);
