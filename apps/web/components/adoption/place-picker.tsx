'use client';

import { useQuery } from '@tanstack/react-query';
import { businessesApi, sitesApi } from '@/lib/api-client';
import { deviceGroupsApi } from '@/components/endpoints/list/api';

/**
 * Business, site and (optionally) static groups, for adopting computers and
 * for deployment keys (0.57). Platform Admin pages only: the lists are the
 * whole platform's businesses.
 */
export interface Place { businessId: string; siteId: string; groupIds: string[] }
export const EMPTY_PLACE: Place = { businessId: '', siteId: '', groupIds: [] };

export const selectClass = 'h-9 w-full rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50';

export function useBusinesses() {
  return useQuery({
    queryKey: ['businesses', ''],
    queryFn: () => businessesApi.list().then((r) => ((r.data as { data?: { id: string; name: string; isArchived?: boolean }[] })?.data ?? [])),
  });
}

export function PlacePicker({ value, onChange, groups = 'many', idPrefix = 'place' }: {
  value: Place; onChange: (p: Place) => void; groups?: 'many' | 'one' | 'none'; idPrefix?: string;
}) {
  const { data: businesses = [] } = useBusinesses();
  const { data: sites = [] } = useQuery({
    queryKey: ['sites', value.businessId],
    queryFn: () => sitesApi.list(value.businessId).then((r) => ((r.data as { data?: { id: string; name: string; isActive?: boolean }[] })?.data ?? [])),
    enabled: !!value.businessId,
  });
  const { data: groupData } = useQuery({
    queryKey: ['device-groups', value.businessId],
    queryFn: () => deviceGroupsApi.list(value.businessId),
    enabled: !!value.businessId && groups !== 'none',
  });
  // Only static groups: a rule group's members are whatever matches its rule.
  const staticGroups = (groupData?.groups ?? []).filter((g) => g.kind === 'static' && (g.business?.id === value.businessId || !g.business));

  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <label className="space-y-1 text-xs font-medium" htmlFor={`${idPrefix}-business`}>
        <span>Business</span>
        <select id={`${idPrefix}-business`} className={selectClass} value={value.businessId}
          onChange={(e) => onChange({ businessId: e.target.value, siteId: '', groupIds: [] })}>
          <option value="">Choose a business…</option>
          {businesses.filter((b) => !b.isArchived).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      </label>
      <label className="space-y-1 text-xs font-medium" htmlFor={`${idPrefix}-site`}>
        <span>Site <span className="font-normal text-muted-foreground">(optional)</span></span>
        <select id={`${idPrefix}-site`} className={selectClass} value={value.siteId} disabled={!value.businessId}
          onChange={(e) => onChange({ ...value, siteId: e.target.value })}>
          <option value="">No site</option>
          {sites.filter((s) => s.isActive !== false).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </label>
      {groups !== 'none' && (
        <label className="space-y-1 text-xs font-medium" htmlFor={`${idPrefix}-groups`}>
          <span>{groups === 'many' ? 'Groups' : 'Group'} <span className="font-normal text-muted-foreground">(optional, static only)</span></span>
          {groups === 'one' ? (
            <select id={`${idPrefix}-groups`} className={selectClass} value={value.groupIds[0] ?? ''} disabled={!value.businessId}
              onChange={(e) => onChange({ ...value, groupIds: e.target.value ? [e.target.value] : [] })}>
              <option value="">No group</option>
              {staticGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          ) : (
            <select id={`${idPrefix}-groups`} multiple className={`${selectClass} h-20`} value={value.groupIds} disabled={!value.businessId}
              onChange={(e) => onChange({ ...value, groupIds: Array.from(e.target.selectedOptions).map((o) => o.value).slice(0, 10) })}>
              {staticGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          )}
        </label>
      )}
    </div>
  );
}

/** The message an API error carries, for a toast. */
export function errText(e: unknown): string | undefined {
  const d = (e as { response?: { data?: { message?: unknown } } })?.response?.data;
  const m = d?.message;
  if (typeof m === 'string') return m;
  if (Array.isArray(m)) return m.join('; ');
  return undefined;
}
