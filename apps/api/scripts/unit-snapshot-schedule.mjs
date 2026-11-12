#!/usr/bin/env node
// Tests for automatic snapshots (0.35), run against dist:
//
//   cd apps/api && npx nest build && node scripts/unit-snapshot-schedule.mjs
//
// Pure parts only: who can be asked (ineligible), when a key is due
// (effectiveInterval, nextDueAt, dueKeys), what the tab is told
// (automaticState), the Settings validation (parseScheduleUpdate), reading
// the stored row (scheduleFrom), the off switch, and the fleet-wide pacer.
// It also computes the stored size of a typical snapshot from the real
// sanitiser, which is where the sizing figures in snapshot-schedule.ts and
// docs/server-sizing.md come from (computed from synthetic rows shaped like
// a Windows desktop's, not measured on one).

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const s = require(join(here, '..', 'dist', 'diagnostics-catalog', 'snapshot-schedule.js'));
const c = require(join(here, '..', 'dist', 'diagnostics-catalog', 'catalog.js'));

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => { if (ok) passed++; else failures.push(`${name}${detail ? ` — ${detail}` : ''}`); };

const NOW = Date.parse('2026-11-12T12:00:00Z');
const MIN = 60_000, H = 60 * MIN;
const KEYS = ['process_list', 'service_list', 'network_adapters'];
const good = { status: 'ACTIVE', platform: 'Windows', agentBound: true, agentVersion: '0.35.0', lastSeenAt: new Date(NOW - MIN) };
const none = { lastCompletedAt: null, lastAutoRequestedAt: null, lastAutoFailed: false, open: false };
const hist = (o = {}) => Object.fromEntries(KEYS.map((k) => [k, { ...none, ...(o[k] ?? o.all ?? {}) }]));
const D = s.SCHEDULE_DEFAULTS;

// ── Defaults and the off switch ─────────────────────────────────────────────
{
  check('defaults: on; every key every 6 h; 5 minutes while watched', D.enabled === true && KEYS.every((k) => D.minutes[k] === 360) && D.watchMinutes === 5, JSON.stringify(D));
  check('the schedule covers exactly the snapshot keys', JSON.stringify(Object.keys(D.minutes)) === JSON.stringify([...c.SNAPSHOT_KEYS]));
  check('SNAPSHOT_SWEEP=off turns it off', s.sweepEnabled({ SNAPSHOT_SWEEP: 'off' }) === false);
  check('unset, empty or anything else leaves it on', s.sweepEnabled({}) && s.sweepEnabled({ SNAPSHOT_SWEEP: '' }) && s.sweepEnabled({ SNAPSHOT_SWEEP: 'OFF ' }) && s.sweepEnabled({ SNAPSHOT_SWEEP: 'on' }));
  check('minimum agent is 0.33.0', s.SNAPSHOT_MIN_AGENT === '0.33.0');
  check('a silent agent is 10 minutes without a heartbeat (as markStaleEndpointsOffline)', s.AGENT_SILENT_MS === 10 * MIN);
}

// ── Reading the stored row ──────────────────────────────────────────────────
{
  check('no row: the defaults', JSON.stringify(s.scheduleFrom(null)) === JSON.stringify(D));
  const r = s.scheduleFrom({ snapshotAutoEnabled: false, snapshotProcessMinutes: 60, snapshotServiceMinutes: 0, snapshotNetworkMinutes: 1440, snapshotWatchMinutes: 0 });
  check('a stored row is read as is', r.enabled === false && r.minutes.process_list === 60 && r.minutes.service_list === 0 && r.minutes.network_adapters === 1440 && r.watchMinutes === 0, JSON.stringify(r));
  const bad = s.scheduleFrom({ snapshotAutoEnabled: 'yes', snapshotProcessMinutes: 5, snapshotServiceMinutes: -1, snapshotNetworkMinutes: 1e9, snapshotWatchMinutes: 1 });
  check('out-of-range values fall back to the defaults (the database CHECK refuses them anyway)', JSON.stringify(bad) === JSON.stringify(D), JSON.stringify(bad));
}

