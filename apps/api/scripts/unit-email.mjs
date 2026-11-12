#!/usr/bin/env node
// Unit tests for outbound email (0.34), run against dist:
//
//   - the SMTP host rule (email/smtp-host.ts): names, IP literals of every
//     class, IPv4-mapped IPv6, what each SMTP_ALLOW_LOCAL_RELAY setting
//     admits, the resolved-address check (every address, not the first) and
//     plaintext only to loopback;
//   - the report schedule maths (reports/schedule.ts): validation, weekly and
//     monthly occurrences across zones, both DST transitions, and weekly
//     occurrences against the update window's own answer (windowState /
//     isWithinSchedule) so the two can never disagree;
//   - what mail says (email/mail-content.ts): redaction, one-line values,
//     address normalisation.
//
// Build first: pnpm --filter @reboot-remote/api build
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const H = require(join(here, '..', 'dist', 'email', 'smtp-host.js'));
const S = require(join(here, '..', 'dist', 'reports', 'schedule.js'));
const C = require(join(here, '..', 'dist', 'email', 'mail-content.js'));
const W = require(join(here, '..', 'dist', 'client-updates', 'update-window.js'));
const R = require(join(here, '..', 'dist', 'rbac', 'schedule.js'));

let pass = 0, fail = 0;
const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re ? re.test(e.message) : true; } };
const iso = (d) => (d ? new Date(d).toISOString() : null);

// ── SMTP host ───────────────────────────────────────────────────────────────
section('Address classes');
const cls = { '8.8.8.8': 'public', '1.1.1.1': 'public', '127.0.0.1': 'loopback', '127.9.9.9': 'loopback', '::1': 'loopback', '[::1]': 'loopback',
  '10.0.0.5': 'private', '172.16.0.1': 'private', '172.31.255.255': 'private', '172.32.0.1': 'public', '192.168.1.1': 'private', '100.64.0.1': 'private', 'fd00::1': 'private', 'fc12:3456::1': 'private',
  '169.254.169.254': 'blocked', 'fe80::1': 'blocked', 'fe80::1%eth0': 'blocked', '0.0.0.0': 'blocked', '::': 'blocked', '224.0.0.1': 'blocked', '255.255.255.255': 'blocked', 'ff02::1': 'blocked',
  '192.0.2.1': 'blocked', '2001:db8::1': 'blocked', '64:ff9b::808:808': 'blocked',
  '::ffff:127.0.0.1': 'loopback', '::ffff:7f00:1': 'loopback', '::ffff:169.254.169.254': 'blocked', '::ffff:10.1.2.3': 'private', '::ffff:8.8.8.8': 'public',
  '2606:4700:4700::1111': 'public', 'not-an-ip': 'blocked', '999.1.1.1': 'blocked' };
for (const [ip, want] of Object.entries(cls)) check(H.classifyAddress(ip) === want, `${ip} is ${want}`, `got ${H.classifyAddress(ip)}`);

section('Host names on save (SMTP_ALLOW_LOCAL_RELAY unset)');
const ok = (h, allow = 'none') => H.checkSmtpHostName(h, allow).ok;
check(ok('smtp.example.com') && H.checkSmtpHostName(' SMTP.Example.COM. ').host === 'smtp.example.com', 'a public DNS name is accepted and normalised');
for (const h of ['localhost', 'mail.localhost', '127.0.0.1', '[::1]', '10.0.0.5', '192.168.1.10', 'mailhost', 'mail.corp', 'exchange.local', 'relay.internal', 'mail.lan', '169.254.169.254', '0.0.0.0', '8.8.8.8', 'exa mple.com', 'a..b.com', '-bad.example.com', '', 'x'.repeat(260)]) {
  check(!ok(h), `refused: ${JSON.stringify(h.length > 40 ? h.slice(0, 20) + '…' : h)}`);
}
check(/DNS name, not an IP/.test(H.checkSmtpHostName('8.8.8.8').reason), 'a public IP literal is refused with the reason (the certificate is checked against the name)');
check(/SMTP_ALLOW_LOCAL_RELAY=loopback/.test(H.checkSmtpHostName('127.0.0.1').reason), 'a loopback refusal names the switch that allows it');

