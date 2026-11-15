#!/usr/bin/env node
// Monthly patch windows (0.53), run against dist:
//
//   node apps/api/scripts/unit-monthly-window.mjs
//
// The window union in the policy document (src/actions/patch-policy.ts):
// weekly, unchanged since 0.32, and the two monthly shapes — the nth or last
// weekday of the month plus an offset of 0–14 days, and a day of the month
// 1–28. The occurrence arithmetic (last weekday, a fifth weekday, an offset
// carried into the next month, a window crossing midnight at month end, DST
// in both hemispheres), expiry (`window_never_opens`), the signer admitting a
// monthly policy and signing ring plans inside it and refusing them outside
// (`outside_window`), unknown shapes refused at every layer, and a weekly
// document's digest pinned to its 0.52 value. No database, no network.

import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const dist = join(here, '..', 'dist');
const P = require(join(dist, 'actions', 'patch-policy.js'));
const core = require(join(dist, 'approval-signer', 'core.js'));
const page = require(join(dist, 'approval-signer', 'page.js'));

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => { if (ok) passed++; else failures.push(`${name}${detail ? ` — ${detail}` : ''}`); };
const iso = (t) => new Date(t).toISOString();
const sha = (s) => createHash('sha256').update(s).digest('hex');
const hex = (n) => randomBytes(n).toString('hex');
const span = (o) => (o ? `${o.start.toISOString()} → ${o.end.toISOString()}` : 'null');
const hours = (o) => (o ? (o.end - o.start) / 3600_000 : NaN);

const PT = (o = {}) => ({ kind: 'monthly', week: 'second', weekday: 'tue', offsetDays: 0, start: '22:00', end: '04:00', timezone: 'America/Chicago', ...o });
const DAY = (o = {}) => ({ kind: 'monthly', day: 15, start: '02:00', end: '05:00', timezone: 'UTC', ...o });

// ── The schema: a closed union ──────────────────────────────────────────────
{
  const ok = (w) => P.PolicyWindow.safeParse(w).success;
  check('weekly (no kind) parses, as before', ok({ days: ['sat'], start: '22:00', end: '04:00', timezone: 'America/Chicago' }));
  check('monthly nth weekday parses', ok(PT()) && ok(PT({ week: 'last', weekday: 'sat' })) && ok(PT({ week: 'first', offsetDays: 14 })));
  check('monthly day of month parses, 1 and 28', ok(DAY({ day: 1 })) && ok(DAY({ day: 28 })));
  check('day 29, 30, 31 and 0 are refused (there is no day that skips February)', [0, 29, 30, 31].every((d) => !ok(DAY({ day: d }))));
  check('a fractional day is refused', !ok(DAY({ day: 1.5 })));
  check('an offset over 14 days, or negative, or fractional, is refused', !ok(PT({ offsetDays: 15 })) && !ok(PT({ offsetDays: -1 })) && !ok(PT({ offsetDays: 1.5 })));
  check('the offset is required (one encoding: 0, never absent)', !ok({ kind: 'monthly', week: 'second', weekday: 'tue', start: '22:00', end: '04:00', timezone: 'UTC' }));
  check('a fifth week is refused (it is "last")', !ok(PT({ week: 'fifth' })) && !ok(PT({ week: 5 })));
  check('an unknown weekday is refused', !ok(PT({ weekday: 'someday' })));
  check('an unknown kind is refused (yearly, weekly, quarterly, none)', ['yearly', 'weekly', 'quarterly', '', null].every((k) => !ok({ ...DAY(), kind: k })));
  check('a weekly window that names a kind is refused (weekly has none)', !ok({ kind: 'weekly', days: ['sat'], start: '22:00', end: '04:00', timezone: 'UTC' }) && !ok({ kind: 'monthly', days: ['sat'], start: '22:00', end: '04:00', timezone: 'UTC' }));
  check('day and week together are refused (one form or the other)', !ok({ ...PT(), day: 15 }));
  check('a day form with an offset is refused (offsets belong to the weekday form)', !ok({ ...DAY(), offsetDays: 2 }));
  check('an extra field is refused (strict)', !ok({ ...PT(), note: 'x' }) && !ok({ ...DAY(), every: 2 }));
  check('an empty monthly window is refused', !ok(PT({ start: '03:00', end: '03:00' })) && !ok(DAY({ start: '03:00', end: '03:00' })));
  check('a monthly window needs a timezone this runtime knows', !ok(PT({ timezone: 'Mars/Olympus_Mons' })));
  check('windowKind names the three shapes and nothing else',
    P.windowKind({ days: ['sat'] }) === 'weekly' && P.windowKind(PT()) === 'monthly' && P.windowKind(DAY()) === 'monthly'
      && P.windowKind({ kind: 'yearly', day: 1 }) === null && P.windowKind({ kind: 'monthly', days: ['sat'], day: 1 }) === null
      && P.windowKind({ kind: 'monthly' }) === null && P.windowKind({ kind: 'monthly', day: 1, week: 'first' }) === null
      && P.windowKind({}) === null && P.windowKind(null) === null && P.windowKind('weekly') === null);
}

