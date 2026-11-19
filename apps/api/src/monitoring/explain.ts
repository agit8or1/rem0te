/**
 * The plain-English explanation on an alert (0.66). Pure: built on read from
 * the alert, its stored classification and its monitor, so an alert raised
 * before 0.66 is explained too, and nothing here is stored.
 *
 * It must not claim more than the evidence says. One event is one event: the
 * text says when a single report cannot show that hardware is failing, and
 * says plainly when Rem0te does not know an event at all.
 */
import {
  benignMatch, classifyThreshold, eventFacts, KNOWN_BENIGN, KNOWN_EVENTS, samplesOf, WINDOWS_LEVEL_NAMES,
  type AlertClass, type Basis, type Classification,
} from './classify';

export interface Explanation {
  whatHappened: string;
  whyGenerated: string;
  howSerious: string;
  recommendedAction: string;
  /** How the class was reached, in words: a known pattern, a catalogued event, the event level, or the monitor's own setting. */
  certainty: string;
  classification: { class: AlertClass; basis: Basis; matched: string | null; matchedTitle: string | null; version: number; seen: number; unseen: number; benign: number };
}

export interface ExplainInput {
  kind: string;
  ruleKey: string;
  title: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  detail: unknown;
  classification: Classification | null;
  rule: { name: string; severity: 'INFO' | 'WARNING' | 'CRITICAL'; params: Record<string, unknown> } | null;
  /** 0.67: the approved alert quality rules that changed this alert, by name. */
  qualityRules?: { id: string; name: string }[];
}

const levelName = (l: number | null | undefined) => (typeof l === 'number' ? `${WINDOWS_LEVEL_NAMES[l] ?? `level ${l}`} (level ${l})` : 'an unknown level');
const list = (v: unknown) => (Array.isArray(v) && v.length ? v.join(', ') : null);
const sevWord = (s: string) => s.toLowerCase();

const CERTAINTY: Record<Basis, string> = {
  known_benign: 'Known harmless pattern: every condition of the pattern (log, provider, event ID, level, status code and component) was checked against the event.',
  known_event: 'Catalogued Windows event: Rem0te recognises this provider and event ID. The meaning is Windows\', the severity Rem0te\'s.',
  level: 'Event level: Windows logged it as Information or Verbose, and the monitor did not ask for that level. Rem0te does not otherwise know this event.',
  rule: 'Unverified: Rem0te does not recognise this event, so the severity is the one set on the monitor.',
  partial: 'Partly seen: the agent counted more matching events than it sent, so the rest could not be checked.',
  threshold: 'Monitor threshold: the monitor measured a value against its own limit and hysteresis.',
  quality_rule: 'Alert quality rule: an approved rule for this scope changed the severity. It was tested against stored history and approved before it applied.',
};

/** 0.67: "An approved alert quality rule … lowered it", or nothing. */
function ruleNote(a: ExplainInput): string {
  const r = a.qualityRules ?? [];
  if (!r.length) return '';
  return ` An approved alert quality rule (${r.map((x) => `"${x.name}"`).join(', ')}) applies to it${a.rule && a.rule.severity !== a.severity ? ` and lowered it to ${sevWord(a.severity)}` : ''}; see False Positives & Rule Improvements.`;
}

