#!/usr/bin/env node
// Tests for false-positive reports and alert quality rules (0.67), run against dist:
//
//   node apps/api/scripts/unit-alert-quality-rules.mjs
//
// Pure functions only: src/monitoring/quality-rules.ts, and the classifier
// and explanation it feeds (classify.ts, explain.ts). The database side —
// permissions, approvals, the ingest path, tickets and mail — is proved by
// e2e-alert-quality-rules.mjs.

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const q = require(join(here, '..', 'dist', 'monitoring', 'quality-rules.js'));
const c = require(join(here, '..', 'dist', 'monitoring', 'classify.js'));
const x = require(join(here, '..', 'dist', 'monitoring', 'explain.js'));
const m = require(join(here, '..', 'dist', 'monitoring', 'engine.js'));

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => { if (ok) passed++; else failures.push(`${name}${detail ? ` — ${detail}` : ''}`); };
const J = JSON.stringify;
const NOW = new Date('2026-11-19T12:00:00Z');
const days = (n) => new Date(NOW.getTime() + n * 86_400_000);

// ── Fixtures ────────────────────────────────────────────────────────────────
const ev = (provider, eventId, level, message = '') => ({ provider, eventId, level, message });
const APP = { severity: 'CRITICAL', params: { log: 'Application', ids: [1000, 1002], levels: [1, 2], threshold: 1 } };
const CRASH = ev('Application Error', 1000, 2, 'Faulting application name: vendortool.exe, version: 1.2.3.4');
const HANG = ev('Application Hang', 1002, 2, 'The program othertool.exe version 2.0 stopped interacting with Windows.');
const DISK = { severity: 'CRITICAL', params: m.DISK_ERRORS_PARAMS };
const DISK7 = ev('disk', 7, 2, 'The device, \\Device\\Harddisk0\\DR0, has a bad block.');
const first = (view, samples, count = samples.length) => c.classifyEvents(view, { count, samples });
const fpOf = (view, s) => first(view, [s]).samples[0].fingerprint;

const A = 'bizAAAAAAAAAAAAAAAAAAAAA', B = 'bizBBBBBBBBBBBBBBBBBBBBB';
const EP = 'endpoint1111111111111111', EP2 = 'endpoint2222222222222222';
const ctx = (o = {}) => ({ endpointId: EP, customerId: A, groupIds: new Set(), osFamily: 'windows-client', ruleKey: 'app-crash', monitorRuleId: 'monitorapp000000000000', ...o });
let n = 0;
const rule = (o = {}) => ({
  id: o.id ?? `rule${String(++n).padStart(20, '0')}`, status: 'active', scopeKind: 'business', customerId: A, endpointId: null, groupId: null, monitorRuleId: null, osFamily: null,
  ruleKey: 'app-crash', match: { ruleKey: 'app-crash', provider: 'Application Error', eventId: 1000 }, behaviour: { kind: 'suppress' }, temporary: false, expiresAt: null, ...o,
});
const apply = (rules, view, samples, c0 = ctx(), seenOf = () => 1, count = samples.length) => {
  const f = first(view, samples, count);
  const r = q.adjustSamples(rules, c0, f, seenOf, NOW);
  return { first: f, ...r, second: c.classifyEvents(view, { count, samples }, r.adjust) };
};

// ── Report input ────────────────────────────────────────────────────────────
{
  check('every reason the spec names is offered', J([...q.FP_REASONS].sort()) === J(['duplicate', 'expected_activity', 'incorrect_correlation', 'incorrect_severity', 'incorrect_threshold', 'known_harmless', 'other', 'rule_too_broad'].sort()), J(q.FP_REASONS));
  check('"other" needs an explanation', !q.FalsePositiveInput.safeParse({ reason: 'other' }).success && q.FalsePositiveInput.safeParse({ reason: 'other', comment: 'nightly batch job' }).success);
  const d = q.FalsePositiveInput.parse({ reason: 'known_harmless' });
  check('a report recommends nothing and resolves nothing unless asked', d.recommendPrevent === false && d.resolve === false, J(d));
  check('a report takes no monitor or rule fields', !q.FalsePositiveInput.safeParse({ reason: 'known_harmless', disableMonitor: true }).success);
}

