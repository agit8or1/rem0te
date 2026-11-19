'use client';

import * as React from 'react';
import { CONNECTIVITY_DOT, CONNECTIVITY_TEXT, connectivityFrom, connectivityHint, connectivityLabel } from '@/lib/connectivity';
import Link from 'next/link';
import { Apple, Monitor, Terminal, HelpCircle, ExternalLink } from 'lucide-react';
import { supportInfo, WARRANTY_STATE_LABEL } from '@/lib/hardware-support';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { DeviceRow, SortKey } from './types';

/** "3 min ago" — every metric on the list says how old it is. */
export function ago(iso: string | null | undefined, now: number): string {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

export interface CellContext {
  now: number;
  liveStaleMs: number;
  patchStaleMs: number;
  alertsVisible: boolean;
}

export interface ColumnDef {
  id: string;
  label: string;
  /** Shown by default; the viewer can change this per browser. */
  defaultOn: boolean;
  /** Cannot be hidden. */
  fixed?: boolean;
  sort?: SortKey;
  /** Needs monitoring:alerts — the column is not offered without it. */
  needsAlerts?: boolean;
  className?: string;
  /**
   * 0.47.1: hidden on narrower screens so the default set fits beside the
   * sidebar without sideways scrolling. Literal classes, so Tailwind sees them.
   * 0.48.1: each optional column comes in at its own window width, chosen from
   * its measured minimum width on the docs stack with the sidebar open (the
   * content pane is the window minus 290 px). Comfortable density, which is
   * wider than compact by 4 px a column:
   *   always shown (box, Device, Business, Health, CPU / RAM / disk,
   *   Pending patches, Connect)                       965
   *   + Last seen      109 = 1074, needs 1364 -> from 1440
   *   + Agent          131 = 1205, needs 1495 -> from 1536
   *   + OS             174 = 1379, needs 1669 -> from 1700
   *   + Site           152 = 1531, needs 1821 -> from 1860
   *   + Logged-in user 148 = 1679, needs 1969 -> from 2000
   * Each threshold leaves 30 px or more for longer names than the demo's.
   */
  hideBelow?: HideBelow;
  cell?: (r: DeviceRow, c: CellContext) => React.ReactNode;
}

function OsIcon({ platform }: { platform: string | null }) {
  const p = (platform ?? '').toLowerCase();
  const Icon = p.includes('win') ? Monitor : p.includes('mac') || p.includes('darwin') ? Apple : p.includes('linux') ? Terminal : HelpCircle;
  return <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />;
}

const stale = 'text-muted-foreground opacity-60';
const dash = <span className="text-muted-foreground">—</span>;

function Pct({ label, v }: { label: string; v: number | null }) {
  if (v === null) return <span className="text-muted-foreground">{label} —</span>;
  const hot = v >= 90 ? 'text-red-600 dark:text-red-400' : v >= 75 ? 'text-yellow-700 dark:text-yellow-300' : '';
  return <span className={hot}>{label} {v}%</span>;
}

export type HideBelow = 'lastSeen' | 'agent' | 'os' | 'site' | 'user';
/** The window width each column needs; the column picker shows it. */
export const HIDE_BELOW_PX: Record<HideBelow, number> = { lastSeen: 1440, agent: 1536, os: 1700, site: 1860, user: 2000 };
/** The same widths as literal classes, so Tailwind generates them. */
export const HIDE_BELOW: Record<HideBelow, string> = {
  lastSeen: 'hidden min-[1440px]:table-cell',
  agent: 'hidden min-[1536px]:table-cell',
  os: 'hidden min-[1700px]:table-cell',
  site: 'hidden min-[1860px]:table-cell',
  user: 'hidden min-[2000px]:table-cell',
};

export const COLUMNS: ColumnDef[] = [
  {
    id: 'name', label: 'Device', defaultOn: true, fixed: true, sort: 'name',
    cell: (r, c) => (
      <div className="flex items-center gap-2 min-w-0">
        <span className={cn('h-2 w-2 rounded-full shrink-0', CONNECTIVITY_DOT[connectivityFrom(r, c.now)])} data-connectivity={connectivityFrom(r, c.now)}
          title={`${connectivityLabel(connectivityFrom(r, c.now), r.lastSeenAt, c.now)}. ${connectivityHint(connectivityFrom(r, c.now))}`} />
        <div className="min-w-0">
          <Link href={`/endpoints/${r.id}`} className="font-medium hover:underline whitespace-nowrap">{r.name}</Link>
          {r.hostname && r.hostname.toLowerCase() !== r.name.toLowerCase() ? (
            <p className="text-xs text-muted-foreground truncate">{r.hostname}</p>
          ) : null}
          {r.status !== 'ACTIVE' ? <Badge variant="outline" className="mt-0.5 text-[10px]">{r.status === 'PENDING_ENROLLMENT' ? 'Pending enrollment' : r.status.toLowerCase()}</Badge> : null}
        </div>
      </div>
    ),
  },
  { id: 'business', label: 'Business', defaultOn: true, sort: 'business', cell: (r) => r.business?.name ? <span className="block max-w-[10rem] truncate" title={r.business.name}>{r.business.name}</span> : dash },
  { id: 'site', label: 'Site', defaultOn: true, sort: 'site', hideBelow: 'site', cell: (r) => r.site?.name ? <span className="block max-w-[8rem] truncate" title={r.site.name}>{r.site.name}</span> : dash },
  // Id kept as 'group' so saved views from 0.33 keep the column.
  {
    id: 'group', label: 'Groups', defaultOn: false,
    cell: (r) => (r.groups.length === 0 ? dash : (
      <div className="flex flex-wrap gap-1 max-w-[220px]" title={r.groups.map((g) => g.name).join(', ')}>
        {r.groups.map((g) => (
          <Badge key={g.id} variant={g.kind === 'rule' ? 'outline' : 'secondary'} className="text-[10px] font-normal"
            title={g.kind === 'rule' ? 'Rule group: in it because it matches the rule now' : undefined}>{g.name}</Badge>
        ))}
      </div>
    )),
  },
  {
    id: 'os', label: 'OS', defaultOn: true, sort: 'os', hideBelow: 'os',
    cell: (r) => (
      <span className="flex items-center gap-1.5" title={r.os ?? r.platform ?? 'Unknown'}>
        <OsIcon platform={r.platform ?? r.os} />
        <span className="truncate max-w-[8rem] text-xs text-muted-foreground">{(r.os ?? r.platform ?? 'Unknown').replace(/^Microsoft\s+/i, '')}</span>
      </span>
    ),
  },
  {
    id: 'health', label: 'Health', defaultOn: true, sort: 'health', needsAlerts: true,
    cell: (r, c) => <HealthCell r={r} now={c.now} />,
  },
  {
    id: 'agent', label: 'Agent', defaultOn: true, sort: 'agent', hideBelow: 'agent',
    // The last heartbeat is the Last seen column; this one says which agent sent it.
    cell: (r, c) => (
      <div className="text-xs whitespace-nowrap" title={r.agent.lastHeartbeatAt ? `Last heartbeat ${new Date(r.agent.lastHeartbeatAt).toLocaleString()}` : 'No heartbeat yet'}>
        <span>{r.agent.type === 'signed' ? 'Signed' : r.agent.type === 'standard' ? (/^linux/i.test(r.platform ?? '') ? 'Standard (Linux)' : /^(macos|mac|darwin|osx)\b/i.test(r.platform ?? '') ? 'Standard (macOS)' : 'Standard') : 'No agent report'}</span>
        <p className={cn('text-muted-foreground', connectivityFrom(r, c.now) !== 'online' && 'opacity-60')}>
          {r.agent.version ?? 'version unknown'}{connectivityFrom(r, c.now) === 'online' ? '' : ` · ${ago(r.agent.lastHeartbeatAt, c.now)}`}
        </p>
      </div>
    ),
  },
  {
    id: 'lastSeen', label: 'Last seen', defaultOn: true, sort: 'lastSeen', hideBelow: 'lastSeen',
    cell: (r, c) => (
      <span className={cn('text-xs block max-w-[8rem]', connectivityFrom(r, c.now) === 'agent_silent' ? CONNECTIVITY_TEXT.agent_silent : 'text-muted-foreground')}
        title={`${r.lastSeenAt ? new Date(r.lastSeenAt).toLocaleString() : 'Never'}${connectivityFrom(r, c.now) === 'agent_silent' ? `. ${connectivityHint('agent_silent')}` : ''}`} data-testid="last-seen-cell">
        {connectivityFrom(r, c.now) === 'online' ? `Online · ${ago(r.lastSeenAt, c.now)}`
          : connectivityFrom(r, c.now) === 'agent_silent' ? connectivityLabel('agent_silent', r.lastSeenAt, c.now) : ago(r.lastSeenAt, c.now)}
      </span>
    ),
  },
  {
    id: 'user', label: 'Logged-in user', defaultOn: true, sort: 'user', hideBelow: 'user',
    cell: (r, c) => {
      if (!r.loggedOnUser) return dash;
      const old = !r.resources || c.now - new Date(r.resources.sampledAt).getTime() > c.liveStaleMs;
      return <span className={cn('text-xs whitespace-nowrap', old && stale)} title={r.resources ? `as of ${ago(r.resources.sampledAt, c.now)}` : undefined}>{r.loggedOnUser}</span>;
    },
  },
  {
    id: 'resources', label: 'CPU / RAM / disk', defaultOn: true, sort: 'cpu',
    cell: (r, c) => {
      const x = r.resources;
      if (!x) return <span className="text-xs text-muted-foreground">Not sampled</span>;
      const isStale = c.now - new Date(x.sampledAt).getTime() > c.liveStaleMs;
      return (
        <div className={cn('text-xs', isStale && stale)} title={`Sampled ${new Date(x.sampledAt).toLocaleString()}${isStale ? ' — stale, not live' : ''}`}>
          <div className="flex flex-wrap gap-x-2 max-w-[9rem]">
            <Pct label="CPU" v={x.cpuPercent} /><Pct label="RAM" v={x.memoryUsedPercent} /><Pct label="Disk" v={x.diskUsedPercent} />
          </div>
          <p className="text-muted-foreground">{isStale ? 'stale · ' : ''}{ago(x.sampledAt, c.now)}</p>
        </div>
      );
    },
  },
  {
    id: 'patches', label: 'Pending patches', defaultOn: true, sort: 'patches',
    cell: (r, c) => {
      const p = r.patches;
      if (p.source === 'none') return <span className="text-xs text-muted-foreground">No scan</span>;
      const isStale = !p.checkedAt || c.now - new Date(p.checkedAt).getTime() > c.patchStaleMs;
      return (
        <div className={cn('text-xs', isStale && stale)} title={`${p.source === 'signed_agent_scan' ? 'Signed agent scan' : 'Standard agent scan'}${p.checkedAt ? `, ${new Date(p.checkedAt).toLocaleString()}` : ''}${isStale ? ' — stale' : ''}`}>
          <div className="flex items-center gap-1.5 whitespace-nowrap">
            <span>{p.pendingCount === null ? 'Unknown' : p.pendingCount === 0 ? 'Up to date' : `${p.pendingCount} pending`}</span>
            {p.rebootPending ? <Badge variant="warning" className="text-[10px] px-1.5 py-0">restart</Badge> : null}
          </div>
          <p className="text-muted-foreground">{isStale ? 'stale · ' : ''}{ago(p.checkedAt, c.now)}</p>
        </div>
      );
    },
  },
  {
    // 0.56: the stored warranty end date, and the vendor's warranty page for this machine.
    id: 'warranty', label: 'Warranty', defaultOn: false, sort: 'warranty',
    cell: (r) => {
      const w = r.warranty;
      if (!w) return dash;
      const hw = r.hardware;
      const info = hw ? supportInfo(hw.manufacturer, hw.model, hw.serialNumber) : null;
      const link = info?.links.find((l) => l.kind === 'warranty') ?? info?.links[0];
      const variant = w.state === 'expired' ? 'destructive' : w.state === 'expiring_30' || w.state === 'expiring_60' ? 'warning' : w.state === 'unknown' ? 'outline' : 'secondary';
      return (
        <div className="text-xs whitespace-nowrap" data-testid="warranty-cell" data-state={w.state}>
          <div className="flex items-center gap-1.5">
            {info?.maker.kind === 'virtual' && w.state === 'unknown'
              ? <span className="text-muted-foreground" title={info.note ?? undefined}>Virtual machine</span>
              : <Badge variant={variant} className="text-[10px] px-1.5 py-0 font-normal">{WARRANTY_STATE_LABEL[w.state]}</Badge>}
            {link ? (
              <a href={link.url} target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-foreground"
                title={`${info?.vendorLabel ?? 'Vendor'}: ${link.label}${link.serialInUrl ? '' : ' (copy the serial from the device page)'}`} aria-label={`${info?.vendorLabel ?? 'Vendor'} ${link.label}`}>
                <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              </a>
            ) : null}
          </div>
          {w.endsAt ? <p className="text-muted-foreground">{new Date(w.endsAt).toISOString().slice(0, 10)}</p> : null}
        </div>
      );
    },
  },
  {
    id: 'alerts', label: 'Alerts', defaultOn: false, sort: 'alerts', needsAlerts: true, className: 'text-right',
    cell: (r) => (r.alerts ? (
      r.alerts.open ? <Link href={`/endpoints/${r.id}?tab=monitoring`} className="font-medium hover:underline">{r.alerts.open}</Link> : <span className="text-muted-foreground">0</span>
    ) : dash),
  },
];

export const DEFAULT_COLUMNS = COLUMNS.filter((c) => c.defaultOn).map((c) => c.id);

/**
 * Health, in words (0.68): Healthy, Warning or Issues, from the open
 * monitoring alerts. It said "None" for no open alerts, which read as "no
 * health". "Healthy" is said only for a computer that is reporting: an agent
 * that has gone quiet raises nothing, so its lack of alerts proves nothing,
 * and it is "Unknown" until it checks in again. An open alert always shows,
 * reporting or not. Informational alerts alone are still Healthy.
 */
export function healthOf(r: Pick<DeviceRow, 'alerts' | 'connectivity' | 'isOnline' | 'lastSeenAt'>, now?: number):
  { label: 'Healthy' | 'Warning' | 'Issues' | 'Unknown'; variant: 'success' | 'warning' | 'destructive' | 'outline'; title: string } | null {
  if (!r.alerts) return null;
  const n = r.alerts.open;
  const plural = `${n} open alert${n === 1 ? '' : 's'}`;
  if (n && r.alerts.worst === 'CRITICAL') return { label: 'Issues', variant: 'destructive', title: `${plural}, the worst critical` };
  if (n && r.alerts.worst === 'WARNING') return { label: 'Warning', variant: 'warning', title: `${plural}, the worst a warning` };
  if (connectivityFrom(r, now) !== 'online') {
    return { label: 'Unknown', variant: 'outline', title: n ? `${plural}, informational only; the agent is not reporting, so nothing new would be raised` : 'No open alerts, but the agent is not reporting, so nothing new would be raised' };
  }
  return { label: 'Healthy', variant: 'success', title: n ? `${plural}, informational only` : 'No open monitoring alerts' };
}

function HealthCell({ r, now }: { r: DeviceRow; now?: number }) {
  const h = healthOf(r, now);
  if (!h) return <span className="text-muted-foreground" title="Seeing alerts needs the monitoring:alerts permission">—</span>;
  return <Badge variant={h.variant} title={h.title} data-health={h.label.toLowerCase()} className="whitespace-nowrap">{h.label}</Badge>;
}
