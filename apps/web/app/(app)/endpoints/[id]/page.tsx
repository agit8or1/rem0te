'use client';

import { EndpointDiagnosticsCatalog } from '@/components/endpoints/endpoint-diagnostics-catalog';
import { useState, useEffect, useCallback, useRef } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { endpointsApi, offboardingApi } from '@/lib/api-client';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EndpointEventLog } from '@/components/endpoints/endpoint-event-log';
import { EndpointActions } from '@/components/endpoints/endpoint-actions';
import { EndpointPatches } from '@/components/endpoints/endpoint-patches';
import { EndpointUpdateHistory } from '@/components/rollouts/endpoint-update-history';
import { TemporaryAccessCard } from '@/components/security-controls/temporary-access-card';
import { DeviceHeader } from '@/components/endpoints/workspace/device-header';
import { DeviceActions } from '@/components/endpoints/workspace/device-actions';
import { DeviceOverviewTab } from '@/components/endpoints/workspace/overview-tab';
import { DeviceMonitoringTab } from '@/components/endpoints/workspace/monitoring-tab';
import { DevicePerformanceTab } from '@/components/endpoints/workspace/performance-tab';
import { DeviceSoftwareTab } from '@/components/endpoints/workspace/software-tab';
import { DeviceNetworkTab, DeviceProcessesTab, DeviceServicesTab } from '@/components/endpoints/workspace/snapshot-tabs';
import { DeviceHistoryTab, type SessionRow } from '@/components/endpoints/workspace/history-tab';
import { DiagnosticsPanel } from '@/components/endpoints/workspace/diagnostics-panel';
import type { AccessReview } from '@/components/endpoints/workspace/access-review-panel';
import { acceptsQueuedWork, agentType, parseTab, reportsInventory, reportsWindowsDetail, TAB_LABEL, type WorkspaceTab } from '@/components/endpoints/workspace/device-model';
import {
  actionUnavailableReason, agentActionKeys, useActionCatalog, useInventory, useMonitoringView, usePatchStatus,
} from '@/components/endpoints/workspace/use-device-data';
import { usePermissions, CAP } from '@/lib/auth';
import { useToast } from '@/hooks/use-toast';

/**
 * The device workspace (0.31): one page for one computer.
 *
 * Header: name, status, business, site, last seen, and an attention strip
 * (open alerts, restart pending, pending updates, agent type) built from reads
 * the tabs already make. Primary actions: Connect, Diagnose, Run action,
 * Patch, and More for archive and the other rare things. Tabs, each
 * deep-linkable with `?tab=`: Overview · Performance · Monitoring · Software ·
 * Processes · Services · Network · Patches · Event logs · Diagnostics · Actions · History.
 *
 * Processes, Services and Network (0.33) are read-only snapshots from the
 * standard Windows agent, requested through the diagnostics catalog and shown
 * with their age; they have no buttons that act on the computer.
 */
