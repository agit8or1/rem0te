/**
 * What an "Ask AI" request carries, and how it is redacted (0.48). Pure: the
 * unit test (scripts/unit-ai-psa.mjs) reads exactly what the API runs.
 *
 * The prompt goes to a model provider outside this server, so before anything
 * leaves:
 *
 *   1. the names this server knows for the computer — its name, hostname,
 *      serial number, domain, the logged-on user (both halves of DOMAIN\user),
 *      its business and site — are replaced wherever they appear, case
 *      insensitively, longest first;
 *   2. what Windows writes that identifies people and machines is replaced by
 *      pattern: SIDs, DOMAIN\user, UNC host names, labelled account and
 *      workstation fields of Security-log messages, \Users\<name> paths
 *      without a drive, fully qualified host names, serial-like tokens and
 *      labelled serial numbers;
 *   3. then the ClientSt0r redactor, redactForPeer (integration/timeline.ts):
 *      credentials, tokens and keys, e-mail, IPv4 and IPv6 addresses, MACs,
 *      RustDesk IDs and C:\Users\<name> profile paths.
 *
 * What is sent: the event's id, provider, level, log name, time and the
 * redacted message, plus the computer's OS version. Never the computer's name
 * or business. The whole input is capped at INPUT_CAP characters.
 */
import { createHash } from 'crypto';
import { redactForPeer, zeroCounts, type RedactionCounts } from '../integration/timeline';
import { CONTROLS_ALL, CONTROLS_KEEP_LINES } from '../common/text';
import { isHostName } from '../email/smtp-host';

export const INPUT_CAP = 8000;
export const MESSAGE_CAP = 6000;

export interface AiRedactionCounts extends RedactionCounts {
  known_name: number; sid: number; account: number; host_name: number; serial: number;
}
export const zeroAiCounts = (): AiRedactionCounts => ({ ...zeroCounts(), known_name: 0, sid: 0, account: 0, host_name: 0, serial: 0 });

/** The words Windows uses for well-known principals: kept, they are not people. */
const WELL_KNOWN_DOMAINS = new Set(['nt authority', 'nt service', 'builtin', 'window manager', 'font driver host', 'iis apppool', 'nt virtual machine', 'authority', 'service', 'manager', 'host', 'apppool',
  'microsoft', 'windows', 'tasks', 'services', 'policies', 'control', 'currentcontrolset', 'controlset001', 'drivers', 'system32', 'syswow64', 'appdata', 'programdata']);
const REGISTRY_ROOTS = /^(hklm|hkcu|hkcr|hku|hkcc|hkey_[a-z_]+|registry|machine|software|system)$/i;
const FILE_EXT = /\.(exe|dll|sys|msi|msp|cab|log|etl|evtx|xml|json|txt|ini|cfg|config|dat|db|ps1|bat|cmd|vbs|js|mui|cat|inf|tmp|bak|ocx|cpl|drv|scr|manifest|pdb|zip|cer|crt|pfx|ps1xml|psm1|psd1)$/i;