section('SMTP_ALLOW_LOCAL_RELAY=loopback and =private');
check(H.localRelayAllowance('loopback') === 'loopback' && H.localRelayAllowance('PRIVATE') === 'private' && H.localRelayAllowance('yes') === 'none' && H.localRelayAllowance(undefined) === 'none', 'only the two exact values switch anything on');
check(ok('127.0.0.1', 'loopback') && ok('localhost', 'loopback') && ok('::1', 'loopback'), 'loopback admits localhost, 127.0.0.1 and ::1');
check(!ok('10.0.0.5', 'loopback') && !ok('mailhost', 'loopback') && !ok('exchange.local', 'loopback'), 'loopback does not admit a private address or an internal name');
check(ok('10.0.0.5', 'private') && ok('exchange.local', 'private') && ok('mailhost', 'private') && ok('127.0.0.1', 'private'), 'private admits RFC 1918, internal names and loopback');
check(!ok('169.254.169.254', 'private') && !ok('fe80::1', 'private') && !ok('0.0.0.0', 'private') && !ok('8.8.8.8', 'private'), 'nothing admits link-local (metadata), unspecified, or a public IP literal');

section('Resolved addresses (on send)');
check(H.checkResolved(['93.184.216.34'], 'none').ok, 'a public answer is used');
check(!H.checkResolved(['93.184.216.34', '127.0.0.1'], 'none').ok, 'one internal address in the answer refuses the whole name (not just the first)');
check(!H.checkResolved(['127.0.0.1'], 'none').ok, 'a public name that now resolves to loopback (rebinding) is refused');
check(!H.checkResolved(['169.254.169.254'], 'private').ok, 'a name resolving to the metadata address is refused even with private allowed');
check(!H.checkResolved(['::ffff:127.0.0.1'], 'none').ok, 'an IPv4-mapped loopback answer is refused');
check(!H.checkResolved([], 'none').ok, 'no answer is refused');
const lo = H.checkResolved(['127.0.0.1'], 'loopback');
check(lo.ok && lo.address === '127.0.0.1' && lo.loopback === true, 'the address returned is the one that was checked, and is marked loopback');
check(H.checkResolved(['10.1.1.1'], 'private').loopback === false, 'a private address is not loopback');

section('Plaintext only to loopback');
check(H.tlsModeAllowed('none', true) && !H.tlsModeAllowed('none', false), 'tlsMode none: loopback only');
check(H.tlsModeAllowed('implicit', false) && H.tlsModeAllowed('starttls', false), 'implicit TLS and STARTTLS anywhere allowed');

// ── Schedule maths ──────────────────────────────────────────────────────────
section('Schedule validation');
const spec = (o) => S.parseScheduleSpec({ frequency: 'weekly', dayOfWeek: 1, time: '08:00', timeZone: 'UTC', ...o });
check(!!spec({}), 'a weekly schedule is accepted');
check(!!spec({ frequency: 'monthly', dayOfWeek: undefined, dayOfMonth: 28 }), 'monthly on the 28th is accepted');
check(throws(() => spec({ frequency: 'monthly', dayOfWeek: undefined, dayOfMonth: 29 }), /1 to 28/), 'monthly on the 29th is refused (not every month has it)');
check(throws(() => spec({ frequency: 'monthly', dayOfWeek: undefined, dayOfMonth: 0 })), 'day 0 is refused');
check(throws(() => spec({ dayOfWeek: 7 })) && throws(() => spec({ dayOfWeek: 1.5 })), 'dayOfWeek outside 0–6 is refused');
check(throws(() => spec({ time: '24:00' })) && throws(() => spec({ time: '8:00' })) && throws(() => spec({ time: '08:60' })), 'a time that is not HH:MM is refused');
check(throws(() => spec({ timeZone: 'Mars/Olympus' }), /IANA/), 'an unknown time zone is refused');
check(throws(() => spec({ frequency: 'daily' })), 'only weekly and monthly');
check(throws(() => spec({ dayOfMonth: 3 })), 'a weekly schedule naming a day of the month is refused');

