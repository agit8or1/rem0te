#!/usr/bin/env node
// Unit tests for scheduled client updates (0.32), run against dist:
//
//   - the update window: validation, time zones (including +5:30, +5:45 and a
//     30-minute DST zone), windows that cross midnight, and both DST
//     transitions — spring forward (an hour that does not exist) and fall
//     back (an hour that happens twice);
//   - windowState's "closes at" / "next opens" against a brute-force
//     reference that asks isWithinSchedule about every single minute, across
//     random windows in DST-heavy zones;
//   - the policy decisions the sweep, the heartbeat and the page share:
//     which policy governs a computer, when a POLICY request is held, and why
//     a computer will not be queued.
//
// Build first: pnpm --filter @reboot-remote/api build
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const W = require(join(here, '..', 'dist', 'client-updates', 'update-window.js'));
const P = require(join(here, '..', 'dist', 'client-updates', 'policy.js'));
const S = require(join(here, '..', 'dist', 'rbac', 'schedule.js'));

let pass = 0, fail = 0;
const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re ? re.test(e.message) : true; } };
const iso = (d) => (d ? d.toISOString() : null);
const at = (s) => new Date(s);
const ALL = [0, 1, 2, 3, 4, 5, 6];
const win = (timeZone, windows) => W.parseUpdateWindow(timeZone, windows);

section('Validation');
check(!!win('Europe/London', [{ days: [1, 2, 3, 4, 5], start: '22:00', end: '05:00' }]), 'a weekday overnight window in a real zone is accepted');
check(throws(() => win('Mars/Olympus', [{ days: [1], start: '22:00', end: '05:00' }]), /IANA/), 'an unknown time zone is refused');
check(throws(() => win('', [{ days: [1], start: '22:00', end: '05:00' }]), /IANA/), 'an empty time zone is refused');
check(throws(() => win('UTC', []), /between 1 and 14/), 'no windows is refused');
check(throws(() => win('UTC', Array.from({ length: 8 }, () => ({ days: [1], start: '01:00', end: '03:00' }))), /At most 7/), 'more than seven windows is refused');
check(throws(() => win('UTC', [{ days: [7], start: '22:00', end: '05:00' }]), /days/), 'day 7 is refused (0 = Sunday … 6 = Saturday)');
check(throws(() => win('UTC', [{ days: [], start: '22:00', end: '05:00' }]), /days/), 'a window with no days is refused');
check(throws(() => win('UTC', [{ days: [1], start: '24:00', end: '05:00' }]), /HH:MM/), '24:00 is not a time');
check(throws(() => win('UTC', [{ days: [1], start: '9:00', end: '10:00' }]), /HH:MM/), 'H:MM without the leading zero is refused');
check(throws(() => win('UTC', [{ days: [1], start: '22:00', end: '22:00' }]), /same/), 'start equal to end is refused');
check(throws(() => win('UTC', [{ days: [1], start: '22:00', end: '22:29' }]), /shorter than 30/), 'a 29-minute window is refused');
check(!!win('UTC', [{ days: [1], start: '22:00', end: '22:30' }]), 'a 30-minute window is accepted');
check(W.windowLengthMinutes({ start: '23:50', end: '00:30' }) === 40, 'a window across midnight measures its real length (23:50–00:30 is 40 minutes)');
check(throws(() => win('UTC', [{ days: [1], start: '23:50', end: '00:10' }]), /shorter than 30/), 'a 20-minute window across midnight is refused');
check(JSON.stringify(win('UTC', [{ days: [5, 1, 1], start: '01:00', end: '03:00' }]).windows[0].days) === '[1,5]', 'days are de-duplicated and sorted');
check(W.storedWindow('UTC', 'not-an-array') === null && W.isWindowOpen(null, new Date()) === false, 'a malformed stored window is never open (fails closed)');

