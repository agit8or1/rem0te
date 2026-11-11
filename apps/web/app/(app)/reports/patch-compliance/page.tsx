'use client';

import Link from 'next/link';
import { PageHeader } from '@/components/common/page-header';
import { usePermissions, CAP } from '@/lib/auth';
import {
  Definition, Empty, FilterBar, Figure, Generated, Refused, Section, Table, ago, pct, where,
  useReport, useReportFilters, type Facets, type Ref, type ReportFilters,
} from '@/components/reports/report-kit';

/**
 * Patch compliance (0.32), from stored Windows Update scans, per business and
 * site — the dashboard's definition, from the same shared rule on the server.
 * Coverage (no scan, stale scan) is shown beside compliance and is never
 * counted as compliant.
 */
interface Summary {
  total: number; fresh: number; upToDate: number; needsUpdates: number; stale: number; noScan: number;
  compliancePercent: number | null; coveragePercent: number | null; noScanNotWindows: number; restartPending: number; pendingUpdates: number;
}
interface Data {
  generatedAt: string; definition: string; staleAfterHours: number; totals: Summary;
  oldestScanAt: string | null; newestScanAt: string | null;
  byBusiness: (Summary & { business: Ref | null })[];
  bySite: (Summary & { business: Ref | null; site: Ref | null })[];
  devices: { device: Ref; business: Ref | null; site: Ref | null; platform: string | null; windows: boolean; state: string; source: string; scanAt: string | null; pendingCount: number | null; rebootRequired: boolean | null; isOnline: boolean }[];
  devicesTotal: number;
  facets: Facets;
}
const KEYS: (keyof ReportFilters)[] = ['businessId', 'siteId'];
const STATE: Record<string, string> = { needs_updates: 'Needs updates', stale_scan: 'Scan stale', no_scan: 'No scan', up_to_date: 'Up to date' };
const SOURCE: Record<string, string> = { signed_agent_scan: 'Signed agent', standard_agent_scan: 'Standard agent', none: '—' };

export default function PatchCompliancePage() {
  const { can } = usePermissions();
  const { filters, set, params, ready } = useReportFilters(KEYS);
  const allowed = can(CAP.COMPUTERS_VIEW);
  const { data, error, isLoading } = useReport<Data>('patch-compliance', params, ready && allowed);
  const t = data?.totals;
  const row = (g: Summary) => [g.total, pct(g.compliancePercent), `${g.upToDate} / ${g.fresh}`, g.needsUpdates, pct(g.coveragePercent), g.stale, g.noScan, g.restartPending];
  const head = ['Devices', 'Compliant', 'Up to date / fresh scan', 'Need updates', 'Coverage', 'Stale scan', 'No scan', 'Restart pending'];

  return (
    <div className="p-6 space-y-6">
      <PageHeader title="Patch compliance" description="Windows Update compliance per business and site, from the update scans your devices have sent." />
      {!allowed ? <Refused error={{ response: { status: 403, data: { message: 'Patch compliance needs the View computers permission.' } } }} /> : (
        <>
          <FilterBar facets={data?.facets} filters={filters} set={set} report="patch-compliance" params={params} disabled={!t?.total} />
          {error ? <Refused error={error} /> : null}
          {data && (
            <Definition>
              <p>{data.definition}</p>
              <p>Devices with a scan older than {data.staleAfterHours} hours, or none, are coverage gaps: they are not counted as compliant or as non-compliant. <Generated at={data.generatedAt} />.</p>
            </Definition>
          )}
          {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {t && t.total === 0 && <Empty>No active devices in this view. Patch compliance is computed from the devices you can see; add or enroll one, or clear the site filter.</Empty>}
          {t && t.total > 0 && (
            <>
              <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
                <Figure label="Compliant" value={pct(t.compliancePercent)} tone={t.compliancePercent === null ? undefined : t.compliancePercent >= 90 ? 'good' : t.compliancePercent >= 60 ? 'warn' : 'bad'}
                  hint={t.fresh ? `${t.upToDate} of ${t.fresh} devices with a fresh scan` : `No device has a scan under ${data!.staleAfterHours} hours old`} />
                <Figure label="Coverage" value={pct(t.coveragePercent)} hint={`${t.fresh} of ${t.total} devices have a fresh scan`} />
                <Figure label="Coverage gaps" value={t.stale + t.noScan} tone={t.stale + t.noScan ? 'warn' : undefined}
                  hint={`${t.stale} stale, ${t.noScan} no scan${t.noScanNotWindows ? ` (${t.noScanNotWindows} not Windows)` : ''}`} />
                <Figure label="Restart pending" value={t.restartPending} hint={`${t.pendingUpdates} pending update${t.pendingUpdates === 1 ? '' : 's'} on fresh scans`} />
              </div>
              <p className="text-xs text-muted-foreground">
                Scans in this view range from {data!.oldestScanAt ? ago(data!.oldestScanAt) : '—'} to {data!.newestScanAt ? ago(data!.newestScanAt) : '—'}.
              </p>
              {data!.byBusiness.length > 1 && (
                <Section title="By business">
                  <Table head={['Business', ...head]} empty="No businesses." rows={data!.byBusiness.map((g) => [g.business?.name ?? 'No business', ...row(g)])} />
                </Section>
              )}
              <Section title="By site">
                <Table head={['Business · site', ...head]} empty="No sites." rows={data!.bySite.map((g) => [where(g.business, g.site), ...row(g)])} />
              </Section>
              <Section title="Devices that are not up to date" note={data!.devicesTotal > data!.devices.length ? `Showing ${data!.devices.length} of ${data!.devicesTotal}; the export has every device` : undefined}>
                <Table
                  head={['Device', 'Business · site', 'State', 'Scan from', 'Scan age', 'Pending', 'Restart']}
                  empty="Every device in this view has a fresh scan with nothing pending."
                  rows={data!.devices.map((d) => [
                    <Link key="d" href={`/endpoints/${d.device.id}?tab=patches`} className="font-medium hover:underline">{d.device.name}</Link>,
                    where(d.business, d.site),
                    <span key="s" className={d.state === 'needs_updates' ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}>{STATE[d.state] ?? d.state}{d.state === 'no_scan' && !d.windows ? ' (not Windows)' : ''}</span>,
                    SOURCE[d.source] ?? d.source,
                    d.scanAt ? ago(d.scanAt) : '—',
                    d.pendingCount ?? '—',
                    d.rebootRequired === null ? '—' : d.rebootRequired ? 'yes' : 'no',
                  ])}
                />
              </Section>
            </>
          )}
        </>
      )}
    </div>
  );
}
