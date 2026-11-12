'use client';

import Link from 'next/link';
import {
  AlertTriangle, Bell, BellRing, CheckCircle2, Cpu, KeyRound, PackageCheck, PowerOff, RotateCw, ShieldCheck,
} from 'lucide-react';
import { cn, formatDate } from '@/lib/utils';
import type { InventoryPayload } from '@/components/endpoints/endpoint-specs';
import type { Patches } from '@/components/endpoints/endpoint-patches';
import {
  agentSilentAlert, ago, agentType, alertHref, deviceStatus, HEARTBEAT_STALE_MS, isStale, openAlerts, STATUS_DOT, worstSeverity,
  type WorkspaceTab,
} from './device-model';
import type { MonitoringView } from './use-device-data';

/**
 * The top of a computer's page: who it is, whether it is reachable, and what
 * needs attention — each from data the page already reads, each with its age
 * where age matters, and each a link to the tab that explains it.
 */

type Tone = 'critical' | 'warning' | 'info' | 'ok' | 'muted';

const TONE: Record<Tone, string> = {
  critical: 'border-red-300 bg-red-50 text-red-900 hover:bg-red-100 dark:border-red-900 dark:bg-red-950/60 dark:text-red-100 dark:hover:bg-red-950',
  warning: 'border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-100 dark:hover:bg-amber-950',
  info: 'border-sky-200 bg-sky-50 text-sky-900 hover:bg-sky-100 dark:border-sky-900 dark:bg-sky-950/60 dark:text-sky-100 dark:hover:bg-sky-950',
  ok: 'border-green-200 bg-green-50 text-green-900 hover:bg-green-100 dark:border-green-900 dark:bg-green-950/50 dark:text-green-100 dark:hover:bg-green-950',
  muted: 'border-border bg-muted/40 text-muted-foreground hover:bg-muted',
};

interface Item {
  key: string;
  tone: Tone;
  icon: React.ElementType;
  label: string;
  detail?: string;
  tab?: WorkspaceTab;
  href?: string;
  title?: string;
}

function Chip({ item, onOpen }: { item: Item; onOpen: (t: WorkspaceTab) => void }) {
  const Icon = item.icon;
  const cls = cn('inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors text-left', TONE[item.tone]);
  const body = (
    <>
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{item.label}</span>
      {item.detail && <span className="font-normal opacity-80">· {item.detail}</span>}
    </>
  );
  if (item.href) return <Link href={item.href} className={cls} title={item.title} data-testid={`attention-${item.key}`}>{body}</Link>;
  if (item.tab) {
    const tab = item.tab;
    return <button type="button" className={cls} title={item.title} onClick={() => onOpen(tab)} data-testid={`attention-${item.key}`}>{body}</button>;
  }
  return <span className={cls} title={item.title} data-testid={`attention-${item.key}`}>{body}</span>;
}

