/**
 * Alert classification (0.66): the one place that decides what a monitored
 * event means. Pure — no database, no clock, no network, nothing from Nest —
 * so unit-alert-classification.mjs can test every decision, and the same input
 * always gives the same answer. Versioned: CLASSIFIER_VERSION goes up whenever
 * a decision below changes, and the API reclassifies open event alerts made by
 * an older version (AlertQualityService, on start).
 *
 * Five classes:
 *
 *   CRITICAL       a catalogued event that strongly indicates a failure
 *   WARNING        a catalogued event worth investigating
 *   INFORMATIONAL  recorded, not normally a technician's problem
 *   BENIGN         a known harmless pattern: never an actionable alert
 *   UNKNOWN        nothing here knows the event: the monitor's own severity stands
 *
 * Nothing here can raise an alert above the severity the monitor was given —
 * that is the ceiling a person set — and nothing lowers one without positive
 * evidence: a known-benign pattern (every structured condition verified), a
 * catalogued event, or an Information/Verbose event under a monitor that did
 * not ask for that level. An event this module does not know keeps the
 * monitor's severity. Basic classification never depends on AI.
 *
 * What the agent sends, and so what this can see: per event monitor, a count
 * of matching events, and the newest event (`sample`: id, level, provider,
 * message truncated to 300 characters). From 0.66 the agent also sends up to
 * five newest events (`samples`). It sends no structured EventData, so the
 * status code and the affected component are read from the message by the
 * two narrow extractors below — device paths and an 8-digit status code,
 * which Windows does not translate — never by matching words in the text.
 */
import { createHash } from 'node:crypto';

export const CLASSIFIER_VERSION = 1;

export const ALERT_CLASSES = ['CRITICAL', 'WARNING', 'INFORMATIONAL', 'BENIGN', 'UNKNOWN'] as const;
export type AlertClass = (typeof ALERT_CLASSES)[number];
type Sev = 'INFO' | 'WARNING' | 'CRITICAL';
const RANK: Record<Sev, number> = { INFO: 0, WARNING: 1, CRITICAL: 2 };
const minSev = (a: Sev, b: Sev): Sev => (RANK[a] <= RANK[b] ? a : b);
const maxSev = (a: Sev, b: Sev): Sev => (RANK[a] >= RANK[b] ? a : b);
export const CLASS_SEVERITY: Record<Exclude<AlertClass, 'BENIGN' | 'UNKNOWN'>, Sev> = { CRITICAL: 'CRITICAL', WARNING: 'WARNING', INFORMATIONAL: 'INFO' };

/** How a class was reached. */
export const BASES = ['known_benign', 'known_event', 'level', 'rule', 'partial', 'threshold'] as const;
export type Basis = (typeof BASES)[number];

/** Windows event levels, as Get-WinEvent numbers them. 0 (LogAlways) is what the Security log's audit events use. */
export const WINDOWS_LEVEL_NAMES: Record<number, string> = { 0: 'LogAlways', 1: 'Critical', 2: 'Error', 3: 'Warning', 4: 'Information', 5: 'Verbose' };
/** Levels that by themselves say "nothing is wrong". Not 0: audit events are level 0 whatever they report. */
export const QUIET_LEVELS: ReadonlySet<number> = new Set([4, 5]);

// ── Structured facts from one event ─────────────────────────────────────────

export interface EventSample { eventId: number | null; level: number | null; provider: string | null; message: string | null; at?: string | null }

export const COMPONENTS = ['volume-shadow-copy', 'physical-disk', 'volume', 'storage-controller'] as const;
export type Component = (typeof COMPONENTS)[number];

/**
 * The NT device path an event names, as a component. Device paths are not
 * translated, so this works on any Windows language. Most specific first: a
 * shadow copy's path also contains "HarddiskVolume".
 */
export function componentOf(message: string | null): Component | null {
  if (!message) return null;
  if (/\\Device\\HarddiskVolumeShadowCopy\d+(?:\\|\b)/i.test(message)) return 'volume-shadow-copy';
  if (/\\Device\\Harddisk\d+\\DR\d+\b/i.test(message)) return 'physical-disk';
  if (/\\Device\\HarddiskVolume\d+\b/i.test(message)) return 'volume';
  if (/\\Device\\(?:Ide\\|RaidPort\d+\b|Scsi\\|Ide\b)/i.test(message)) return 'storage-controller';
  return null;
}

