/**
 * What the device workspace derives from data the page already loads.
 *
 * Nothing here fetches. The queries live in use-device-data.ts and share their
 * keys with the tabs, so the header, the Overview and a tab never disagree and
 * never fetch the same thing twice.
 */

import type { AlertRow } from '@/components/monitoring/alerts';

export type WorkspaceTab =
  | 'overview' | 'performance' | 'monitoring' | 'software' | 'processes' | 'services' | 'network' | 'patches' | 'events' | 'diagnostics' | 'actions' | 'chat' | 'history';

export const TAB_LABEL: Record<WorkspaceTab, string> = {
  overview: 'Overview',
  performance: 'Performance',
  monitoring: 'Monitoring',
  software: 'Software',
  processes: 'Processes',
  services: 'Services',
  network: 'Network',
  patches: 'Patches',
  events: 'Event logs',
  diagnostics: 'Diagnostics',
  actions: 'Actions',
  chat: 'Chat',
  history: 'History',
};

/**
 * Old `?tab=` values, from before the tabs were regrouped (0.31). Alert links,
 * bookmarks and the docs screenshots used them, so they still land somewhere.
 */
const LEGACY_TAB: Record<string, WorkspaceTab> = {
  notes: 'history',
  timeline: 'history',
  'access-review': 'history',
  sessions: 'history',
  'event-log': 'events',
  'test-connection': 'diagnostics',
};

export function parseTab(raw: string | null | undefined): WorkspaceTab | null {
  if (!raw) return null;
  if (raw in TAB_LABEL) return raw as WorkspaceTab;
  return LEGACY_TAB[raw] ?? null;
}

/**
 * How long without a heartbeat before the server sweeps a computer offline
 * (markStaleEndpointsOffline, 10 minutes). The agent checks in about every
 * three minutes, so a last-seen older than this is a missed check-in, not a
 * slow one.
 */
export const HEARTBEAT_STALE_MS = 10 * 60_000;

/** "4m ago", "3h ago", "12d ago" — for values whose age is the point. */
export function ago(at: string | Date | null | undefined): string {
  if (!at) return 'never';
  const ms = Date.now() - new Date(at).getTime();
  if (!Number.isFinite(ms)) return 'unknown';
  if (ms < 60_000) return 'just now';
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function isStale(at: string | null | undefined, maxAgeMs: number): boolean {
  if (!at) return true;
  return Date.now() - new Date(at).getTime() > maxAgeMs;
}

// ── Agent type (docs/capabilities.md) ──────────────────────────────────────

export type AgentKind = 'signed' | 'standard' | 'rustdesk-only' | 'unknown';

export interface AgentType {
  kind: AgentKind;
  label: string;
  /** One line on what this means for the technician. */
  explanation: string;
  /**
   * The read-only POSIX agent — Linux (0.32) or macOS (0.33): it reports
   * heartbeat, inventory and pending updates and acts on nothing the server
   * sends, so there is no software list, no event log and nothing to queue on
   * the computer.
   */
  readOnlyOs?: 'Linux' | 'macOS';
}

const isLinux = (platform: string) => platform.startsWith('linux');
const isMac = (platform: string) => /^(macos|mac|darwin|osx|os x)\b/.test(platform);

/**
 * Which agent the computer runs, from what its heartbeats report.
 *
 * `updateChannel` is self-reported: it decides what the portal withholds, never
 * what it sends, and the signed agent verifies every plan itself — so this is
 * a description, not a permission.
 */
export function agentType(ep: Record<string, unknown>): AgentType {
  const platform = String(ep.platform ?? '').toLowerCase().trim();
  // A Linux computer installed from 0.32 on, or a Mac installed with sudo from
  // 0.33 on, runs the read-only agent; one installed before has RustDesk only
  // and never sends an agent version.
  const os = isLinux(platform) ? 'Linux' : isMac(platform) ? 'macOS' : null;
  if (os && ep.agentVersion) {
    return {
      kind: 'standard',
      label: `Standard (${os})`,
      explanation: os === 'Linux'
        ? 'Reports inventory and pending package updates (read-only). No software list or event logs, and it runs nothing the console sends.'
        : 'Reports inventory and the updates macOS last found (read-only). No software list or event logs, and it runs nothing the console sends.',
      readOnlyOs: os,
    };
  }
  if (os) {
    return {
      kind: 'rustdesk-only',
      label: 'RustDesk only',
      explanation: os === 'Linux'
        ? 'Remote access only: installed before the Linux agent existed. Re-run the Linux installer from an enrolment link to add inventory and pending updates.'
        : 'Remote access only: installed before the macOS agent existed, or without sudo. Re-run the macOS installer with sudo from an enrolment link to add inventory and pending updates.',
    };
  }
  if (ep.updateChannel === 'signed') {
    return {
      kind: 'signed',
      label: 'Signed agent',
      explanation: 'Reports inventory, monitoring and patch status, and can run approved actions and patch deployments.',
    };
  }
  if (platform === 'windows' || ep.agentVersion) {
    return {
      kind: 'standard',
      label: 'Standard agent',
      explanation: 'Reports inventory, monitoring and pending updates (read-only). Approved actions and patch deployment need the signed agent.',
    };
  }
  return { kind: 'unknown', label: 'Agent unknown', explanation: 'This computer has not reported which agent it runs.' };
}

export const reportsInventory = (a: AgentType) => a.kind === 'signed' || a.kind === 'standard' || a.kind === 'unknown';
/** Installed software and event logs: the Windows agents only. */
export const reportsWindowsDetail = (a: AgentType) => reportsInventory(a) && !a.readOnlyOs;
/** Something the console can queue on the computer (reinstall): not the read-only Linux or macOS agent. */
export const acceptsQueuedWork = (a: AgentType) => reportsInventory(a) && !a.readOnlyOs;

// ── Connection status ──────────────────────────────────────────────────────

export interface DeviceStatus {
  tone: 'online' | 'degraded' | 'offline' | 'inactive';
  label: string;
  detail: string | null;
}

/**
 * Online / offline, said the way it is known.
 *
 * `isOnline` is true either from a recent heartbeat or because the RustDesk
 * server can reach the machine while its agent is silent. The second is still
 * "online" for connecting, but every agent-reported value on the page is then
 * as old as the last check-in, and the header says so.
 */
export function deviceStatus(ep: Record<string, unknown>): DeviceStatus {
  const lastSeen = (ep.lastSeenAt as string | null) ?? null;
  if (ep.status === 'ARCHIVED') return { tone: 'inactive', label: 'Archived', detail: 'Nobody can connect until it is restored.' };
  if (ep.status === 'PENDING_ENROLLMENT') return { tone: 'inactive', label: 'Not enrolled yet', detail: 'Its installer has not checked in.' };
  if (ep.isOnline) {
    if (lastSeen && isStale(lastSeen, HEARTBEAT_STALE_MS)) {
      return { tone: 'degraded', label: 'Online (RustDesk only)', detail: `Reachable through RustDesk, but its agent has not checked in since ${ago(lastSeen)}.` };
    }
    return { tone: 'online', label: 'Online', detail: null };
  }
  return { tone: 'offline', label: lastSeen ? `Offline since ${ago(lastSeen)}` : 'Offline', detail: lastSeen ? null : 'Never checked in.' };
}

export const STATUS_DOT: Record<DeviceStatus['tone'], string> = {
  online: 'bg-green-500',
  degraded: 'bg-amber-500',
  offline: 'bg-gray-400',
  inactive: 'bg-gray-400',
};

// ── Alerts ─────────────────────────────────────────────────────────────────

const SEVERITY_RANK: Record<AlertRow['severity'], number> = { CRITICAL: 3, WARNING: 2, INFO: 1 };

export function openAlerts(alerts: AlertRow[] | null | undefined): AlertRow[] {
  return (alerts ?? [])
    .filter((a) => a.state !== 'RESOLVED')
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || +new Date(b.lastSeenAt) - +new Date(a.lastSeenAt));
}

