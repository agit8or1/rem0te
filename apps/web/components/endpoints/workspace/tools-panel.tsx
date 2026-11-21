'use client';

import { useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Activity, AlertTriangle, Ban, Clock, Hourglass, Loader2, Lock, PauseCircle, ShieldCheck, ShieldQuestion, Sparkles, WifiOff, Wrench,
} from 'lucide-react';
import { actionsApi, api, containmentApi } from '@/lib/api-client';
import { connectivityFrom, connectivityLabel } from '@/lib/connectivity';
import { useCurrentUser } from '@/lib/auth';
import {
  STATE_LABEL, TOOL_GROUPS, deviceTools, mayRequestActions, noteLine, opens, toolsIn, type ActionNote, type ToolFacts, type ToolState, type ToolTarget, type ToolView,
} from '@/lib/device-tools';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { agentType, ago } from './device-model';
import type { Patches } from '@/components/endpoints/endpoint-patches';

/**
 * Tools (0.75): one panel on the device page that lists what can be done to
 * this computer, grouped, and opens the existing flow for each — the
 * Diagnostics, Actions, Services, Processes, Network, Software, Patches,
 * Event logs and (0.77) Terminal tabs, or the script library. It adds no route and no action, and
 * runs nothing itself: picking a tool opens its tab (with the action, check
 * or log chosen), where the existing confirm dialog and route decide.
 *
 * Every state and reason comes from lib/device-tools.ts, which is pure and
 * unit-tested. Its reads are the ones those tabs already make, under the
 * same query keys, and only while the panel is open: the action catalog
 * with this computer's approval mode, the diagnostics catalog, and the
 * containment banner the shell already reads. It never asks a Managed Secure
 * Access route.
 */

