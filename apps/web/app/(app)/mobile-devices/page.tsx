'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Smartphone } from 'lucide-react';
import { PageHeader } from '@/components/common/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { mobileApi } from '@/lib/api-client';
import { usePermissions, CAP } from '@/lib/auth';
import { formatDate } from '@/lib/utils';
import {
  ComplianceBadge, READ_ONLY_NOTE, RequiresSetupBadge,
  type ComplianceState, type MobileDevice, type Setup,
} from '@/components/mobile/mobile-ui';

/**
 * Devices → Mobile devices (0.80 Tablet): iOS, iPadOS and Android phones and
 * tablets as an MDM provider reports them. Read from GET /mobile-devices and
 * /mobile-devices/setup (mobile:view; the API pins the caller to their own
 * business). There is no control on this page: nothing can be sent to a
 * device in this release, and no real provider can be connected yet, so the
 * page says "Requires setup" and what a provider needs.
 */

interface ListData {
  total: number; page: number; pageSize: number;
  counts: Record<ComplianceState, number>;
  devices: MobileDevice[];
}

const COMPLIANCE_ORDER: { state: ComplianceState; label: string }[] = [
  { state: 'noncompliant', label: 'Not compliant' },
  { state: 'in_grace_period', label: 'In grace period' },
  { state: 'compliant', label: 'Compliant' },
  { state: 'unknown', label: 'Unknown' },
];
const selectClass = 'h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring';