export function worstSeverity(alerts: AlertRow[]): AlertRow['severity'] | null {
  return alerts.reduce<AlertRow['severity'] | null>((w, a) => (!w || SEVERITY_RANK[a.severity] > SEVERITY_RANK[w] ? a.severity : w), null);
}

// ── Monitors, in words ─────────────────────────────────────────────────────

export const MONITOR_KIND_LABEL: Record<string, string> = {
  OFFLINE: 'Offline',
  DISK_FREE: 'Disk space',
  CPU_HIGH: 'Processor load',
  MEMORY_HIGH: 'Memory use',
  SERVICE_STOPPED: 'Windows service',
  EVENT_MATCH: 'Event log',
  REBOOT_PENDING: 'Restart pending',
};

const EVENT_LEVEL: Record<number, string> = { 0: 'any', 1: 'Critical', 2: 'Error', 3: 'Warning', 4: 'Information', 5: 'Verbose' };

/** What a monitor watches for, as a sentence fragment. Parameters as engine.ts validates them. */
export function describeMonitor(kind: string, p: Record<string, unknown>): string {
  const n = (k: string) => (typeof p[k] === 'number' ? (p[k] as number) : null);
  switch (kind) {
    case 'OFFLINE': return `no check-in for ${n('minutes') ?? 15} minutes`;
    case 'DISK_FREE': return `system disk under ${n('minFreePercent') ?? 10}% free${n('minFreeMb') ? ` or under ${Math.round((n('minFreeMb') as number) / 1024)} GB` : ''}`;
    case 'CPU_HIGH': return `processor above ${n('percent') ?? 95}% for ${n('samples') ?? 5} check-ins in a row`;
    case 'MEMORY_HIGH': return `memory above ${n('percent') ?? 95}% for ${n('samples') ?? 5} check-ins in a row`;
    case 'SERVICE_STOPPED': return `${String(p.service ?? '?')} not running${p.alertIfMissing ? ' or missing' : ''}`;
    case 'REBOOT_PENDING': return `a restart pending for over ${n('hours') ?? 72} hours`;
    case 'EVENT_MATCH': {
      const ids = Array.isArray(p.ids) && p.ids.length ? `event ID ${(p.ids as number[]).join(', ')}` : null;
      const levels = Array.isArray(p.levels) && p.levels.length ? (p.levels as number[]).map((l) => EVENT_LEVEL[l] ?? l).join(' / ') : null;
      const provider = typeof p.provider === 'string' ? `from ${p.provider}` : null;
      const threshold = n('threshold');
      return [`${String(p.log ?? '?')} log`, ids, levels, provider, threshold && threshold > 1 ? `${threshold} or more` : null].filter(Boolean).join(', ');
    }
    default: return '';
  }
}

export const SCOPE_LABEL = (k: string) =>
  k === 'global' ? 'all computers' : ({ b: 'this business', s: 'this site', e: 'this computer' } as Record<string, string>)[k[0]] ?? k;

export const CHANGE_LABEL: Record<string, string> = {
  hardware: 'Hardware', os: 'Windows', disk: 'Disk', network: 'Network', software: 'Software',
};