section('Open or closed, crossing midnight (UTC)');
{
  const w = win('UTC', [{ days: [1], start: '22:00', end: '05:00' }]); // Monday night only
  // 2026-11-09 is a Monday.
  check(!W.isWindowOpen(w, at('2026-11-09T21:59:00Z')), 'Mon 21:59 — not yet');
  check(W.isWindowOpen(w, at('2026-11-09T22:00:00Z')), 'Mon 22:00 — opens on the minute');
  check(W.isWindowOpen(w, at('2026-11-10T04:59:00Z')), 'Tue 04:59 — the early part belongs to Monday');
  check(!W.isWindowOpen(w, at('2026-11-10T05:00:00Z')), 'Tue 05:00 — closed (end is exclusive)');
  check(!W.isWindowOpen(w, at('2026-11-09T02:00:00Z')), 'Mon 02:00 — closed: that early part would belong to Sunday, which is not listed');
  check(!W.isWindowOpen(w, at('2026-11-10T22:30:00Z')), 'Tue 22:30 — closed: Tuesday is not listed');
}

section('Time zones');
{
  const ny = win('America/New_York', [{ days: ALL, start: '22:00', end: '05:00' }]);
  check(W.isWindowOpen(ny, at('2026-01-15T03:30:00Z')), 'New York in winter (EST, −5): 03:30Z is 22:30 local — open');
  check(!W.isWindowOpen(ny, at('2026-01-15T02:30:00Z')), 'New York in winter: 02:30Z is 21:30 local — closed');
  check(W.isWindowOpen(ny, at('2026-07-15T02:30:00Z')), 'New York in summer (EDT, −4): 02:30Z is 22:30 local — open');
  check(!W.isWindowOpen(ny, at('2026-07-15T09:30:00Z')), 'New York in summer: 09:30Z is 05:30 local — closed');
  const kol = win('Asia/Kolkata', [{ days: [1], start: '22:00', end: '23:00' }]);
  check(W.isWindowOpen(kol, at('2026-11-09T16:30:00Z')) && !W.isWindowOpen(kol, at('2026-11-09T16:29:00Z')), 'Kolkata (+5:30): Monday 22:00 local is 16:30Z to the minute');
  const ktm = win('Asia/Kathmandu', [{ days: [1], start: '22:00', end: '23:00' }]);
  check(W.isWindowOpen(ktm, at('2026-11-09T16:15:00Z')) && !W.isWindowOpen(ktm, at('2026-11-09T16:14:00Z')), 'Kathmandu (+5:45): Monday 22:00 local is 16:15Z to the minute');
  check(W.utcOffsetMinutes(Date.parse('2026-11-09T12:00:00Z'), 'Asia/Kathmandu') === 345, 'utcOffsetMinutes: Kathmandu is +345');
  check(W.utcOffsetMinutes(Date.parse('2026-01-15T12:00:00Z'), 'America/New_York') === -300 && W.utcOffsetMinutes(Date.parse('2026-07-15T12:00:00Z'), 'America/New_York') === -240, 'utcOffsetMinutes: New York −300 in winter, −240 in summer');
  const tok = win('Asia/Tokyo', [{ days: [2], start: '01:00', end: '03:00' }]);
  check(W.isWindowOpen(tok, at('2026-11-09T16:30:00Z')), 'Tokyo (+9): Monday 16:30Z is already Tuesday 01:30 local — the weekday is the local one');
}

