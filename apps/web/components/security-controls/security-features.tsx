'use client';

import { useQuery } from '@tanstack/react-query';
import { securityControlsApi } from '@/lib/api-client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { apiError, Chip, CHIP } from './shared';

interface Feature {
  id: string;
  name: string;
  scope: string;
  status: 'enforced' | 'partial' | 'unavailable';
  enforcement: string;
  evidence: string[];
  gap?: string;
}

const STATUS: Record<Feature['status'], { label: string; className: string; help: string }> = {
  enforced: { label: 'Enforced', className: CHIP.on, help: 'The server refuses the action, and a test drives it.' },
  partial: { label: 'Partial', className: CHIP.warn, help: 'Enforced at the portal, but the endpoint cannot confirm it.' },
  unavailable: { label: 'Unavailable', className: CHIP.bad, help: 'No component exists to enforce it, so it cannot be enabled.' },
};

/** Admin → Security → Security features: GET /security-controls/catalog. */
export function SecurityFeaturesTab() {
  const { data = [], isLoading, isError, error } = useQuery<Feature[]>({
    queryKey: ['security-controls', 'catalog'],
    queryFn: () => securityControlsApi.catalog().then((r) => r.data?.data ?? []),
    staleTime: 300_000,
    retry: false,
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (isError) return <p className="text-sm text-destructive">{apiError(error, 'Could not load the catalog').message}</p>;

  const counts = data.reduce<Record<string, number>>((m, f) => ({ ...m, [f.status]: (m[f.status] ?? 0) + 1 }), {});

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        What each safeguard covers, whether this build actually enforces it, where, and what proves it. Deliberately blunt:
        a safeguard that cannot be enforced is listed as unavailable rather than presented as a setting.
      </p>
      <div className="flex flex-wrap gap-2">
        {(Object.keys(STATUS) as Feature['status'][]).map((s) => (
          <Chip key={s} className={STATUS[s].className} title={STATUS[s].help}>{STATUS[s].label}: {counts[s] ?? 0}</Chip>
        ))}
      </div>
      {data.map((f) => (
        <Card key={f.id}>
          <CardHeader className="pb-2">
            <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-sm">
              {f.name}
              <Chip className={STATUS[f.status]?.className ?? CHIP.off} title={STATUS[f.status]?.help}>{STATUS[f.status]?.label ?? f.status}</Chip>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p><span className="text-muted-foreground">Scope: </span>{f.scope}</p>
            <p><span className="text-muted-foreground">Enforcement: </span>{f.enforcement}</p>
            {f.gap && (
              <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                <span className="font-medium">Gap: </span>{f.gap}
              </p>
            )}
            {f.evidence.length > 0 && (
              <div>
                <span className="text-muted-foreground">Evidence:</span>
                <ul className="mt-1 list-disc pl-5 font-mono text-xs">{f.evidence.map((e) => <li key={e}>{e}</li>)}</ul>
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