// ── Drafts: narrowness, risk, expiry, keys ──────────────────────────────────
{
  const base = { scope: { kind: 'business' }, behaviour: { kind: 'suppress' }, allowBroad: false };
  check('an event rule on the whole monitor is too broad', q.narrownessProblem({ ...base, match: { ruleKey: 'app-crash' } }, 'EVENT_MATCH')?.code === 'RULE_TOO_BROAD');
  check('a provider alone is too broad', q.narrownessProblem({ ...base, match: { ruleKey: 'app-crash', provider: 'Application Error' } }, 'EVENT_MATCH')?.code === 'RULE_TOO_BROAD');
  check('provider + event id is narrow enough', q.narrownessProblem({ ...base, match: { ruleKey: 'app-crash', provider: 'Application Error', eventId: 1000 } }, 'EVENT_MATCH') === null);
  check('a fingerprint is narrow enough', q.narrownessProblem({ ...base, match: { ruleKey: 'app-crash', fingerprint: 'a'.repeat(16) } }, 'EVENT_MATCH') === null);
  check('allowBroad lifts it (Platform Admin only, enforced in the service)', q.narrownessProblem({ ...base, allowBroad: true, match: { ruleKey: 'app-crash' } }, 'EVENT_MATCH') === null);
  check('a threshold monitor takes no event conditions', q.narrownessProblem({ ...base, match: { ruleKey: 'disk-space', eventId: 1 } }, 'DISK_FREE')?.code === 'EVENT_CONDITIONS_ON_THRESHOLD');
  check('a threshold monitor takes no count or repeat behaviour', q.narrownessProblem({ ...base, behaviour: { kind: 'require_count', minCount: 3 }, match: { ruleKey: 'disk-space' } }, 'DISK_FREE')?.code === 'BEHAVIOUR_NEEDS_EVENTS');
  check('a threshold rule everywhere is too broad', q.narrownessProblem({ ...base, scope: { kind: 'platform' }, match: { ruleKey: 'disk-space' } }, 'DISK_FREE')?.code === 'RULE_TOO_BROAD');
  check('a threshold rule for one business is fine', q.narrownessProblem({ ...base, match: { ruleKey: 'disk-space' } }, 'DISK_FREE') === null);

  const match = { ruleKey: 'app-crash', provider: 'Application Error', eventId: 1000 };
  const mon = (o = {}) => ({ kind: 'EVENT_MATCH', severity: 'WARNING', key: 'app-crash', name: 'Application crashes', log: 'Application', ...o });
  check('suppressing on a warning monitor in one business is normal risk', q.riskOf({ ...base, match }, mon()).risk === 'normal');
  const crit = q.riskOf({ ...base, match }, mon({ severity: 'CRITICAL' }));
  check('suppressing on a critical monitor is high risk', crit.risk === 'high' && crit.reasons.includes('critical_monitor'), J(crit));
  check('downgrading a critical monitor to warning is not, by itself, high risk', q.riskOf({ ...base, match, behaviour: { kind: 'downgrade', severity: 'WARNING' } }, mon({ severity: 'CRITICAL' })).risk === 'normal');
  check('downgrading a critical monitor to info is high risk', q.riskOf({ ...base, match, behaviour: { kind: 'downgrade', severity: 'INFO' } }, mon({ severity: 'CRITICAL' })).risk === 'high');
  check('the Security log is high risk', q.riskOf({ ...base, match }, mon({ log: 'Security' })).reasons.includes('security_log'));
  check('a backup monitor is high risk', q.riskOf({ ...base, match }, mon({ key: 'veeam-backup', name: 'Backup job failed' })).reasons.includes('backup_monitor'));
  check('disk events are high risk', q.riskOf({ ...base, match: { ruleKey: 'disk-errors', provider: 'disk', eventId: 7 } }, mon({ key: 'disk-errors' })).reasons.includes('storage_events'));
  check('platform-wide is high risk', q.riskOf({ ...base, scope: { kind: 'platform' }, match }, mon()).reasons.includes('platform_wide'));
  check('an OS rule for one business is not platform-wide', !q.riskOf({ ...base, scope: { kind: 'os', businessId: A }, match }, mon()).reasons.includes('platform_wide'));
  check('dangerous simulation matches make it high risk', q.riskOf({ ...base, match }, mon(), 2).reasons.includes('dangerous_matches'));

  check('temporary: needs an end date', q.expiryProblem({ temporary: true }, NOW)?.code === 'EXPIRY_REQUIRED');
  check('temporary: at most 90 days', q.expiryProblem({ temporary: true, expiresAt: days(91) }, NOW)?.code === 'EXPIRY_TOO_FAR' && q.expiryProblem({ temporary: true, expiresAt: days(89) }, NOW) === null);
  check('temporary: not in the past', q.expiryProblem({ temporary: true, expiresAt: days(-1) }, NOW)?.code === 'EXPIRY_PAST');
  check('permanent: needs a review date within a year, and no end date', q.expiryProblem({ temporary: false }, NOW)?.code === 'REVIEW_REQUIRED'
    && q.expiryProblem({ temporary: false, reviewAt: days(400) }, NOW)?.code === 'REVIEW_TOO_FAR' && q.expiryProblem({ temporary: false, reviewAt: days(30), expiresAt: days(10) }, NOW)?.code === 'REVIEW_REQUIRED'
    && q.expiryProblem({ temporary: false, reviewAt: days(180) }, NOW) === null);

  check('the match key ignores key order and level order', q.matchKeyOf({ ruleKey: 'k', eventId: 1, levels: [3, 2], provider: 'p' }) === q.matchKeyOf({ provider: 'p', levels: [2, 3, 3], ruleKey: 'k', eventId: 1 }));
  check('the match key changes with the conditions', q.matchKeyOf({ ruleKey: 'k', eventId: 1 }) !== q.matchKeyOf({ ruleKey: 'k', eventId: 2 }));
  check('scope keys have the shapes 0086 CHECKs', q.scopeKeyFor({ kind: 'endpoint', customerId: A, endpointId: EP }) === `e:${EP}` && q.scopeKeyFor({ kind: 'os', customerId: null, osFamily: 'linux' }) === 'os:*:linux'
    && q.scopeKeyFor({ kind: 'os', customerId: A, osFamily: 'windows' }) === `os:${A}:windows` && q.scopeKeyFor({ kind: 'platform', customerId: null }) === 'platform' && q.scopeKeyFor({ kind: 'business', customerId: A }) === `b:${A}`);
  check('a draft is strict (no unknown fields)', !q.RuleDraftInput.safeParse({ name: 'abc', description: 'abc', justification: 'abcdefghijk', scope: { kind: 'business', businessId: A }, match: { ruleKey: 'app-crash', eventId: 1 }, behaviour: { kind: 'suppress' }, temporary: false, reviewAt: days(10).toISOString(), disableMonitor: true }).success);
  check('a downgrade never names CRITICAL', !q.RuleBehaviour.safeParse({ kind: 'downgrade', severity: 'CRITICAL' }).success);
  check('an edit must name the revision it read', !q.RuleEditInput.safeParse({ name: 'abc' }).success && q.RuleEditInput.safeParse({ name: 'abcd', revision: 2 }).success);
}