// ── Which date each month ───────────────────────────────────────────────────
{
  const d = (y, m, w) => { const r = P.monthlyDate(y, m, w); return r ? `${r.y}-${String(r.m).padStart(2, '0')}-${String(r.d).padStart(2, '0')}` : null; };
  const pt2026 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((m) => d(2026, m, PT()));
  check('Patch Tuesday 2026 is the second Tuesday of each month',
    pt2026.join() === '2026-01-13,2026-02-10,2026-03-10,2026-04-14,2026-05-12,2026-06-09,2026-07-14,2026-08-11,2026-09-08,2026-10-13,2026-11-10,2026-12-08', pt2026.join());
  check('the first Tuesday of a month that starts on a Tuesday is the 1st', d(2026, 12, PT({ week: 'first' })) === '2026-12-01');
  check('the last Saturday of February 2027 (28 days) is the 27th', d(2027, 2, PT({ week: 'last', weekday: 'sat' })) === '2027-02-27');
  check('the last Saturday of October 2026 is the 31st, the month\'s last day', d(2026, 10, PT({ week: 'last', weekday: 'sat' })) === '2026-10-31');
  check('in a month with five Tuesdays, "last" is the fifth and "fourth" is not last',
    d(2026, 12, PT({ week: 'last' })) === '2026-12-29' && d(2026, 12, PT({ week: 'fourth' })) === '2026-12-22');
  check('in a month with four Tuesdays, "last" and "fourth" are the same day', d(2026, 11, PT({ week: 'last' })) === d(2026, 11, PT({ week: 'fourth' })));
  check('Patch Tuesday plus 2 is the Thursday after it', d(2026, 11, PT({ offsetDays: 2 })) === '2026-11-12');
  check('an offset carries into the next month (last Saturday of November + 7 = 5 December)', d(2026, 11, PT({ week: 'last', weekday: 'sat', offsetDays: 7 })) === '2026-12-05');
  check('…and into the next year (last Saturday of December 2026 + 14 = 9 January 2027)', d(2026, 12, PT({ week: 'last', weekday: 'sat', offsetDays: 14 })) === '2027-01-09');
  check('a leap February: the last Sunday of February 2028 is the 27th, the 29th is a Tuesday', d(2028, 2, PT({ week: 'last', weekday: 'sun' })) === '2028-02-27' && d(2028, 2, PT({ week: 'last', weekday: 'tue' })) === '2028-02-29');
  check('day 28 of February is the 28th, in a leap year too', d(2027, 2, DAY({ day: 28 })) === '2027-02-28' && d(2028, 2, DAY({ day: 28 })) === '2028-02-28');
  check('a shape that is not monthly has no date', P.monthlyDate(2026, 11, { kind: 'monthly', week: 'fifth', weekday: 'tue', offsetDays: 0 }) === null
    && P.monthlyDate(2026, 11, { kind: 'monthly', day: 31 }) === null && P.monthlyDate(2026, 11, { kind: 'monthly', week: 'first', weekday: 'tue', offsetDays: 30 }) === null);
}

