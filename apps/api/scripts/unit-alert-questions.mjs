#!/usr/bin/env node
// The eight questions every alert answers (0.92, UX P1-6):
// apps/api/src/monitoring/alert-questions.ts, run against dist (npx nest build first).
//
//   node scripts/unit-alert-questions.mjs
//
// Every monitor kind has an evidence source; stale or missing telemetry is
// never "fresh"; only a measurement verifies a resolve (a person's word, a
// closed monitor and a clear while the agent was silent do not); the ticket
// question is absent with no PSA and no ticket; every answer is in the
// directive's order.

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const Q = require(join(here, '..', 'dist', 'monitoring', 'alert-questions.js'));
const { MONITOR_KINDS } = require(join(here, '..', 'dist', 'monitoring', 'engine.js'));
const { HEARTBEAT_STALE_MS } = require(join(here, '..', 'dist', 'common', 'connectivity.js'));

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => { if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); } };

const now = Date.parse('2026-11-27T12:00:00Z');
const min = (m) => new Date(now - m * 60_000);
const base = {
  kind: 'CPU_HIGH', severity: 'WARNING', state: 'OPEN', business: { name: 'Acme' }, site: { name: 'HQ' }, device: { name: 'ACME-PC1' },
  childCount: 0, firstSeenAt: min(60), lastSeenAt: min(2), occurrences: 4, suppressed: false,
  resolvedAt: null, resolvedBy: null, resolveNote: null, agentLastSeenAt: min(2),
  explanation: { whatHappened: 'The processor stayed busy.', howSerious: 'Set as a warning on the monitor.', recommendedAction: 'Look at the Processes tab.' },
  tickets: [], psaConfigured: false, now,
};
const by = (o) => Object.fromEntries(Q.answerAlert({ ...base, ...o }).map((a) => [a.key, a]));

check('the eight keys, in the directive\'s order', JSON.stringify(Q.QUESTION_KEYS) === JSON.stringify(['what', 'who', 'when', 'fresh', 'why', 'act', 'ticket', 'resolved']));
for (const k of [...MONITOR_KINDS, 'SITE_OUTAGE']) check(`${k} has an evidence source`, ['agent', 'absence', 'vendor', 'provider'].includes(Q.SOURCE_OF[k]), String(Q.SOURCE_OF[k]));
check('no source is listed for a kind that does not exist', Object.keys(Q.SOURCE_OF).every((k) => MONITOR_KINDS.includes(k) || k === 'SITE_OUTAGE'));

{
  const a = Q.answerAlert(base);
  check('standalone: seven answers, no ticket question', a.length === 7 && !a.some((x) => x.key === 'ticket'), a.map((x) => x.key).join());
  check('answers come in order', JSON.stringify(a.map((x) => x.key)) === JSON.stringify(Q.QUESTION_KEYS.filter((k) => k !== 'ticket')));
  check('every answer has its question and words', a.every((x) => x.question === Q.QUESTION[x.key] && x.text.length > 10));
  const f = by({});
  check('what is the explanation\'s own words', f.what.text === base.explanation.whatHappened);
  check('who names the customer, the site and the device', /Acme/.test(f.who.text) && /HQ/.test(f.who.text) && /ACME-PC1/.test(f.who.text));
  check('when gives first and last seen and the count', /First seen 2026-11-27 11:00 UTC/.test(f.when.text) && /last seen 2026-11-27 11:58 UTC, 4 times/.test(f.when.text));
  check('why says why a CPU alert matters, then the severity', /slow/.test(f.why.text) && f.why.text.endsWith(base.explanation.howSerious));
  check('act says acknowledging and resolving change nothing and need no ticket', /change nothing on the device/.test(f.act.text) && /no ticket is needed/.test(f.act.text));
  check('a maintenance hold is said, not hidden', /maintenance window/.test(by({ suppressed: true }).when.text));
  check('no customer is said plainly', /No customer/.test(by({ business: null }).who.text));
  check('a site outage counts its devices', /3 devices grouped/.test(by({ kind: 'SITE_OUTAGE', device: null, childCount: 3 }).who.text));
}