// ── Scope: tenant isolation, groups, OS ─────────────────────────────────────
{
  check('a business rule does not reach another business', q.scopeCovers(rule(), ctx()) && !q.scopeCovers(rule(), ctx({ customerId: B })));
  check('a computer rule covers only that computer', q.scopeCovers(rule({ scopeKind: 'endpoint', endpointId: EP }), ctx()) && !q.scopeCovers(rule({ scopeKind: 'endpoint', endpointId: EP }), ctx({ endpointId: EP2 })));
  check('a computer rule never crosses a business even with the same id', !q.scopeCovers(rule({ scopeKind: 'endpoint', endpointId: EP }), ctx({ customerId: B })));
  const g = rule({ scopeKind: 'group', groupId: 'group0000000000000001' });
  check('a group rule covers members only, in its own business', q.scopeCovers(g, ctx({ groupIds: new Set(['group0000000000000001']) })) && !q.scopeCovers(g, ctx()) && !q.scopeCovers(g, ctx({ customerId: B, groupIds: new Set(['group0000000000000001']) })));
  const os = rule({ scopeKind: 'os', customerId: null, osFamily: 'windows-server' });
  check('an OS rule matches the family', q.scopeCovers(os, ctx({ osFamily: 'windows-server' })) && !q.scopeCovers(os, ctx()) && q.scopeCovers({ ...os, osFamily: 'windows' }, ctx()));
  check('an OS rule for one business stays there', !q.scopeCovers({ ...os, customerId: A }, ctx({ customerId: B, osFamily: 'windows-server' })));
  check('a platform rule covers every business', q.scopeCovers(rule({ scopeKind: 'platform', customerId: null }), ctx({ customerId: B })));
  check('a monitor-scoped rule covers that monitor row only', q.scopeCovers(rule({ scopeKind: 'monitor', customerId: null, monitorRuleId: 'monitorapp000000000000' }), ctx()) && !q.scopeCovers(rule({ scopeKind: 'monitor', customerId: null, monitorRuleId: 'other000000000000000' }), ctx()));
  check('another monitor is never covered', !q.scopeCovers(rule(), ctx({ ruleKey: 'disk-errors' })));
  check('osFamilyOf', q.osFamilyOf('windows', 'Windows Server 2022') === 'windows-server' && q.osFamilyOf('windows', 'Windows 11 Pro') === 'windows-client' && q.osFamilyOf('linux', '') === 'linux' && q.osFamilyOf('macos', '') === 'macos' && q.osFamilyOf(null, null) === null);
}