// ── Occurrences ─────────────────────────────────────────────────────────────
{
  const NOV15 = new Date('2026-11-15T12:00:00Z');
  const o = P.occurrenceAt(new Date('2026-11-11T05:00:00Z'), PT()); // Tue 10 Nov 23:00 CST
  check('Patch Tuesday 22:00–04:00 Chicago contains 23:00 that night', o && o.start.toISOString() === '2026-11-11T04:00:00.000Z' && o.end.toISOString() === '2026-11-11T10:00:00.000Z', span(o));
  check('…and the early hours of Wednesday belong to it', P.occurrenceAt(new Date('2026-11-11T09:30:00Z'), PT())?.start.toISOString() === '2026-11-11T04:00:00.000Z');
  check('the end is exclusive, the start inclusive', P.occurrenceAt(new Date('2026-11-11T10:00:00Z'), PT()) === null && P.occurrenceAt(new Date('2026-11-11T04:00:00Z'), PT()) !== null);
  check('the same Tuesday a week later is not in a monthly window (it would be in a weekly one)',
    P.occurrenceAt(new Date('2026-11-18T05:00:00Z'), PT()) === null && P.occurrenceAt(new Date('2026-11-18T05:00:00Z'), { days: ['tue'], start: '22:00', end: '04:00', timezone: 'America/Chicago' }) !== null);
  const n = P.nextOccurrence(NOV15, PT());
  check('the next Patch Tuesday window after 15 November is 8 December (CST)', n && n.start.toISOString() === '2026-12-09T04:00:00.000Z', span(n));
  const three = P.nextOccurrences(NOV15, PT(), 3);
  check('the next three: 8 December, 12 January, 9 February',
    three.map((x) => x.start.toISOString()).join() === '2026-12-09T04:00:00.000Z,2027-01-13T04:00:00.000Z,2027-02-10T04:00:00.000Z', three.map(span).join('; '));
  check('nextOccurrences stops at the bound', P.nextOccurrences(NOV15, PT(), 3, new Date('2027-01-20T00:00:00Z')).length === 2 && P.nextOccurrences(NOV15, PT(), 3, new Date('2026-12-01T00:00:00Z')).length === 0);
  check('nextOccurrences asks for at most 12', P.nextOccurrences(NOV15, DAY(), 50).length === 12);
  check('an open window is the next occurrence while it is open', P.nextOccurrence(new Date('2026-11-11T06:00:00Z'), PT())?.start.toISOString() === '2026-11-11T04:00:00.000Z');

  const roll = PT({ week: 'last', weekday: 'sat', offsetDays: 7, start: '09:00', end: '12:00', timezone: 'UTC' });
  const rs = P.nextOccurrences(new Date('2026-11-20T00:00:00Z'), roll, 3).map((x) => x.start.toISOString().slice(0, 10));
  check('an offset into the next month: November\'s falls on 5 December, December\'s on 2 January, January\'s on 6 February', rs.join() === '2026-12-05,2027-01-02,2027-02-06', rs.join());
  check('…and the base date itself (the last Saturday) is not an occurrence', P.occurrenceAt(new Date('2026-11-28T10:00:00Z'), roll) === null && P.occurrenceAt(new Date('2026-12-05T10:00:00Z'), roll) !== null);
  // Two occurrences in one month: last Saturday of October + 0 = 31 Oct, of November + 7 = 5 Dec, but with a 14-day offset December holds two.
  const two = PT({ week: 'first', weekday: 'mon', offsetDays: 14, start: '09:00', end: '10:00', timezone: 'UTC' });
  check('each month\'s occurrence is counted from that month (first Monday + 14 never doubles up)',
    P.nextOccurrences(new Date('2026-11-01T00:00:00Z'), two, 3).map((x) => x.start.toISOString().slice(0, 10)).join() === '2026-11-16,2026-12-21,2027-01-18');

  // Across midnight at the end of a month, and across a DST change.
  const feb = DAY({ day: 28, start: '22:00', end: '02:00', timezone: 'UTC' });
  const f = P.occurrenceAt(new Date('2027-03-01T01:00:00Z'), feb);
  check('the 28th 22:00–02:00 crosses into 1 March and 1 March 01:00 belongs to it', f && f.start.toISOString() === '2027-02-28T22:00:00.000Z' && f.end.toISOString() === '2027-03-01T02:00:00.000Z', span(f));
  check('…and in a leap year it ends on 29 February, not 1 March', P.occurrenceAt(new Date('2028-02-29T01:00:00Z'), feb)?.end.toISOString() === '2028-02-29T02:00:00.000Z');
  const halloween = PT({ week: 'last', weekday: 'sat', start: '23:00', end: '03:00', timezone: 'America/New_York' });
  const h = P.occurrenceAt(new Date('2026-11-01T05:00:00Z'), halloween);
  check('the last Saturday of October 2026 (the 31st) 23:00–03:00 New York crosses the month end and fall-back: 5 real hours', h && h.start.toISOString() === '2026-11-01T03:00:00.000Z' && hours(h) === 5, span(h));
  const fallback = P.nextOccurrence(new Date('2026-10-20T00:00:00Z'), PT({ week: 'first', weekday: 'sun', start: '00:00', end: '03:00', timezone: 'America/New_York' }));
  check('the first Sunday of November 2026 (fall-back) 00:00–03:00 New York lasts 4 real hours', fallback && fallback.start.toISOString() === '2026-11-01T04:00:00.000Z' && hours(fallback) === 4, span(fallback));
  const spring = P.nextOccurrence(new Date('2026-03-01T12:00:00Z'), PT({ week: 'second', weekday: 'sun', start: '01:00', end: '04:00', timezone: 'America/New_York' }));
  check('the second Sunday of March 2026 (spring-forward) 01:00–04:00 New York lasts 2 real hours', spring && spring.start.toISOString() === '2026-03-08T06:00:00.000Z' && hours(spring) === 2, span(spring));
  const syd = P.nextOccurrence(new Date('2026-09-25T00:00:00Z'), PT({ week: 'first', weekday: 'sun', start: '01:00', end: '04:00', timezone: 'Australia/Sydney' }));
  check('southern hemisphere: the first Sunday of October 2026 (Sydney springs forward) 01:00–04:00 lasts 2 real hours', syd && syd.start.toISOString() === '2026-10-03T15:00:00.000Z' && hours(syd) === 2, span(syd));
  const pt = P.nextOccurrences(new Date('2026-06-01T00:00:00Z'), PT(), 6).map((x) => x.start.toISOString());
  check('the same local window is 03:00Z in summer and 04:00Z in winter (CDT, then CST)', pt[0] === '2026-06-10T03:00:00.000Z' && pt[5] === '2026-11-11T04:00:00.000Z', pt.join());
  check('a monthly window is never found more than ~5 weeks apart, from any day of a year',
    Array.from({ length: 365 }, (_, i) => new Date(Date.UTC(2026, 0, 1 + i))).every((t) => { const x = P.nextOccurrence(t, PT({ week: 'last', weekday: 'sat', offsetDays: 14 })); return x && x.start - t < 37 * 86_400_000; }));
  check('every day-28 window in 2026–2028 opens on the 28th', P.nextOccurrences(new Date('2026-01-01T00:00:00Z'), DAY({ day: 28 }), 12).every((x) => x.start.getUTCDate() === 28));
}