section('Weekly and monthly occurrences');
{
  const s = spec({ dayOfWeek: 1, time: '08:00', timeZone: 'UTC' }); // Monday
  const now = new Date('2026-11-11T12:00:00Z'); // a Wednesday
  check(iso(S.previousOccurrence(s, now).at) === '2026-11-09T08:00:00.000Z' && S.previousOccurrence(s, now).periodKey === 'W:2026-11-09', 'previous Monday 08:00 UTC, keyed by its date');
  check(iso(S.nextOccurrence(s, now).at) === '2026-11-16T08:00:00.000Z', 'next Monday 08:00 UTC');
  const exact = new Date('2026-11-16T08:00:00Z');
  check(iso(S.previousOccurrence(s, exact).at) === iso(exact) && iso(S.nextOccurrence(s, exact).at) === '2026-11-23T08:00:00.000Z', 'at the exact minute: that is the previous one, the next is a week on');
  const ny = spec({ dayOfWeek: 5, time: '17:30', timeZone: 'America/New_York' });
  check(iso(S.nextOccurrence(ny, now).at) === '2026-11-13T22:30:00.000Z', 'Friday 17:30 New York (EST) is 22:30 UTC');
  const ist = spec({ dayOfWeek: 0, time: '06:15', timeZone: 'Asia/Kolkata' });
  check(iso(S.nextOccurrence(ist, now).at) === '2026-11-15T00:45:00.000Z', 'Sunday 06:15 Kolkata (+5:30) is 00:45 UTC');
  const late = spec({ dayOfWeek: 1, time: '01:00', timeZone: 'Pacific/Auckland' });
  check(iso(S.nextOccurrence(late, now).at) === '2026-11-15T12:00:00.000Z' && S.nextOccurrence(late, now).periodKey === 'W:2026-11-16', 'Monday 01:00 Auckland (+13) is Sunday 12:00 UTC, keyed by the local date');
  const m = spec({ frequency: 'monthly', dayOfWeek: undefined, dayOfMonth: 1, time: '07:00', timeZone: 'Europe/London' });
  check(iso(S.previousOccurrence(m, now).at) === '2026-11-01T07:00:00.000Z' && S.previousOccurrence(m, now).periodKey === 'M:2026-11', 'monthly on the 1st 07:00 London (GMT in November), keyed by month');
  check(iso(S.nextOccurrence(m, now).at) === '2026-12-01T07:00:00.000Z', 'and the next is 1 December');
  const jul = new Date('2026-07-15T00:00:00Z');
  check(iso(S.previousOccurrence(m, jul).at) === '2026-07-01T06:00:00.000Z', 'in July it is 06:00 UTC (BST)');
  const jan = spec({ frequency: 'monthly', dayOfWeek: undefined, dayOfMonth: 15, time: '09:00', timeZone: 'UTC' });
  check(iso(S.nextOccurrence(jan, new Date('2026-12-20T00:00:00Z')).at) === '2027-01-15T09:00:00.000Z', 'monthly rolls over the year');
  check(iso(S.previousOccurrence(jan, new Date('2027-01-10T00:00:00Z')).at) === '2026-12-15T09:00:00.000Z', 'and back over it');
  check(S.periodDaysFor('weekly') === 7 && S.periodDaysFor('monthly') === 30, 'a weekly schedule reports on 7 days, a monthly one on 30');
  check(S.CATCH_UP_MS === 86_400_000, 'a missed delivery is still sent up to a day late, no later');
}