const STATE_STYLE: Record<ToolState, { cls: string; Icon: typeof Activity }> = {
  available: { cls: 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200', Icon: Activity },
  needs_approval: { cls: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200', Icon: ShieldCheck },
  needs_newer_agent: { cls: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200', Icon: Hourglass },
  unsupported: { cls: 'bg-muted text-muted-foreground', Icon: Ban },
  contained: { cls: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200', Icon: PauseCircle },
  offline: { cls: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200', Icon: WifiOff },
  not_permitted: { cls: 'bg-muted text-muted-foreground', Icon: Lock },
  not_configured: { cls: 'bg-muted text-muted-foreground', Icon: ShieldQuestion },
  inactive: { cls: 'bg-muted text-muted-foreground', Icon: AlertTriangle },
  coming_later: { cls: 'bg-muted text-muted-foreground', Icon: Sparkles },
  checking: { cls: 'bg-muted text-muted-foreground', Icon: Clock },
};

type Catalog = { configured: boolean; approval: 'direct' | 'signed' | null; actions: ({ id: string; title?: string; workstationRisk?: 'low' | 'high' } & Partial<ActionNote>)[] };
type BannerPause = { scope: 'global' | 'business'; businessId?: string | null; kinds: string[] };

/** The reads, only while the panel is open, and the facts the pure module decides from. */
type ToolPerms = { view: boolean; eventLogs: boolean; terminal: boolean; filesUpload: boolean; filesDownload: boolean };

export function useToolFacts(endpointId: string, ep: Record<string, unknown>, patches: Patches | undefined, perms: ToolPerms, enabled: boolean) {
  const { data: user } = useCurrentUser();
  const on = enabled && perms.view;
  // The Actions tab's own read and key (endpoint-actions.tsx), with the approval mode.
  const catalog = useQuery<Catalog>({
    queryKey: ['actions-catalog', endpointId],
    queryFn: () => actionsApi.catalog(endpointId).then((r) => r.data.data as Catalog),
    enabled: on,
    retry: false,
  });
  // The Diagnostics tab's read and key (endpoint-diagnostics-catalog.tsx).
  const diag = useQuery<{ agentBound: boolean; items?: Array<{ key: string; allowed?: boolean; needsNewerAgent?: boolean }> }>({
    queryKey: ['diagnostics-catalog', endpointId],
    queryFn: () => api.get(`/endpoints/${endpointId}/diagnostics/catalog`).then((r) => r.data?.data),
    enabled: on,
    staleTime: 60_000,
    retry: false,
  });
  // The shell's containment banner read and key (containment-banner.tsx).
  const banner = useQuery<BannerPause[]>({
    queryKey: ['containment-banner', user?.businessId ?? null],
    queryFn: () => containmentApi.banner().then((r) => r.data.data ?? []),
    enabled: enabled && !!user,
    refetchInterval: 60_000,
    retry: false,
  });

  const agent = agentType(ep);
  const conn = connectivityFrom(ep);
  const customerId = typeof ep.customerId === 'string' ? ep.customerId : null;
  const deviceClass = String(ep.deviceClass ?? 'WORKSTATION');
  const paused = [...new Set((banner.data ?? [])
    .filter((p) => p.scope === 'global' || (p.businessId != null && p.businessId === customerId))
    .flatMap((p) => p.kinds))];
  const actionRisk: Record<string, 'low' | 'high'> = {};
  for (const a of catalog.data?.actions ?? []) actionRisk[a.id] = deviceClass === 'WORKSTATION' ? (a.workstationRisk ?? 'high') : 'high';
  // 0.79: rollback and repeatability, from the catalog the server serves.
  const actionNotes: Record<string, ActionNote> = {};
  const actionTitles: Record<string, string> = {};
  for (const a of catalog.data?.actions ?? []) {
    if (a.rollback && a.repeat) actionNotes[a.id] = { rollback: a.rollback, repeat: a.repeat };
    if (a.title) actionTitles[a.id] = a.title;
  }
  const u = user ? { isPlatformAdmin: user.isPlatformAdmin, capabilities: user.capabilities as string[], roleType: user.roleType, technician: user.technician ? { sources: user.technician.sources } : null } : null;
  const facts: ToolFacts = {
    agentKind: agent.kind,
    readOnlyOs: agent.readOnlyOs ?? null,
    agentVersion: typeof ep.agentVersion === 'string' ? ep.agentVersion : null,
    agentActions: Array.isArray(ep.agentActions) ? (ep.agentActions as string[]) : [],
    status: String(ep.status ?? ''),
    pooled: ep.tenantId == null || ep.customerId == null,
    agentBound: diag.data ? diag.data.agentBound : null,
    diagAllowed: diag.data?.items ? Object.fromEntries(diag.data.items.map((i) => [i.key, i.allowed !== false])) : null,
    diagNeedsNewer: diag.data?.items ? Object.fromEntries(diag.data.items.map((i) => [i.key, i.needsNewerAgent === true])) : null,
    connectivity: conn,
    // "Offline, last seen 3d ago": the age is the point when deciding whether a request will be picked up.
    connectivityText: conn === 'offline' ? `Offline, last seen ${ago(ep.lastSeenAt as string | null)}` : connectivityLabel(conn, ep.lastSeenAt),
    signer: { configured: catalog.isError ? false : catalog.data ? catalog.data.configured : null, approval: catalog.data?.approval ?? null },
    paused,
    perms: {
      view: perms.view,
      eventLogs: perms.eventLogs,
      terminal: perms.terminal,
      filesUpload: perms.filesUpload,
      filesDownload: perms.filesDownload,
      requestLow: mayRequestActions(u, endpointId, deviceClass, 'low'),
      requestHigh: mayRequestActions(u, endpointId, deviceClass, 'high'),
    },
    actionRisk,
    restartPending: patches?.summary?.rebootRequired ?? patches?.basic?.rebootRequired ?? null,
    actionNotes,
  };
  return { facts, titles: actionTitles, loading: on && (catalog.isLoading || diag.isLoading) };
}

export function ToolsPanel({
  endpointId, ep, patches, perms, open, onOpenChange, onPick,
}: {
  endpointId: string;
  ep: Record<string, unknown>;
  patches: Patches | undefined;
  perms: ToolPerms;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Opens the tool's flow: a tab (with its action, check or log) or a page. */
  onPick: (target: ToolTarget) => void;
}) {
  const { facts, titles, loading } = useToolFacts(endpointId, ep, patches, perms, open);
  const tools = deviceTools(endpointId, facts);
  const name = (ep.name as string) ?? 'this computer';
  // Closed without picking: focus goes back to the Tools button. After a pick,
  // the opened tab places the focus (the check's Run button, the action).
  const picked = useRef(false);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl w-[calc(100vw-1rem)] max-h-[88vh] overflow-y-auto p-4 sm:p-6" data-testid="tools-panel"
        onOpenAutoFocus={() => { picked.current = false; }}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          if (!picked.current) document.querySelector<HTMLElement>('[data-testid="action-tools"]')?.focus();
        }}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Wrench className="h-4 w-4" />Tools for {name}</DialogTitle>
          <DialogDescription>
            Each tool opens the flow that already does it, with its own confirmation. The server checks your access, containment and approval again when you use it.
            {loading && <span className="ml-1 inline-flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" />Checking…</span>}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          {TOOL_GROUPS.map((g) => (
            <section key={g.id} aria-labelledby={`tool-group-${g.id}`} data-testid={`tool-group-${g.id}`} className="min-w-0 space-y-1.5">
              <h3 id={`tool-group-${g.id}`} className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{g.label}</h3>
              <ul className="divide-y rounded-md border">
                {toolsIn(tools, g.id).map((t) => <ToolRow key={t.id} t={t} titles={titles} onPick={(target) => { picked.current = true; onOpenChange(false); onPick(target); }} />)}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ToolRow({ t, titles, onPick }: { t: ToolView; titles: Record<string, string>; onPick: (target: ToolTarget) => void }) {
  const s = STATE_STYLE[t.state];
  const body = (
    <>
      <span className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <span className="text-sm font-medium">{t.label}</span>
        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${s.cls}`} data-testid="tool-state">
          <s.Icon className="h-3 w-3" aria-hidden="true" />{STATE_LABEL[t.state]}
        </span>
      </span>
      <span className="block text-xs text-muted-foreground">{t.reason === t.description || t.reason === 'Ready.' ? t.description : <>{t.description} <span className="text-foreground/80">{t.reason}</span></>}</span>
      {t.note && (
        <span className="block text-[11px] text-muted-foreground" data-testid="tool-note" data-repeat={t.note.repeat.safe ? 'safe' : 'unsafe'} data-rollback={t.note.rollback.kind}
          title={`${t.note.rollback.how} ${t.note.repeat.why}`}>
          {noteLine(t.note, titles)}
        </span>
      )}
    </>
  );
  const common = { 'data-testid': `tool-${t.id}`, 'data-state': t.state } as const;
  if (!opens(t.state) || !t.target) {
    return <li {...common} data-disabled="true" className="space-y-0.5 px-3 py-2 opacity-80">{body}</li>;
  }
  const target = t.target;
  if (target.kind === 'download') {
    return (
      <li {...common}>
        <a href={target.href} className="block space-y-0.5 px-3 py-2 hover:bg-muted/60 focus:bg-muted/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">{body}</a>
      </li>
    );
  }
  return (
    <li {...common}>
      <button type="button" onClick={() => onPick(target)}
        className="block w-full space-y-0.5 px-3 py-2 text-left hover:bg-muted/60 focus:bg-muted/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {body}
      </button>
    </li>
  );
}
