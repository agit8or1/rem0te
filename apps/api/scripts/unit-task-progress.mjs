#!/usr/bin/env node
/**
 * Task progress (0.52): the lifecycle every task view is built from
 * (apps/api/src/tasks/lifecycle.ts), and the schedule a scheduled install
 * turns into a signed notBefore (patching.service.ts scheduledStart). Pure: no
 * database, no API. Needs a built dist (`npx nest build`).
 *
 *   node scripts/unit-task-progress.mjs
 *
 * The first section replays DEWEY-WKS2022, the production install that
 * prompted this release, from its real timestamps.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const L = require(path.join(dist, 'tasks/lifecycle.js'));
const { scheduledStart, scheduledWindow, MAX_SCHEDULE_DAYS } = require(path.join(dist, 'patching/patching.service.js'));

let pass = 0, fail = 0; const failures = [];
const check = (c, m, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${m}`); } else { fail++; failures.push(m); console.log(`  \x1b[31m✗\x1b[0m ${m}${d ? `\n      ${d}` : ''}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const T = (s) => new Date(`2026-11-14T${s}Z`);
const title = (id) => ({ 'windows.update.install': 'Install Windows updates', 'windows.reboot.schedule': 'Schedule a restart' })[id] ?? id;

const EP = { id: 'ep_dewey_0001', name: 'DEWEY-WKS2022', hostname: 'DEWEY-WKS2022', customerId: 'biz_dewey_001', lastSeenAt: T('23:42:04') };
const UPD = (n) => `00000000-0000-4000-8000-00000000000${n}`;
const plan = { display: { updates: [{ updateId: UPD(1), kb: 'KB5007651', title: 'Windows Malicious Software Removal Tool' }, { updateId: UPD(2), kb: null, title: 'Driver update' }] } };
const job = (o = {}) => ({ id: 'a'.repeat(32), actionId: 'windows.update.install', status: 'DISPATCHED', statusReason: null, customerId: EP.customerId, requestedById: 'u_owner', notBefore: T('23:31:46'), notAfter: T('23:31:46').getTime() ? new Date(T('23:31:46').getTime() + 8 * 3600_000) : null, createdAt: T('23:31:46'), deploymentId: 'dep_dewey_01', softwareDeploymentId: null, plan, params: {}, ...o });
const target = (o = {}) => ({ id: 't1', endpointId: EP.id, status: 'DISPATCHED', statusReason: null, dispatchedAt: T('23:33:05'), deliveries: 4, lastDeliveredAt: T('23:42:04'), outcome: null, result: null, resultAt: null, reconciledAt: null, ...o });
const ctx = (now, o = {}) => ({ now, held: false, titleOf: title, endpoint: EP, ...o });

section('DEWEY-WKS2022, replayed: requested 23:31:46, handed out 23:33:05, 4 deliveries, answered 23:45:04');
{
  let v = L.actionTask(job({ status: 'APPROVED' }), target({ status: 'PENDING', dispatchedAt: null, deliveries: 0, lastDeliveredAt: null }), ctx(T('23:32:30'), { endpoint: { ...EP, lastSeenAt: T('23:30:02') } }));
  check(v.stage === 'queued' && v.state === 'queued' && v.waitingFor === 'check_in' && /next check-in \(about every 3 minutes\)/.test(v.text) && !v.overdue, '23:32: queued, waiting for the next check-in (about every 3 minutes)', v.text);
  check(v.cancelJobId === job().id, 'an approved plan that reached no computer can be canceled');
  v = L.actionTask(job(), target(), ctx(T('23:42:30')));
  check(v.stage === 'handed_out' && v.inFlight && /Handed to the computer at 23:33 UTC \(4 deliveries, the last at 23:42 UTC\)/.test(v.text) && !v.overdue, '23:42: handed to the computer at 23:33, 4 deliveries — not overdue yet', v.text);
  check(v.cancelJobId === null, 'nothing delivered can be canceled from here');
  v = L.actionTask(job(), target(), ctx(T('23:59:59')));
  check(!v.overdue, '26 minutes after hand-out an update install is not yet overdue (30 min)');
  v = L.actionTask(job(), target(), ctx(new Date(T('23:33:05').getTime() + 31 * 60_000)));
  check(v.overdue && /^Handed out 31 min ago, no result yet: the agent may be busy \(a large update can take a long time\) or offline\./.test(v.overdueText), 'past 30 minutes: "handed out 31 min ago, no result yet: the agent may be busy or offline"', v.overdueText);
  const result = {
    outcome: 'restart_required',
    updates: [
      { updateId: UPD(1), revision: 1, kb: 'KB5007651', state: 'installed', hresult: '0x00000000' },
      { updateId: UPD(2), revision: 1, state: 'restart_required' },
      { updateId: UPD(3), revision: 1, kb: 'KB5135243', state: 'failed', hresult: '0x80240022' },
    ],
    reboot: { pending: true, sources: ['windows_update'] },
  };
  v = L.actionTask(job(), target({ status: 'SUCCEEDED', outcome: 'restart_required', result, resultAt: T('23:45:04') }), ctx(T('23:55:00')));
  check(v.stage === 'done' && !v.inFlight && v.state === 'restart_required' && v.restartPending === true, '23:45: done — restart required', JSON.stringify({ state: v.state, stage: v.stage }));
  check(/^Installed 2 updates, 1 failed — restart required\. Answered at 23:45 UTC, 12 min after it was handed out\./.test(v.text), 'the sentence says what happened and how long it took', v.text);
  check(v.items.length === 3 && v.items[0].label.startsWith('KB5007651') && v.items[1].label === 'Driver update' && v.items[2].state === 'failed' && /0x80240022: every update in the request failed/.test(v.items[2].detail),
    'per update: KB or the title the plan showed, its state, and the HRESULT explained', JSON.stringify(v.items));
  check(v.finishedAt === T('23:45:04').toISOString() && v.handedOutAt === T('23:33:05').toISOString() && v.deliveries === 4, 'timestamps and delivery count are the rows\' own');
  check(v.link.href === '/patching/dep_dewey_01', 'links to its deployment');
}

section('Scheduled, approval, containment, a quiet computer');
{
  const sched = job({ status: 'APPROVED', notBefore: T('23:00:00'), notAfter: T('23:59:00') });
  let v = L.actionTask(sched, target({ status: 'PENDING', dispatchedAt: null, deliveries: 0 }), ctx(T('20:30:00')));
  check(v.stage === 'scheduled' && v.state === 'scheduled' && v.waitingFor === 'schedule' && /Scheduled for 23:00 UTC \(in 2 h 30 min\); it may run until 23:59 UTC\. Nothing is handed to the computer before then\./.test(v.text), 'scheduled: "Scheduled for 23:00 (in 2 h 30 min) … nothing is handed out before then"', v.text);
  check(v.inFlight && v.cancelJobId === sched.id, 'a scheduled task is in flight and cancelable');
  check(L.matchesState(v, 'scheduled') && L.matchesState(v, 'in_flight') && !L.matchesState(v, 'done'), 'state filters: scheduled and in flight, not done');
  v = L.actionTask(job({ status: 'AWAITING_APPROVAL' }), target({ status: 'PENDING', dispatchedAt: null }), ctx(T('20:30:00')));
  check(v.stage === 'awaiting_approval' && v.waitingFor === 'approval' && v.cancelJobId, 'awaiting approval on the signer, cancelable');
  v = L.actionTask(job({ status: 'APPROVED' }), target({ status: 'PENDING', dispatchedAt: null }), ctx(T('23:40:00'), { held: true }));
  check(v.state === 'held' && v.waitingFor === 'containment' && /paused for this business \(containment\)/.test(v.text), 'held by a containment pause, and says so');
  v = L.actionTask(job({ status: 'APPROVED' }), target({ status: 'PENDING', dispatchedAt: null }), ctx(T('23:40:00'), { endpoint: { ...EP, lastSeenAt: T('23:05:00') } }));
  check(v.state === 'queued' && v.overdue && /last checked in 35 min ago: it may be offline or asleep/.test(v.overdueText), 'queued on a computer silent for 35 min: overdue, with why', v.overdueText);
  v = L.actionTask(job({ status: 'APPROVED' }), target({ status: 'CANCELED', statusReason: 'plan canceled', dispatchedAt: null }), ctx(T('23:40:00')));
  check(v.state === 'canceled' && !v.inFlight && /Nothing reached the computer/.test(v.text), 'canceled before delivery');
  v = L.actionTask(job({ status: 'EXPIRED' }), target({ status: 'CANCELED', statusReason: 'window_closed', dispatchedAt: null }), ctx(T('23:40:00')));
  check(v.state === 'expired' && L.matchesState(v, 'problem'), 'expired unrun: a problem');
  v = L.actionTask(job(), target({ status: 'UNKNOWN', statusReason: 'no result' }), ctx(new Date(T('23:33:05').getTime() + 7 * 3600_000)));
  check(v.state === 'uncertain' && v.inFlight && v.overdue, 'no result past the deadline: uncertain, still in flight (the agent answers from its journal), overdue');
}

section('Thresholds per task type');
{
  check(L.OVERDUE_MINUTES.update_install === 30 && L.OVERDUE_MINUTES.software === 20 && L.OVERDUE_MINUTES.script === 15 && L.OVERDUE_MINUTES.restart === 10 && L.OVERDUE_MINUTES.diagnostic === 10, 'update 30, software 20, script 15, restart and diagnostics 10 minutes');
  const svc = job({ actionId: 'windows.service.control', deploymentId: null });
  const v = L.actionTask(svc, target(), ctx(new Date(T('23:33:05').getTime() + 11 * 60_000)));
  check(v.type === 'service_process' && v.overdue && !/large update/.test(v.overdueText) && v.link.href.endsWith('?tab=services'), 'a service change is overdue after 10 minutes, and links to the Services tab');
  check(L.actionType('windows.reboot.schedule') === 'restart' && L.actionType('windows.script.run') === 'script' && L.actionType('windows.software.remove') === 'software' && L.actionType('windows.nope') === 'action', 'every catalog action has a type; anything else is "action"');
  for (const t of Object.keys(L.OVERDUE_MINUTES)) check(L.TASK_TYPES.includes(t), `threshold for a known type: ${t}`);
  check(L.TASK_TYPES.every((t) => L.OVERDUE_MINUTES[t] > 0), 'every type has a threshold');
}

section('Diagnostics, commands, scans, migrations, reinstalls');
{
  const run = (o) => ({ id: 'r1', endpointId: EP.id, key: 'disk_space', status: 'REQUESTED', requestedById: 'u', requestedAt: T('22:00:00'), deliveredAt: null, startedAt: null, completedAt: null, expiresAt: T('22:15:00'), dispatchCount: 0, error: null, ...o });
  let v = L.diagnosticTask(run({}), EP, 'Disk space', false, T('22:01:00'));
  check(v.stage === 'queued' && /expires at 22:15 UTC/.test(v.text), 'diagnostic queued, with its pickup expiry');
  v = L.diagnosticTask(run({ status: 'RUNNING', deliveredAt: T('22:02:00'), startedAt: T('22:02:10') }), EP, 'Disk space', false, T('22:03:00'));
  check(v.stage === 'running' && v.state === 'running', 'the agent reports running: Running');
  v = L.diagnosticTask(run({ status: 'COMPLETED', completedAt: T('22:04:00') }), EP, 'Processes', true, T('22:05:00'));
  check(v.type === 'snapshot' && !v.inFlight && v.state === 'succeeded', 'a snapshot run, done');
  const cmd = { id: 'c1', endpointId: EP.id, type: 'UPDATE_SCAN', status: 'DISPATCHED', requestedById: 'u', createdAt: T('22:00:00'), dispatchedAt: T('22:01:00'), completedAt: null, expiresAt: T('23:00:00'), dispatchCount: 1, error: null };
  v = L.commandTask(cmd, EP, T('22:25:00'));
  check(v.type === 'scan' && v.overdue && /24 min ago/.test(v.overdueText), 'an update scan handed out 24 min ago with no answer is overdue (20 min)', v.overdueText);
  v = L.patchScanTask(EP.id, EP, T('23:59:00'), T('23:00:00'), T('23:50:00'));
  check(v?.state === 'scheduled' && /after the scheduled restart/.test(v.text), 'a scan due after a restart (requested in the future): scheduled');
  check(L.patchScanTask(EP.id, EP, T('23:00:00'), T('23:10:00'), T('23:50:00')) === null, 'a scan that already arrived is no task');
  const mig = { id: 'm1', endpointId: EP.id, requestedById: 'u', requestedAt: T('20:00:00'), dispatchedAt: T('20:03:00'), lastDispatchedAt: T('20:30:00'), dispatchCount: 4, fetchedAt: null, holdReason: null, holdAt: null, completedAt: null, cancelledAt: null, automatic: false };
  v = L.migrationTask(mig, EP, { state: 'dispatched', text: 'Handed to the computer at its last check-in.' }, T('20:40:00'));
  check(v.stage === 'handed_out' && v.overdue, 'a migration handed out 37 min ago and still standard: overdue');
  v = L.migrationTask({ ...mig, completedAt: T('20:20:00') }, EP, { state: 'completed', text: 'Completed.' }, T('20:40:00'));
  check(!v.inFlight && v.state === 'succeeded' && v.finishedAt, 'a completed migration is done');
  const node = { endpointId: EP.id, reinstallRequestedAt: T('21:00:00'), reinstallRequestedBy: 'u', reinstallDispatchedAt: null, updateRequestedAt: null, updateRequestedById: null, updateRequestSource: null, updateTargetVersion: null, updateHoldReason: null };
  const ns = L.nodeTasks(node, EP, T('21:01:00'));
  check(ns.length === 1 && ns[0].kind === 'reinstall' && ns[0].stage === 'queued', 'an open reinstall is one queued task');
  check(L.nodeTasks({ ...node, reinstallRequestedAt: null }, EP, T('21:01:00')).length === 0, 'no flag, no task');
}

section('Ordering and the HRESULT table');
{
  const a = { inFlight: true, overdue: false, requestedAt: T('10:00:00').toISOString(), finishedAt: null };
  const b = { inFlight: true, overdue: true, requestedAt: T('09:00:00').toISOString(), finishedAt: null };
  const c = { inFlight: false, overdue: false, requestedAt: T('11:00:00').toISOString(), finishedAt: T('11:30:00').toISOString() };
  const s = [c, a, b].sort(L.sortTasks);
  check(s[0] === b && s[1] === a && s[2] === c, 'overdue in-flight first, then in flight, then finished');
  check(L.hresultText('0x80240022') && L.hresultText('0X80070070')?.includes('disk space') && L.hresultText('0x12345678') === null, 'known HRESULTs explained, case-insensitive; unknown ones are not guessed');
  check(L.span(25 * 60_000) === '25 min' && L.span(125 * 60_000) === '2 h 5 min' && L.span(30_000) === 'under a minute', 'durations read as people say them');
  check(L.POLL_FAST_MS === 5000 && L.POLL_SLOW_MS === 60000, 'polls every 5 s while something moves, every minute when idle');
}

section('Scheduling: a wall-clock time in a named zone becomes the signed notBefore');
{
  const now = new Date('2026-11-14T12:00:00Z');
  const at = scheduledStart({ local: '2026-11-15T02:00', timeZone: 'America/Chicago' }, now);
  check(at.toISOString() === '2026-11-15T08:00:00.000Z', '02:00 in Chicago (CST, UTC−6) is 08:00 UTC', at.toISOString());
  const w = scheduledWindow({ local: '2026-11-15T02:00', timeZone: 'Europe/London' }, 4, now);
  check(w.notBefore.toISOString() === '2026-11-15T02:00:00.000Z' && w.notAfter.getTime() - w.notBefore.getTime() === 4 * 3600_000, 'the window opens at the scheduled time and lasts the window length');
  const code = (f) => { try { f(); return null; } catch (e) { return e.response?.code ?? e.message; } };
  check(code(() => scheduledStart({ local: '2026-11-14T10:00', timeZone: 'UTC' }, now)) === 'SCHEDULE_IN_PAST', 'two hours ago is refused');
  check(scheduledStart({ local: '2026-11-14T11:58', timeZone: 'UTC' }, now).getTime() === now.getTime(), 'two minutes ago (inside the grace) starts now');
  check(code(() => scheduledStart({ local: '2026-12-14T10:00', timeZone: 'UTC' }, now)) === 'SCHEDULE_TOO_FAR' && MAX_SCHEDULE_DAYS === 14, `more than ${MAX_SCHEDULE_DAYS} days ahead is refused, pointing at policies`);
  check(code(() => scheduledStart({ local: '2026-11-15T02:00', timeZone: 'Mars/Olympus' }, now)) === 'INVALID_TIMEZONE', 'an unknown zone is refused');
  check(code(() => scheduledStart({ local: '2026-02-31T02:00', timeZone: 'UTC' }, new Date('2026-02-01T00:00:00Z'))) === 'INVALID_REQUEST', 'a date that does not exist is refused, not rolled over');
  const spring = scheduledStart({ local: '2027-03-14T02:30', timeZone: 'America/Chicago' }, new Date('2027-03-10T00:00:00Z'));
  check(spring.toISOString() === '2027-03-14T08:30:00.000Z', 'a time the spring-forward night skips lands where the old offset puts it (03:30 CDT)', spring.toISOString());
}

console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