// ── Applying rules to an event report ───────────────────────────────────────
{
  const r = apply([rule()], APP, [CRASH]);
  check('suppress: the matching event is taken out; nothing is raised', r.second.severity === null && r.second.effectiveCount === 0 && r.second.basis === 'quality_rule' && r.second.qualityRules?.length === 1, J(r.second));
  check('suppress: the first pass (what is recorded) is unchanged', r.first.severity === 'CRITICAL' && r.first.basis !== 'quality_rule');
  check('suppress: the hit is counted against the rule', r.hits.length === 1 && !r.hits[0].shadow && r.hits[0].events === 1);
  const both = apply([rule()], APP, [CRASH, HANG]);
  check('suppress: an unrelated event in the same report still raises', both.second.severity === 'CRITICAL' && both.second.effectiveCount === 1 && both.second.samples[1].ruleEffect === undefined, J(both.second));
  const unseen = apply([rule()], APP, [CRASH], ctx(), () => 1, 4);
  check('suppress: events counted but not sent keep the WARNING floor', unseen.second.severity === 'WARNING' && unseen.second.basis === 'partial', J(unseen.second));
  const down = apply([rule({ behaviour: { kind: 'downgrade', severity: 'WARNING' } })], APP, [CRASH]);
  check('downgrade: capped at the rule\'s severity, basis quality_rule', down.second.severity === 'WARNING' && down.second.basis === 'quality_rule', J(down.second));
  const downInfo = apply([rule({ behaviour: { kind: 'downgrade', severity: 'WARNING' } })], { ...APP, severity: 'INFO' }, [CRASH]);
  check('downgrade: never raises an alert', downInfo.second.severity === 'INFO', J(downInfo.second));
  const cnt = rule({ behaviour: { kind: 'require_count', minCount: 3 } });
  check('require_count: two in one report are held back', apply([cnt], APP, [CRASH, CRASH]).second.severity === null);
  check('require_count: three in one report raise', apply([cnt], APP, [CRASH, CRASH, CRASH]).second.severity === 'CRITICAL');
  check('require_count: unsent events of a fully covered report count towards it', apply([cnt], APP, [CRASH, CRASH], ctx(), () => 1, 5).second.severity === 'CRITICAL');
  const rep = rule({ behaviour: { kind: 'require_repeats', reports: 3 } });
  check('require_repeats: the second report is held back', apply([rep], APP, [CRASH], ctx(), () => 2).second.severity === null);
  check('require_repeats: the third report raises', apply([rep], APP, [CRASH], ctx(), () => 3).second.severity === 'CRITICAL');

  const pend = apply([rule({ status: 'pending' })], APP, [CRASH]);
  check('shadow: a pending rule is counted, never applied', pend.second.severity === 'CRITICAL' && pend.adjust.every((a) => a === null) && pend.hits.length === 1 && pend.hits[0].shadow, J(pend.hits));
  check('a rejected or rolled-back rule does nothing', ['rejected', 'rolled_back', 'superseded', 'expired'].every((s) => apply([rule({ status: s })], APP, [CRASH]).second.severity === 'CRITICAL' && apply([rule({ status: s })], APP, [CRASH]).hits.length === 0));
  const exp = rule({ temporary: true, expiresAt: new Date(NOW.getTime() - 1000) });
  check('expiry: a temporary rule past its end applies no more, before any sweep', apply([exp], APP, [CRASH]).second.severity === 'CRITICAL' && !q.inForce(exp, NOW));
  check('expiry: before its end it applies', apply([rule({ temporary: true, expiresAt: days(1) })], APP, [CRASH]).second.severity === null);
  check('tenant: another business\'s rule does nothing here', apply([rule({ customerId: B })], APP, [CRASH]).second.severity === 'CRITICAL' && apply([rule({ customerId: B })], APP, [CRASH]).hits.length === 0);

  // A known-harmless event is never touched (and never counted).
  const DSH = { eventId: 11, level: 4, provider: 'Microsoft-Windows-Kernel-General', message: 'TxR init phase for hive \\??\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy3\\Windows\\System32\\config\\DRIVERS (TM: {x}, RM: {y}) finished with result=0xC00000A2 (Internal code=7).' };
  const OLD = { severity: 'CRITICAL', params: { log: 'System', ids: [7, 11, 51, 153], levels: [], threshold: 1 } };
  const ben = apply([rule({ ruleKey: 'disk-errors', match: { ruleKey: 'disk-errors', provider: 'Microsoft-Windows-Kernel-General', eventId: 11 }, behaviour: { kind: 'downgrade', severity: 'WARNING' } })], OLD, [DSH], ctx({ ruleKey: 'disk-errors' }));
  check('a known-harmless event is left to the classifier', ben.second.basis === 'known_benign' && ben.hits.length === 0, J(ben.second));

  // Precedence: computer beats business; equal levels: more conditions; then what keeps more.
  const biz = rule({ id: 'aaaaaaaaaaaaaaaaaaaa01', behaviour: { kind: 'suppress' } });
  const comp = rule({ id: 'zzzzzzzzzzzzzzzzzzzz01', scopeKind: 'endpoint', endpointId: EP, behaviour: { kind: 'downgrade', severity: 'WARNING' } });
  const p1 = apply([biz, comp], APP, [CRASH]);
  check('precedence: the computer\'s rule beats the business\'s', p1.second.severity === 'WARNING' && p1.adjust[0].ruleId === comp.id, J(p1.adjust));
  const narrow = rule({ id: 'zzzzzzzzzzzzzzzzzzzz02', match: { ...biz.match, levels: [2] }, behaviour: { kind: 'downgrade', severity: 'INFO' } });
  check('precedence: at the same scope, more conditions win', apply([biz, narrow], APP, [CRASH]).adjust[0].ruleId === narrow.id);
  const twin = rule({ id: 'zzzzzzzzzzzzzzzzzzzz03', behaviour: { kind: 'downgrade', severity: 'WARNING' } });
  const p3 = apply([biz, twin], APP, [CRASH]);
  check('conflict: same scope and conditions, the one that keeps more of the alert wins, and it is flagged', p3.adjust[0].ruleId === twin.id && p3.conflicts.includes(twin.id) && p3.second.severity === 'WARNING', J(p3));
  check('precedence is deterministic whatever the order', apply([twin, biz], APP, [CRASH]).adjust[0].ruleId === twin.id && apply([comp, biz], APP, [CRASH]).adjust[0].ruleId === comp.id);
  check('conflictsAmong finds two active rules that disagree on overlapping events', J(q.conflictsAmong([biz, twin])) === J([{ a: biz.id, b: twin.id }]) && q.conflictsAmong([biz, comp]).length === 0);

  // Dangerous: suppressing a genuine disk failure.
  const dr = rule({ ruleKey: 'disk-errors', match: { ruleKey: 'disk-errors', provider: 'disk', eventId: 7 } });
  const d = apply([dr], DISK, [DISK7], ctx({ ruleKey: 'disk-errors' }));
  check('a suppressed event the classifier knows as CRITICAL is a dangerous match', d.hits[0].dangerous === 1 && d.second.severity === null, J(d.hits));

  // Matching conditions
  const fp = fpOf(APP, CRASH);
  check('a fingerprint rule matches only that fingerprint', apply([rule({ match: { ruleKey: 'app-crash', fingerprint: fp } })], APP, [CRASH, HANG]).second.samples.map((s) => s.ruleEffect ?? null).join() === 'suppressed,');
  check('a level condition must hold', apply([rule({ match: { ...biz.match, levels: [3] } })], APP, [CRASH]).second.severity === 'CRITICAL');
  check('the provider matches case-insensitively', apply([rule({ match: { ruleKey: 'app-crash', provider: 'application error', eventId: 1000 } })], APP, [CRASH]).second.severity === null);
}