// ── Unknown shapes fail closed in the functions too ─────────────────────────
{
  const t = new Date('2026-11-11T05:00:00Z');
  const bad = [{ kind: 'yearly', day: 11, start: '22:00', end: '04:00', timezone: 'America/Chicago' }, { kind: 'monthly', start: '22:00', end: '04:00', timezone: 'UTC' }, { start: '22:00', end: '04:00', timezone: 'UTC' }];
  check('an unknown shape never opens: occurrenceAt and nextOccurrence are null for it', bad.every((w) => P.occurrenceAt(t, w) === null && P.nextOccurrence(t, w) === null && P.nextOccurrences(t, w, 3).length === 0));
  check('describePolicyWindow says it is unrecognised rather than guessing', /unrecognised/.test(P.describePolicyWindow(bad[0])));
}

// ── Words ───────────────────────────────────────────────────────────────────
{
  check('a weekly window reads exactly as before 0.53', P.describePolicyWindow({ days: ['sat', 'sun'], start: '22:00', end: '04:00', timezone: 'America/Chicago' }) === 'sat, sun 22:00–04:00 America/Chicago');
  check('Patch Tuesday reads as the second Tuesday', P.describePolicyWindow(PT()) === 'the second Tuesday of each month 22:00–04:00 America/Chicago', P.describePolicyWindow(PT()));
  check('an offset reads as days after it', P.describePolicyWindow(PT({ offsetDays: 2 })) === '2 days after the second Tuesday of each month 22:00–04:00 America/Chicago' && /^1 day after/.test(P.describePolicyWindow(PT({ offsetDays: 1 }))));
  check('a day of the month reads as an ordinal', ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '28th'].every((s) => P.describePolicyWindow(DAY({ day: parseInt(s, 10) })).startsWith(`the ${s} of each month`)));
}