/**
 * The status code an event reports: the first 8-digit hexadecimal 0x value
 * (an NTSTATUS or HRESULT), upper-cased. Shorter or longer hex (an internal
 * code, a block address, a pointer) is not a status code.
 */
export function statusCodeOf(message: string | null): string | null {
  if (!message) return null;
  const m = /(?<![0-9A-Za-z])0x([0-9A-Fa-f]{8})(?![0-9A-Fa-f])/.exec(message);
  return m ? `0x${m[1].toUpperCase()}` : null;
}

export interface EventFacts { log: string; provider: string | null; providerKey: string | null; eventId: number | null; level: number | null; statusCode: string | null; component: Component | null }

export function eventFacts(log: string, s: EventSample): EventFacts {
  const provider = typeof s.provider === 'string' && s.provider.trim() ? s.provider.trim() : null;
  return { log, provider, providerKey: provider ? provider.toLowerCase() : null, eventId: s.eventId ?? null, level: s.level ?? null, statusCode: statusCodeOf(s.message), component: componentOf(s.message) };
}

// ── Fingerprints ────────────────────────────────────────────────────────────

/**
 * The message with what varies between equivalent events taken out: shadow
 * copy numbers, GUIDs, dates and times, process ids, temporary paths, user
 * profile names, block addresses and long hexadecimal values (addresses).
 * 8-digit status codes, event-specific numbers (an internal code, a disk
 * number) and everything else stay.
 */