// ── Threshold monitors ──────────────────────────────────────────────────────
{
  const t = (o) => rule({ ruleKey: 'disk-space', match: { ruleKey: 'disk-space' }, ...o });
  const c0 = ctx({ ruleKey: 'disk-space' });
  check('threshold: suppress raises nothing, and names the rule', J(q.adjustThreshold([t({ id: 'tttttttttttttttttttt01' })], c0, 'CRITICAL', NOW)) === J({ severity: null, ruleId: 'tttttttttttttttttttt01' }));
  check('threshold: another business\'s rule does nothing', q.adjustThreshold([t({ customerId: B })], c0, 'CRITICAL', NOW).ruleId === null);
  check('threshold: downgrade caps, never raises', q.adjustThreshold([t({ behaviour: { kind: 'downgrade', severity: 'WARNING' } })], c0, 'CRITICAL', NOW).severity === 'WARNING'
    && q.adjustThreshold([t({ behaviour: { kind: 'downgrade', severity: 'WARNING' } })], c0, 'INFO', NOW).severity === 'INFO');
  check('threshold: an expired or pending rule does nothing', q.adjustThreshold([t({ temporary: true, expiresAt: days(-1) })], c0, 'CRITICAL', NOW).ruleId === null && q.adjustThreshold([t({ status: 'pending' })], c0, 'CRITICAL', NOW).ruleId === null);
  check('threshold: an event-condition rule never matches a threshold alert', q.adjustThreshold([t({ match: { ruleKey: 'disk-space', eventId: 1 } })], c0, 'CRITICAL', NOW).ruleId === null);
}

