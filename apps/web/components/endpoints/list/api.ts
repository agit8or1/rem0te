import { api } from '@/lib/api-client';
import { RULE_KEYS, type BulkAction, type BulkResponse, type DeviceFilters, type DeviceGroup, type DeviceListResponse, type DeviceRule, type SavedView, type SortKey } from './types';

/** The largest selection one bulk request may name (the server refuses more). */
export const BULK_MAX = 200;

/** Query-string form of the current view. Empty values are left out, never sent as "all". */
export function toParams(f: DeviceFilters, sort: SortKey, dir: 'asc' | 'desc', page?: number, pageSize?: number) {
  const p: Record<string, string> = { sort, dir };
  if (f.search.trim()) p.search = f.search.trim();
  if (f.businessId) p.businessId = f.businessId;
  if (f.siteId) p.siteId = f.siteId;
  if (f.online) p.online = f.online;
  if (f.alerts) p.alerts = f.alerts;
  if (f.restartPending) p.restartPending = 'true';
  if (f.agent) p.agent = f.agent;
  if (f.status !== 'current') p.status = f.status;
  if (f.groupId) p.groupId = f.groupId;
  for (const k of ['platform', 'os', 'tag', 'patches', 'rustdeskMin', 'rustdeskMax', 'notSeenDays', 'seenWithinDays'] as const) {
    if (f[k].trim()) p[k] = f[k].trim();
  }
  if (page) p.page = String(page);
  if (pageSize) p.pageSize = String(pageSize);
  return p;
}

/** A view's filters in the list's own shape (the server stored only list parameters). */
export function viewFilters(f: SavedView['filters']): DeviceFilters {
  const s = (k: keyof DeviceFilters) => (typeof f[k] === 'string' ? (f[k] as string) : '');
  return {
    search: s('search'), businessId: s('businessId'), siteId: s('siteId'), groupId: s('groupId'),
    online: (s('online') as DeviceFilters['online']) || '', alerts: (s('alerts') as DeviceFilters['alerts']) || '',
    restartPending: f.restartPending === true, agent: (s('agent') as DeviceFilters['agent']) || '',
    status: (s('status') as DeviceFilters['status']) || 'current',
    platform: (s('platform') as DeviceFilters['platform']) || '', os: s('os'), tag: s('tag'),
    patches: (s('patches') as DeviceFilters['patches']) || '',
    rustdeskMin: s('rustdeskMin'), rustdeskMax: s('rustdeskMax'), notSeenDays: s('notSeenDays'), seenWithinDays: s('seenWithinDays'),
  };
}

/** The part of the current filters a rule group can hold, and the set filters it cannot (0.34). */
export function ruleFromFilters(f: DeviceFilters): { rule: DeviceRule; left: string[] } {
  const stored = storedFilters(f);
  const rule: DeviceRule = {};
  const left: string[] = [];
  for (const [k, v] of Object.entries(stored)) {
    if ((RULE_KEYS as readonly string[]).includes(k)) rule[k as keyof DeviceRule] = v;
    else left.push(k);
  }
  return { rule, left };
}

const PLATFORM_LABEL: Record<string, string> = { windows: 'Windows', linux: 'Linux', macos: 'macOS', other: 'other OS' };
const PATCH_LABEL: Record<string, string> = { pending: 'updates pending', current: 'no updates pending', unknown: 'never scanned for updates', stale: 'update scan stale' };

/** A rule in words, for the groups dialog and the save dialog. Site names come from the caller. */
export function describeRule(r: DeviceRule, siteName?: (id: string) => string | undefined): string {
  const out: string[] = [];
  if (r.online) out.push(r.online === 'online' ? 'online' : 'offline');
  if (r.platform) out.push(PLATFORM_LABEL[String(r.platform)] ?? String(r.platform));
  if (r.os) out.push(`OS contains “${r.os}”`);
  if (r.siteId) out.push(`site ${siteName?.(String(r.siteId)) ?? '(a site)'}`);
  if (r.tag) out.push(`tagged “${r.tag}”`);
  if (r.agent) out.push(r.agent === 'signed' ? 'signed agent' : r.agent === 'standard' ? 'standard agent' : 'no agent report');
  if (r.patches) out.push(PATCH_LABEL[String(r.patches)] ?? String(r.patches));
  if (r.restartPending) out.push('restart pending');
  if (r.alerts) out.push(r.alerts === 'critical' ? 'critical alerts open' : 'alerts open');
  if (r.rustdeskMin && r.rustdeskMax) out.push(`RustDesk ${r.rustdeskMin}–${r.rustdeskMax}`);
  else if (r.rustdeskMin) out.push(`RustDesk ≥ ${r.rustdeskMin}`);
  else if (r.rustdeskMax) out.push(`RustDesk ≤ ${r.rustdeskMax}`);
  if (r.notSeenDays) out.push(`not seen for ${r.notSeenDays}+ day${r.notSeenDays === '1' ? '' : 's'}`);
  if (r.seenWithinDays) out.push(`seen in the last ${r.seenWithinDays} day${r.seenWithinDays === '1' ? '' : 's'}`);
  return out.length ? out.join(' · ') : 'no conditions';
}