const KIND_TEXT: Record<string, { what: (d: Record<string, unknown>, title: string) => string; action: string }> = {
  OFFLINE: { what: (d) => `The computer has not been heard from${typeof d.minutes === 'number' ? ` for ${d.minutes} minutes` : ''}: no agent heartbeat and RustDesk cannot reach it.`, action: 'Check whether it is switched off, asleep or off the network. If several computers at one site are offline, look at that site\'s internet connection.' },
  AGENT_SILENT: { what: () => 'RustDesk can still reach the computer, but Rem0te\'s agent has stopped checking in.', action: 'Use Update agent on the computer\'s Agent card, or re-run the installer on the machine. Remote control should still work.' },
  DISK_FREE: { what: (d) => `The system disk is short of free space${typeof d.freePercent === 'number' ? ` (${d.freePercent}% free)` : ''}.`, action: 'Free space (temporary files, old updates, large downloads) or add capacity. Windows Update and some programs fail on a full system disk.' },
  DRIVE_FREE: { what: (d) => `A fixed drive${typeof d.drive === 'string' ? ` (${d.drive})` : ''} is short of free space.`, action: 'Free space on that drive or add capacity.' },
  CPU_HIGH: { what: (d) => `The processor stayed busy${typeof d.percent === 'number' ? ` at ${d.percent}%` : ''} for several heartbeats in a row.`, action: 'Look at the Processes tab for what is using it. A long update or scan can do this briefly.' },
  MEMORY_HIGH: { what: (d) => `Memory stayed nearly full${typeof d.usedPercent === 'number' ? ` (${d.usedPercent}% used)` : ''} for several heartbeats in a row.`, action: 'Look at the Processes tab for what is using it, and consider a restart or more memory.' },
  SERVICE_STOPPED: { what: (d) => `The Windows service ${typeof d.service === 'string' ? d.service : ''} is not running${typeof d.status === 'string' ? ` (${d.status})` : ''}.`.replace('  ', ' '), action: 'Start it from the Services tab and check the System log for why it stopped. A service that keeps stopping needs its own fix.' },
  REBOOT_PENDING: { what: () => 'Windows has been waiting for a restart for longer than the monitor allows.', action: 'Restart the computer at a convenient time (or let a restart window do it). Updates are not finished until it does.' },
  UPTIME_LONG: { what: () => 'The computer has not been restarted for longer than the monitor allows.', action: 'Restart it at a convenient time.' },
  UPDATES_MISSING: { what: () => 'Security or critical updates have been offered to this computer for longer than the monitor allows.', action: 'Install them (Patches tab, or a patch policy).' },
  UPDATE_FAILED: { what: () => 'An update failed to install on this computer.', action: 'Look at the failure code on the Patches tab, then retry. Repeated failures usually need disk space, a restart or a repair of Windows Update.' },
  WARRANTY_EXPIRING: { what: () => 'The hardware warranty ends soon, or has ended.', action: 'Decide whether to extend the warranty or plan a replacement.' },
  SITE_OUTAGE: { what: () => 'Most of the computers at one site went offline at about the same time.', action: 'Check the site\'s internet connection and power before looking at single computers.' },
};