export default function MobileDevicesPage() {
  const { can, isPlatformAdmin } = usePermissions();
  const allowed = can(CAP.MOBILE_VIEW);
  const [compliance, setCompliance] = React.useState<ComplianceState | ''>('');
  const [platform, setPlatform] = React.useState('');
  const [ownership, setOwnership] = React.useState('');

  const setup = useQuery<Setup>({
    queryKey: ['mobile-setup'],
    queryFn: () => mobileApi.setup().then((r) => r.data?.data),
    enabled: allowed,
  });
  const list = useQuery<ListData>({
    queryKey: ['mobile-devices', compliance, platform, ownership],
    queryFn: () => mobileApi.list({ compliance: compliance || undefined, platform: platform || undefined, ownership: ownership || undefined, pageSize: 100 }).then((r) => r.data?.data),
    enabled: allowed,
    refetchInterval: 120_000,
  });
  const s = setup.data;
  const data = list.data;
  const filtered = !!(compliance || platform || ownership);

  return (
    <div className="p-4 sm:p-6 space-y-5">
      <PageHeader
        title="Mobile devices"
        description="iPhones, iPads and Android devices as your MDM provider reports them: model, OS, ownership, compliance and command history."
      />
      {!allowed ? <p className="text-sm text-muted-foreground">This page needs the View mobile devices permission.</p> : (
        <>
          <p className="text-xs text-muted-foreground" data-testid="mdm-readonly-note">{READ_ONLY_NOTE}</p>

          {setup.isError && <p className="text-sm text-destructive">The provider status could not be loaded.</p>}
          {s && s.state === 'requires_setup' && (
            <Card data-testid="mdm-setup" data-state="requires_setup">
              <CardContent className="space-y-3 p-4 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <RequiresSetupBadge />
                  <span className="font-medium">No MDM provider is connected{s.connectors.length ? ' and readable' : ''}.</span>
                </div>
                <p className="text-muted-foreground">
                  Rem0te is becoming its own MDM: the MDM server for iPhones and iPads, and the EMM for Android. Nothing is enrolled
                  yet. Setting it up starts with the credentials Apple and Google require, which a Platform Admin prepares under
                  Settings → Mobile devices. This is what each needs:
                </p>
                {isPlatformAdmin ? (
                  <p data-testid="mdm-settings-link"><Button asChild size="sm" variant="outline"><Link href="/settings/mobile-devices">Open Settings → Mobile devices</Link></Button></p>
                ) : (
                  <p className="text-xs text-muted-foreground" data-testid="mdm-settings-hint">A Platform Admin sets this up under Settings → Mobile devices.</p>
                )}
                <ul className="space-y-2" data-testid="mdm-prerequisites">
                  {s.prerequisites.map((p) => (
                    <li key={p.key} className="rounded-md border p-3">
                      <p className="font-medium">{p.title}</p>
                      <p className="mt-0.5 text-muted-foreground">{p.needs}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">Planned: {p.plannedIn}</p>
                    </li>
                  ))}
                </ul>
                {s.connectors.length > 0 && (
                  <ul className="space-y-1 text-xs text-muted-foreground" data-testid="mdm-connectors">
                    {s.connectors.map((c) => (
                      <li key={c.id} className="break-words">{c.providerLabel}{c.business ? ` (${c.business.name})` : ''}: {c.reason ?? (c.enabled ? 'ready' : 'switched off')}</li>
                    ))}
                  </ul>
                )}
                <p className="text-xs text-muted-foreground">
                  More: <Link className="underline" href="/docs/mobile-devices">Mobile devices (MDM)</Link>.
                </p>
              </CardContent>
            </Card>
          )}
          {s && s.state === 'available' && (
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" data-testid="mdm-setup" data-state="available">
              {s.connectors.filter((c) => c.enabled).map((c) => (
                <span key={c.id} className="break-words">
                  {c.providerLabel}{c.business ? ` (${c.business.name})` : ''}: last read {c.lastSyncAt ? formatDate(c.lastSyncAt) : 'never'}{c.lastSyncResult && c.lastSyncResult !== 'ok' ? ` (${c.lastSyncResult.replace('_', ' ')})` : ''}
                </span>
              ))}
            </div>
          )}

          {data && (data.total > 0 || filtered) && (
            <>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="mdm-counts">
                {COMPLIANCE_ORDER.map((c) => (
                  <button
                    key={c.state}
                    type="button"
                    onClick={() => setCompliance(compliance === c.state ? '' : c.state)}
                    aria-pressed={compliance === c.state}
                    data-testid={`mdm-count-${c.state}`}
                    className={`rounded-lg border bg-card p-3 text-left transition-colors hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${compliance === c.state ? 'ring-2 ring-ring' : ''}`}
                  >
                    <div className="text-2xl font-semibold tabular-nums">{data.counts[c.state] ?? 0}</div>
                    <div className="mt-1"><ComplianceBadge state={c.state} label={c.label} /></div>
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <label className="sr-only" htmlFor="mdm-platform">Platform</label>
                <select id="mdm-platform" className={selectClass} value={platform} onChange={(e) => setPlatform(e.target.value)} data-testid="mdm-filter-platform">
                  <option value="">All platforms</option>
                  <option value="ios">iOS</option>
                  <option value="ipados">iPadOS</option>
                  <option value="android">Android</option>
                </select>
                <label className="sr-only" htmlFor="mdm-ownership">Ownership</label>
                <select id="mdm-ownership" className={selectClass} value={ownership} onChange={(e) => setOwnership(e.target.value)} data-testid="mdm-filter-ownership">
                  <option value="">Corporate and personal</option>
                  <option value="corporate">Corporate</option>
                  <option value="byod">Personal (BYOD)</option>
                </select>
                {filtered && (
                  <Button size="sm" variant="ghost" className="h-8 px-2 text-xs" onClick={() => { setCompliance(''); setPlatform(''); setOwnership(''); }} data-testid="mdm-filter-clear">
                    Show all
                  </Button>
                )}
              </div>
            </>
          )}

          {list.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {list.isError && <p className="text-sm text-destructive">Mobile devices could not be loaded.</p>}
          {data && (
            <Card>
              <CardContent className="p-0">
                {data.devices.length === 0 ? (
                  <div className="flex flex-col items-center gap-2 p-8 text-center text-sm text-muted-foreground" data-testid="mdm-empty">
                    <Smartphone className="h-8 w-8" aria-hidden />
                    {filtered ? <p>No mobile devices match these filters.</p>
                      : s?.state === 'requires_setup' ? <p>No mobile devices yet. They appear here once devices are enrolled; setup starts under Settings → Mobile devices.</p>
                        : <p>The provider reported no devices.</p>}
                  </div>
                ) : (
                  <ul className="divide-y" data-testid="mdm-rows">
                    {data.devices.map((d) => (
                      <li key={d.id} className="flex flex-wrap items-start gap-x-4 gap-y-1.5 p-3 text-xs" data-compliance={d.complianceState}>
                        <div className="min-w-0 flex-1 basis-48">
                          <Link href={`/mobile-devices/${d.id}`} className="text-sm font-medium hover:underline break-all">{d.name ?? d.providerDeviceId}</Link>
                          <p className="text-muted-foreground break-words">
                            {[d.model, d.osVersion ? `${d.platformLabel} ${d.osVersion}` : d.platformLabel].filter(Boolean).join(' · ')}
                          </p>
                          {d.business && <p className="text-muted-foreground break-words">{d.business.name}</p>}
                        </div>
                        <div className="min-w-0 flex-[2] basis-64 space-y-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <ComplianceBadge state={d.complianceState} label={d.complianceLabel} />
                            <span className="rounded-full border px-2 py-0.5 text-[11px]" data-ownership={d.ownership}>{d.ownershipLabel}</span>
                          </div>
                          {d.complianceReason && <p className="text-muted-foreground break-words">{d.complianceReason}</p>}
                          <p className="text-muted-foreground">Last check-in {d.lastCheckInAt ? formatDate(d.lastCheckInAt) : 'unknown'}</p>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                {data.total > data.devices.length && <p className="border-t p-3 text-xs text-muted-foreground">Showing the first {data.devices.length} of {data.total}.</p>}
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