/** The current filters as a view stores them: set values only. */
export function storedFilters(f: DeviceFilters): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const [k, v] of Object.entries(f)) {
    if (k === 'status' ? v !== 'current' : !!v) out[k] = typeof v === 'string' ? v.trim() : v;
  }
  return out;
}

async function blobDownload(r: { data: unknown; headers: Record<string, unknown> }) {
  const cd = String(r.headers['content-disposition'] ?? '');
  const name = /filename="([^"]+)"/.exec(cd)?.[1] ?? 'devices.csv';
  return { blob: r.data as Blob, filename: name, rows: Number(r.headers['x-rows'] ?? 0), notExported: Number(r.headers['x-not-exported'] ?? 0) };
}

export const deviceViewsApi = {
  list: () => api.get('/device-views').then((r) => r.data?.data as { views: SavedView[]; may: { share: boolean } }),
  create: (body: { name: string; filters: Record<string, string | boolean>; columns: string[]; sort: SortKey; dir: 'asc' | 'desc'; density: string; shared: boolean; businessId?: string }) =>
    api.post('/device-views', body).then((r) => r.data?.data as SavedView),
  update: (id: string, body: Partial<{ name: string; filters: Record<string, string | boolean>; columns: string[]; sort: SortKey; dir: 'asc' | 'desc'; density: string }>) =>
    api.patch(`/device-views/${id}`, body).then((r) => r.data?.data as SavedView),
  remove: (id: string) => api.delete(`/device-views/${id}`),
};

export const deviceGroupsApi = {
  list: (businessId?: string) =>
    api.get('/device-groups', { params: businessId ? { businessId } : {} }).then((r) => r.data?.data as { groups: DeviceGroup[]; may: { manage: boolean; reason: string | null } }),
  create: (body: { name: string; description?: string; businessId?: string; kind?: 'static' | 'rule'; rule?: DeviceRule }) => api.post('/device-groups', body).then((r) => r.data?.data),
  update: (id: string, body: { name?: string; description?: string | null; rule?: DeviceRule }) => api.patch(`/device-groups/${id}`, body).then((r) => r.data?.data),
  remove: (id: string) => api.delete(`/device-groups/${id}`).then((r) => r.data?.data as { membersReleased: number }),
};

export const bulkApi = {
  run: (action: BulkAction, endpointIds: string[], groupId?: string) =>
    api.post('/endpoints/bulk', { action, endpointIds, ...(groupId ? { groupId } : {}) }).then((r) => r.data?.data as BulkResponse),
  /** 0.34: act on a group's members, resolved by the server when the request runs (a rule group's rule is evaluated then). */
  runOnGroup: (action: BulkAction, targetGroupId: string, groupId?: string) =>
    api.post('/endpoints/bulk', { action, targetGroupId, ...(groupId ? { groupId } : {}) }).then((r) => r.data?.data as BulkResponse),
  /** The selection as CSV, through the audited device-list export. */
  exportCsv: async (endpointIds: string[], sort: SortKey, dir: 'asc' | 'desc') =>
    blobDownload(await api.post('/endpoints/bulk/export.csv', { endpointIds, sort, dir }, { responseType: 'blob' })),
};

export const deviceListApi = {
  list: (params: Record<string, string>) =>
    api.get('/endpoints/list', { params }).then((r) => r.data?.data as DeviceListResponse),

  /**
   * The CSV of the current filtered view, as a blob, so a refusal (403, or
   * EXPORT_TOO_LARGE) can be shown as a message instead of navigating the
   * browser to a JSON error page. The server audits every export.
   */
  exportCsv: async (params: Record<string, string>) => {
    const { page: _p, pageSize: _s, ...rest } = params;
    const r = await api.get('/endpoints/list/export.csv', { params: rest, responseType: 'blob' });
    const cd = String(r.headers['content-disposition'] ?? '');
    const name = /filename="([^"]+)"/.exec(cd)?.[1] ?? 'devices.csv';
    return { blob: r.data as Blob, filename: name, rows: Number(r.headers['x-rows'] ?? 0) };
  },
};

/** The message an API refusal carries — also when the body arrived as a Blob. */
export async function refusalMessage(e: unknown, fallback: string): Promise<string> {
  const data = (e as { response?: { data?: unknown } })?.response?.data;
  try {
    const body = data instanceof Blob ? JSON.parse(await data.text()) : data;
    const m = (body as { message?: unknown })?.message;
    if (typeof m === 'string') return m;
    if (m && typeof (m as { message?: unknown }).message === 'string') return (m as { message: string }).message;
  } catch { /* not JSON */ }
  return fallback;
}