export function explainAlert(a: ExplainInput): Explanation {
  const d = (a.detail && typeof a.detail === 'object' ? a.detail : {}) as Record<string, unknown>;
  const ruleName = a.rule?.name ?? a.ruleKey;
  if (a.kind !== 'EVENT_MATCH') {
    const c = a.classification ?? classifyThreshold(a.severity);
    const t = KIND_TEXT[a.kind];
    return {
      whatHappened: t ? t.what(d, a.title) : a.title,
      whyGenerated: a.kind === 'SITE_OUTAGE'
        ? 'Rem0te groups offline alerts when at least three computers at a site, and at least half of it, are offline at once.'
        : `The monitor "${ruleName}" (${a.ruleKey}) found the condition it watches for, past its threshold. Its severity is ${sevWord(a.severity)}.${ruleNote(a)}`,
      howSerious: a.severity === 'CRITICAL' ? 'Set as critical on the monitor: someone should look soon.' : a.severity === 'WARNING' ? 'Set as a warning on the monitor: worth looking at, rarely urgent.' : 'Set as information on the monitor: for the record.',
      recommendedAction: t?.action ?? 'Open the computer and check the condition the monitor describes.',
      certainty: c.basis === 'quality_rule' ? CERTAINTY.quality_rule : CERTAINTY.threshold,
      classification: { class: c.class, basis: c.basis, matched: null, matchedTitle: null, version: c.v, seen: 0, unseen: 0, benign: 0 },
    };
  }

  // An event monitor.
  const p = (a.rule?.params ?? {}) as Record<string, unknown>;
  const log = typeof d.log === 'string' ? d.log : typeof p.log === 'string' ? p.log : 'event';
  const samples = samplesOf(d);
  const s0 = samples[0] ?? null;
  const c = a.classification;
  const count = typeof d.count === 'number' ? d.count : c?.count ?? 0;
  const benign = c?.matched ? KNOWN_BENIGN.find((b) => b.id === c.matched) ?? null : s0 ? benignMatch(eventFacts(log, s0)) : null;
  const known = c?.matched ? KNOWN_EVENTS.find((k) => k.id === c.matched) ?? null : null;
  const cls: AlertClass = c?.class ?? 'UNKNOWN';
  const basis: Basis = c?.basis ?? 'rule';
  const seen = c?.seen ?? samples.length;
  const unseen = c?.unseen ?? Math.max(0, count - samples.length);

  const ev = s0 ? `event ${s0.eventId ?? '?'} from ${s0.provider ?? 'an unnamed provider'}, logged as ${levelName(s0.level)}` : 'a matching event';
  const quote = s0?.message ? ` Its message begins: "${s0.message.slice(0, 160)}${s0.message.length > 160 ? '…' : ''}"` : '';
  let what: string;
  if (benign && (cls === 'BENIGN' || basis === 'partial')) what = `${benign.explanation}${count > 1 ? ` The agent counted ${count} matching events.` : ''}`;
  else if (known) what = `${known.what} Windows logged ${ev}${count > 1 ? `, ${count} matching events in this report` : ''}.`;
  else what = `Windows logged ${ev} in the ${log} log${count > 1 ? ` (${count} matching events since the last report)` : ''}.${quote}`;

  const watched = [list(p.ids) ? `event IDs ${list(p.ids)}` : null, list(p.levels) ? `levels ${list(p.levels)}` : 'any level', typeof p.provider === 'string' ? `provider ${p.provider}` : 'any provider'].filter(Boolean).join(', ');
  const why = `The monitor "${ruleName}" (${a.ruleKey}) watches the ${log} log for ${watched}, and raises an alert at ${typeof p.threshold === 'number' ? p.threshold : 1} or more matching events. `
    + (a.rule ? `It is set to ${sevWord(a.rule.severity)}; ` : '')
    + (basis === 'known_event' && known ? `Rem0te recognises this as "${known.title}" (${sevWord(known.class)}), and made the alert ${sevWord(a.severity)}${a.rule && a.rule.severity !== a.severity ? `, not ${sevWord(a.rule.severity)}` : ''}.`
      : basis === 'level' ? `Windows logged the event as Information, so Rem0te made the alert ${sevWord(a.severity)} instead of the monitor's severity.`
        : basis === 'partial' ? `the newest event${benign ? ` is a known harmless pattern ("${benign.title}")` : ' was checked'}, but ${unseen} of ${count} matching events were not sent by the agent and could not be checked, so the alert stays ${sevWord(a.severity)}.`
          : basis === 'known_benign' ? 'every counted event matched a known harmless pattern.'
            : basis === 'quality_rule' ? `an approved alert quality rule lowered it to ${sevWord(a.severity)}.`
              : `Rem0te does not recognise this event, so the alert has the monitor's severity, ${sevWord(a.severity)}.`)
    + ((c?.reasons ?? []).some((r) => r.startsWith('recurring:')) ? ` It recurred ${count} times in one report, which raised it to ${sevWord(a.severity)}.` : '')
    + ruleNote(a);

  const serious =
    cls === 'BENIGN' ? 'Not a problem: a known harmless Windows event. Nothing needs doing.'
      : basis === 'partial' ? `Probably nothing${benign ? ': the event that was seen is known to be harmless' : ''}, but it cannot be ruled out until the other ${unseen === 1 ? 'event is' : `${unseen} events are`} checked.`
        : known?.id === 'disk-52-smart-predicted-failure' ? 'Serious: the disk itself predicts that it will fail.'
          : known?.class === 'CRITICAL' ? `Potentially serious. ${count > 1 ? `${count} events in one report make a hardware problem more likely` : 'This is one event, which on its own does not prove the hardware is failing'}: check for repeats and the device's own health before replacing anything.`
            : known ? 'Worth investigating if it repeats; on its own it is usually not urgent.'
              : cls === 'INFORMATIONAL' ? 'Probably not a problem: Windows itself logged it as information. It is recorded, and nobody is paged for it unless your notification rules include information alerts.'
                : `Unknown. Rem0te cannot judge this event; it is ${sevWord(a.severity)} because the monitor says so. Read the event before deciding.`;

  const action =
    cls === 'BENIGN' || (basis === 'partial' && benign) ? (unseen > 0 ? `Look at the ${log} log on the computer around ${typeof d.newestAt === 'string' ? d.newestAt : 'the time of the alert'} for the other matching event${unseen === 1 ? '' : 's'}; if ${unseen === 1 ? 'it is' : 'they are'} the same harmless pattern, resolve the alert.` : 'No action is needed. You can resolve the alert.')
      : known ? known.action
        : cls === 'INFORMATIONAL' ? 'Usually none. If you want such events to page someone, set the monitor\'s levels to include Information.'
          : `Open the ${log} log on the computer and read event ${s0?.eventId ?? ''} from ${s0?.provider ?? 'its provider'}. If it is harmless, resolve the alert and consider narrowing the monitor (a provider or levels).`;

  const matchedTitle = benign?.title ?? known?.title ?? null;
  return {
    whatHappened: what,
    whyGenerated: why,
    howSerious: serious,
    recommendedAction: action,
    certainty: CERTAINTY[basis] + (seen > 0 ? ` The agent sent ${seen} of ${count} matching event${count === 1 ? '' : 's'}.` : ''),
    classification: { class: cls, basis, matched: c?.matched ?? benign?.id ?? null, matchedTitle, version: c?.v ?? 0, seen, unseen, benign: c?.benign ?? 0 },
  };
}