section('Next opening and closing (windowState)');
{
  const w = win('UTC', [{ days: [1, 2, 3, 4, 5], start: '22:00', end: '05:00' }]);
  let s = W.windowState(w, at('2026-11-09T12:00:00Z')); // Monday noon
  check(!s.open && iso(s.opensAt) === '2026-11-09T22:00:00.000Z' && iso(s.closesAt) === '2026-11-10T05:00:00.000Z', 'Monday noon: closed; opens Mon 22:00, that window closes Tue 05:00', JSON.stringify(s));
  s = W.windowState(w, at('2026-11-09T23:00:00Z'));
  check(s.open && iso(s.closesAt) === '2026-11-10T05:00:00.000Z' && iso(s.opensAt) === '2026-11-10T22:00:00.000Z', 'Monday 23:00: open; closes Tue 05:00, next opens Tue 22:00', JSON.stringify(s));
  s = W.windowState(w, at('2026-11-13T23:00:00Z')); // Friday night
  check(s.open && iso(s.closesAt) === '2026-11-14T05:00:00.000Z' && iso(s.opensAt) === '2026-11-16T22:00:00.000Z', 'Friday 23:00: closes Sat 05:00, next opens Monday 22:00 (the weekend is skipped)', JSON.stringify(s));
  s = W.windowState(w, at('2026-11-09T21:59:30Z'));
  check(!s.open && iso(s.opensAt) === '2026-11-09T22:00:00.000Z', 'thirty seconds before opening: opensAt is the coming minute, not the one after');
  const always = win('UTC', [{ days: ALL, start: '00:00', end: '23:59' }, { days: ALL, start: '23:30', end: '00:30' }]);
  s = W.windowState(always, at('2026-11-09T12:00:00Z'));
  check(s.open && s.closesAt === null && s.opensAt === null, 'a schedule that covers every minute never closes (null, not a made-up time)', JSON.stringify(s));
  check(JSON.stringify(W.windowState(null, new Date())) === JSON.stringify({ open: false, closesAt: null, opensAt: null }), 'no window: closed, and no opening is invented');
}

section('Daylight saving: spring forward (an hour that does not exist)');
{
  // America/New_York, 2026-03-08: 02:00 EST jumps to 03:00 EDT (07:00Z).
  const w = win('America/New_York', [{ days: ALL, start: '02:30', end: '05:00' }]);
  const s = W.windowState(w, at('2026-03-08T05:00:00Z')); // 00:00 EST
  check(iso(s.opensAt) === '2026-03-08T07:00:00.000Z', 'a 02:30 window opens when the clock jumps to 03:00 EDT (07:00Z) — 02:30 does not exist that night', JSON.stringify(s));
  check(iso(s.closesAt) === '2026-03-08T09:00:00.000Z', 'and closes at 05:00 EDT (09:00Z): 2 hours that night, not 2.5', JSON.stringify(s));
  check(!W.isWindowOpen(w, at('2026-03-08T06:59:00Z')), '06:59Z is 01:59 EST — still closed');
  const gone = win('America/New_York', [{ days: ALL, start: '02:00', end: '02:45' }]);
  const g = W.windowState(gone, at('2026-03-08T05:00:00Z'));
  check(iso(g.opensAt) === '2026-03-09T06:00:00.000Z', 'a 02:00–02:45 window never opens on the spring-forward night; the next is Mar 9 02:00 EDT (06:00Z)', JSON.stringify(g));
  // Europe/London, 2026-03-29: 01:00 GMT jumps to 02:00 BST (01:00Z).
  const lon = win('Europe/London', [{ days: ALL, start: '00:30', end: '01:30' }]);
  const l = W.windowState(lon, at('2026-03-29T00:00:00Z'));
  check(iso(l.opensAt) === '2026-03-29T00:30:00.000Z' && iso(l.closesAt) === '2026-03-29T01:00:00.000Z', 'London: 00:30–01:30 that night lasts 30 minutes — 01:00–01:59 local never happens', JSON.stringify(l));
  // Australia/Lord_Howe moves by 30 minutes: 2026-10-04 02:00 (+10:30) → 02:30 (+11), i.e. 15:30Z on Oct 3.
  const lh = win('Australia/Lord_Howe', [{ days: ALL, start: '02:00', end: '04:00' }]);
  const h = W.windowState(lh, at('2026-10-03T14:00:00Z'));
  check(iso(h.opensAt) === '2026-10-03T15:30:00.000Z' && iso(h.closesAt) === '2026-10-03T17:00:00.000Z', 'Lord Howe (a 30-minute shift): opens at 02:30 local (15:30Z), closes at 04:00 (17:00Z)', JSON.stringify(h));
}