// Freshness.
check('agent reported 2 min ago: fresh', by({}).fresh.status === 'fresh');
check('…29 min: still fresh', by({ agentLastSeenAt: min(29) }).fresh.status === 'fresh');
check('…31 min: stale, and says silence is not health', by({ agentLastSeenAt: min(31) }).fresh.status === 'stale' && /silence is not health/.test(by({ agentLastSeenAt: min(31) }).fresh.text));
check('the stale window is the heartbeat window', HEARTBEAT_STALE_MS === 30 * 60_000);
check('never reported: unknown, never fresh', by({ agentLastSeenAt: null }).fresh.status === 'unknown' && /not known to be healthy/.test(by({ agentLastSeenAt: null }).fresh.text));
check('a bad date is unknown', by({ agentLastSeenAt: 'nonsense' }).fresh.status === 'unknown');
check('offline is the absence of reports, never fresh', by({ kind: 'OFFLINE', agentLastSeenAt: min(90) }).fresh.status === 'absence');
check('agent silent is the absence of reports', by({ kind: 'AGENT_SILENT', agentLastSeenAt: min(90) }).fresh.status === 'absence');
check('warranty is stored data, not telemetry', by({ kind: 'WARRANTY_EXPIRING' }).fresh.status === 'stored' && /not live telemetry/.test(by({ kind: 'WARRANTY_EXPIRING' }).fresh.text));
check('backup kinds are the provider\'s report', ['BACKUP_STALE', 'BACKUP_FAILED', 'DRILL_FAILED', 'RPO_EXCEEDED'].every((k) => by({ kind: k }).fresh.status === 'stored'));
check('an unknown kind is unknown', by({ kind: 'MYSTERY' }).fresh.status === 'unknown');
for (const k of MONITOR_KINDS.filter((k) => Q.SOURCE_OF[k] === 'agent')) check(`${k} with a 2-hour-old report is stale`, by({ kind: k, agentLastSeenAt: min(120) }).fresh.status === 'stale');

// Verification.
check('open: not yet', by({}).resolved.status === 'open');
check('an open event alert says how it clears', /quiet period/.test(by({ kind: 'EVENT_MATCH' }).resolved.text));
const person = by({ state: 'RESOLVED', resolvedAt: min(5), resolvedBy: 'person', resolveNote: 'Restarted the service' });
check('a person\'s resolve is never verified', person.resolved.status === 'person' && /not a measurement/.test(person.resolved.text) && /Restarted the service/.test(person.resolved.text));
check('…and says the monitor raises it again', /raises a new alert/.test(person.resolved.text));
const cleared = by({ state: 'RESOLVED', resolvedAt: min(5), resolvedBy: 'monitor', resolveNote: 'Cleared: the monitor reads normal again.', agentLastSeenAt: min(5) });
check('a monitor clear with the agent reporting is verified', cleared.resolved.status === 'verified');
const silentClear = by({ kind: 'EVENT_MATCH', state: 'RESOLVED', resolvedAt: min(5), resolvedBy: 'monitor', resolveNote: 'Cleared: no matching events for the quiet period.', agentLastSeenAt: min(300) });
check('a clear while the agent was silent is not verified', silentClear.resolved.status === 'unverified' && /nothing measured it/.test(silentClear.resolved.text));
check('a clear with no agent report at all is not verified', by({ state: 'RESOLVED', resolvedAt: min(5), resolvedBy: 'monitor', resolveNote: 'Cleared: the monitor reads normal again.', agentLastSeenAt: null }).resolved.status === 'unverified');
const closed = by({ state: 'RESOLVED', resolvedAt: min(5), resolvedBy: 'monitor', resolveNote: 'Closed: the monitor no longer applies to this computer, or the computer was retired.' });
check('a monitor that was closed (no longer applies) is not verified', closed.resolved.status === 'unverified' && /without a measurement/.test(closed.resolved.text));
check('a warranty clear needs no agent report', by({ kind: 'WARRANTY_EXPIRING', state: 'RESOLVED', resolvedAt: min(5), resolvedBy: 'monitor', resolveNote: 'Cleared: the warranty end date changed.', agentLastSeenAt: null }).resolved.status === 'verified');
check('a site outage clear is verified', by({ kind: 'SITE_OUTAGE', state: 'RESOLVED', resolvedAt: min(5), resolvedBy: 'monitor', resolveNote: 'Cleared: 0 of 10 computers still offline.', agentLastSeenAt: null }).resolved.status === 'verified');

// Tickets.
check('a PSA with no ticket: asked, and "None", and resolving needs none', by({ psaConfigured: true }).ticket?.status === 'none' && /does not need one/.test(by({ psaConfigured: true }).ticket.text));
const t = by({ tickets: [{ ref: 'T-42', url: null, via: 'automatic' }, { ref: 'CS-7', url: null, via: 'clientst0r' }] });
check('tickets are listed by where they came from, even with no PSA now', t.ticket?.status === 'linked' && /automatic ticket T-42/.test(t.ticket.text) && /ClientSt0r ticket CS-7/.test(t.ticket.text));

// The source.
const src = readFileSync(join(here, '..', 'src', 'monitoring', 'alert-questions.ts'), 'utf8');
check('alert-questions.ts imports only common/connectivity', [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]).join() === '../common/connectivity');
check('alert-questions.ts reads no clock (now is passed in)', !/Date\.now\(|new Date\(\)/.test(src));
const svc = readFileSync(join(here, '..', 'src', 'monitoring', 'monitoring-admin.service.ts'), 'utf8');
check('the detail is the only caller of answerAlert', (svc.match(/answerAlert\(/g) ?? []).length === 1);
check('the PSA is asked only whether a connector applies', /this\.psa\.configuredFor\(r\.customerId\)/.test(svc) && !/this\.psa\.(alertTicket|create|send)/.test(svc));
const conn = readFileSync(join(here, '..', 'src', 'common', 'connectivity.ts'), 'utf8');
check('common/connectivity.ts stays import-free', !/^import /m.test(conn));

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