// ── Simulation ──────────────────────────────────────────────────────────────
{
  const alert = (id, samples, o = {}) => ({ id, title: `alert ${id}`, customerId: A, endpointId: EP, ruleKey: 'app-crash', ruleId: 'monitorapp000000000000', kind: 'EVENT_MATCH', severity: 'CRITICAL', state: 'OPEN',
    firstSeenAt: NOW, detail: { count: samples.length, samples }, classification: null, log: 'Application', ruleSeverity: 'CRITICAL', ruleParams: APP.params, ctx: ctx(), ...o });
  const hist = [alert('a1', [CRASH]), alert('a2', [HANG]), alert('a3', [CRASH, HANG]), alert('a4', [CRASH], { customerId: B, ctx: ctx({ customerId: B }) })];
  const s = q.simulateRule(rule({ status: 'pending' }), 1, hist, [], NOW);
  check('simulation: matches only what the rule covers, in its own business', s.considered === 3 && s.matched === 2 && s.wouldSuppress === 1 && s.unchanged === 1 && s.revision === 1, J(s));
  check('simulation: before and after per alert', s.changes.some((ch) => ch.alertId === 'a1' && ch.before === 'CRITICAL' && ch.after === null));
  check('simulation: a pending rule is simulated as if active, and nothing is stored on the input', hist[0].classification === null);
  const dsim = q.simulateRule(rule({ ruleKey: 'disk-errors', match: { ruleKey: 'disk-errors', provider: 'disk', eventId: 7 } }), 1,
    [alert('d1', [DISK7], { ruleKey: 'disk-errors', ruleParams: DISK.params, log: 'System', ctx: ctx({ ruleKey: 'disk-errors' }) })], [], NOW);
  check('simulation: a genuine disk failure is a dangerous match', dsim.dangerous.length === 1 && dsim.dangerous[0].alertId === 'd1', J(dsim.dangerous));
  const sec = q.simulateRule(rule(), 1, [alert('s1', [CRASH], { log: 'Security' })], [], NOW);
  check('simulation: a Security-log match is dangerous', sec.dangerous.length === 1);
  const thr = q.simulateRule(rule({ ruleKey: 'disk-space', match: { ruleKey: 'disk-space' } }), 1, [alert('t1', [], { ruleKey: 'disk-space', kind: 'DISK_FREE', ctx: ctx({ ruleKey: 'disk-space' }) })], [], NOW);
  check('simulation: suppressing a critical threshold alert is dangerous', thr.wouldSuppress === 1 && thr.dangerous.length === 1, J(thr));
  const fp = fpOf(APP, CRASH);
  const evs = q.simulateRule(rule(), 1, [], [{ endpointId: EP, ruleKey: 'app-crash', fingerprint: fp, class: 'UNKNOWN', seen: 7, sample: CRASH, log: 'Application', ctx: ctx() }], NOW);
  check('simulation: recorded events that never became alerts are counted', evs.events.fingerprints === 1 && evs.events.occurrences === 7, J(evs.events));
}