section('Daylight saving: fall back (an hour that happens twice)');
{
  // America/New_York, 2026-11-01: 02:00 EDT falls back to 01:00 EST (06:00Z).
  const w = win('America/New_York', [{ days: ALL, start: '01:00', end: '02:00' }]);
  const s = W.windowState(w, at('2026-11-01T04:00:00Z')); // 00:00 EDT
  check(iso(s.opensAt) === '2026-11-01T05:00:00.000Z' && iso(s.closesAt) === '2026-11-01T07:00:00.000Z', '01:00–02:00 covers both real hours that read 01:xx — open 05:00Z to 07:00Z', JSON.stringify(s));
  check(W.isWindowOpen(w, at('2026-11-01T06:30:00Z')), '06:30Z is the second 01:30 (EST) — still open');
  const night = win('America/New_York', [{ days: [6], start: '22:00', end: '05:00' }]); // Saturday night, Oct 31 → Nov 1
  const n = W.windowState(night, at('2026-10-31T20:00:00Z'));
  check(iso(n.opensAt) === '2026-11-01T02:00:00.000Z' && iso(n.closesAt) === '2026-11-01T10:00:00.000Z', 'Saturday 22:00 EDT → Sunday 05:00 EST across the change: 8 real hours (02:00Z–10:00Z)', JSON.stringify(n));
  const lon = win('Europe/London', [{ days: ALL, start: '01:00', end: '01:30' }]);
  // London falls back at 02:00 BST = 01:00Z, so 01:00 local happens at 00:00Z and again at 01:00Z.
  const l1 = W.windowState(lon, at('2026-10-24T23:30:00Z'));
  check(iso(l1.opensAt) === '2026-10-25T00:00:00.000Z' && iso(l1.closesAt) === '2026-10-25T00:30:00.000Z', 'London 01:00–01:30: first opens at 01:00 BST (00:00Z), closes 00:30Z', JSON.stringify(l1));
  const l2 = W.windowState(lon, at('2026-10-25T00:45:00Z'));
  check(!l2.open && iso(l2.opensAt) === '2026-10-25T01:00:00.000Z' && iso(l2.closesAt) === '2026-10-25T01:30:00.000Z', 'and opens again at 01:00 GMT (01:00Z) — the hour repeats, so does the window', JSON.stringify(l2));
  check(W.isWindowOpen(lon, at('2026-10-25T00:15:00Z')) && W.isWindowOpen(lon, at('2026-10-25T01:15:00Z')) && !W.isWindowOpen(lon, at('2026-10-25T00:45:00Z')), 'London 01:00–01:30 matches 01:15 BST (00:15Z) and 01:15 GMT (01:15Z), not 01:45 BST');
}

section('windowState against a minute-by-minute reference');
{
  // The reference asks isWithinSchedule about every minute: slow, obviously
  // right, and it shares nothing with windowState's offset sampling.
  const ref = (w, now) => {
    const open = S.isWithinSchedule(w, now);
    let t = Math.floor(now.getTime() / 60000) * 60000 + 60000;
    const end = t + W.HORIZON_DAYS * 86400000;
    const find = (cur, from) => { for (let m = from; m < end; m += 60000) if (S.isWithinSchedule(w, new Date(m)) !== cur) return m; return null; };
    const a = find(open, t);
    if (a === null) return { open, closesAt: null, opensAt: null };
    const b = find(!open, a + 60000);
    return open ? { open, closesAt: a, opensAt: b } : { open, opensAt: a, closesAt: b };
  };
  // Deterministic pseudo-random, so a failure reproduces.
  let seed = 20261111;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const cases = [
    ['America/New_York', '2026-03-07T12:00:00Z'], ['America/New_York', '2026-10-31T12:00:00Z'],
    ['Europe/London', '2026-03-28T12:00:00Z'], ['Europe/London', '2026-10-24T12:00:00Z'],
    ['Australia/Lord_Howe', '2026-10-02T12:00:00Z'], ['Australia/Lord_Howe', '2026-04-04T12:00:00Z'],
    ['Pacific/Chatham', '2026-09-26T12:00:00Z'], ['America/Santiago', '2026-09-05T12:00:00Z'],
    ['Asia/Kathmandu', '2026-11-09T12:00:00Z'], ['UTC', '2026-11-09T12:00:00Z'],
  ];
  let agree = 0, total = 0;
  const bad = [];
  for (const [tz, base] of cases) {
    for (let k = 0; k < 4; k++) {
      const start = rnd(1440);
      const len = 30 + rnd(600);
      const days = ALL.filter(() => rnd(3) > 0);
      const w = win(tz, [{ days: days.length ? days : [rnd(7)], start: hhmm(start), end: hhmm((start + len) % 1440) }]);
      const now = new Date(Date.parse(base) + rnd(72) * 3600000 + rnd(60) * 60000 + rnd(60) * 1000);
      const got = W.windowState(w, now);
      const want = ref(w, now);
      total++;
      const same = got.open === want.open && (got.opensAt?.getTime() ?? null) === want.opensAt && (got.closesAt?.getTime() ?? null) === want.closesAt;
      if (same) agree++; else bad.push(`${tz} ${JSON.stringify(w.windows)} now=${now.toISOString()} got=${JSON.stringify(got)} want=${JSON.stringify({ ...want, opensAt: want.opensAt && new Date(want.opensAt), closesAt: want.closesAt && new Date(want.closesAt) })}`);
    }
  }
  check(agree === total, `windowState matches the reference in all ${total} random windows across DST transitions in 9 zones`, bad.slice(0, 3).join('\n      '));
}