section('Daylight saving');
{
  // New York, spring forward 2027-03-14: 02:00 → 03:00 EDT. 02:30 does not exist.
  const gap = spec({ dayOfWeek: 0, time: '02:30', timeZone: 'America/New_York' });
  const o = S.nextOccurrence(gap, new Date('2027-03-13T12:00:00Z'));
  check(iso(o.at) === '2027-03-14T07:00:00.000Z' && o.periodKey === 'W:2027-03-14', 'spring forward: 02:30 that night is due at the jump (03:00 EDT = 07:00 UTC)');
  // New York, fall back 2026-11-01: 02:00 EDT → 01:00 EST. 01:30 happens twice.
  const dup = spec({ dayOfWeek: 0, time: '01:30', timeZone: 'America/New_York' });
  const f = S.nextOccurrence(dup, new Date('2026-10-31T12:00:00Z'));
  check(iso(f.at) === '2026-11-01T05:30:00.000Z', 'fall back: 01:30 is due the first time (EDT, 05:30 UTC)');
  const after = S.nextOccurrence(dup, f.at);
  check(iso(after.at) === '2026-11-08T06:30:00.000Z', 'and not again an hour later: the next is a week on (EST, 06:30 UTC)');
  check(S.previousOccurrence(dup, new Date('2026-11-01T06:45:00Z')).periodKey === 'W:2026-11-01', 'during the second 01:xx hour the period is still that Sunday (same key: no second delivery)');
  // Lord Howe: a 30-minute DST shift.
  const lh = spec({ dayOfWeek: 0, time: '02:15', timeZone: 'Australia/Lord_Howe' });
  const l = S.nextOccurrence(lh, new Date('2026-10-03T00:00:00Z'));
  check(R.localClock(l.at, 'Australia/Lord_Howe').minutes === 150 || R.localClock(l.at, 'Australia/Lord_Howe').minutes === 135, 'Lord Howe (30-minute shift): a time in the half-hour gap lands at the jump', `got ${iso(l.at)}`);
  // London, monthly on a DST day: last Sunday of March 2027 is the 28th.
  const lon = spec({ frequency: 'monthly', dayOfWeek: undefined, dayOfMonth: 28, time: '01:30', timeZone: 'Europe/London' });
  check(iso(S.nextOccurrence(lon, new Date('2027-03-20T00:00:00Z')).at) === '2027-03-28T01:00:00.000Z', 'London 28 March 2027 01:30 does not exist: due at the jump, 02:00 BST = 01:00 UTC');
}

