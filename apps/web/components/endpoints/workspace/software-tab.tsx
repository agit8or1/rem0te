'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, RefreshCw } from 'lucide-react';
import { endpointsApi } from '@/lib/api-client';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { apiError } from '@/components/security-controls/shared';
import { formatDate } from '@/lib/utils';
import { ago } from './device-model';
import { useMonitoringView } from './use-device-data';
import { ManagedSoftware, RemoveProgramDialog, useEndpointSoftware, type InstalledProgram } from './managed-software';

/**
 * Installed software (0.29): what Windows lists under Programs and Features,
 * sent with the full inventory pass. Read from the same monitoring view the
 * Monitoring tab uses — there is no separate software route.
 *
 * 0.34 added Managed software above it: the software catalog as this
 * computer sees it, with Install / Uninstall when the server allows them.
 *
 * 0.41: Uninstall on any program here. A program a catalog entry describes is
 * uninstalled through that entry; any other one through windows.software.remove,
 * when the inventory says it registers a silent uninstall or is a Windows
 * Installer product. Otherwise the reason is shown instead of a button.
 *
 * 0.42: the agent also removes Inno Setup, NSIS and Chromium programs (and
 * msiexec /I entries) silently, and the collector reports which form each
 * key is, so Uninstall appears exactly where the agent acts. An inventory
 * that predates that is one banner with Refresh inventory, not the same
 * reason on every row. RustDesk and Rem0te are never offered.
 */
