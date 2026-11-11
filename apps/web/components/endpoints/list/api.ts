import { api } from '@/lib/api-client';
import type { DeviceFilters, DeviceListResponse, SortKey } from './types';

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
  if (page) p.page = String(page);
  if (pageSize) p.pageSize = String(pageSize);
  return p;
}

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