// ── Settings validation ─────────────────────────────────────────────────────
{
  const ok = s.parseScheduleUpdate({ enabled: false, minutes: { process_list: 60, network_adapters: 0 }, watchMinutes: 10 });
  check('a valid change maps to the columns', ok.ok && JSON.stringify(ok.data) === JSON.stringify({ snapshotAutoEnabled: false, snapshotProcessMinutes: 60, snapshotNetworkMinutes: 0, snapshotWatchMinutes: 10 }), JSON.stringify(ok));
  const refuse = (name, body) => { const r = s.parseScheduleUpdate(body); check(`refused: ${name}`, r.ok === false && typeof r.error === 'string', JSON.stringify(r)); };
  refuse('not an object', 'every hour');
  refuse('an array', [1]);
  refuse('nothing to change', {});
  refuse('an unknown field', { enabled: true, intervalMinutes: 5 });
  refuse('an unknown key', { minutes: { top_processes: 60 } });
  refuse('a non-snapshot catalog key', { minutes: { recent_system_errors: 60 } });
  refuse('__proto__ as a key', JSON.parse('{"minutes":{"__proto__":60}}'));
  refuse('an interval under an hour', { minutes: { process_list: 59 } });
  refuse('an interval over a week', { minutes: { process_list: 10081 } });
  refuse('a fractional interval', { minutes: { process_list: 90.5 } });
  refuse('an interval as a string', { minutes: { process_list: '60' } });
  refuse('a negative interval', { minutes: { service_list: -60 } });
  refuse('a watched interval under the heartbeat', { watchMinutes: 2 });
  refuse('a watched interval over an hour', { watchMinutes: 61 });
  refuse('enabled not a boolean', { enabled: 'true' });
  check('bounds agree with the comments: 60–10080 and 3–60', s.INTERVAL_MIN === 60 && s.INTERVAL_MAX === 10080 && s.WATCH_MIN === 3 && s.WATCH_MAX === 60);
  check('0 is accepted as off for both', s.parseScheduleUpdate({ minutes: { process_list: 0 }, watchMinutes: 0 }).ok);
}

// ── Who can be asked ────────────────────────────────────────────────────────
{
  check('an active, bound, current Windows computer checking in can be asked', s.ineligible(good, NOW) === null);
  const why = (o) => s.ineligible({ ...good, ...o }, NOW);
  check('archived → not_active', why({ status: 'ARCHIVED' }) === 'not_active');
  check('pending enrolment → not_active', why({ status: 'PENDING_ENROLLMENT' }) === 'not_active');
  check('Linux → unsupported_platform', why({ platform: 'Linux' }) === 'unsupported_platform');
  check('macOS → unsupported_platform', why({ platform: 'macOS' }) === 'unsupported_platform');
  check('no platform → unsupported_platform', why({ platform: null }) === 'unsupported_platform');
  check('not bound → not_bound', why({ agentBound: false }) === 'not_bound');
  check('no agent version → agent_unknown', why({ agentVersion: null }) === 'agent_unknown');
  check('a junk agent version → agent_unknown', why({ agentVersion: 'unknown' }) === 'agent_unknown' && why({ agentVersion: '0.33.0; rm' }) === 'agent_unknown');
  check('0.32.9 → agent_too_old', why({ agentVersion: '0.32.9' }) === 'agent_too_old');
  check('0.31.0 → agent_too_old', why({ agentVersion: '0.31.0' }) === 'agent_too_old');
  check('0.33.0 exactly is enough', why({ agentVersion: '0.33.0' }) === null);
  check('1.0.0 is enough', why({ agentVersion: '1.0.0' }) === null);
  check('last seen 11 minutes ago → agent_silent', why({ lastSeenAt: new Date(NOW - 11 * MIN) }) === 'agent_silent');
  check('never seen → agent_silent', why({ lastSeenAt: null }) === 'agent_silent');
  check('last seen 9 minutes ago is still checking in', why({ lastSeenAt: new Date(NOW - 9 * MIN) }) === null);
  check('the first reason wins (archived Linux → not_active)', why({ status: 'ARCHIVED', platform: 'Linux' }) === 'not_active');
}