section('Which policy governs a computer');
{
  const pol = (id, customerId, siteId, enabled) => ({ id, customerId, siteId, enabled, timeZone: 'UTC', windows: [{ days: ALL, start: '00:00', end: '23:00' }], skipActiveSession: true, skipLoggedOnUser: false });
  const list = [pol('bA', 'A', null, true), pol('sA1', 'A', 'site1', false), pol('bB', 'B', null, true), pol('sB2', 'B', 'site2', true)];
  check(P.effectivePolicy(list, 'A', null)?.id === 'bA', 'a computer with no site follows its business policy');
  check(P.effectivePolicy(list, 'A', 'site9')?.id === 'bA', 'a site without an override follows the business policy');
  check(P.effectivePolicy(list, 'A', 'site1')?.id === 'sA1' && P.effectivePolicy(list, 'A', 'site1').enabled === false, 'a site override replaces the business policy — including being off when the business is on');
  check(P.effectivePolicy(list, 'A', 'site2')?.id === 'bA', "another business's site override never applies (business A, site2 belongs to B)");
  check(P.effectivePolicy(list, null, null) === null, 'a computer in no business has no policy');
  check(P.effectivePolicy(list.filter((p) => p.customerId === 'B'), 'A', null) === null, "business B's policy never governs business A's computers");
}

section('When a POLICY request is held at the heartbeat');
{
  const base = { id: 'p', customerId: 'A', siteId: null, enabled: true, timeZone: 'UTC', windows: [{ days: ALL, start: '22:00', end: '05:00' }], skipActiveSession: true, skipLoggedOnUser: false };
  const inside = at('2026-11-09T23:00:00Z'), outside = at('2026-11-09T12:00:00Z');
  const quiet = { sessionOpen: false, loggedOnUser: '' };
  check(P.policyHold(base, inside, quiet) === null, 'inside the window, no session, nobody required absent → hand it out');
  check(P.policyHold(base, outside, quiet) === 'outside_window', 'outside the window → held');
  check(P.policyHold({ ...base, enabled: false }, inside, quiet) === 'policy_off', 'policy turned off since it queued → held');
  check(P.policyHold(null, inside, quiet) === 'policy_off', 'no policy any more → held');
  check(P.policyHold({ ...base, windows: 'garbage' }, inside, quiet) === 'outside_window', 'a stored window that no longer parses → held (fails closed)');
  check(P.policyHold(base, inside, { ...quiet, sessionOpen: true }) === 'session_open', 'an open session, with skip-session on (the default) → held');
  check(P.policyHold({ ...base, skipActiveSession: false }, inside, { ...quiet, sessionOpen: true }) === null, 'an open session with skip-session turned off → handed out');
  check(P.policyHold(base, inside, { sessionOpen: false, loggedOnUser: 'ACME\\pat' }) === null, 'a logged-on user does not matter unless the policy says so');
  const strict = { ...base, skipLoggedOnUser: true };
  check(P.policyHold(strict, inside, { sessionOpen: false, loggedOnUser: 'ACME\\pat' }) === 'user_logged_on', 'skip-logged-on-user: a reported user → held');
  check(P.policyHold(strict, inside, { sessionOpen: false, loggedOnUser: '' }) === null, "skip-logged-on-user: '' (the agent's \"nobody\") → handed out");
  check(P.policyHold(strict, inside, { sessionOpen: false, loggedOnUser: undefined }) === 'user_unknown', 'skip-logged-on-user: an agent that does not report a user → held (unknown is not nobody)');
  check(P.policyHold(strict, outside, { sessionOpen: true, loggedOnUser: 'x' }) === 'outside_window', 'the window is checked first');
}