// ── A policy document with a monthly window ─────────────────────────────────
const BIZ = 'biz_month_0001';
const DEV = (name) => ({ endpointId: `ep_${name.toLowerCase()}_0001`, hostname: name, rustdeskId: String(100000000 + Math.floor(Math.random() * 8e8)), deviceSecretSha256: sha(name) });
const CANARY = DEV('CANARY');
const AUTHOR = { userId: 'user_author01', name: 'Owen' };
const SEC = '0fa1201d-4330-4fa8-8ae9-b877473b6441';
const CU = { updateId: '5a1b2c3d-0000-4000-8000-000000000001', revision: 201, kb: 'KB5044284', title: '2026-11 Cumulative Update', className: 'Security Updates', severity: 'Critical' };
// Patch Tuesday + 2, 22:00–04:00 Chicago: Thursday 12 November 2026 22:00 CST = 13 Nov 04:00Z.
const WIN = PT({ offsetDays: 2 });
const OPEN = new Date('2026-11-13T04:00:00Z');
const NOW = new Date('2026-11-13T04:30:00Z');

function doc(over = {}, now = NOW) {
  return {
    schema: 'rem0te-patch-policy/1', policyId: hex(16), name: 'Acme, two days after Patch Tuesday', businessId: BIZ, businessName: 'Acme',
    rings: [[CANARY]], allow: { classifications: [SEC] }, soakHours: 0, failureThreshold: 0, window: WIN, reboot: 'never',
    createdAt: iso(now.getTime() - 3600_000), expiresAt: iso(now.getTime() + 60 * 86_400_000), createdBy: AUTHOR, reason: 'Monthly, after Patch Tuesday', ...over,
  };
}
const approvals = [
  { userId: 'user_olivia01', name: 'Olivia', role: 'approver', credentialSha256: sha('o'), at: iso(NOW.getTime() - 1800_000) },
  { userId: 'user_quinn001', name: 'Quinn', role: 'approver', credentialSha256: sha('q'), at: iso(NOW.getTime() - 1700_000) },
];
const state = (d, over = {}) => ({ doc: d, digest: P.policyDigest(d), status: 'ACTIVE', approvals, signatureValid: true, revokedAt: null, ledger: [], ...over });
function plan(d, { nb = NOW, hrs = 2 } = {}) {
  const c = d.rings[0][0];
  return {
    schema: 'rem0te-action-plan/1', jobId: hex(16), action: { id: 'windows.update.install', version: 1 },
    artifact: { target: 'windows/rem0te-agent.exe', sha256: sha('agent') },
    params: { updates: [{ updateId: CU.updateId, revision: CU.revision }], reboot: 'never', allow: P.allowParams(d.allow) },
    targets: [{ endpointId: c.endpointId, businessId: BIZ, businessName: 'Acme', hostname: c.hostname, deviceClass: 'WORKSTATION', rustdeskId: c.rustdeskId, deviceSecretSha256: c.deviceSecretSha256 }],
    requestedBy: { ...AUTHOR, via: 'portal' }, origin: { kind: 'technician', ticketRef: null },
    reason: `${d.name} — ring 0`, policy: { risk: 'high', approvalsRequired: 2, customerSignoff: false },
    window: { notBefore: iso(nb), notAfter: iso(nb.getTime() + hrs * 3600_000) },
    display: { updates: [{ ...CU }], deployment: { id: `dep_${hex(6)}`, name: d.name, ring: 0, rings: d.rings.length }, policy: { id: d.policyId, name: d.name, digest: P.policyDigest(d) } },
    createdAt: iso(NOW), approvers: [], signedAt: null,
  };
}
const evaluate = (s, p, now = NOW) => P.evaluatePolicyPlan(s, { plan: p, policyDigest: s.digest, evidence: null }, { now, customerSignoff: false });
const code = (r) => (r.ok ? 'ok' : r.code);

