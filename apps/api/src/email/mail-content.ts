/**
 * What outbound mail says (0.34). Pure: unit-tested in scripts/unit-email.mjs.
 *
 * Plain text only. Mail leaves the server for good — it is forwarded, kept in
 * other people's mailboxes and archived — so it carries as little as a
 * notification can and still be useful:
 *
 *   an alert   its title, severity, the computer (or site), the business and
 *              a link. Never the alert's `detail`, an inventory, a hostname,
 *              an address or an id beyond the link's.
 *   a report   which report, for which business and site, the period, and a
 *              link; the CSV only when the schedule asks for it, and then
 *              produced by the same audited export a person downloads.
 *
 * Every value that came from a device or a person (a computer name, a title,
 * a business name) is reduced to one printable line before it is used, so a
 * name cannot add a header, a line that looks like a different link, or a
 * control sequence.
 */

// Built from code points rather than written as escapes, so the source holds no invisible characters.
// eslint-disable-next-line security/detect-non-literal-regexp -- constant input, no user data
const UNPRINTABLE = new RegExp(`[${([[0x00, 0x1f], [0x7f, 0x9f], [0x2028, 0x2029], [0x200b, 0x200f], [0x202a, 0x202e], [0x2066, 0x2069]] as const)
  .map(([a, b]) => `\\u{${a.toString(16)}}-\\u{${b.toString(16)}}`).join('')}]`, 'gu');

/** One printable line: no control characters, no line breaks, collapsed whitespace, capped. */
export function oneLine(v: unknown, max = 150): string {
  const s = String(v ?? '')
    // Control characters, line and paragraph separators, zero-width and bidi-override characters (as code points).
    .replace(UNPRINTABLE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export interface Mail { subject: string; text: string }

export interface AlertForMail {
  id: string;
  title: string;
  severity: string;
  kind: string;
  state: string;
  firstSeenAt: Date;
  resolvedAt?: Date | null;
  computer: string | null;
  site: string | null;
  business: string | null;
}

const FOOTER = 'This message was sent by rem0te. It carries no device details: sign in to see them.';

export function alertMail(a: AlertForMail, type: 'alert.notify' | 'alert.resolved', link: string): Mail {
  const sev = oneLine(a.severity, 16).toUpperCase();
  const title = oneLine(a.title);
  const resolved = type === 'alert.resolved';
  const lines = [
    resolved ? 'An alert has been resolved.' : 'An alert needs attention.',
    '',
    `Alert:     ${title}`,
    `Severity:  ${sev.toLowerCase()}`,
    a.kind === 'SITE_OUTAGE' ? `Site:      ${oneLine(a.site, 100) || '—'}` : `Computer:  ${oneLine(a.computer, 100) || '—'}`,
    `Business:  ${oneLine(a.business, 100) || '—'}`,
    `Raised:    ${a.firstSeenAt.toISOString()}`,
    ...(resolved && a.resolvedAt ? [`Resolved:  ${a.resolvedAt.toISOString()}`] : []),
    '',
    `Open it in rem0te: ${link}`,
    '',
    FOOTER,
  ];
  return { subject: oneLine(`[rem0te] ${resolved ? 'Resolved' : sev}: ${title}`, 200), text: lines.join('\n') };
}

export const REPORT_TITLE: Record<string, string> = {
  'patch-compliance': 'Patch compliance', 'agent-coverage': 'Agent coverage', 'alert-frequency': 'Alert frequency', 'offline-time': 'Offline time',
};

export interface ReportForMail {
  report: string;
  business: string | null;
  site: string | null;
  days: number | null;
  schedule: string;
  generatedAt: Date;
  rows: number | null;
  attached: boolean;
}

export function reportMail(r: ReportForMail, link: string): Mail {
  const name = REPORT_TITLE[r.report] ?? r.report;
  const scope = r.business ? oneLine(r.business, 100) : 'All businesses';
  const lines = [
    `Your scheduled ${name.toLowerCase()} report.`,
    '',
    `Report:    ${name}`,
    `Business:  ${scope}`,
    ...(r.site ? [`Site:      ${oneLine(r.site, 100)}`] : []),
    ...(r.days ? [`Period:    the last ${r.days} days`] : []),
    `Generated: ${r.generatedAt.toISOString()}`,
    `Schedule:  ${r.schedule}`,
    '',
    r.attached ? `The report is attached as CSV (${r.rows ?? 0} rows).` : 'Open it in rem0te to see it (no file is attached to this schedule).',
    `Open it in rem0te: ${link}`,
    '',
    FOOTER,
  ];
  return { subject: oneLine(`[rem0te] ${name} report — ${scope}`, 200), text: lines.join('\n') };
}

/** Sent instead of a report when it could not be produced. Says why, never anything of the report. */
export function reportFailedMail(r: { report: string; business: string | null; schedule: string }, reason: string): Mail {
  const name = REPORT_TITLE[r.report] ?? r.report;
  const scope = r.business ? oneLine(r.business, 100) : 'All businesses';
  return {
    subject: oneLine(`[rem0te] ${name} report could not be sent — ${scope}`, 200),
    text: [
      `Your scheduled ${name.toLowerCase()} report for ${scope} was not sent.`,
      '',
      `Why: ${oneLine(reason, 300)}`,
      `Schedule: ${r.schedule}`,
      '',
      'Nothing from the report is included in this message. Ask whoever manages reports in rem0te to look at the schedule.',
      '',
      FOOTER,
    ].join('\n'),
  };
}

export function verificationMail(who: string, link: string): Mail {
  return {
    subject: '[rem0te] Confirm this address for notifications',
    text: [
      `${oneLine(who, 100)} asked to send rem0te alert emails and scheduled reports to this address.`,
      '',
      'If you expect them, confirm the address here (the link works once, for 7 days):',
      link,
      '',
      'If you do not, ignore this message: nothing will be sent to this address unless it is confirmed.',
      '',
      FOOTER,
    ].join('\n'),
  };
}

export function testMail(by: string): Mail {
  return {
    subject: '[rem0te] Test email',
    text: [`This is a test email from rem0te, sent by ${oneLine(by, 120)}.`, '', 'If you can read it, outbound email works.', '', FOOTER].join('\n'),
  };
}

/** For logs and the UI: j…@example.com. The domain stays, the person does not. */
export function maskAddress(a: string): string {
  const at = a.lastIndexOf('@');
  if (at < 1) return '…';
  return `${a[0]}…@${a.slice(at + 1)}`;
}

/** One mailbox address. Deliberately narrow: no display names, quotes, comments or line breaks. */
const LOCAL_PART = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}$/;
const DOMAIN_LABEL = /^[A-Za-z0-9-]{1,63}$/;
export function isAddress(s: string): boolean {
  const at = s.lastIndexOf('@');
  if (at < 1 || s.indexOf('@') !== at) return false;
  const labels = s.slice(at + 1).split('.');
  return LOCAL_PART.test(s.slice(0, at)) && labels.length >= 2
    && labels.every((l) => DOMAIN_LABEL.test(l) && !l.startsWith('-') && !l.endsWith('-'));
}
export function normaliseAddress(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (s.length > 254 || !isAddress(s)) return null;
  // Lower-cased whole: mailbox local parts are case-insensitive in practice,
  // and one address must not be two recipients.
  return s.toLowerCase();
}
