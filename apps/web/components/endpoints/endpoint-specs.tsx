'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { endpointsApi } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { formatDate } from '@/lib/utils';
import {
  Cpu, HardDrive, MemoryStick, Network, PackageCheck, RefreshCw,
  User, Server, AlertTriangle, ChevronDown, ChevronRight, Info, Download,
} from 'lucide-react';

/**
 * What a managed computer has reported about itself.
 *
 * Every value here came off the endpoint on a heartbeat, which has two
 * consequences the UI has to be honest about: it can be a few minutes old, and
 * for a machine whose installer predates the agent secret there is none of it
 * at all. Both of those say so on screen rather than rendering as zeros or
 * dashes that look like real answers.
 */

export interface Disk {
  drive: string;
  label: string | null;
  fsType: string | null;
  totalBytes: number | null;
  freeBytes: number | null;
}
export interface Gpu { name: string; driverVersion: string | null; resolution: string | null }
export interface Nic {
  name: string; mac: string | null; ipv4: string | null;
  gateway: string | null; dhcp: boolean | null;
}
export interface PendingUpdate {
  title: string; kb: string | null; severity: string | null; sizeBytes: number | null;
}

export interface Inventory {
  manufacturer: string | null; model: string | null; serialNumber: string | null;
  chassisType: string | null; biosVersion: string | null; biosDate: string | null;
  osCaption: string | null; osBuild: string | null; osArch: string | null;
  osInstalledAt: string | null; domain: string | null; timezone: string | null;
  cpuModel: string | null; cpuCores: number | null; cpuThreads: number | null; cpuMhz: number | null;
  memoryTotalMb: number | null; memoryFreeMb: number | null;
  disks: Disk[] | null; gpus: Gpu[] | null; networks: Nic[] | null;
  loggedOnUser: string | null; lastBootAt: string | null; uptimeSeconds: number | null;
  pendingUpdates: PendingUpdate[] | null; pendingUpdateCount: number | null;
  rebootRequired: boolean | null; updatesCheckedAt: string | null;
  collectedAt: string | null;
}

export interface InventoryPayload {
  inventory: Inventory | null;
  rustdesk: { installedVersion: string | null; stagedVersion: string | null; stagedAt: string | null };
  // The Rem0te agent, as distinct from the RustDesk client: this is the one
  // that decides whether the machine can collect anything at all.
  agent: {
    version: string | null;
    server: string;
    /** The version the agent contract actually requires — not the server's. */
    required: string;
    outdated: boolean;
    reinstallPending: boolean;
    reinstallDispatched: boolean;
  };
  agentBound: boolean;
  commands: {
    id: string; type: string; status: string; error: string | null;
    requestedById: string | null; createdAt: string; completedAt: string | null;
  }[];
}

// --- Formatting -------------------------------------------------------------