section('Why a computer will not be queued');
{
  const ok = { status: 'ACTIVE', isOnline: true, platform: 'Windows', node: { agentSecretHash: 'h', version: '1.4.0', updateRequestedAt: null }, inRollout: false };
  check(P.blocker(ok, '1.4.5') === null, 'online Windows computer with a secret and an old version → can be queued');
  check(P.blocker({ ...ok, platform: 'Microsoft Windows 11 Pro' }, '1.4.5') === null, 'platform matching is a case-insensitive "windows" substring');
  check(P.blocker({ ...ok, status: 'ARCHIVED' }, '1.4.5') === 'archived', 'archived');
  check(P.blocker({ ...ok, node: null }, '1.4.5') === 'no_rustdesk', 'no RustDesk node');
  check(P.blocker({ ...ok, platform: 'macOS' }, '1.4.5') === 'not_windows' && P.BLOCKER.not_windows.permanent, 'not Windows — permanent');
  check(P.blocker({ ...ok, platform: null }, '1.4.5') === 'not_windows', 'unknown platform is not assumed to be Windows');
  check(P.blocker({ ...ok, node: { ...ok.node, agentSecretHash: null } }, '1.4.5') === 'no_device_secret' && P.BLOCKER.no_device_secret.permanent, 'no device secret — permanent');
  check(P.blocker({ ...ok, node: { ...ok.node, version: null } }, '1.4.5') === 'version_unknown', 'never reported a version (pre-0.8.2) — never queued');
  check(P.blocker({ ...ok, node: { ...ok.node, version: '1.4.5' } }, '1.4.5') === 'up_to_date' && P.blocker({ ...ok, node: { ...ok.node, version: '1.5.0' } }, '1.4.5') === 'up_to_date', 'on or past the target → up to date');
  check(P.blocker({ ...ok, isOnline: false }, '1.4.5') === 'offline' && !P.BLOCKER.offline.permanent, 'offline — temporary');
  check(P.blocker({ ...ok, inRollout: true }, '1.4.5') === 'rollout', 'a staged rollout owns it');
  check(P.blocker({ ...ok, node: { ...ok.node, updateRequestedAt: new Date() } }, '1.4.5') === 'queued', 'already queued');
  check(P.blocker({ ...ok, isOnline: false, platform: 'Linux' }, '1.4.5') === 'not_windows', 'a permanent reason is reported before a temporary one');
}

section('Policy input');
{
  const good = { businessId: 'cmabcdefgh12', enabled: true, timeZone: 'Europe/London', windows: [{ days: [1], start: '22:00', end: '05:00' }] };
  const r = P.PolicyInput.safeParse(good);
  check(r.success && r.data.skipActiveSession === true && r.data.skipLoggedOnUser === false, 'defaults: skip open sessions on, skip logged-on user off');
  check(!P.PolicyInput.safeParse({ ...good, extra: 1 }).success, 'unknown fields are refused (strict)');
  check(!P.PolicyInput.safeParse({ ...good, businessId: '../x' }).success, 'a businessId that is not an id is refused');
  check(!P.PolicyInput.safeParse({ ...good, enabled: 'yes' }).success, 'enabled must be a boolean');
}

console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
