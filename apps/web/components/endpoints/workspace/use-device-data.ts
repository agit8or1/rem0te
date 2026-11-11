'use client';

import { useQuery } from '@tanstack/react-query';
import { actionsApi, endpointsApi, monitoringApi, patchingApi } from '@/lib/api-client';
import type { AlertRow } from '@/components/monitoring/alerts';
import type { InventoryPayload } from '@/components/endpoints/endpoint-specs';
import type { Patches } from '@/components/endpoints/endpoint-patches';

/**
 * The reads the workspace header and Overview are built from. Every one is an
 * existing route, and every key is the one its tab already uses
 * (['mon-endpoint'], ['endpoint-patches'], ['endpoint-inventory'],
 * ['actions-catalog']), so opening a tab after the header loaded reuses the
 * cached answer instead of asking again, and an alert acknowledged on the
 * Monitoring tab updates the header too.
 */

/** GET /monitoring/endpoints/:id — monitoring-admin.service.ts endpointView(). */
export interface MonitoringView {
  scopes: string[];
  rules: { key: string; kind: string; name: string; severity: string; params: Record<string, unknown>; inheritedFrom: string; overrides: string[]; id: string }[];
  report: {
    services?: { name: string; status: string; startType: string | null }[];
    events?: { key: string; checkedAt: string; count: number; newestAt: string | null; sample: { eventId: number | null; message: string | null } | null }[];
  } | null;
  reportedAt: string | null;
  /** null when the viewer lacks monitoring:alerts. */
  alerts: AlertRow[] | null;
  changes: { id: string; category: string; change: string; subject: string; before: string | null; after: string | null; detectedAt: string }[];
  software: { name: string; version: string | null; publisher: string | null; installedOn: string | null }[] | null;
  softwareCount: number | null;
  inventoryAt: string | null;
}

export interface ActionCatalog {
  configured: boolean;
  actions: { id: string; version: number; title: string; direct?: boolean }[];
}

export function useMonitoringView(endpointId: string, enabled = true) {
  return useQuery<MonitoringView>({
    queryKey: ['mon-endpoint', endpointId],
    queryFn: () => monitoringApi.endpoint(endpointId).then((r) => r.data.data),
    retry: false,
    enabled,
  });
}

export function usePatchStatus(endpointId: string, enabled = true) {
  return useQuery<Patches>({
    queryKey: ['endpoint-patches', endpointId],
    queryFn: () => patchingApi.endpoint(endpointId).then((r) => r.data.data as Patches),
    retry: false,
    enabled,
  });
}

export function useInventory(endpointId: string, enabled = true) {
  return useQuery<InventoryPayload>({
    queryKey: ['endpoint-inventory', endpointId],
    queryFn: () => endpointsApi.inventory(endpointId).then((r) => r.data?.data as InventoryPayload),
    // Same cadence as the Overview's specs, which share this key.
    refetchInterval: 30_000,
    retry: false,
    enabled,
  });
}

export function useActionCatalog(enabled = true) {
  return useQuery<ActionCatalog>({
    queryKey: ['actions-catalog'],
    queryFn: () => actionsApi.catalog().then((r) => r.data.data as ActionCatalog),
    retry: false,
    enabled,
  });
}

/**
 * The catalog actions a computer page can request: those marked direct
 * (updates go through a deployment). 0.32 adds the maintenance actions.
 */
export const directActions = (catalog: ActionCatalog | undefined) => (catalog?.actions ?? []).filter((a) => a.direct);

/** The actions this computer's agent says it can run, as id@version. */
export const agentActionKeys = (ep: Record<string, unknown>) => (Array.isArray(ep.agentActions) ? (ep.agentActions as string[]) : []);

/**
 * Why RUN ACTION cannot work for this computer, or null. Mirrors the first
 * checks of ActionsService.readiness() with what this page can see; the
 * server still decides, and says why, when a request is made. RUN ACTION is
 * available when the agent reports at least one direct action; the Actions
 * tab says, per action, which ones it does not.
 */
export function actionUnavailableReason(ep: Record<string, unknown>, catalog: ActionCatalog | undefined, catalogError: boolean): string | null {
  if (catalogError) return 'Could not read the action catalog.';
  if (!catalog) return 'Checking…';
  if (!catalog.configured) return 'No approval signer is configured on this server, so no action can be approved.';
  if (ep.status === 'ARCHIVED') return 'This computer is archived.';
  if (ep.updateChannel !== 'signed') return 'This computer runs the standard agent. Approved actions need the signed agent.';
  const direct = directActions(catalog);
  if (!direct.length) return 'This server offers no action that can be requested for one computer.';
  const agent = agentActionKeys(ep);
  if (!direct.some((a) => agent.includes(`${a.id}@${a.version}`))) return 'This computer’s agent does not report support for any catalog action yet. Let it update first.';
  return null;
}