// ── Recommendations ─────────────────────────────────────────────────────────
{
  const facts = { kind: 'EVENT_MATCH', monitorName: 'Application crashes', monitorSeverity: 'CRITICAL', log: 'Application', provider: 'Application Error', eventId: 1000, level: 2, statusCode: null, component: null, className: 'UNKNOWN' };
  const fp = fpOf(APP, CRASH);
  const base = { ruleKey: 'app-crash', fingerprint: fp, facts, reportCount: 3, computers: 2, businessId: A };
  const harmless = q.recommendationText({ ...base, reasons: { known_harmless: 3 } });
  check('known harmless → a narrow suppress draft for that business', harmless.draft?.behaviour.kind === 'suppress' && harmless.draft.scope.kind === 'business' && harmless.draft.match.fingerprint === fp && harmless.draft.match.eventId === 1000, J(harmless.draft));
  check('the draft is narrow enough to propose', q.narrownessProblem({ ...harmless.draft, allowBroad: false }, 'EVENT_MATCH') === null);
  check('every recommendation says it is not validated yet', /Not validated yet/.test(harmless.caution) && harmless.title === 'Proposed Rule Improvement');
  check('incorrect severity → a downgrade to warning', q.recommendationText({ ...base, reasons: { incorrect_severity: 2, known_harmless: 1 } }).draft?.behaviour.kind === 'downgrade');
  check('duplicate → require repeats', q.recommendationText({ ...base, reasons: { duplicate: 2 } }).draft?.behaviour.kind === 'require_repeats');
  const corr = q.recommendationText({ ...base, reasons: { incorrect_correlation: 2 } });
  check('incorrect correlation → a monitor correction, no rule', corr.draft === null && corr.title === 'Proposed Monitor Correction', J(corr));
  check('a threshold monitor\'s wrong threshold → a monitor correction', q.recommendationText({ ...base, fingerprint: null, facts: { ...facts, kind: 'DISK_FREE' }, reasons: { incorrect_threshold: 2 } }).draft === null);
  check('priority rises with reports, reporters and computers — it never authorises anything', q.priorityOf({ reportCount: 5, reporters: 3, computers: 4, lastReportedAt: NOW }, NOW) > q.priorityOf({ reportCount: 1, reporters: 1, computers: 1, lastReportedAt: NOW }, NOW));
  check('topReason breaks ties in a fixed order', q.topReason({ duplicate: 2, known_harmless: 2 }) === 'known_harmless');
}

