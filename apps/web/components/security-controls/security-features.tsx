'use client';

import { Fragment, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { businessesApi, securityControlsApi } from '@/lib/api-client';
import { usePermissions } from '@/lib/auth';
import { apiError, Chip, CHIP } from './shared';

type Status = 'enforced' | 'partial' | 'advisory' | 'unavailable';
type Layer = 'portal' | 'launcher' | 'endpoint-agent' | 'endpoint-rustdesk' | 'technician-rustdesk' | 'offline-signing' | 'none';
interface Feature {
  id: string; group: string; name: string; status: Status; protects: string; scope: string;
  enforcedAt: Layer[]; enforcement: string; default: string; prerequisites: string[];
  link: { href: string; label: string }; evidence: string[]; gap?: string;
  effective: { state: string; detail?: string; source: string } | null;
}
interface Catalog { scope: { kind: 'platform' } | { kind: 'business'; business: { id: string; name: string } }; features: Feature[] }

const STATUS: Record<Status, { label: string; className: string; help: string }> = {
  enforced: { label: 'Enforced', className: CHIP.on, help: 'The server refuses the action, and a test drives it.' },
  partial: { label: 'Partial', className: CHIP.warn, help: 'Enforced at the portal for some people or paths; the endpoint cannot confirm it. The row says which.' },
  advisory: { label: 'Advisory', className: CHIP.warn, help: 'Shown or recorded, but nothing refuses or ends anything.' },
  unavailable: { label: 'Unavailable', className: CHIP.bad, help: 'No component exists to enforce it, so it cannot be enabled.' },
};
const LAYER: Record<Layer, string> = {
  portal: 'Portal (API)', launcher: 'Launcher', 'endpoint-agent': 'Endpoint agent', 'endpoint-rustdesk': 'Endpoint RustDesk',
  'technician-rustdesk': "Technician's RustDesk", 'offline-signing': 'Offline signing', none: 'Nothing',
};
const SOURCE: Record<string, string> = {
  code: 'from the code', 'portal-policy': 'portal policy', 'endpoint-reports': 'observed from endpoint reports',
  mirror: 'as served by the mirror', 'server-config': 'server configuration',
};
const GROUPS: [string, string][] = [
  ['reach', 'Who can reach a computer'], ['session', 'What a session can do'], ['evidence', 'What you will have afterwards'],
  ['guardrails', 'Guardrails'], ['updates', 'Updates'], ['integration', 'Integration'], ['roadmap', 'Not in this build'],
];

/**
 * Settings → Security → Security Features, and Admin → Security → Security
 * features. Read-only. The effective column comes from the server for the
 * scope the caller may see; when the server cannot observe something it
 * sends nothing, and this renders "Unknown" — never a default dressed up as
 * a state.
 */
export function SecurityFeaturesTab() {
  const { isPlatformAdmin, canManageTechnicians } = usePermissions();
  const canPickBusiness = !!isPlatformAdmin || !!canManageTechnicians;
  const [businessId, setBusinessId] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  const { data: businesses = [] } = useQuery<{ id: string; name: string }[]>({
    queryKey: ['businesses', 'picker'],
    queryFn: () => businessesApi.list().then((r) => r.data?.data ?? []),
    enabled: canPickBusiness,
    staleTime: 300_000,
  });
  const { data, isLoading, isError, error } = useQuery<Catalog>({
    queryKey: ['security-controls', 'catalog', businessId],
    queryFn: () => securityControlsApi.catalog(businessId || undefined).then((r) => r.data?.data),
    staleTime: 60_000,
    retry: false,
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (isError || !data) return <p className="text-sm text-destructive">{apiError(error, 'Could not load the catalog').message}</p>;

  const counts = data.features.reduce<Record<string, number>>((m, f) => ({ ...m, [f.status]: (m[f.status] ?? 0) + 1 }), {});

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Who can reach a customer&apos;s computer, what a session can do once it starts, and what evidence you will have
        afterwards. <strong>Enforced at</strong> names the layer that refuses; a hidden button is not one, and a portal
        audit event does not prove what happened on the computer. See{' '}
        <Link className="underline" href="/docs/security-model">Security model</Link>.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {(Object.keys(STATUS) as Status[]).map((s) => (
          <Chip key={s} className={STATUS[s].className} title={STATUS[s].help}>{STATUS[s].label}: {counts[s] ?? 0}</Chip>
        ))}
        <span className="ml-auto text-xs text-muted-foreground">
          Effective state for{' '}
          {canPickBusiness ? (
            <select aria-label="Scope" className="rounded border bg-background px-1 py-0.5 text-xs" value={businessId} onChange={(e) => setBusinessId(e.target.value)}>
              <option value="">the platform</option>
              {businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          ) : (
            <strong>{data.scope.kind === 'business' ? data.scope.business.name : 'the platform'}</strong>
          )}
        </span>
      </div>

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-xs">
          <thead className="bg-muted/50 text-left text-muted-foreground">
            <tr>
              <th className="px-2 py-1.5">Control</th><th className="px-2">Status</th><th className="px-2">Enforced at</th>
              <th className="px-2">Default</th><th className="px-2">Effective</th><th className="px-2">Setting / docs</th>
            </tr>
          </thead>
          <tbody>
            {GROUPS.map(([g, title]) => {
              const rows = data.features.filter((f) => f.group === g);
              if (!rows.length) return null;
              return (
                <Fragment key={g}>
                  <tr className="border-t bg-muted/20"><td colSpan={6} className="px-2 py-1 font-medium">{title}</td></tr>
                  {rows.map((f) => {
                    const isOpen = open === f.id;
                    return (
                      <Fragment key={f.id}>
                        <tr className="border-t align-top">
                          <td className="px-2 py-1.5">
                            <button type="button" className="flex items-start gap-1 text-left font-medium" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : f.id)}>
                              {isOpen ? <ChevronDown className="mt-0.5 h-3 w-3 shrink-0" /> : <ChevronRight className="mt-0.5 h-3 w-3 shrink-0" />}
                              {f.name}
                            </button>
                            <div className="pl-4 text-muted-foreground">{f.protects}</div>
                          </td>
                          <td className="px-2 py-1.5"><Chip className={STATUS[f.status]?.className ?? CHIP.off} title={STATUS[f.status]?.help}>{STATUS[f.status]?.label ?? f.status}</Chip></td>
                          <td className="px-2 py-1.5">{f.enforcedAt.map((l) => LAYER[l] ?? l).join(', ')}</td>
                          <td className="px-2 py-1.5 max-w-[16rem]">{f.default}</td>
                          <td className="px-2 py-1.5 max-w-[16rem]">
                            {f.effective ? (
                              <span title={f.effective.detail}>{f.effective.state}<span className="block text-muted-foreground">{SOURCE[f.effective.source] ?? f.effective.source}</span></span>
                            ) : (
                              <span className="text-muted-foreground" title="Nothing the server holds can say what is true here.">Unknown</span>
                            )}
                          </td>
                          <td className="px-2 py-1.5"><Link className="underline" href={f.link.href}>{f.link.label}</Link></td>
                        </tr>
                        {isOpen && (
                          <tr className="bg-muted/10">
                            <td colSpan={6} className="space-y-1.5 px-6 py-2">
                              <p><span className="text-muted-foreground">Scope: </span>{f.scope}</p>
                              <p><span className="text-muted-foreground">How: </span>{f.enforcement}</p>
                              {f.prerequisites.length > 0 && <p><span className="text-muted-foreground">Needs: </span>{f.prerequisites.join(' · ')}</p>}
                              {f.effective?.detail && <p><span className="text-muted-foreground">Effective: </span>{f.effective.detail}</p>}
                              {f.gap && (
                                <p className="rounded border border-amber-300 bg-amber-50 p-1.5 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                                  <span className="font-medium">Limitation: </span>{f.gap}
                                </p>
                              )}
                              {f.evidence.length > 0 && <p className="font-mono text-[11px] text-muted-foreground">Evidence: {f.evidence.join(' · ')}</p>}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
