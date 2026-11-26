/**
 * How old each device tab's data is (0.88, UX P1-2, roadmap §10).
 *
 * Every tab that shows state a device reported says where it came from and
 * when, in one place and one form. The time is the device's report, never
 * the moment the browser fetched it: a page loaded a second ago can show an
 * inventory three days old, and that is what a technician needs to know.
 *
 * "Stale" is said only where a rule already exists, so this module invents
 * none:
 *  - check-in data uses the heartbeat window (HEARTBEAT_STALE_MS, passed in
 *    by the caller, §49);
 *  - the update scan uses the server's own `fresh` / `stale` verdict;
 *  - a snapshot uses the snapshot tabs' own "over a day old" window (OLD_MS
 *    in snapshot-tabs.tsx, passed in).
 * Inventory and the monitoring report show their age with no verdict.
 * A missing time is "not reported yet", never fresh.
 *
 * Tabs that are request lists or live views (Diagnostics, Actions,
 * Terminal, Files, Chat, History, Event logs, which queries on demand) have
 * no freshness line: each row there carries its own time.
 *
 * Pure: no imports, no clock but the `now` it is given.
 */

export type FreshnessTab =
  | 'overview' | 'performance' | 'monitoring' | 'software' | 'patches'
  | 'processes' | 'services' | 'network';

export interface FreshnessFacts {
  /** The device's last check-in (`lastSeenAt`). */
  lastSeenAt?: string | null;
  /** When the full inventory was collected (`inventory.collectedAt`). */
  inventoryAt?: string | null;
  /** The agent's last monitoring report (`reportedAt`). */
  monitorReportAt?: string | null;
  /** The update scan's evidence, as the patch summary gives it. */
  patchScan?: { at: string | null; freshness: 'fresh' | 'stale' | 'none' } | null;
  /** When the snapshot this tab shows was taken. */
  snapshotAt?: string | null;
  /** The snapshot tabs' own staleness window; without it, age only. */
  snapshotStaleMs?: number;
}

export type Verdict = 'fresh' | 'stale' | 'unknown' | 'none';

export interface Freshness {
  /** What the time is: "Inventory collected", "Last check-in"… */
  label: string;
  /** ISO time, or null when nothing has been reported. */
  at: string | null;
  /**
   * `stale` / `fresh` only under an existing rule; `none` when no rule
   * applies (age only); `unknown` when nothing was reported.
   */
  verdict: Verdict;
}

export const FRESHNESS_TABS: readonly FreshnessTab[] = [
  'overview', 'performance', 'monitoring', 'software', 'patches', 'processes', 'services', 'network',
];

function valid(at: string | null | undefined): at is string {
  return typeof at === 'string' && Number.isFinite(new Date(at).getTime());
}

function heartbeat(label: string, at: string | null | undefined, now: number, windowMs: number): Freshness {
  if (!valid(at)) return { label, at: null, verdict: 'unknown' };
  return { label, at, verdict: now - new Date(at).getTime() > windowMs ? 'stale' : 'fresh' };
}

function ageOnly(label: string, at: string | null | undefined): Freshness {
  return valid(at) ? { label, at, verdict: 'none' } : { label, at: null, verdict: 'unknown' };
}

/**
 * The freshness line for a tab, or null for a tab that has none.
 * `heartbeatStaleMs` is HEARTBEAT_STALE_MS; it is a parameter so this file
 * stays pure.
 */
export function tabFreshness(tab: string, f: FreshnessFacts, now: number, heartbeatStaleMs: number): Freshness | null {
  switch (tab) {
    case 'overview':
    case 'software':
      return ageOnly('Inventory collected', f.inventoryAt);
    case 'performance':
      return heartbeat('Last check-in', f.lastSeenAt, now, heartbeatStaleMs);
    case 'monitoring':
      return ageOnly('Last monitoring report', f.monitorReportAt);
    case 'patches': {
      const s = f.patchScan;
      if (!s || s.freshness === 'none' || !valid(s.at)) return { label: 'Update scan', at: null, verdict: 'unknown' };
      return { label: 'Update scan', at: s.at, verdict: s.freshness === 'stale' ? 'stale' : 'fresh' };
    }
    case 'processes':
    case 'services':
    case 'network':
      return f.snapshotStaleMs ? heartbeat('Snapshot taken', f.snapshotAt, now, f.snapshotStaleMs) : ageOnly('Snapshot taken', f.snapshotAt);
    default:
      return null;
  }
}

/** "3 min ago", "2 h ago", "4 days ago"; "just now" under a minute; a future time is "just now". */
export function relativeAge(at: string, now: number): string {
  const ms = Math.max(0, now - new Date(at).getTime());
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} days ago`;
}

/** The sentence a screen reader hears and the line shows. */
export function freshnessText(x: Freshness, now: number): string {
  if (!x.at) return `${x.label}: not reported yet`;
  const age = relativeAge(x.at, now);
  return x.verdict === 'stale' ? `${x.label} ${age} — stale` : `${x.label} ${age}`;
}