function bytes(n: number | null | undefined) {
  if (n === null || n === undefined) return '—';
  if (n === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function mb(n: number | null | undefined) {
  if (n === null || n === undefined) return '—';
  return bytes(n * 1024 * 1024);
}

/**
 * Uptime as a person would say it.
 *
 * `formatDuration` in lib/utils tops out at hours, which is the wrong unit for
 * a server that has been up since March — "4128h 12m" is not an answer anybody
 * reads.
 */
function uptime(seconds: number | null | undefined) {
  if (seconds === null || seconds === undefined) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** How long ago, for a value whose age is the point. */
function ago(at: string | null | undefined) {
  if (!at) return 'never';
  const ms = Date.now() - new Date(at).getTime();
  if (ms < 0) return 'just now';
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="text-right min-w-0 break-words">{children}</span>
    </div>
  );
}

/** A used/total bar. Amber past 80%, red past 92% — the thresholds at which a
 *  full disk stops being trivia and starts being the reason for the ticket. */
function UsageBar({ used, total }: { used: number; total: number }) {
  if (!total) return null;
  const pct = Math.min(100, Math.max(0, (used / total) * 100));
  const tone =
    pct >= 92 ? 'bg-red-500' : pct >= 80 ? 'bg-amber-500' : 'bg-primary';
  return (
    <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
      <div className={`h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

// --- Cards ------------------------------------------------------------------

function SectionCard({
  title, icon: Icon, children, aside,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
  aside?: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Icon className="h-4 w-4 text-muted-foreground" />
            {title}
          </CardTitle>
          {aside}
        </div>
      </CardHeader>
      <CardContent className="space-y-2.5 text-sm">{children}</CardContent>
    </Card>
  );
}

function UpdatesCard({ data }: { data: InventoryPayload }) {
  const [open, setOpen] = useState(false);
  const inv = data.inventory;
  const count = inv?.pendingUpdateCount ?? null;
  const list = inv?.pendingUpdates ?? [];

  return (
    <SectionCard
      title="Updates"
      icon={PackageCheck}
      aside={
        count !== null && count > 0 ? (
          <Badge variant="destructive" className="text-xs">{count} pending</Badge>
        ) : count === 0 ? (
          <Badge variant="secondary" className="text-xs">Up to date</Badge>
        ) : null
      }
    >
      <Row label="Windows Update">
        {count === null ? (
          <span className="text-muted-foreground">Not checked yet</span>
        ) : count === 0 ? (
          'No pending updates'
        ) : (
          `${count} pending`
        )}
      </Row>
      <Row label="Last checked">
        {inv?.updatesCheckedAt ? (
          <span title={formatDate(inv.updatesCheckedAt)}>{ago(inv.updatesCheckedAt)}</span>
        ) : (
          '—'
        )}
      </Row>
      {inv?.rebootRequired && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-600 mt-0.5" />
          <span>
            This computer is waiting on a restart to finish installing updates.
          </span>
        </div>
      )}

      {/* Three different things can be out of date on a managed machine and
          confusing them wastes time, so each is named rather than merged. */}
      <div className="pt-1 border-t space-y-2.5">
        <Row label="Rem0te agent">
          {data.agent.version ? (
            <>
              <span className="font-mono text-xs">v{data.agent.version}</span>
              {/* Only when it actually falls short of what the server asks of
                  it. An agent behind the platform version but at or above the
                  contract needs nothing, and saying otherwise sends people
                  reinstalling a fleet for no reason. */}
              {data.agent.outdated && (
                <div className="text-[11px] text-amber-600">
                  needs v{data.agent.required} or later
                </div>
              )}
            </>
          ) : (
            <>
              <span className="text-muted-foreground">Not reported</span>
              <div className="text-[11px] text-amber-600">
                predates v0.14.0 — cannot collect
              </div>
            </>
          )}
        </Row>
        <Row label="RustDesk client">
          {data.rustdesk.installedVersion ? (
            <span className="font-mono text-xs">v{data.rustdesk.installedVersion}</span>
          ) : (
            <span className="text-muted-foreground">Unknown</span>
          )}
        </Row>
        {data.rustdesk.stagedVersion && (
          <Row label="Upgrade staged">
            <span className="font-mono text-xs">
              v{data.rustdesk.stagedVersion}
            </span>
            <div className="text-[11px] text-muted-foreground">
              applies on the next heartbeat
            </div>
          </Row>
        )}
      </div>

      {list.length > 0 && (
        <div className="pt-1">
          <button
            onClick={() => setOpen((o) => !o)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            {open ? 'Hide' : 'Show'} the {list.length} pending update{list.length === 1 ? '' : 's'}
          </button>
          {open && (
            <ul className="mt-2 space-y-1.5">
              {list.map((u, i) => (
                <li key={`${u.kb ?? 'kb'}-${i}`} className="text-xs leading-snug">
                  <div className="break-words">{u.title}</div>
                  <div className="text-muted-foreground">
                    {[u.kb, u.severity, u.sizeBytes ? bytes(u.sizeBytes) : null]
                      .filter(Boolean)
                      .join(' · ') || '—'}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </SectionCard>
  );
}

// --- The tab ----------------------------------------------------------------

export function EndpointSpecs({
  endpointId,
  endpoint,
}: {
  endpointId: string;
  endpoint: Record<string, unknown>;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['endpoint-inventory', endpointId],
    queryFn: () =>
      endpointsApi.inventory(endpointId).then((r) => r.data?.data as InventoryPayload),
    // A collection lands on a heartbeat, not on a click, so the page keeps
    // looking rather than leaving someone staring at stale cards after they
    // pressed Refresh.
    refetchInterval: 30_000,
  });

  const reinstall = useMutation({
    mutationFn: () => endpointsApi.reinstallAgent(endpointId),
    onSuccess: () => {
      toast({
        title: 'Reinstall queued',
        description:
          'The installer re-runs on this computer at its next heartbeat. It keeps the server ' +
          'config, password and enrolment — it replaces the agent and pulls the current client.',
      });
      qc.invalidateQueries({ queryKey: ['endpoint-inventory', endpointId] });
    },
    onError: (e: unknown) => {
      // The server refuses this for a machine that has never authenticated,
      // and the reason is the actionable part — show it rather than a generic
      // failure the operator cannot do anything with.
      const message =
        (e as { response?: { data?: { message?: string } } })?.response?.data?.message ??
        'Could not queue the reinstall';
      toast({ title: 'Cannot reinstall from here', description: message, variant: 'destructive' });
    },
  });

  const refresh = useMutation({
    mutationFn: () => endpointsApi.refreshInventory(endpointId),
    onSuccess: () => {
      toast({
        title: 'Queued',
        description:
          'This computer collects its specs and checks Windows Update on its next heartbeat — up to about three minutes.',
      });
      qc.invalidateQueries({ queryKey: ['endpoint-inventory', endpointId] });
    },
    onError: () =>
      toast({ title: 'Error', description: 'Could not queue the refresh', variant: 'destructive' }),
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const inv = data?.inventory ?? null;
  const pendingCollection = (data?.commands ?? []).some(
    (c) =>
      (c.status === 'PENDING' || c.status === 'DISPATCHED') &&
      (c.type === 'INVENTORY_REFRESH' || c.type === 'UPDATE_SCAN'),
  );

  // Decided by the server against the agent contract, not by comparing with
  // the platform version here. An agent newer than the contract is the normal
  // case, not a problem — comparing against the server's own version flagged
  // every machine in the fleet on every release.
  const agentOutdated = !!data?.agent.outdated;

  const memTotal = inv?.memoryTotalMb ?? null;
  const memFree = inv?.memoryFreeMb ?? null;

  return (
    <div className="space-y-4">
      {/* Why there is nothing to show. An endpoint enrolled before device
          secrets existed reports liveness and nothing else — the server
          refuses to write anything it says until its installer is re-run — and
          that is invisible without saying so. */}
      {data && !data.agentBound && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 mt-0.5" />
          <div>
            <div className="font-medium">This computer cannot report its specs yet</div>
            <p className="text-muted-foreground text-xs mt-0.5">
              It enrolled before per-device secrets existed, so nothing it sends is
              trusted beyond an online check. Re-run the installer on it and everything
              below fills in on the next heartbeat.
            </p>
          </div>
        </div>
      )}

      {data?.agentBound && !inv?.collectedAt && (
        <div className="flex items-start gap-2 rounded-md border bg-muted/40 p-3 text-sm">
          <Info className="h-4 w-4 shrink-0 text-muted-foreground mt-0.5" />
          <div>
            <div className="font-medium">Specs have not been collected yet</div>
            <p className="text-muted-foreground text-xs mt-0.5">
              {agentOutdated
                ? 'This computer’s agent is older than v0.14.0 and cannot collect specs. Use Reinstall agent below — it keeps every setting and replaces the agent.'
                : 'The first pass runs on this computer’s next heartbeat, up to about three minutes away.'}
            </p>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {inv?.collectedAt
            ? `Collected ${ago(inv.collectedAt)}`
            : 'Nothing collected yet'}
          {pendingCollection && ' · a refresh is queued for the next heartbeat'}
        </p>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending || pendingCollection}
          >
            <RefreshCw className={`h-3 w-3 mr-1 ${refresh.isPending ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          {/* Offered whenever the agent is not the server's version, and as a
              repair otherwise. Left enabled for an unbound machine on purpose:
              the server's refusal explains what to do, which is more use than
              a disabled button with no reason. */}
          <Button
            size="sm"
            variant={agentOutdated ? 'default' : 'outline'}
            onClick={() => reinstall.mutate()}
            disabled={reinstall.isPending || data?.agent.reinstallPending}
          >
            <Download className={`h-3 w-3 mr-1 ${reinstall.isPending ? 'animate-pulse' : ''}`} />
            {data?.agent.reinstallPending ? 'Reinstall queued' : 'Reinstall agent'}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SectionCard title="System" icon={Server}>
          <Row label="Operating system">
            {inv?.osCaption ?? (endpoint.osVersion as string) ?? '—'}
          </Row>
          <Row label="Build">{inv?.osBuild ?? '—'}</Row>
          <Row label="Architecture">{inv?.osArch ?? '—'}</Row>
          <Row label="Installed">
            {inv?.osInstalledAt ? formatDate(inv.osInstalledAt) : '—'}
          </Row>
          <Row label="Domain / workgroup">{inv?.domain ?? '—'}</Row>
          <Row label="Time zone">{inv?.timezone ?? '—'}</Row>
          <Row label="RustDesk ID">
            <span className="font-mono text-xs">
              {((endpoint.rustdeskNode as { rustdeskId?: string } | null)?.rustdeskId) ??
                'Not enrolled'}
            </span>
          </Row>
          <Row label="Last seen">{formatDate(endpoint.lastSeenAt as string)}</Row>
        </SectionCard>

        <SectionCard title="Session" icon={User}>
          <Row label="Signed in">
            {inv?.loggedOnUser ? (
              <span className="font-mono text-xs">{inv.loggedOnUser}</span>
            ) : inv?.collectedAt || inv?.lastBootAt ? (
              <span className="text-muted-foreground">Nobody at the console</span>
            ) : (
              '—'
            )}
          </Row>
          <Row label="Uptime">{uptime(inv?.uptimeSeconds)}</Row>
          <Row label="Last boot">{inv?.lastBootAt ? formatDate(inv.lastBootAt) : '—'}</Row>
          <Row label="IP address">
            <span className="font-mono text-xs">{(endpoint.ipAddress as string) ?? '—'}</span>
          </Row>
        </SectionCard>

        <SectionCard title="Hardware" icon={Cpu}>
          <Row label="Manufacturer">{inv?.manufacturer ?? '—'}</Row>
          <Row label="Model">{inv?.model ?? '—'}</Row>
          <Row label="Form factor">{inv?.chassisType ?? '—'}</Row>
          <Row label="Serial number">
            <span className="font-mono text-xs">{inv?.serialNumber ?? '—'}</span>
          </Row>
          <Row label="Processor">{inv?.cpuModel ?? '—'}</Row>
          <Row label="Cores / threads">
            {inv?.cpuCores ? `${inv.cpuCores} / ${inv.cpuThreads ?? '?'}` : '—'}
            {inv?.cpuMhz ? ` · ${(inv.cpuMhz / 1000).toFixed(2)} GHz` : ''}
          </Row>
          <Row label="BIOS">
            {inv?.biosVersion ?? '—'}
            {inv?.biosDate && (
              <div className="text-[11px] text-muted-foreground">
                {formatDate(inv.biosDate)}
              </div>
            )}
          </Row>
          {(inv?.gpus ?? []).length > 0 && (
            <Row label="Graphics">
              <div className="space-y-0.5">
                {(inv?.gpus ?? []).map((g, i) => (
                  <div key={`${g.name}-${i}`} className="text-xs">
                    {g.name}
                    {g.resolution && (
                      <span className="text-muted-foreground"> · {g.resolution}</span>
                    )}
                  </div>
                ))}
              </div>
            </Row>
          )}
        </SectionCard>

        <SectionCard
          title="Memory"
          icon={MemoryStick}
          aside={
            memTotal ? (
              <span className="text-xs text-muted-foreground">{mb(memTotal)}</span>
            ) : null
          }
        >
          {memTotal ? (
            <>
              <UsageBar used={memTotal - (memFree ?? 0)} total={memTotal} />
              <Row label="In use">
                {memFree !== null ? mb(memTotal - memFree) : '—'}
              </Row>
              <Row label="Available">{mb(memFree)}</Row>
              <Row label="Installed">{mb(memTotal)}</Row>
              {/* Free memory is a snapshot from the moment of collection, not a
                  live reading — saying so stops it being read as current. */}
              <p className="text-[11px] text-muted-foreground pt-1">
                Free memory is as of {inv?.collectedAt ? ago(inv.collectedAt) : 'the last pass'}.
              </p>
            </>
          ) : (
            <p className="text-muted-foreground">Not collected yet.</p>
          )}
        </SectionCard>

        <SectionCard title="Storage" icon={HardDrive}>
          {(inv?.disks ?? []).length === 0 ? (
            <p className="text-muted-foreground">Not collected yet.</p>
          ) : (
            <div className="space-y-3">
              {(inv?.disks ?? []).map((d) => {
                const total = d.totalBytes ?? 0;
                const free = d.freeBytes ?? 0;
                return (
                  <div key={d.drive} className="space-y-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-mono text-xs">
                        {d.drive}
                        {d.label ? ` ${d.label}` : ''}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {bytes(free)} free of {bytes(total)}
                      </span>
                    </div>
                    <UsageBar used={total - free} total={total} />
                    {d.fsType && (
                      <div className="text-[11px] text-muted-foreground">{d.fsType}</div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </SectionCard>

        <SectionCard title="Network" icon={Network}>
          {(inv?.networks ?? []).length === 0 ? (
            <p className="text-muted-foreground">Not collected yet.</p>
          ) : (
            <div className="space-y-3">
              {(inv?.networks ?? []).map((n, i) => (
                <div key={`${n.mac ?? n.name}-${i}`} className="space-y-0.5">
                  <div className="text-xs break-words">{n.name}</div>
                  <div className="font-mono text-[11px] text-muted-foreground">
                    {[n.ipv4, n.mac, n.gateway && `gw ${n.gateway}`]
                      .filter(Boolean)
                      .join(' · ') || '—'}
                    {n.dhcp !== null && (n.dhcp ? ' · DHCP' : ' · static')}
                  </div>
                </div>
              ))}
            </div>
          )}
        </SectionCard>

        {data && <UpdatesCard data={data} />}
      </div>
    </div>
  );
}