function attentionItems(
  ep: Record<string, unknown>,
  mon: { data?: MonitoringView; isError: boolean },
  patches: { data?: Patches; isError: boolean },
  inv: InventoryPayload | undefined,
): Item[] {
  const items: Item[] = [];
  const agent = agentType(ep);

  // A computer heartbeating with a secret the server does not hold looks
  // offline and ignores every request — that outranks everything else.
  if (inv?.secretMismatch) {
    items.push({ key: 'secret', tone: 'critical', icon: KeyRound, label: 'Heartbeats refused', detail: 'new device secret', tab: 'overview', title: 'This computer is calling in with a device secret the server does not hold. Review it on the Overview tab.' });
  }

  // Alerts. `alerts` is null when the viewer may not see them; say nothing then.
  if (mon.data && mon.data.alerts !== null) {
    const open = openAlerts(mon.data.alerts);
    const worst = worstSeverity(open);
    if (open.length === 0) {
      items.push({ key: 'alerts', tone: 'ok', icon: Bell, label: 'No open alerts', tab: 'monitoring' });
    } else {
      items.push({
        key: 'alerts', tone: worst === 'CRITICAL' ? 'critical' : worst === 'WARNING' ? 'warning' : 'info', icon: BellRing,
        label: `${open.length} open alert${open.length === 1 ? '' : 's'}`, detail: `worst: ${worst?.toLowerCase()}`, tab: 'monitoring',
      });
    }
  } else if (mon.isError) {
    items.push({ key: 'alerts', tone: 'muted', icon: Bell, label: 'Alerts unavailable', tab: 'monitoring' });
  }
  // 0.36: an open agent-silent alert links straight to itself.
  const silent = agentSilentAlert(mon.data?.alerts);
  if (silent) {
    items.push({
      key: 'agent-silent-alert', tone: 'warning', icon: BellRing, label: 'Agent silent alert', detail: `since ${ago(silent.firstSeenAt)}`,
      href: alertHref(silent), title: `${silent.title}. Use Update agent on the Agent card, or re-run the installer on the machine.`,
    });
  }

  // Patch status, from the same summary the Patches tab leads with.
  const s = patches.data?.summary;
  if (s) {
    const stale = s.evidence.freshness === 'stale';
    const scanAge = s.evidence.at ? `scan ${ago(s.evidence.at)}${stale ? ', stale' : ''}` : undefined;
    if (s.rebootRequired) {
      items.push({ key: 'restart', tone: 'warning', icon: RotateCw, label: 'Restart pending', detail: scanAge, tab: 'patches' });
    }
    if (s.evidence.source === 'none') {
      items.push({ key: 'updates', tone: 'muted', icon: PackageCheck, label: 'Updates not scanned yet', tab: 'patches' });
    } else if (s.pendingCount > 0) {
      items.push({ key: 'updates', tone: 'warning', icon: PackageCheck, label: `${s.pendingCount} update${s.pendingCount === 1 ? '' : 's'} pending`, detail: scanAge, tab: 'patches' });
    } else {
      items.push({ key: 'updates', tone: stale ? 'warning' : 'ok', icon: stale ? AlertTriangle : CheckCircle2, label: 'No pending updates', detail: scanAge, tab: 'patches' });
    }
  } else if (inv?.inventory?.rebootRequired) {
    // Patches route unavailable: the inventory still says whether a restart is pending.
    items.push({ key: 'restart', tone: 'warning', icon: RotateCw, label: 'Restart pending', detail: inv.inventory.updatesCheckedAt ? `checked ${ago(inv.inventory.updatesCheckedAt)}` : undefined, tab: 'patches' });
  }

  // The agent — which decides what the rest of the page can show.
  if (inv && agent.kind !== 'rustdesk-only') {
    if (!inv.agentBound) {
      items.push({ key: 'agent-unbound', tone: 'warning', icon: AlertTriangle, label: 'Cannot report specs', detail: 'enrolled before device secrets', tab: 'overview' });
    } else if (inv.agent.outdated) {
      items.push({ key: 'agent-outdated', tone: 'warning', icon: AlertTriangle, label: 'Agent out of date', detail: `needs v${inv.agent.required}`, tab: 'overview' });
    }
  }
  const version = typeof ep.agentVersion === 'string' && ep.agentVersion ? `v${ep.agentVersion}` : undefined;
  items.push({
    key: 'agent', tone: 'info', icon: agent.kind === 'signed' ? ShieldCheck : agent.kind === 'rustdesk-only' ? PowerOff : Cpu,
    label: agent.label, detail: agent.kind === 'rustdesk-only' ? undefined : version, href: '/docs/capabilities', title: agent.explanation,
  });
  return items;
}

export function DeviceHeader({
  ep, mon, patches, inventory, onOpenTab, actions,
}: {
  ep: Record<string, unknown>;
  mon: { data?: MonitoringView; isError: boolean };
  patches: { data?: Patches; isError: boolean };
  inventory: InventoryPayload | undefined;
  onOpenTab: (t: WorkspaceTab) => void;
  actions: React.ReactNode;
}) {
  const status = deviceStatus(ep);
  const customer = ep.customer as { id: string; name: string } | null;
  const site = ep.site as { id: string; name: string } | null;
  const lastSeen = (ep.lastSeenAt as string | null) ?? null;
  const lastSeenStale = !!lastSeen && isStale(lastSeen, HEARTBEAT_STALE_MS);
  const items = attentionItems(ep, mon, patches, inventory);

  return (
    <div className="space-y-3" data-testid="device-header">
      <div>
        <div className="min-w-0 space-y-1">
          <h1 className="text-2xl font-semibold text-foreground break-words">{ep.name as string}</h1>
          <dl className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
            <div className="flex items-center gap-1.5" data-testid="device-status">
              <dt className="sr-only">Status</dt>
              <span className={cn('inline-block h-2.5 w-2.5 rounded-full shrink-0', STATUS_DOT[status.tone])} aria-hidden="true" />
              <dd className="text-foreground font-medium" title={status.detail ?? undefined}>{status.label}</dd>
            </div>
            <div className="flex items-center gap-1"><dt>Business</dt><dd className="text-foreground">{customer?.name ?? '—'}</dd></div>
            <div className="flex items-center gap-1"><dt>Site</dt><dd className="text-foreground">{site?.name ?? '—'}</dd></div>
            <div className="flex items-center gap-1">
              <dt>Last seen</dt>
              <dd className="text-foreground" title={lastSeen ? formatDate(lastSeen) : undefined}>
                {ago(lastSeen)}
                {lastSeenStale && status.tone !== 'offline' && (
                  <span className="ml-1.5 rounded border border-amber-300 bg-amber-50 px-1 text-[11px] text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">stale</span>
                )}
              </dd>
            </div>
            {typeof ep.hostname === 'string' && ep.hostname && ep.hostname !== ep.name && (
              <div className="flex items-center gap-1"><dt>Hostname</dt><dd className="font-mono text-xs text-foreground">{ep.hostname}</dd></div>
            )}
          </dl>
          {status.detail && <p className="text-xs text-muted-foreground">{status.detail}</p>}
        </div>
      </div>
      {actions}

      <div className="flex flex-wrap gap-2" aria-label="Needs attention" data-testid="attention-strip">
        {items.map((i) => <Chip key={i.key} item={i} onOpen={onOpenTab} />)}
      </div>
    </div>
  );
}