export function DeviceSoftwareTab({ endpointId }: { endpointId: string }) {
  const [filter, setFilter] = useState('');
  const [removing, setRemoving] = useState<InstalledProgram | null>(null);
  const { data, error } = useMonitoringView(endpointId);
  const { data: sw } = useEndpointSoftware(endpointId);
  if (error || !data) {
    return (
      <div className="space-y-4">
        <ManagedSoftware endpointId={endpointId} />
        <p className="text-sm text-muted-foreground">{error ? apiError(error).message : 'Loading…'}</p>
      </div>
    );
  }

  const q = filter.trim().toLowerCase();
  const rows = (data.software ?? []).filter((s) => !q || `${s.name} ${s.publisher ?? ''} ${s.version ?? ''}`.toLowerCase().includes(q));
  const changes = data.changes.filter((c) => c.category === 'software').slice(0, 10);
  // The server's view of the same list carries each program's key and how it would be removed.
  const programOf = (s: { name: string; version: string | null }) => sw?.installed.find((p) => p.name === s.name && p.version === s.version) ?? null;
  const canRemove = !!sw && (sw.remove.possible || sw.uninstall.possible);
  const stale = sw?.inventory?.needsRefresh ?? null;

  return (
    <div className="space-y-4">
      <ManagedSoftware endpointId={endpointId} />
      <Card data-testid="mon-software">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0 pb-3">
          <div>
            <CardTitle className="text-sm">Installed software{data.softwareCount != null ? ` (${data.softwareCount})` : ''}</CardTitle>
            {data.inventoryAt && (
              <p className="mt-1 text-xs text-muted-foreground" title={formatDate(data.inventoryAt)}>
                As reported {ago(data.inventoryAt)} — the list is sent with the full inventory, about every six hours.
              </p>
            )}
          </div>
          {data.software && <Input className="h-8 w-full sm:w-56" placeholder="Filter by name, publisher or version" aria-label="Filter software" value={filter} onChange={(e) => setFilter(e.target.value)} />}
        </CardHeader>
        <CardContent className="text-sm space-y-2">
          {canRemove && stale && <RefreshInventoryBanner endpointId={endpointId} why={stale} />}
          {!data.software && <p className="text-muted-foreground">Not reported yet. The agent sends it with its next full inventory (agents from 0.29).</p>}
          {data.software && (
            <div className="max-h-[32rem] overflow-auto rounded-md border">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-card text-muted-foreground">
                  <tr><th className="px-3 py-1.5 font-medium">Name</th><th className="px-3 font-medium">Version</th><th className="px-3 font-medium">Publisher</th><th className="px-3 font-medium">Installed</th><th className="px-3 font-medium" /></tr>
                </thead>
                <tbody>
                  {rows.map((s, i) => (
                    <tr key={`${s.name}-${i}`} className="border-t">
                      <td className="px-3 py-1">{s.name}</td><td className="px-3 font-mono">{s.version ?? ''}</td>
                      <td className="px-3">{s.publisher ?? ''}</td><td className="px-3 whitespace-nowrap">{s.installedOn ? new Date(s.installedOn).toLocaleDateString() : ''}</td>
                      <td className="px-3 py-1 text-right whitespace-nowrap">
                        <UninstallCell p={programOf(s)} canRemove={canRemove} bannered={!!stale} remove={sw?.remove.possible ?? false} uninstall={sw?.uninstall.possible ?? false} onClick={setRemoving} />
                      </td>
                    </tr>
                  ))}
                  {rows.length === 0 && <tr><td colSpan={5} className="px-3 py-3 text-muted-foreground">Nothing matches “{filter}”.</td></tr>}
                </tbody>
              </table>
            </div>
          )}
          {sw && !canRemove && sw.remove.reason && (
            <p className="mt-2 text-xs text-muted-foreground" data-not-possible="Uninstall">Uninstall is not possible: {sw.remove.reason}{sw.remove.fix ? ` ${sw.remove.fix}` : ''}</p>
          )}
        </CardContent>
      </Card>
      {removing && sw && <RemoveProgramDialog endpointId={endpointId} program={removing} data={sw} onClose={() => setRemoving(null)} />}

      {changes.length > 0 && (
        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-sm">Recent software changes</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-xs">
            {changes.map((c) => (
              <p key={c.id}>
                <span className="text-muted-foreground" title={formatDate(c.detectedAt)}>{ago(c.detectedAt)}</span>{' · '}
                <span className="font-medium">{c.change}</span> {c.subject}
                {c.before || c.after ? <span className="text-muted-foreground"> ({[c.before, c.after].filter(Boolean).join(' → ')})</span> : null}
              </p>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/** One banner, with the button, when the inventory is too old to say how its programs uninstall (0.42). */
function RefreshInventoryBanner({ endpointId, why }: { endpointId: string; why: 'no_keys' | 'old_collector' }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [asked, setAsked] = useState(false);
  const m = useMutation({
    mutationFn: () => endpointsApi.refreshInventory(endpointId),
    onSuccess: () => {
      setAsked(true);
      qc.invalidateQueries({ queryKey: ['endpoint-software', endpointId] });
      toast({ title: 'Inventory requested', description: 'The computer collects it at its next check-in (a few minutes) and reports back.' });
    },
    onError: () => toast({ title: 'Not requested', variant: 'destructive' }),
  });
  return (
    <div className="rounded-md border border-yellow-300 bg-yellow-50 dark:border-yellow-800 dark:bg-yellow-950/40 p-2 text-xs flex flex-wrap items-center gap-2" data-testid="software-refresh-inventory" data-why={why}>
      <span className="min-w-0 flex-1">
        {why === 'no_keys'
          ? 'This inventory predates the 0.41 agent: it lists no uninstall keys, so nothing here can be uninstalled yet. Refresh it to see which programs can be.'
          : 'This inventory came from an older collector that did not check for the uninstallers 0.42 runs silently (Inno Setup, NSIS, Chromium, msiexec /I). Refresh it to see which programs can be uninstalled.'}
        {' '}If a refresh does not change this, update the agent on this computer — the collector comes with the agent install.
      </span>
      <Button size="sm" variant="outline" className="h-7 text-xs" data-testid="refresh-inventory" disabled={m.isPending || asked} onClick={() => m.mutate()}>
        {m.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1" />}{asked ? 'Inventory requested' : 'Refresh inventory'}
      </Button>
    </div>
  );
}

/** The short label for a program that is not offered; the full reason is its tooltip. */
const NOT_OFFERED: Record<string, string> = {
  protected: 'protected (remote access)', interactive: 'interactive uninstaller only', office: 'remove in Settings → Apps',
  driver: 'driver package', name: 'name the agent refuses',
};

function UninstallCell({ p, canRemove, bannered, remove, uninstall, onClick }: {
  p: InstalledProgram | null; canRemove: boolean; bannered: boolean; remove: boolean; uninstall: boolean; onClick: (p: InstalledProgram) => void;
}) {
  if (!p || !canRemove) return null;
  const last = p.last ? (
    <span className="block text-[10px] text-muted-foreground" title={formatDate(p.last.at)}>
      {(p.last.outcome ?? p.last.status).toLowerCase().replace(/_/g, ' ')}{p.last.reason ? ` (${p.last.reason.replace(/_/g, ' ')})` : ''} {ago(p.last.at)}
    </span>
  ) : null;
  const allowed = p.removal.method === 'catalog' ? uninstall : remove;
  if (p.removal.possible && allowed) {
    return <><Button size="sm" variant="ghost" className="h-6 text-xs" data-uninstall={p.key ?? p.name} onClick={() => onClick(p)}>Uninstall</Button>{last}</>;
  }
  const code = p.removal.code ?? '';
  // Rows the banner already explains say nothing of their own.
  const label = p.removal.possible ? '' : NOT_OFFERED[code] ?? (bannered && ['no_key', 'old_collector', 'unknown'].includes(code) ? '' : 'refresh the inventory to check');
  return <span className="text-[10px] text-muted-foreground" title={p.removal.reason ?? undefined} data-no-uninstall={code || 'unknown'}>{label}{last}</span>;
}
