'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { apiError } from '@/components/security-controls/shared';
import { formatDate } from '@/lib/utils';
import { ago } from './device-model';
import { useMonitoringView } from './use-device-data';
import { ManagedSoftware } from './managed-software';

/**
 * Installed software (0.29): what Windows lists under Programs and Features,
 * sent with the full inventory pass. Read from the same monitoring view the
 * Monitoring tab uses — there is no separate software route.
 *
 * 0.34 added Managed software above it: the software catalog as this
 * computer sees it, with Install / Uninstall when the server allows them.
 */
export function DeviceSoftwareTab({ endpointId }: { endpointId: string }) {
  const [filter, setFilter] = useState('');
  const { data, error } = useMonitoringView(endpointId);
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
        <CardContent className="text-sm">
          {!data.software && <p className="text-muted-foreground">Not reported yet. The agent sends it with its next full inventory (agents from 0.29).</p>}
          {data.software && (
            <div className="max-h-[32rem] overflow-auto rounded-md border">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-card text-muted-foreground">
                  <tr><th className="px-3 py-1.5 font-medium">Name</th><th className="px-3 font-medium">Version</th><th className="px-3 font-medium">Publisher</th><th className="px-3 font-medium">Installed</th></tr>
                </thead>
                <tbody>
                  {rows.map((s, i) => (
                    <tr key={`${s.name}-${i}`} className="border-t">
                      <td className="px-3 py-1">{s.name}</td><td className="px-3 font-mono">{s.version ?? ''}</td>
                      <td className="px-3">{s.publisher ?? ''}</td><td className="px-3 whitespace-nowrap">{s.installedOn ? new Date(s.installedOn).toLocaleDateString() : ''}</td>
                    </tr>
                  ))}
                  {rows.length === 0 && <tr><td colSpan={4} className="px-3 py-3 text-muted-foreground">Nothing matches “{filter}”.</td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

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