section('Weekly occurrences agree with the update window (random, DST-heavy zones)');
{
  const zones = ['America/New_York', 'Europe/London', 'Australia/Sydney', 'Australia/Lord_Howe', 'Asia/Kathmandu', 'America/Santiago', 'Pacific/Chatham', 'UTC', 'America/St_Johns'];
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  let agree = 0, total = 0;
  const bad = [];
  for (let i = 0; i < 400; i++) {
    const tz = zones[rnd(zones.length)];
    const dow = rnd(7), h = rnd(24), mi = rnd(4) * 15;
    const time = `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
    const end = (h * 60 + mi + 120) % 1440;
    const w = W.parseUpdateWindow(tz, [{ days: [dow], start: time, end: `${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}` }]);
    // Start from a moment the window is closed, so "next opens" is the next occurrence.
    let from = new Date(Date.UTC(2026, rnd(12), 1 + rnd(28), rnd(24), rnd(60)));
    while (R.isWithinSchedule(w, from)) from = new Date(from.getTime() + 3 * 3_600_000);
    const want = W.windowState(w, from).opensAt;
    const got = S.nextOccurrence(spec({ dayOfWeek: dow, time, timeZone: tz }), from).at;
    total++;
    if (want && iso(want) === iso(got)) agree++; else if (bad.length < 3) bad.push(`${tz} ${dow} ${time} from ${iso(from)}: window ${iso(want)}, schedule ${iso(got)}`);
  }
  check(agree === total, `${agree}/${total} weekly occurrences equal the update window's next opening`, bad.join('; '));
}

section('previous ≤ now < next, everywhere');
{
  let okc = 0, n = 0;
  for (const tz of ['America/New_York', 'Europe/Berlin', 'Australia/Adelaide', 'Asia/Tokyo']) {
    for (let k = 0; k < 60; k++) {
      const now = new Date(Date.UTC(2026, 0, 1) + k * 6.1 * 86_400_000);
      for (const sp of [spec({ dayOfWeek: k % 7, time: '03:00', timeZone: tz }), spec({ frequency: 'monthly', dayOfWeek: undefined, dayOfMonth: 1 + (k % 28), time: '23:45', timeZone: tz })]) {
        const p = S.previousOccurrence(sp, now), x = S.nextOccurrence(sp, now);
        n++;
        if (p.at <= now && x.at > now && p.periodKey !== x.periodKey && iso(S.nextOccurrence(sp, p.at).at) === iso(x.at)) okc++;
      }
    }
  }
  check(okc === n, `${okc}/${n}: the previous occurrence is at or before now, the next after it, with different period keys`);
}

// ── Mail content ────────────────────────────────────────────────────────────
section('Alert mail: minimal and redacted');
{
  const a = { id: 'alert123456', title: 'Disk C: below 10% on PC-1', severity: 'CRITICAL', kind: 'DISK_FREE', state: 'OPEN', firstSeenAt: new Date('2026-11-11T10:00:00Z'), computer: 'PC-1', site: 'HQ', business: 'Acme' };
  const m = C.alertMail(a, 'alert.notify', 'https://rmm.example.com/alerts?alert=alert123456');
  check(m.subject === '[rem0te] CRITICAL: Disk C: below 10% on PC-1', 'the subject is severity and title', m.subject);
  check(/Computer:\s+PC-1/.test(m.text) && /Business:\s+Acme/.test(m.text) && /alerts\?alert=alert123456/.test(m.text), 'the body has the computer, the business and the link');
  check(!/HQ/.test(m.text), 'a computer alert does not name the site');
  const cp = (...c) => String.fromCodePoint(...c);
  const evil = { ...a, title: 'x\r\nBcc: victim@example.com\r\n\r\nclick http://evil', computer: `PC${cp(0, 0x202e)}exe.${cp(0x2028)}Subject: hi`, business: 'B\nusiness' };
  const e = C.alertMail(evil, 'alert.notify', 'https://rmm.example.com/alerts?alert=x');
  check(!/[\r\n]/.test(e.subject), 'a title with line breaks cannot add a header');
  check(e.text.split('\n').filter((l) => /^Bcc:|^Subject:/.test(l)).length === 0, 'nor a line of its own in the body');
  const bad = new RegExp(`[${cp(0)}-${cp(0x1f)}${cp(0x202e)}${cp(0x2028)}]`, 'u');
  check(!bad.test(e.text.replace(/\n/g, '')), 'control, bidi-override and line-separator characters are removed');
  const o = C.alertMail({ ...a, kind: 'SITE_OUTAGE', computer: null }, 'alert.resolved', 'https://x.example.com/a');
  check(/^\[rem0te\] Resolved:/.test(o.subject) && /Site:\s+HQ/.test(o.text) && !/Computer:/.test(o.text), 'a resolved site outage names the site');
  check(C.oneLine('a'.repeat(400)).length === 150, 'long values are capped');
}

section('Report and confirmation mail');
{
  const r = C.reportMail({ report: 'patch-compliance', business: 'Acme', site: null, days: null, schedule: 'Every Monday at 08:00 (UTC)', generatedAt: new Date(), rows: 12, attached: true }, 'https://x.example.com/reports/patch-compliance?businessId=b1');
  check(/Patch compliance report — Acme/.test(r.subject) && /attached as CSV \(12 rows\)/.test(r.text), 'a report mail names the report, the business and the attachment');
  const n = C.reportMail({ report: 'offline-time', business: null, site: null, days: 7, schedule: 's', generatedAt: new Date(), rows: null, attached: false }, 'https://x.example.com/r');
  check(/All businesses/.test(n.subject) && /no file is attached/.test(n.text) && /last 7 days/.test(n.text), 'without a CSV it says so; the period is named');
  const f = C.reportFailedMail({ report: 'agent-coverage', business: 'Acme', schedule: 's' }, 'The person who set up this schedule no longer has access to this report.');
  check(/could not be sent/.test(f.subject) && /Nothing from the report/.test(f.text), 'a failure notice says why and carries nothing of the report');
  const v = C.verificationMail('Acme', 'https://x.example.com/verify-email?token=abc');
  check(/confirm/i.test(v.text) && /ignore this message/.test(v.text), 'the confirmation mail asks, and says ignoring it sends nothing');
}

section('Addresses');
check(C.normaliseAddress(' NOC@Example.COM ') === 'noc@example.com', 'an address is trimmed and lower-cased (one address, one recipient)');
for (const x of ['a@b', 'no-at.example.com', 'a b@example.com', 'a@example.com\r\nBcc: x@y.com', '"Name" <a@example.com>', 'a@-bad.com', 'x@example..com', `${'a'.repeat(65)}@example.com`]) {
  check(C.normaliseAddress(x) === null, `refused address: ${JSON.stringify(x.slice(0, 40))}`);
}
check(C.maskAddress('jane.doe@example.com') === 'j…@example.com', 'masked for logs: first letter and domain');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