// ── When a key is due ───────────────────────────────────────────────────────
{
  const due = (h, sch = D, watched = () => false) => s.dueKeys(sch, NOW, hist(h), watched).map((d) => `${d.key}:${d.basis}`).join(',');
  check('nothing taken yet: every key is due, on the schedule', due({}) === 'process_list:schedule,service_list:schedule,network_adapters:schedule', due({}));
  check('fresh (taken 5 h ago): nothing due', due({ all: { lastCompletedAt: new Date(NOW - 5 * H) } }) === '');
  check('stale (taken 6 h 1 min ago): due', due({ all: { lastCompletedAt: new Date(NOW - 6 * H - MIN) } }).split(',').length === 3);
  check('exactly 6 h: due (at or after)', due({ all: { lastCompletedAt: new Date(NOW - 6 * H) } }).split(',').length === 3);
  check('only the stale key is asked for', due({ all: { lastCompletedAt: new Date(NOW - H) }, service_list: { lastCompletedAt: new Date(NOW - 7 * H) } }) === 'service_list:schedule');
  check('an open run (anyone\'s) means not due', due({ all: { open: true } }) === '');
  check('a manual run counts as fresh: someone pressed Refresh an hour ago', due({ all: { lastCompletedAt: new Date(NOW - H), lastAutoRequestedAt: null } }) === '');
  check('the platform switch off: nothing', due({}, { ...D, enabled: false }) === '');
  check('a key at 0: never on the schedule', due({}, { ...D, minutes: { ...D.minutes, process_list: 0 } }) === 'service_list:schedule,network_adapters:schedule');
  // Failure back-off: an hour or the interval, whichever is sooner.
  const failed = (ago) => ({ all: { lastCompletedAt: new Date(NOW - 30 * H), lastAutoRequestedAt: new Date(NOW - ago), lastAutoFailed: true } });
  check('an automatic attempt that failed 10 minutes ago is not retried yet', due(failed(10 * MIN)) === '');
  check('one that failed 61 minutes ago is retried', due(failed(61 * MIN)).split(',').length === 3);
  const okAttempt = { all: { lastCompletedAt: new Date(NOW - 7 * H), lastAutoRequestedAt: new Date(NOW - 2 * H), lastAutoFailed: false } };
  check('an automatic attempt 2 h ago that did not fail (completion older) waits the full interval', due(okAttempt) === '');
  // Watched.
  const w = (k) => k === 'process_list';
  check('watched: a 6-minute-old process list is due, on the watch basis; the others are not', due({ all: { lastCompletedAt: new Date(NOW - 6 * MIN) } }, D, w) === 'process_list:watch');
  check('watched: a 4-minute-old one is not', due({ all: { lastCompletedAt: new Date(NOW - 4 * MIN) } }, D, w) === '');
  check('watched with the watch interval off: the schedule only', due({ all: { lastCompletedAt: new Date(NOW - 6 * MIN) } }, { ...D, watchMinutes: 0 }, w) === '');
  check('watched with the key\'s schedule off: still the watch interval', due({ all: { lastCompletedAt: new Date(NOW - 6 * MIN) } }, { ...D, minutes: { ...D.minutes, process_list: 0 } }, w) === 'process_list:watch');
  check('watched but the platform switch off: nothing', due({ all: { lastCompletedAt: new Date(NOW - 6 * MIN) } }, { ...D, enabled: false }, w) === '');
  const wfail = { all: { lastCompletedAt: new Date(NOW - H), lastAutoRequestedAt: new Date(NOW - 4 * MIN), lastAutoFailed: true } };
  check('watched: a failure 4 minutes ago waits the 5-minute interval, not an hour', due(wfail, D, w) === '' && s.dueKeys(D, NOW + 2 * MIN, hist(wfail), w).length === 1);
  const iv = s.effectiveInterval(D, 'process_list', true);
  check('effectiveInterval: watched takes the shorter', iv.minutes === 5 && iv.basis === 'watch');
  check('effectiveInterval: a watch interval longer than the schedule does not lengthen it', s.effectiveInterval({ ...D, minutes: { ...D.minutes, process_list: 60 }, watchMinutes: 60 }, 'process_list', true).basis === 'schedule');
  check('effectiveInterval: both off → null', s.effectiveInterval({ ...D, minutes: { ...D.minutes, process_list: 0 }, watchMinutes: 0 }, 'process_list', true) === null);
}