export function normaliseMessage(message: string | null): string {
  if (!message) return '';
  return message
    .toLowerCase()
    .replace(/harddiskvolumeshadowcopy\d+/g, 'harddiskvolumeshadowcopy#')
    .replace(/\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?/g, '{guid}')
    .replace(/\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}[0-9:.z+-]*/g, '<time>')
    .replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, '<date>')
    .replace(/\b\d{1,2}:\d{2}[0-9:]*/g, '<time>')
    .replace(/\b(process id|processid|pid)(\s*[:=]?\s*)\d+/g, '$1$2#')
    .replace(/[a-z]:\\users\\[^\\\s]+\\appdata\\local\\temp\\[^\s"']*/g, '<temp>')
    .replace(/[a-z]:\\windows\\temp\\[^\s"']*/g, '<temp>')
    .replace(/\\users\\[^\\\s]+\\/g, '\\users\\<user>\\')
    .replace(/(logical block address\s*)0x[0-9a-f]+/g, '$1<lba>')
    .replace(/(?<![0-9a-z])0x[0-9a-f]{9,}(?![0-9a-f])/g, '<hex>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 32 hex characters: the same for two events that differ only in what normaliseMessage takes out. */
export function fingerprintOf(log: string, s: EventSample): string {
  const f = eventFacts(log, s);
  const canonical = ['fp1', f.log, f.providerKey ?? '', f.eventId ?? '', f.level ?? '', f.statusCode ?? '', f.component ?? '', normaliseMessage(s.message)].join('\n');
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}
export const FINGERPRINT_RE = /^[0-9a-f]{32}$/;

// ── Known-benign patterns ───────────────────────────────────────────────────

/**
 * Events known to be harmless, each matched on every structured field it
 * names — log, provider, event id, level, status code and component — and
 * never on message words. An entry may not leave any of those out (§78
 * checks it), so no entry can quietly match a whole event id.
 */
export interface BenignPattern {
  id: string;
  title: string;
  log: string;
  provider: string;
  eventId: number;
  levels: number[];
  statusCode: string;
  component: Component;
  /** Plain English, shown in the alert explanation. */
  explanation: string;
}

export const KNOWN_BENIGN: readonly BenignPattern[] = [
  {
    // DS-HOME1, 2026-11-18: "TxR init phase for hive \??\GLOBALROOT\Device\
    // HarddiskVolumeShadowCopy59\Windows\System32\config\DRIVERS (TM: {…},
    // RM: {…}) finished with result=0xC00000A2 (Internal code=7)." Raised as a
    // critical disk alert by the pre-0.66 disk-errors monitor, which named no
    // provider and no level.
    id: 'kernel-general-11-txr-shadow-copy',
    title: 'Registry transaction start-up inside a read-only shadow copy',
    log: 'System',
    provider: 'Microsoft-Windows-Kernel-General',
    eventId: 11,
    levels: [4],
    statusCode: '0xC00000A2',
    component: 'volume-shadow-copy',
    explanation:
      'Windows tried to start the transactional registry (TxR) for a registry hive stored inside a Volume Shadow Copy. ' +
      'Shadow copies are read-only snapshots, so the attempt ends with 0xC00000A2 (STATUS_MEDIA_WRITE_PROTECTED, "the media is write protected"). ' +
      'It is logged at Information level when backup, System Restore or another program mounts a snapshot and reads its registry. It is not a disk, controller or file-system error.',
  },
];

export function benignMatch(f: EventFacts): BenignPattern | null {
  for (const p of KNOWN_BENIGN) {
    if (f.log !== p.log || f.providerKey !== p.provider.toLowerCase() || f.eventId !== p.eventId) continue;
    if (f.level === null || !p.levels.includes(f.level)) continue;
    if (f.statusCode !== p.statusCode || f.component !== p.component) continue;
    return p;
  }
  return null;
}

// ── Catalogued events ───────────────────────────────────────────────────────

/** Windows storage controller and RAID drivers that log "controller error" as their own event 11. */
export const STORAGE_CONTROLLER_PROVIDERS: readonly string[] = [
  'atapi', 'msahci', 'storahci', 'stornvme', 'storport', 'secnvme',
  'iastor', 'iastora', 'iastorac', 'iastorav', 'iastoravc', 'iastore', 'iastorv', 'iastorvd', 'iavroc',
  'lsi_sas', 'lsi_sas2', 'lsi_sas2i', 'lsi_sas3', 'lsi_sas3i', 'lsi_sss', 'megasas', 'megasas2i', 'megasas35i', 'megasr',
  'percsas2i', 'percsas3i', 'hpcisss2', 'hpcisss3', 'smartpqi', 'arcsas', 'amdsata', 'amdsbs', 'nvraid', 'rcraid',
];

export interface KnownEvent {
  id: string;
  log: string;
  providers: readonly string[];
  eventId: number;
  class: 'CRITICAL' | 'WARNING';
  subsystem: 'disk' | 'storage-controller' | 'file-system';
  title: string;
  what: string;
  action: string;
}

export const KNOWN_EVENTS: readonly KnownEvent[] = [
  { id: 'disk-7-bad-block', log: 'System', providers: ['disk'], eventId: 7, class: 'CRITICAL', subsystem: 'disk', title: 'Bad block on a disk',
    what: 'The disk driver reported a bad block: a part of the disk that could not be read or written.',
    action: 'Check the disk\'s own health (the manufacturer\'s tool, or Get-PhysicalDisk / SMART), make sure a recent backup exists, and watch for repeats. One bad block is not proof the disk is failing; more of them, or other disk errors, are.' },
  { id: 'disk-11-controller-error', log: 'System', providers: ['disk'], eventId: 11, class: 'CRITICAL', subsystem: 'disk', title: 'Disk controller error',
    what: 'The disk driver reported a controller error on a disk: a request to the disk failed at the controller or cable.',
    action: 'Check cables and connections (for a desktop), the storage controller driver and firmware, and the disk\'s own health. A single error can follow a power or cable glitch; repeats point to hardware.' },
  { id: 'disk-51-paging-error', log: 'System', providers: ['disk'], eventId: 51, class: 'WARNING', subsystem: 'disk', title: 'Error during a paging operation',
    what: 'Windows hit an error reading or writing the paging file on a disk. It often accompanies removable or USB disks being disconnected, and sometimes a failing disk.',
    action: 'See whether it names a removable disk. If it names an internal disk and repeats, check the disk\'s health and its connection.' },
  { id: 'disk-52-smart-predicted-failure', log: 'System', providers: ['disk'], eventId: 52, class: 'CRITICAL', subsystem: 'disk', title: 'The disk predicts its own failure (SMART)',
    what: 'The disk\'s own self-monitoring (SMART) told Windows that it expects to fail.',
    action: 'Back up the computer now and plan to replace the disk. This is the disk\'s own prediction, not a guess by Rem0te.' },
  { id: 'disk-153-io-retried', log: 'System', providers: ['disk'], eventId: 153, class: 'WARNING', subsystem: 'disk', title: 'Disk I/O was retried',
    what: 'A read or write to a disk had to be retried. The operation then succeeded, but retries mean the disk or its path was slow to answer.',
    action: 'One retry is usually harmless. Many of them, or retries together with other disk errors, point at a failing disk, a cable or a controller.' },
  { id: 'controller-11-error', log: 'System', providers: STORAGE_CONTROLLER_PROVIDERS, eventId: 11, class: 'CRITICAL', subsystem: 'storage-controller', title: 'Storage controller error',
    what: 'A storage controller driver reported a controller error on one of its devices.',
    action: 'Check the controller\'s driver and firmware, the cables and the disks behind it. A single error can follow a power or cable glitch; repeats point to hardware.' },
  { id: 'controller-129-reset', log: 'System', providers: STORAGE_CONTROLLER_PROVIDERS, eventId: 129, class: 'WARNING', subsystem: 'storage-controller', title: 'Storage device reset',
    what: 'A storage controller driver reset a device that stopped answering.',
    action: 'Occasional resets can follow power-saving or a busy disk; frequent ones point at a failing disk, cable, controller or driver.' },
  { id: 'ntfs-55-corruption', log: 'System', providers: ['ntfs', 'microsoft-windows-ntfs'], eventId: 55, class: 'CRITICAL', subsystem: 'file-system', title: 'File system structure is corrupt',
    what: 'NTFS found that the file system structure on a volume is corrupt and unusable in places.',
    action: 'Run chkdsk on the volume it names (it may need a restart), make sure a backup exists, and check the disk underneath for errors.' },
];

export function knownEventMatch(f: EventFacts): KnownEvent | null {
  if (f.providerKey === null || f.eventId === null) return null;
  return KNOWN_EVENTS.find((k) => k.log === f.log && k.eventId === f.eventId && k.providers.includes(f.providerKey!)) ?? null;
}

/** A WARNING-class catalogued event seen this many times in one report is treated as CRITICAL (still under the monitor's severity). */
export const RECURRENCE_ESCALATE = 5;

// ── The decision ────────────────────────────────────────────────────────────

export interface SampleDecision {
  fingerprint: string;
  class: AlertClass;
  basis: Basis;
  matched: string | null;
  eventId: number | null; level: number | null; provider: string | null; statusCode: string | null; component: Component | null;
}

export interface Classification {
  v: number;
  class: AlertClass;
  /** The alert's severity, or null: nothing actionable (every counted event was a known-benign pattern). */
  severity: Sev | null;
  basis: Basis;
  matched: string | null;
  ruleSeverity: Sev;
  count: number;
  seen: number;
  unseen: number;
  benign: number;
  /** count minus the benign events seen: what the monitor's threshold is compared with. */
  effectiveCount: number;
  /** The deciding event's fingerprint, or null for a threshold monitor. */
  fingerprint: string | null;
  reasons: string[];
  samples: SampleDecision[];
}

export interface EventRuleView { severity: Sev; params: { log?: unknown; levels?: unknown } }

function decideSample(log: string, ruleLevels: number[], s: EventSample): SampleDecision {
  const f = eventFacts(log, s);
  const base = { fingerprint: fingerprintOf(log, s), eventId: f.eventId, level: f.level, provider: f.provider, statusCode: f.statusCode, component: f.component };
  const b = benignMatch(f);
  if (b) return { ...base, class: 'BENIGN', basis: 'known_benign', matched: b.id };
  const k = knownEventMatch(f);
  if (k) return { ...base, class: k.class, basis: 'known_event', matched: k.id };
  if (f.level !== null && QUIET_LEVELS.has(f.level) && log !== 'Security' && !ruleLevels.includes(f.level)) return { ...base, class: 'INFORMATIONAL', basis: 'level', matched: null };
  return { ...base, class: 'UNKNOWN', basis: 'rule', matched: null };
}

const sevOf = (d: SampleDecision, ruleSeverity: Sev): Sev =>
  d.class === 'UNKNOWN' ? ruleSeverity : d.class === 'BENIGN' ? 'INFO' : minSev(CLASS_SEVERITY[d.class], ruleSeverity);

/**
 * An event monitor's report, classified. `samples` are the events the agent
 * sent (newest first); `count` is how many matched. Events the agent counted
 * but did not send are "unseen": they cannot be called harmless, so when any
 * are left, the alert is at least WARNING (under the monitor's severity).
 */
export function classifyEvents(rule: EventRuleView, report: { count: number; samples: EventSample[] }): Classification {
  const log = typeof rule.params.log === 'string' ? rule.params.log : '';
  const ruleLevels = Array.isArray(rule.params.levels) ? (rule.params.levels as unknown[]).filter((x): x is number => typeof x === 'number') : [];
  const ruleSeverity = rule.severity;
  const count = Math.max(0, report.count | 0);
  const samples = report.samples.slice(0, Math.max(0, count)).map((s) => decideSample(log, ruleLevels, s));
  const seen = samples.length;
  const unseen = Math.max(0, count - seen);
  const benign = samples.filter((d) => d.class === 'BENIGN').length;
  const effectiveCount = count - benign;
  const reasons: string[] = [];
  const out = (o: Omit<Classification, 'v' | 'ruleSeverity' | 'count' | 'seen' | 'unseen' | 'benign' | 'effectiveCount' | 'samples'>): Classification =>
    ({ v: CLASSIFIER_VERSION, ruleSeverity, count, seen, unseen, benign, effectiveCount, samples, ...o });

  if (count === 0) return out({ class: 'UNKNOWN', severity: null, basis: 'rule', matched: null, fingerprint: null, reasons: ['no_events'] });
  if (seen === 0) {
    reasons.push('no_sample');
    return out({ class: 'UNKNOWN', severity: ruleSeverity, basis: 'rule', matched: null, fingerprint: null, reasons });
  }
  if (benign) reasons.push(`benign_seen:${benign}`);
  if (effectiveCount === 0) {
    const d = samples[0];
    return out({ class: 'BENIGN', severity: null, basis: 'known_benign', matched: d.matched, fingerprint: d.fingerprint, reasons });
  }
  const actionable = samples.filter((d) => d.class !== 'BENIGN');
  // The most severe event seen decides; between equals, the newest.
  let pick = actionable[0] ?? samples[0];
  let sev: Sev = actionable.length ? sevOf(pick, ruleSeverity) : 'INFO';
  for (const d of actionable.slice(1)) { const s2 = sevOf(d, ruleSeverity); if (RANK[s2] > RANK[sev]) { pick = d; sev = s2; } }
  let cls: AlertClass = actionable.length ? pick.class : 'UNKNOWN';
  let basis: Basis = actionable.length ? pick.basis : 'partial';
  // Recurrence: a warning-class storage event, many times in one report.
  if (cls === 'WARNING' && basis === 'known_event' && effectiveCount >= RECURRENCE_ESCALATE && actionable.every((d) => d.matched === pick.matched)) {
    const up = minSev('CRITICAL', ruleSeverity);
    if (RANK[up] > RANK[sev]) { sev = up; cls = 'CRITICAL'; reasons.push(`recurring:${effectiveCount}`); }
  }
  if (unseen > 0 && RANK[sev] < RANK.WARNING) {
    // Something was counted that nobody saw: it may not be what was seen.
    const floor = minSev('WARNING', ruleSeverity);
    if (RANK[floor] > RANK[sev]) { sev = floor; cls = 'UNKNOWN'; basis = 'partial'; reasons.push(`unseen:${unseen}`); }
  } else if (unseen > 0) reasons.push(`unseen:${unseen}`);
  return out({ class: cls, severity: sev, basis, matched: pick.matched, fingerprint: pick.fingerprint, reasons });
}

/** A threshold monitor (disk space, offline, a service…): its own hysteresis decides; the class follows its severity. */
export function classifyThreshold(severity: Sev): Classification {
  const cls: AlertClass = severity === 'CRITICAL' ? 'CRITICAL' : severity === 'WARNING' ? 'WARNING' : 'INFORMATIONAL';
  return { v: CLASSIFIER_VERSION, class: cls, severity, basis: 'threshold', matched: null, ruleSeverity: severity, count: 1, seen: 0, unseen: 0, benign: 0, effectiveCount: 1, fingerprint: null, reasons: [], samples: [] };
}

/** The more severe of two severities (an open alert keeps the worst it has seen). */
export const worse = maxSev;

/** The samples of a stored event report: `samples` (0.66 agents), else the single `sample`. */
export function samplesOf(detail: unknown): EventSample[] {
  const d = (detail && typeof detail === 'object' ? detail : {}) as { samples?: unknown; sample?: unknown };
  const list = Array.isArray(d.samples) && d.samples.length ? d.samples : d.sample && typeof d.sample === 'object' ? [d.sample] : [];
  return list.filter((x): x is EventSample => !!x && typeof x === 'object');
}