{
  const d = doc();
  check('a monthly policy document parses as a PolicyDoc', P.PolicyDoc.safeParse(d).success, JSON.stringify(P.PolicyDoc.safeParse(d).error?.issues?.slice(0, 2)));
  check('validatePolicyDoc accepts it when its window opens before expiry', P.validatePolicyDoc(d, NOW).ok);
  // Expiry: at most 90 days, and the window must open first.
  const from = new Date('2026-11-15T12:00:00Z');
  const short = doc({ window: PT(), createdAt: iso(from), expiresAt: iso(from.getTime() + 14 * 86_400_000) }, from);
  const r = P.validatePolicyDoc(short, from);
  check('Patch Tuesday, proposed on 15 November with a 14-day expiry, never opens → window_never_opens', !r.ok && r.reason === 'window_never_opens', JSON.stringify(r));
  check('…with a 30-day expiry it opens on 8 December', P.validatePolicyDoc(doc({ window: PT(), createdAt: iso(from), expiresAt: iso(from.getTime() + 30 * 86_400_000) }, from), from).ok);
  const far = doc({ window: DAY({ day: 1 }), createdAt: iso(from), expiresAt: iso(from.getTime() + 90 * 86_400_000) }, from);
  check('a 90-day policy on the 1st holds three openings before it expires', P.validatePolicyDoc(far, from).ok && P.nextOccurrences(from, far.window, 5, new Date(far.expiresAt)).length === 3);
  check('the 90-day ceiling still applies to monthly policies (expiry_too_far)', P.validatePolicyDoc(doc({ expiresAt: iso(NOW.getTime() + 91 * 86_400_000) }), NOW).reason === 'expiry_too_far');

  // The signer: admission, then plans under it.
  const admitted = core.admitPolicy(d, NOW);
  check('the signer admits a monthly policy', admitted.digest === P.policyDigest(d));
  let threw = '';
  try { core.admitPolicy(doc({ window: { ...WIN, kind: 'quarterly' } }), NOW); } catch (e) { threw = e.code ?? e.message; }
  check('the signer refuses an unknown window kind at admission (invalid_policy)', threw === 'invalid_policy', threw);
  threw = '';
  try { core.admitPolicy(doc({ window: DAY({ day: 31 }) }), NOW); } catch (e) { threw = e.code ?? e.message; }
  check('…and a 31st (invalid_policy)', threw === 'invalid_policy', threw);
  threw = '';
  try { core.admitPolicy(doc({ window: PT(), createdAt: iso(from), expiresAt: iso(from.getTime() + 14 * 86_400_000) }, from), from); } catch (e) { threw = e.code ?? e.message; }
  check('…and a monthly policy whose window never opens before expiry (window_never_opens)', threw === 'window_never_opens', threw);

  const s = state(d);
  check('a ring plan inside the monthly window is signed', evaluate(s, plan(d)).ok, JSON.stringify(evaluate(s, plan(d))));
  check('a plan running to the window\'s end is signed', evaluate(s, plan(d, { nb: NOW, hrs: 5.5 })).ok);
  let x = evaluate(s, plan(d, { nb: NOW, hrs: 6 }));
  check('a plan running past the window\'s end → outside_window', code(x) === 'outside_window', code(x));
  x = evaluate(s, plan(d, { nb: new Date(OPEN.getTime() + 7 * 86_400_000) }), NOW);
  check('the same weekday and hour a week later (a weekly window would allow it) → outside_window', code(x) === 'outside_window', code(x));
  x = evaluate(s, plan(d, { nb: new Date('2026-11-11T04:30:00Z') }), new Date('2026-11-11T04:30:00Z'));
  check('Patch Tuesday itself, two days before the window → outside_window', code(x) === 'outside_window', code(x));
  check('the refusal names the monthly window', /2 days after the second Tuesday of each month 22:00–04:00 America\/Chicago/.test(x.message ?? ''), x.message);
  const dec = new Date('2026-12-11T04:30:00Z'); // December: Patch Tuesday 8 Dec + 2 = Thu 10 Dec 22:00 CST = 11 Dec 04:00Z
  check('next month\'s occurrence is signed too', evaluate(s, plan(d, { nb: dec }), dec).ok);
  // A document that slipped past the schema with an unknown shape (it cannot arrive this way, but the evaluator does not rely on that).
  const tampered = { ...d, window: { ...WIN, kind: 'quarterly' } };
  x = evaluate({ ...s, doc: tampered, digest: P.policyDigest(tampered) }, plan(tampered));
  check('an unknown window kind inside a stored policy signs nothing → outside_window (fail closed)', code(x) === 'outside_window', code(x));

  // The approval page the approvers read.
  const html = page.renderPolicyApprovalPage({ policyId: d.policyId, status: 'AWAITING_APPROVAL', digest: s.digest, doc: d, decisions: [], revokedAt: null, revokeReason: null, signedPlans: 0 }, 'n0nce');
  check('the signer\'s approval page says monthly, in words, and lists the next openings',
    /<strong>monthly<\/strong>: 2 days after the second Tuesday of each month 22:00–04:00/.test(html) && /America\/Chicago<\/strong> local time/.test(html) && /Next openings before it expires|never opens/.test(html), html.match(/<th>Window<\/th><td>.*?<\/td>/s)?.[0]);
  const wk = { ...d, window: { days: ['sat'], start: '22:00', end: '04:00', timezone: 'UTC' } };
  const whtml = page.renderPolicyApprovalPage({ policyId: d.policyId, status: 'AWAITING_APPROVAL', digest: s.digest, doc: wk, decisions: [], revokedAt: null, revokeReason: null, signedPlans: 0 }, 'n0nce');
  check('a weekly policy\'s page still names its days and hours', /<th>Window<\/th><td>Sat, 22:00–04:00 <strong>UTC<\/strong> local time/.test(whtml), whtml.match(/<th>Window<\/th><td>.*?<\/td>/s)?.[0]);
}

