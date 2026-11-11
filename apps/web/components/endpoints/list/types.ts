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
}

export const EMPTY_FILTERS: DeviceFilters = {
  search: '', businessId: '', siteId: '', online: '', alerts: '', restartPending: false, agent: '', status: 'current',
};

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
  };
  generatedAt: string;
  thresholds: { liveStaleMs: number; patchStaleMs: number };
}

export type Density = 'comfortable' | 'compact';