// ── Monitoring-quality checks ───────────────────────────────────────────────
{
  const stats = (o = {}) => ({ ruleId: 'monitorapp000000000000', key: 'app-crash', name: 'Application crashes', kind: 'EVENT_MATCH', severity: 'CRITICAL', enabled: true, params: APP.params, createdAt: days(-200), businessId: null,
    alerts7d: 0, alertsPrev7d: 0, alerts30d: 0, alerts90d: 5, computers7d: 0, quickResolves7d: 0, resolves7d: 0, fpReports30d: 0, informational30d: 0, byAgentVersion: [], ...o });
  const codes = (o, extra = {}) => q.qualityChecks({ monitors: [stats(o)], duplicates: [], rules: [], ...extra }, NOW).map((x) => x.code);
  check('high volume', codes({ alerts7d: 80, computers7d: 4 }).includes('high_volume'));
  check('frequently reported false positives', codes({ fpReports30d: 4 }).includes('false_positives'));
  check('flapping', codes({ quickResolves7d: 6, resolves7d: 8 }).includes('flapping'));
  check('escalating informational events', q.qualityChecks({ monitors: [stats({ params: { log: 'System', ids: [1], levels: [4] } })], duplicates: [], rules: [] }, NOW).some((x) => x.code === 'escalates_informational'));
  check('a sensitive threshold', codes({ alerts30d: 30 }).includes('sensitive_threshold'));
  check('never triggers — and says not to remove it for that', q.qualityChecks({ monitors: [stats({ alerts90d: 0 })], duplicates: [], rules: [] }, NOW).find((x) => x.code === 'never_triggers')?.recommendation.includes('do not remove'));
  check('noise after an agent update', codes({ alerts7d: 40, alertsPrev7d: 5, byAgentVersion: [{ version: '0.66.0', alerts: 38, computers: 2 }, { version: '0.65.1', alerts: 2, computers: 10 }] }).includes('after_agent_update'));
  check('a disabled monitor is not judged', codes({ enabled: false, alerts7d: 500, computers7d: 1 }).length === 0);
  check('duplicate monitors', codes({}, { duplicates: [{ endpointId: EP, fingerprint: 'f', keys: ['a', 'b'] }] }).includes('duplicate_monitors'));
  const r1 = { ...rule({ id: 'cccccccccccccccccccc01' }), name: 'one', dangerousMatchCount: 0, risk: 'normal', reviewAt: days(-1), matchCount: 3 };
  const r2 = { ...rule({ id: 'cccccccccccccccccccc02', behaviour: { kind: 'downgrade', severity: 'WARNING' } }), name: 'two', dangerousMatchCount: 2, risk: 'high', reviewAt: days(10), matchCount: 1 };
  const rc = q.qualityChecks({ monitors: [], duplicates: [], rules: [r1, r2] }, NOW).map((x) => x.code);
  check('conflicting rules, a rule hiding failures, and an overdue review', rc.includes('conflicting_rules') && rc.includes('rule_hides_failures') && rc.includes('review_overdue'), J(rc));
  check('checks are sorted high first', q.qualityChecks({ monitors: [stats({ fpReports30d: 9, alerts90d: 0, createdAt: days(-200) })], duplicates: [], rules: [] }, NOW)[0].level === 'high');
}

// ── The explanation names the rule ──────────────────────────────────────────
{
  const r = apply([rule({ behaviour: { kind: 'downgrade', severity: 'WARNING' } })], APP, [CRASH]);
  const e = x.explainAlert({ kind: 'EVENT_MATCH', ruleKey: 'app-crash', title: 't', severity: 'WARNING', detail: { count: 1, samples: [CRASH] }, classification: r.second,
    rule: { name: 'Application crashes', severity: 'CRITICAL', params: APP.params }, qualityRules: [{ id: 'x', name: 'Vendor tool crash is harmless' }] });
  const s = J(e);
  check('the explanation says an approved rule lowered it, by name', /approved alert quality rule/.test(s) && /Vendor tool crash is harmless/.test(s), s.slice(0, 400));
}

console.log(`unit-alert-quality-rules: ${passed} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1); }
