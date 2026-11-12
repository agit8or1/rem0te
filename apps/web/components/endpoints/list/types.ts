/**
 * The device list's wire types — GET /endpoints/list (0.31). Mirrors
 * apps/api/src/endpoints/endpoint-list.service.ts.
 */

export type SortKey =
  | 'online' | 'name' | 'business' | 'site' | 'os' | 'lastSeen' | 'agent' | 'user'
  | 'cpu' | 'memory' | 'disk' | 'patches' | 'alerts' | 'health';

export interface DeviceFilters {
  search: string;
  businessId: string;
  siteId: string;
  online: '' | 'online' | 'offline';
  alerts: '' | 'any' | 'critical';
  restartPending: boolean;
  agent: '' | 'signed' | 'standard' | 'none';
  status: 'current' | 'archived' | 'all';
  /** A device group (0.33). */
  groupId: string;
  // 0.34 — also what a rule group's rule is made of.
  platform: '' | 'windows' | 'linux' | 'macos' | 'other';
  /** A substring of the OS name or version. */
  os: string;
  /** A tag, exactly. */
  tag: string;
  patches: '' | 'pending' | 'current' | 'unknown' | 'stale';
  /** RustDesk client version range, inclusive (dotted numbers). */
  rustdeskMin: string;
  rustdeskMax: string;
  /** Whole days, as typed. */
  notSeenDays: string;
  seenWithinDays: string;
}

export const EMPTY_FILTERS: DeviceFilters = {
  search: '', businessId: '', siteId: '', online: '', alerts: '', restartPending: false, agent: '', status: 'current', groupId: '',
  platform: '', os: '', tag: '', patches: '', rustdeskMin: '', rustdeskMax: '', notSeenDays: '', seenWithinDays: '',
};

/** The filters a rule group may use (0.34) — the server refuses any other in a rule. */
export const RULE_KEYS = [
  'siteId', 'online', 'alerts', 'restartPending', 'agent',
  'platform', 'os', 'tag', 'patches', 'rustdeskMin', 'rustdeskMax', 'notSeenDays', 'seenWithinDays',
] as const satisfies readonly (keyof DeviceFilters)[];
export type DeviceRule = Partial<Record<(typeof RULE_KEYS)[number], string | boolean>>;

export interface DeviceRow {
  id: string;
  name: string;
  hostname: string | null;
  platform: string | null;
  os: string | null;
  status: string;
  isOnline: boolean;
  lastSeenAt: string | null;
  deviceClass: string;
  accessMode: string;
  business: { id: string; name: string | null } | null;
  site: { id: string; name: string | null } | null;
  /** Every group the computer is in (0.34: any number of its business's groups), by name. A rule group's membership is computed now. */
  groups: { id: string; name: string; kind?: 'static' | 'rule' }[];
  agent: { type: 'signed' | 'standard' | 'none'; version: string | null; lastHeartbeatAt: string | null };
  loggedOnUser: string | null;
  resources: {
    sampledAt: string; stale: boolean;
    cpuPercent: number | null; memoryUsedPercent: number | null; memoryTotalMb: number | null;
    diskUsedPercent: number | null; diskFreeMb: number | null; diskTotalMb: number | null;
  } | null;
  patches: {
    source: 'signed_agent_scan' | 'standard_agent_scan' | 'none';
    checkedAt: string | null; stale: boolean | null;
    pendingCount: number | null; rebootPending: boolean | null;
  };
  /** null = this viewer may not see alerts for this device (monitoring:alerts). */
  alerts: { open: number; worst: 'CRITICAL' | 'WARNING' | 'INFO' | null } | null;
}

export interface DeviceListResponse {
  rows: DeviceRow[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
  sort: SortKey;
  dir: 'asc' | 'desc';
  alertsVisible: boolean;
  facets: {
    businesses: { id: string; name: string; count: number }[];
    sites: { id: string; name: string; businessId: string; count: number }[];
    groups: { id: string; name: string; businessId: string | null; count: number; kind?: 'static' | 'rule' }[];
  };
  generatedAt: string;
  thresholds: { liveStaleMs: number; patchStaleMs: number };
}

export type Density = 'comfortable' | 'compact';

/** A saved view (0.33) — GET /device-views. Only list parameters; opening one runs the list as the viewer. */
export interface SavedView {
  id: string;
  name: string;
  shared: boolean;
  business: { id: string; name: string | null } | null;
  filters: Partial<Record<keyof DeviceFilters, string | boolean>>;
  columns: string[];
  sort: SortKey;
  dir: 'asc' | 'desc';
  density: Density;
  mine: boolean;
  may: { edit: boolean };
}

export interface DeviceGroup {
  id: string;
  name: string;
  description: string | null;
  business: { id: string; name: string | null } | null;
  legacy: boolean;
  /** 0.34: a rule group's members are computed from `rule` on every read. */
  kind: 'static' | 'rule';
  rule?: DeviceRule;
  /** false when the stored rule no longer parses (it then matches nothing). */
  ruleReadable?: boolean;
  /** Members this viewer can see; null for a rule on alerts the viewer may not see. */
  members: number | null;
  may: { manage: boolean };
}

export type BulkAction = 'group.add' | 'group.remove' | 'inventory.refresh' | 'client.update';
export interface BulkResponse {
  action: BulkAction;
  requested: number;
  succeeded: number;
  refused: number;
  group?: { id: string; name: string };
  /** 0.34: the group acted on, and how many computers it resolved to when the request ran. */
  target?: { id: string; name: string; kind: 'static' | 'rule'; resolved: number };
  results: { endpointId: string; name?: string; ok: boolean; code?: string; reason?: string; unchanged?: boolean }[];
}