// ── Weekly documents are unchanged ──────────────────────────────────────────
{
  // A fixed weekly document whose digest was computed by the 0.52 build. Its canonical bytes — and so every
  // signature over it, on the signer and on approval — must never move.
  const golden = {
    schema: 'rem0te-patch-policy/1', policyId: '0123456789abcdef0123456789abcdef', name: 'Golden weekly', businessId: 'biz_golden_01', businessName: 'Golden',
    rings: [[{ endpointId: 'ep_golden_canary', hostname: 'CANARY', rustdeskId: '123456789', deviceSecretSha256: 'a'.repeat(64) }]],
    allow: { classifications: [SEC] }, soakHours: 24, failureThreshold: 0,
    window: { days: ['sat', 'sun'], start: '22:00', end: '04:00', timezone: 'America/Chicago' }, reboot: 'never',
    createdAt: '2026-11-15T00:00:00.000Z', expiresAt: '2026-12-15T00:00:00.000Z', createdBy: { userId: 'user_golden01', name: 'G' }, reason: 'golden weekly',
  };
  const parsed = P.PolicyDoc.parse(golden);
  check('a weekly document parses to exactly its own bytes (no kind is added)', JSON.stringify(parsed) === JSON.stringify(golden) && !('kind' in parsed.window));
  check('…and its digest is the one the 0.52 signer computed', P.policyDigest(parsed) === '466423a5bb889e289b536d62ac25ddf66450179770f1161c576003fc3644f99b', P.policyDigest(parsed));
  const sat = parsed.window;
  check('weekly occurrences are unchanged: Saturday 22:00 Chicago, and Sunday\'s', P.nextOccurrences(new Date('2026-11-11T12:00:00Z'), sat, 2).map((o) => o.start.toISOString()).join() === '2026-11-15T04:00:00.000Z,2026-11-16T04:00:00.000Z');
}

if (failures.length) {
  console.error(`✗ ${failures.length} of ${passed + failures.length} monthly-window checks failed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ ${passed} monthly-window checks passed`);