// Account SIDs (domain or local accounts, Azure AD, app containers). Well-known ones (S-1-5-18 SYSTEM, S-1-5-32-544, service SIDs) name no person and are kept.
const SID = /\bS-1-(?:5-21|12-1|15-[23])-[0-9][0-9-]{0,160}/g;
const UNDER_KNOWN = /(?<![\w.-])[A-Za-z0-9][A-Za-z0-9.-]{0,200}\.\[name\]/g;
// Labelled fields in Security-log messages ("Account Name:\t\tbob").
const ACCOUNT_FIELD = /\b(Account Name|Account Domain|User Name|Target User Name|Subject User Name|Target Domain Name|Logon Account|Client User Name|Caller User Name|Old Account Name|New Account Name|User|Account)(:[ \t]+)([^\r\n\t]{1,128})/g;
const HOST_FIELD = /\b(Workstation Name|Workstation|Computer Name|Computer|Source Workstation|Client Name|Caller Computer Name|Machine Name|Host Name|Hostname|Server Name|Source Host|Target Server Name|Network Address|Source Network Address|Client Address)(:[ \t]+)([^\r\n\t]{1,128})/g;
const SERIAL_FIELD = /\b(Serial(?: Number)?|SerialNumber|Service Tag|Asset Tag)(\s*[:=]\s*)(\S{1,64})/gi;
const UNC = /\\\\([A-Za-z0-9][A-Za-z0-9.-]{0,62})(?=\\|\s|$)/g;
const DOMAIN_USER = /(?<![\\\w:/.%-])([A-Za-z][A-Za-z0-9-]{0,14})\\([A-Za-z0-9][A-Za-z0-9._$-]{0,63})/g;
const BARE_USERS_PATH = /(?<![A-Za-z]:)\\(Users|Documents and Settings)\\([^\\\s"'<>|]+)/gi;
// A dotted name ending in a letters-only label: a host, unless it ends like a file. Candidates are a
// flat run checked label by label (isHostName), so nothing here can backtrack badly.
const FQDN_CANDIDATE = /(?<![\w.@-])[A-Za-z0-9][A-Za-z0-9.-]{2,252}(?![\w@-])/g;
const KEEP_HOSTS = /(^|\.)(microsoft\.com|windows\.com|windowsupdate\.com|msftncsi\.com|office\.com|live\.com|example\.com|rustdesk\.com)$/i;
// Upper-case letters and digits mixed, 10 to 24 long: a serial, a service tag, a licence. KB numbers and hex error codes are kept.
const SERIALISH = /(?<![\w-])(?!KB\d)(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{10,24}(?![\w-])/g;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Names to replace: at least 3 characters, unique, longest first. */
export function knownNames(raw: (string | null | undefined)[]): string[] {
  const out = new Set<string>();
  for (const v of raw) {
    if (!v) continue;
    for (const part of [v, ...v.split('\\'), ...v.split('@')]) {
      const t = part.trim();
      if (t.length >= 3 && t.length <= 253) out.add(t);
    }
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/** Redact one free-text value for the AI provider. Counts per kind, never values. */
export function redactForAi(input: string, names: string[] = [], counts: AiRedactionCounts = zeroAiCounts()): { text: string; counts: AiRedactionCounts } {
  let s = String(input ?? '').replace(CONTROLS_KEEP_LINES, ' ').slice(0, 100_000);
  for (const n of names) {
    // eslint-disable-next-line security/detect-non-literal-regexp -- the name is escaped: a literal match only
    s = s.replace(new RegExp(`(?<![A-Za-z0-9])${escapeRe(n)}(?![A-Za-z0-9])`, 'gi'), () => { counts.known_name++; return '[name]'; });
  }
  // A host under a known domain ("dc01.[name]") is a host name too: take the prefix with it.
  s = s.replace(UNDER_KNOWN, () => { counts.host_name++; return '[host]'; });
  s = s.replace(SID, () => { counts.sid++; return '[sid]'; });
  s = s.replace(ACCOUNT_FIELD, (m, k: string, sep: string, v: string) => {
    if (/^\s*(-|N\/A|NULL SID|SYSTEM|LOCAL SERVICE|NETWORK SERVICE|ANONYMOUS LOGON|NT AUTHORITY|\[[a-z]+\])\s*$/i.test(v)) return m;
    counts.account++; return `${k}${sep}[user]`;
  });
  s = s.replace(HOST_FIELD, (m, k: string, sep: string, v: string) => {
    if (/^\s*(-|::1|127\.0\.0\.1|localhost|\[[a-z]+\])\s*$/i.test(v)) return m;
    counts.host_name++; return `${k}${sep}[host]`;
  });
  s = s.replace(SERIAL_FIELD, (_m, k: string, sep: string) => { counts.serial++; return `${k}${sep}[serial]`; });
  s = s.replace(UNC, () => { counts.host_name++; return '\\\\[host]'; });
  s = s.replace(BARE_USERS_PATH, (_m, dir: string) => { counts.user_path++; return `\\${dir}\\[user]`; });
  s = s.replace(DOMAIN_USER, (m, d: string, u: string) => {
    if (WELL_KNOWN_DOMAINS.has(d.toLowerCase()) || REGISTRY_ROOTS.test(d) || FILE_EXT.test(u)) return m;
    counts.account++; return '[domain]\\[user]';
  });
  // redactForPeer first takes e-mail addresses whole, before the host rule sees their domain.
  const peer = redactForPeer(s, counts);
  s = peer.text;
  s = s.replace(FQDN_CANDIDATE, (m) => {
    const dot = m.endsWith('.') ? '.' : '';
    const h = (dot ? m.slice(0, -1) : m).toLowerCase();
    const labels = h.split('.');
    if (labels.length < 2 || !/^[a-z]{2,24}$/.test(labels[labels.length - 1]) || !isHostName(h)) return m;
    if (FILE_EXT.test(h) || KEEP_HOSTS.test(h) || /^\d/.test(h) || /^(microsoft|windows|system|msft)\./.test(h)) return m;
    counts.host_name++; return `[host]${dot}`;
  });
  s = s.replace(SERIALISH, () => { counts.serial++; return '[serial]'; });
  return { text: s, counts };
}

export interface EventInput {
  logName: string | null;
  eventId: number | null;
  provider: string | null;
  level: number | null;
  levelName: string | null;
  timeCreated: string | null;
  message: string | null;
}
export interface AlertInput {
  kind: string; ruleKey: string; severity: string; title: string; detail: unknown; firstSeenAt: string;
}

export interface AiPayload {
  /** The user message's text, already redacted. */
  text: string;
  /** SHA-256 over the redacted input, without the time: the same event asked again is a cache hit. */
  fingerprint: string;
  counts: AiRedactionCounts;
  chars: number;
}

const oneLine = (v: unknown, n: number) => String(v ?? '').replace(/[\r\n\t]+/g, ' ').replace(CONTROLS_ALL, '').slice(0, n);

/** Build the redacted input for one event-log entry. */
export function eventPayload(e: EventInput, osVersion: string | null, names: string[]): AiPayload {
  const counts = zeroAiCounts();
  const r = (v: unknown, n: number) => redactForAi(oneLine(v, n), names, counts).text;
  const message = redactForAi(String(e.message ?? '').slice(0, MESSAGE_CAP), names, counts).text;
  const facts = [
    `Log: ${r(e.logName, 64)}`,
    `Event ID: ${e.eventId ?? 'unknown'}`,
    `Source (provider): ${r(e.provider, 200)}`,
    `Level: ${oneLine(e.levelName ?? (e.level !== null ? `level ${e.level}` : 'unknown'), 32)}`,
    `OS: ${r(osVersion ?? 'Windows (version unknown)', 120)}`,
  ];
  const fp = createHash('sha256').update(JSON.stringify(['event', facts, message])).digest('hex');
  const when = e.timeCreated && !Number.isNaN(Date.parse(e.timeCreated)) ? new Date(e.timeCreated).toISOString() : 'unknown';
  return finish([...facts, `Time: ${when}`, 'Message:', message].join('\n'), fp, counts);
}

/** Build the redacted input for one monitoring alert. */
export function alertPayload(a: AlertInput, osVersion: string | null, names: string[]): AiPayload {
  const counts = zeroAiCounts();
  const r = (v: unknown, n: number) => redactForAi(oneLine(v, n), names, counts).text;
  const detail = (() => { try { return JSON.stringify(a.detail ?? {}).slice(0, 3000); } catch { return ''; } })();
  const facts = [
    `Monitoring alert kind: ${oneLine(a.kind, 40)}`,
    `Monitor: ${r(a.ruleKey, 64)}`,
    `Severity: ${oneLine(a.severity, 16)}`,
    `Title: ${r(a.title, 300)}`,
    `OS: ${r(osVersion ?? 'Windows (version unknown)', 120)}`,
    `Detail (JSON): ${redactForAi(detail, names, counts).text}`,
  ];
  const fp = createHash('sha256').update(JSON.stringify(['alert', facts])).digest('hex');
  return finish([...facts, `First seen: ${a.firstSeenAt}`].join('\n'), fp, counts);
}

function finish(text: string, fingerprint: string, counts: AiRedactionCounts): AiPayload {
  const t = text.length > INPUT_CAP ? `${text.slice(0, INPUT_CAP - 30)}\n[truncated for length]` : text;
  return { text: t, fingerprint, counts, chars: t.length };
}

/** The identity of an event across fetches (unredacted, never sent): for "Ticket created". */
export function eventFingerprint(e: EventInput): string {
  return createHash('sha256').update(JSON.stringify([e.logName, e.eventId, e.provider, e.level, e.timeCreated, e.message])).digest('hex');
}