// ── What the tab is told ────────────────────────────────────────────────────
{
  const st = (o = {}) => s.automaticState({ schedule: D, processEnabled: true, key: 'service_list', computer: good, history: none, watched: false, now: NOW, ...o });
  let a = st();
  check('never taken, checking in: on, next ≈ the next check-in (last seen + 3 min)', a.state === 'on' && a.nextAt === new Date(NOW + 2 * MIN).toISOString() && a.intervalMinutes === 360 && a.basis === 'schedule', JSON.stringify(a));
  a = st({ history: { ...none, lastCompletedAt: new Date(NOW - H) } });
  check('taken an hour ago: next in 5 h', a.state === 'on' && a.nextAt === new Date(NOW + 5 * H).toISOString(), JSON.stringify(a));
  a = st({ history: { ...none, open: true } });
  check('a run open: on, with no next time (it is on its way)', a.state === 'on' && a.nextAt === null);
  a = st({ watched: true, history: { ...none, lastCompletedAt: new Date(NOW - 2 * MIN) } });
  check('watched: next in 3 min, on the watch basis', a.basis === 'watch' && a.nextAt === new Date(NOW + 3 * MIN).toISOString() && a.intervalMinutes === 5, JSON.stringify(a));
  check('SNAPSHOT_SWEEP=off: off, process_off', st({ processEnabled: false }).reason === 'process_off' && st({ processEnabled: false }).state === 'off');
  check('switched off in Settings: off, disabled', st({ schedule: { ...D, enabled: false } }).reason === 'disabled');
  check('this key at 0: off, key_off', st({ schedule: { ...D, minutes: { ...D.minutes, service_list: 0 } } }).reason === 'key_off');
  check('agent silent: blocked, agent_silent, no next time', (() => { const x = st({ computer: { ...good, lastSeenAt: new Date(NOW - H) } }); return x.state === 'blocked' && x.reason === 'agent_silent' && x.nextAt === null; })());
  check('agent too old: blocked, even with automatic collection off (no schedule would help)', st({ computer: { ...good, agentVersion: '0.32.0' }, processEnabled: false }).reason === 'agent_too_old');
  check('Linux: blocked, unsupported_platform', st({ computer: { ...good, platform: 'Linux' } }).reason === 'unsupported_platform');
  check('silent and switched off: off (the switch is the more useful answer)', st({ computer: { ...good, lastSeenAt: null }, schedule: { ...D, enabled: false } }).reason === 'disabled');
}

// ── The pacer ───────────────────────────────────────────────────────────────
{
  const p = new s.Pacer(3, NOW);
  check('the pacer allows its per-minute budget at once', p.take(NOW) && p.take(NOW) && p.take(NOW));
  check('then refuses', !p.take(NOW));
  check('and refills over the minute (20 s → one more at 3 a minute)', p.take(NOW + 20_000) && !p.take(NOW + 20_000));
  check('never holds more than a minute\'s worth', (() => { const q = new s.Pacer(2, NOW); return q.take(NOW + 10 * H) && q.take(NOW + 10 * H) && !q.take(NOW + 10 * H); })());
  check('SNAPSHOT_MAX_PER_MINUTE: default 120, clamped 1–10000, junk → default', s.perMinuteFrom({}) === 120 && s.perMinuteFrom({ SNAPSHOT_MAX_PER_MINUTE: '0' }) === 1 && s.perMinuteFrom({ SNAPSHOT_MAX_PER_MINUTE: '1e9' }) === 10000 && s.perMinuteFrom({ SNAPSHOT_MAX_PER_MINUTE: 'lots' }) === 120 && s.perMinuteFrom({ SNAPSHOT_MAX_PER_MINUTE: '30' }) === 30);
}

