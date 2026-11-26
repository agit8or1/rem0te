/**
 * The device list's built-in views (0.89, UX P1-3; directive §9's "useful
 * default views").
 *
 * Each one is a set of the list's own filters, nothing more: opening it sets
 * those filters, the server scopes and answers exactly as for the same
 * filters typed by hand, and nothing is stored. A view the server cannot
 * answer from what it holds is not offered at all — it is listed in
 * NOT_OFFERED with the reason, rather than approximated.
 *
 * Pure: no imports. The filter names and values are the API's
 * (endpoints/list-query.ts); unit-device-list-views.mjs checks every one
 * against that file.
 */

export type BuiltinFilters = Partial<{
  online: 'online' | 'silent' | 'offline';
  alerts: 'any' | 'critical';
  restartPending: boolean;
  agent: 'signed' | 'standard' | 'none' | 'outdated';
  platform: 'windows' | 'linux' | 'macos' | 'other';
  patches: 'pending' | 'current' | 'unknown' | 'stale' | 'critical';
  warranty: 'expired' | 'd30' | 'd60' | 'd90' | 'active' | 'unknown';
  windowsRole: 'server' | 'workstation';
  mine: 'favorite' | 'recent';
}>;

export interface BuiltinView {
  id: string;
  label: string;
  /** What it shows, in one sentence, including what it cannot see. */
  description: string;
  filters: BuiltinFilters;
  /** Needs monitoring:alerts — not offered without it (the server would refuse the filter). */
  needsAlerts?: boolean;
}

export const BUILTIN_VIEWS: readonly BuiltinView[] = [
  { id: 'favorites', label: 'My favourites', description: 'Devices you starred. Only you see your favourites.', filters: { mine: 'favorite' } },
  { id: 'recent', label: 'Recently opened', description: 'The devices you opened last, up to 15.', filters: { mine: 'recent' } },
  { id: 'critical', label: 'Critical alerts', description: 'Devices with an open critical alert.', filters: { alerts: 'critical' }, needsAlerts: true },
  { id: 'offline', label: 'Offline', description: 'Devices neither the agent nor RustDesk can reach.', filters: { online: 'offline' } },
  {
    id: 'windows-servers', label: 'Windows servers',
    description: 'Windows devices whose reported OS name says Server. A device that reports no edition (only “Windows NT 10.0…”, or nothing) is in neither Windows view.',
    filters: { platform: 'windows', windowsRole: 'server' },
  },
  {
    id: 'windows-workstations', label: 'Windows workstations',
    description: 'Windows devices whose reported OS name is a Windows edition other than Server. A device that reports no edition (only “Windows NT 10.0…”, or nothing) is in neither Windows view.',
    filters: { platform: 'windows', windowsRole: 'workstation' },
  },
  { id: 'linux', label: 'Linux', description: 'Devices reporting Linux.', filters: { platform: 'linux' } },
  { id: 'macos', label: 'macOS', description: 'Devices reporting macOS.', filters: { platform: 'macos' } },
  { id: 'restart', label: 'Restart pending', description: 'Devices whose last report says a restart is needed.', filters: { restartPending: true } },
  {
    id: 'critical-updates', label: 'Security or critical updates pending',
    description: 'From a signed agent’s update scan, which records each update’s classification. A standard agent’s scan does not, so its devices are not in this view; see “Updates pending” under More filters.',
    filters: { patches: 'critical' },
  },
  { id: 'agent-outdated', label: 'Agent needs an update', description: 'Agents older than the one this server hands out.', filters: { agent: 'outdated' } },
  { id: 'warranty', label: 'Warranty ending', description: 'Hardware warranty ends within 90 days (devices with a stored date only).', filters: { warranty: 'd90' } },
];

/** Directive §9 views the list cannot answer yet, and why. Shown in the menu as text, never as a view. */
export const NOT_OFFERED: readonly { label: string; why: string }[] = [
  { label: 'Failed automation', why: 'task results are on the Tasks page; the list does not read them yet' },
  { label: 'Aging hardware', why: 'no purchase or manufacture date is collected' },
  { label: 'Backup failures', why: 'backup results are on the Backups page; the list does not read them yet' },
];

/** The keys a built-in view may set. Opening one clears the others (customer aside). */
export const BUILTIN_KEYS = ['online', 'alerts', 'restartPending', 'agent', 'platform', 'patches', 'warranty', 'windowsRole', 'mine'] as const;

/**
 * The built-in view the current filters are exactly, if any: its keys set to
 * its values and every other filter empty, except customer and site, which
 * narrow any view.
 */
export function matchBuiltin(f: object): BuiltinView | null {
  const ignore = new Set(['businessId', 'siteId', 'status']);
  for (const v of BUILTIN_VIEWS) {
    const want = v.filters as Record<string, unknown>;
    const ok = Object.entries(f as Record<string, unknown>).every(([k, x]) => {
      if (ignore.has(k)) return k !== 'status' || x === 'current';
      return k in want ? want[k] === x : x === '' || x === false;
    });
    if (ok) return v;
  }
  return null;
}
