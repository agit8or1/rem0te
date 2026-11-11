'use client';

import * as React from 'react';
import Link from 'next/link';
import { Apple, Monitor, Terminal, HelpCircle } from 'lucide-react';
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

export const COLUMNS: ColumnDef[] = [
  {
    id: 'name', label: 'Device', defaultOn: true, fixed: true, sort: 'name',
    cell: (r) => (
      <div className="flex items-center gap-2 min-w-0">
        <span className={cn('h-2 w-2 rounded-full shrink-0', r.isOnline ? 'bg-green-500' : 'bg-gray-400')} title={r.isOnline ? 'Online' : 'Offline'} />
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
  { id: 'business', label: 'Business', defaultOn: true, sort: 'business', cell: (r) => r.business?.name ?? dash },
  { id: 'site', label: 'Site', defaultOn: true, sort: 'site', cell: (r) => r.site?.name ?? dash },
  { id: 'group', label: 'Group', defaultOn: false, cell: (r) => r.group?.name ?? dash },
  {
    id: 'os', label: 'OS', defaultOn: true, sort: 'os',
    cell: (r) => (
      <span className="flex items-center gap-1.5" title={r.os ?? r.platform ?? 'Unknown'}>
        <OsIcon platform={r.platform ?? r.os} />
        <span className="truncate max-w-[8rem] text-xs text-muted-foreground">{(r.os ?? r.platform ?? 'Unknown').replace(/^Microsoft\s+/i, '')}</span>
      </span>
    ),
  },
  {
    id: 'health', label: 'Health', defaultOn: true, sort: 'health', needsAlerts: true,
    cell: (r) => {
      if (!r.alerts) return <span className="text-muted-foreground" title="Seeing alerts needs the monitoring:alerts permission">—</span>;
      // Derived from open monitoring alerts only: "no open alerts" is not a
      // claim that nothing is wrong, only that no monitor says so.
      if (!r.alerts.open) return <span className="text-xs text-muted-foreground whitespace-nowrap">No open alerts</span>;
      const w = r.alerts.worst;
      return <Badge variant={w === 'CRITICAL' ? 'destructive' : w === 'WARNING' ? 'warning' : 'secondary'}>{w === 'CRITICAL' ? 'Critical' : w === 'WARNING' ? 'Warning' : 'Info'}</Badge>;
    },
  },
  {
    id: 'agent', label: 'Agent', defaultOn: true, sort: 'agent',
    // The last heartbeat is the Last seen column; this one says which agent sent it.
    cell: (r, c) => (
      <div className="text-xs whitespace-nowrap" title={r.agent.lastHeartbeatAt ? `Last heartbeat ${new Date(r.agent.lastHeartbeatAt).toLocaleString()}` : 'No heartbeat yet'}>
        <span>{r.agent.type === 'signed' ? 'Signed' : r.agent.type === 'standard' ? (/^linux/i.test(r.platform ?? '') ? 'Standard (Linux)' : 'Standard') : 'No agent report'}</span>
        <p className={cn('text-muted-foreground', !r.isOnline && 'opacity-60')}>
          {r.agent.version ?? 'version unknown'}{r.isOnline ? '' : ` · ${ago(r.agent.lastHeartbeatAt, c.now)}`}
        </p>
      </div>
    ),
  },
  {
    id: 'lastSeen', label: 'Last seen', defaultOn: true, sort: 'lastSeen',
    cell: (r, c) => (
      <span className="text-xs text-muted-foreground whitespace-nowrap" title={r.lastSeenAt ? new Date(r.lastSeenAt).toLocaleString() : 'Never'}>
        {r.isOnline ? `Online · ${ago(r.lastSeenAt, c.now)}` : ago(r.lastSeenAt, c.now)}
      </span>
    ),
  },
  {
    id: 'user', label: 'Logged-in user', defaultOn: true, sort: 'user',
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
          <div className="flex gap-2 whitespace-nowrap">
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
    id: 'alerts', label: 'Alerts', defaultOn: true, sort: 'alerts', needsAlerts: true, className: 'text-right',
    cell: (r) => (r.alerts ? (
      r.alerts.open ? <Link href={`/endpoints/${r.id}?tab=monitoring`} className="font-medium hover:underline">{r.alerts.open}</Link> : <span className="text-muted-foreground">0</span>
    ) : dash),
  },
];

export const DEFAULT_COLUMNS = COLUMNS.filter((c) => c.defaultOn).map((c) => c.id);