// ── Payload sizes (computed from the sanitiser; feeds the sizing figures) ───
{
  const names = ['svchost', 'chrome', 'msedge', 'explorer', 'RuntimeBroker', 'SearchHost', 'Teams', 'OUTLOOK', 'conhost', 'dllhost', 'WmiPrvSE', 'MsMpEng', 'spoolsv', 'lsass', 'csrss'];
  const procs = Array.from({ length: 250 }, (_, i) => ({ name: `${names[i % names.length]}`, pid: 1000 + i * 4, cpuSeconds: Math.round(Math.random() * 50000) / 10, workingSetBytes: 1e6 + i * 98765, user: i % 3 ? 'NT AUTHORITY\\SYSTEM' : 'CORP\\alice.example', startedAt: '2026-11-12T07:58:13.000Z' }));
  const p = c.capResult(c.sanitizeResult('process_list', { processCount: 250, userNamesRead: true, processes: procs }), c.resultCapFor('process_list'));
  const svcs = Array.from({ length: 280 }, (_, i) => ({ name: `Service${i}Name`, displayName: `Windows Example Service Number ${i} Host`, state: i % 2 ? 'Running' : 'Stopped', startMode: i % 3 ? 'Manual' : 'Automatic', account: i % 4 ? 'LocalSystem' : 'NT AUTHORITY\\LocalService' }));
  const v = c.capResult(c.sanitizeResult('service_list', { serviceCount: 280, services: svcs }), c.resultCapFor('service_list'));
  const ads = Array.from({ length: 4 }, (_, i) => ({ name: `Intel(R) Ethernet Connection ${i}`, connectionId: `Ethernet ${i}`, status: 'Connected', up: true, mac: `00-11-22-33-44-5${i}`, speedBps: 1e9, ipv4: [`10.0.${i}.5`], ipv6: [`fe80::1:${i}%12`], gateway: [`10.0.${i}.1`], dnsServers: ['10.0.0.1', '10.0.0.2'], dnsSuffix: 'corp.example.com', dhcpEnabled: true, dhcpServer: '10.0.0.1', dhcpLeaseObtainedAt: '2026-11-12T00:00:00Z', dhcpLeaseExpiresAt: '2026-11-13T00:00:00Z' }));
  const n = c.capResult(c.sanitizeResult('network_adapters', { adapters: ads }), c.resultCapFor('network_adapters'));
  const kb = (x) => Math.round(x.bytes / 1024);
  console.log(`  computed stored sizes: 250 processes ${kb(p)} KB, 280 services ${kb(v)} KB, 4 adapters ${kb(n)} KB`);
  check('a typical process list is 25–45 KB stored, untruncated', p.bytes > 25_000 && p.bytes < 45_000 && !p.truncated, String(p.bytes));
  check('a typical service list is 25–50 KB stored, untruncated', v.bytes > 25_000 && v.bytes < 50_000 && !v.truncated, String(v.bytes));
  check('a typical adapter list is under 4 KB', n.bytes < 4096, String(n.bytes));
  const perDay = 5000 * 4 * (p.bytes + v.bytes + n.bytes);
  console.log(`  at 5,000 computers every 6 h: ${(5000 * 3 * 4).toLocaleString()} uploads a day, ${(perDay / 1e9).toFixed(2)} GB a day stored and replaced, ${((5000 * (p.bytes + v.bytes + n.bytes)) / 1e6).toFixed(0)} MB kept`);
  check('every 6 h at 5,000 computers is under 2 GB a day of results', perDay < 2e9, String(perDay));
}

console.log(`\nunit-snapshot-schedule: ${passed} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1); }