export default function EndpointDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { toast } = useToast();
  const { can, isPlatformAdmin, technician } = usePermissions();
  const canView = can(CAP.COMPUTERS_VIEW);
  const canEventLogs = can(CAP.COMPUTERS_EVENT_LOGS);

  const [tab, setTabState] = useState<WorkspaceTab>('overview');
  const tabsRef = useRef<HTMLDivElement>(null);
  // ?tab= opens that tab (alert links, bookmarks and the docs screenshots use
  // it); old values from before the regrouping map to where their content went.
  useEffect(() => {
    const t = parseTab(new URLSearchParams(window.location.search).get('tab'));
    if (t) setTabState(t);
  }, []);
  const setTab = useCallback((t: WorkspaceTab) => {
    setTabState(t);
    const url = new URL(window.location.href);
    if (t === 'overview') url.searchParams.delete('tab'); else url.searchParams.set('tab', t);
    window.history.replaceState(window.history.state, '', url);
    // From a link further down the Overview, bring the tab into view.
    tabsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, []);

  const { data: endpoint, isLoading } = useQuery({
    queryKey: ['endpoint', id],
    queryFn: () => endpointsApi.get(id).then((r) => r.data?.data),
  });

  // Header and Overview reads — the same queries (and keys) the tabs use.
  const mon = useMonitoringView(id, canView);
  const patches = usePatchStatus(id, canView);
  const inventory = useInventory(id, canView);
  const catalog = useActionCatalog(canView);

  // Access review lists people, so it needs users:view as well. A 403 (or any
  // error) leaves it out of History rather than showing an error there.
  const canReview = can(CAP.USERS_VIEW);
  const { data: review, isError: reviewError } = useQuery<AccessReview>({
    queryKey: ['access-review', id],
    queryFn: () => offboardingApi.accessReview(id).then((r) => r.data?.data),
    enabled: canReview,
    retry: false,
  });

  // One click: POST :id/connect (step-up when the launch carries the
  // computer's password), then the Connect script, which carries it.
  // v0.23: a refusal that a temporary grant would lift opens the request form.
  const [grantRequired, setGrantRequired] = useState<string | null>(null);
  const launchMutation = useMutation({
    mutationFn: (mode?: 'view_only') => endpointsApi.connect(id, mode),
    onSuccess: async (res, mode) => {
      setGrantRequired(null);
      const info = res.data?.data as {
        rustdeskId?: string; hasPassword?: boolean; sessionId?: string | null;
        mode?: string; accessPath?: string; maxSessionMinutes?: number | null;
      } | undefined;
      const rdId = info?.rustdeskId;
      if (!rdId) {
        toast({ title: 'Computer not ready', description: 'This computer has not finished enrollment.', variant: 'destructive' });
        return;
      }
      // The browser never receives the password (0.30.1): the Connect script
      // carries it, released after the step-up POST :id/connect just asked for.
      const pw = info?.hasPassword === true;
      // A preset-backed launch never releases the permanent password. The
      // shipped endpoint configuration accepts only that password
      // (verification-method = use-permanent-password), so nothing will prompt
      // at the computer — say what is actually true. The session-length limit
      // is policy text: nothing on the endpoint ends the session.
      if (!pw || info?.maxSessionMinutes) {
        toast({
          title: info?.mode === 'view_only' ? 'Starting a view-only session' : 'Starting the session',
          description: [
            !pw ? 'No password is released for this launch. A computer installed by Rem0te accepts only its permanent password, so RustDesk may not be able to sign in.' : null,
            info?.maxSessionMinutes ? `Policy limit: ${info.maxSessionMinutes} minutes. Nothing on the computer enforces it — end the session when the time is up.` : null,
          ].filter(Boolean).join(' '),
        });
      }
      // See my-computers/page.tsx: a bare rustdesk:// link cannot carry the
      // server address, so it only works on a client that already knows this
      // server. The script installs RustDesk if needed, configures it, then
      // connects — and deletes itself afterwards. POST :id/connect already
      // recorded the session; `?session=` makes the script reuse it rather
      // than create a second one.
      const q = new URLSearchParams();
      if (info?.sessionId) q.set('session', info.sessionId);
      if (mode) q.set('mode', mode);
      const url = endpointsApi.connectScriptUrl(id);
      const qs = q.toString();
      window.location.href = qs ? `${url}?${qs}` : url;
    },
    // A 403 from connect carries { code, message } written to be read as it
    // is — protected device class, a view-only launch the endpoint cannot
    // enforce, a paused identity — so show it verbatim.
    onError: (e: unknown) => {
      const r = (e as { response?: { status?: number; data?: { code?: string } } })?.response;
      if (r?.status === 403 && r.data?.code === 'TEMPORARY_GRANT_REQUIRED') {
        setGrantRequired(apiMessage(e, 'Interactive control needs a temporary grant.'));
        return;
      }
      toast({
        title: r?.status === 403 ? 'Connection refused' : 'Error',
        description: apiMessage(e, 'Failed to start connection'),
        variant: 'destructive',
      });
    },
  });

  if (isLoading) return <div className="p-6 text-muted-foreground text-sm">Loading…</div>;
  if (!endpoint) return <div className="p-6 text-muted-foreground text-sm">Not found</div>;

  const ep = endpoint as Record<string, unknown>;
  const agent = agentType(ep);
  const windowsDetail = reportsWindowsDetail(agent);
  const isOnline = !!(ep.isOnline as boolean);
  const actionReason = canView ? actionUnavailableReason(ep, catalog.data, catalog.isError) : null;
  const sessions = (ep.supportSessions as SessionRow[] | undefined) ?? [];
  const showReview = canReview && !reviewError && !!review;

  // Only tabs with something real behind them. Software and Event logs come
  // from the Windows agents; the Linux agent reports inventory and pending
  // updates (Overview, Patches), and macOS has RustDesk only.
  const tabs: WorkspaceTab[] = [
    'overview',
    // Metric history (0.33): from the heartbeat, so any agent that reports — not RustDesk only.
    ...(canView && reportsInventory(agent) ? (['performance'] as const) : []),
    ...(canView ? (['monitoring'] as const) : []),
    ...(canView && windowsDetail ? (['software', 'processes', 'services', 'network'] as const) : []),
    ...(canView ? (['patches'] as const) : []),
    ...(canEventLogs && windowsDetail ? (['events'] as const) : []),
    ...(canView ? (['diagnostics', 'actions'] as const) : []),
    'history',
  ];
  const active: WorkspaceTab = tabs.includes(tab) ? tab : 'overview';

  return (
    <div className="p-4 sm:p-6 space-y-5">
      <DeviceHeader
        ep={ep}
        mon={{ data: mon.data, isError: mon.isError }}
        patches={{ data: patches.data, isError: patches.isError }}
        inventory={inventory.data}
        onOpenTab={setTab}
        actions={
          <DeviceActions
            endpointId={id}
            ep={ep}
            onConnect={() => launchMutation.mutate(undefined)}
            onViewOnly={() => launchMutation.mutate('view_only')}
            connecting={launchMutation.isPending}
            onOpenTab={setTab}
            perms={{ view: canView, edit: can(CAP.COMPUTERS_EDIT), remove: can(CAP.COMPUTERS_REMOVE), technician: !!technician }}
            actionReason={actionReason}
            reportsInventory={acceptsQueuedWork(agent)}
          />
        }
      />

      <TemporaryAccessCard
        endpointId={id}
        refusal={grantRequired}
        onDismiss={() => setGrantRequired(null)}
        onConnect={() => launchMutation.mutate(undefined)}
      />

      <Tabs value={active} onValueChange={(v) => setTab(v as WorkspaceTab)}>
        {/* Scrolls sideways on a narrow window rather than wrapping into a
            second row that reads as a different set of tabs. Tabs are left out
            without the capability as a courtesy — every route re-checks. */}
        <div ref={tabsRef} className="-mx-1 overflow-x-auto px-1 pb-1 scroll-mt-4">
          <TabsList className="w-max" data-testid="workspace-tabs">
            {tabs.map((t) => (
              <TabsTrigger key={t} value={t} data-testid={`tab-${t}`}>{TAB_LABEL[t]}</TabsTrigger>
            ))}
          </TabsList>
        </div>

        <TabsContent value="overview" className="mt-4">
          <DeviceOverviewTab
            endpointId={id}
            ep={ep}
            mon={mon.data}
            patches={patches.data}
            sessions={sessions}
            onOpenTab={setTab}
            showAlertsAndPatches={canView}
            // Staged-update history (Platform Admin only, like rollouts).
            adminExtras={isPlatformAdmin ? <EndpointUpdateHistory endpointId={id} /> : undefined}
          />
        </TabsContent>

        {tabs.includes('performance') && (
          <TabsContent value="performance" className="mt-4">
            {active === 'performance' && <DevicePerformanceTab endpointId={id} onOpenTab={setTab} />}
          </TabsContent>
        )}

        {tabs.includes('monitoring') && (
          <TabsContent value="monitoring" className="mt-4">
            {active === 'monitoring' && <DeviceMonitoringTab endpointId={id} />}
          </TabsContent>
        )}

        {tabs.includes('software') && (
          <TabsContent value="software" className="mt-4">
            {active === 'software' && <DeviceSoftwareTab endpointId={id} />}
          </TabsContent>
        )}

        {tabs.includes('processes') && (
          <TabsContent value="processes" className="mt-4">
            {active === 'processes' && <DeviceProcessesTab endpointId={id} />}
          </TabsContent>
        )}

        {tabs.includes('services') && (
          <TabsContent value="services" className="mt-4">
            {active === 'services' && <DeviceServicesTab endpointId={id} />}
          </TabsContent>
        )}

        {tabs.includes('network') && (
          <TabsContent value="network" className="mt-4">
            {active === 'network' && <DeviceNetworkTab endpointId={id} />}
          </TabsContent>
        )}

        {tabs.includes('patches') && (
          <TabsContent value="patches" className="mt-4">
            {active === 'patches' && <EndpointPatches endpointId={id} />}
          </TabsContent>
        )}

        {tabs.includes('events') && (
          <TabsContent value="events" className="mt-4">
            <EndpointEventLog endpointId={id} isOnline={isOnline} />
          </TabsContent>
        )}

        {tabs.includes('diagnostics') && (
          <TabsContent value="diagnostics" className="mt-4 space-y-4">
            {/* Mounted only while selected: Test connection probes the server
                and is audited, so it should not run just because the page
                opened. The catalog runs nothing until a check is clicked. */}
            {active === 'diagnostics' && (
              <>
                <EndpointDiagnosticsCatalog endpointId={id} />
                <DiagnosticsPanel endpointId={id} canConnect={can(CAP.COMPUTERS_CONNECT)} />
              </>
            )}
          </TabsContent>
        )}

        {tabs.includes('actions') && (
          <TabsContent value="actions" className="mt-4">
            {active === 'actions' && <EndpointActions endpointId={id} isOnline={isOnline} unavailableReason={actionReason === 'Checking…' ? null : actionReason} agentActions={agentActionKeys(ep)} />}
          </TabsContent>
        )}

        <TabsContent value="history" className="mt-4">
          {active === 'history' && (
            <DeviceHistoryTab
              endpointId={id}
              sessions={sessions}
              aiTimeline={(ep.aiTimeline as string | null | undefined) ?? null}
              review={showReview && review ? review : null}
            />
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function apiMessage(e: unknown, fallback: string) {
  return (e as { response?: { data?: { message?: string | string[] } } })?.response?.data?.message?.toString() ?? fallback;
}
